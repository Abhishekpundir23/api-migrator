import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import test from "node:test";

import { canonicalJson, sha256 } from "../lib.mjs";
import {
  PREFLIGHT_AUTHORIZATION_STATUS,
  renderLifecyclePreflightPlan,
  validateLifecyclePreflightResult,
} from "../lifecycle-preflight.mjs";
import {
  LIFECYCLE_OBSERVER_EVIDENCE_CLASS,
  appendExclusiveLifecycleEvent,
  collectLifecycleAbsenceEvidence,
  executeFixedReadOnlyOperation,
  loadLifecycleObserverContext,
  parseObserverArguments,
  readRootSealedInput,
  runIndependentNativeConfigValidation,
  runLifecyclePreflightObserver,
  verifyArtifactBinding,
  verifyObserverRuntimeIdentity,
} from "../observe-gateway-lifecycle.mjs";
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
  return {
    job,
    jobText,
    profile,
    profileText,
    plan,
    planText,
    gatewayContract,
    gatewayContractText,
    gatewayDeployment: renderGatewayDeployment(gatewayContract),
    runtimeManifest,
    runtimeManifestText,
    runtimeManifestDigest: sha256(Buffer.from(runtimeManifestText, "utf8")),
    hostProfileDigest: sha256(Buffer.from(profileText, "utf8")),
  };
}

function commandEvidence(command, startedAt, finishedAt) {
  return {
    name: command.name,
    tool: command.tool,
    path: command.path,
    digest: command.digest,
    args: [...command.args],
    cwd: command.cwd,
    environmentDigest: sha256(Buffer.from(canonicalJson(command.env), "utf8")),
    shell: false,
    exitCode: 0,
    stdoutBytes: 3,
    stdoutDigest: sha256(Buffer.from("ok\n")),
    stderrBytes: 0,
    stderrDigest: sha256(Buffer.alloc(0)),
    startedAt,
    finishedAt,
    status: "passed",
  };
}

function preflightResult(plan, startedAt) {
  const finishedAt = startedAt + 5;
  return validateLifecyclePreflightResult({
    schemaVersion: 1,
    kind: "api_migrator_linux_l7_native_config_preflight",
    jobId: plan.job.jobId,
    planDigest: plan.job.planDigest,
    hostId: plan.profile.hostId,
    hostProfileDigest: plan.hostProfileDigest,
    runtimeManifestDigest: plan.runtimeManifestDigest,
    gatewayContractDigest: plan.gatewayDeployment.digest,
    envoyConfigDigest: plan.gatewayDeployment.envoyConfigDigest,
    nftablesPolicyDigest: plan.gatewayDeployment.nftablesPolicyDigest,
    toolBindings: plan.toolBindings,
    toolBindingsDigest: plan.toolBindingsDigest,
    observerReadinessDigest: plan.observerReadiness.digest,
    paths: plan.paths,
    artifacts: {
      envoyConfig: { path: plan.paths.envoyConfigPath, digest: plan.gatewayDeployment.envoyConfigDigest },
      nftablesPolicy: { path: plan.paths.nftablesPolicyPath, digest: plan.gatewayDeployment.nftablesPolicyDigest },
    },
    commands: plan.commands.map((command, index) => commandEvidence(
      command,
      startedAt + 1 + index * 2,
      startedAt + 2 + index * 2
    )),
    startedAt,
    finishedAt,
    status: "passed",
    filesystemArtifactsCreated: true,
    gatewayLifecycleMutationPerformed: false,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: PREFLIGHT_AUTHORIZATION_STATUS,
  }, plan);
}

function emptyHostExecutor(requests = []) {
  return (request) => {
    requests.push(structuredClone(request));
    if (request.operation === "process_uid_snapshot") return { uids: [0, 1, 1000] };
    if (request.operation === "nft_list_tables") {
      return { stdout: '{"nftables":[{"metainfo":{"json_schema_version":1}}]}', stderr: "" };
    }
    return { stdout: "ok\n", stderr: "" };
  };
}

