import {
  canonicalJson,
  parseCanonicalPlan,
  sha256,
  validateHostProfile,
  validateJobDescriptor,
} from "./lib.mjs";
import {
  GATEWAY_PROFILE,
  renderGatewayDeployment,
  validateGatewayDeploymentRecord,
} from "../gateway/gateway-contract.mjs";

export const LIFECYCLE_AUTHORIZATION_STATUS = "non_authorizing_linux_drill_only";
export const LIFECYCLE_DRILL_KIND = "api_migrator_linux_l7_lifecycle_drill_contract";
export const LIFECYCLE_REPORT_KIND = "api_migrator_linux_l7_lifecycle_drill_report";

export const LIFECYCLE_EVENT_ORDER = Object.freeze([
  "observer_started",
  "contract_validated",
  "envoy_config_validated",
  "nftables_policy_installed",
  "gateway_started",
  "gateway_ready",
  "scenario_started",
  "scenario_finished",
  "gateway_stopped",
  "runner_uid_idle",
  "gateway_uid_idle",
  "nftables_policy_removed",
  "cgroup_namespace_cleanup",
  "workspace_cleanup",
  "observer_finished",
]);

export const LIFECYCLE_SCENARIO_MATRIX = deepFreeze([
  { name: "success", expectedOutcome: "registry_npm_tls_sni_tcp443_only" },
  { name: "timeout", expectedOutcome: "fail_closed_and_teardown" },
  { name: "sigkill", expectedOutcome: "fail_closed_and_teardown" },
  { name: "oom", expectedOutcome: "fail_closed_and_teardown" },
  { name: "reboot", expectedOutcome: "fail_closed_and_teardown" },
  { name: "wrong_sni", expectedOutcome: "blocked" },
  { name: "absent_sni", expectedOutcome: "blocked" },
  { name: "plaintext", expectedOutcome: "blocked" },
  { name: "direct_bypass", expectedOutcome: "forced_through_gateway_with_correlated_counters" },
  { name: "non_443", expectedOutcome: "blocked" },
  { name: "non_npm", expectedOutcome: "blocked" },
  { name: "offline_network", expectedOutcome: "blocked" },
  { name: "gateway_stop", expectedOutcome: "fail_closed_and_teardown" },
  { name: "uid_idle", expectedOutcome: "verified" },
  { name: "policy_removal", expectedOutcome: "verified" },
  { name: "cgroup_namespace_cleanup", expectedOutcome: "verified" },
  { name: "workspace_cleanup", expectedOutcome: "verified" },
]);

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const JOB_ID = /^previewjob_[a-f0-9]{64}$/;
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

/**
 * Cross-bind the already validated job, host, plan, and gateway inputs. This
 * renders immutable drill configuration only; it never executes or authorizes.
 */
