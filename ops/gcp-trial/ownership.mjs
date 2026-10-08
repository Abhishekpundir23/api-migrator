import { captureOwnership, validatedPlan } from "./cleanup.mjs";

const PROJECT = "project-32bf49a2-bd30-4956-850", ZONE = "us-central1-a";
const BASE = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}`;
const PROJECTIONS = {
  operations: "kind,id,name,selfLink,zone,operationType,status,targetId,targetLink,error,warnings,httpErrorStatusCode,httpErrorMessage",
  instances: "kind,id,name,selfLink,zone,creationTimestamp,labels,disks(boot,autoDelete,source)",
  disks: "kind,id,name,selfLink,zone,creationTimestamp,users",
};
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
function onlyFields(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error();
}
function checkResource(value, kind, name, plan) {
  const keys = kind === "operations" ? ["kind", "id", "name", "selfLink", "zone", "operationType", "status", "targetId", "targetLink"]
    : ["kind", "id", "name", "selfLink", "zone", "creationTimestamp", kind === "instances" ? "labels" : "users", ...(kind === "instances" ? ["disks"] : [])];
  onlyFields(value, keys);
  if (value.kind !== ({ operations: "compute#operation", instances: "compute#instance", disks: "compute#disk" })[kind]
    || value.name !== name || value.selfLink !== `${BASE}/${kind}/${name}` || value.zone !== BASE) throw new Error();
  if (kind === "operations") {
    if (value.status !== "DONE" || value.operationType !== "insert") throw new Error();
  } else {
    const createdAt = Date.parse(value.creationTimestamp);
    if (!time(createdAt) || createdAt < plan.issuedAt || createdAt > plan.createBefore) throw new Error();
    if (kind === "instances") {
      if (!object(value.labels) || Object.values(value.labels).some(label => typeof label !== "string") || !Array.isArray(value.disks)) throw new Error();
      for (const disk of value.disks) onlyFields(disk, ["boot", "autoDelete", "source"]);
    }
  }
}

// Production uses native fetch; injected transport is an offline test boundary.
// These authenticated observations are not signed evidence or delete authority.
export async function collectTrialOwnership(inputJson, token,
  { expectedAccount, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController(); let timer, activeReader;
  try {
    if (typeof inputJson !== "string" || Buffer.byteLength(inputJson) > 32_768
      || typeof token !== "string" || token.length < 20 || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(token)
      || typeof expectedAccount !== "string" || expectedAccount.length > 254
      || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(expectedAccount)
      || expectedAccount.toLowerCase().endsWith(".gserviceaccount.com")
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new Error();
    const input = JSON.parse(inputJson);
    onlyFields(input, ["plan", "operationName"]);
    // Server-defined operation names are not instance RFC1035 names. Accept a
    // conservative bounded URL-safe segment, never a path, URL or query.
    if (Object.keys(input).length !== 2 || typeof input.operationName !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(input.operationName)) throw new Error();
    const plan = validatedPlan(JSON.stringify(input.plan)), operationName = input.operationName, observedAt = now();
    if (!time(observedAt) || observedAt < plan.issuedAt || observedAt >= plan.deleteAt) throw new Error();
    let totalBytes = 0, lastTime = observedAt;
    const checkClock = () => {
      const value = now();
      if (!time(value) || value < lastTime || value - observedAt > timeoutMs || value >= plan.deleteAt || controller.signal.aborted) throw new Error();
      lastTime = value; return value;
    };
    const get = async (url, compute = false) => {
      checkClock();
      const response = await fetchImpl(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
          ...(compute ? { "X-Goog-User-Project": PROJECT } : {}) }, signal: controller.signal });
      try {
        checkClock();
        if (response.status !== 200 || response.redirected) throw new Error();
      } catch {
        void response.body?.cancel().catch(() => {}); throw new Error();
      }
      const reader = response.body.getReader(); activeReader = reader;
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read(); checkClock(); if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > 262_144) throw new Error();
          chunks.push(Buffer.from(value));
        }
        const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!object(data)) throw new Error();
        return data;
      } finally {
        void reader.cancel().catch(() => {}); reader.releaseLock(); activeReader = undefined;
      }
    };
    const run = async () => {
      const identity = await get("https://openidconnect.googleapis.com/v1/userinfo");
      onlyFields(identity, ["sub", "name", "given_name", "family_name", "picture", "locale", "hd", "email", "email_verified"]);
      if (identity.email !== expectedAccount || identity.email_verified !== true) throw new Error();
      const resources = [];
      for (const [kind, name] of [["operations", operationName], ["instances", plan.instanceName], ["disks", plan.instanceName]]) {
        const url = new URL(`${BASE}/${kind}/${name}`);
        url.searchParams.set("fields", PROJECTIONS[kind]);
        const value = await get(url.href, true); checkResource(value, kind, name, plan); resources.push(value);
      }
      const ownership = captureOwnership(JSON.stringify(plan), JSON.stringify({ projectId: PROJECT, zone: ZONE, observedAt,
        operation: resources[0], instance: resources[1], disk: resources[2] }), { nowMs: checkClock() });
      const completedAt = checkClock();
      return { schemaVersion: 1, kind: "api_migrator_gcp_ownership_observation", observedAt, completedAt,
        account: expectedAccount, handoff: { plan, ownership }, executionBlocked: true, activationBlocked: true,
        cloudVerified: false, releaseEvidenceEligible: false, evidenceAuthenticityVerified: false };
    };
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); void activeReader?.cancel().catch(() => {}); reject(new Error());
    }, timeoutMs); });
    return await Promise.race([run(), timeout]);
  } catch { throw new Error("GCP ownership observation failed"); }
  finally { clearTimeout(timer); controller.abort(); void activeReader?.cancel().catch(() => {}); }
}
