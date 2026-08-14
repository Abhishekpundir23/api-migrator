import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalJson, sha256 } from "../lib.mjs";
import {
  LIFECYCLE_AUTHORIZATION_STATUS,
  LIFECYCLE_EVENT_ORDER,
  LIFECYCLE_SCENARIO_MATRIX,
  parseCanonicalLifecycleDrillReport,
  renderLifecycleDrillContract,
  validateLifecycleDrillContractRecord,
  validateLifecycleDrillReport,
} from "../lifecycle-drill.mjs";

const DEPLOYMENT_DIR = new URL("../", import.meta.url);
const NOW = 2_000_000_000_000;
const JOB_ID = `previewjob_${"d".repeat(64)}`;

function digest(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function inputFixture() {
  const profile = JSON.parse(readFileSync(new URL("host-profile.example.json", DEPLOYMENT_DIR), "utf8"));
  const plan = {
    schemaVersion: 1,
    profile: "disposable-egress-filtered-pilot-v1",
    job: {
      id: JOB_ID,
      nonceDigest: digest("nonce"),
      createdAt: NOW,
      expiresAt: NOW + 600_000,
      disposable: true,
    },
    subject: {
      pilotId: "pilot_sandbox_001",
      repository: { slug: "example/repo", id: 1, ownerId: 2 },
      base: { branch: "main", sha: "1".repeat(40) },
    },
    inputs: {
      sourceArchiveDigest: digest("source"),
      manifestDigest: digest("manifest"),
      commandScopeDigest: digest("commands"),
    },
    imageDigest: profile.artifacts.imageDigest,
    egress: {
      enforcement: "host_nftables_output_exact_ip_tcp443",
      install: { policyDigest: digest("egress-policy") },
    },
    execution: { credentials: "none" },
    teardown: { evidenceRequired: true },
  };
  const planText = canonicalJson(plan);
  const job = JSON.parse(readFileSync(new URL("job-descriptor.example.json", DEPLOYMENT_DIR), "utf8"));
  job.jobId = JOB_ID;
  job.unitRenderedAt = NOW;
  job.runtimeMaxMs = 600_000;
  job.planDigest = sha256(Buffer.from(planText, "utf8"));
  const gatewayContract = {
    schemaVersion: 1,
    profile: "static-envoy-sni-passthrough-v1",
    jobId: JOB_ID,
    plan: { digest: job.planDigest, createdAt: NOW, expiresAt: NOW + 600_000 },
    egressPolicyDigest: plan.egress.install.policyDigest,
    gatewayRuntimeDigest: profile.executables.envoy.digest,
    runnerUid: profile.runner.uid,
    gatewayUid: profile.gateway.uid,
    listener: { addresses: ["127.0.0.1", "::1"], port: profile.gateway.listenerPort },
    origin: {
      host: "registry.npmjs.org",
      port: 443,
      addresses: ["104.16.1.35", "2606:4700::6810:123"],
      resolutionEvidenceDigest: digest("resolution"),
      resolutionObservedAt: NOW - 60_000,
      resolutionExpiresAt: NOW + 1_200_000,
    },
  };
  return { job, profile, plan, planText, gatewayContract };
}

function renderFixture(input = inputFixture()) {
  const { job, profile, planText, gatewayContract } = input;
  return renderLifecycleDrillContract({ job, profile, planText, gatewayContract });
}

function reportFixture(deployment) {
  const contract = deployment.contract;
  const offsets = [
    0, 1_000, 2_000, 3_000, 4_000, 5_000, 10_000, 100_000,
    101_000, 102_000, 103_000, 104_000, 105_000, 106_000, 107_000,
  ];
  const scenarios = LIFECYCLE_SCENARIO_MATRIX.map((scenario, index) => ({
    scenario,
    index,
    base: NOW + index * 1_000_000,
    jobId: index === 0 ? contract.jobId : `previewjob_${(index + 1).toString(16).padStart(64, "0")}`,
    planDigest: index === 0 ? contract.planDigest : digest(`plan-${scenario.name}`),
    gatewayContractDigest: index === 0 ? contract.gatewayContractDigest : digest(`gateway-contract-${scenario.name}`),
  })).map(({ scenario, index, base, jobId, planDigest, gatewayContractDigest }) => {
    const events = LIFECYCLE_EVENT_ORDER.map((event, eventIndex) => ({
      sequence: eventIndex + 1,
      event,
      jobId,
      planDigest,
      observedAt: base + offsets[eventIndex],
      evidenceDigest: digest(`event-${scenario.name}-${event}`),
    }));
    return {
      name: scenario.name,
      expectedOutcome: scenario.expectedOutcome,
      observedOutcome: scenario.expectedOutcome,
      status: "passed",
      jobId,
      planDigest,
      planCreatedAt: index === 0 ? contract.planCreatedAt : base - 1_000,
      planExpiresAt: index === 0 ? contract.planExpiresAt : base + 200_000,
      egressPolicyDigest: contract.egressPolicyDigest,
      runnerUid: contract.runnerUid,
      gatewayUid: contract.gatewayUid,
      envoyDigest: contract.envoyDigest,
      hostProfileDigest: contract.hostProfileDigest,
      toolBindingsDigest: contract.toolBindingsDigest,
      gatewayContractDigest,
      gatewayReceiptDigest: digest(`gateway-receipt-${scenario.name}`),
      startedAt: base,
      finishedAt: base + 107_000,
      events,
      eventsDigest: sha256(Buffer.from(canonicalJson(events), "utf8")),
      teardown: {
        gatewayStoppedAt: events[8].observedAt,
        runnerUidIdleAt: events[9].observedAt,
        gatewayUidIdleAt: events[10].observedAt,
        nftablesPolicyRemovedAt: events[11].observedAt,
        cgroupNamespaceCleanupAt: events[12].observedAt,
        workspaceCleanupAt: events[13].observedAt,
        complete: true,
        evidenceDigest: digest(`teardown-${scenario.name}`),
      },
      evidenceDigest: digest(`scenario-${index}-${scenario.name}`),
    };
  });
  return {
    schemaVersion: 1,
    kind: "api_migrator_linux_l7_lifecycle_drill_report",
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
    startedAt: scenarios[0].startedAt,
    finishedAt: scenarios.at(-1).finishedAt,
    scenarios,
    reportScope: "structural_aggregate_independent_scenario_jobs",
    aggregateStatus: "passed",
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: LIFECYCLE_AUTHORIZATION_STATUS,
  };
}

test("cross-binds the v2 host, job, canonical plan, and rendered gateway without authorization", () => {
  const input = inputFixture();
  const deployment = renderFixture(input);
  assert.equal(deployment.contract.jobId, input.job.jobId);
  assert.equal(deployment.contract.planDigest, input.job.planDigest);
  assert.equal(deployment.contract.egressPolicyDigest, input.plan.egress.install.policyDigest);
  assert.equal(deployment.contract.runnerUid, input.profile.runner.uid);
  assert.equal(deployment.contract.gatewayUid, input.profile.gateway.uid);
  assert.notEqual(deployment.contract.runnerUid, deployment.contract.gatewayUid);
  assert.equal(deployment.contract.envoyDigest, input.profile.executables.envoy.digest);
  assert.equal(deployment.contract.toolBindings.gatewayProbe.path, input.profile.artifacts.gatewayProbePath);
  assert.equal(deployment.contract.toolBindings.gatewayProbe.digest, input.profile.artifacts.gatewayProbeDigest);
  assert.equal(
    deployment.contract.toolBindings.lifecycleOrchestrator.digest,
    input.profile.artifacts.lifecycleOrchestratorDigest
  );
  assert.equal(
    deployment.contract.toolBindings.lifecycleObserver.digest,
    input.profile.artifacts.lifecycleObserverDigest
  );
  assert.deepEqual(deployment.contract.toolBindings.runtimeManifest, {
    path: input.profile.artifacts.lifecycleRuntimeManifestPath,
    digest: input.profile.artifacts.lifecycleRuntimeManifestDigest,
  });
  assert.equal(deployment.contract.paths.runtimeRootPath, input.job.runtimeRootPath);
  assert.equal(deployment.contract.paths.lifecyclePreflightPath, input.job.lifecyclePreflightPath);
  assert.equal(deployment.contract.toolBindings.ss.digest, input.profile.executables.ss.digest);
  assert.deepEqual(deployment.contract.eventOrder, LIFECYCLE_EVENT_ORDER);
  assert.deepEqual(deployment.contract.scenarioMatrix, LIFECYCLE_SCENARIO_MATRIX);
  assert.equal(deployment.contract.executionScope, "structural_suite_template_independent_scenario_jobs");
  assert.equal(
    deployment.contract.scenarioMatrix.find(({ name }) => name === "direct_bypass").expectedOutcome,
    "forced_through_gateway_with_correlated_counters"
  );
  assert.equal(deployment.contract.activationBlocked, true);
  assert.equal(deployment.contract.externalSigningEligible, false);
  assert.equal(deployment.contract.authorizationStatus, LIFECYCLE_AUTHORIZATION_STATUS);
  assert.doesNotThrow(() => validateLifecycleDrillContractRecord(deployment));
});

test("rejects substituted plan, policy, identity, listener, and Envoy bindings", () => {
  const mutations = [
    (input) => { input.gatewayContract.plan.digest = digest("wrong-plan"); },
    (input) => { input.gatewayContract.egressPolicyDigest = digest("wrong-policy"); },
    (input) => { input.gatewayContract.runnerUid += 10; },
    (input) => { input.gatewayContract.gatewayUid = input.gatewayContract.runnerUid; },
    (input) => { input.gatewayContract.listener.port += 1; },
    (input) => { input.gatewayContract.gatewayRuntimeDigest = digest("wrong-envoy"); },
  ];
  for (const mutate of mutations) {
    const input = inputFixture();
    mutate(input);
    assert.throws(() => renderFixture(input));
  }

  const deployment = renderFixture();
  const substituted = structuredClone(deployment);
  substituted.contract.envoyDigest = digest("substituted-record");
  assert.throws(() => validateLifecycleDrillContractRecord(substituted), /substitutes|substituted/);

  for (const mutate of [
    (record) => { record.hostProfile.artifacts.gatewayProbeDigest = digest("changed-probe"); },
    (record) => { record.hostProfile.artifacts.lifecycleOrchestratorPath = "/opt/substituted-orchestrator"; },
    (record) => { record.hostProfile.artifacts.lifecycleObserverDigest = digest("changed-observer"); },
    (record) => { record.hostProfile.artifacts.lifecycleRuntimeManifestDigest = digest("changed-runtime-manifest"); },
    (record) => { record.hostProfile.executables.ss.digest = digest("changed-ss"); },
  ]) {
    const changed = structuredClone(deployment);
    mutate(changed);
    assert.throws(() => validateLifecycleDrillContractRecord(changed), /substitutes|substituted/);
  }
});

test("validates the exact observer-first aggregate scenario and teardown report", () => {
  const deployment = renderFixture();
  const report = reportFixture(deployment);
  const validated = validateLifecycleDrillReport(report, deployment);
  assert.deepEqual(validated.scenarios.map(({ name }) => name), LIFECYCLE_SCENARIO_MATRIX.map(({ name }) => name));
  assert(validated.scenarios.every(({ events }) => events[0].event === "observer_started"));
  assert(validated.scenarios.every(({ teardown }) => teardown.complete));
  assert.equal(new Set(validated.scenarios.map(({ jobId }) => jobId)).size, LIFECYCLE_SCENARIO_MATRIX.length);
  assert.equal(validated.reportScope, "structural_aggregate_independent_scenario_jobs");
  assert.equal(validated.activationBlocked, true);
  assert.equal(validated.externalSigningEligible, false);

  const text = canonicalJson(validated);
  assert.deepEqual(parseCanonicalLifecycleDrillReport(text, deployment).report, validated);
  assert.throws(() => parseCanonicalLifecycleDrillReport(`${text}\n`, deployment), /exact canonical JSON/);
});

test("rejects incomplete, reordered, stale, substituted, or authorizing aggregate reports", () => {
  const deployment = renderFixture();
  const cases = [
    (report) => { report.activationBlocked = false; },
    (report) => { report.externalSigningEligible = true; },
    (report) => { report.authorizationStatus = "authorized"; },
    (report) => { report.planDigest = digest("substituted-plan"); },
    (report) => { report.scenarios[0].planCreatedAt -= 1; },
    (report) => { report.hostProfileDigest = digest("substituted-host-profile"); },
    (report) => { report.scenarios[0].toolBindingsDigest = digest("substituted-tools"); },
    (report) => { report.scenarios[0].events[0].event = "contract_validated"; },
    (report) => { report.scenarios[0].events[1].observedAt = report.scenarios[0].events[0].observedAt; },
    (report) => { report.scenarios[0].eventsDigest = digest("substituted-events"); },
    (report) => { report.scenarios.splice(5, 1); },
    (report) => { report.scenarios[1].observedOutcome = "blocked"; },
    (report) => { report.scenarios[1].gatewayReceiptDigest = report.scenarios[0].gatewayReceiptDigest; },
    (report) => { report.scenarios[0].teardown.complete = false; },
    (report) => { report.scenarios[0].teardown.workspaceCleanupAt -= 1; },
    (report) => { report.scenarios[0].finishedAt = report.scenarios[0].planExpiresAt; },
    (report) => { report.startedAt = 0; },
  ];
  for (const mutate of cases) {
    const report = reportFixture(deployment);
    mutate(report);
    assert.throws(() => validateLifecycleDrillReport(report, deployment));
  }
});