export function renderLifecycleDrillContract(input) {
  const root = record(input, "lifecycle drill input");
  exactKeys(root, ["job", "profile", "planText", "gatewayContract"], "lifecycle drill input");
  const job = validateJobDescriptor(root.job);
  const profile = validateHostProfile(root.profile);
  const plan = parseCanonicalPlan(root.planText, job.planDigest, job.jobId);
  const gatewayDeployment = renderGatewayDeployment(root.gatewayContract);
  const gateway = gatewayDeployment.contract;
  const hostProfileDigest = sha256(Buffer.from(canonicalJson(profile), "utf8"));
  const toolBindings = lifecycleToolBindings(profile);
  const toolBindingsDigest = sha256(Buffer.from(canonicalJson(toolBindings), "utf8"));
  if (
    gateway.jobId !== job.jobId ||
    gateway.plan.digest !== job.planDigest ||
    gateway.plan.createdAt !== plan.job.createdAt ||
    gateway.plan.expiresAt !== plan.job.expiresAt
  ) {
    throw new Error("gateway contract substitutes the job or canonical plan binding");
  }
  if (gateway.egressPolicyDigest !== plan.egress.install.policyDigest) {
    throw new Error("gateway contract substitutes the install egress policy digest");
  }
  if (gateway.runnerUid !== profile.runner.uid) {
    throw new Error("gateway contract substitutes the runner UID");
  }
  if (gateway.gatewayUid !== profile.gateway.uid || gateway.gatewayUid === profile.runner.uid) {
    throw new Error("gateway contract substitutes or aliases the gateway UID");
  }
  if (gateway.listener.port !== profile.gateway.listenerPort) {
    throw new Error("gateway contract substitutes the host gateway listener port");
  }
  if (gateway.gatewayRuntimeDigest !== profile.executables.envoy.digest) {
    throw new Error("gateway contract substitutes the profile Envoy digest");
  }

  const paths = {
    runtimeRootPath: absolutePath(job.runtimeRootPath, "lifecycle runtime root path"),
    lifecyclePreflightPath: absolutePath(job.lifecyclePreflightPath, "lifecycle preflight path"),
    gatewayContractPath: absolutePath(job.gatewayContractPath, "gateway contract path"),
    gatewayReceiptPath: absolutePath(job.gatewayReceiptPath, "gateway receipt path"),
    lifecycleEventsPath: absolutePath(job.lifecycleEventsPath, "lifecycle events path"),
    lifecycleReportPath: absolutePath(job.lifecycleReportPath, "lifecycle report path"),
  };
  if (new Set(Object.values(paths)).size !== Object.keys(paths).length) {
    throw new Error("lifecycle drill artifact paths must be distinct");
  }

  const contract = deepFreeze({
    schemaVersion: 1,
    kind: LIFECYCLE_DRILL_KIND,
    profile: GATEWAY_PROFILE,
    jobId: job.jobId,
    planDigest: job.planDigest,
    planCreatedAt: plan.job.createdAt,
    planExpiresAt: plan.job.expiresAt,
    egressPolicyDigest: plan.egress.install.policyDigest,
    runnerUid: profile.runner.uid,
    gatewayUid: profile.gateway.uid,
    listenerPort: profile.gateway.listenerPort,
    envoyDigest: profile.executables.envoy.digest,
    hostProfileDigest,
    toolBindings,
    toolBindingsDigest,
    gatewayContractDigest: gatewayDeployment.digest,
    envoyConfigDigest: gatewayDeployment.envoyConfigDigest,
    nftablesPolicyDigest: gatewayDeployment.nftablesPolicyDigest,
    paths,
    eventOrder: [...LIFECYCLE_EVENT_ORDER],
    scenarioMatrix: structuredClone(LIFECYCLE_SCENARIO_MATRIX),
    executionScope: "structural_suite_template_independent_scenario_jobs",
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: LIFECYCLE_AUTHORIZATION_STATUS,
  });
  const canonical = canonicalJson(contract);
  return deepFreeze({
    contract,
    canonicalJson: canonical,
    digest: sha256(Buffer.from(canonical, "utf8")),
    gatewayDeployment,
    hostProfile: profile,
  });
}

/** Recheck a rendered record and its embedded gateway artifacts. */
export function validateLifecycleDrillContractRecord(value) {
  const root = record(value, "rendered lifecycle drill record");
  exactKeys(root, ["contract", "canonicalJson", "digest", "gatewayDeployment", "hostProfile"], "rendered lifecycle drill record");
  const gateway = validateGatewayDeploymentRecord(root.gatewayDeployment);
  const profile = validateHostProfile(root.hostProfile);
  const contract = normalizeContract(root.contract, gateway, profile);
  const canonical = canonicalJson(contract);
  if (root.canonicalJson !== canonical || root.digest !== sha256(Buffer.from(canonical, "utf8"))) {
    throw new Error("rendered lifecycle drill record contains substituted contract bytes");
  }
  return deepFreeze({
    contract,
    canonicalJson: canonical,
    digest: root.digest,
    gatewayDeployment: gateway,
    hostProfile: profile,
  });
}

/**
 * Validate the non-authorizing shape of an aggregate assembled from separate
 * scenario-job records. This structural check is not proof that any Linux job
 * ran and cannot authorize activation, signing, or publication.
 */
