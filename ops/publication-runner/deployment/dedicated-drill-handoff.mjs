import { canonicalJson, sha256 } from "./lib.mjs";
import { LIFECYCLE_SCENARIO_MATRIX } from "./lifecycle-drill.mjs";

export const DEDICATED_DRILL_HANDOFF_KIND =
  "api_migrator_external_dedicated_host_drill_handoff";
export const DEDICATED_DRILL_ATTEMPT_REPORT_KIND =
  "api_migrator_external_dedicated_host_drill_attempt_report";
export const DEDICATED_DRILL_AUTHORIZATION_STATUS =
  "non_authorizing_external_dedicated_host_drill_candidate_only";
export const DEDICATED_DRILL_SCENARIOS = deepFreeze(
  LIFECYCLE_SCENARIO_MATRIX.map(({ name, expectedOutcome }) => ({ name, expectedOutcome }))
);
export const DEDICATED_DRILL_EVENT_CHAIN_ROOT = sha256(
  Buffer.from("api-migrator:dedicated-drill:event-chain-root:v1", "utf8")
);

const HANDOFF_SCOPE = "external_controller_17_fresh_dedicated_hosts";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SUITE_ID = /^dedicatedsuite_[a-f0-9]{64}$/;
const JOB_ID = /^previewjob_[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[a-z][a-z0-9._:@+-]{5,127}$/;
const PROVIDER = /^[a-z][a-z0-9-]{2,63}$/;
const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{5,255}$/;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MAX_HANDOFF_BYTES = 512 * 1024;
const MAX_REPORT_BYTES = 512 * 1024;
const MIN_MEMORY_MAX = 64 * 1024 * 1024;
const MAX_MEMORY_MAX = 4 * 1024 * 1024 * 1024;
const MAX_HOST_AGE_AT_HANDOFF_MS = 15 * 60 * 1000;
const MAX_ATTEMPT_WINDOW_MS = 30 * 60 * 1000;
const MAX_LEASE_WINDOW_MS = 60 * 60 * 1000;
const MIN_EVIDENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REFERENCE_BYTES = 2048;
const EVIDENCE_REFERENCE =
  /^(?:https|s3|gs|az):\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?\/[A-Za-z0-9._~/-]+$/;
const ATTEMPT_DIGEST_DOMAIN = "api-migrator:dedicated-drill:attempt:v1";
const EVENT_CHAIN_DOMAIN = "api-migrator:dedicated-drill:event-chain:v1";

const BASE_PREFIX_EVENTS = Object.freeze([
  "observer_started",
  "handoff_validated",
  "host_lease_verified",
  "initial_boot_observed",
  "runtime_manifest_verified",
  "nftables_policy_installed",
  "gateway_started",
  "gateway_ready",
  "scenario_started",
]);

const TABLE_LAST_EVENTS = Object.freeze([
  "gateway_stopped",
  "offline_network_checked",
  "runner_uid_idle",
  "gateway_uid_idle",
  "cgroup_namespace_cleanup",
  "workspace_cleanup",
  "nftables_policy_removed",
  "host_destroyed",
  "scenario_finished",
  "observer_finished",
]);

const OOM_SCENARIO_EVENTS = Object.freeze([
  ...BASE_PREFIX_EVENTS,
  "oom_limits_verified",
  "oom_workload_started",
  "oom_observed",
  ...TABLE_LAST_EVENTS,
]);

const REBOOT_SCENARIO_EVENTS = Object.freeze([
  ...BASE_PREFIX_EVENTS,
  "reboot_requested",
  "host_unreachable",
  "host_reconnected",
  "post_reboot_boot_observed",
  "post_reboot_units_idle",
  "post_reboot_containment_absent",
  "cgroup_namespace_cleanup",
  "workspace_cleanup",
  "host_destroyed",
  "scenario_finished",
  "observer_finished",
]);

/** Return the exact externally observed lifecycle for one scenario. */
export function dedicatedDrillEventOrder(scenario) {
  scenarioDefinition(scenario);
  if (scenario === "oom") return [...OOM_SCENARIO_EVENTS];
  if (scenario === "reboot") return [...REBOOT_SCENARIO_EVENTS];
  const proof = genericScenarioProofDefinition(scenario);
  const teardownEvents = [...TABLE_LAST_EVENTS];
  if (proof.insertObservationAfter) {
    const insertionIndex = teardownEvents.indexOf(proof.insertObservationAfter);
    teardownEvents.splice(insertionIndex + 1, 0, proof.observationEvent);
    return [...BASE_PREFIX_EVENTS, ...teardownEvents];
  }
  return [
    ...BASE_PREFIX_EVENTS,
    proof.stimulusEvent,
    proof.observationEvent,
    ...teardownEvents,
  ];
}

/** Return the exact generic-scenario stimulus and observation event names. */
export function dedicatedDrillScenarioProofEvents(scenario) {
  const proof = genericScenarioProofDefinition(scenario);
  return deepFreeze({
    stimulusEvent: proof.stimulusEvent,
    observationEvent: proof.observationEvent,
  });
}

/**
 * Render the provider-neutral handoff made after 17 fresh host leases have been
 * acquired but before any target-host scenario begins. This is only a contract
 * boundary: it does not provision, connect to, mutate, or authorize a host.
 */
export function renderDedicatedDrillHandoff(input) {
  const root = record(input, "dedicated drill handoff input");
  exactKeys(root, [
    "suiteId", "sourceRevision", "issuedAt", "provider", "providerScopeDigest",
    "controller", "observer", "evidenceSink", "attempts",
  ], "dedicated drill handoff input");
  const issuedAt = timestamp(root.issuedAt, "dedicated drill handoff issue time");
  const suiteId = exactPattern(root.suiteId, SUITE_ID, "dedicated drill suite ID");
  const sourceRevision = exactPattern(root.sourceRevision, REVISION, "dedicated drill source revision");
  const provider = validateProvider(root.provider);
  const providerScopeDigest = digest(root.providerScopeDigest, "dedicated drill provider scope");
  const controller = validateController(root.controller);
  const observer = validateObserver(root.observer);
  assertIndependentObserver(controller, observer);
  const attemptContext = {
    suiteId, sourceRevision, issuedAt, provider, providerScopeDigest, controller, observer,
  };
  const attempts = normalizeAttemptInputs(root.attempts, attemptContext);
  const evidenceSink = validateEvidenceSink(root.evidenceSink, controller, attempts);
  const handoff = deepFreeze({
    schemaVersion: 1,
    kind: DEDICATED_DRILL_HANDOFF_KIND,
    suiteId,
    sourceRevision,
    issuedAt,
    provider,
    providerScopeDigest,
    controller,
    observer,
    evidenceSink,
    attempts,
    attemptsDigest: sha256(Buffer.from(canonicalJson(attempts), "utf8")),
    handoffScope: HANDOFF_SCOPE,
    selfAttested: false,
    authoritativeDrill: false,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: DEDICATED_DRILL_AUTHORIZATION_STATUS,
  });
  const wire = canonicalJson(handoff);
  return deepFreeze({
    handoff,
    canonicalJson: wire,
    digest: sha256(Buffer.from(wire, "utf8")),
  });
}

/** Revalidate a rendered handoff and its exact canonical bytes. */
export function validateDedicatedDrillHandoffRecord(value) {
  const root = record(value, "dedicated drill handoff record");
  exactKeys(root, ["handoff", "canonicalJson", "digest"], "dedicated drill handoff record");
  const handoff = normalizeHandoff(root.handoff);
  const wire = canonicalJson(handoff);
  if (root.canonicalJson !== wire || root.digest !== sha256(Buffer.from(wire, "utf8"))) {
    throw new Error("dedicated drill handoff record contains substituted canonical bytes");
  }
  return deepFreeze({ handoff, canonicalJson: wire, digest: root.digest });
}

/** Parse a persisted handoff without accepting non-canonical or excessive bytes. */
export function parseCanonicalDedicatedDrillHandoff(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") < 1 ||
      Buffer.byteLength(text, "utf8") > MAX_HANDOFF_BYTES) {
    throw new Error("dedicated drill handoff bytes are missing or excessive");
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("dedicated drill handoff is not JSON"); }
  const handoff = normalizeHandoff(parsed);
  const wire = canonicalJson(handoff);
  if (wire !== text) throw new Error("dedicated drill handoff is not exact canonical JSON");
  return deepFreeze({ handoff, canonicalJson: wire, digest: sha256(Buffer.from(wire, "utf8")) });
}