function runtimeIdentity(value) {
  return {
    schemaVersion: 1,
    kind: "api_migrator_linux_l7_observer_runtime_identity",
    node: structuredClone(value.profile.executables.node),
    observer: {
      path: value.profile.artifacts.lifecycleObserverPath,
      digest: value.profile.artifacts.lifecycleObserverDigest,
    },
    verified: true,
  };
}

function fileStat(overrides = {}) {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    dev: 1,
    ino: 2,
    uid: 0,
    mode: 0o100600,
    nlink: 1,
    size: 3,
    ...overrides,
  };
}

test("accepts only the exact absolute preflight CLI and keeps candidate units observer-first", () => {
  assert.deepEqual(parseObserverArguments(["--preflight", "--job", JOB_PATH]), {
    mode: "preflight",
    jobPath: JOB_PATH,
  });
  for (const argv of [
    ["--job", JOB_PATH, "--preflight"],
    ["--preflight", "--job", "job.json"],
    ["--preflight", "--job", `${JOB_ROOT}/../job.json`],
    ["--preflight", "--job", JOB_PATH, "--live"],
  ]) assert.throws(() => parseObserverArguments(argv));

  const observerUnit = readFileSync(new URL("../systemd/api-migrator-lifecycle-drill-observer.service.in", import.meta.url), "utf8");
  const drillUnit = readFileSync(new URL("../systemd/api-migrator-lifecycle-drill.service.in", import.meta.url), "utf8");
  assert.match(observerUnit, /Before=api-migrator-lifecycle-drill\.service/);
  assert.match(drillUnit, /Requires=api-migrator-lifecycle-drill-observer\.service/);
  assert.match(drillUnit, /After=api-migrator-lifecycle-drill-observer\.service/);
  assert.match(observerUnit, /IPAddressDeny=any/);
  assert.match(drillUnit, /IPAddressDeny=any/);
  assert.match(observerUnit, /ReadWritePaths=@LIFECYCLE_OBSERVER_ROOT@/);
  assert.match(drillUnit, /ReadWritePaths=@LIFECYCLE_ORCHESTRATOR_ROOT@/);
  assert.doesNotMatch(observerUnit + drillUnit, /GH_APP_PRIVATE_KEY_PATH=@|LoadCredential=/);
});

test("fixed executor never permits caller-supplied arguments, shell, cwd, or large output", () => {
  const calls = [];
  const result = executeFixedReadOnlyOperation({
    operation: "envoy_validate",
    executable: "/usr/bin/envoy",
    artifactPath: `${JOB_ROOT}/runtime/envoy-config.json`,
  }, {
    spawnSync: (path, args, options) => {
      calls.push({ path, args, options });
      return { status: 0, signal: null, error: undefined, stdout: "ok", stderr: "" };
    },
  });
  assert.deepEqual(result, { stdout: "ok", stderr: "" });
  assert.equal(calls[0].path, "/usr/bin/envoy");
  assert.deepEqual(calls[0].args, ["--mode", "validate", "-c", `${JOB_ROOT}/runtime/envoy-config.json`]);
  assert.equal(calls[0].options.cwd, "/");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.maxBuffer, 64 * 1024);
  assert.throws(() => executeFixedReadOnlyOperation({
    operation: "envoy_validate",
    executable: "/usr/bin/envoy",
    artifactPath: "relative.json",
  }));
});

test("root-sealed reader uses one no-follow descriptor and rejects permissions or mutation", () => {
  const path = `${JOB_ROOT}/plan.json`;
  const readWith = (stats) => {
    let index = 0;
    return readRootSealedInput(path, 10, "sealed test input", {
      openSync: (observedPath, flags) => {
        assert.equal(observedPath, path);
        assert.notEqual(flags & fsConstants.O_NOFOLLOW, 0, "O_NOFOLLOW must be set");
        return 7;
      },
      fstatSync: () => stats[Math.min(index++, stats.length - 1)],
      readSync: (_fd, buffer, offset) => {
        Buffer.from("abc").copy(buffer, offset);
        return 3;
      },
      realpathSync: () => path,
      closeSync: () => {},
    });
  };
  assert.equal(readWith([fileStat(), fileStat()]), "abc");
  assert.throws(() => readWith([fileStat({ uid: 1000 })]), /root-sealed/);
  assert.throws(() => readWith([fileStat(), fileStat({ ino: 3 })]), /changed during/);
  assert.throws(() => readWith([fileStat({ mode: 0o100622 })]), /root-sealed/);
});