export function validateLifecycleDrillReport(value, renderedContract) {
  const deployment = validateLifecycleDrillContractRecord(renderedContract);
  const contract = deployment.contract;
  const root = record(value, "lifecycle drill report");
  exactKeys(root, [
    "schemaVersion", "kind", "contractDigest", "jobId", "planDigest", "egressPolicyDigest",
    "runnerUid", "gatewayUid", "envoyDigest", "gatewayContractDigest", "envoyConfigDigest",
    "nftablesPolicyDigest", "hostProfileDigest", "toolBindingsDigest", "startedAt", "finishedAt", "scenarios", "reportScope",
    "aggregateStatus", "activationBlocked", "externalSigningEligible", "authorizationStatus",
  ], "lifecycle drill report");
  if (root.schemaVersion !== 1 || root.kind !== LIFECYCLE_REPORT_KIND) {
    throw new Error("lifecycle drill report type is unsupported");
  }
  const bindings = [
    ["contractDigest", deployment.digest],
    ["jobId", contract.jobId],
    ["planDigest", contract.planDigest],
    ["egressPolicyDigest", contract.egressPolicyDigest],
    ["runnerUid", contract.runnerUid],
    ["gatewayUid", contract.gatewayUid],
    ["envoyDigest", contract.envoyDigest],
    ["gatewayContractDigest", contract.gatewayContractDigest],
    ["envoyConfigDigest", contract.envoyConfigDigest],
    ["nftablesPolicyDigest", contract.nftablesPolicyDigest],
    ["hostProfileDigest", contract.hostProfileDigest],
    ["toolBindingsDigest", contract.toolBindingsDigest],
  ];
  for (const [name, expected] of bindings) {
    if (root[name] !== expected) throw new Error(`lifecycle drill report substitutes ${name}`);
  }
  if (
    root.reportScope !== "structural_aggregate_independent_scenario_jobs" ||
    root.activationBlocked !== true ||
    root.externalSigningEligible !== false ||
    root.authorizationStatus !== LIFECYCLE_AUTHORIZATION_STATUS ||
    root.aggregateStatus !== "passed"
  ) {
    throw new Error("lifecycle drill report cannot authorize activation, signing, or publication");
  }

  const startedAt = timestamp(root.startedAt, "drill start");
  const finishedAt = timestamp(root.finishedAt, "drill finish");
  if (finishedAt <= startedAt) throw new Error("lifecycle drill aggregate timestamps are invalid");
  const scenarios = validateScenarios(root.scenarios, contract, startedAt, finishedAt);

  return deepFreeze({
    schemaVersion: 1,
    kind: LIFECYCLE_REPORT_KIND,
    contractDigest: deployment.digest,
    jobId: contract.jobId,
    planDigest: contract.planDigest,
    egressPolicyDigest: contract.egressPolicyDigest,
    runnerUid: contract.runnerUid,
    gatewayUid: contract.gatewayUid,
    envoyDigest: contract.envoyDigest,
    gatewayContractDigest: contract.gatewayContractDigest,
    envoyConfigDigest: contract.envoyConfigDigest,
    nftablesPolicyDigest: contract.nftablesPolicyDigest,
    hostProfileDigest: contract.hostProfileDigest,
    toolBindingsDigest: contract.toolBindingsDigest,
    startedAt,
    finishedAt,
    scenarios,
    reportScope: "structural_aggregate_independent_scenario_jobs",
    aggregateStatus: "passed",
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: LIFECYCLE_AUTHORIZATION_STATUS,
  });
}

export function parseCanonicalLifecycleDrillReport(text, renderedContract) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") === 0 || Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("lifecycle drill report bytes are missing or excessive");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("lifecycle drill report is not JSON");
  }
  const report = validateLifecycleDrillReport(value, renderedContract);
  const canonical = canonicalJson(report);
  if (canonical !== text) throw new Error("lifecycle drill report is not exact canonical JSON");
  return deepFreeze({ report, canonicalJson: canonical, digest: sha256(Buffer.from(canonical, "utf8")) });
}