/** Build one hash-chained externally observed event for a bound attempt. */
export function buildDedicatedDrillEvent(input, handoffRecord) {
  const deployment = validateDedicatedDrillHandoffRecord(handoffRecord);
  const root = record(input, "dedicated drill event input");
  exactKeys(root, [
    "scenario", "sequence", "event", "bootId", "observedAt",
    "evidenceDigest", "previousEventDigest",
  ], "dedicated drill event input");
  const attempt = attemptForScenario(deployment.handoff, root.scenario);
  const order = dedicatedDrillEventOrder(attempt.scenario);
  if (!Number.isSafeInteger(root.sequence) || root.sequence < 1 || root.sequence > order.length ||
      root.event !== order[root.sequence - 1]) {
    throw new Error("dedicated drill event is outside the exact scenario order");
  }
  const eventWithoutDigest = {
    sequence: root.sequence,
    event: root.event,
    scenario: attempt.scenario,
    handoffDigest: deployment.digest,
    attemptDigest: attempt.attemptDigest,
    jobId: attempt.jobId,
    planDigest: attempt.bindings.planDigest,
    instanceId: attempt.hostLease.instanceId,
    bootId: digest(root.bootId, "dedicated drill event boot ID"),
    observedAt: timestamp(root.observedAt, "dedicated drill event timestamp"),
    evidenceDigest: digest(root.evidenceDigest, "dedicated drill event evidence"),
    previousEventDigest: digest(root.previousEventDigest, "dedicated drill previous event"),
  };
  return deepFreeze({
    ...eventWithoutDigest,
    eventDigest: sha256(Buffer.from(canonicalJson(eventWithoutDigest), "utf8")),
  });
}

/** Return the domain-separated first-link digest for one exact handoff attempt. */
export function dedicatedDrillEventChainRoot(handoffRecord, scenario) {
  const deployment = validateDedicatedDrillHandoffRecord(handoffRecord);
  const attempt = attemptForScenario(deployment.handoff, scenario);
  return sha256(Buffer.from(canonicalJson({
    domain: EVENT_CHAIN_DOMAIN,
    root: DEDICATED_DRILL_EVENT_CHAIN_ROOT,
    handoffDigest: deployment.digest,
    attemptDigest: attempt.attemptDigest,
  }), "utf8"));
}

/** Render one permanently non-authorizing attempt report. */
export function renderDedicatedDrillAttemptReport(input, handoffRecord) {
  const deployment = validateDedicatedDrillHandoffRecord(handoffRecord);
  const root = record(input, "dedicated drill attempt report input");
  exactKeys(root, [
    "scenario", "startedAt", "finishedAt", "observedOutcome", "status", "events",
    "gatewayReceiptDigest", "faultProof", "teardown", "evidenceBundle",
  ], "dedicated drill attempt report input");
  const attempt = attemptForScenario(deployment.handoff, root.scenario);
  const report = normalizeAttemptReport({
    schemaVersion: 1,
    kind: DEDICATED_DRILL_ATTEMPT_REPORT_KIND,
    handoffDigest: deployment.digest,
    attemptDigest: attempt.attemptDigest,
    suiteId: deployment.handoff.suiteId,
    scenario: attempt.scenario,
    scenarioNonce: attempt.scenarioNonce,
    jobId: attempt.jobId,
    planDigest: attempt.bindings.planDigest,
    instanceId: attempt.hostLease.instanceId,
    startedAt: root.startedAt,
    finishedAt: root.finishedAt,
    observedOutcome: root.observedOutcome,
    status: root.status,
    events: root.events,
    eventsDigest: sha256(Buffer.from(canonicalJson(root.events), "utf8")),
    gatewayReceiptDigest: root.gatewayReceiptDigest,
    faultProof: root.faultProof,
    teardown: root.teardown,
    evidenceBundle: root.evidenceBundle,
    evidenceBundleDigest: sha256(Buffer.from(canonicalJson(root.evidenceBundle), "utf8")),
    selfAttested: false,
    authoritativeDrill: false,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: DEDICATED_DRILL_AUTHORIZATION_STATUS,
  }, deployment);
  const wire = canonicalJson(report);
  return deepFreeze({ report, canonicalJson: wire, digest: sha256(Buffer.from(wire, "utf8")) });
}

/** Revalidate a rendered attempt report and exact canonical bytes. */
export function validateDedicatedDrillAttemptReportRecord(value, handoffRecord) {
  const deployment = validateDedicatedDrillHandoffRecord(handoffRecord);
  const root = record(value, "dedicated drill attempt report record");
  exactKeys(root, ["report", "canonicalJson", "digest"], "dedicated drill attempt report record");
  const report = normalizeAttemptReport(root.report, deployment);
  const wire = canonicalJson(report);
  if (root.canonicalJson !== wire || root.digest !== sha256(Buffer.from(wire, "utf8"))) {
    throw new Error("dedicated drill attempt report record contains substituted canonical bytes");
  }
  return deepFreeze({ report, canonicalJson: wire, digest: root.digest });
}

/** Parse only exact canonical attempt report bytes. */
export function parseCanonicalDedicatedDrillAttemptReport(text, handoffRecord) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") < 1 ||
      Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("dedicated drill attempt report bytes are missing or excessive");
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("dedicated drill attempt report is not JSON"); }
  const deployment = validateDedicatedDrillHandoffRecord(handoffRecord);
  const report = normalizeAttemptReport(parsed, deployment);
  const wire = canonicalJson(report);
  if (wire !== text) throw new Error("dedicated drill attempt report is not exact canonical JSON");
  return deepFreeze({ report, canonicalJson: wire, digest: sha256(Buffer.from(wire, "utf8")) });
}

function normalizeHandoff(value) {
  const root = record(value, "dedicated drill handoff");
  exactKeys(root, [
    "schemaVersion", "kind", "suiteId", "sourceRevision", "issuedAt", "provider",
    "providerScopeDigest", "controller", "observer", "evidenceSink", "attempts",
    "attemptsDigest", "handoffScope",
    "selfAttested", "authoritativeDrill", "releaseEvidenceEligible", "activationBlocked",
    "externalSigningEligible", "authorizationStatus",
  ], "dedicated drill handoff");
  assertBlockedBoundary(root, DEDICATED_DRILL_HANDOFF_KIND, "dedicated drill handoff");
  if (root.handoffScope !== HANDOFF_SCOPE) throw new Error("dedicated drill handoff scope is unsupported");
  const issuedAt = timestamp(root.issuedAt, "dedicated drill handoff issue time");
  const suiteId = exactPattern(root.suiteId, SUITE_ID, "dedicated drill suite ID");
  const sourceRevision = exactPattern(root.sourceRevision, REVISION, "dedicated drill source revision");
  const provider = validateProvider(root.provider);
  const providerScopeDigest = digest(root.providerScopeDigest, "dedicated drill provider scope");
  const controller = validateController(root.controller);
  const observer = validateObserver(root.observer);
  assertIndependentObserver(controller, observer);
  const attemptContext = {
    suiteId, sourceRevision, issuedAt, provider, providerScopeDigest, controller, observer,
  };
  const attempts = normalizeRenderedAttempts(root.attempts, attemptContext);
  const attemptsDigest = sha256(Buffer.from(canonicalJson(attempts), "utf8"));
  if (root.attemptsDigest !== attemptsDigest) throw new Error("dedicated drill attempts digest is substituted");
  const evidenceSink = validateEvidenceSink(root.evidenceSink, controller, attempts);
  const normalized = {
    schemaVersion: 1,
    kind: DEDICATED_DRILL_HANDOFF_KIND,
    suiteId,
    sourceRevision,
    issuedAt,
    provider,
    providerScopeDigest,
    controller,
    observer,
    evidenceSink,
    attempts,
    attemptsDigest,
    handoffScope: HANDOFF_SCOPE,
    selfAttested: false,
    authoritativeDrill: false,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: DEDICATED_DRILL_AUTHORIZATION_STATUS,
  };
  const bytes = canonicalJson(normalized);
  if (Buffer.byteLength(bytes, "utf8") > MAX_HANDOFF_BYTES) throw new Error("dedicated drill handoff is excessive");
  return deepFreeze(normalized);
}