test("native preflight artifacts require exact mode 0600", () => {
  const path = "/sealed/envoy-config.json";
  const bytes = Buffer.from("{}", "utf8");
  const binding = { path, digest: sha256(bytes), exactText: "{}" };
  const verifyWithMode = (mode) => verifyArtifactBinding(binding, {
    lstatSync: () => fileStat({ mode }),
    realpathSync: () => path,
    readFileSync: () => bytes,
  });

  assert.equal(verifyWithMode(0o100600), true);
  assert.throws(() => verifyWithMode(0o100400), /mode-0600/);
  assert.throws(() => verifyWithMode(0o100700), /mode-0600/);
});

test("event append reads, appends, fsyncs, and rechecks through one sealed descriptor", () => {
  const initial = '{"event":"observer_started"}\n';
  let bytes = Buffer.from(initial);
  let opens = 0;
  const dependencies = {
    openSync: (_path, flags) => {
      opens += 1;
      assert.notEqual(flags & fsConstants.O_NOFOLLOW, 0);
      assert.notEqual(flags & fsConstants.O_APPEND, 0);
      assert.notEqual(flags & fsConstants.O_RDWR, 0);
      return 9;
    },
    fstatSync: () => fileStat({ size: bytes.length, mode: 0o100600 }),
    readSync: (_fd, buffer, offset, length, position) => {
      const observed = bytes.subarray(position, position + length);
      observed.copy(buffer, offset);
      return observed.length;
    },
    writeSync: (_fd, input, offset, length) => {
      bytes = Buffer.concat([bytes, input.subarray(offset, offset + length)]);
      return length;
    },
    fsyncSync: () => {},
    closeSync: () => {},
  };
  appendExclusiveLifecycleEvent("/sealed/events.ndjson", initial, { sequence: 2, event: "observer_finished" }, dependencies);
  assert.equal(opens, 1);
  assert.equal(bytes.toString("utf8"), `${initial}{"event":"observer_finished","sequence":2}\n`);

  bytes = Buffer.from('{"event":"substituted"}\n');
  assert.throws(() => appendExclusiveLifecycleEvent(
    "/sealed/events.ndjson",
    initial,
    { sequence: 2, event: "observer_finished" },
    dependencies
  ), /root-owned|changed before/);
});

test("runtime identity must bind the exact pinned Node and observer artifacts", () => {
  const value = fixture();
  assert.deepEqual(
    verifyObserverRuntimeIdentity(value.profile, { runtimeIdentity: runtimeIdentity(value) }),
    runtimeIdentity(value)
  );
  const substituted = runtimeIdentity(value);
  substituted.observer.digest = digest("wrong-observer");
  assert.throws(() => verifyObserverRuntimeIdentity(value.profile, { runtimeIdentity: substituted }), /exact host binding/);
});

test("absence snapshot requires both tables and every dedicated UID range to be idle", () => {
  const value = fixture();
  const requests = [];
  const evidence = collectLifecycleAbsenceEvidence({
    profile: value.profile,
    gatewayDeployment: value.gatewayDeployment,
    observedAt: NOW + 1_000,
  }, {
    execute: emptyHostExecutor(requests),
    verifyExecutableBinding: () => true,
  });
  assert.equal(evidence.gatewayTableAbsent, true);
  assert.equal(evidence.legacyTableAbsent, true);
  assert.equal(evidence.runnerUidIdle, true);
  assert.equal(evidence.gatewayUidIdle, true);
  assert.equal(evidence.subuidRangeIdle, true);
  assert.equal(evidence.gatewayLifecycleMutationObserved, false);
  assert.deepEqual(requests.map(({ operation }) => operation), ["nft_list_tables", "process_uid_snapshot"]);

  const activeUid = (request) => request.operation === "process_uid_snapshot"
    ? { uids: [value.profile.runner.uid] }
    : { stdout: '{"nftables":[]}', stderr: "" };
  assert.throws(() => collectLifecycleAbsenceEvidence({
    profile: value.profile,
    gatewayDeployment: value.gatewayDeployment,
    observedAt: NOW + 1_000,
  }, { execute: activeUid, verifyExecutableBinding: () => true }), /not idle/);

  const existingTable = (request) => request.operation === "process_uid_snapshot"
    ? { uids: [] }
    : { stdout: canonicalJson({ nftables: [{ table: { family: "inet", name: value.gatewayDeployment.nftablesTable } }] }), stderr: "" };
  assert.throws(() => collectLifecycleAbsenceEvidence({
    profile: value.profile,
    gatewayDeployment: value.gatewayDeployment,
    observedAt: NOW + 1_000,
  }, { execute: existingTable, verifyExecutableBinding: () => true }), /table exists/);
});