function normalizeContract(value, gateway, profile) {
  const root = record(value, "lifecycle drill contract");
  exactKeys(root, [
    "schemaVersion", "kind", "profile", "jobId", "planDigest", "planCreatedAt", "planExpiresAt",
    "egressPolicyDigest", "runnerUid", "gatewayUid", "listenerPort", "envoyDigest",
    "gatewayContractDigest", "envoyConfigDigest", "nftablesPolicyDigest", "paths", "eventOrder",
    "hostProfileDigest", "toolBindings", "toolBindingsDigest", "scenarioMatrix", "executionScope",
    "activationBlocked", "externalSigningEligible", "authorizationStatus",
  ], "lifecycle drill contract");
  if (
    root.schemaVersion !== 1 || root.kind !== LIFECYCLE_DRILL_KIND || root.profile !== GATEWAY_PROFILE ||
    root.executionScope !== "structural_suite_template_independent_scenario_jobs" ||
    root.activationBlocked !== true || root.externalSigningEligible !== false ||
    root.authorizationStatus !== LIFECYCLE_AUTHORIZATION_STATUS
  ) throw new Error("lifecycle drill contract is not the fixed non-authorizing profile");
  if (!JOB_ID.test(root.jobId) || root.jobId !== gateway.contract.jobId) throw new Error("lifecycle drill job binding is invalid");
  for (const name of ["planDigest", "egressPolicyDigest", "envoyDigest", "gatewayContractDigest", "envoyConfigDigest", "nftablesPolicyDigest"]) digest(root[name], name);
  const expected = {
    planDigest: gateway.contract.plan.digest,
    planCreatedAt: gateway.contract.plan.createdAt,
    planExpiresAt: gateway.contract.plan.expiresAt,
    egressPolicyDigest: gateway.contract.egressPolicyDigest,
    runnerUid: gateway.contract.runnerUid,
    gatewayUid: gateway.contract.gatewayUid,
    listenerPort: gateway.contract.listener.port,
    envoyDigest: gateway.contract.gatewayRuntimeDigest,
    gatewayContractDigest: gateway.digest,
    envoyConfigDigest: gateway.envoyConfigDigest,
    nftablesPolicyDigest: gateway.nftablesPolicyDigest,
    hostProfileDigest: sha256(Buffer.from(canonicalJson(profile), "utf8")),
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (root[name] !== expectedValue) throw new Error(`lifecycle drill contract substitutes ${name}`);
  }
  if (root.runnerUid === root.gatewayUid) throw new Error("lifecycle drill identities must be distinct");
  const expectedToolBindings = lifecycleToolBindings(profile);
  if (canonicalJson(root.toolBindings) !== canonicalJson(expectedToolBindings)) {
    throw new Error("lifecycle drill contract substitutes a pinned host tool binding");
  }
  const expectedToolBindingsDigest = sha256(Buffer.from(canonicalJson(expectedToolBindings), "utf8"));
  if (root.toolBindingsDigest !== expectedToolBindingsDigest) {
    throw new Error("lifecycle drill contract substitutes the tool-binding digest");
  }
  const pathsRoot = record(root.paths, "lifecycle drill paths");
  exactKeys(pathsRoot, [
    "runtimeRootPath", "lifecyclePreflightPath", "gatewayContractPath", "gatewayReceiptPath",
    "lifecycleEventsPath", "lifecycleReportPath",
  ], "lifecycle drill paths");
  const paths = Object.fromEntries(Object.entries(pathsRoot).map(([name, path]) => [name, absolutePath(path, name)]));
  if (new Set(Object.values(paths)).size !== 6) throw new Error("lifecycle drill paths must be distinct");
  if (canonicalJson(root.eventOrder) !== canonicalJson(LIFECYCLE_EVENT_ORDER)) throw new Error("lifecycle drill event order is substituted");
  if (canonicalJson(root.scenarioMatrix) !== canonicalJson(LIFECYCLE_SCENARIO_MATRIX)) throw new Error("lifecycle drill scenario matrix is substituted");
  return deepFreeze({
    ...structuredClone(root),
    paths,
    toolBindings: expectedToolBindings,
    eventOrder: [...LIFECYCLE_EVENT_ORDER],
    scenarioMatrix: structuredClone(LIFECYCLE_SCENARIO_MATRIX),
  });
}

