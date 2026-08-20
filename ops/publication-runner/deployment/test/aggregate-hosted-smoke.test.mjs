import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import test from "node:test";

import {
  buildHostedSmokeAggregateFromDirectory,
  discoverHostedSmokeScenarioReports,
  parseAggregateHostedSmokeArguments,
  runHostedSmokeAggregation,
} from "../aggregate-hosted-smoke.mjs";
import {
  HOSTED_SMOKE_AUTHORIZATION_STATUS,
  HOSTED_SMOKE_EVENT_ORDER,
  HOSTED_SMOKE_SCENARIO_MATRIX,
  buildHostedSmokeEventStream,
  buildHostedSmokeScenarioReport,
  parseCanonicalHostedSmokeAggregateReport,
} from "../hosted-lifecycle-smoke.mjs";
import { canonicalJson, sha256 } from "../lib.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../aggregate-hosted-smoke.mjs");
const NOW = 2_100_000_000_000;
const SUITE_ID = `hostedsmoke_${"e".repeat(64)}`;
const SOURCE_REVISION = "b".repeat(40);

function digest(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function githubRun(runAttempt = 1) {
  return {
    repository: "example/api-migrator",
    workflowRef: "example/api-migrator/.github/workflows/hosted-smoke.yml@refs/pull/12/merge",
    runId: "1234567890",
    runAttempt,
  };
}

function host(index) {
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
    bootIdDigest: digest(`aggregate-boot-id-${index}`),
  };
}

function toolBindings(index) {
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
  ].map(([name, path]) => [name, {
    path,
    digest: digest(`aggregate-tool-${index}-${name}`),
    version: `${name} 1.0`,
  }]));
}

function gateway(index) {
  return {
    profile: "static-envoy-sni-passthrough-v1",
    gatewayContractDigest: digest(`aggregate-gateway-contract-${index}`),
    envoyConfigDigest: digest(`aggregate-envoy-config-${index}`),
    nftablesPolicyDigest: digest(`aggregate-nft-policy-${index}`),
    gatewayRuntimeDigest: digest(`aggregate-envoy-runtime-${index}`),
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
    listenerSnapshotDigest: digest(`${name}-aggregate-listener`),
    counterSnapshotBeforeDigest: digest(`${name}-aggregate-before`),
    counterSnapshotAfterDigest: digest(`${name}-aggregate-after`),
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
        accessLogDigest: digest(`${name}-aggregate-access-log`),
      };
    case "timeout":
    case "sigkill":
      return {
        type: "fault_teardown",
        fault: name,
        workloadStarted: true,
        faultObserved: true,
        containmentInstalledAtFault: true,
        processEvidenceDigest: digest(`${name}-aggregate-process`),
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
        accessLogDigest: digest(`${name}-aggregate-access-log`),
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
        envoyAccessLogMatches: 1,
        counterSnapshotBeforeDigest: snapshots.counterSnapshotBeforeDigest,
        counterSnapshotAfterDigest: snapshots.counterSnapshotAfterDigest,
        accessLogDigest: digest(`${name}-aggregate-access-log`),
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
        listenerAbsent: true,
        evidenceDigest: digest(`${name}-aggregate-offline`),
      };
    case "gateway_stop":
      return {
        type: "gateway_stop",
        processAbsent: true,
        ipv4ListenerAbsent: true,
        ipv6ListenerAbsent: true,
        processSnapshotDigest: digest(`${name}-aggregate-process`),
        listenerSnapshotDigest: snapshots.listenerSnapshotDigest,
      };
    case "uid_idle":
      return {
        type: "uid_idle",
        runnerUidIdle: true,
        gatewayUidIdle: true,
        processSnapshotDigest: digest(`${name}-aggregate-process`),
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
        cgroupEvidenceDigest: digest(`${name}-aggregate-cgroup`),
        namespaceEvidenceDigest: digest(`${name}-aggregate-namespace`),
      };
    case "workspace_cleanup":
      return {
        type: "workspace_cleanup",
        workspaceAbsent: true,
        parentSnapshotDigest: digest(`${name}-aggregate-parent`),
      };
    default:
      throw new Error(`unsupported fixture scenario: ${name}`);
  }
}

