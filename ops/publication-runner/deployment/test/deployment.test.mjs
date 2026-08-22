import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildObservation,
  buildUnsignedSigningRequest,
  canonicalJson,
  computeNormalizedTreeDigest,
  computeRunnerOutputIdentity,
  deriveRunnerContainerSet,
  deriveRuntimeMaxMs,
  parseCanonicalPlan,
  parseRunnerResult,
  parseSystemdDurationUSec,
  parseWrapperEvents,
  sha256,
  validateHostProfile,
  validateJobDescriptor,
  validateL7IntegrationStatus,
  validateLiveSnapshot,
} from "../lib.mjs";
import {
  parseCanonicalDedicatedDrillAttemptReport,
  parseCanonicalDedicatedDrillHandoff,
} from "../dedicated-drill-handoff.mjs";
import { renderUnits } from "../render-units.mjs";

const DEPLOYMENT_DIR = resolve(new URL("..", import.meta.url).pathname);
const NOW = 2_000_000_000_000;
const EXPIRES = NOW + 600_000;
const JOB_ID = `previewjob_${"d".repeat(64)}`;
const INVOCATION = "0123456789abcdef0123456789abcdef";

function digest(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function deploymentSchemaValidator() {
  const validator = new Ajv2020({ allErrors: true, strict: true });
  for (const file of [
    "dedicated-drill-attempt-report.schema.json", "dedicated-drill-handoff.schema.json",
    "host-profile.schema.json", "job-descriptor.schema.json", "l7-integration-status.schema.json",
    "runner-observation.schema.json", "runtime-manifest.schema.json", "unsigned-signing-request.schema.json",
  ]) {
    validator.addSchema(JSON.parse(readFileSync(join(DEPLOYMENT_DIR, file), "utf8")));
  }
  return validator;
}

function wrapperTreeDigest(path) {
  const program = [
    "import hashlib,os,stat,sys",
    "root=os.path.realpath(sys.argv[1])",
    "digest=hashlib.sha256()",
    "for directory,names,files in os.walk(root,topdown=True,followlinks=False):",
    "  names.sort(key=os.fsencode)",
    "  files.sort(key=os.fsencode)",
    "  for name in [*names,*files]:",
    "    path=os.path.join(directory,name)",
    "    relative=os.path.relpath(path,root)",
    "    info=os.lstat(path)",
    "    encoded=os.fsencode(relative)",
    "    mode=stat.S_IMODE(info.st_mode)",
    "    kind=b'd' if stat.S_ISDIR(info.st_mode) else (b'x' if mode == 0o700 else b'f')",
    "    size=0 if kind == b'd' else info.st_size",
    "    digest.update(kind+len(encoded).to_bytes(4,'big')+encoded+size.to_bytes(8,'big'))",
    "    if kind in (b'f',b'x'):",
    "      digest.update(open(path,'rb').read())",
    "print('sha256:'+digest.hexdigest())",
  ].join("\n");
  const result = spawnSync("python3", ["-I", "-S", "-c", program, path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "api-migrator-deployment-test.")));
  const root = join(scratchRoot, "jobs", JOB_ID);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const outputPath = join(root, "output");
  mkdirSync(outputPath, { mode: 0o700 });
  mkdirSync(join(outputPath, "src"), { mode: 0o700 });
  writeFileSync(join(outputPath, "src", "index.ts"), "export const ok = true;\n", { mode: 0o600 });
  writeFileSync(join(outputPath, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(outputPath, 0o700);
  chmodSync(join(outputPath, "src"), 0o700);
  chmodSync(join(outputPath, "src", "index.ts"), 0o600);
  chmodSync(join(outputPath, "run.sh"), 0o700);

  const sourceBytes = Buffer.from("bounded source archive fixture", "utf8");
  const sourceDigest = sha256(sourceBytes);
  const profile = JSON.parse(readFileSync(join(DEPLOYMENT_DIR, "host-profile.example.json"), "utf8"));
  const plan = {
    schemaVersion: 1,
    profile: "disposable-egress-filtered-pilot-v1",
    job: {
      id: JOB_ID,
      nonceDigest: digest("nonce"),
      createdAt: NOW,
      expiresAt: EXPIRES,
      disposable: true,
    },
    subject: {
      pilotId: "pilot_sandbox_001",
      repository: { slug: "example/repo", id: 1, ownerId: 2 },
      base: { branch: "main", sha: "1".repeat(40) },
    },
    inputs: {
      sourceArchiveDigest: sourceDigest,
      manifestDigest: digest("manifest"),
      commandScopeDigest: digest("commands"),
    },
    imageDigest: profile.artifacts.imageDigest,
    egress: {
      enforcement: "host_nftables_output_exact_ip_tcp443",
      install: { policyDigest: digest("egress") },
    },
    execution: { credentials: "none" },
    teardown: { evidenceRequired: true },
  };
  const planText = canonicalJson(plan);
  const planDigest = sha256(Buffer.from(planText, "utf8"));
  const rawEventsPath = join(root, "events.ndjson");
  const job = {
    schemaVersion: 2,
    jobId: JOB_ID,
    unitRenderedAt: NOW,
    runtimeMaxMs: EXPIRES - NOW,
    planPath: join(root, "plan.json"),
    planDigest,
    sourceArchivePath: join(root, "source.tar"),
    outputPath,
    rawEventsPath,
    runnerResultPath: `${rawEventsPath}.runner.json`,
    hostProfilePath: join(scratchRoot, "host-profile.json"),
    runtimeRootPath: join(root, "orchestrator", "runtime"),
    lifecyclePreflightPath: join(root, "orchestrator", "lifecycle-preflight.json"),
    l7IntegrationStatusPath: join(root, "l7-integration-status.json"),
    gatewayContractPath: join(root, "gateway-contract.json"),
    gatewayReceiptPath: join(root, "gateway-receipt.json"),
    lifecycleEventsPath: join(root, "observer", "lifecycle-events.ndjson"),
    lifecycleReportPath: join(root, "observer", "lifecycle-report.json"),
    observationPath: join(root, "observation.json"),
    signingRequestPath: join(root, "signing-request.json"),
  };
  const runnerOutputIdentity = computeRunnerOutputIdentity(outputPath, plan.subject.base.sha);
  const result = {
    artifactDigest: digest("artifact"),
    candidateTreeSha: runnerOutputIdentity.candidateTreeSha,
    preflightId: `pf_${"2".repeat(64)}`,
  };
  const checks = Object.fromEntries(
    ["install", "typecheck", "test", "lint", "runtime"].map((name) => [name, {
      status: "passed",
      command: `trusted-${name}`,
      exitCode: 0,
    }])
  );
  const report = {
    entries: [],
    verification: {
      ok: true,
      skipped: false,
      checks: Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, {
        ...check,
        output: "",
      }])),
    },
    summary: { verified: true, review: 0 },
  };
  const runnerEvidence = {
    schemaVersion: 1,
    kind: "api-migrator-runner-evidence-v1",
    profile: "disposable-egress-filtered-pilot-v1",
    planDigest,
    jobId: JOB_ID,
    sourceArchiveDigest: sourceDigest,
    manifestDigest: plan.inputs.manifestDigest,
    commandScopeDigest: plan.inputs.commandScopeDigest,
    dependencyStateDigest: digest("dependency-state"),
    outputTreeDigest: runnerOutputIdentity.regularTreeDigest,
    output: result,
    targetBranch: `codex/api-migrator/fixture-${"4".repeat(64)}`,
    checks,
    report,
    reportDigest: sha256(Buffer.from(canonicalJson(report), "utf8")),
    blockers: [],
  };
  const resultText = canonicalJson(runnerEvidence);
  const treeDigest = computeNormalizedTreeDigest(outputPath);
  const details = {
    nftables_policy_installed: digest("nft-ruleset"),
    offline_preparation_started: "network-none+read-only-source",
    offline_preparation_finished: digest("preparation-log"),
    dependency_install_started: plan.egress.install.policyDigest,
    dependency_install_finished: digest("install-log"),
    offline_network_enforced: "podman-network-none+nft-empty-sets",
    offline_migration_started: "network-none+read-only-source",
    offline_migration_finished: digest("migration-log"),
    offline_verification_started: "typecheck,test,lint,runtime",
    offline_checks_finished: digest("checks-log"),
    output_ownership_revoked: treeDigest,
    offline_verification_finished: sha256(Buffer.from(resultText, "utf8")),
    output_sealed: result.artifactDigest,
    containers_destroyed: "status=0",
    podman_cleanup_observed: "status=0",
    nftables_policy_removed: "status=0",
    workspace_destroyed: "status=0",
    wrapper_teardown_complete: "raw-events-require-control-plane-signature",
  };
  const eventNames = Object.keys(details);
  const eventObjects = eventNames.map((event, index) => ({
    event,
    detail: details[event],
    jobId: JOB_ID,
    planDigest,
    systemdInvocation: INVOCATION,
    observedAt: NOW + (index + 1) * 1_000,
  }));
  const eventsText = `${eventObjects.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const l7IntegrationStatus = {
    schemaVersion: 1,
    kind: "api_migrator_l7_gateway_integration_status",
    jobId: JOB_ID,
    planDigest,
    gatewayProfile: "static-envoy-sni-passthrough-v1",
    targetOrigin: "registry.npmjs.org",
    integrationStatus: "not_wired",
    receiptValidation: "not_performed",
    liveActivation: "blocked",
    linuxLifecycleDrillRequired: true,
    blockReason: "forced_gateway_lifecycle_not_integrated",
  };
  const snapshot = {
    schemaVersion: 1,
    kind: "api_migrator_runner_live_snapshot",
    capturedAt: NOW + 20_000,
    systemd: {
      unitName: "api-migrator-runner.service",
      invocationId: INVOCATION,
      serviceType: "oneshot",
      remainAfterExit: true,
      activeState: "active",
      subState: "exited",
      result: "success",
      execMainCode: 1,
      execMainStatus: 0,
      killMode: "control-group",
      oomPolicy: "kill",
      delegate: true,
      timeoutStartUSec: (EXPIRES - NOW) * 1_000,
      timeoutStartFailureMode: "kill",
      timeoutStopUSec: 20_000_000,
      timeoutStopFailureMode: "kill",
      controlGroup: "/system.slice/api-migrator-runner.service",
      cgroupEmpty: true,
    },
    teardown: {
      runnerUidIdle: true,
      containersAbsent: true,
      networkNamespacesAbsent: true,
      nftablesTableAbsent: true,
      workspaceAbsent: true,
      observedAt: NOW + 19_000,
    },
  };
  writeFileSync(job.planPath, planText);
  writeFileSync(job.sourceArchivePath, sourceBytes);
  writeFileSync(job.hostProfilePath, JSON.stringify(profile));
  writeFileSync(job.l7IntegrationStatusPath, JSON.stringify(l7IntegrationStatus));
  writeFileSync(job.rawEventsPath, eventsText);
  writeFileSync(job.runnerResultPath, resultText);
  return {
    root,
    job,
    profile,
    plan,
    planText,
    result,
    runnerEvidence,
    resultText,
    sourceDigest,
    treeDigest,
    runnerOutputIdentity,
    eventObjects,
    eventsText,
    l7IntegrationStatus,
    snapshot,
    cleanup: () => rmSync(scratchRoot, { recursive: true, force: true }),
  };
}

function build(fx, overrides = {}) {
  return buildObservation({
    job: fx.job,
    profile: fx.profile,
    planText: fx.planText,
    eventsText: fx.eventsText,
    resultText: fx.resultText,
    sourceArchiveDigest: fx.sourceDigest,
    l7IntegrationStatus: fx.l7IntegrationStatus,
    snapshot: fx.snapshot,
    renderedAt: NOW,
    observationMode: "contract_fixture",
    outputTreeDigest: fx.treeDigest,
    ...overrides,
  });
}

test("validates all checked-in schemas, examples, and shell syntax", () => {
  const files = [
    "dedicated-drill-attempt-report.schema.json", "dedicated-drill-attempt-report.example.json",
    "dedicated-drill-handoff.schema.json", "dedicated-drill-handoff.example.json",
    "host-profile.schema.json", "host-profile.example.json", "job-descriptor.schema.json",
    "job-descriptor.example.json", "l7-integration-status.schema.json", "l7-integration-status.example.json",
    "runner-observation.schema.json", "runner-observation.example.json", "runtime-manifest.schema.json",
    "runtime-manifest.example.json", "unsigned-signing-request.schema.json",
  ];
  for (const file of files) assert.doesNotThrow(() => JSON.parse(readFileSync(join(DEPLOYMENT_DIR, file), "utf8")), file);
  const validator = deploymentSchemaValidator();
  for (const [schemaId, exampleFile] of [
    ["https://api-migrator.invalid/schemas/dedicated-drill-attempt-report-v1.json", "dedicated-drill-attempt-report.example.json"],
    ["https://api-migrator.invalid/schemas/dedicated-drill-handoff-v1.json", "dedicated-drill-handoff.example.json"],
    ["https://api-migrator.invalid/schemas/runner-host-profile-v2.json", "host-profile.example.json"],
    ["https://api-migrator.invalid/schemas/runner-deployment-job-v2.json", "job-descriptor.example.json"],
    ["https://api-migrator.invalid/schemas/l7-gateway-integration-status-v1.json", "l7-integration-status.example.json"],
    ["https://api-migrator.invalid/schemas/runner-observation-v1.json", "runner-observation.example.json"],
    ["https://api-migrator.invalid/schemas/linux-l7-runtime-manifest-v1.json", "runtime-manifest.example.json"],
  ]) {
    const example = JSON.parse(readFileSync(join(DEPLOYMENT_DIR, exampleFile), "utf8"));
    assert.equal(validator.validate(schemaId, example), true, validator.errorsText(validator.errors));
  }
  const handoffText = readFileSync(join(DEPLOYMENT_DIR, "dedicated-drill-handoff.example.json"), "utf8");
  const handoffRecord = parseCanonicalDedicatedDrillHandoff(handoffText);
  const reportText = readFileSync(join(DEPLOYMENT_DIR, "dedicated-drill-attempt-report.example.json"), "utf8");
  const reportRecord = parseCanonicalDedicatedDrillAttemptReport(reportText, handoffRecord);
  assert.equal(handoffText, canonicalJson(handoffRecord.handoff));
  assert.equal(reportText, canonicalJson(reportRecord.report));
  assert.equal(reportRecord.report.handoffDigest, handoffRecord.digest);
  assert.equal(reportRecord.report.attemptDigest, handoffRecord.handoff.attempts[0].attemptDigest);

  const handoffSchemaId = "https://api-migrator.invalid/schemas/dedicated-drill-handoff-v1.json";
  const reportSchemaId = "https://api-migrator.invalid/schemas/dedicated-drill-attempt-report-v1.json";
  const nestedExtension = structuredClone(reportRecord.report);
  nestedExtension.evidenceBundle.gatewayReceipt.unexpected = true;
  assert.equal(validator.validate(reportSchemaId, nestedExtension), false);
  const reorderedEventEvidence = structuredClone(reportRecord.report);
  [reorderedEventEvidence.evidenceBundle.eventEvidence[0], reorderedEventEvidence.evidenceBundle.eventEvidence[1]] =
    [reorderedEventEvidence.evidenceBundle.eventEvidence[1], reorderedEventEvidence.evidenceBundle.eventEvidence[0]];
  assert.equal(validator.validate(reportSchemaId, reorderedEventEvidence), false);
  const substitutedFaultEvidence = structuredClone(reportRecord.report);
  substitutedFaultEvidence.evidenceBundle.faultEvidence[0].name = "observation";
  assert.equal(validator.validate(reportSchemaId, substitutedFaultEvidence), false);
  const substitutedProofEvents = structuredClone(reportRecord.report);
  substitutedProofEvents.faultProof.stimulusEvent = "timeout_injected";
  substitutedProofEvents.faultProof.observationEvent = "timeout_observed";
  assert.equal(validator.validate(reportSchemaId, substitutedProofEvents), false);
  const crossScenarioModel = structuredClone(reportRecord.report);
  crossScenarioModel.faultProof.scenario = "wrong_sni";
  crossScenarioModel.faultProof.stimulusEvent = "wrong_sni_probe_started";
  crossScenarioModel.faultProof.observationEvent = "wrong_sni_observed";
  for (const event of crossScenarioModel.events) event.scenario = "wrong_sni";
  crossScenarioModel.events[9].event = "wrong_sni_probe_started";
  crossScenarioModel.events[10].event = "wrong_sni_observed";
  crossScenarioModel.evidenceBundle.eventEvidence[9].event = "wrong_sni_probe_started";
  crossScenarioModel.evidenceBundle.eventEvidence[10].event = "wrong_sni_observed";
  assert.equal(validator.validate(reportSchemaId, crossScenarioModel), false);
  const successWithProviderOperation = structuredClone(reportRecord.report);
  successWithProviderOperation.evidenceBundle.providerOperationReceipt = {
    digest: digest("substituted-provider-operation"),
    objectReference: "s3://example-api-migrator-evidence/substituted-provider-operation.json",
  };
  assert.equal(validator.validate(reportSchemaId, successWithProviderOperation), false);
  for (const invalidReference of [
    "https://localhost/evidence.json",
    "https://evidence.localhost/evidence.json",
    "https://127.0.0.2/evidence.json",
    "https://0.0.0.0/evidence.json",
    "https://evidence.example:443/evidence.json",
    "HTTPS://evidence.example/evidence.json",
    "https://Evidence.example/evidence.json",
    "https://evidence.example/a/../evidence.json",
    "https://evidence.example/%65vidence.json",
  ]) {
    const invalidHandoffReference = structuredClone(handoffRecord.handoff);
    invalidHandoffReference.evidenceSink.locationReference = invalidReference;
    assert.equal(validator.validate(handoffSchemaId, invalidHandoffReference), false, invalidReference);
    const invalidReportReference = structuredClone(reportRecord.report);
    invalidReportReference.evidenceBundle.gatewayReceipt.objectReference = invalidReference;
    assert.equal(validator.validate(reportSchemaId, invalidReportReference), false, invalidReference);
  }
  assert.doesNotThrow(() => validateHostProfile(JSON.parse(readFileSync(join(DEPLOYMENT_DIR, "host-profile.example.json"), "utf8"))));
  assert.doesNotThrow(() => validateJobDescriptor(JSON.parse(readFileSync(join(DEPLOYMENT_DIR, "job-descriptor.example.json"), "utf8"))));
  const shell = spawnSync("bash", ["-n", join(DEPLOYMENT_DIR, "cleanup-runner.sh")], { encoding: "utf8" });
  assert.equal(shell.status, 0, shell.stderr);
  const wrapperShell = spawnSync("bash", ["-n", join(DEPLOYMENT_DIR, "..", "run-credential-free-preview.sh")], {
    encoding: "utf8",
  });
  assert.equal(wrapperShell.status, 0, wrapperShell.stderr);
});

test("v2 host identities and exact job-root paths remain fail closed", () => {
  const fx = fixture();
  try {
    assert.equal(validateHostProfile(fx.profile).profile, "api-migrator-runner-host-v2");
    assert.equal(validateJobDescriptor(fx.job).schemaVersion, 2);

    const sameUid = structuredClone(fx.profile);
    sameUid.gateway.uid = sameUid.runner.uid;
    assert.throws(() => validateHostProfile(sameUid), /identities must be distinct/);
    const sameGid = structuredClone(fx.profile);
    sameGid.gateway.gid = sameGid.runner.gid;
    assert.throws(() => validateHostProfile(sameGid), /identities must be distinct/);
    const gatewayInSubuid = structuredClone(fx.profile);
    gatewayInSubuid.gateway.uid = gatewayInSubuid.runner.subuid.start;
    assert.throws(() => validateHostProfile(gatewayInSubuid), /outside the runner subordinate ID ranges/);
    const runnerInSubgid = structuredClone(fx.profile);
    runnerInSubgid.runner.gid = runnerInSubgid.runner.subgid.start;
    assert.throws(() => validateHostProfile(runnerInSubgid), /outside its subordinate ID ranges/);
    const privilegedListener = structuredClone(fx.profile);
    privilegedListener.gateway.listenerPort = 443;
    assert.throws(() => validateHostProfile(privilegedListener), /listener port is invalid/);
    const missingEnvoy = structuredClone(fx.profile);
    delete missingEnvoy.executables.envoy;
    assert.throws(() => validateHostProfile(missingEnvoy), /missing or unexpected fields/);
    const invalidProbeBinding = structuredClone(fx.profile);
    invalidProbeBinding.artifacts.gatewayProbePath = "/tmp/bad path";
    assert.throws(() => validateHostProfile(invalidProbeBinding), /supported absolute path/);

    assert.throws(
      () => validateJobDescriptor({ ...fx.job, schemaVersion: 1 }),
      /descriptor identity is invalid/
    );
    assert.throws(
      () => validateJobDescriptor({ ...fx.job, hostProfilePath: join(fx.root, "host-profile.json") }),
      /must remain external/
    );
    assert.throws(
      () => validateJobDescriptor({ ...fx.job, lifecycleReportPath: "/var/tmp/escaped-lifecycle-report.json" }),
      /escapes the exact job root/
    );
    assert.throws(
      () => validateJobDescriptor({ ...fx.job, gatewayReceiptPath: fx.job.lifecycleReportPath }),
      /paths must not overlap/
    );
    assert.throws(
      () => validateJobDescriptor({ ...fx.job, gatewayReceiptPath: `${fx.job.outputPath}/gateway.json` }),
      /paths must not overlap/
    );
    assert.throws(
      () => validateJobDescriptor({ ...fx.job, gatewayContractPath: fx.job.sourceArchivePath }),
      /paths must not overlap/
    );
    assert.throws(
      () => validateJobDescriptor({ ...fx.job, runtimeRootPath: fx.job.outputPath }),
      /paths must not overlap/
    );
    assert.throws(
      () => validateJobDescriptor({ ...fx.job, lifecyclePreflightPath: `${fx.job.runtimeRootPath}/preflight.json` }),
      /paths must not overlap/
    );
    assert.throws(
      () => validateJobDescriptor({ ...fx.job, runtimeRootPath: "/var/tmp/escaped-runtime" }),
      /escapes the exact job root/
    );
    assert.throws(
      () => validateJobDescriptor({
        ...fx.job,
        lifecyclePreflightPath: join(fx.root, "observer", "lifecycle-preflight.json"),
      }),
      /exact isolated orchestrator root/
    );
    assert.throws(
      () => validateJobDescriptor({
        ...fx.job,
        lifecycleEventsPath: join(fx.root, "orchestrator", "lifecycle-events.ndjson"),
      }),
      /exact isolated observer root/
    );
    assert.throws(
      () => validateJobDescriptor({
        ...fx.job,
        sourceArchivePath: join(fx.root, "orchestrator", "source.tar"),
      }),
      /enters a lifecycle service write boundary/
    );
    assert.throws(
      () => validateJobDescriptor({
        ...fx.job,
        outputPath: join(fx.root, "observer", "output"),
      }),
      /enters a lifecycle service write boundary/
    );
    assert.throws(
      () => validateJobDescriptor({ ...fx.job, planPath: "/tmp/job/plan.json" }),
      /deployment job root is too broad/
    );
  } finally {
    fx.cleanup();
  }
});

test("cleanup covers both job identities, subordinate UIDs, and exact policy tables", () => {
  const cleanup = readFileSync(join(DEPLOYMENT_DIR, "cleanup-runner.sh"), "utf8");
  assert.match(cleanup, /schema_version == 2/);
  assert.match(cleanup, /api_migrator_gw_/);
  assert.match(cleanup, /api_migrator_\$\{/);
  assert.match(cleanup, /pgrep -u "\$gateway_uid"/);
  assert.match(cleanup, /ps -e -o uid=/);
  assert.match(cleanup, /runner subordinate UID range still owns a process/);
  const policyLoop = cleanup.indexOf('for table in "$legacy_table" "$gateway_table"');
  const preRemovalCheck = cleanup.lastIndexOf("\nassert_job_boundary_idle\n", policyLoop);
  const policyRemoval = cleanup.indexOf('nft delete table inet "$table"');
  const postRemovalCheck = cleanup.indexOf("\nassert_job_boundary_idle\n", policyLoop);
  assert(policyLoop !== -1 && preRemovalCheck !== -1 && preRemovalCheck < policyLoop);
  assert(policyRemoval > policyLoop);
  assert(postRemovalCheck > policyRemoval);
});

test("reference wrapper keeps source out of the online mount and binds every phase digest", () => {
  const wrapper = readFileSync(resolve(DEPLOYMENT_DIR, "../run-credential-free-preview.sh"), "utf8");
  const installBlock = wrapper.slice(
    wrapper.indexOf('event "dependency_install_started"'),
    wrapper.indexOf('event "offline_network_enforced"')
  );
  assert.match(installBlock, /INSTALLATION_DIR:\/run\/api-migrator\/installation:rw/);
  assert.doesNotMatch(installBlock, /STAGED_SOURCE|DEPENDENCY_DIR:\/run\/api-migrator\/dependencies/);
  assert.match(installBlock, /--prepared-state-digest "\$PREPARED_STATE_DIGEST"/);
  assert.match(wrapper, /prepared_state_digest=\(sha256:\[a-f0-9\]\{64\}\)/);
  assert.match(wrapper, /install_state_digest=\(sha256:\[a-f0-9\]\{64\}\)/);
  assert.match(wrapper, /dependency_state_digest=\(sha256:\[a-f0-9\]\{64\}\)/);
  assert.match(wrapper, /\.dependencyStateDigest == \$dependencyStateDigest/);
  assert.match(wrapper, /RAW_RESULT_DIGEST == "\$REPORTED_EVIDENCE_DIGEST"/);
  assert.match(wrapper, /PREFLIGHT_ID == "\$REPORTED_PREFLIGHT_ID"/);
});

test("live observer activation is explicitly refused", () => {
  const result = spawnSync(process.execPath, [
    join(DEPLOYMENT_DIR, "observe-runner.mjs"),
    "--job", "/tmp/nonexistent-api-migrator-job.json",
    "--live",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /live runner observation is disabled until the forced gateway lifecycle is integrated and drilled/);
});

test("canonical JSON rejects ambiguous programmatic values exactly at the trust boundary", () => {
  assert.throws(() => canonicalJson(-0), /non-negative-zero/);
  assert.throws(() => canonicalJson("\ud800"), /unpaired high surrogate/);
  assert.throws(() => canonicalJson({ "\udc00": true }), /unpaired low surrogate/);

  const sparse = [];
  sparse.length = 1;
  assert.throws(() => canonicalJson(sparse), /sparse or extended arrays/);

  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
  assert.throws(() => canonicalJson(accessor), /accessors or hidden members/);

  const symbolic = { value: 1 };
  symbolic[Symbol("hidden")] = true;
  assert.throws(() => canonicalJson(symbolic), /hidden or symbolic members/);
});

test("renders a fixed serialized runner and separate no-network observer at the exact deadline", () => {
  const fx = fixture();
  try {
    const rendered = renderUnits({
      job: fx.job,
      profile: fx.profile,
      hostProfilePath: fx.job.hostProfilePath,
      planText: fx.planText,
      nowMs: NOW,
      jobDescriptorPath: join(fx.root, "job.json"),
    });
    assert.equal(rendered.serializedRunnerUnit, "api-migrator-runner.service");
    assert.equal(rendered.observerUnit, "api-migrator-runner-observer.service");
    assert.equal(rendered.runtimeMaxMs, EXPIRES - NOW);
    assert.equal(rendered.activationBlocked, true);
    assert.equal(rendered.externalSigningEligible, false);
    assert.equal(rendered.authorizationStatus, "blocked_pending_linux_gateway_lifecycle_drill");
    assert.match(rendered.runnerUnit, /Type=oneshot/);
    assert.match(rendered.runnerUnit, /RemainAfterExit=yes/);
    assert.match(rendered.runnerUnit, new RegExp(`TimeoutStartSec=${EXPIRES - NOW}ms`));
    assert.match(rendered.runnerUnit, /TimeoutStartFailureMode=kill/);
    assert.match(rendered.runnerUnit, /KillMode=control-group/);
    assert.match(rendered.runnerUnit, /OOMPolicy=kill/);
    assert.match(rendered.runnerUnit, /Delegate=yes/);
    assert.match(rendered.observerUnitDefinition, /PrivateNetwork=no/);
    assert.match(rendered.observerUnitDefinition, /IPAddressDeny=any/);
    assert.match(rendered.observerUnitDefinition, /RestrictAddressFamilies=AF_UNIX AF_NETLINK/);
    assert.match(rendered.observerUnitDefinition, /NoNewPrivileges=yes/);
    assert.doesNotMatch(`${rendered.runnerUnit}${rendered.observerUnitDefinition}`, /@[A-Z][A-Z0-9_]*@/);
    assert.doesNotMatch(`${rendered.runnerUnit}${rendered.observerUnitDefinition}`, /PRIVATE KEY|signature/i);
  } finally {
    fx.cleanup();
  }
});

test("deadline rendering rejects stale, short, and descriptor-divergent plans", () => {
  const fx = fixture();
  try {
    assert.equal(deriveRuntimeMaxMs(fx.plan, NOW), 600_000);
    assert.throws(() => deriveRuntimeMaxMs(fx.plan, EXPIRES), /not current/);
    assert.throws(() => deriveRuntimeMaxMs(fx.plan, EXPIRES - 29_999), /less than 30 seconds/);
    assert.throws(() => renderUnits({
      job: { ...fx.job, runtimeMaxMs: 599_999 },
      profile: fx.profile,
      hostProfilePath: fx.job.hostProfilePath,
      planText: fx.planText,
      nowMs: NOW,
      jobDescriptorPath: join(fx.root, "job.json"),
    }), /exact unit render time and deadline/);
    assert.throws(() => renderUnits({
      job: fx.job,
      profile: fx.profile,
      hostProfilePath: "/etc/api-migrator-runner/substituted-profile.json",
      planText: fx.planText,
      nowMs: NOW,
      jobDescriptorPath: join(fx.root, "job.json"),
    }), /host profile path does not match/);
    const jobPath = join(fx.root, "job.json");
    writeFileSync(jobPath, JSON.stringify(fx.job));
    const mismatchedCli = spawnSync(process.execPath, [
      join(DEPLOYMENT_DIR, "render-units.mjs"),
      "--job", jobPath,
      "--host-profile", "/etc/api-migrator-runner/substituted-profile.json",
      "--now-ms", String(NOW),
    ], { encoding: "utf8" });
    assert.equal(mismatchedCli.status, 1);
    assert.match(mismatchedCli.stderr, /--host-profile does not match the exact path/);
    assert.throws(() => validateJobDescriptor({ ...fx.job, outputPath: "/tmp/bad path" }), /absolute path/);
    assert.throws(
      () => validateJobDescriptor({ ...fx.job, planPath: "/tmp/job/plan.json" }),
      /deployment job root is too broad/
    );
    assert.throws(() => validateJobDescriptor({ ...fx.job, outputPath: "/var/tmp/escaped-output" }), /escapes the exact job root/);
  } finally {
    fx.cleanup();
  }
});

test("parses only exact canonical plan, wrapper event wire order, and result wire shape", () => {
  const fx = fixture();
  try {
    assert.equal(parseCanonicalPlan(fx.planText, fx.job.planDigest, JOB_ID).job.id, JOB_ID);
    assert.equal(parseWrapperEvents(fx.eventsText, {
      jobId: JOB_ID,
      planDigest: fx.job.planDigest,
      createdAt: NOW,
      expiresAt: EXPIRES,
      installEgressPolicyDigest: fx.plan.egress.install.policyDigest,
    }).invocationId, INVOCATION);
    assert.deepEqual(parseRunnerResult(fx.resultText).output, fx.result);
    assert.throws(() => parseCanonicalPlan(`${fx.planText}\n`, fx.job.planDigest, JOB_ID), /canonical JSON|digest/);
    assert.throws(() => parseRunnerResult(`${fx.resultText}\n`), /exact canonical bounded wire/);
    const reordered = [...fx.eventObjects];
    [reordered[3], reordered[4]] = [reordered[4], reordered[3]];
    assert.throws(() => parseWrapperEvents(`${reordered.map(JSON.stringify).join("\n")}\n`, {
      jobId: JOB_ID,
      planDigest: fx.job.planDigest,
      createdAt: NOW,
      expiresAt: EXPIRES,
      installEgressPolicyDigest: fx.plan.egress.install.policyDigest,
    }), /order diverged/);
    assert.throws(() => parseWrapperEvents(` ${fx.eventsText}`, {
      jobId: JOB_ID,
      planDigest: fx.job.planDigest,
      createdAt: NOW,
      expiresAt: EXPIRES,
      installEgressPolicyDigest: fx.plan.egress.install.policyDigest,
    }), /wire JSON|count/);
  } finally {
    fx.cleanup();
  }
});

test("normalized transfer hashing and runner output identities match exact fixtures", () => {
  const fx = fixture();
  try {
    assert.equal(computeNormalizedTreeDigest(fx.job.outputPath), fx.treeDigest);
    assert.equal(computeNormalizedTreeDigest(fx.job.outputPath), wrapperTreeDigest(fx.job.outputPath));
    assert.deepEqual(
      computeRunnerOutputIdentity(fx.job.outputPath, fx.plan.subject.base.sha),
      fx.runnerOutputIdentity
    );
    assert.equal(
      fx.runnerOutputIdentity.regularTreeDigest,
      "sha256:d475fe1dd0c9c64d80a5a59cc4b221cb4382f6294c5f62be53363778cd3aeddf"
    );
    assert.equal(fx.runnerOutputIdentity.candidateTreeSha, "b55bd74459befa8c12f4e8663a2c5150f641a49e");
    assert.equal(
      computeRunnerOutputIdentity(fx.job.outputPath, "1".repeat(64)).candidateTreeSha,
      "0503a9c2c8f8630626ea75b03f4edea1c3d5213349cdf79249a7223521df2f46"
    );
    chmodSync(join(fx.job.outputPath, "src", "index.ts"), 0o644);
    assert.throws(() => computeNormalizedTreeDigest(fx.job.outputPath), /metadata is not normalized/);
  } finally {
    fx.cleanup();
  }
});

test("produces only a keyless non-authorizing contract fixture", () => {
  const fx = fixture();
  try {
    const observation = build(fx);
    const built = buildUnsignedSigningRequest(observation);
    assert.equal(observation.observationMode, "contract_fixture");
    assert.equal(observation.teardown.workspaceAbsent, true);
    assert.equal(observation.execution.l7Gateway.integrationStatus, "not_wired");
    assert.equal(observation.execution.l7Gateway.receiptValidation, "not_performed");
    assert.equal(observation.execution.l7Gateway.liveActivation, "blocked");
    assert.equal(observation.execution.preparationLogDigest, digest("preparation-log"));
    assert.deepEqual(
      observation.execution.containerSet.map((entry) => entry.phase),
      ["offline_preparation", "dependency_install", "migration", "verification"]
    );
    assert.deepEqual(observation.execution.containerSet, deriveRunnerContainerSet(JOB_ID));
    assert.equal(
      observation.execution.containerSetDigest,
      sha256(Buffer.from(canonicalJson(observation.execution.containerSet), "utf8"))
    );
    assert.equal(built.request.unsigned, true);
    assert.equal(built.request.eligibleForExternalSigning, false);
    assert.equal(built.request.authorizationStatus, "blocked_pending_linux_gateway_lifecycle_drill");
    assert.equal(built.request.externalSignerVerificationRequired, true);
    assert.equal(built.request.observationDigest, sha256(Buffer.from(built.observationCanonicalJson, "utf8")));
    const validator = deploymentSchemaValidator();
    assert.equal(
      validator.validate("https://api-migrator.invalid/schemas/runner-unsigned-signing-request-v1.json", built.request),
      true,
      validator.errorsText(validator.errors)
    );
    assert.doesNotMatch(built.canonicalJson, /private.?key|"signature"|BEGIN [A-Z ]*PRIVATE KEY/i);
    assert.throws(() => build(fx, { observationMode: "live" }), /live runner observation is disabled/);
  } finally {
    fx.cleanup();
  }
});

test("refuses every incomplete independent teardown or weakened unit property", () => {
  const fx = fixture();
  try {
    const teardownKeys = ["runnerUidIdle", "containersAbsent", "networkNamespacesAbsent", "nftablesTableAbsent", "workspaceAbsent"];
    for (const key of teardownKeys) {
      const snapshot = structuredClone(fx.snapshot);
      snapshot.teardown[key] = false;
      assert.throws(() => build(fx, { snapshot }), /teardown snapshot is incomplete/, key);
    }
    for (const [key, value] of [
      ["killMode", "process"], ["oomPolicy", "continue"], ["delegate", false],
      ["cgroupEmpty", false], ["execMainStatus", 1], ["activeState", "failed"],
    ]) {
      const snapshot = structuredClone(fx.snapshot);
      snapshot.systemd[key] = value;
      assert.throws(() => build(fx, { snapshot }), /successful quiescent unit/, key);
    }
  } finally {
    fx.cleanup();
  }
});

test("refuses wrapper cleanup failure, output drift, and result substitution", () => {
  const fx = fixture();
  try {
    const failedEvents = structuredClone(fx.eventObjects);
    failedEvents.find((event) => event.event === "workspace_destroyed").detail = "status=1";
    assert.throws(() => build(fx, {
      eventsText: `${failedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    }), /did not report exact successful cleanup/);
    assert.throws(() => build(fx, { outputTreeDigest: digest("substituted-tree") }), /tree digest does not match/);
    const substitutedTree = structuredClone(fx.runnerEvidence);
    substitutedTree.outputTreeDigest = digest("substituted-runner-tree");
    assert.throws(
      () => build(fx, { resultText: canonicalJson(substitutedTree) }),
      /independently observed runner output tree digest/
    );
    const substitutedCandidate = structuredClone(fx.runnerEvidence);
    substitutedCandidate.output.candidateTreeSha = "3".repeat(40);
    assert.throws(
      () => build(fx, { resultText: canonicalJson(substitutedCandidate) }),
      /independently observed candidate Git tree/
    );
    const substituted = structuredClone(fx.runnerEvidence);
    substituted.output.artifactDigest = digest("substituted-artifact");
    const resultText = canonicalJson(substituted);
    assert.throws(() => build(fx, { resultText }), /runner result does not match/);
  } finally {
    fx.cleanup();
  }
});

