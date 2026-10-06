import { createHash } from "node:crypto";
import { validateTrialOwnership } from "./cleanup.mjs";

const MARKER = "API_MIGRATOR_TRIAL_RESULT";
const MARKER_STEM = "API_MIGRATOR";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const phases = ["preflight", "os_prerequisites", "node_download", "worker_setup", "engine_smoke", "complete"];

// Logging emits UTC timestamps with nanosecond precision. Do not round an
// out-of-window event down into the accepted millisecond boundary.
function timestamp(value) {
  if (typeof value !== "string") throw new Error();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) throw new Error();
  const ms = Date.parse(match[1] + "Z");
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString().slice(0, 19) !== match[1]) throw new Error();
  return BigInt(ms) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

function terminal(line, plan) {
  // A bare wrapper marker or the metadata script runner's console prefix.
  // Console text is still guest-reported, not proof of who wrote the line.
  const match = /^(?:[ -~]{0,512}startup-script: )?API_MIGRATOR_TRIAL_RESULT (\{.*\})$/.exec(line);
  if (!match || match[1].length > 2048) return null;
  try {
    const value = JSON.parse(match[1]);
    const expected = { schemaVersion: 1, profile: "engine-smoke-v1", runId: plan.runId,
      sourceRevision: plan.source.revision, sourceArchiveSha256: plan.source.sha256,
      phase: value.phase, status: value.status, exitCode: value.exitCode, activationBlocked: true };
    // The generated wrapper has a fixed compact wire format. Exact comparison
    // also refuses extra fields, duplicate keys and alternate interpretations.
    if (match[1] !== JSON.stringify(expected) || !phases.includes(value.phase)
      || !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255
      || !(value.status === "passed" && value.exitCode === 0 && value.phase === "complete"
        || value.status === "failed" && value.exitCode !== 0 && value.phase !== "complete")) return null;
    return { phase: value.phase, exitCode: value.exitCode, status: `reported_${value.status}` };
  } catch { return null; }
}

// Consume the bounded JSON array from the existing serial-port-1 Logging read.
// Never fetch, execute, attest or claim the supplied records are authentic.
export function parseTrialResult(planJson, recordJson, logsJson, { nowMs = Date.now(), eventUntilMs = nowMs } = {}) {
  try {
    const { plan, ownership } = validateTrialOwnership(planJson, recordJson, { nowMs });
    if (!Number.isSafeInteger(eventUntilMs) || eventUntilMs < plan.issuedAt || eventUntilMs > nowMs) throw new Error();
    if (typeof logsJson !== "string" || Buffer.byteLength(logsJson) > 1_048_576) throw new Error();
    const entries = JSON.parse(logsJson);
    if (!Array.isArray(entries) || entries.length > 1000) throw new Error();
    const from = BigInt(plan.issuedAt) * 1_000_000n, until = BigInt(Math.min(plan.deleteAt, eventUntilMs)) * 1_000_000n;
    const logName = `projects/${plan.projectId}/logs/serialconsole.googleapis.com%2Fserial_port_1_output`;
    const candidates = []; let split = false, fragment = false, markerCount = 0;
    for (const entry of entries) {
      if (!object(entry) || entry.logName !== logName || !object(entry.resource) || entry.resource.type !== "gce_instance"
        || !object(entry.resource.labels) || entry.resource.labels.project_id !== plan.projectId
        || entry.resource.labels.zone !== plan.zone || entry.resource.labels.instance_id !== ownership.instanceId
        || typeof entry.textPayload !== "string" || Object.hasOwn(entry, "jsonPayload") || Object.hasOwn(entry, "protoPayload")
        || Object.hasOwn(entry, "error")) throw new Error();
      const at = timestamp(entry.timestamp);
      if (at < from || at > until) throw new Error();
      if (entry.receiveTimestamp !== undefined) {
        const received = timestamp(entry.receiveTimestamp);
        if (received < at || received > BigInt(nowMs) * 1_000_000n) throw new Error();
      }
      split ||= Object.hasOwn(entry, "split");
      for (const line of entry.textPayload.split(/\r?\n/)) {
        const count = line.split(MARKER).length - 1;
        // Do not overlook a visibly truncated token beside a complete result.
        // Shorter fragments cannot be distinguished from ordinary console text.
        fragment ||= line.split(MARKER_STEM).length - 1 !== count;
        markerCount += count;
        if (count) candidates.push({ line, timestamp: entry.timestamp });
      }
    }
    const common = { schemaVersion: 1, kind: "api_migrator_trial_result_observation",
      projectId: plan.projectId, zone: plan.zone, instanceId: ownership.instanceId, runId: plan.runId,
      planDigest: plan.planDigest, ownershipDigest: ownership.ownershipDigest, parsedAt: nowMs,
      evidenceDigest: `sha256:${createHash("sha256").update(logsJson).digest("hex")}`,
      executionBlocked: true, activationBlocked: true, cloudVerified: false,
      evidenceAuthenticityVerified: false, cleanupVerified: false, releaseEvidenceEligible: false };
    const incomplete = reason => ({ ...common, status: "incomplete", reason });
    if (entries.length === 1000) return incomplete("entry_limit_reached");
    if (split) return incomplete("split_entries");
    if (fragment) return incomplete("terminal_fragment");
    if (!markerCount) return incomplete("terminal_missing");
    if (markerCount !== 1) return incomplete("terminal_ambiguous");
    const result = terminal(candidates[0].line, plan);
    return result ? { ...common, ...result, terminalTimestamp: candidates[0].timestamp } : incomplete("terminal_invalid");
  } catch { throw new Error("invalid trial result evidence"); }
}