function validateEvents(value, scenario, startedAt, finishedAt) {
  if (!Array.isArray(value) || value.length !== LIFECYCLE_EVENT_ORDER.length) throw new Error("lifecycle event sequence is incomplete");
  let previous = -1;
  const events = value.map((entry, index) => {
    const root = record(entry, `lifecycle event ${index}`);
    exactKeys(root, ["sequence", "event", "jobId", "planDigest", "observedAt", "evidenceDigest"], `lifecycle event ${index}`);
    if (root.sequence !== index + 1 || root.event !== LIFECYCLE_EVENT_ORDER[index]) throw new Error("lifecycle events are not in exact observer-first order");
    if (root.jobId !== scenario.jobId || root.planDigest !== scenario.planDigest) throw new Error("lifecycle event substitutes the scenario job or plan binding");
    const observedAt = timestamp(root.observedAt, `${root.event} observation`);
    if (observedAt <= previous) throw new Error("lifecycle event timestamps must be strictly increasing");
    previous = observedAt;
    return { ...structuredClone(root), observedAt, evidenceDigest: digest(root.evidenceDigest, `${root.event} evidence digest`) };
  });
  if (events[0].observedAt !== startedAt || events.at(-1).observedAt !== finishedAt) throw new Error("observer boundary events do not match report timestamps");
  return events;
}

function validateScenarios(value, contract, aggregateStartedAt, aggregateFinishedAt) {
  if (!Array.isArray(value) || value.length !== LIFECYCLE_SCENARIO_MATRIX.length) throw new Error("lifecycle scenario matrix is incomplete");
  const scenarios = value.map((entry, index) => {
    const expected = LIFECYCLE_SCENARIO_MATRIX[index];
    const root = record(entry, `lifecycle scenario ${index}`);
    exactKeys(root, [
      "name", "expectedOutcome", "observedOutcome", "status", "jobId", "planDigest",
      "planCreatedAt", "planExpiresAt", "egressPolicyDigest", "runnerUid", "gatewayUid",
      "envoyDigest", "hostProfileDigest", "toolBindingsDigest", "gatewayContractDigest", "gatewayReceiptDigest", "startedAt", "finishedAt",
      "events", "eventsDigest", "teardown", "evidenceDigest",
    ], `lifecycle scenario ${index}`);
    if (root.name !== expected.name || root.expectedOutcome !== expected.expectedOutcome || root.observedOutcome !== expected.expectedOutcome || root.status !== "passed") throw new Error("lifecycle scenario result is missing, reordered, or did not prove the required outcome");
    if (!JOB_ID.test(root.jobId)) throw new Error("lifecycle scenario job ID is invalid");
    digest(root.planDigest, `${root.name} plan digest`);
    digest(root.gatewayContractDigest, `${root.name} gateway contract digest`);
    digest(root.gatewayReceiptDigest, `${root.name} gateway receipt digest`);
    digest(root.evidenceDigest, `${root.name} aggregate evidence digest`);
    if (
      root.egressPolicyDigest !== contract.egressPolicyDigest || root.runnerUid !== contract.runnerUid ||
      root.gatewayUid !== contract.gatewayUid || root.envoyDigest !== contract.envoyDigest ||
      root.hostProfileDigest !== contract.hostProfileDigest || root.toolBindingsDigest !== contract.toolBindingsDigest
    ) throw new Error("lifecycle scenario substitutes the suite security bindings");
    const planCreatedAt = timestamp(root.planCreatedAt, `${root.name} plan creation`);
    const planExpiresAt = timestamp(root.planExpiresAt, `${root.name} plan expiry`);
    if (planExpiresAt <= planCreatedAt || planExpiresAt - planCreatedAt > 900_000 || planExpiresAt - planCreatedAt < 60_000) throw new Error("lifecycle scenario plan lifetime is invalid");
    const startedAt = timestamp(root.startedAt, `${root.name} scenario start`);
    const finishedAt = timestamp(root.finishedAt, `${root.name} scenario finish`);
    if (startedAt < planCreatedAt || finishedAt <= startedAt || finishedAt >= planExpiresAt || startedAt < aggregateStartedAt || finishedAt > aggregateFinishedAt) throw new Error("lifecycle scenario timestamps are outside its independent plan or aggregate");
    const scenarioBinding = { jobId: root.jobId, planDigest: root.planDigest };
    const events = validateEvents(root.events, scenarioBinding, startedAt, finishedAt);
    const eventsDigest = sha256(Buffer.from(canonicalJson(events), "utf8"));
    if (root.eventsDigest !== eventsDigest) throw new Error("lifecycle scenario event digest is substituted");
    const eventTime = Object.fromEntries(events.map((event) => [event.event, event.observedAt]));
    const teardown = validateTeardown(root.teardown, eventTime);
    return {
      ...structuredClone(root), planCreatedAt, planExpiresAt, startedAt, finishedAt, events,
      eventsDigest, teardown, evidenceDigest: root.evidenceDigest,
    };
  });
  if (
    scenarios[0].jobId !== contract.jobId || scenarios[0].planDigest !== contract.planDigest ||
    scenarios[0].gatewayContractDigest !== contract.gatewayContractDigest ||
    scenarios[0].planCreatedAt !== contract.planCreatedAt ||
    scenarios[0].planExpiresAt !== contract.planExpiresAt
  ) throw new Error("success scenario must bind the rendered reference job and gateway contract");
  for (const name of ["jobId", "planDigest", "gatewayContractDigest", "gatewayReceiptDigest", "evidenceDigest"]) {
    if (new Set(scenarios.map((scenario) => scenario[name])).size !== scenarios.length) throw new Error(`independent lifecycle scenarios require distinct ${name} values`);
  }
  if (Math.min(...scenarios.map((scenario) => scenario.startedAt)) !== aggregateStartedAt || Math.max(...scenarios.map((scenario) => scenario.finishedAt)) !== aggregateFinishedAt) throw new Error("aggregate lifecycle timestamps do not span the independent scenario reports");
  return scenarios;
}

