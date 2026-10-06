import { createHash } from "node:crypto";
import { validateTrialOwnership } from "./cleanup.mjs";
import { renderEvidenceRead } from "./plan.mjs";
import { parseTrialResult } from "./result.mjs";

const ENDPOINT = "https://logging.googleapis.com/v2/entries:list";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;

// The production CLI uses native fetch. Injection is only an offline test
// boundary, not a way to authenticate serialized observations for release use.
export async function collectTrialLogs(planJson, recordJson, token,
  { expectedAccount, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController(); let timer, activeReader;
  try {
    if (typeof token !== "string" || token.length < 20 || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(token)
      || typeof expectedAccount !== "string" || expectedAccount.length > 254
      || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(expectedAccount)
      || expectedAccount.toLowerCase().endsWith(".gserviceaccount.com")
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new Error();
    const startedAt = now();
    const { plan, ownership } = validateTrialOwnership(planJson, recordJson, { nowMs: startedAt });
    const eventUntilMs = Math.min(plan.deleteAt, startedAt);
    // Reuse the reviewed filter argument, never execute the rendered command.
    const filter = renderEvidenceRead({ projectId: plan.projectId, instanceId: ownership.instanceId,
      fromMs: plan.issuedAt, toMs: eventUntilMs }).command[3];
    const query = { resourceNames: [`projects/${plan.projectId}`], filter, orderBy: "timestamp desc", pageSize: 100 };
    let totalBytes = 0, lastTime = startedAt;
    const checkClock = () => {
      const value = now();
      if (!time(value) || value < lastTime || value - startedAt > timeoutMs || controller.signal.aborted) throw new Error();
      lastTime = value; return value;
    };
    const request = async (url, body) => {
      checkClock();
      const response = await fetchImpl(url, { method: body === undefined ? "GET" : "POST", redirect: "error",
        credentials: "omit", cache: "no-store", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Goog-User-Project": plan.projectId }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status !== 200 || controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error(); }
      const reader = response.body.getReader(); activeReader = reader;
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read(); checkClock(); if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > 1_048_576) throw new Error();
          chunks.push(Buffer.from(value));
        }
        const raw = Buffer.concat(chunks);
        const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        if (!object(data)) throw new Error();
        return { data, digest: hash(raw) };
      } finally {
        void reader.cancel().catch(() => {}); reader.releaseLock(); activeReader = undefined;
      }
    };
    const run = async () => {
      const { data: identity } = await request("https://openidconnect.googleapis.com/v1/userinfo");
      if (identity.email !== expectedAccount || identity.email_verified !== true || Object.hasOwn(identity, "error")) throw new Error();
      const entries = [], pageDigests = [], seen = new Set(); let pageToken = "";
      do {
        if (seen.has(pageToken) || pageDigests.length >= 20) throw new Error();
        seen.add(pageToken);
        const { data, digest } = await request(ENDPOINT, { ...query, ...(pageToken ? { pageToken } : {}) });
        if (Object.keys(data).some(key => !["entries", "nextPageToken"].includes(key))
          || data.entries !== undefined && !Array.isArray(data.entries)) throw new Error();
        entries.push(...(data.entries ?? [])); pageDigests.push(digest);
        if (entries.length > 1000) throw new Error();
        pageToken = data.nextPageToken === undefined ? "" : data.nextPageToken;
        if (typeof pageToken !== "string" || pageToken.length > 2048 || entries.length === 1000 && pageToken) throw new Error();
      } while (pageToken);
      const completedAt = checkClock();
      const result = parseTrialResult(planJson, recordJson, JSON.stringify(entries), { nowMs: completedAt, eventUntilMs });
      checkClock();
      return { schemaVersion: 1, kind: "api_migrator_gcp_log_observation", startedAt, completedAt,
        queryDigest: hash(JSON.stringify(query)), pageDigests, entryCount: entries.length, result,
        executionBlocked: true, activationBlocked: true, cloudVerified: false,
        evidenceAuthenticityVerified: false, cleanupVerified: false, releaseEvidenceEligible: false };
    };
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); void activeReader?.cancel().catch(() => {}); reject(new Error());
    }, timeoutMs); });
    return await Promise.race([run(), timeout]);
  } catch { throw new Error("GCP log observation failed"); }
  finally { clearTimeout(timer); controller.abort(); void activeReader?.cancel().catch(() => {}); }
}
