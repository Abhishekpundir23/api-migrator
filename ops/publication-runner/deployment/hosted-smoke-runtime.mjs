import { createHash } from "node:crypto";

import { canonicalJson, sha256 } from "./lib.mjs";

export const HOSTED_SMOKE_RUNNER_UID = 12_001;
export const HOSTED_SMOKE_GATEWAY_UID = 12_002;
export const HOSTED_SMOKE_LISTENER_PORT = 15_443;
export const HOSTED_SMOKE_AUTHORIZATION_STATUS = "non_authorizing_github_hosted_smoke_only";
export const HOSTED_SMOKE_OWNERSHIP_KIND = "api_migrator_github_hosted_l7_smoke_resource_ownership";

export const HOSTED_SMOKE_SCENARIOS = Object.freeze([
  "success",
  "timeout",
  "sigkill",
  "wrong_sni",
  "absent_sni",
  "plaintext",
  "direct_bypass",
  "non_443",
  "non_npm",
  "offline_network",
  "gateway_stop",
  "uid_idle",
  "policy_removal",
  "cgroup_namespace_cleanup",
  "workspace_cleanup",
]);

const RUN_ID = /^[1-9][0-9]{0,19}$/;
const RUN_ATTEMPT = /^[1-9][0-9]{0,5}$/;
const JOB_ID = /^previewjob_[a-f0-9]{64}$/;
const SUITE_ID = /^hostedsmoke_[a-f0-9]{64}$/;
const SUFFIX = /^[a-f0-9]{16}$/;
const NFT_TABLE = /^api_migrator_gw_[a-f0-9]{16}$/;
const SYSTEMD_UNIT = /^api-migrator-hosted-(?:gateway|canary)-[a-f0-9]{16}\.service$/;
const RUNTIME_ROOT = /^\/run\/api-migrator-hosted-smoke\/[a-f0-9]{16}$/;
const WORKSPACE = /^\/run\/api-migrator-hosted-smoke-workspace\/[a-f0-9]{16}$/;
const CLEANUP_REPORT = /^hosted-smoke-cleanup-[a-z0-9_]+-[a-f0-9]{16}\.json$/;

const SUITE_DOMAIN = "api-migrator:github-hosted-l7-smoke-suite:v1\0";
const RESOURCE_DOMAIN = "api-migrator:github-hosted-l7-smoke-resource:v1\0";

/**
 * One suite spans all 15 scenario jobs for one exact GitHub run attempt. The
 * scenario is intentionally excluded so every report aggregates under one ID.
 */
export function deriveHostedSmokeSuiteId(input) {
  const root = exactInput(input, ["runId", "runAttempt"], "hosted smoke suite input");
  const runId = runIdValue(root.runId);
  const runAttempt = runAttemptValue(root.runAttempt);
  return `hostedsmoke_${hexDigest(`${SUITE_DOMAIN}${runId}\0${runAttempt}`)}`;
}

/**
 * Derive the complete mutation namespace from immutable GitHub coordinates.
 * The nftables table is deliberately computed from the first 16 hexadecimal
 * job-ID characters, exactly matching gateway-contract.mjs's table renderer.
 */
export function deriveHostedSmokeResources(input) {
  const root = exactInput(input, ["runId", "runAttempt", "scenario"], "hosted smoke resource input");
  const runId = runIdValue(root.runId);
  const runAttempt = runAttemptValue(root.runAttempt);
  const scenario = scenarioValue(root.scenario);
  const resourceHex = hexDigest(`${RESOURCE_DOMAIN}${runId}\0${runAttempt}\0${scenario}`);
  const jobId = `previewjob_${resourceHex}`;
  const suffix = jobId.slice("previewjob_".length, "previewjob_".length + 16);
  const runtimeRoot = `/run/api-migrator-hosted-smoke/${suffix}`;
  const resources = {
    runId,
    runAttempt,
    scenario,
    suiteId: deriveHostedSmokeSuiteId({ runId, runAttempt }),
    jobId,
    suffix,
    nftTable: `api_migrator_gw_${suffix}`,
    gatewayUnit: `api-migrator-hosted-gateway-${suffix}.service`,
    canaryUnit: `api-migrator-hosted-canary-${suffix}.service`,
    runtimeRoot,
    workspacePath: `/run/api-migrator-hosted-smoke-workspace/${suffix}`,
    ownershipMarkerPath: `${runtimeRoot}/ownership.json`,
    cleanupReportName: `hosted-smoke-cleanup-${scenario}-${suffix}.json`,
    runnerUid: HOSTED_SMOKE_RUNNER_UID,
    gatewayUid: HOSTED_SMOKE_GATEWAY_UID,
    listenerPort: HOSTED_SMOKE_LISTENER_PORT,
  };
  return deepFreeze(validateDerivedResources(resources));
}