function normalizeAttemptInputs(value, context) {
  if (!Array.isArray(value) || value.length !== DEDICATED_DRILL_SCENARIOS.length) {
    throw new Error("dedicated drill handoff requires the exact 17-scenario matrix");
  }
  const attempts = value.map((entry, index) => {
    const root = record(entry, `dedicated drill attempt input ${index}`);
    exactKeys(root, [
      "scenario", "scenarioNonce", "deadlineAt", "jobId", "bindings", "hostLease", "faultProfile",
    ], `dedicated drill attempt input ${index}`);
    const expected = DEDICATED_DRILL_SCENARIOS[index];
    if (root.scenario !== expected.name) throw new Error("dedicated drill scenarios are missing, reordered, or substituted");
    const attemptWithoutDigest = normalizeAttemptBody({
      ...root,
      expectedOutcome: expected.expectedOutcome,
    }, context);
    return deepFreeze({
      ...attemptWithoutDigest,
      attemptDigest: attemptDigestFor(context, attemptWithoutDigest),
    });
  });
  assertIndependentAttempts(attempts);
  return deepFreeze(attempts);
}

function normalizeRenderedAttempts(value, context) {
  if (!Array.isArray(value) || value.length !== DEDICATED_DRILL_SCENARIOS.length) {
    throw new Error("dedicated drill handoff requires the exact 17 rendered attempts");
  }
  const attempts = value.map((entry, index) => {
    const root = record(entry, `dedicated drill attempt ${index}`);
    exactKeys(root, [
      "scenario", "expectedOutcome", "scenarioNonce", "deadlineAt", "jobId", "bindings",
      "hostLease", "faultProfile", "attemptDigest",
    ], `dedicated drill attempt ${index}`);
    const expected = DEDICATED_DRILL_SCENARIOS[index];
    if (root.scenario !== expected.name || root.expectedOutcome !== expected.expectedOutcome) {
      throw new Error("dedicated drill rendered scenarios are missing, reordered, or substituted");
    }
    const { attemptDigest, ...body } = root;
    const normalizedBody = normalizeAttemptBody(body, context);
    const expectedDigest = attemptDigestFor(context, normalizedBody);
    if (attemptDigest !== expectedDigest) throw new Error("dedicated drill attempt digest is substituted");
    return deepFreeze({ ...normalizedBody, attemptDigest: expectedDigest });
  });
  assertIndependentAttempts(attempts);
  return deepFreeze(attempts);
}

function normalizeAttemptBody(value, context) {
  const root = record(value, "dedicated drill attempt body");
  exactKeys(root, [
    "scenario", "expectedOutcome", "scenarioNonce", "deadlineAt", "jobId", "bindings",
    "hostLease", "faultProfile",
  ], "dedicated drill attempt body");
  const scenario = scenarioDefinition(root.scenario);
  if (root.expectedOutcome !== scenario.expectedOutcome) throw new Error("dedicated drill expected outcome is substituted");
  const bindings = validateAttemptBindings(root.bindings);
  const deadlineAt = timestamp(root.deadlineAt, `${root.scenario} deadline`);
  const hostLease = validateHostLease(root.hostLease, bindings, deadlineAt, context);
  const faultProfile = validateFaultProfile(root.faultProfile, root.scenario);
  return deepFreeze({
    scenario: root.scenario,
    expectedOutcome: root.expectedOutcome,
    scenarioNonce: digest(root.scenarioNonce, `${root.scenario} scenario nonce`),
    deadlineAt,
    jobId: exactPattern(root.jobId, JOB_ID, `${root.scenario} job ID`),
    bindings,
    hostLease,
    faultProfile,
  });
}

function validateAttemptBindings(value) {
  const root = record(value, "dedicated drill attempt bindings");
  exactKeys(root, [
    "jobDigest", "planDigest", "hostProfileDigest", "runtimeManifestDigest",
    "gatewayContractDigest", "nftablesPolicyDigest", "imageDigest",
  ], "dedicated drill attempt bindings");
  return deepFreeze(Object.fromEntries(Object.entries(root).map(([name, value]) => [name, digest(value, name)])));
}

function validateHostLease(value, bindings, deadlineAt, context) {
  const root = record(value, "dedicated drill host lease");
  exactKeys(root, [
    "leaseId", "provider", "providerScopeDigest", "providerLeaseReceiptDigest",
    "providerLeaseReceipt", "instanceId", "instanceIdentityDigest", "imageDigest",
    "initialBootId", "createdAt", "expiresAt", "fresh", "dedicated", "disposable",
    "reused", "selfAttested",
  ], "dedicated drill host lease");
  const createdAt = timestamp(root.createdAt, "dedicated drill host creation time");
  const expiresAt = timestamp(root.expiresAt, "dedicated drill host lease expiry");
  if (createdAt > context.issuedAt || context.issuedAt - createdAt > MAX_HOST_AGE_AT_HANDOFF_MS ||
      deadlineAt <= context.issuedAt || deadlineAt > context.issuedAt + MAX_ATTEMPT_WINDOW_MS ||
      deadlineAt >= expiresAt || expiresAt > context.issuedAt + MAX_LEASE_WINDOW_MS) {
    throw new Error("dedicated drill handoff or deadline is outside the host lease");
  }
  if (root.imageDigest !== bindings.imageDigest) throw new Error("dedicated drill host lease substitutes the image digest");
  if (root.fresh !== true || root.dedicated !== true || root.disposable !== true ||
      root.reused !== false || root.selfAttested !== false) {
    throw new Error("dedicated drill host lease is not a fresh externally identified disposable host");
  }
  const instanceId = exactPattern(root.instanceId, INSTANCE_ID, "dedicated drill instance ID");
  if (instanceId === context.controller.hostId || instanceId === context.observer.hostId) {
    throw new Error("dedicated drill target host aliases the external control boundary");
  }
  const provider = validateProvider(root.provider);
  const providerScopeDigest = digest(root.providerScopeDigest, "provider scope");
  if (provider !== context.provider || providerScopeDigest !== context.providerScopeDigest) {
    throw new Error("dedicated drill host lease substitutes the provider or provider scope");
  }
  const leaseId = exactPattern(root.leaseId, IDENTIFIER, "dedicated drill lease ID");
  const instanceIdentityDigest = digest(root.instanceIdentityDigest, "instance identity");
  const providerLeaseReceiptDigest = digest(root.providerLeaseReceiptDigest, "provider lease receipt");
  const providerLeaseReceipt = validateProviderLeaseReceipt(root.providerLeaseReceipt, {
    provider,
    providerScopeDigest,
    leaseId,
    instanceId,
    instanceIdentityDigest,
    imageDigest: bindings.imageDigest,
    controllerPrincipalDigest: context.controller.principalDigest,
    createdAt,
    expiresAt,
    receiptDigest: providerLeaseReceiptDigest,
  });
  return deepFreeze({
    leaseId,
    provider,
    providerScopeDigest,
    providerLeaseReceiptDigest,
    providerLeaseReceipt,
    instanceId,
    instanceIdentityDigest,
    imageDigest: bindings.imageDigest,
    initialBootId: digest(root.initialBootId, "initial boot ID"),
    createdAt,
    expiresAt,
    fresh: true,
    dedicated: true,
    disposable: true,
    reused: false,
    selfAttested: false,
  });
}

function validateFaultProfile(value, scenario) {
  const root = record(value, `${scenario} fault profile`);
  if (scenario === "oom") {
    exactKeys(root, [
      "kind", "cgroupVersion", "memoryMaxBytes", "memorySwapMaxBytes", "allocationBytes",
      "oomKillDeltaMinimum", "unitNameDigest", "cgroupPathDigest", "expectedSystemdResult",
      "hostMustRemainReachable",
    ], "OOM fault profile");
    if (root.kind !== "bounded_cgroup_v2_oom" || root.cgroupVersion !== 2 ||
        !Number.isSafeInteger(root.memoryMaxBytes) || root.memoryMaxBytes < MIN_MEMORY_MAX ||
        root.memoryMaxBytes > MAX_MEMORY_MAX || root.memorySwapMaxBytes !== 0 ||
        !Number.isSafeInteger(root.allocationBytes) || root.allocationBytes <= root.memoryMaxBytes ||
        root.allocationBytes > root.memoryMaxBytes * 2 || root.oomKillDeltaMinimum !== 1 ||
        root.expectedSystemdResult !== "oom-kill" || root.hostMustRemainReachable !== true) {
      throw new Error("OOM fault profile is not an exact bounded cgroup-v2 drill");
    }
    return deepFreeze({
      ...structuredClone(root),
      unitNameDigest: digest(root.unitNameDigest, "OOM systemd unit name"),
      cgroupPathDigest: digest(root.cgroupPathDigest, "OOM cgroup path"),
    });
  }
  if (scenario === "reboot") {
    exactKeys(root, [
      "kind", "operationNonceDigest", "requireUnreachableTransition", "requireReconnect",
      "requireSameInstanceIdentity", "requireBootIdChange", "maxUnavailableMs",
    ], "reboot fault profile");
    if (root.kind !== "provider_control_plane_reboot" ||
        root.requireUnreachableTransition !== true || root.requireReconnect !== true ||
        root.requireSameInstanceIdentity !== true || root.requireBootIdChange !== true ||
        !Number.isSafeInteger(root.maxUnavailableMs) || root.maxUnavailableMs < 30_000 ||
        root.maxUnavailableMs > 600_000) {
      throw new Error("reboot fault profile is not an externally controlled bounded reboot");
    }
    return deepFreeze({ ...structuredClone(root), operationNonceDigest: digest(root.operationNonceDigest, "reboot operation nonce") });
  }
  exactKeys(root, ["kind"], `${scenario} no-fault profile`);
  if (root.kind !== "none") throw new Error(`${scenario} cannot substitute an OOM or reboot fault profile`);
  return deepFreeze({ kind: "none" });
}

