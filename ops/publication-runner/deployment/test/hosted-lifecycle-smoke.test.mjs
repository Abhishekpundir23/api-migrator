import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson, sha256 } from "../lib.mjs";
import {
  HOSTED_SMOKE_AUTHORIZATION_STATUS,
  HOSTED_SMOKE_EVENT_ORDER,
  HOSTED_SMOKE_OMITTED_SCENARIOS,
  HOSTED_SMOKE_SCENARIO_MATRIX,
  buildHostedSmokeAggregateReport,
  buildHostedSmokeEventStream,
  buildHostedSmokeScenarioReport,
  parseCanonicalHostedSmokeAggregateReport,
  parseCanonicalHostedSmokeScenarioReport,
  validateHostedSmokeAggregateReport,
  validateHostedSmokeScenarioReport,
} from "../hosted-lifecycle-smoke.mjs";

const NOW = 2_000_000_000_000;
const SUITE_ID = `hostedsmoke_${"d".repeat(64)}`;
const SOURCE_REVISION = "a".repeat(40);

function digest(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function githubRun() {
  return {
    repository: "example/api-migrator",
    workflowRef: "example/api-migrator/.github/workflows/ci.yml@refs/pull/12/merge",
    runId: "1234567890",
    runAttempt: 1,
  };
}

function host(index = 0) {
  return {
    provider: "github_hosted",
    runnerLabel: "ubuntu-24.04",
    osId: "ubuntu",
    osVersion: "24.04",
    architecture: "x86_64",
    dedicatedHost: false,
    selfAttested: true,
    imageVersion: "20260810.271.1",
    kernelRelease: "6.17.0-1022-azure",
    systemdVersion: "255.4",
    cgroupVersion: 2,
    bootIdDigest: digest(`boot-id-${index}`),
  };
}

function toolBindings() {
  return Object.fromEntries([
    ["node", "/usr/bin/node"],
    ["envoy", "/usr/bin/envoy"],
    ["nft", "/usr/sbin/nft"],
    ["ss", "/usr/bin/ss"],
    ["systemctl", "/usr/bin/systemctl"],
    ["systemdRun", "/usr/bin/systemd-run"],
    ["journalctl", "/usr/bin/journalctl"],
    ["setpriv", "/usr/bin/setpriv"],
    ["ip", "/usr/sbin/ip"],
  ].map(([name, path]) => [name, { path, digest: digest(`tool-${name}`), version: `${name} 1.0` }]));
}

function gateway(index) {
  return {
    profile: "static-envoy-sni-passthrough-v1",
    gatewayContractDigest: digest(`gateway-contract-${index}`),
    envoyConfigDigest: digest(`envoy-config-${index}`),
    nftablesPolicyDigest: digest(`nft-policy-${index}`),
    gatewayRuntimeDigest: digest("envoy-runtime"),
    nftablesTable: `api_migrator_gw_${index.toString(16).padStart(16, "0")}`,
    runnerUid: 22001,
    gatewayUid: 22002,
    listenerAddresses: ["127.0.0.1", "::1"],
    listenerPort: 15443,
    originHost: "registry.npmjs.org",
    originPort: 443,
  };
}

function proof(name) {
  const snapshots = {
    listenerSnapshotDigest: digest(`${name}-listener`),
    counterSnapshotBeforeDigest: digest(`${name}-before`),
    counterSnapshotAfterDigest: digest(`${name}-after`),
  };
  switch (name) {
    case "success":
      return {
        type: "positive_route",
        correctSni: true,
        tcpConnectedToOwnedListener: true,
        tlsAuthorized: true,
        httpPingPassed: true,
        runnerLoopbackCounterDelta: 1,
        gatewayUpstreamCounterDelta: 1,
        envoyAccessLogMatches: 1,
        ...snapshots,
        accessLogDigest: digest(`${name}-access-log`),
      };
    case "timeout":
    case "sigkill":
      return {
        type: "fault_teardown",
        fault: name,
        workloadStarted: true,
        faultObserved: true,
        containmentInstalledAtFault: true,
        processEvidenceDigest: digest(`${name}-process`),
      };
    case "wrong_sni":
    case "absent_sni":
      return {
        type: "sni_rejection",
        sni: name === "wrong_sni" ? "wrong" : "absent",
        tcpConnectedToOwnedListener: true,
        listenerOwnedByGatewayUid: true,
        deniedAfterTcpConnect: true,
        tlsHandshakeSucceeded: false,
        runnerLoopbackCounterDelta: 1,
        gatewayUpstreamCounterDelta: 0,
        envoyUpstreamAccessLogMatches: 0,
        ...snapshots,
        accessLogDigest: digest(`${name}-access-log`),
      };
    case "plaintext":
      return {
        type: "plaintext_rejection",
        tcpConnectedToOwnedListener: true,
        listenerOwnedByGatewayUid: true,
        closedByListener: true,
        responseBytes: 0,
        gatewayUpstreamCounterDelta: 0,
        ...snapshots,
      };
    case "direct_bypass":
      return {
        type: "forced_gateway_route",
        directDestinationAttempted: true,
        tcpConnected: true,
        tlsAuthorized: true,
        httpPingPassed: true,
        requestedServerName: "registry.npmjs.org",
        upstreamAddressBoundToContract: true,
        redirectCounterDelta: 1,
        runnerLoopbackCounterDelta: 1,
        gatewayUpstreamCounterDelta: 1,
        gatewayDownstreamResponseCounterDelta: 1,
        gatewayRejectCounterDelta: 0,
        envoyAccessLogMatches: 1,
        counterSnapshotBeforeDigest: snapshots.counterSnapshotBeforeDigest,
        counterSnapshotAfterDigest: snapshots.counterSnapshotAfterDigest,
        accessLogDigest: digest(`${name}-access-log`),
      };
    case "non_443":
    case "non_npm":
      return {
        type: "egress_rejection",
        target: name,
        connectionBlocked: true,
        runnerRejectCounterDelta: name === "non_443" ? 1 : 0,
        gatewayRejectCounterDelta: name === "non_npm" ? 1 : 0,
        counterSnapshotBeforeDigest: snapshots.counterSnapshotBeforeDigest,
        counterSnapshotAfterDigest: snapshots.counterSnapshotAfterDigest,
      };
    case "offline_network":
      return {
        type: "offline_fail_closed",
        gatewayStopped: true,
        nftablesPolicyInstalled: true,
        connectionBlocked: true,
        redirectCounterDelta: 1,
        runnerLoopbackCounterDelta: 1,
        gatewayUpstreamCounterDelta: 0,
        gatewayDownstreamResponseCounterDelta: 0,
        listenerAbsent: true,
        evidenceDigest: digest(`${name}-offline`),
      };
    case "gateway_stop":
      return {
        type: "gateway_stop",
        processAbsent: true,
        ipv4ListenerAbsent: true,
        ipv6ListenerAbsent: true,
        processSnapshotDigest: digest(`${name}-process`),
        listenerSnapshotDigest: snapshots.listenerSnapshotDigest,
      };
    case "uid_idle":
      return {
        type: "uid_idle",
        runnerUidIdle: true,
        gatewayUidIdle: true,
        processSnapshotDigest: digest(`${name}-process`),
      };
    case "policy_removal":
      return {
        type: "policy_removal",
        tablePresentBeforeCleanup: true,
        tableAbsentAfterCleanup: true,
        beforeSnapshotDigest: snapshots.counterSnapshotBeforeDigest,
        afterSnapshotDigest: snapshots.counterSnapshotAfterDigest,
      };
    case "cgroup_namespace_cleanup":
      return {
        type: "cgroup_namespace_cleanup",
        cgroupEmpty: true,
        processNetworkNamespaceReferenceAbsent: true,
        cgroupEvidenceDigest: digest(`${name}-cgroup`),
        namespaceEvidenceDigest: digest(`${name}-namespace`),
      };
    case "workspace_cleanup":
      return {
        type: "workspace_cleanup",
        workspaceAbsent: true,
        parentSnapshotDigest: digest(`${name}-parent`),
      };
    default:
      throw new Error(`unsupported fixture scenario: ${name}`);
  }
}

function scenarioInput(name, index = HOSTED_SMOKE_SCENARIO_MATRIX.findIndex((entry) => entry.name === name)) {
  const base = NOW + index * 100_000;
  const times = Object.fromEntries(HOSTED_SMOKE_EVENT_ORDER.map((event, eventIndex) => [event, base + eventIndex * 100]));
  const actionTime = {
    offline_network: times.offline_network_checked,
    gateway_stop: times.gateway_stopped,
    uid_idle: times.gateway_uid_idle,
    policy_removal: times.nftables_policy_removed,
    cgroup_namespace_cleanup: times.cgroup_namespace_cleanup,
    workspace_cleanup: times.workspace_cleanup,
  }[name] ?? times.scenario_started + 50;
  const selectedGateway = gateway(index);
  const scenarioEvidence = {
    kind: "api_migrator_github_hosted_l7_smoke_scenario_evidence",
    scenarioName: name,
    observedAt: actionTime,
    actionEvidenceDigest: digest(`${name}-action`),
    proof: proof(name),
  };
  const scenarioEvidenceDigest = sha256(Buffer.from(canonicalJson(scenarioEvidence), "utf8"));
  const checks = {
    preMutation: {
      nftablesTableAbsent: true,
      runnerUidIdle: true,
      gatewayUidIdle: true,
      evidenceDigest: digest(`${name}-pre-mutation`),
    },
    nativeValidation: {
      envoyStatus: "passed",
      nftablesStatus: "passed",
      envoyEvidenceDigest: digest(`${name}-envoy-validation`),
      nftablesEvidenceDigest: digest(`${name}-nft-validation`),
    },
    policyInstallation: {
      installed: true,
      policyDigest: selectedGateway.nftablesPolicyDigest,
      evidenceDigest: digest(`${name}-policy-installation`),
    },
    gatewayRuntime: {
      started: true,
      stopped: true,
      startEvidenceDigest: digest(`${name}-gateway-start`),
      stopEvidenceDigest: digest(`${name}-gateway-stop`),
    },
    listenerReadiness: {
      ipv4: true,
      ipv6: true,
      ipv4PositiveProbePassed: true,
      ipv6PositiveProbePassed: true,
      ownedByGatewayUid: true,
      evidenceDigest: digest(`${name}-listener-readiness`),
    },
    offlineFailClosed: {
      gatewayStopped: true,
      nftablesPolicyInstalled: true,
      connectionBlocked: true,
      redirectCounterDelta: 1,
      runnerLoopbackCounterDelta: 1,
      gatewayUpstreamCounterDelta: 0,
      gatewayDownstreamResponseCounterDelta: 0,
      evidenceDigest: digest(`${name}-offline-check`),
    },
    scenarioStartEvidenceDigest: digest(`${name}-scenario-start`),
    finalSnapshotEvidenceDigest: digest(`${name}-final-snapshot`),
  };
  const teardown = {
    gatewayStoppedAt: times.gateway_stopped,
    runnerUidIdleAt: times.runner_uid_idle,
    gatewayUidIdleAt: times.gateway_uid_idle,
    cgroupNamespaceCleanupAt: times.cgroup_namespace_cleanup,
    workspaceCleanupAt: times.workspace_cleanup,
    nftablesPolicyRemovedAt: times.nftables_policy_removed,
    runnerUidIdle: true,
    gatewayUidIdle: true,
    cgroupEmpty: true,
    processNetworkNamespaceReferenceAbsent: true,
    workspaceAbsent: true,
    nftablesPolicyAbsent: true,
    complete: true,
    runnerUidIdleEvidenceDigest: digest(`${name}-runner-idle`),
    gatewayUidIdleEvidenceDigest: digest(`${name}-gateway-idle`),
    cgroupNamespaceEvidenceDigest: digest(`${name}-cgroup-cleanup`),
    workspaceEvidenceDigest: digest(`${name}-workspace-cleanup`),
    nftablesRemovalEvidenceDigest: digest(`${name}-nft-removal`),
  };
  const evidenceDigests = {
    observer_started: checks.preMutation.evidenceDigest,
    contract_validated: selectedGateway.gatewayContractDigest,
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
  return {
    suiteId: SUITE_ID,
    scenarioName: name,
    sourceRevision: SOURCE_REVISION,
    githubRun: githubRun(),
    host: host(index),
    toolBindings: toolBindings(),
    gateway: selectedGateway,
    checks,
    scenarioEvidence,
    events: buildHostedSmokeEventStream({ observedAt: times, evidenceDigests }),
    teardown,
    startedAt: times.observer_started,
    finishedAt: times.observer_finished,
  };
}

function allReports() {
  return HOSTED_SMOKE_SCENARIO_MATRIX.map(({ name }, index) => buildHostedSmokeScenarioReport(scenarioInput(name, index)).report);
}

test("defines exactly the hosted 15 scenarios and keeps containment through cgroup/workspace cleanup", () => {
  assert.deepEqual(HOSTED_SMOKE_SCENARIO_MATRIX.map(({ name }) => name), [
    "success", "timeout", "sigkill", "wrong_sni", "absent_sni", "plaintext", "direct_bypass",
    "non_443", "non_npm", "offline_network", "gateway_stop", "uid_idle", "policy_removal",
    "cgroup_namespace_cleanup", "workspace_cleanup",
  ]);
  assert.deepEqual(HOSTED_SMOKE_OMITTED_SCENARIOS, ["oom", "reboot"]);
  assert(HOSTED_SMOKE_EVENT_ORDER.indexOf("gateway_stopped") < HOSTED_SMOKE_EVENT_ORDER.indexOf("offline_network_checked"));
  assert(HOSTED_SMOKE_EVENT_ORDER.indexOf("cgroup_namespace_cleanup") < HOSTED_SMOKE_EVENT_ORDER.indexOf("nftables_policy_removed"));
  assert(HOSTED_SMOKE_EVENT_ORDER.indexOf("workspace_cleanup") < HOSTED_SMOKE_EVENT_ORDER.indexOf("nftables_policy_removed"));
});

test("builds exact canonical, permanently non-authorizing scenario reports", () => {
  const built = buildHostedSmokeScenarioReport(scenarioInput("success"));
  assert.equal(built.report.host.provider, "github_hosted");
  assert.equal(built.report.host.runnerLabel, "ubuntu-24.04");
  assert.equal(built.report.host.dedicatedHost, false);
  assert.equal(built.report.selfAttested, true);
  assert.equal(built.report.releaseEvidenceEligible, false);
  assert.equal(built.report.activationBlocked, true);
  assert.equal(built.report.externalSigningEligible, false);
  assert.equal(built.report.authorizationStatus, HOSTED_SMOKE_AUTHORIZATION_STATUS);
  assert.deepEqual(validateHostedSmokeScenarioReport(built.report), built.report);
  assert.deepEqual(parseCanonicalHostedSmokeScenarioReport(built.canonicalJson).report, built.report);
  assert.throws(() => parseCanonicalHostedSmokeScenarioReport(`${built.canonicalJson}\n`), /canonical/);

  const authorizing = structuredClone(built.report);
  authorizing.releaseEvidenceEligible = true;
  assert.throws(() => validateHostedSmokeScenarioReport(authorizing), /cannot authorize/);
  const capability = structuredClone(built.report);
  capability.host.capability = "forbidden";
  assert.throws(() => validateHostedSmokeScenarioReport(capability), /forbidden authority field/);
});

test("wrong and absent SNI must reach the exact live owned listener without opening upstream", () => {
  for (const name of ["wrong_sni", "absent_sni"]) {
    assert.doesNotThrow(() => buildHostedSmokeScenarioReport(scenarioInput(name)));
    for (const mutate of [
      (value) => { value.scenarioEvidence.proof.tcpConnectedToOwnedListener = false; },
      (value) => { value.scenarioEvidence.proof.listenerOwnedByGatewayUid = false; },
      (value) => { value.scenarioEvidence.proof.deniedAfterTcpConnect = false; },
      (value) => { value.scenarioEvidence.proof.runnerLoopbackCounterDelta = 0; },
      (value) => { value.scenarioEvidence.proof.gatewayUpstreamCounterDelta = 1; },
      (value) => { value.scenarioEvidence.proof.envoyUpstreamAccessLogMatches = 1; },
    ]) {
      const input = scenarioInput(name);
      mutate(input);
      assert.throws(() => buildHostedSmokeScenarioReport(input), /listener|counter|upstream/);
    }
  }
});

test("listener readiness requires positive traffic over both IPv4 and IPv6", () => {
  for (const field of ["ipv4PositiveProbePassed", "ipv6PositiveProbePassed"]) {
    const input = scenarioInput("success");
    input.checks.listenerReadiness[field] = false;
    assert.throws(() => buildHostedSmokeScenarioReport(input), /positive traffic over both/);
  }
});

test("direct bypass requires redirect, loopback, upstream counter, and Envoy-log correlation", () => {
  for (const field of [
    "redirectCounterDelta", "runnerLoopbackCounterDelta", "gatewayUpstreamCounterDelta",
    "gatewayDownstreamResponseCounterDelta", "envoyAccessLogMatches",
  ]) {
    const input = scenarioInput("direct_bypass");
    input.scenarioEvidence.proof[field] = 0;
    assert.throws(() => buildHostedSmokeScenarioReport(input), /positive bounded counter delta/);
  }
  const rejected = scenarioInput("direct_bypass");
  rejected.scenarioEvidence.proof.gatewayRejectCounterDelta = 1;
  assert.throws(() => buildHostedSmokeScenarioReport(rejected), /fixed TLS route/);
});

test("offline closure requires redirect and loopback deltas with zero gateway upstream traffic", () => {
  for (const mutate of [
    (input) => { input.checks.redirectCounterDelta = 0; },
    (input) => { input.checks.runnerLoopbackCounterDelta = 0; },
    (input) => { input.checks.gatewayUpstreamCounterDelta = 1; },
    (input) => { input.checks.gatewayDownstreamResponseCounterDelta = 1; },
    (input) => { input.proof.redirectCounterDelta = 0; },
    (input) => { input.proof.runnerLoopbackCounterDelta = 0; },
    (input) => { input.proof.gatewayUpstreamCounterDelta = 1; },
    (input) => { input.proof.gatewayDownstreamResponseCounterDelta = 1; },
  ]) {
    const input = scenarioInput("offline_network");
    mutate({ checks: input.checks.offlineFailClosed, proof: input.scenarioEvidence.proof });
    assert.throws(() => buildHostedSmokeScenarioReport(input), /offline|counter delta/);
  }
});

test("cgroup cleanup claims only the vanished process namespace reference", () => {
  const input = scenarioInput("cgroup_namespace_cleanup");
  input.scenarioEvidence.proof.processNetworkNamespaceReferenceAbsent = false;
  assert.throws(() => buildHostedSmokeScenarioReport(input), /namespace-reference/);
});

test("rejects event-chain drift and teardown before cleanup containment removal", () => {
  const chainDrift = scenarioInput("success");
  chainDrift.events = structuredClone(chainDrift.events);
  chainDrift.events[8].previousEventDigest = digest("substituted-chain");
  assert.throws(() => buildHostedSmokeScenarioReport(chainDrift), /event is reordered|event-stream/);

  const earlyRemoval = scenarioInput("workspace_cleanup");
  earlyRemoval.teardown.workspaceCleanupAt = earlyRemoval.teardown.nftablesPolicyRemovedAt + 1;
  assert.throws(() => buildHostedSmokeScenarioReport(earlyRemoval), /does not match|before removing containment/);
});

test("builds and parses the exact 15-report one-run/attempt/SHA aggregate", () => {
  const built = buildHostedSmokeAggregateReport({ scenarioReports: allReports() });
  assert.equal(built.report.scenarioCount, 15);
  assert.deepEqual(built.report.scenarioReports.map(({ scenarioName }) => scenarioName), HOSTED_SMOKE_SCENARIO_MATRIX.map(({ name }) => name));
  assert.equal(new Set(built.report.scenarioReportDigests.map(({ reportDigest }) => reportDigest)).size, 15);
  assert.deepEqual(built.report.omittedScenarios, ["oom", "reboot"]);
  assert.equal(built.report.releaseEvidenceEligible, false);
  assert.equal(built.report.authoritativeDrill, false);
  assert.deepEqual(validateHostedSmokeAggregateReport(built.report), built.report);
  assert.deepEqual(parseCanonicalHostedSmokeAggregateReport(built.canonicalJson).report, built.report);
  assert.throws(() => parseCanonicalHostedSmokeAggregateReport(`${built.canonicalJson}\n`), /canonical/);
});

test("aggregate rejects missing, duplicate, cross-attempt, cross-SHA, and authorizing reports", () => {
  const reports = allReports();
  assert.throws(() => buildHostedSmokeAggregateReport({ scenarioReports: reports.slice(1) }), /exactly 15/);

  const duplicate = [...reports];
  duplicate[1] = duplicate[0];
  assert.throws(() => buildHostedSmokeAggregateReport({ scenarioReports: duplicate }), /duplicate/);

  const crossAttempt = reports.map((report) => structuredClone(report));
  crossAttempt[1].githubRun.runAttempt = 2;
  assert.throws(() => buildHostedSmokeAggregateReport({ scenarioReports: crossAttempt }), /runs, or attempts/);

  const crossSha = reports.map((report) => structuredClone(report));
  crossSha[1].sourceRevision = "b".repeat(40);
  assert.throws(() => buildHostedSmokeAggregateReport({ scenarioReports: crossSha }), /commits/);

  const built = buildHostedSmokeAggregateReport({ scenarioReports: reports });
  const authorizing = structuredClone(built.report);
  authorizing.externalSigningEligible = true;
  assert.throws(() => validateHostedSmokeAggregateReport(authorizing), /cannot authorize/);

  const omitted = structuredClone(built.report);
  omitted.omittedScenarios = ["oom"];
  assert.throws(() => validateHostedSmokeAggregateReport(omitted), /scenario boundary/);
});
