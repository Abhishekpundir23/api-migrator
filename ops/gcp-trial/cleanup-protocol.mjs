import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { decideCleanup, validateTrialInventory, validateTrialOwnership } from "./cleanup.mjs";

const BASE = "https://www.googleapis.com/compute/v1/projects/project-32bf49a2-bd30-4956-850/zones/us-central1-a";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const id = value => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)
  && BigInt(value) <= 18_446_744_073_709_551_615n;

// Stable UUIDv5 for retry deduplication only, never a generation precondition.
function requestId(ownershipDigest, kind) {
  const bytes = createHash("sha1").update(Buffer.from("90b55eca28275f34a19cdfbc4d8373e0", "hex"))
    .update(`${ownershipDigest}/${kind}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function operation(response, kind, ownership, previous) {
  if (!object(response) || response.status !== 200 || typeof response.body !== "string"
    || Buffer.byteLength(response.body) > 65_536) throw new Error();
  const op = JSON.parse(response.body), resourceId = kind === "instances" ? ownership.instanceId : ownership.diskId;
  if (!object(op) || op.kind !== "compute#operation" || !id(op.id)
    || typeof op.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(op.name)
    || op.selfLink !== `${BASE}/operations/${op.name}` || op.zone !== BASE
    || op.operationType !== "delete" || op.targetId !== resourceId
    || op.targetLink !== `${BASE}/${kind}/${ownership.instanceName}`
    || !["PENDING", "RUNNING", "DONE"].includes(op.status)
    || ["error", "warnings", "httpErrorStatusCode", "httpErrorMessage"].some(key => Object.hasOwn(op, key))
    || (previous && (op.id !== previous.id || op.name !== previous.name
      || (previous.status === "RUNNING" && op.status === "PENDING")))) throw new Error();
  // Never propagate arbitrary provider fields to the caller or subsequent URL.
  return { id: op.id, name: op.name, status: op.status };
}

/**
 * Offline protocol rehearsal kernel. There is deliberately no fetch, token,
 * cloud adapter, CLI or production caller. Only controlled fixture transports
 * may be connected today. A future live adapter needs separate review of disk
 * ID semantics, concurrent auto-delete attachments, auth and watchdog custody.
 * The callback boundary is trusted code, NOT a sandbox or a live safety gate.
 */
export async function rehearseTrialCleanup(planJson, ownershipJson, {
  transport, readInventory, now = Date.now, reason = "deadline", timeoutMs = 20_000,
  wait = (ms, signal) => delay(ms, undefined, { signal }),
} = {}) {
  let plan, ownership, startedAt;
  try {
    if (typeof transport !== "function" || typeof readInventory !== "function" || typeof now !== "function"
      || typeof wait !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000
      || !["deadline", "completed", "failed", "cancelled", "controller_failure"].includes(reason)) throw new Error();
    startedAt = now();
    ({ plan, ownership } = validateTrialOwnership(planJson, ownershipJson, { nowMs: startedAt }));
  } catch { throw new Error("GCP cleanup rehearsal failed"); }

  const controller = new AbortController(); let timer, lastTime = startedAt;
  const attempts = [];
  const result = (status, why) => ({ schemaVersion: 1, kind: "api_migrator_gcp_cleanup_rehearsal", mode: "rehearsal",
    status, ...(why ? { reason: why } : {}), planDigest: plan.planDigest, ownershipDigest: ownership.ownershipDigest,
    deleteAt: plan.deleteAt, startedAt, completedAt: lastTime, attempts: attempts.map(a => ({ ...a })),
    executionBlocked: true, activationBlocked: true, cloudVerified: false, cleanupVerified: false,
    releaseEvidenceEligible: false, evidenceAuthenticityVerified: false, independentControllerReady: false });
  const check = () => {
    const value = now();
    if (!time(value) || value < lastTime || value - startedAt > timeoutMs || controller.signal.aborted) throw new Error();
    lastTime = value; return value;
  };
  const read = async () => {
    const requestedAt = check();
    const json = await readInventory({ signal: controller.signal }); check();
    const { inventory, instances } = validateTrialInventory(json, { nowMs: lastTime });
    if (inventory.observedAt < requestedAt) throw new Error();
    const decision = decideCleanup(planJson, ownershipJson, json, { nowMs: lastTime, reason });
    // A disk.users projection alone is insufficient if another VM also names
    // that disk. This is still a non-atomic read, not a concurrency guarantee.
    if (instances.some(vm => vm.id !== ownership.instanceId && Array.isArray(vm.disks)
      && vm.disks.some(d => d?.source === `${BASE}/disks/${ownership.diskName}`))) {
      return { status: "blocked", reason: "disk_attached_elsewhere" };
    }
    return decision;
  };
  const request = async (method, url) => {
    check();
    const response = await transport(Object.freeze({ method, url, signal: controller.signal }));
    check(); return response;
  };
  const remove = async kind => {
    const resourceId = kind === "instances" ? ownership.instanceId : ownership.diskId;
    const attempt = { resource: kind, resourceId, outcome: "indeterminate" }; attempts.push(attempt);
    const url = `${BASE}/${kind}/${resourceId}?requestId=${requestId(ownership.ownershipDigest, kind)}`;
    const response = await request("DELETE", url);
    if (object(response) && response.status === 404) { attempt.outcome = "not_found"; return; }
    let op = operation(response, kind, ownership);
    for (let polls = 0; op.status !== "DONE"; polls++) {
      if (polls >= 5) throw new Error();
      check(); await wait(1000, controller.signal); check();
      op = operation(await request("GET", `${BASE}/operations/${op.name}`), kind, ownership, op);
    }
    attempt.outcome = "operation_done";
  };
  const run = async () => {
    let decision = await read();
    for (const kind of ["instances", "disks"]) {
      if (decision.status !== "blocked" || decision.reason !== "generation_safe_delete_unverified") {
        return result(decision.status, decision.reason);
      }
      const expected = kind === "instances" ? "instance" : "disk";
      if (decision.resource !== expected) continue;
      await remove(kind);
      decision = await read();
      if (decision.reason === "generation_safe_delete_unverified" && decision.resource === expected) {
        return result("indeterminate", "resource_still_present");
      }
    }
    return result(decision.status, decision.reason);
  };
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error());
  }, timeoutMs); });
  try { return await Promise.race([run(), timeout]); }
  catch { return result("indeterminate", "protocol_incomplete"); }
  finally { clearTimeout(timer); controller.abort(); }
}