function validateController(value) {
  const root = record(value, "dedicated drill controller");
  exactKeys(root, [
    "controllerId", "hostId", "trustDomain", "principalDigest", "runtimeDigest", "role",
    "targetMutationAccess", "evidenceSinkOwner", "targetCredentialDelivery",
  ], "dedicated drill controller");
  if (root.role !== "external_controller" || root.targetMutationAccess !== "provider_control_plane" ||
      root.evidenceSinkOwner !== true || root.targetCredentialDelivery !== "ephemeral_session_only") {
    throw new Error("dedicated drill controller boundary is unsupported");
  }
  return deepFreeze({
    controllerId: exactPattern(root.controllerId, IDENTIFIER, "controller ID"),
    hostId: exactPattern(root.hostId, IDENTIFIER, "controller host ID"),
    trustDomain: exactPattern(root.trustDomain, IDENTIFIER, "controller trust domain"),
    principalDigest: digest(root.principalDigest, "controller principal"),
    runtimeDigest: digest(root.runtimeDigest, "controller runtime"),
    role: "external_controller",
    targetMutationAccess: "provider_control_plane",
    evidenceSinkOwner: true,
    targetCredentialDelivery: "ephemeral_session_only",
  });
}

function validateObserver(value) {
  const root = record(value, "dedicated drill observer");
  exactKeys(root, [
    "observerId", "hostId", "trustDomain", "principalDigest", "runtimeDigest", "role",
    "targetMutationAccess", "evidenceSinkAppendOnly",
  ], "dedicated drill observer");
  if (root.role !== "external_read_only_observer" || root.targetMutationAccess !== "none" ||
      root.evidenceSinkAppendOnly !== true) {
    throw new Error("dedicated drill observer is not an independent read-only boundary");
  }
  return deepFreeze({
    observerId: exactPattern(root.observerId, IDENTIFIER, "observer ID"),
    hostId: exactPattern(root.hostId, IDENTIFIER, "observer host ID"),
    trustDomain: exactPattern(root.trustDomain, IDENTIFIER, "observer trust domain"),
    principalDigest: digest(root.principalDigest, "observer principal"),
    runtimeDigest: digest(root.runtimeDigest, "observer runtime"),
    role: "external_read_only_observer",
    targetMutationAccess: "none",
    evidenceSinkAppendOnly: true,
  });
}

function assertIndependentObserver(controller, observer) {
  if (controller.hostId === observer.hostId || controller.principalDigest === observer.principalDigest ||
      controller.runtimeDigest === observer.runtimeDigest || controller.controllerId === observer.observerId ||
      controller.trustDomain === observer.trustDomain) {
    throw new Error("dedicated drill controller and observer must be independently identified and hosted");
  }
}

function validateEvidenceSink(value, controller, attempts) {
  const root = record(value, "dedicated drill evidence sink");
  exactKeys(root, [
    "kind", "ownerControllerId", "locationReference", "locationDigest", "retentionUntil",
    "offHost", "appendOnly", "controllerOwned", "targetWriteAccess", "targetCredentialsPresent",
  ], "dedicated drill evidence sink");
  const retentionUntil = timestamp(root.retentionUntil, "evidence retention deadline");
  const locationReference = evidenceReference(root.locationReference, "evidence sink location");
  const locationDigest = sha256(Buffer.from(locationReference, "utf8"));
  if (root.kind !== "controller_owned_append_only" || root.ownerControllerId !== controller.controllerId ||
      root.locationDigest !== locationDigest ||
      retentionUntil < Math.max(...attempts.map(({ deadlineAt }) => deadlineAt)) + MIN_EVIDENCE_RETENTION_MS ||
      root.offHost !== true || root.appendOnly !== true || root.controllerOwned !== true ||
      root.targetWriteAccess !== false || root.targetCredentialsPresent !== false) {
    throw new Error("dedicated drill evidence sink is not controller-owned, off-host, and target-inaccessible");
  }
  return deepFreeze({
    kind: "controller_owned_append_only",
    ownerControllerId: controller.controllerId,
    locationReference,
    locationDigest,
    retentionUntil,
    offHost: true,
    appendOnly: true,
    controllerOwned: true,
    targetWriteAccess: false,
    targetCredentialsPresent: false,
  });
}

function normalizeAttemptReport(value, deployment) {
  const root = record(value, "dedicated drill attempt report");
  exactKeys(root, [
    "schemaVersion", "kind", "handoffDigest", "attemptDigest", "suiteId", "scenario",
    "scenarioNonce", "jobId", "planDigest", "instanceId", "startedAt", "finishedAt",
    "observedOutcome", "status", "events", "eventsDigest", "gatewayReceiptDigest",
    "faultProof", "teardown", "evidenceBundle", "evidenceBundleDigest", "selfAttested",
    "authoritativeDrill", "releaseEvidenceEligible", "activationBlocked",
    "externalSigningEligible", "authorizationStatus",
  ], "dedicated drill attempt report");
  assertBlockedBoundary(root, DEDICATED_DRILL_ATTEMPT_REPORT_KIND, "dedicated drill attempt report");
  const attempt = attemptForScenario(deployment.handoff, root.scenario);
  const exactBindings = {
    handoffDigest: deployment.digest,
    attemptDigest: attempt.attemptDigest,
    suiteId: deployment.handoff.suiteId,
    scenarioNonce: attempt.scenarioNonce,
    jobId: attempt.jobId,
    planDigest: attempt.bindings.planDigest,
    instanceId: attempt.hostLease.instanceId,
  };
  for (const [name, expected] of Object.entries(exactBindings)) {
    if (root[name] !== expected) throw new Error(`dedicated drill attempt report substitutes ${name}`);
  }
  if (root.status !== "passed" || root.observedOutcome !== attempt.expectedOutcome) {
    throw new Error("dedicated drill attempt did not prove its fixed expected outcome");
  }
  const startedAt = timestamp(root.startedAt, "dedicated drill attempt start");
  const finishedAt = timestamp(root.finishedAt, "dedicated drill attempt finish");
  if (startedAt < deployment.handoff.issuedAt || finishedAt <= startedAt ||
      finishedAt >= attempt.deadlineAt || finishedAt >= attempt.hostLease.expiresAt) {
    throw new Error("dedicated drill attempt timestamps are outside the handoff or host lease");
  }
  const events = validateEvents(root.events, deployment, attempt, startedAt, finishedAt);
  const eventsDigest = sha256(Buffer.from(canonicalJson(events), "utf8"));
  if (root.eventsDigest !== eventsDigest) throw new Error("dedicated drill event-stream digest is substituted");
  const gatewayReceiptDigest = digest(root.gatewayReceiptDigest, "dedicated drill gateway receipt");
  const faultProof = validateFaultProof(root.faultProof, deployment, attempt, events);
  const teardown = validateTeardown(root.teardown, deployment, attempt, events);
  const evidenceBundle = validateEvidenceBundle(
    root.evidenceBundle,
    deployment,
    attempt,
    events,
    gatewayReceiptDigest,
    eventsDigest,
    faultProof,
    teardown
  );
  const evidenceBundleDigest = sha256(Buffer.from(canonicalJson(evidenceBundle), "utf8"));
  if (root.evidenceBundleDigest !== evidenceBundleDigest) {
    throw new Error("dedicated drill off-host evidence bundle digest is substituted");
  }
  return deepFreeze({
    ...structuredClone(root),
    startedAt,
    finishedAt,
    events,
    eventsDigest,
    gatewayReceiptDigest,
    faultProof,
    teardown,
    evidenceBundle,
    evidenceBundleDigest,
    selfAttested: false,
    authoritativeDrill: false,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: DEDICATED_DRILL_AUTHORIZATION_STATUS,
  });
}