test("independent native validation rechecks pinned executables and exact created artifacts", () => {
  const value = fixture();
  const initialEvidence = collectLifecycleAbsenceEvidence({
    profile: value.profile,
    gatewayDeployment: value.gatewayDeployment,
    observedAt: NOW + 999,
  }, { execute: emptyHostExecutor(), verifyExecutableBinding: () => true });
  const eventText = `${canonicalJson({
    schemaVersion: 1,
    kind: "api_migrator_linux_l7_preflight_event",
    sequence: 1,
    event: "observer_started",
    jobId: value.job.jobId,
    planDigest: value.job.planDigest,
    hostProfileDigest: value.hostProfileDigest,
    runtimeManifestDigest: value.runtimeManifestDigest,
    gatewayContractDigest: value.gatewayDeployment.digest,
    observedAt: initialEvidence.observedAt,
    evidenceDigest: sha256(Buffer.from(canonicalJson(initialEvidence), "utf8")),
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: PREFLIGHT_AUTHORIZATION_STATUS,
  })}\n`;
  const plan = renderLifecyclePreflightPlan({
    jobText: value.jobText,
    profileText: value.profileText,
    planText: value.planText,
    gatewayContractText: value.gatewayContractText,
    runtimeManifestText: value.runtimeManifestText,
    observerEventText: eventText,
    nowMs: NOW + 1_000,
  });
  const requests = [];
  const executableBindings = [];
  const artifactBindings = [];
  const evidence = runIndependentNativeConfigValidation({
    profile: value.profile,
    gatewayDeployment: value.gatewayDeployment,
    preflightPlan: plan,
    observedAt: NOW + 1_010,
  }, {
    execute: emptyHostExecutor(requests),
    verifyExecutableBinding: (binding) => executableBindings.push(structuredClone(binding)),
    verifyArtifactBinding: (binding) => artifactBindings.push(structuredClone(binding)),
  });
  assert.deepEqual(requests.map(({ operation, artifactPath }) => ({ operation, artifactPath })), [
    { operation: "envoy_validate", artifactPath: plan.paths.envoyConfigPath },
    { operation: "nft_check", artifactPath: plan.paths.nftablesPolicyPath },
  ]);
  assert.equal(executableBindings.length, 2);
  assert.equal(artifactBindings.length, 4, "each exact artifact is checked before and after native execution");
  assert.equal(evidence.filesystemArtifactsObserved, true);
  assert.equal(evidence.gatewayLifecycleMutationObserved, false);
});