test("accepts only the explicit blocked and unverified L7 integration status", () => {
  const fx = fixture();
  try {
    assert.doesNotThrow(() => validateL7IntegrationStatus(
      fx.l7IntegrationStatus,
      { jobId: JOB_ID, planDigest: fx.job.planDigest }
    ));
    for (const mutate of [
      (value) => { value.jobId = `previewjob_${"e".repeat(64)}`; },
      (value) => { value.integrationStatus = "wired"; },
      (value) => { value.receiptValidation = "passed"; },
      (value) => { value.liveActivation = "enabled"; },
      (value) => { value.linuxLifecycleDrillRequired = false; },
      (value) => { value.blockReason = "none"; },
    ]) {
      const l7IntegrationStatus = structuredClone(fx.l7IntegrationStatus);
      mutate(l7IntegrationStatus);
      assert.throws(() => build(fx, { l7IntegrationStatus }), /L7 gateway integration/);
    }
  } finally {
    fx.cleanup();
  }
});

test("snapshot validation binds invocation, activation deadline, and post-wrapper observation", () => {
  const fx = fixture();
  try {
    const expected = {
      invocationId: INVOCATION,
      renderedAt: NOW,
      expiresAt: EXPIRES,
      executionFinishedAt: NOW + 13_000,
    };
    assert.equal(validateLiveSnapshot(fx.snapshot, expected).systemd.invocationId, INVOCATION);
    const wrongInvocation = structuredClone(fx.snapshot);
    wrongInvocation.systemd.invocationId = "f".repeat(32);
    assert.throws(() => validateLiveSnapshot(wrongInvocation, expected), /successful quiescent unit/);
    const late = structuredClone(fx.snapshot);
    late.capturedAt = EXPIRES;
    late.teardown.observedAt = EXPIRES;
    assert.throws(() => validateLiveSnapshot(late, expected), /timeline is invalid/);
    const overlong = structuredClone(fx.snapshot);
    overlong.systemd.timeoutStartUSec += 1;
    assert.throws(() => validateLiveSnapshot(overlong, expected), /fail-closed limits/);
  } finally {
    fx.cleanup();
  }
});

test("parses only finite exact systemd duration output", () => {
  assert.equal(parseSystemdDurationUSec("10min"), 600_000_000);
  assert.equal(parseSystemdDurationUSec("1min 30s 500ms"), 90_500_000);
  assert.throws(() => parseSystemdDurationUSec("infinity"), /not finite/);
  assert.throws(() => parseSystemdDurationUSec("1.5s"), /unsupported/);
  assert.throws(() => parseSystemdDurationUSec("10 min"), /unsupported/);
});