function validateEvents(value, deployment, attempt, startedAt, finishedAt) {
  const order = dedicatedDrillEventOrder(attempt.scenario);
  if (!Array.isArray(value) || value.length !== order.length) {
    throw new Error("dedicated drill event stream is incomplete");
  }
  let previousDigest = eventChainRootFor(deployment, attempt);
  let previousTimestamp = 0;
  const events = value.map((entry, index) => {
    const root = record(entry, `dedicated drill event ${index}`);
    exactKeys(root, [
      "sequence", "event", "scenario", "handoffDigest", "attemptDigest", "jobId", "planDigest",
      "instanceId", "bootId", "observedAt", "evidenceDigest", "previousEventDigest", "eventDigest",
    ], `dedicated drill event ${index}`);
    if (root.sequence !== index + 1 || root.event !== order[index] || root.scenario !== attempt.scenario ||
        root.handoffDigest !== deployment.digest || root.attemptDigest !== attempt.attemptDigest || root.jobId !== attempt.jobId ||
        root.planDigest !== attempt.bindings.planDigest || root.instanceId !== attempt.hostLease.instanceId ||
        root.previousEventDigest !== previousDigest) {
      throw new Error("dedicated drill event is reordered, unchained, or substitutes its attempt");
    }
    const observedAt = timestamp(root.observedAt, `${root.event} observation`);
    if (observedAt <= previousTimestamp) throw new Error("dedicated drill event timestamps must strictly increase");
    const eventWithoutDigest = {
      sequence: root.sequence,
      event: root.event,
      scenario: root.scenario,
      handoffDigest: root.handoffDigest,
      attemptDigest: root.attemptDigest,
      jobId: root.jobId,
      planDigest: root.planDigest,
      instanceId: root.instanceId,
      bootId: digest(root.bootId, `${root.event} boot ID`),
      observedAt,
      evidenceDigest: digest(root.evidenceDigest, `${root.event} evidence`),
      previousEventDigest: root.previousEventDigest,
    };
    const eventDigest = sha256(Buffer.from(canonicalJson(eventWithoutDigest), "utf8"));
    if (root.eventDigest !== eventDigest) throw new Error("dedicated drill event digest is substituted");
    previousDigest = eventDigest;
    previousTimestamp = observedAt;
    return deepFreeze({ ...eventWithoutDigest, eventDigest });
  });
  if (events[0].observedAt !== startedAt || events.at(-1).observedAt !== finishedAt) {
    throw new Error("dedicated drill observer boundaries do not match report timestamps");
  }
  validateBootTimeline(events, attempt);
  if (new Set(events.map(({ evidenceDigest }) => evidenceDigest)).size !== events.length) {
    throw new Error("dedicated drill event evidence artifacts must be independently identified");
  }
  const byName = Object.fromEntries(events.map((event) => [event.event, event]));
  if (byName.host_lease_verified.evidenceDigest !== attempt.hostLease.providerLeaseReceiptDigest) {
    throw new Error("dedicated drill host lease event does not bind the provider lease receipt");
  }
  return deepFreeze(events);
}

function validateBootTimeline(events, attempt) {
  const initialBoot = attempt.hostLease.initialBootId;
  if (attempt.scenario !== "reboot") {
    if (events.some(({ bootId }) => bootId !== initialBoot)) {
      throw new Error("non-reboot dedicated drill changed the bound boot identity");
    }
    return;
  }
  const reconnect = events.findIndex(({ event }) => event === "host_reconnected");
  const before = events.slice(0, reconnect);
  const after = events.slice(reconnect);
  if (before.some(({ bootId }) => bootId !== initialBoot)) {
    throw new Error("reboot drill changed boot identity before the reconnect boundary");
  }
  const nextBoot = after[0]?.bootId;
  if (!nextBoot || nextBoot === initialBoot || after.some(({ bootId }) => bootId !== nextBoot)) {
    throw new Error("reboot drill does not bind one distinct post-reboot boot identity");
  }
}

function validateFaultProof(value, deployment, attempt, events) {
  const root = record(value, `${attempt.scenario} fault proof`);
  const byName = Object.fromEntries(events.map((event) => [event.event, event]));
  if (attempt.scenario === "oom") {
    exactKeys(root, [
      "kind", "memoryMaxBytes", "memorySwapMaxBytes", "allocationBytes",
      "unitNameDigest", "cgroupPathDigest", "memoryEventsBefore", "memoryEventsAfter",
      "memoryEventsBeforeDigest", "memoryEventsAfterDigest", "oomKillDelta", "systemdResult",
      "hostReachableAfterFault", "containmentPresentAtFault", "limitsEvidenceDigest",
      "workloadEvidenceDigest", "evidenceDigest",
    ], "OOM fault proof");
    const profile = attempt.faultProfile;
    const memoryEventsBefore = validateMemoryEventsSnapshot(
      root.memoryEventsBefore,
      "OOM memory.events before",
      profile,
      byName.oom_limits_verified.observedAt
    );
    const memoryEventsAfter = validateMemoryEventsSnapshot(
      root.memoryEventsAfter,
      "OOM memory.events after",
      profile,
      byName.oom_observed.observedAt
    );
    const memoryEventsBeforeDigest = sha256(Buffer.from(canonicalJson(memoryEventsBefore), "utf8"));
    const memoryEventsAfterDigest = sha256(Buffer.from(canonicalJson(memoryEventsAfter), "utf8"));
    const oomKillDelta = memoryEventsAfter.counters.oomKill - memoryEventsBefore.counters.oomKill;
    if (root.kind !== profile.kind || root.memoryMaxBytes !== profile.memoryMaxBytes ||
        root.memorySwapMaxBytes !== profile.memorySwapMaxBytes || root.allocationBytes !== profile.allocationBytes ||
        root.unitNameDigest !== profile.unitNameDigest || root.cgroupPathDigest !== profile.cgroupPathDigest ||
        root.memoryEventsBeforeDigest !== memoryEventsBeforeDigest ||
        root.memoryEventsAfterDigest !== memoryEventsAfterDigest ||
        memoryEventsBeforeDigest === memoryEventsAfterDigest || root.oomKillDelta !== oomKillDelta ||
        oomKillDelta < profile.oomKillDeltaMinimum ||
        memoryEventsAfter.counters.oom - memoryEventsBefore.counters.oom < profile.oomKillDeltaMinimum ||
        !monotonicMemoryEvents(memoryEventsBefore.counters, memoryEventsAfter.counters) ||
        root.systemdResult !== profile.expectedSystemdResult || root.hostReachableAfterFault !== true ||
        root.containmentPresentAtFault !== true ||
        root.limitsEvidenceDigest !== byName.oom_limits_verified.evidenceDigest ||
        root.workloadEvidenceDigest !== byName.oom_workload_started.evidenceDigest ||
        root.evidenceDigest !== byName.oom_observed.evidenceDigest) {
      throw new Error("OOM fault proof does not prove the bounded cgroup kill and live host");
    }
    return deepFreeze({
      ...structuredClone(root),
      unitNameDigest: digest(root.unitNameDigest, "OOM systemd unit name"),
      cgroupPathDigest: digest(root.cgroupPathDigest, "OOM cgroup path"),
      memoryEventsBefore,
      memoryEventsAfter,
      memoryEventsBeforeDigest,
      memoryEventsAfterDigest,
      limitsEvidenceDigest: digest(root.limitsEvidenceDigest, "OOM limits evidence"),
      workloadEvidenceDigest: digest(root.workloadEvidenceDigest, "OOM workload evidence"),
      evidenceDigest: digest(root.evidenceDigest, "OOM proof evidence"),
    });
  }
  if (attempt.scenario === "reboot") {
    exactKeys(root, [
      "kind", "providerOperation", "instanceIdentityBeforeDigest", "instanceIdentityAfterDigest",
      "bootIdBefore", "bootIdAfter", "unreachableObserved",
      "reconnectedObserved", "postRebootUnitsIdle", "postRebootContainmentAbsent", "evidenceDigest",
    ], "reboot fault proof");
    const profile = attempt.faultProfile;
    const providerOperation = validateProviderOperationReceipt(root.providerOperation, deployment, attempt, events);
    const postBoot = byName.post_reboot_boot_observed.bootId;
    const unavailableMs = byName.host_reconnected.observedAt - byName.host_unreachable.observedAt;
    if (root.kind !== profile.kind || providerOperation.operationNonceDigest !== profile.operationNonceDigest ||
        root.instanceIdentityBeforeDigest !== attempt.hostLease.instanceIdentityDigest ||
        root.instanceIdentityAfterDigest !== attempt.hostLease.instanceIdentityDigest ||
        root.bootIdBefore !== attempt.hostLease.initialBootId || root.bootIdAfter === root.bootIdBefore ||
        root.bootIdAfter !== postBoot || root.unreachableObserved !== true || root.reconnectedObserved !== true ||
        root.postRebootUnitsIdle !== true || root.postRebootContainmentAbsent !== true ||
        unavailableMs > profile.maxUnavailableMs || root.evidenceDigest !== byName.post_reboot_boot_observed.evidenceDigest) {
      throw new Error("reboot fault proof does not prove provider-controlled loss and a new boot");
    }
    return deepFreeze({
      ...structuredClone(root),
      providerOperation,
      evidenceDigest: digest(root.evidenceDigest, "reboot proof evidence"),
    });
  }
  exactKeys(root, [
    "kind", "scenario", "stimulusEvent", "observationEvent", "stimulusEvidenceDigest",
    "outcomeEvidenceDigest",
  ], `${attempt.scenario} scenario proof`);
  const proof = genericScenarioProofDefinition(attempt.scenario);
  if (root.kind !== "scenario_observation" || root.scenario !== attempt.scenario ||
      root.stimulusEvent !== proof.stimulusEvent || root.observationEvent !== proof.observationEvent) {
    throw new Error("dedicated drill generic scenario proof is substituted");
  }
  if (root.stimulusEvidenceDigest !== byName[proof.stimulusEvent].evidenceDigest ||
      root.outcomeEvidenceDigest !== byName[proof.observationEvent].evidenceDigest) {
    throw new Error("dedicated drill generic proof does not bind its stimulus and observation events");
  }
  return deepFreeze({
    kind: "scenario_observation",
    scenario: attempt.scenario,
    stimulusEvent: proof.stimulusEvent,
    observationEvent: proof.observationEvent,
    stimulusEvidenceDigest: digest(root.stimulusEvidenceDigest, `${attempt.scenario} stimulus evidence`),
    outcomeEvidenceDigest: digest(root.outcomeEvidenceDigest, `${attempt.scenario} outcome evidence`),
  });
}