test("loads all canonical bindings and verifies the deployed runtime closure", () => {
  const value = fixture();
  const reads = new Map([
    [JOB_PATH, value.jobText],
    [value.job.hostProfilePath, value.profileText],
    [value.job.planPath, value.planText],
    [value.job.gatewayContractPath, value.gatewayContractText],
    [value.profile.artifacts.lifecycleRuntimeManifestPath, value.runtimeManifestText],
  ]);
  let closureOptions;
  const context = loadLifecycleObserverContext(JOB_PATH, {
    readRootSealedInput: (path) => reads.get(path),
    runtimeIdentity: runtimeIdentity(value),
    verifyRuntimeManifestFilesystem: (_manifest, options) => {
      closureOptions = options;
      return { verified: true };
    },
  });
  assert.equal(context.job.jobId, value.job.jobId);
  assert.equal(context.gatewayDeployment.digest, value.gatewayDeployment.digest);
  assert.equal(context.runtimeManifestDigest, value.runtimeManifestDigest);
  assert.equal(context.hostProfileDigest, value.hostProfileDigest);
  assert.equal(context.jobText, value.jobText);
  assert.equal(closureOptions.manifestPath, value.profile.artifacts.lifecycleRuntimeManifestPath);
  assert.equal(closureOptions.expectedManifestDigest, value.runtimeManifestDigest);

  const noncanonical = new Map(reads);
  noncanonical.set(JOB_PATH, `${value.jobText}\n`);
  assert.throws(() => loadLifecycleObserverContext(JOB_PATH, {
    readRootSealedInput: (path) => noncanonical.get(path),
    runtimeIdentity: runtimeIdentity(value),
    verifyRuntimeManifestFilesystem: () => ({ verified: true }),
  }), /canonical/);
});

test("observer owns exact two-event stream and permanently non-authorizing report", async () => {
  const value = fixture();
  const requests = [];
  let eventsText;
  let reportText;
  let clock = NOW + 1_000;
  const context = {
    job: value.job,
    profile: value.profile,
    plan: value.plan,
    gatewayDeployment: value.gatewayDeployment,
    runtimeManifest: value.runtimeManifest,
    runtimeManifestDigest: value.runtimeManifestDigest,
    hostProfileDigest: value.hostProfileDigest,
    jobText: value.jobText,
    profileText: value.profileText,
    planText: value.planText,
    gatewayContractText: value.gatewayContractText,
    runtimeManifestText: value.runtimeManifestText,
    runtimeIdentity: runtimeIdentity(value),
  };
  const completed = await runLifecyclePreflightObserver(context, {
    now: () => clock++,
    existsSync: () => false,
    execute: emptyHostExecutor(requests),
    verifyExecutableBinding: () => true,
    verifyArtifactBinding: () => true,
    writeExclusiveEvidence: (path, text) => {
      if (path === value.job.lifecycleEventsPath) eventsText = text;
      else if (path === value.job.lifecycleReportPath) reportText = text;
      else throw new Error(`unexpected observer output: ${path}`);
    },
    appendExclusiveLifecycleEvent: (_path, expectedText, event) => {
      assert.equal(eventsText, expectedText);
      eventsText += `${canonicalJson(event)}\n`;
    },
    waitForLifecyclePreflight: async () => {
      const plan = renderLifecyclePreflightPlan({
        jobText: value.jobText,
        profileText: value.profileText,
        planText: value.planText,
        gatewayContractText: value.gatewayContractText,
        runtimeManifestText: value.runtimeManifestText,
        observerEventText: eventsText,
        nowMs: clock,
      });
      const result = preflightResult(plan, NOW + 1_002);
      clock = result.finishedAt + 1;
      return canonicalJson(result);
    },
  });
  assert.equal(eventsText.split("\n").filter(Boolean).length, 2);
  assert.equal(reportText, canonicalJson(completed.report));
  assert.equal(completed.report.evidenceClass, LIFECYCLE_OBSERVER_EVIDENCE_CLASS);
  assert.equal(completed.report.filesystemArtifactsObserved, true);
  assert.equal(completed.report.gatewayLifecycleMutationObserved, false);
  assert.equal(completed.report.releaseEvidenceEligible, false);
  assert.equal(completed.report.activationBlocked, true);
  assert.equal(completed.report.externalSigningEligible, false);
  assert.equal(completed.report.authorizationStatus, PREFLIGHT_AUTHORIZATION_STATUS);
  assert.equal(completed.report.status, "passed");
  assert.deepEqual(requests.map(({ operation }) => operation), [
    "nft_list_tables", "process_uid_snapshot", "envoy_validate", "nft_check",
    "nft_list_tables", "process_uid_snapshot",
  ]);

  const substituted = structuredClone(completed.report.initialAbsenceEvidence);
  substituted.runnerUidIdle = false;
  assert.equal(substituted.runnerUidIdle, false, "report evidence is immutable only after validation, not by clone identity");
});