function scenarioCanonical(name, index, options = {}) {
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
    actionEvidenceDigest: digest(`${name}-aggregate-action`),
    proof: proof(name),
  };
  const scenarioEvidenceDigest = sha256(Buffer.from(canonicalJson(scenarioEvidence), "utf8"));
  const checks = {
    preMutation: {
      nftablesTableAbsent: true,
      runnerUidIdle: true,
      gatewayUidIdle: true,
      evidenceDigest: digest(`${name}-aggregate-pre-mutation`),
    },
    nativeValidation: {
      envoyStatus: "passed",
      nftablesStatus: "passed",
      envoyEvidenceDigest: digest(`${name}-aggregate-envoy-validation`),
      nftablesEvidenceDigest: digest(`${name}-aggregate-nft-validation`),
    },
    policyInstallation: {
      installed: true,
      policyDigest: selectedGateway.nftablesPolicyDigest,
      evidenceDigest: digest(`${name}-aggregate-policy-installation`),
    },
    gatewayRuntime: {
      started: true,
      stopped: true,
      startEvidenceDigest: digest(`${name}-aggregate-gateway-start`),
      stopEvidenceDigest: digest(`${name}-aggregate-gateway-stop`),
    },
    listenerReadiness: {
      ipv4: true,
      ipv6: true,
      ipv4PositiveProbePassed: true,
      ipv6PositiveProbePassed: true,
      ownedByGatewayUid: true,
      evidenceDigest: digest(`${name}-aggregate-listener-readiness`),
    },
    offlineFailClosed: {
      gatewayStopped: true,
      nftablesPolicyInstalled: true,
      connectionBlocked: true,
      redirectCounterDelta: 1,
      runnerLoopbackCounterDelta: 1,
      gatewayUpstreamCounterDelta: 0,
      evidenceDigest: digest(`${name}-aggregate-offline-check`),
    },
    scenarioStartEvidenceDigest: digest(`${name}-aggregate-scenario-start`),
    finalSnapshotEvidenceDigest: digest(`${name}-aggregate-final-snapshot`),
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
    runnerUidIdleEvidenceDigest: digest(`${name}-aggregate-runner-idle`),
    gatewayUidIdleEvidenceDigest: digest(`${name}-aggregate-gateway-idle`),
    cgroupNamespaceEvidenceDigest: digest(`${name}-aggregate-cgroup-cleanup`),
    workspaceEvidenceDigest: digest(`${name}-aggregate-workspace-cleanup`),
    nftablesRemovalEvidenceDigest: digest(`${name}-aggregate-nft-removal`),
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
  return buildHostedSmokeScenarioReport({
    suiteId: SUITE_ID,
    scenarioName: name,
    sourceRevision: options.sourceRevision ?? SOURCE_REVISION,
    githubRun: githubRun(options.runAttempt ?? 1),
    host: host(index),
    toolBindings: toolBindings(index),
    gateway: selectedGateway,
    checks,
    scenarioEvidence,
    events: buildHostedSmokeEventStream({ observedAt: times, evidenceDigests }),
    teardown,
    startedAt: times.observer_started,
    finishedAt: times.observer_finished,
  }).canonicalJson;
}

function fixtureReports() {
  return HOSTED_SMOKE_SCENARIO_MATRIX.map(({ name }, index) => scenarioCanonical(name, index));
}

