import { createHash } from "node:crypto";
import { canonicalJson } from "../publication-runner/deployment/lib.mjs";
import { hasBatchSmokeSummary } from "./batch-bootstrap.mjs";

const digest = (s) => createHash("sha256").update(s).digest("hex");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const valid = (condition, message) => {
  if (!condition) throw new Error(message);
};
const time = (s) =>
  typeof s === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(s)
    ? Date.parse(s)
    : NaN;
const hex = (s, n) =>
  typeof s === "string" && new RegExp(`^[a-f0-9]{${n}}$`).test(s);
const exact = (v, keys) =>
  object(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));

// This is an operator-side consistency classifier, never production attestation.
export function classifyBatchResult({
  prepared: p,
  accepted: a,
  job: j,
  logs,
  inventory,
} = {}) {
  valid(
    object(p) &&
      p.schemaVersion === 1 &&
      p.projectId === "project-32bf49a2-bd30-4956-850" &&
      p.region === "us-central1" &&
      hex(p.runId, 32) &&
      p.jobId === `api-migrator-batch-${p.runId}` &&
      object(p.source) &&
      hex(p.source.revision, 40) &&
      hex(p.source.sha256, 64) &&
      p.activationBlocked === true &&
      Number.isSafeInteger(p.issuedAt) &&
      Number.isSafeInteger(p.deleteAt) &&
      p.deleteAt > p.issuedAt,
    "invalid prepared identity",
  );
  const script = p.job?.taskGroups?.[0]?.taskSpec?.runnables?.[0]?.script?.text;
  valid(
    typeof script === "string" &&
      hex(p.scriptSha256, 64) &&
      digest(script) === p.scriptSha256,
    "script digest mismatch",
  );
  const outcome = {
    smoke: "unverified",
    cleanup: "unverified",
    activationBlocked: true,
    productionReady: false,
  };
  const name = `projects/${p.projectId}/locations/${p.region}/jobs/${p.jobId}`;
  if (a === undefined) {
    valid(j === undefined && logs === undefined, "missing retained acceptance");
    return outcome;
  }
  valid(
    object(a) &&
      a.name === name &&
      typeof a.uid === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(a.uid) &&
      time(a.createTime) > p.issuedAt &&
      time(a.createTime) < p.deleteAt,
    "invalid retained acceptance",
  );
  if (j !== undefined)
    valid(
      object(j) &&
        j.name === a.name &&
        j.uid === a.uid &&
        j.createTime === a.createTime &&
        time(j.updateTime) >= time(a.createTime) &&
        object(j.status) &&
        [
          "QUEUED",
          "SCHEDULED",
          "RUNNING",
          "SUCCEEDED",
          "FAILED",
          "CANCELLED",
          "STATE_UNSPECIFIED",
        ].includes(j.status.state),
      "invalid job identity or state",
    );
  if (j !== undefined) {
    const materialKeys = [
      "taskGroups",
      "allocationPolicy",
      "labels",
      "logsPolicy",
    ];
    const outputKeys = ["name", "uid", "createTime", "updateTime", "status"];
    valid(
      Object.keys(j).every((key) =>
        [...materialKeys, ...outputKeys].includes(key),
      ),
      "unknown fetched job configuration",
    );
    const fetched = structuredClone(
      Object.fromEntries(materialKeys.map((key) => [key, j[key]])),
    );
    valid(Array.isArray(fetched.taskGroups), "missing fetched task groups");
    fetched.taskGroups = fetched.taskGroups.map((group) => {
      valid(object(group), "invalid fetched task group");
      const { name: outputName, ...material } = group;
      valid(
        outputName === undefined ||
          (typeof outputName === "string" &&
            outputName.length > 0 &&
            outputName.length <= 1024),
        "invalid output-only task group name",
      );
      return material;
    });
    // Only exact, observed provider normalization is accepted. All other fields
    // remain in the canonical comparison, including unknown execution settings.
    for (const [index, group] of fetched.taskGroups.entries()) {
      const spec = group.taskSpec;
      if (
        object(spec) &&
        !Object.hasOwn(spec, "maxRetryCount") &&
        p.job.taskGroups[index]?.taskSpec?.maxRetryCount === 0
      ) {
        spec.maxRetryCount = 0;
      }
    }
    const allocation = fetched.allocationPolicy;
    if (object(allocation)) {
      if (
        object(allocation.labels) &&
        allocation.labels["batch-job-id"] === p.jobId &&
        !Object.hasOwn(p.job.allocationPolicy.labels, "batch-job-id")
      ) {
        delete allocation.labels["batch-job-id"];
      }
      const expectedLocations =
        p.job.allocationPolicy.location.allowedLocations;
      if (
        canonicalJson(expectedLocations) === '["zones/us-central1-a"]' &&
        canonicalJson(allocation.location?.allowedLocations) ===
          '["regions/us-central1","zones/us-central1-a"]'
      ) {
        allocation.location.allowedLocations = [...expectedLocations];
      }
      if (Array.isArray(allocation.network?.networkInterfaces)) {
        for (const [
          index,
          network,
        ] of allocation.network.networkInterfaces.entries()) {
          if (
            object(network) &&
            !Object.hasOwn(network, "noExternalIpAddress") &&
            p.job.allocationPolicy.network.networkInterfaces[index]
              ?.noExternalIpAddress === false
          ) {
            network.noExternalIpAddress = false;
          }
        }
      }
    }
    valid(
      canonicalJson(fetched) === canonicalJson(p.job),
      "fetched job material configuration mismatch",
    );
  }
  const terminal =
    j && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(j.status.state);
  if (j && ["FAILED", "CANCELLED"].includes(j.status.state))
    outcome.smoke = "failed";
  if (logs !== undefined) {
    valid(
      object(logs) &&
        logs.jobUid === a.uid &&
        typeof logs.complete === "boolean" &&
        Array.isArray(logs.records) &&
        logs.records.length <= 4096 &&
        logs.records.every(
          (s) => typeof s === "string" && Buffer.byteLength(s) <= 65536,
        ),
      "invalid logs envelope",
    );
    const chunks = new Map();
    let result;
    for (const line of logs.records) {
      const kind = line.startsWith("API_MIGRATOR_BATCH_LOG")
        ? "LOG"
        : line.startsWith("API_MIGRATOR_BATCH_RESULT")
          ? "RESULT"
          : undefined;
      if (!kind) continue;
      const prefix = `API_MIGRATOR_BATCH_${kind} `;
      valid(line.startsWith(prefix), "malformed recognized marker");
      let record;
      try {
        record = JSON.parse(line.slice(prefix.length));
      } catch {
        throw new Error("malformed recognized marker");
      }
      if (kind === "LOG") {
        valid(
          exact(record, ["runId", "index", "data"]) &&
            record.runId === p.runId &&
            Number.isSafeInteger(record.index) &&
            record.index >= 0 &&
            record.index < 1366 &&
            !chunks.has(record.index) &&
            typeof record.data === "string" &&
            record.data.length <= 4096,
          "invalid chunk identity or index",
        );
        const bytes = Buffer.from(record.data, "base64");
        valid(
          bytes.length > 0 &&
            bytes.length <= 3072 &&
            bytes.toString("base64") === record.data,
          "invalid chunk base64",
        );
        chunks.set(record.index, bytes);
      } else {
        valid(
          result === undefined &&
            exact(record, [
              "schemaVersion",
              "profile",
              "runId",
              "sourceRevision",
              "sourceArchiveSha256",
              "phase",
              "exitCode",
              "status",
              "logBytes",
              "logChunks",
              "logSha256",
              "activationBlocked",
            ]) &&
            record.schemaVersion === 1 &&
            record.profile === "batch-engine-smoke-v1" &&
            record.runId === p.runId &&
            record.sourceRevision === p.source.revision &&
            record.sourceArchiveSha256 === p.source.sha256 &&
            record.activationBlocked === true &&
            typeof record.phase === "string" &&
            Number.isSafeInteger(record.exitCode) &&
            record.exitCode >= 0 &&
            record.exitCode <= 255 &&
            ["passed", "failed"].includes(record.status) &&
            Number.isSafeInteger(record.logBytes) &&
            record.logBytes >= 0 &&
            record.logBytes <= 4194304 &&
            Number.isSafeInteger(record.logChunks) &&
            record.logChunks >= 0 &&
            record.logChunks <= 1366 &&
            hex(record.logSha256, 64),
          "invalid result identity or bounds",
        );
        result = record;
      }
    }
    if (result) {
      valid(chunks.size === result.logChunks, "missing log chunks");
      const ordered = [...chunks].sort((a, b) => a[0] - b[0]);
      valid(
        ordered.every(
          ([index, bytes], i) =>
            index === i && (i === ordered.length - 1 || bytes.length === 3072),
        ),
        "nonsequential chunks",
      );
      const bytes = Buffer.concat(ordered.map(([, bytes]) => bytes));
      valid(
        bytes.length === result.logBytes && digest(bytes) === result.logSha256,
        "log bytes or digest mismatch",
      );
      const output = bytes.toString("utf8");
      if (
        j?.status.state === "SUCCEEDED" &&
        logs.complete &&
        result.phase === "complete" &&
        result.exitCode === 0 &&
        result.status === "passed" &&
        hasBatchSmokeSummary(output)
      )
        outcome.smoke = "passed";
    }
  }
  if (inventory !== undefined) {
    valid(
      object(inventory) && inventory.projectId === p.projectId,
      "invalid inventory project",
    );
    if (
      terminal &&
      exact(inventory, [
        "projectId",
        "observedAt",
        "complete",
        "instances",
        "disks",
        "instanceGroupManagers",
      ]) &&
      inventory.complete === true &&
      time(inventory.observedAt) > time(j.updateTime) &&
      time(inventory.observedAt) - time(j.updateTime) <= 300000 &&
      ["instances", "disks", "instanceGroupManagers"].every(
        (k) => Array.isArray(inventory[k]) && inventory[k].length === 0,
      )
    )
      outcome.cleanup = "verified_absent";
  }
  return outcome;
}
