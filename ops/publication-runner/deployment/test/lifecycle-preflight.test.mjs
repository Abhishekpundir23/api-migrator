import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalJson, sha256 } from "../lib.mjs";
import {
  PREFLIGHT_AUTHORIZATION_STATUS,
  buildLifecyclePreflightEvent,
  parseCanonicalLifecyclePreflightResult,
  parseObserverReadinessEvent,
  renderLifecyclePreflightPlan,
  runLifecyclePreflight,
  validateLifecyclePreflightResult,
} from "../lifecycle-preflight.mjs";
import { renderGatewayDeployment } from "../../gateway/gateway-contract.mjs";

const DEPLOYMENT_DIR = new URL("../", import.meta.url);
const NOW = 2_000_000_000_000;
const JOB_ID = `previewjob_${"d".repeat(64)}`;
const JOB_ROOT = "/var/lib/api-migrator-runner/jobs/job-001";
const JOB_PATH = `${JOB_ROOT}/job-descriptor.json`;

function digest(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function fixture() {
  const runtimeManifest = JSON.parse(readFileSync(new URL("runtime-manifest.example.json", DEPLOYMENT_DIR), "utf8"));
  const runtimeManifestText = canonicalJson(runtimeManifest);
  const profile = JSON.parse(readFileSync(new URL("host-profile.example.json", DEPLOYMENT_DIR), "utf8"));
  profile.artifacts.lifecycleRuntimeManifestDigest = sha256(Buffer.from(runtimeManifestText, "utf8"));
  const profileText = canonicalJson(profile);
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
  Object.assign(job, {
    jobId: JOB_ID,
    unitRenderedAt: NOW,
    runtimeMaxMs: 600_000,
    planPath: `${JOB_ROOT}/plan.json`,
    planDigest: sha256(Buffer.from(planText, "utf8")),
    sourceArchivePath: `${JOB_ROOT}/source.tar`,
    outputPath: `${JOB_ROOT}/output`,
    rawEventsPath: `${JOB_ROOT}/events.ndjson`,
    runnerResultPath: `${JOB_ROOT}/events.ndjson.runner.json`,
    hostProfilePath: "/etc/api-migrator-runner/host-profile.json",
    runtimeRootPath: `${JOB_ROOT}/orchestrator/runtime`,
    lifecyclePreflightPath: `${JOB_ROOT}/orchestrator/lifecycle-preflight.json`,
    l7IntegrationStatusPath: `${JOB_ROOT}/l7-integration-status.json`,
    gatewayContractPath: `${JOB_ROOT}/gateway-contract.json`,
    gatewayReceiptPath: `${JOB_ROOT}/gateway-receipt.json`,
    lifecycleEventsPath: `${JOB_ROOT}/observer/lifecycle-events.ndjson`,
    lifecycleReportPath: `${JOB_ROOT}/observer/lifecycle-report.json`,
    observationPath: `${JOB_ROOT}/observation.json`,
    signingRequestPath: `${JOB_ROOT}/signing-request.json`,
  });
  const jobText = canonicalJson(job);
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
  const gatewayContractText = canonicalJson(gatewayContract);
  const gatewayDeployment = renderGatewayDeployment(gatewayContract);
  const event = buildLifecyclePreflightEvent({
    sequence: 1,
    event: "observer_started",
    jobId: JOB_ID,
    planDigest: job.planDigest,
    hostProfileDigest: sha256(Buffer.from(profileText, "utf8")),
    runtimeManifestDigest: sha256(Buffer.from(runtimeManifestText, "utf8")),
    gatewayContractDigest: gatewayDeployment.digest,
    observedAt: NOW + 999,
    evidenceDigest: digest("observer-readiness-evidence"),
  });
  const observerEventText = `${canonicalJson(event)}\n`;
  return {
    job,
    jobText,
    profile,
    profileText,
    plan,
    planText,
    gatewayContract,
    gatewayContractText,
    gatewayDeployment,
    runtimeManifest,
    runtimeManifestText,
    event,
    observerEventText,
  };
}

function renderFixture(value = fixture(), nowMs = NOW + 1_000) {
  return renderLifecyclePreflightPlan({
    jobText: value.jobText,
    profileText: value.profileText,
    planText: value.planText,
    gatewayContractText: value.gatewayContractText,
    runtimeManifestText: value.runtimeManifestText,
    observerEventText: value.observerEventText,
    nowMs,
  });
}

function executionResult(command, options = {}) {
  return {
    command: structuredClone(command),
    exitCode: options.exitCode ?? 0,
    signal: null,
    timedOut: false,
    stdout: options.stdout ?? Buffer.from("validated\n"),
    stderr: options.stderr ?? Buffer.alloc(0),
  };
}

function runHarness(value = fixture(), overrides = {}) {
  const reads = new Map([
    [JOB_PATH, value.jobText],
    [value.job.hostProfilePath, value.profileText],
    [value.job.planPath, value.planText],
    [value.job.gatewayContractPath, value.gatewayContractText],
    [value.profile.artifacts.lifecycleRuntimeManifestPath, value.runtimeManifestText],
  ]);
  const existing = new Set(overrides.existing ?? []);
  const writes = new Map();
  const commands = [];
  const verifiedBindings = [];
  let current = NOW + 1_000;
  const dependencies = {
    platform: "linux",
    getuid: () => 0,
    env: {},
    runtimeIdentity: {
      nodePath: value.profile.executables.node.path,
      entrypointPath: value.profile.artifacts.lifecycleOrchestratorPath,
    },
    clock: async () => current++,
    read: async (path) => {
      if (!reads.has(path)) {
        const error = new Error(`missing read: ${path}`);
        error.code = "ENOENT";
        throw error;
      }
      return reads.get(path);
    },
    wait: async ({ path, timeoutMs, maxBytes }) => {
      assert.equal(path, value.job.lifecycleEventsPath);
      assert(timeoutMs > 0 && timeoutMs <= 15_000);
      assert(maxBytes >= Buffer.byteLength(value.observerEventText));
      return overrides.observerEventText ?? value.observerEventText;
    },
    exists: async (path) => existing.has(path),
    createDirectory: async (path, options) => {
      assert.equal(path, value.job.runtimeRootPath);
      assert.equal(options.mode, 0o700);
      if (existing.has(path)) throw new Error("already exists");
      existing.add(path);
    },
    write: async (path, text, options) => {
      assert.equal(options.mode, 0o600);
      if (writes.has(path)) throw new Error("write is not exclusive");
      writes.set(path, text);
      existing.add(path);
    },
    verifyRuntimeManifest: async (_manifest, options) => {
      assert.equal(options.manifestPath, value.profile.artifacts.lifecycleRuntimeManifestPath);
      assert.equal(options.expectedManifestDigest, value.profile.artifacts.lifecycleRuntimeManifestDigest);
      return { verified: true };
    },
    verifyFileBinding: async (binding) => {
      verifiedBindings.push(structuredClone(binding));
      return true;
    },
    executor: async (command) => {
      commands.push(structuredClone(command));
      if (overrides.executor) return overrides.executor(command, commands.length - 1);
      return executionResult(command);
    },
    ...overrides.dependencies,
  };
  return { dependencies, existing, writes, commands, verifiedBindings };
}

test("renders only the two fixed digest-bound native check commands", () => {
  const value = fixture();
  const plan = renderFixture(value);
  assert.deepEqual(plan.commands.map(({ tool, args }) => ({ tool, args })), [
    {
      tool: "envoy",
      args: ["--mode", "validate", "-c", `${value.job.runtimeRootPath}/envoy-config.json`],
    },
    {
      tool: "nft",
      args: ["-c", "-f", `${value.job.runtimeRootPath}/nftables-policy.nft`],
    },
  ]);
  assert(plan.commands.every(({ cwd, shell, env }) => cwd === "/" && shell === false && canonicalJson(env) === canonicalJson({ LANG: "C", LC_ALL: "C", TZ: "UTC" })));
  assert.equal(plan.toolBindings.envoy.digest, value.profile.executables.envoy.digest);
  assert.equal(plan.toolBindings.nft.digest, value.profile.executables.nft.digest);
  assert.equal(plan.toolBindings.node.digest, value.profile.executables.node.digest);
  assert.equal(plan.toolBindings.orchestrator.digest, value.profile.artifacts.lifecycleOrchestratorDigest);
  assert.equal(plan.observerReadiness.digest, sha256(Buffer.from(canonicalJson(value.event), "utf8")));
  assert.equal(plan.paths.lifecycleEventsPath, value.job.lifecycleEventsPath);
  assert.equal(plan.paths.lifecyclePreflightPath, value.job.lifecyclePreflightPath);
});

test("accepts only a fresh, exact, observer-first canonical readiness line", () => {
  const value = fixture();
  const expected = {
    jobId: value.job.jobId,
    planDigest: value.job.planDigest,
    hostProfileDigest: sha256(Buffer.from(value.profileText, "utf8")),
    runtimeManifestDigest: sha256(Buffer.from(value.runtimeManifestText, "utf8")),
    gatewayContractDigest: value.gatewayDeployment.digest,
    nowMs: NOW + 1_000,
    planCreatedAt: NOW,
    planExpiresAt: NOW + 600_000,
  };
  assert.equal(parseObserverReadinessEvent(value.observerEventText, expected).event.event, "observer_started");
  assert.throws(() => parseObserverReadinessEvent(`${value.observerEventText}\n`, expected), /one bounded/);

  const bad = structuredClone(value.event);
  bad.gatewayContractDigest = digest("substituted-gateway");
  assert.throws(() => parseObserverReadinessEvent(`${canonicalJson(bad)}\n`, expected), /substitutes/);

  const finished = buildLifecyclePreflightEvent({ ...eventInput(value), sequence: 2, event: "observer_finished" });
  assert.throws(() => parseObserverReadinessEvent(`${canonicalJson(finished)}\n`, expected), /observer-first/);

  const stale = buildLifecyclePreflightEvent({ ...eventInput(value), observedAt: NOW + 1_000 });
  assert.throws(() => parseObserverReadinessEvent(`${canonicalJson(stale)}\n`, { ...expected, nowMs: NOW + 40_001 }), /stale/);
});

test("rejects stale plans and canonical input or digest substitutions", () => {
  const value = fixture();
  assert.throws(() => renderFixture(value, value.plan.job.expiresAt), /stale/);
  assert.throws(() => renderLifecyclePreflightPlan({
    jobText: `${value.jobText}\n`,
    profileText: value.profileText,
    planText: value.planText,
    gatewayContractText: value.gatewayContractText,
    runtimeManifestText: value.runtimeManifestText,
    observerEventText: value.observerEventText,
    nowMs: NOW + 1_000,
  }), /canonical/);

  const changedProfile = structuredClone(value.profile);
  changedProfile.executables.envoy.digest = digest("changed-envoy");
  assert.throws(() => renderLifecyclePreflightPlan({
    jobText: value.jobText,
    profileText: canonicalJson(changedProfile),
    planText: value.planText,
    gatewayContractText: value.gatewayContractText,
    runtimeManifestText: value.runtimeManifestText,
    observerEventText: value.observerEventText,
    nowMs: NOW + 1_000,
  }));
});

test("runs the non-authorizing preflight and writes only exact configs and canonical result", async () => {
  const value = fixture();
  const harness = runHarness(value);
  const completed = await runLifecyclePreflight({ jobPath: JOB_PATH }, harness.dependencies);
  assert.deepEqual(harness.commands.map(({ path, args }) => ({ path, args })), [
    {
      path: value.profile.executables.envoy.path,
      args: ["--mode", "validate", "-c", `${value.job.runtimeRootPath}/envoy-config.json`],
    },
    {
      path: value.profile.executables.nft.path,
      args: ["-c", "-f", `${value.job.runtimeRootPath}/nftables-policy.nft`],
    },
  ]);
  assert.equal(harness.writes.size, 3);
  assert.equal(harness.writes.get(completed.plan.paths.envoyConfigPath), completed.plan.gatewayDeployment.envoyConfigJson);
  assert.equal(harness.writes.get(completed.plan.paths.nftablesPolicyPath), completed.plan.gatewayDeployment.nftablesPolicy);
  assert.equal(harness.writes.get(value.job.lifecyclePreflightPath), completed.canonicalJson);
  assert.equal(completed.result.filesystemArtifactsCreated, true);
  assert.equal(completed.result.gatewayLifecycleMutationPerformed, false);
  assert.equal(completed.result.releaseEvidenceEligible, false);
  assert.equal(completed.result.activationBlocked, true);
  assert.equal(completed.result.externalSigningEligible, false);
  assert.equal(completed.result.authorizationStatus, PREFLIGHT_AUTHORIZATION_STATUS);
  assert.equal(harness.verifiedBindings.length, 6, "the active runtime and each native executable are digest-verified at their use boundary");
  assert.deepEqual(parseCanonicalLifecyclePreflightResult(completed.canonicalJson, completed.plan).result, completed.result);
  assert.deepEqual(validateLifecyclePreflightResult(completed.result, completed.plan), completed.result);
});

test("fails closed on existing paths, command drift, failure, and oversized output", async () => {
  const value = fixture();
  const existing = runHarness(value, { existing: [value.job.runtimeRootPath] });
  await assert.rejects(() => runLifecyclePreflight({ jobPath: JOB_PATH }, existing.dependencies), /pre-existing/);

  const copiedEntrypoint = runHarness(value, {
    dependencies: {
      runtimeIdentity: {
        nodePath: value.profile.executables.node.path,
        entrypointPath: "/tmp/copied-run-gateway-lifecycle.mjs",
      },
    },
  });
  await assert.rejects(
    () => runLifecyclePreflight({ jobPath: JOB_PATH }, copiedEntrypoint.dependencies),
    /does not match the pinned Node and orchestrator paths/
  );

  const drift = runHarness(value, {
    executor: (command) => {
      const result = executionResult(command);
      result.command.args = ["-f", `${value.job.runtimeRootPath}/nftables-policy.nft`];
      return result;
    },
  });
  await assert.rejects(() => runLifecyclePreflight({ jobPath: JOB_PATH }, drift.dependencies), /command drift/);

  const nonzero = runHarness(value, { executor: (command) => executionResult(command, { exitCode: 1 }) });
  await assert.rejects(() => runLifecyclePreflight({ jobPath: JOB_PATH }, nonzero.dependencies), /failed closed/);

  const oversized = runHarness(value, { executor: (command) => executionResult(command, { stdout: Buffer.alloc(65 * 1024) }) });
  await assert.rejects(() => runLifecyclePreflight({ jobPath: JOB_PATH }, oversized.dependencies), /bounded limit/);
});

test("rejects non-Linux, non-root, credential, proxy, and preload environments before reads", async () => {
  const value = fixture();
  for (const dependencies of [
    { platform: "darwin", getuid: () => 0, env: {} },
    { platform: "linux", getuid: () => 1000, env: {} },
    { platform: "linux", getuid: () => 0, env: { GH_TOKEN: "secret" } },
    { platform: "linux", getuid: () => 0, env: { https_proxy: "http://proxy.invalid" } },
    { platform: "linux", getuid: () => 0, env: { LD_PRELOAD: "/tmp/hook.so" } },
  ]) {
    const harness = runHarness(value, { dependencies });
    await assert.rejects(() => runLifecyclePreflight({ jobPath: JOB_PATH }, harness.dependencies), /requires|forbidden/);
  }
});

function eventInput(value) {
  return {
    sequence: 1,
    event: "observer_started",
    jobId: value.event.jobId,
    planDigest: value.event.planDigest,
    hostProfileDigest: value.event.hostProfileDigest,
    runtimeManifestDigest: value.event.runtimeManifestDigest,
    gatewayContractDigest: value.event.gatewayContractDigest,
    observedAt: value.event.observedAt,
    evidenceDigest: value.event.evidenceDigest,
  };
}