/** Return exact canonical ownership bytes that provisioning writes first. */
export function buildHostedSmokeOwnershipMarker(resourcesInput) {
  const resources = validateHostedSmokeResources(resourcesInput);
  const marker = deepFreeze({
    schemaVersion: 1,
    kind: HOSTED_SMOKE_OWNERSHIP_KIND,
    suiteId: resources.suiteId,
    jobId: resources.jobId,
    scenario: resources.scenario,
    suffix: resources.suffix,
    nftTable: resources.nftTable,
    gatewayUnit: resources.gatewayUnit,
    canaryUnit: resources.canaryUnit,
    runtimeRoot: resources.runtimeRoot,
    workspacePath: resources.workspacePath,
    runnerUid: resources.runnerUid,
    gatewayUid: resources.gatewayUid,
    listenerPort: resources.listenerPort,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: HOSTED_SMOKE_AUTHORIZATION_STATUS,
  });
  const wire = canonicalJson(marker);
  return deepFreeze({
    marker,
    canonicalJson: wire,
    digest: sha256(Buffer.from(wire, "utf8")),
  });
}

/** Reject a marker unless every authority and resource field is exact. */
export function validateHostedSmokeOwnershipMarker(value, resourcesInput) {
  const resources = validateHostedSmokeResources(resourcesInput);
  const root = plainRecord(value, "hosted smoke ownership marker");
  exactKeys(root, [
    "schemaVersion", "kind", "suiteId", "jobId", "scenario", "suffix", "nftTable",
    "gatewayUnit", "canaryUnit", "runtimeRoot", "workspacePath", "runnerUid", "gatewayUid",
    "listenerPort", "releaseEvidenceEligible", "activationBlocked", "externalSigningEligible",
    "authorizationStatus",
  ], "hosted smoke ownership marker");
  if (
    root.schemaVersion !== 1 || root.kind !== HOSTED_SMOKE_OWNERSHIP_KIND ||
    root.releaseEvidenceEligible !== false || root.activationBlocked !== true ||
    root.externalSigningEligible !== false ||
    root.authorizationStatus !== HOSTED_SMOKE_AUTHORIZATION_STATUS
  ) {
    throw new Error("hosted smoke ownership marker is authorizing or unsupported");
  }
  const expected = buildHostedSmokeOwnershipMarker(resources).marker;
  if (canonicalJson(root) !== canonicalJson(expected)) {
    throw new Error("hosted smoke ownership marker substitutes an exact resource");
  }
  return expected;
}

/** Re-derive rather than trusting paths or identities supplied by a caller. */
export function validateHostedSmokeResources(value) {
  const root = plainRecord(value, "hosted smoke resources");
  exactKeys(root, [
    "runId", "runAttempt", "scenario", "suiteId", "jobId", "suffix", "nftTable",
    "gatewayUnit", "canaryUnit", "runtimeRoot", "workspacePath", "ownershipMarkerPath",
    "cleanupReportName", "runnerUid", "gatewayUid", "listenerPort",
  ], "hosted smoke resources");
  const expected = deriveHostedSmokeResources({
    runId: root.runId,
    runAttempt: root.runAttempt,
    scenario: root.scenario,
  });
  if (canonicalJson(root) !== canonicalJson(expected)) {
    throw new Error("hosted smoke resources are substituted");
  }
  return expected;
}

function validateDerivedResources(root) {
  if (
    !SUITE_ID.test(root.suiteId) || !JOB_ID.test(root.jobId) || !SUFFIX.test(root.suffix) ||
    !NFT_TABLE.test(root.nftTable) || !SYSTEMD_UNIT.test(root.gatewayUnit) ||
    !SYSTEMD_UNIT.test(root.canaryUnit) || !RUNTIME_ROOT.test(root.runtimeRoot) ||
    !WORKSPACE.test(root.workspacePath) ||
    root.ownershipMarkerPath !== `${root.runtimeRoot}/ownership.json` ||
    !CLEANUP_REPORT.test(root.cleanupReportName) ||
    root.nftTable !== `api_migrator_gw_${root.jobId.slice("previewjob_".length, "previewjob_".length + 16)}` ||
    root.runnerUid !== HOSTED_SMOKE_RUNNER_UID || root.gatewayUid !== HOSTED_SMOKE_GATEWAY_UID ||
    root.listenerPort !== HOSTED_SMOKE_LISTENER_PORT
  ) {
    throw new Error("derived hosted smoke resource namespace is invalid");
  }
  return root;
}

function runIdValue(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) throw new Error("hosted smoke run ID is invalid");
  return value;
}

function runAttemptValue(value) {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !RUN_ATTEMPT.test(normalized)) {
    throw new Error("hosted smoke run attempt is invalid");
  }
  const attempt = Number(normalized);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("hosted smoke run attempt is invalid");
  return attempt;
}

function scenarioValue(value) {
  if (typeof value !== "string" || !HOSTED_SMOKE_SCENARIOS.includes(value)) {
    throw new Error("hosted smoke scenario is unsupported");
  }
  return value;
}

function hexDigest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactInput(value, keys, label) {
  const root = plainRecord(value, label);
  exactKeys(root, keys, label);
  return root;
}

function plainRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, names, label) {
  const actual = Object.keys(value).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