function validateTeardown(value, deployment, attempt, events) {
  const root = record(value, "dedicated drill teardown");
  exactKeys(root, [
    "gatewayStoppedAt", "runnerUidIdleAt", "gatewayUidIdleAt", "cgroupNamespaceCleanupAt",
    "workspaceCleanupAt", "containmentFinalizedAt", "hostDestroyedAt", "containmentDisposition",
    "preFilesystemQuiescenceProven", "workspaceAbsent", "containmentAbsent", "tableRemovedLast",
    "rebootResetContainmentBeforeCleanup", "providerDestroyReceipt", "hostDestroyed", "complete",
    "evidenceDigest",
  ], "dedicated drill teardown");
  const byName = Object.fromEntries(events.map((event) => [event.event, event]));
  const reboot = attempt.scenario === "reboot";
  const expected = reboot ? {
    gatewayStoppedAt: byName.post_reboot_units_idle.observedAt,
    runnerUidIdleAt: byName.post_reboot_units_idle.observedAt,
    gatewayUidIdleAt: byName.post_reboot_units_idle.observedAt,
    cgroupNamespaceCleanupAt: byName.cgroup_namespace_cleanup.observedAt,
    workspaceCleanupAt: byName.workspace_cleanup.observedAt,
    containmentFinalizedAt: byName.post_reboot_containment_absent.observedAt,
    hostDestroyedAt: byName.host_destroyed.observedAt,
  } : {
    gatewayStoppedAt: byName.gateway_stopped.observedAt,
    runnerUidIdleAt: byName.runner_uid_idle.observedAt,
    gatewayUidIdleAt: byName.gateway_uid_idle.observedAt,
    cgroupNamespaceCleanupAt: byName.cgroup_namespace_cleanup.observedAt,
    workspaceCleanupAt: byName.workspace_cleanup.observedAt,
    containmentFinalizedAt: byName.nftables_policy_removed.observedAt,
    hostDestroyedAt: byName.host_destroyed.observedAt,
  };
  for (const [name, timestampValue] of Object.entries(expected)) {
    if (root[name] !== timestampValue) throw new Error(`dedicated drill teardown substitutes ${name}`);
  }
  const expectedDisposition = reboot
    ? "reboot_reset_then_pre_policy_quiescence"
    : "table_removed_last_after_quiescence";
  if (root.containmentDisposition !== expectedDisposition || root.preFilesystemQuiescenceProven !== true ||
      root.workspaceAbsent !== true || root.containmentAbsent !== true ||
      root.tableRemovedLast !== !reboot || root.rebootResetContainmentBeforeCleanup !== reboot ||
      root.hostDestroyed !== true || root.complete !== true) {
    throw new Error("dedicated drill teardown is incomplete or misstates containment disposal");
  }
  if (!reboot && !(root.cgroupNamespaceCleanupAt < root.workspaceCleanupAt &&
      root.workspaceCleanupAt < root.containmentFinalizedAt &&
      root.containmentFinalizedAt < root.hostDestroyedAt)) {
    throw new Error("dedicated drill containment was not removed last after cleanup");
  }
  if (reboot && !(root.gatewayStoppedAt < root.containmentFinalizedAt &&
      root.containmentFinalizedAt < root.cgroupNamespaceCleanupAt &&
      root.cgroupNamespaceCleanupAt < root.workspaceCleanupAt &&
      root.workspaceCleanupAt < root.hostDestroyedAt)) {
    throw new Error("reboot recovery cleanup is not fail-closed after post-boot quiescence");
  }
  const providerDestroyReceipt = validateProviderDestroyReceipt(
    root.providerDestroyReceipt,
    deployment,
    attempt,
    byName.host_destroyed
  );
  if (root.evidenceDigest !== byName.scenario_finished.evidenceDigest) {
    throw new Error("dedicated drill teardown does not bind the scenario-finished evidence");
  }
  return deepFreeze({
    ...structuredClone(root),
    providerDestroyReceipt,
    evidenceDigest: digest(root.evidenceDigest, "teardown evidence"),
  });
}