function temporaryDirectory(t) {
  const root = mkdtempSync(join(tmpdir(), "api-migrator-hosted-aggregate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeArtifactTree(root, reports = fixtureReports()) {
  const inputDir = join(root, "artifacts");
  mkdirSync(inputDir);
  reports.forEach((contents, index) => {
    const artifactDir = join(inputDir, `hosted-smoke-${String(index).padStart(2, "0")}`);
    mkdirSync(artifactDir);
    writeFileSync(join(artifactDir, "scenario-report.json"), contents, { mode: 0o600 });
  });
  return inputDir;
}

test("accepts only the exact absolute CLI shape and keeps output outside input", () => {
  const inputDir = "/tmp/hosted-smoke-input";
  const output = "/tmp/hosted-smoke-output.json";
  assert.deepEqual(parseAggregateHostedSmokeArguments([
    "--input-dir", inputDir, "--output", output,
  ]), { inputDir, output });
  assert.throws(() => parseAggregateHostedSmokeArguments([inputDir, output]), /usage/);
  assert.throws(() => parseAggregateHostedSmokeArguments([
    "--input-dir", "relative", "--output", output,
  ]), /absolute normalized/);
  assert.throws(() => parseAggregateHostedSmokeArguments([
    "--input-dir", inputDir, "--output", `${inputDir}/aggregate.json`,
  ]), /outside/);
});

test("recursively aggregates exactly 15 canonical artifacts and writes mode 0600 with O_EXCL", (t) => {
  const root = temporaryDirectory(t);
  const inputDir = writeArtifactTree(root);
  const nestedParent = join(inputDir, "nested");
  mkdirSync(nestedParent);
  const oldArtifact = join(inputDir, "hosted-smoke-14");
  const nestedArtifact = join(nestedParent, "hosted-smoke-14");
  mkdirSync(nestedArtifact);
  const finalReport = readFileSync(join(oldArtifact, "scenario-report.json"));
  writeFileSync(join(nestedArtifact, "scenario-report.json"), finalReport);
  rmSync(oldArtifact, { recursive: true });

  const output = join(root, "aggregate.json");
  const loaded = discoverHostedSmokeScenarioReports(inputDir);
  assert.equal(loaded.length, 15);
  assert.equal(new Set(loaded.map(({ artifactDirectory }) => artifactDirectory)).size, 15);

  const result = runHostedSmokeAggregation(["--input-dir", inputDir, "--output", output]);
  assert.equal(result.scenarioCount, 15);
  assert.equal(result.releaseEvidenceEligible, false);
  assert.equal(result.activationBlocked, true);
  assert.equal(result.externalSigningEligible, false);
  assert.equal(result.authorizationStatus, HOSTED_SMOKE_AUTHORIZATION_STATUS);
  assert.equal(lstatSync(output).mode & 0o777, 0o600);

  const parsed = parseCanonicalHostedSmokeAggregateReport(readFileSync(output, "utf8"));
  assert.equal(parsed.digest, result.aggregateDigest);
  assert.equal(parsed.report.reportScope, "github_hosted_independent_fresh_vm_15_scenario_aggregate");
  assert.equal(new Set(parsed.report.scenarioReports.map(({ host }) => host.bootIdDigest)).size, 15);
  assert.throws(
    () => runHostedSmokeAggregation(["--input-dir", inputDir, "--output", output]),
    (error) => error?.code === "EEXIST",
  );
});

test("the executable CLI emits only a non-authorizing result", (t) => {
  const root = temporaryDirectory(t);
  const inputDir = writeArtifactTree(root);
  const output = join(root, "aggregate.json");
  const run = spawnSync(process.execPath, [SCRIPT, "--input-dir", inputDir, "--output", output], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result, {
    activationBlocked: true,
    aggregateDigest: parseCanonicalHostedSmokeAggregateReport(readFileSync(output, "utf8")).digest,
    authorizationStatus: HOSTED_SMOKE_AUTHORIZATION_STATUS,
    externalSigningEligible: false,
    kind: "api_migrator_github_hosted_l7_smoke_aggregate_cli_result",
    outputPath: output,
    releaseEvidenceEligible: false,
    scenarioCount: 15,
    status: "passed",
  });
});

test("rejects missing, extra, duplicate, malformed, and cross-run scenario artifacts", async (t) => {
  await t.test("missing", (t) => {
    const root = temporaryDirectory(t);
    const inputDir = writeArtifactTree(root, fixtureReports().slice(1));
    assert.throws(() => buildHostedSmokeAggregateFromDirectory(inputDir), /exactly 15/);
  });

  await t.test("extra report", (t) => {
    const root = temporaryDirectory(t);
    const reports = fixtureReports();
    const inputDir = writeArtifactTree(root, reports);
    const extra = join(inputDir, "extra-artifact");
    mkdirSync(extra);
    writeFileSync(join(extra, "scenario-report.json"), reports[0]);
    assert.throws(() => buildHostedSmokeAggregateFromDirectory(inputDir), /exactly 15/);
  });

  await t.test("extra regular file", (t) => {
    const root = temporaryDirectory(t);
    const inputDir = writeArtifactTree(root);
    writeFileSync(join(inputDir, "README.txt"), "not evidence");
    assert.throws(() => buildHostedSmokeAggregateFromDirectory(inputDir), /extra regular file/);
  });

  await t.test("duplicate", (t) => {
    const root = temporaryDirectory(t);
    const reports = fixtureReports();
    reports[1] = reports[0];
    const inputDir = writeArtifactTree(root, reports);
    assert.throws(() => buildHostedSmokeAggregateFromDirectory(inputDir), /duplicate/);
  });

  await t.test("malformed non-canonical", (t) => {
    const root = temporaryDirectory(t);
    const reports = fixtureReports();
    reports[0] = `${reports[0]}\n`;
    const inputDir = writeArtifactTree(root, reports);
    assert.throws(() => buildHostedSmokeAggregateFromDirectory(inputDir), /canonical/);
  });

  await t.test("cross-run attempt", (t) => {
    const root = temporaryDirectory(t);
    const reports = fixtureReports();
    reports[1] = scenarioCanonical(HOSTED_SMOKE_SCENARIO_MATRIX[1].name, 1, { runAttempt: 2 });
    const inputDir = writeArtifactTree(root, reports);
    assert.throws(() => buildHostedSmokeAggregateFromDirectory(inputDir), /runs, or attempts/);
  });
});

test("rejects links, direct-at-root reports, oversized reports, and pre-existing outputs", async (t) => {
  await t.test("symbolic link", (t) => {
    const root = temporaryDirectory(t);
    const reports = fixtureReports();
    const inputDir = writeArtifactTree(root, reports.slice(1));
    const target = join(root, "outside-report.json");
    writeFileSync(target, reports[0]);
    const linkedArtifact = join(inputDir, "linked-artifact");
    mkdirSync(linkedArtifact);
    symlinkSync(target, join(linkedArtifact, "scenario-report.json"));
    assert.throws(() => buildHostedSmokeAggregateFromDirectory(inputDir), /symbolic links/);
  });

  await t.test("direct at root", (t) => {
    const root = temporaryDirectory(t);
    const reports = fixtureReports();
    const inputDir = writeArtifactTree(root, reports.slice(1));
    writeFileSync(join(inputDir, "scenario-report.json"), reports[0]);
    assert.throws(() => buildHostedSmokeAggregateFromDirectory(inputDir), /artifact subdirectory/);
  });

  await t.test("oversized", (t) => {
    const root = temporaryDirectory(t);
    const reports = fixtureReports();
    reports[0] = "x".repeat(256 * 1024 + 1);
    const inputDir = writeArtifactTree(root, reports);
    assert.throws(() => buildHostedSmokeAggregateFromDirectory(inputDir), /bounded/);
  });

  await t.test("pre-existing output", (t) => {
    const root = temporaryDirectory(t);
    const inputDir = writeArtifactTree(root);
    const output = join(root, "aggregate.json");
    writeFileSync(output, "preserve me", { mode: 0o600 });
    assert.throws(
      () => runHostedSmokeAggregation(["--input-dir", inputDir, "--output", output]),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(readFileSync(output, "utf8"), "preserve me");
  });
});
