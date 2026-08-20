import { isAbsolute, resolve } from "node:path";

import { canonicalJson, sha256 } from "./lib.mjs";

export const HOSTED_SMOKE_PROFILE = "github-hosted-ubuntu-24.04-l7-smoke-v1";
export const HOSTED_SMOKE_AUTHORIZATION_STATUS = "non_authorizing_github_hosted_smoke_only";
export const HOSTED_SMOKE_SCENARIO_REPORT_KIND = "api_migrator_github_hosted_l7_smoke_scenario_report";
export const HOSTED_SMOKE_AGGREGATE_REPORT_KIND = "api_migrator_github_hosted_l7_smoke_aggregate_report";
export const HOSTED_SMOKE_EVENT_KIND = "api_migrator_github_hosted_l7_smoke_event";
export const HOSTED_SMOKE_EVIDENCE_CLASS = "non_authorizing_github_hosted_l7_smoke";

export const HOSTED_SMOKE_SCENARIO_MATRIX = deepFreeze([
  { name: "success", expectedOutcome: "registry_npm_tls_sni_tcp443_only" },
  { name: "timeout", expectedOutcome: "fail_closed_and_teardown" },
  { name: "sigkill", expectedOutcome: "fail_closed_and_teardown" },
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

export const HOSTED_SMOKE_OMITTED_SCENARIOS = Object.freeze(["oom", "reboot"]);

// The gateway is deliberately stopped before the offline check. Containment
// remains installed until both identity/cgroup cleanup and exact workspace
// cleanup have been observed. Policy removal is the final host mutation.
export const HOSTED_SMOKE_EVENT_ORDER = Object.freeze([
  "observer_started",
  "contract_validated",
  "envoy_config_validated",
  "nftables_policy_validated",
  "nftables_policy_installed",
  "gateway_started",
  "gateway_ready",
  "scenario_started",
  "gateway_stopped",
  "offline_network_checked",
  "runner_uid_idle",
  "gateway_uid_idle",
  "cgroup_namespace_cleanup",
  "workspace_cleanup",
  "nftables_policy_removed",
  "scenario_finished",
  "observer_finished",
]);

export const HOSTED_SMOKE_EVENT_CHAIN_ROOT = sha256(Buffer.alloc(0));

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SUITE_ID = /^hostedsmoke_[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const NFT_TABLE = /^api_migrator_gw_[a-f0-9]{16}$/;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MAX_SCENARIO_BYTES = 256 * 1024;
const MAX_AGGREGATE_BYTES = 4 * 1024 * 1024;
const TOOL_NAMES = Object.freeze([
  "node", "envoy", "nft", "ss", "systemctl", "systemdRun", "journalctl", "setpriv", "ip",
]);
const ONLINE_SCENARIOS = new Set([
  "success", "timeout", "sigkill", "wrong_sni", "absent_sni", "plaintext",
  "direct_bypass", "non_443", "non_npm",
]);

/** Build the exact hash-chained event stream from fixed timestamps/evidence digests. */
export function buildHostedSmokeEventStream(input) {
  const root = record(input, "hosted smoke event-stream input");
  exactKeys(root, ["observedAt", "evidenceDigests"], "hosted smoke event-stream input");
  const observedAt = record(root.observedAt, "hosted smoke event timestamps");
  const evidenceDigests = record(root.evidenceDigests, "hosted smoke event evidence digests");
  exactKeys(observedAt, HOSTED_SMOKE_EVENT_ORDER, "hosted smoke event timestamps");
  exactKeys(evidenceDigests, HOSTED_SMOKE_EVENT_ORDER, "hosted smoke event evidence digests");
  const events = [];
  let previousEventDigest = HOSTED_SMOKE_EVENT_CHAIN_ROOT;
  let previousTimestamp = 0;
  for (let index = 0; index < HOSTED_SMOKE_EVENT_ORDER.length; index += 1) {
    const event = HOSTED_SMOKE_EVENT_ORDER[index];
    const eventTimestamp = timestamp(observedAt[event], `${event} observation`);
    if (eventTimestamp <= previousTimestamp) {
      throw new Error("hosted smoke event timestamps must be strictly increasing");
    }
    const entry = deepFreeze({
      schemaVersion: 1,
      kind: HOSTED_SMOKE_EVENT_KIND,
      sequence: index + 1,
      event,
      observedAt: eventTimestamp,
      evidenceDigest: digest(evidenceDigests[event], `${event} evidence digest`),
      previousEventDigest,
      releaseEvidenceEligible: false,
      activationBlocked: true,
      externalSigningEligible: false,
      authorizationStatus: HOSTED_SMOKE_AUTHORIZATION_STATUS,
    });
    events.push(entry);
    previousEventDigest = sha256(Buffer.from(canonicalJson(entry), "utf8"));
    previousTimestamp = eventTimestamp;
  }
  return deepFreeze(events);
}

/** Build and canonicalize one self-attested, permanently non-authorizing scenario report. */
export function buildHostedSmokeScenarioReport(input) {
  const root = record(input, "hosted smoke scenario input");
  assertNoForbiddenAuthorityFields(root);
  exactKeys(root, [
    "suiteId", "scenarioName", "sourceRevision", "githubRun", "host", "toolBindings",
    "gateway", "checks", "scenarioEvidence", "events", "teardown", "startedAt", "finishedAt",
  ], "hosted smoke scenario input");
  const scenario = scenarioDefinition(root.scenarioName);
  const toolBindings = validateToolBindings(root.toolBindings);
  const scenarioEvidence = validateScenarioEvidence(root.scenarioEvidence, scenario.name);
  const report = {
    schemaVersion: 1,
    kind: HOSTED_SMOKE_SCENARIO_REPORT_KIND,
    profile: HOSTED_SMOKE_PROFILE,
    evidenceClass: HOSTED_SMOKE_EVIDENCE_CLASS,
    suiteId: root.suiteId,
    scenarioName: scenario.name,
    expectedOutcome: scenario.expectedOutcome,
    observedOutcome: scenario.expectedOutcome,
    sourceRevision: root.sourceRevision,
    githubRun: structuredClone(root.githubRun),
    host: structuredClone(root.host),
    hostDigest: sha256(Buffer.from(canonicalJson(root.host), "utf8")),
    toolBindings,
    toolBindingsDigest: sha256(Buffer.from(canonicalJson(toolBindings), "utf8")),
    gateway: structuredClone(root.gateway),
    checks: structuredClone(root.checks),
    scenarioEvidence,
    scenarioEvidenceDigest: sha256(Buffer.from(canonicalJson(scenarioEvidence), "utf8")),
    events: structuredClone(root.events),
    eventsDigest: sha256(Buffer.from(canonicalJson(root.events), "utf8")),
    teardown: structuredClone(root.teardown),
    startedAt: root.startedAt,
    finishedAt: root.finishedAt,
    status: "passed",
    environmentScope: "github_hosted_ubuntu_24_04_smoke",
    executionScope: "single_scenario_fresh_github_hosted_vm_lifecycle",
    omittedScenarios: [...HOSTED_SMOKE_OMITTED_SCENARIOS],
    selfAttested: true,
    authoritativeDrill: false,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: HOSTED_SMOKE_AUTHORIZATION_STATUS,
  };
  const validated = validateHostedSmokeScenarioReport(report);
  const canonical = canonicalJson(validated);
  return deepFreeze({
    report: validated,
    canonicalJson: canonical,
    digest: sha256(Buffer.from(canonical, "utf8")),
  });
}

/** Validate one hosted scenario without treating it as release or attestation evidence. */
export function validateHostedSmokeScenarioReport(value) {
  const root = record(value, "hosted smoke scenario report");
  assertNoForbiddenAuthorityFields(root);
  exactKeys(root, [
    "schemaVersion", "kind", "profile", "evidenceClass", "suiteId", "scenarioName",
    "expectedOutcome", "observedOutcome", "sourceRevision", "githubRun", "host", "hostDigest",
    "toolBindings", "toolBindingsDigest", "gateway", "checks", "scenarioEvidence",
    "scenarioEvidenceDigest", "events", "eventsDigest", "teardown", "startedAt", "finishedAt",
    "status", "environmentScope", "executionScope", "omittedScenarios", "selfAttested",
    "authoritativeDrill", "releaseEvidenceEligible", "activationBlocked",
    "externalSigningEligible", "authorizationStatus",
  ], "hosted smoke scenario report");
  if (
    root.schemaVersion !== 1 || root.kind !== HOSTED_SMOKE_SCENARIO_REPORT_KIND ||
    root.profile !== HOSTED_SMOKE_PROFILE || root.evidenceClass !== HOSTED_SMOKE_EVIDENCE_CLASS ||
    root.status !== "passed" || root.environmentScope !== "github_hosted_ubuntu_24_04_smoke" ||
    root.executionScope !== "single_scenario_fresh_github_hosted_vm_lifecycle" ||
    root.selfAttested !== true || root.authoritativeDrill !== false ||
    root.releaseEvidenceEligible !== false || root.activationBlocked !== true ||
    root.externalSigningEligible !== false ||
    root.authorizationStatus !== HOSTED_SMOKE_AUTHORIZATION_STATUS
  ) {
    throw new Error("hosted smoke scenario cannot authorize release, activation, signing, or publication");
  }
  exactPattern(root.suiteId, SUITE_ID, "hosted smoke suite id");
  exactPattern(root.sourceRevision, COMMIT, "hosted smoke source revision");
  if (canonicalJson(root.omittedScenarios) !== canonicalJson(HOSTED_SMOKE_OMITTED_SCENARIOS)) {
    throw new Error("hosted smoke omitted-scenario boundary is substituted");
  }
  const scenario = scenarioDefinition(root.scenarioName);
  if (root.expectedOutcome !== scenario.expectedOutcome || root.observedOutcome !== scenario.expectedOutcome) {
    throw new Error("hosted smoke scenario did not prove its fixed expected outcome");
  }
  const githubRun = validateGithubRun(root.githubRun);
  const host = validateHostedHost(root.host);
  const hostDigest = sha256(Buffer.from(canonicalJson(host), "utf8"));
  if (root.hostDigest !== hostDigest) throw new Error("hosted smoke host digest is substituted");
  const toolBindings = validateToolBindings(root.toolBindings);
  const toolBindingsDigest = sha256(Buffer.from(canonicalJson(toolBindings), "utf8"));
  if (root.toolBindingsDigest !== toolBindingsDigest) {
    throw new Error("hosted smoke tool-binding digest is substituted");
  }
  const gateway = validateGatewayEvidence(root.gateway);
  const checks = validateChecks(root.checks, gateway);
  const scenarioEvidence = validateScenarioEvidence(root.scenarioEvidence, scenario.name);
  const scenarioEvidenceDigest = sha256(Buffer.from(canonicalJson(scenarioEvidence), "utf8"));
  if (root.scenarioEvidenceDigest !== scenarioEvidenceDigest) {
    throw new Error("hosted smoke scenario-evidence digest is substituted");
  }
  const teardown = validateTeardown(root.teardown);
  const startedAt = timestamp(root.startedAt, "hosted smoke scenario start");
  const finishedAt = timestamp(root.finishedAt, "hosted smoke scenario finish");
  if (finishedAt <= startedAt) throw new Error("hosted smoke scenario timestamps are invalid");
  const expectedEventDigests = {
    observer_started: checks.preMutation.evidenceDigest,
    contract_validated: gateway.gatewayContractDigest,
    envoy_config_validated: checks.nativeValidation.envoyEvidenceDigest,
    nftables_policy_validated: checks.nativeValidation.nftablesEvidenceDigest,
    nftables_policy_installed: checks.policyInstallation.evidenceDigest,
    gateway_started: checks.gatewayRuntime.startEvidenceDigest,
    gateway_ready: checks.listenerReadiness.evidenceDigest,
    scenario_started: checks.scenarioStartEvidenceDigest,
    gateway_stopped: checks.gatewayRuntime.stopEvidenceDigest,
    offline_network_checked: checks.offlineFailClosed.evidenceDigest,
    runner_uid_idle: teardown.runnerUidIdleEvidenceDigest,
    gateway_uid_idle: teardown.gatewayUidIdleEvidenceDigest,
    cgroup_namespace_cleanup: teardown.cgroupNamespaceEvidenceDigest,
    workspace_cleanup: teardown.workspaceEvidenceDigest,
    nftables_policy_removed: teardown.nftablesRemovalEvidenceDigest,
    scenario_finished: scenarioEvidenceDigest,
    observer_finished: checks.finalSnapshotEvidenceDigest,
  };
  const { events, byName } = validateEventStream(root.events, expectedEventDigests);
  const eventsDigest = sha256(Buffer.from(canonicalJson(events), "utf8"));
  if (root.eventsDigest !== eventsDigest) throw new Error("hosted smoke event-stream digest is substituted");
  if (byName.observer_started.observedAt !== startedAt || byName.observer_finished.observedAt !== finishedAt) {
    throw new Error("hosted smoke observer boundary does not match report timestamps");
  }
  validateTeardownTimeline(teardown, byName);
  validateScenarioObservationTime(scenario.name, scenarioEvidence.observedAt, byName);

  return deepFreeze({
    ...structuredClone(root),
    githubRun,
    host,
    hostDigest,
    toolBindings,
    toolBindingsDigest,
    gateway,
    checks,
    scenarioEvidence,
    scenarioEvidenceDigest,
    events,
    eventsDigest,
    teardown,
    startedAt,
    finishedAt,
  });
}

export function parseCanonicalHostedSmokeScenarioReport(text) {
  const value = parseCanonicalObject(text, "hosted smoke scenario report", MAX_SCENARIO_BYTES);
  const report = validateHostedSmokeScenarioReport(value);
  const canonical = canonicalJson(report);
  if (canonical !== text) throw new Error("hosted smoke scenario report is not exact canonical JSON");
  return deepFreeze({ report, canonicalJson: canonical, digest: sha256(Buffer.from(canonical, "utf8")) });
}

/** Build the 15-scenario aggregate from complete scenario report objects. */
export function buildHostedSmokeAggregateReport(input) {
  const root = record(input, "hosted smoke aggregate input");
  exactKeys(root, ["scenarioReports"], "hosted smoke aggregate input");
  if (!Array.isArray(root.scenarioReports) || root.scenarioReports.length !== HOSTED_SMOKE_SCENARIO_MATRIX.length) {
    throw new Error("hosted smoke aggregate requires exactly 15 scenario reports");
  }
  const byName = new Map();
  for (const value of root.scenarioReports) {
    const report = validateHostedSmokeScenarioReport(value);
    if (byName.has(report.scenarioName)) throw new Error("hosted smoke aggregate contains a duplicate scenario report");
    byName.set(report.scenarioName, report);
  }
  const scenarioReports = HOSTED_SMOKE_SCENARIO_MATRIX.map(({ name }) => {
    const report = byName.get(name);
    if (!report) throw new Error(`hosted smoke aggregate is missing ${name}`);
    return report;
  });
  const first = scenarioReports[0];
  const scenarioReportDigests = scenarioReports.map((report) => ({
    name: report.scenarioName,
    reportDigest: sha256(Buffer.from(canonicalJson(report), "utf8")),
    hostDigest: report.hostDigest,
    toolBindingsDigest: report.toolBindingsDigest,
  }));
  const aggregate = {
    schemaVersion: 1,
    kind: HOSTED_SMOKE_AGGREGATE_REPORT_KIND,
    profile: HOSTED_SMOKE_PROFILE,
    evidenceClass: `${HOSTED_SMOKE_EVIDENCE_CLASS}_aggregate`,
    suiteId: first.suiteId,
    sourceRevision: first.sourceRevision,
    githubRun: structuredClone(first.githubRun),
    startedAt: Math.min(...scenarioReports.map((report) => report.startedAt)),
    finishedAt: Math.max(...scenarioReports.map((report) => report.finishedAt)),
    scenarioCount: HOSTED_SMOKE_SCENARIO_MATRIX.length,
    scenarioReports: structuredClone(scenarioReports),
    scenarioReportDigests,
    omittedScenarios: [...HOSTED_SMOKE_OMITTED_SCENARIOS],
    aggregateStatus: "passed",
    reportScope: "github_hosted_independent_fresh_vm_15_scenario_aggregate",
    selfAttested: true,
    authoritativeDrill: false,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: HOSTED_SMOKE_AUTHORIZATION_STATUS,
  };
  const validated = validateHostedSmokeAggregateReport(aggregate);
  const canonical = canonicalJson(validated);
  return deepFreeze({
    report: validated,
    canonicalJson: canonical,
    digest: sha256(Buffer.from(canonical, "utf8")),
  });
}

export function validateHostedSmokeAggregateReport(value) {
  const root = record(value, "hosted smoke aggregate report");
  assertNoForbiddenAuthorityFields(root);
  exactKeys(root, [
    "schemaVersion", "kind", "profile", "evidenceClass", "suiteId", "sourceRevision", "githubRun",
    "startedAt", "finishedAt", "scenarioCount",
    "scenarioReports", "scenarioReportDigests", "omittedScenarios", "aggregateStatus",
    "reportScope", "selfAttested", "authoritativeDrill", "releaseEvidenceEligible",
    "activationBlocked", "externalSigningEligible", "authorizationStatus",
  ], "hosted smoke aggregate report");
  if (
    root.schemaVersion !== 1 || root.kind !== HOSTED_SMOKE_AGGREGATE_REPORT_KIND ||
    root.profile !== HOSTED_SMOKE_PROFILE ||
    root.evidenceClass !== `${HOSTED_SMOKE_EVIDENCE_CLASS}_aggregate` ||
    root.aggregateStatus !== "passed" ||
    root.reportScope !== "github_hosted_independent_fresh_vm_15_scenario_aggregate" ||
    root.selfAttested !== true || root.authoritativeDrill !== false ||
    root.releaseEvidenceEligible !== false || root.activationBlocked !== true ||
    root.externalSigningEligible !== false || root.authorizationStatus !== HOSTED_SMOKE_AUTHORIZATION_STATUS
  ) {
    throw new Error("hosted smoke aggregate cannot authorize release, activation, signing, or publication");
  }
  exactPattern(root.suiteId, SUITE_ID, "hosted smoke aggregate suite id");
  exactPattern(root.sourceRevision, COMMIT, "hosted smoke aggregate source revision");
  const githubRun = validateGithubRun(root.githubRun);
  if (root.scenarioCount !== HOSTED_SMOKE_SCENARIO_MATRIX.length ||
      canonicalJson(root.omittedScenarios) !== canonicalJson(HOSTED_SMOKE_OMITTED_SCENARIOS)) {
    throw new Error("hosted smoke aggregate scenario boundary is incomplete or substituted");
  }
  if (!Array.isArray(root.scenarioReports) || root.scenarioReports.length !== HOSTED_SMOKE_SCENARIO_MATRIX.length ||
      !Array.isArray(root.scenarioReportDigests) || root.scenarioReportDigests.length !== HOSTED_SMOKE_SCENARIO_MATRIX.length) {
    throw new Error("hosted smoke aggregate does not contain the exact 15 reports and digests");
  }
  const reports = root.scenarioReports.map((value, index) => {
    const report = validateHostedSmokeScenarioReport(value);
    const expectedName = HOSTED_SMOKE_SCENARIO_MATRIX[index].name;
    if (report.scenarioName !== expectedName) throw new Error("hosted smoke aggregate scenarios are missing or reordered");
    if (report.suiteId !== root.suiteId || report.sourceRevision !== root.sourceRevision ||
        canonicalJson(report.githubRun) !== canonicalJson(githubRun)) {
      throw new Error("hosted smoke aggregate spans multiple suites, commits, runs, or attempts");
    }
    return report;
  });
  const reportDigests = root.scenarioReportDigests.map((value, index) => {
    const entry = record(value, `hosted smoke scenario digest ${index}`);
    exactKeys(entry, ["name", "reportDigest", "hostDigest", "toolBindingsDigest"], `hosted smoke scenario digest ${index}`);
    const expectedName = HOSTED_SMOKE_SCENARIO_MATRIX[index].name;
    const expectedReport = reports[index];
    const expectedDigest = sha256(Buffer.from(canonicalJson(expectedReport), "utf8"));
    if (entry.name !== expectedName || entry.reportDigest !== expectedDigest ||
        entry.hostDigest !== expectedReport.hostDigest ||
        entry.toolBindingsDigest !== expectedReport.toolBindingsDigest) {
      throw new Error("hosted smoke aggregate contains a substituted scenario digest");
    }
    return {
      name: entry.name,
      reportDigest: digest(entry.reportDigest, `${entry.name} scenario report digest`),
      hostDigest: digest(entry.hostDigest, `${entry.name} host digest`),
      toolBindingsDigest: digest(entry.toolBindingsDigest, `${entry.name} tool-binding digest`),
    };
  });
  if (new Set(reportDigests.map(({ reportDigest }) => reportDigest)).size !== reportDigests.length) {
    throw new Error("hosted smoke aggregate requires distinct per-scenario canonical digests");
  }
  if (new Set(reports.map((report) => report.host.bootIdDigest)).size !== reports.length) {
    throw new Error("hosted smoke aggregate requires 15 independent fresh VM boot identities");
  }
  const startedAt = timestamp(root.startedAt, "hosted smoke aggregate start");
  const finishedAt = timestamp(root.finishedAt, "hosted smoke aggregate finish");
  if (startedAt !== Math.min(...reports.map((report) => report.startedAt)) ||
      finishedAt !== Math.max(...reports.map((report) => report.finishedAt)) || finishedAt <= startedAt) {
    throw new Error("hosted smoke aggregate timestamps do not span all scenario reports");
  }
  return deepFreeze({
    ...structuredClone(root),
    githubRun,
    scenarioReports: reports,
    scenarioReportDigests: reportDigests,
    startedAt,
    finishedAt,
  });
}

export function parseCanonicalHostedSmokeAggregateReport(text) {
  const value = parseCanonicalObject(text, "hosted smoke aggregate report", MAX_AGGREGATE_BYTES);
  const report = validateHostedSmokeAggregateReport(value);
  const canonical = canonicalJson(report);
  if (canonical !== text) throw new Error("hosted smoke aggregate report is not exact canonical JSON");
  return deepFreeze({ report, canonicalJson: canonical, digest: sha256(Buffer.from(canonical, "utf8")) });
}

function validateGithubRun(value) {
  const root = record(value, "hosted smoke GitHub run");
  exactKeys(root, ["repository", "workflowRef", "runId", "runAttempt"], "hosted smoke GitHub run");
  exactPattern(root.repository, REPOSITORY, "GitHub repository");
  boundedToken(root.workflowRef, "GitHub workflow ref", /^[A-Za-z0-9._/@+-]{1,500}$/);
  boundedToken(root.runId, "GitHub run id", /^[1-9][0-9]{0,19}$/);
  positiveInteger(root.runAttempt, "GitHub run attempt");
  return deepFreeze(structuredClone(root));
}

function validateHostedHost(value) {
  const root = record(value, "hosted smoke host");
  exactKeys(root, [
    "provider", "runnerLabel", "osId", "osVersion", "architecture", "dedicatedHost",
    "selfAttested", "imageVersion", "kernelRelease", "systemdVersion", "cgroupVersion", "bootIdDigest",
  ], "hosted smoke host");
  if (root.provider !== "github_hosted" || root.runnerLabel !== "ubuntu-24.04" ||
      root.osId !== "ubuntu" || root.osVersion !== "24.04" || root.architecture !== "x86_64" ||
      root.dedicatedHost !== false || root.selfAttested !== true || root.cgroupVersion !== 2) {
    throw new Error("hosted smoke host must be a self-attested non-dedicated GitHub ubuntu-24.04 runner");
  }
  boundedToken(root.imageVersion, "GitHub runner image version", /^[A-Za-z0-9._+-]{1,100}$/);
  boundedToken(root.kernelRelease, "hosted smoke kernel release", /^[A-Za-z0-9._+-]{3,100}$/);
  boundedToken(root.systemdVersion, "hosted smoke systemd version", /^[A-Za-z0-9._+-]{1,100}$/);
  digest(root.bootIdDigest, "hosted smoke boot identity digest");
  return deepFreeze(structuredClone(root));
}

function validateToolBindings(value) {
  const root = record(value, "hosted smoke tool bindings");
  exactKeys(root, TOOL_NAMES, "hosted smoke tool bindings");
  const output = {};
  for (const name of TOOL_NAMES) {
    const binding = record(root[name], `hosted smoke ${name} binding`);
    exactKeys(binding, ["path", "digest", "version"], `hosted smoke ${name} binding`);
    if (typeof binding.path !== "string" || !isAbsolute(binding.path) || resolve(binding.path) !== binding.path ||
        !/^\/[A-Za-z0-9._/+:-]+$/.test(binding.path)) {
      throw new Error(`hosted smoke ${name} path is not canonical and absolute`);
    }
    digest(binding.digest, `hosted smoke ${name} digest`);
    boundedText(binding.version, `hosted smoke ${name} version`, 512);
    output[name] = structuredClone(binding);
  }
  return deepFreeze(output);
}

function validateGatewayEvidence(value) {
  const root = record(value, "hosted smoke gateway binding");
  exactKeys(root, [
    "profile", "gatewayContractDigest", "envoyConfigDigest", "nftablesPolicyDigest",
    "gatewayRuntimeDigest", "nftablesTable", "runnerUid", "gatewayUid", "listenerAddresses",
    "listenerPort", "originHost", "originPort",
  ], "hosted smoke gateway binding");
  if (root.profile !== "static-envoy-sni-passthrough-v1" || root.originHost !== "registry.npmjs.org" ||
      root.originPort !== 443 || canonicalJson(root.listenerAddresses) !== canonicalJson(["127.0.0.1", "::1"])) {
    throw new Error("hosted smoke gateway binding is not the fixed npm static-SNI profile");
  }
  for (const name of ["gatewayContractDigest", "envoyConfigDigest", "nftablesPolicyDigest", "gatewayRuntimeDigest"]) {
    digest(root[name], `hosted smoke ${name}`);
  }
  exactPattern(root.nftablesTable, NFT_TABLE, "hosted smoke nftables table");
  positiveInteger(root.runnerUid, "hosted smoke runner uid");
  positiveInteger(root.gatewayUid, "hosted smoke gateway uid");
  if (root.runnerUid === root.gatewayUid) throw new Error("hosted smoke gateway and runner identities must be distinct");
  if (!Number.isSafeInteger(root.listenerPort) || root.listenerPort < 1_024 || root.listenerPort > 65_535) {
    throw new Error("hosted smoke listener port is invalid");
  }
  return deepFreeze(structuredClone(root));
}

function validateChecks(value, gateway) {
  const root = record(value, "hosted smoke checks");
  exactKeys(root, [
    "preMutation", "nativeValidation", "policyInstallation", "gatewayRuntime",
    "listenerReadiness", "offlineFailClosed", "scenarioStartEvidenceDigest", "finalSnapshotEvidenceDigest",
  ], "hosted smoke checks");
  const preMutation = record(root.preMutation, "hosted smoke pre-mutation check");
  exactKeys(preMutation, ["nftablesTableAbsent", "runnerUidIdle", "gatewayUidIdle", "evidenceDigest"], "hosted smoke pre-mutation check");
  if (preMutation.nftablesTableAbsent !== true || preMutation.runnerUidIdle !== true || preMutation.gatewayUidIdle !== true) {
    throw new Error("hosted smoke did not start from an absent and idle boundary");
  }
  digest(preMutation.evidenceDigest, "hosted smoke pre-mutation evidence");

  const nativeValidation = record(root.nativeValidation, "hosted smoke native validation");
  exactKeys(nativeValidation, ["envoyStatus", "nftablesStatus", "envoyEvidenceDigest", "nftablesEvidenceDigest"], "hosted smoke native validation");
  if (nativeValidation.envoyStatus !== "passed" || nativeValidation.nftablesStatus !== "passed") {
    throw new Error("hosted smoke native config validation did not pass");
  }
  digest(nativeValidation.envoyEvidenceDigest, "hosted smoke Envoy validation evidence");
  digest(nativeValidation.nftablesEvidenceDigest, "hosted smoke nftables validation evidence");

  const policyInstallation = record(root.policyInstallation, "hosted smoke policy installation");
  exactKeys(policyInstallation, ["installed", "policyDigest", "evidenceDigest"], "hosted smoke policy installation");
  if (policyInstallation.installed !== true || policyInstallation.policyDigest !== gateway.nftablesPolicyDigest) {
    throw new Error("hosted smoke did not install the exact rendered nftables policy");
  }
  digest(policyInstallation.evidenceDigest, "hosted smoke policy-installation evidence");

  const gatewayRuntime = record(root.gatewayRuntime, "hosted smoke gateway runtime");
  exactKeys(gatewayRuntime, ["started", "stopped", "startEvidenceDigest", "stopEvidenceDigest"], "hosted smoke gateway runtime");
  if (gatewayRuntime.started !== true || gatewayRuntime.stopped !== true) {
    throw new Error("hosted smoke gateway lifecycle is incomplete");
  }
  digest(gatewayRuntime.startEvidenceDigest, "hosted smoke gateway-start evidence");
  digest(gatewayRuntime.stopEvidenceDigest, "hosted smoke gateway-stop evidence");

  const listenerReadiness = record(root.listenerReadiness, "hosted smoke listener readiness");
  exactKeys(listenerReadiness, [
    "ipv4", "ipv6", "ipv4PositiveProbePassed", "ipv6PositiveProbePassed",
    "ownedByGatewayUid", "evidenceDigest",
  ], "hosted smoke listener readiness");
  if (listenerReadiness.ipv4 !== true || listenerReadiness.ipv6 !== true ||
      listenerReadiness.ipv4PositiveProbePassed !== true || listenerReadiness.ipv6PositiveProbePassed !== true ||
      listenerReadiness.ownedByGatewayUid !== true) {
    throw new Error("hosted smoke did not prove positive traffic over both exact gateway listeners under the gateway UID");
  }
  digest(listenerReadiness.evidenceDigest, "hosted smoke listener evidence");

  const offlineFailClosed = record(root.offlineFailClosed, "hosted smoke offline check");
  exactKeys(offlineFailClosed, [
    "gatewayStopped", "nftablesPolicyInstalled", "connectionBlocked", "redirectCounterDelta",
    "runnerLoopbackCounterDelta", "gatewayUpstreamCounterDelta", "evidenceDigest",
  ], "hosted smoke offline check");
  if (offlineFailClosed.gatewayStopped !== true || offlineFailClosed.nftablesPolicyInstalled !== true ||
      offlineFailClosed.connectionBlocked !== true || offlineFailClosed.gatewayUpstreamCounterDelta !== 0) {
    throw new Error("hosted smoke offline phase was not fail-closed with containment still installed");
  }
  positiveDelta(offlineFailClosed.redirectCounterDelta, "offline redirect counter delta");
  positiveDelta(offlineFailClosed.runnerLoopbackCounterDelta, "offline runner-loopback counter delta");
  digest(offlineFailClosed.evidenceDigest, "hosted smoke offline evidence");
  digest(root.scenarioStartEvidenceDigest, "hosted smoke scenario-start evidence");
  digest(root.finalSnapshotEvidenceDigest, "hosted smoke final-snapshot evidence");
  return deepFreeze(structuredClone(root));
}

function validateScenarioEvidence(value, expectedName) {
  const root = record(value, "hosted smoke scenario evidence");
  exactKeys(root, ["kind", "scenarioName", "observedAt", "actionEvidenceDigest", "proof"], "hosted smoke scenario evidence");
  if (root.kind !== "api_migrator_github_hosted_l7_smoke_scenario_evidence" || root.scenarioName !== expectedName) {
    throw new Error("hosted smoke scenario evidence substitutes its kind or scenario");
  }
  timestamp(root.observedAt, "hosted smoke scenario observation");
  digest(root.actionEvidenceDigest, "hosted smoke scenario action evidence");
  const proof = validateScenarioProof(expectedName, root.proof);
  return deepFreeze({ ...structuredClone(root), proof });
}

function validateScenarioProof(name, value) {
  const root = record(value, `${name} hosted smoke proof`);
  if (name === "success") {
    exactKeys(root, [
      "type", "correctSni", "tcpConnectedToOwnedListener", "tlsAuthorized", "httpPingPassed",
      "runnerLoopbackCounterDelta", "gatewayUpstreamCounterDelta", "envoyAccessLogMatches",
      "listenerSnapshotDigest", "counterSnapshotBeforeDigest", "counterSnapshotAfterDigest", "accessLogDigest",
    ], "success hosted smoke proof");
    if (root.type !== "positive_route" || root.correctSni !== true || root.tcpConnectedToOwnedListener !== true ||
        root.tlsAuthorized !== true || root.httpPingPassed !== true) throw new Error("hosted smoke positive route did not pass");
    positiveDelta(root.runnerLoopbackCounterDelta, "success runner-loopback counter delta");
    positiveDelta(root.gatewayUpstreamCounterDelta, "success gateway-upstream counter delta");
    positiveDelta(root.envoyAccessLogMatches, "success Envoy access-log matches");
    validateProofDigests(root, ["listenerSnapshotDigest", "counterSnapshotBeforeDigest", "counterSnapshotAfterDigest", "accessLogDigest"]);
  } else if (name === "timeout" || name === "sigkill") {
    exactKeys(root, ["type", "fault", "workloadStarted", "faultObserved", "containmentInstalledAtFault", "processEvidenceDigest"], `${name} hosted smoke proof`);
    if (root.type !== "fault_teardown" || root.fault !== name || root.workloadStarted !== true ||
        root.faultObserved !== true || root.containmentInstalledAtFault !== true) throw new Error(`${name} hosted smoke fault was not observed under containment`);
    digest(root.processEvidenceDigest, `${name} process evidence`);
  } else if (name === "wrong_sni" || name === "absent_sni") {
    exactKeys(root, [
      "type", "sni", "tcpConnectedToOwnedListener", "listenerOwnedByGatewayUid", "deniedAfterTcpConnect",
      "tlsHandshakeSucceeded", "runnerLoopbackCounterDelta", "gatewayUpstreamCounterDelta",
      "envoyUpstreamAccessLogMatches", "listenerSnapshotDigest", "counterSnapshotBeforeDigest",
      "counterSnapshotAfterDigest", "accessLogDigest",
    ], `${name} hosted smoke proof`);
    const expectedSni = name === "wrong_sni" ? "wrong" : "absent";
    if (root.type !== "sni_rejection" || root.sni !== expectedSni ||
        root.tcpConnectedToOwnedListener !== true || root.listenerOwnedByGatewayUid !== true ||
        root.deniedAfterTcpConnect !== true || root.tlsHandshakeSucceeded !== false ||
        root.gatewayUpstreamCounterDelta !== 0 || root.envoyUpstreamAccessLogMatches !== 0) {
      throw new Error(`${name} must prove the live owned listener was reached and no upstream was opened`);
    }
    positiveDelta(root.runnerLoopbackCounterDelta, `${name} runner-loopback counter delta`);
    validateProofDigests(root, ["listenerSnapshotDigest", "counterSnapshotBeforeDigest", "counterSnapshotAfterDigest", "accessLogDigest"]);
  } else if (name === "plaintext") {
    exactKeys(root, [
      "type", "tcpConnectedToOwnedListener", "listenerOwnedByGatewayUid", "closedByListener",
      "responseBytes", "gatewayUpstreamCounterDelta", "listenerSnapshotDigest", "counterSnapshotBeforeDigest",
      "counterSnapshotAfterDigest",
    ], "plaintext hosted smoke proof");
    if (root.type !== "plaintext_rejection" || root.tcpConnectedToOwnedListener !== true ||
        root.listenerOwnedByGatewayUid !== true || root.closedByListener !== true || root.responseBytes !== 0 ||
        root.gatewayUpstreamCounterDelta !== 0) throw new Error("plaintext smoke did not prove exact listener rejection");
    validateProofDigests(root, ["listenerSnapshotDigest", "counterSnapshotBeforeDigest", "counterSnapshotAfterDigest"]);
  } else if (name === "direct_bypass") {
    exactKeys(root, [
      "type", "directDestinationAttempted", "tcpConnected", "tlsAuthorized", "httpPingPassed",
      "requestedServerName", "upstreamAddressBoundToContract", "redirectCounterDelta",
      "runnerLoopbackCounterDelta", "gatewayUpstreamCounterDelta", "envoyAccessLogMatches",
      "counterSnapshotBeforeDigest", "counterSnapshotAfterDigest", "accessLogDigest",
    ], "direct-bypass hosted smoke proof");
    if (root.type !== "forced_gateway_route" || root.directDestinationAttempted !== true ||
        root.tcpConnected !== true || root.tlsAuthorized !== true || root.httpPingPassed !== true ||
        root.requestedServerName !== "registry.npmjs.org" || root.upstreamAddressBoundToContract !== true) {
      throw new Error("direct-bypass smoke did not complete the fixed TLS route");
    }
    positiveDelta(root.redirectCounterDelta, "direct-bypass redirect counter delta");
    positiveDelta(root.runnerLoopbackCounterDelta, "direct-bypass runner-loopback counter delta");
    positiveDelta(root.gatewayUpstreamCounterDelta, "direct-bypass gateway-upstream counter delta");
    positiveDelta(root.envoyAccessLogMatches, "direct-bypass Envoy access-log matches");
    validateProofDigests(root, ["counterSnapshotBeforeDigest", "counterSnapshotAfterDigest", "accessLogDigest"]);
  } else if (name === "non_443" || name === "non_npm") {
    exactKeys(root, [
      "type", "target", "connectionBlocked", "runnerRejectCounterDelta", "gatewayRejectCounterDelta",
      "counterSnapshotBeforeDigest", "counterSnapshotAfterDigest",
    ], `${name} hosted smoke proof`);
    if (root.type !== "egress_rejection" || root.target !== name || root.connectionBlocked !== true) {
      throw new Error(`${name} smoke did not prove fixed egress rejection`);
    }
    if (name === "non_443") {
      positiveDelta(root.runnerRejectCounterDelta, "non-443 runner rejection delta");
      if (root.gatewayRejectCounterDelta !== 0) throw new Error("non-443 smoke used the wrong rejecting identity");
    } else {
      positiveDelta(root.gatewayRejectCounterDelta, "non-npm gateway rejection delta");
      if (root.runnerRejectCounterDelta !== 0) throw new Error("non-npm smoke used the wrong rejecting identity");
    }
    validateProofDigests(root, ["counterSnapshotBeforeDigest", "counterSnapshotAfterDigest"]);
  } else if (name === "offline_network") {
    exactKeys(root, [
      "type", "gatewayStopped", "nftablesPolicyInstalled", "connectionBlocked", "redirectCounterDelta",
      "runnerLoopbackCounterDelta", "gatewayUpstreamCounterDelta", "listenerAbsent", "evidenceDigest",
    ], "offline-network hosted smoke proof");
    if (root.type !== "offline_fail_closed" || root.gatewayStopped !== true || root.nftablesPolicyInstalled !== true ||
        root.connectionBlocked !== true || root.listenerAbsent !== true || root.gatewayUpstreamCounterDelta !== 0) {
      throw new Error("offline-network smoke was not checked after gateway stop under containment");
    }
    positiveDelta(root.redirectCounterDelta, "offline-network redirect counter delta");
    positiveDelta(root.runnerLoopbackCounterDelta, "offline-network runner-loopback counter delta");
    digest(root.evidenceDigest, "offline-network proof evidence");
  } else if (name === "gateway_stop") {
    exactKeys(root, ["type", "processAbsent", "ipv4ListenerAbsent", "ipv6ListenerAbsent", "processSnapshotDigest", "listenerSnapshotDigest"], "gateway-stop hosted smoke proof");
    if (root.type !== "gateway_stop" || root.processAbsent !== true || root.ipv4ListenerAbsent !== true || root.ipv6ListenerAbsent !== true) throw new Error("gateway-stop smoke is incomplete");
    validateProofDigests(root, ["processSnapshotDigest", "listenerSnapshotDigest"]);
  } else if (name === "uid_idle") {
    exactKeys(root, ["type", "runnerUidIdle", "gatewayUidIdle", "processSnapshotDigest"], "uid-idle hosted smoke proof");
    if (root.type !== "uid_idle" || root.runnerUidIdle !== true || root.gatewayUidIdle !== true) throw new Error("UID-idle smoke is incomplete");
    digest(root.processSnapshotDigest, "uid-idle process evidence");
  } else if (name === "policy_removal") {
    exactKeys(root, ["type", "tablePresentBeforeCleanup", "tableAbsentAfterCleanup", "beforeSnapshotDigest", "afterSnapshotDigest"], "policy-removal hosted smoke proof");
    if (root.type !== "policy_removal" || root.tablePresentBeforeCleanup !== true || root.tableAbsentAfterCleanup !== true) throw new Error("policy-removal smoke is incomplete");
    validateProofDigests(root, ["beforeSnapshotDigest", "afterSnapshotDigest"]);
  } else if (name === "cgroup_namespace_cleanup") {
    exactKeys(root, ["type", "cgroupEmpty", "processNetworkNamespaceReferenceAbsent", "cgroupEvidenceDigest", "namespaceEvidenceDigest"], "cgroup/namespace cleanup hosted smoke proof");
    if (root.type !== "cgroup_namespace_cleanup" || root.cgroupEmpty !== true ||
        root.processNetworkNamespaceReferenceAbsent !== true) {
      throw new Error("cgroup/process-namespace-reference cleanup smoke is incomplete");
    }
    validateProofDigests(root, ["cgroupEvidenceDigest", "namespaceEvidenceDigest"]);
  } else if (name === "workspace_cleanup") {
    exactKeys(root, ["type", "workspaceAbsent", "parentSnapshotDigest"], "workspace-cleanup hosted smoke proof");
    if (root.type !== "workspace_cleanup" || root.workspaceAbsent !== true) throw new Error("workspace-cleanup smoke is incomplete");
    digest(root.parentSnapshotDigest, "workspace-cleanup parent evidence");
  } else {
    throw new Error("hosted smoke scenario proof is unsupported");
  }
  return deepFreeze(structuredClone(root));
}

function validateTeardown(value) {
  const root = record(value, "hosted smoke teardown");
  exactKeys(root, [
    "gatewayStoppedAt", "runnerUidIdleAt", "gatewayUidIdleAt", "cgroupNamespaceCleanupAt",
    "workspaceCleanupAt", "nftablesPolicyRemovedAt", "runnerUidIdle", "gatewayUidIdle",
    "cgroupEmpty", "processNetworkNamespaceReferenceAbsent", "workspaceAbsent", "nftablesPolicyAbsent", "complete",
    "runnerUidIdleEvidenceDigest", "gatewayUidIdleEvidenceDigest", "cgroupNamespaceEvidenceDigest",
    "workspaceEvidenceDigest", "nftablesRemovalEvidenceDigest",
  ], "hosted smoke teardown");
  for (const name of [
    "gatewayStoppedAt", "runnerUidIdleAt", "gatewayUidIdleAt", "cgroupNamespaceCleanupAt",
    "workspaceCleanupAt", "nftablesPolicyRemovedAt",
  ]) timestamp(root[name], `hosted smoke teardown ${name}`);
  for (const name of [
    "runnerUidIdleEvidenceDigest", "gatewayUidIdleEvidenceDigest", "cgroupNamespaceEvidenceDigest",
    "workspaceEvidenceDigest", "nftablesRemovalEvidenceDigest",
  ]) digest(root[name], `hosted smoke teardown ${name}`);
  if (root.runnerUidIdle !== true || root.gatewayUidIdle !== true || root.cgroupEmpty !== true ||
      root.processNetworkNamespaceReferenceAbsent !== true || root.workspaceAbsent !== true || root.nftablesPolicyAbsent !== true ||
      root.complete !== true) throw new Error("hosted smoke teardown is incomplete");
  return deepFreeze(structuredClone(root));
}

function validateEventStream(value, expectedDigests) {
  if (!Array.isArray(value) || value.length !== HOSTED_SMOKE_EVENT_ORDER.length) {
    throw new Error("hosted smoke event stream is incomplete");
  }
  let previousEventDigest = HOSTED_SMOKE_EVENT_CHAIN_ROOT;
  let previousTimestamp = 0;
  const events = value.map((value, index) => {
    const root = record(value, `hosted smoke event ${index}`);
    exactKeys(root, [
      "schemaVersion", "kind", "sequence", "event", "observedAt", "evidenceDigest",
      "previousEventDigest", "releaseEvidenceEligible", "activationBlocked",
      "externalSigningEligible", "authorizationStatus",
    ], `hosted smoke event ${index}`);
    const expectedEvent = HOSTED_SMOKE_EVENT_ORDER[index];
    if (root.schemaVersion !== 1 || root.kind !== HOSTED_SMOKE_EVENT_KIND || root.sequence !== index + 1 ||
        root.event !== expectedEvent || root.evidenceDigest !== expectedDigests[expectedEvent] ||
        root.previousEventDigest !== previousEventDigest || root.releaseEvidenceEligible !== false ||
        root.activationBlocked !== true || root.externalSigningEligible !== false ||
        root.authorizationStatus !== HOSTED_SMOKE_AUTHORIZATION_STATUS) {
      throw new Error("hosted smoke event is reordered, substituted, or authorizing");
    }
    const observedAt = timestamp(root.observedAt, `${expectedEvent} observation`);
    if (observedAt <= previousTimestamp) throw new Error("hosted smoke event timestamps must be strictly increasing");
    digest(root.evidenceDigest, `${expectedEvent} evidence digest`);
    const event = deepFreeze({ ...structuredClone(root), observedAt });
    previousEventDigest = sha256(Buffer.from(canonicalJson(event), "utf8"));
    previousTimestamp = observedAt;
    return event;
  });
  return { events, byName: Object.fromEntries(events.map((event) => [event.event, event])) };
}

function validateTeardownTimeline(teardown, events) {
  const mapping = {
    gatewayStoppedAt: "gateway_stopped",
    runnerUidIdleAt: "runner_uid_idle",
    gatewayUidIdleAt: "gateway_uid_idle",
    cgroupNamespaceCleanupAt: "cgroup_namespace_cleanup",
    workspaceCleanupAt: "workspace_cleanup",
    nftablesPolicyRemovedAt: "nftables_policy_removed",
  };
  for (const [field, event] of Object.entries(mapping)) {
    if (teardown[field] !== events[event].observedAt) {
      throw new Error(`hosted smoke teardown ${field} does not match its event`);
    }
  }
  if (!(teardown.gatewayStoppedAt < teardown.runnerUidIdleAt &&
        teardown.runnerUidIdleAt < teardown.gatewayUidIdleAt &&
        teardown.gatewayUidIdleAt < teardown.cgroupNamespaceCleanupAt &&
        teardown.cgroupNamespaceCleanupAt < teardown.workspaceCleanupAt &&
        teardown.workspaceCleanupAt < teardown.nftablesPolicyRemovedAt)) {
    throw new Error("hosted smoke must finish cgroup and workspace cleanup before removing containment");
  }
}

function validateScenarioObservationTime(name, observedAt, events) {
  if (observedAt < events.scenario_started.observedAt || observedAt > events.scenario_finished.observedAt) {
    throw new Error("hosted smoke scenario evidence is outside its scenario interval");
  }
  if (ONLINE_SCENARIOS.has(name)) {
    if (observedAt < events.gateway_ready.observedAt || observedAt >= events.gateway_stopped.observedAt) {
      throw new Error(`${name} hosted smoke evidence is outside the live-gateway interval`);
    }
    return;
  }
  const expectedEvent = {
    offline_network: "offline_network_checked",
    gateway_stop: "gateway_stopped",
    uid_idle: "gateway_uid_idle",
    policy_removal: "nftables_policy_removed",
    cgroup_namespace_cleanup: "cgroup_namespace_cleanup",
    workspace_cleanup: "workspace_cleanup",
  }[name];
  if (!expectedEvent || observedAt !== events[expectedEvent].observedAt) {
    throw new Error(`${name} hosted smoke evidence does not bind its exact lifecycle event`);
  }
}

function scenarioDefinition(name) {
  const scenario = HOSTED_SMOKE_SCENARIO_MATRIX.find((entry) => entry.name === name);
  if (!scenario) throw new Error("hosted smoke scenario is unsupported");
  return scenario;
}

function validateProofDigests(value, names) {
  for (const name of names) digest(value[name], `${name} proof digest`);
}

function positiveDelta(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} is not a positive bounded counter delta`);
  }
  return value;
}

function parseCanonicalObject(text, label, maxBytes) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") < 1 || Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`${label} bytes are missing or excessive`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  if (canonicalJson(value) !== text) throw new Error(`${label} is not exact canonical JSON`);
  return value;
}

function assertNoForbiddenAuthorityFields(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [name, entry] of Object.entries(current)) {
      if (name !== "externalSigningEligible" && /signature|signing|attestation|capabilit/i.test(name)) {
        throw new Error(`hosted smoke evidence contains forbidden authority field: ${name}`);
      }
      stack.push(entry);
    }
  }
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, names, label) {
  const actual = Object.keys(value).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
}

function exactPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedToken(value, label, pattern) {
  return exactPattern(value, pattern, label);
}

function boundedText(value, label, maxBytes) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maxBytes ||
      /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid or excessive`);
  return value;
}

function digest(value, label) {
  return exactPattern(value, DIGEST, label);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMESTAMP) throw new Error(`${label} is invalid`);
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