function validateEvidenceBundle(
  value,
  deployment,
  attempt,
  events,
  gatewayReceiptDigest,
  eventsDigest,
  faultProof,
  teardown
) {
  const root = record(value, "dedicated drill off-host evidence bundle");
  exactKeys(root, [
    "manifestVersion", "kind", "sinkLocationReference", "sinkLocationDigest", "objectReference",
    "controllerPrincipalDigest", "observerPrincipalDigest", "handoffDigest", "attemptDigest",
    "eventsDigest", "eventEvidence", "gatewayReceipt", "faultProof", "faultEvidence",
    "teardown", "providerLeaseReceipt", "providerOperationReceipt", "providerDestroyReceipt",
    "rawEvidence", "appendReceipt",
  ], "dedicated drill off-host evidence bundle");
  const base = evidenceBaseReference(deployment, attempt);
  const byName = Object.fromEntries(events.map((event) => [event.event, event]));
  if (byName.gateway_ready.evidenceDigest !== gatewayReceiptDigest) {
    throw new Error("dedicated drill gateway event does not bind the gateway receipt");
  }
  const expected = {
    manifestVersion: 1,
    kind: "dedicated_drill_evidence_manifest",
    sinkLocationReference: deployment.handoff.evidenceSink.locationReference,
    sinkLocationDigest: deployment.handoff.evidenceSink.locationDigest,
    objectReference: `${base}/manifest.json`,
    controllerPrincipalDigest: deployment.handoff.controller.principalDigest,
    observerPrincipalDigest: deployment.handoff.observer.principalDigest,
    handoffDigest: deployment.digest,
    attemptDigest: attempt.attemptDigest,
    eventsDigest,
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (root[name] !== expectedValue) throw new Error(`dedicated drill evidence bundle substitutes ${name}`);
  }
  const eventEvidence = events.map((event) => deepFreeze({
    sequence: event.sequence,
    event: event.event,
    eventDigest: event.eventDigest,
    evidenceDigest: event.evidenceDigest,
    objectReference: `${base}/events/${String(event.sequence).padStart(2, "0")}-${event.event}.json`,
  }));
  if (canonicalJson(root.eventEvidence) !== canonicalJson(eventEvidence)) {
    throw new Error("dedicated drill evidence manifest substitutes event evidence objects");
  }
  const faultProofDigest = sha256(Buffer.from(canonicalJson(faultProof), "utf8"));
  const teardownDigest = sha256(Buffer.from(canonicalJson(teardown), "utf8"));
  const gatewayReceipt = exactEvidenceArtifact(root.gatewayReceipt, {
    digest: gatewayReceiptDigest,
    objectReference: `${base}/gateway-receipt.json`,
  }, "gateway receipt");
  const faultProofArtifact = exactEvidenceArtifact(root.faultProof, {
    digest: faultProofDigest,
    objectReference: `${base}/fault-proof.json`,
  }, "fault proof");
  const faultEvidence = expectedFaultEvidence(faultProof, attempt, base);
  if (canonicalJson(root.faultEvidence) !== canonicalJson(faultEvidence)) {
    throw new Error("dedicated drill evidence manifest substitutes fault evidence objects");
  }
  const teardownArtifact = exactEvidenceArtifact(root.teardown, {
    digest: teardownDigest,
    objectReference: `${base}/teardown.json`,
  }, "teardown");
  const providerLeaseReceipt = exactEvidenceArtifact(root.providerLeaseReceipt, {
    digest: attempt.hostLease.providerLeaseReceiptDigest,
    objectReference: `${base}/provider-lease-receipt.json`,
  }, "provider lease receipt");
  const expectedProviderOperation = attempt.scenario === "reboot" ? {
    digest: faultProof.providerOperation.receiptDigest,
    objectReference: `${base}/provider-operation-receipt.json`,
  } : null;
  let providerOperationReceipt = null;
  if (expectedProviderOperation === null) {
    if (root.providerOperationReceipt !== null) {
      throw new Error("non-reboot dedicated drill cannot claim a provider operation receipt");
    }
  } else {
    providerOperationReceipt = exactEvidenceArtifact(
      root.providerOperationReceipt,
      expectedProviderOperation,
      "provider operation receipt"
    );
  }
  const providerDestroyReceipt = exactEvidenceArtifact(root.providerDestroyReceipt, {
    digest: teardown.providerDestroyReceipt.receiptDigest,
    objectReference: `${base}/provider-destroy-receipt.json`,
  }, "provider destroy receipt");
  const rawEvidence = exactEvidenceArtifact(root.rawEvidence, {
    digest: digest(record(root.rawEvidence, "raw evidence artifact").digest, "raw off-host evidence"),
    objectReference: `${base}/raw-evidence.tar.zst`,
  }, "raw evidence");
  const appendReceipt = exactEvidenceArtifact(root.appendReceipt, {
    digest: digest(record(root.appendReceipt, "append receipt artifact").digest, "off-host append receipt"),
    objectReference: `${base}/append-receipt.json`,
  }, "append receipt");
  const independentDigests = [rawEvidence.digest, appendReceipt.digest];
  const reservedDigests = new Set([
    ...events.map(({ evidenceDigest }) => evidenceDigest),
    faultProofDigest,
    teardownDigest,
    ...faultEvidence.map(({ digest: value }) => value),
  ]);
  if (new Set(independentDigests).size !== independentDigests.length ||
      independentDigests.some((value) => reservedDigests.has(value))) {
    throw new Error("dedicated drill raw evidence and append receipt must be independently identified");
  }
  return deepFreeze({
    ...expected,
    eventEvidence,
    gatewayReceipt,
    faultProof: faultProofArtifact,
    faultEvidence,
    teardown: teardownArtifact,
    providerLeaseReceipt,
    providerOperationReceipt,
    providerDestroyReceipt,
    rawEvidence,
    appendReceipt,
  });
}

function attemptDigestFor(context, attemptBody) {
  return sha256(Buffer.from(canonicalJson({
    domain: ATTEMPT_DIGEST_DOMAIN,
    suiteId: context.suiteId,
    sourceRevision: context.sourceRevision,
    issuedAt: context.issuedAt,
    provider: context.provider,
    providerScopeDigest: context.providerScopeDigest,
    controller: context.controller,
    observer: context.observer,
    attempt: attemptBody,
  }), "utf8"));
}

function eventChainRootFor(deployment, attempt) {
  return sha256(Buffer.from(canonicalJson({
    domain: EVENT_CHAIN_DOMAIN,
    root: DEDICATED_DRILL_EVENT_CHAIN_ROOT,
    handoffDigest: deployment.digest,
    attemptDigest: attempt.attemptDigest,
  }), "utf8"));
}

function validateMemoryEventsSnapshot(value, label, profile, observedAt) {
  const root = record(value, label);
  exactKeys(root, ["unitNameDigest", "cgroupPathDigest", "observedAt", "counters"], label);
  if (root.unitNameDigest !== profile.unitNameDigest ||
      root.cgroupPathDigest !== profile.cgroupPathDigest || root.observedAt !== observedAt) {
    throw new Error(`${label} substitutes its cgroup, unit, or observation boundary`);
  }
  const counters = record(root.counters, `${label} counters`);
  exactKeys(counters, ["oom", "oomKill", "oomGroupKill"], `${label} counters`);
  for (const [name, counter] of Object.entries(counters)) {
    if (!Number.isSafeInteger(counter) || counter < 0) {
      throw new Error(`${label} ${name} is not a non-negative safe counter`);
    }
  }
  return deepFreeze({
    unitNameDigest: profile.unitNameDigest,
    cgroupPathDigest: profile.cgroupPathDigest,
    observedAt,
    counters: {
      oom: counters.oom,
      oomKill: counters.oomKill,
      oomGroupKill: counters.oomGroupKill,
    },
  });
}

function monotonicMemoryEvents(before, after) {
  return Object.keys(before).every((name) => after[name] >= before[name]);
}

function validateProviderLeaseReceipt(value, expectedBindings) {
  const root = record(value, "provider lease receipt");
  exactKeys(root, [
    "kind", "provider", "providerScopeDigest", "leaseId", "instanceId",
    "instanceIdentityDigest", "imageDigest", "controllerPrincipalDigest", "createdAt",
    "expiresAt", "receiptDigest",
  ], "provider lease receipt");
  const expected = { kind: "provider_lease_receipt", ...expectedBindings };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (root[name] !== expectedValue) throw new Error(`provider lease receipt substitutes ${name}`);
  }
  return deepFreeze(expected);
}

function validateProviderOperationReceipt(value, deployment, attempt, events) {
  const root = record(value, "reboot provider operation receipt");
  exactKeys(root, [
    "kind", "operationNonceDigest", "provider", "providerScopeDigest", "instanceId",
    "instanceIdentityDigest", "controllerPrincipalDigest", "requestedAt", "unreachableAt",
    "reconnectedAt", "completedAt", "receiptDigest",
  ], "reboot provider operation receipt");
  const byName = Object.fromEntries(events.map((event) => [event.event, event]));
  const expected = {
    kind: "provider_reboot_receipt",
    operationNonceDigest: attempt.faultProfile.operationNonceDigest,
    provider: deployment.handoff.provider,
    providerScopeDigest: deployment.handoff.providerScopeDigest,
    instanceId: attempt.hostLease.instanceId,
    instanceIdentityDigest: attempt.hostLease.instanceIdentityDigest,
    controllerPrincipalDigest: deployment.handoff.controller.principalDigest,
    requestedAt: byName.reboot_requested.observedAt,
    unreachableAt: byName.host_unreachable.observedAt,
    reconnectedAt: byName.host_reconnected.observedAt,
    completedAt: byName.post_reboot_boot_observed.observedAt,
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (root[name] !== expectedValue) throw new Error(`reboot provider operation receipt substitutes ${name}`);
  }
  const receiptDigest = digest(root.receiptDigest, "reboot provider operation receipt");
  if (receiptDigest !== byName.reboot_requested.evidenceDigest) {
    throw new Error("reboot request event does not bind the provider operation receipt");
  }
  return deepFreeze({ ...expected, receiptDigest });
}