function lifecycleToolBindings(profile) {
  return deepFreeze({
    node: structuredClone(profile.executables.node),
    nft: structuredClone(profile.executables.nft),
    systemctl: structuredClone(profile.executables.systemctl),
    envoy: structuredClone(profile.executables.envoy),
    ss: structuredClone(profile.executables.ss),
    cleanup: {
      path: profile.artifacts.cleanupPath,
      digest: profile.artifacts.cleanupDigest,
    },
    gatewayProbe: {
      path: profile.artifacts.gatewayProbePath,
      digest: profile.artifacts.gatewayProbeDigest,
    },
    lifecycleOrchestrator: {
      path: profile.artifacts.lifecycleOrchestratorPath,
      digest: profile.artifacts.lifecycleOrchestratorDigest,
    },
    lifecycleObserver: {
      path: profile.artifacts.lifecycleObserverPath,
      digest: profile.artifacts.lifecycleObserverDigest,
    },
    runtimeManifest: {
      path: profile.artifacts.lifecycleRuntimeManifestPath,
      digest: profile.artifacts.lifecycleRuntimeManifestDigest,
    },
  });
}

function validateTeardown(value, eventTime) {
  const root = record(value, "lifecycle drill teardown");
  exactKeys(root, ["gatewayStoppedAt", "runnerUidIdleAt", "gatewayUidIdleAt", "nftablesPolicyRemovedAt", "cgroupNamespaceCleanupAt", "workspaceCleanupAt", "complete", "evidenceDigest"], "lifecycle drill teardown");
  const mapping = {
    gatewayStoppedAt: "gateway_stopped",
    runnerUidIdleAt: "runner_uid_idle",
    gatewayUidIdleAt: "gateway_uid_idle",
    nftablesPolicyRemovedAt: "nftables_policy_removed",
    cgroupNamespaceCleanupAt: "cgroup_namespace_cleanup",
    workspaceCleanupAt: "workspace_cleanup",
  };
  for (const [name, event] of Object.entries(mapping)) {
    if (timestamp(root[name], name) !== eventTime[event]) throw new Error(`lifecycle teardown ${name} does not match observer evidence`);
  }
  if (root.complete !== true) throw new Error("lifecycle drill teardown is incomplete");
  return { ...structuredClone(root), evidenceDigest: digest(root.evidenceDigest, "lifecycle teardown evidence") };
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  return value;
}

function exactKeys(value, names, label) {
  const actual = Object.keys(value).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new Error(`${label} has unsupported or missing fields`);
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} is not a SHA-256 digest`);
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMESTAMP) throw new Error(`${label} is not a bounded positive timestamp`);
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !ABSOLUTE_PATH.test(value) || value.includes("//") || value.includes("/../") || value.endsWith("/..") || value.includes("/./") || value.endsWith("/.")) throw new Error(`${label} is not a canonical absolute path`);
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