function validateProviderDestroyReceipt(value, deployment, attempt, destroyedEvent) {
  const root = record(value, "provider destroy receipt");
  exactKeys(root, [
    "kind", "provider", "providerScopeDigest", "instanceId", "instanceIdentityDigest",
    "controllerPrincipalDigest", "destroyedAt", "receiptDigest",
  ], "provider destroy receipt");
  const expected = {
    kind: "provider_destroy_receipt",
    provider: deployment.handoff.provider,
    providerScopeDigest: deployment.handoff.providerScopeDigest,
    instanceId: attempt.hostLease.instanceId,
    instanceIdentityDigest: attempt.hostLease.instanceIdentityDigest,
    controllerPrincipalDigest: deployment.handoff.controller.principalDigest,
    destroyedAt: destroyedEvent.observedAt,
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (root[name] !== expectedValue) throw new Error(`provider destroy receipt substitutes ${name}`);
  }
  const receiptDigest = digest(root.receiptDigest, "provider destroy receipt");
  if (receiptDigest !== destroyedEvent.evidenceDigest) {
    throw new Error("host-destroyed event does not bind the provider destroy receipt");
  }
  return deepFreeze({ ...expected, receiptDigest });
}

function evidenceBaseReference(deployment, attempt) {
  return `${deployment.handoff.evidenceSink.locationReference}/dedicated-drill/` +
    `${deployment.digest.slice("sha256:".length)}/${attempt.attemptDigest.slice("sha256:".length)}`;
}

function exactEvidenceArtifact(value, expected, label) {
  const root = record(value, `${label} evidence artifact`);
  exactKeys(root, ["digest", "objectReference"], `${label} evidence artifact`);
  const normalized = {
    digest: digest(root.digest, `${label} evidence artifact`),
    objectReference: evidenceReference(root.objectReference, `${label} evidence artifact reference`),
  };
  if (canonicalJson(normalized) !== canonicalJson(expected)) {
    throw new Error(`dedicated drill evidence manifest substitutes ${label}`);
  }
  return deepFreeze(normalized);
}

function expectedFaultEvidence(faultProof, attempt, base) {
  if (attempt.scenario === "oom") {
    return deepFreeze([
      { name: "memory_events_before", digest: faultProof.memoryEventsBeforeDigest,
        objectReference: `${base}/fault/memory-events-before.json` },
      { name: "memory_events_after", digest: faultProof.memoryEventsAfterDigest,
        objectReference: `${base}/fault/memory-events-after.json` },
      { name: "limits", digest: faultProof.limitsEvidenceDigest,
        objectReference: `${base}/fault/limits.json` },
      { name: "workload", digest: faultProof.workloadEvidenceDigest,
        objectReference: `${base}/fault/workload.json` },
      { name: "observation", digest: faultProof.evidenceDigest,
        objectReference: `${base}/fault/observation.json` },
    ]);
  }
  if (attempt.scenario === "reboot") {
    return deepFreeze([
      { name: "provider_operation", digest: faultProof.providerOperation.receiptDigest,
        objectReference: `${base}/provider-operation-receipt.json` },
      { name: "observation", digest: faultProof.evidenceDigest,
        objectReference: `${base}/fault/observation.json` },
    ]);
  }
  return deepFreeze([{
    name: "stimulus",
    digest: faultProof.stimulusEvidenceDigest,
    objectReference: `${base}/fault/stimulus.json`,
  }, {
    name: "outcome",
    digest: faultProof.outcomeEvidenceDigest,
    objectReference: `${base}/fault/outcome.json`,
  }]);
}

function assertBlockedBoundary(root, expectedKind, label) {
  if (root.schemaVersion !== 1 || root.kind !== expectedKind || root.selfAttested !== false ||
      root.authoritativeDrill !== false || root.releaseEvidenceEligible !== false ||
      root.activationBlocked !== true || root.externalSigningEligible !== false ||
      root.authorizationStatus !== DEDICATED_DRILL_AUTHORIZATION_STATUS) {
    throw new Error(`${label} cannot authorize release, activation, signing, or publication`);
  }
}

function assertIndependentAttempts(attempts) {
  for (const [name, values] of [
    ["scenario nonce", attempts.map(({ scenarioNonce }) => scenarioNonce)],
    ["job ID", attempts.map(({ jobId }) => jobId)],
    ["job digest", attempts.map(({ bindings }) => bindings.jobDigest)],
    ["plan digest", attempts.map(({ bindings }) => bindings.planDigest)],
    ["lease ID", attempts.map(({ hostLease }) => hostLease.leaseId)],
    ["instance ID", attempts.map(({ hostLease }) => hostLease.instanceId)],
    ["instance identity", attempts.map(({ hostLease }) => hostLease.instanceIdentityDigest)],
    ["initial boot ID", attempts.map(({ hostLease }) => hostLease.initialBootId)],
    ["provider lease receipt", attempts.map(({ hostLease }) => hostLease.providerLeaseReceiptDigest)],
    ["attempt digest", attempts.map(({ attemptDigest }) => attemptDigest)],
  ]) {
    if (new Set(values).size !== attempts.length) {
      throw new Error(`dedicated drill requires one fresh independent ${name} per scenario`);
    }
  }
}

function attemptForScenario(handoff, scenario) {
  scenarioDefinition(scenario);
  const attempt = handoff.attempts.find((entry) => entry.scenario === scenario);
  if (!attempt) throw new Error("dedicated drill handoff is missing the requested scenario");
  return attempt;
}

function genericScenarioProofDefinition(scenario) {
  const fixed = {
    timeout: {
      stimulusEvent: "timeout_injected",
      observationEvent: "timeout_observed",
      insertObservationAfter: null,
    },
    sigkill: {
      stimulusEvent: "sigkill_injected",
      observationEvent: "sigkill_observed",
      insertObservationAfter: null,
    },
    gateway_stop: {
      stimulusEvent: "gateway_stopped",
      observationEvent: "gateway_stop_observed",
      insertObservationAfter: "offline_network_checked",
    },
    uid_idle: {
      stimulusEvent: "runner_uid_idle",
      observationEvent: "uid_idle_observed",
      insertObservationAfter: "gateway_uid_idle",
    },
    policy_removal: {
      stimulusEvent: "nftables_policy_removed",
      observationEvent: "policy_removal_observed",
      insertObservationAfter: "nftables_policy_removed",
    },
    cgroup_namespace_cleanup: {
      stimulusEvent: "cgroup_namespace_cleanup",
      observationEvent: "cgroup_namespace_cleanup_observed",
      insertObservationAfter: "cgroup_namespace_cleanup",
    },
    workspace_cleanup: {
      stimulusEvent: "workspace_cleanup",
      observationEvent: "workspace_cleanup_observed",
      insertObservationAfter: "workspace_cleanup",
    },
  };
  if (fixed[scenario]) return fixed[scenario];
  if (scenario === "oom" || scenario === "reboot") {
    throw new Error("OOM and reboot use dedicated fault-proof event definitions");
  }
  scenarioDefinition(scenario);
  return {
    stimulusEvent: `${scenario}_probe_started`,
    observationEvent: `${scenario}_observed`,
    insertObservationAfter: null,
  };
}

function scenarioDefinition(name) {
  const scenario = DEDICATED_DRILL_SCENARIOS.find((entry) => entry.name === name);
  if (!scenario) throw new Error("dedicated drill scenario is unsupported");
  return scenario;
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
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

function exactPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validateProvider(value) {
  const provider = exactPattern(value, PROVIDER, "dedicated drill provider");
  if (["github-hosted", "localhost", "local", "self-hosted"].includes(provider)) {
    throw new Error("dedicated drill provider cannot be a co-resident or hosted-smoke boundary");
  }
  return provider;
}

function evidenceReference(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REFERENCE_BYTES ||
      value.endsWith("/")) {
    throw new Error(`${label} is not a bounded provider-neutral object reference`);
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new Error(`${label} is not a bounded provider-neutral object reference`);
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash ||
      forbiddenEvidenceHostname(parsed.hostname)) {
    throw new Error(`${label} is not a credential-free off-host object reference`);
  }
  if (!EVIDENCE_REFERENCE.test(value) || parsed.href !== value || parsed.pathname.includes("//")) {
    throw new Error(`${label} is not an exact canonical object reference`);
  }
  return value;
}

function forbiddenEvidenceHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const octets = normalized.split(".");
  if (octets.length === 4 && octets.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part))) {
    const numbers = octets.map(Number);
    if (numbers.every((part) => part <= 255) && (numbers[0] === 0 || numbers[0] === 127)) {
      return true;
    }
  }
  return false;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} is not a SHA-256 digest`);
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMESTAMP) {
    throw new Error(`${label} is not a bounded positive timestamp`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
