import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  canonicalJson,
  parseCanonicalPlan,
  sha256,
  validateHostProfile,
  validateJobDescriptor,
} from "./lib.mjs";
import {
  parseCanonicalLifecycleRuntimeManifest,
  runtimeManifestArtifact,
  verifyLifecycleRuntimeManifestFiles,
} from "./runtime-manifest.mjs";
import { renderLifecycleDrillContract } from "./lifecycle-drill.mjs";

export const PREFLIGHT_AUTHORIZATION_STATUS = "non_authorizing_linux_preflight_only";
export const PREFLIGHT_EVENT_KIND = "api_migrator_linux_l7_preflight_event";
export const PREFLIGHT_RESULT_KIND = "api_migrator_linux_l7_native_config_preflight";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const JOB_ID = /^previewjob_[a-f0-9]{64}$/;
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_NATIVE_OUTPUT_BYTES = 64 * 1024;
const NATIVE_COMMAND_TIMEOUT_MS = 15_000;
const OBSERVER_WAIT_TIMEOUT_MS = 15_000;
const MIN_PREFLIGHT_REMAINING_MS = 45_000;
const MAX_OBSERVER_EVENT_AGE_MS = 30_000;
const CHILD_ENVIRONMENT = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" });

const FORBIDDEN_ENVIRONMENT = new Set([
  "GH_TOKEN", "GITHUB_TOKEN", "GH_APP_ID", "GH_APP_PRIVATE_KEY", "GH_APP_PRIVATE_KEY_PATH",
  "GH_APP_INSTALLATION_ID", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID", "DATABASE_URL", "OPERATOR_APPROVAL_SECRET", "RUNNER_ATTESTATION_PRIVATE_KEY",
  "ATTESTATION_SIGNING_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTPS_PROXY", "NPM_CONFIG_USERCONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV",
  "PYTHONPATH", "PYTHONHOME", "SSH_AUTH_SOCK", "KUBECONFIG", "DOCKER_HOST", "CONTAINER_HOST",
]);

/** Fail before reading job-controlled bytes unless this is a credential-free Linux root process. */
export function assertLinuxRootPreflightHost(options = {}) {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? (typeof options.getuid === "function"
    ? options.getuid()
    : (typeof process.getuid === "function" ? process.getuid() : undefined));
  const env = options.env ?? process.env;
  if (platform !== "linux" || uid !== 0) {
    throw new Error("lifecycle preflight requires a Linux root process");
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("lifecycle preflight environment is invalid");
  }
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (
      FORBIDDEN_ENVIRONMENT.has(upper) ||
      /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)(?:_|$)/.test(upper) ||
      upper.endsWith("_PROXY") ||
      upper.includes("PRELOAD")
    ) {
      throw new Error(`lifecycle preflight environment contains forbidden material: ${name}`);
    }
  }
  return true;
}

/** Build either of the two fixed observer events without permitting authorizing fields. */
export function buildLifecyclePreflightEvent(input) {
  const root = record(input, "lifecycle preflight event input");
  exactKeys(root, [
    "sequence", "event", "jobId", "planDigest", "hostProfileDigest", "runtimeManifestDigest",
    "gatewayContractDigest", "observedAt", "evidenceDigest",
  ], "lifecycle preflight event input");
  const expectedEvent = root.sequence === 1 ? "observer_started" : root.sequence === 2 ? "observer_finished" : undefined;
  if (root.event !== expectedEvent) throw new Error("lifecycle preflight observer event sequence is invalid");
  return deepFreeze({
    schemaVersion: 1,
    kind: PREFLIGHT_EVENT_KIND,
    sequence: root.sequence,
    event: root.event,
    jobId: jobId(root.jobId, "observer event job id"),
    planDigest: digest(root.planDigest, "observer event plan digest"),
    hostProfileDigest: digest(root.hostProfileDigest, "observer event host profile digest"),
    runtimeManifestDigest: digest(root.runtimeManifestDigest, "observer event runtime manifest digest"),
    gatewayContractDigest: digest(root.gatewayContractDigest, "observer event gateway contract digest"),
    observedAt: timestamp(root.observedAt, "observer event timestamp"),
    evidenceDigest: digest(root.evidenceDigest, "observer event evidence digest"),
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: PREFLIGHT_AUTHORIZATION_STATUS,
  });
}

/** Validate the exact first observer line and bind its digest without the trailing newline. */
export function parseObserverReadinessEvent(text, expected) {
  if (
    typeof text !== "string" || !text.endsWith("\n") ||
    Buffer.byteLength(text, "utf8") === 1 || Buffer.byteLength(text, "utf8") > MAX_EVENT_BYTES ||
    text.slice(0, -1).includes("\n")
  ) {
    throw new Error("observer readiness must be one bounded newline-terminated event");
  }
  const line = text.slice(0, -1);
  const value = parseCanonicalObject(line, "observer readiness event", MAX_EVENT_BYTES);
  const event = validateLifecyclePreflightEvent(value);
  const root = record(expected, "observer readiness expectation");
  for (const [name, valueExpected] of [
    ["jobId", root.jobId],
    ["planDigest", root.planDigest],
    ["hostProfileDigest", root.hostProfileDigest],
    ["runtimeManifestDigest", root.runtimeManifestDigest],
    ["gatewayContractDigest", root.gatewayContractDigest],
  ]) {
    if (event[name] !== valueExpected) throw new Error(`observer readiness substitutes ${name}`);
  }
  if (event.sequence !== 1 || event.event !== "observer_started") {
    throw new Error("observer readiness is not the observer-first event");
  }
  const nowMs = timestamp(root.nowMs, "observer readiness validation time");
  const planCreatedAt = timestamp(root.planCreatedAt, "observer readiness plan creation");
  const planExpiresAt = timestamp(root.planExpiresAt, "observer readiness plan expiry");
  if (
    event.observedAt < planCreatedAt || event.observedAt > nowMs || event.observedAt >= planExpiresAt ||
    nowMs - event.observedAt > MAX_OBSERVER_EVENT_AGE_MS
  ) {
    throw new Error("observer readiness is stale or outside the plan lifetime");
  }
  return deepFreeze({
    event,
    canonicalJson: line,
    digest: sha256(Buffer.from(line, "utf8")),
  });
}

/**
 * Purely validate and cross-bind all canonical inputs, then render the two
 * check-only native command specifications. No filesystem or process action
 * occurs in this function.
 */
export function renderLifecyclePreflightPlan(input) {
  const root = record(input, "lifecycle preflight plan input");
  exactKeys(root, [
    "jobText", "profileText", "planText", "gatewayContractText", "runtimeManifestText",
    "observerEventText", "nowMs",
  ], "lifecycle preflight plan input");
  const nowMs = timestamp(root.nowMs, "lifecycle preflight clock");
  const jobValue = parseCanonicalObject(root.jobText, "deployment job descriptor", MAX_INPUT_BYTES);
  const profileValue = parseCanonicalObject(root.profileText, "runner host profile", MAX_INPUT_BYTES);
  const gatewayValue = parseCanonicalObject(root.gatewayContractText, "gateway contract", MAX_INPUT_BYTES);
  const job = validateJobDescriptor(jobValue);
  const profile = validateHostProfile(profileValue);
  const plan = parseCanonicalPlan(root.planText, job.planDigest, job.jobId);
  if (nowMs < plan.job.createdAt || nowMs >= plan.job.expiresAt || plan.job.expiresAt - nowMs < MIN_PREFLIGHT_REMAINING_MS) {
    throw new Error("runner plan is stale or has insufficient preflight lifetime");
  }

  const runtimeManifestRecord = parseCanonicalLifecycleRuntimeManifest(root.runtimeManifestText, profile);
  const runtimeManifest = runtimeManifestRecord.manifest ?? runtimeManifestRecord;
  const runtimeManifestDigest = runtimeManifestRecord.digest ?? sha256(Buffer.from(root.runtimeManifestText, "utf8"));
  if (runtimeManifestDigest !== profile.artifacts.lifecycleRuntimeManifestDigest) {
    throw new Error("runtime manifest digest does not match the host profile");
  }
  const deployment = renderLifecycleDrillContract({
    job,
    profile,
    planText: root.planText,
    gatewayContract: gatewayValue,
  });
  if (deployment.gatewayDeployment.canonicalJson !== root.gatewayContractText) {
    throw new Error("gateway contract is not exact normalized canonical JSON");
  }

  bindManifestArtifact(
    runtimeManifest,
    "lifecycle_orchestrator",
    profile.artifacts.lifecycleOrchestratorPath,
    profile.artifacts.lifecycleOrchestratorDigest
  );
  bindManifestArtifact(
    runtimeManifest,
    "lifecycle_observer",
    profile.artifacts.lifecycleObserverPath,
    profile.artifacts.lifecycleObserverDigest
  );

  const hostProfileDigest = sha256(Buffer.from(root.profileText, "utf8"));
  const observerReadiness = parseObserverReadinessEvent(root.observerEventText, {
    jobId: job.jobId,
    planDigest: job.planDigest,
    hostProfileDigest,
    runtimeManifestDigest,
    gatewayContractDigest: deployment.gatewayDeployment.digest,
    nowMs,
    planCreatedAt: plan.job.createdAt,
    planExpiresAt: plan.job.expiresAt,
  });
  const toolBindings = deepFreeze({
    node: structuredClone(profile.executables.node),
    orchestrator: {
      path: profile.artifacts.lifecycleOrchestratorPath,
      digest: profile.artifacts.lifecycleOrchestratorDigest,
    },
    envoy: structuredClone(profile.executables.envoy),
    nft: structuredClone(profile.executables.nft),
  });
  const toolBindingsDigest = sha256(Buffer.from(canonicalJson(toolBindings), "utf8"));
  const paths = deepFreeze({
    lifecycleEventsPath: job.lifecycleEventsPath,
    lifecyclePreflightPath: job.lifecyclePreflightPath,
    runtimeRootPath: job.runtimeRootPath,
    envoyConfigPath: join(job.runtimeRootPath, "envoy-config.json"),
    nftablesPolicyPath: join(job.runtimeRootPath, "nftables-policy.nft"),
  });
  if (
    dirname(paths.envoyConfigPath) !== job.runtimeRootPath ||
    dirname(paths.nftablesPolicyPath) !== job.runtimeRootPath
  ) {
    throw new Error("rendered preflight artifacts escape the exact runtime root");
  }
  const commands = deepFreeze([
    nativeCommand(
      "envoy_config_validation",
      "envoy",
      toolBindings.envoy,
      ["--mode", "validate", "-c", paths.envoyConfigPath]
    ),
    nativeCommand(
      "nftables_policy_check",
      "nft",
      toolBindings.nft,
      ["-c", "-f", paths.nftablesPolicyPath]
    ),
  ]);
  return deepFreeze({
    job,
    profile,
    plan,
    lifecycleContract: deployment,
    gatewayDeployment: deployment.gatewayDeployment,
    runtimeManifest,
    runtimeManifestDigest,
    hostProfileDigest,
    observerReadiness,
    toolBindings,
    toolBindingsDigest,
    paths,
    commands,
    plannedAt: nowMs,
  });
}

/** Validate a canonical result against the already rendered immutable plan. */
export function validateLifecyclePreflightResult(value, planInput) {
  const plan = record(planInput, "rendered lifecycle preflight plan");
  const root = record(value, "lifecycle preflight result");
  exactKeys(root, [
    "schemaVersion", "kind", "jobId", "planDigest", "hostId", "hostProfileDigest",
    "runtimeManifestDigest", "gatewayContractDigest", "envoyConfigDigest", "nftablesPolicyDigest",
    "toolBindings", "toolBindingsDigest", "observerReadinessDigest", "paths", "artifacts", "commands",
    "startedAt", "finishedAt", "status", "filesystemArtifactsCreated", "gatewayLifecycleMutationPerformed",
    "releaseEvidenceEligible", "activationBlocked", "externalSigningEligible", "authorizationStatus",
  ], "lifecycle preflight result");
  if (
    root.schemaVersion !== 1 || root.kind !== PREFLIGHT_RESULT_KIND || root.status !== "passed" ||
    root.filesystemArtifactsCreated !== true || root.gatewayLifecycleMutationPerformed !== false ||
    root.releaseEvidenceEligible !== false ||
    root.activationBlocked !== true || root.externalSigningEligible !== false ||
    root.authorizationStatus !== PREFLIGHT_AUTHORIZATION_STATUS
  ) {
    throw new Error("lifecycle preflight result cannot authorize activation, signing, or publication");
  }
  const expectedBindings = {
    jobId: plan.job.jobId,
    planDigest: plan.job.planDigest,
    hostId: plan.profile.hostId,
    hostProfileDigest: plan.hostProfileDigest,
    runtimeManifestDigest: plan.runtimeManifestDigest,
    gatewayContractDigest: plan.gatewayDeployment.digest,
    envoyConfigDigest: plan.gatewayDeployment.envoyConfigDigest,
    nftablesPolicyDigest: plan.gatewayDeployment.nftablesPolicyDigest,
    toolBindingsDigest: plan.toolBindingsDigest,
    observerReadinessDigest: plan.observerReadiness.digest,
  };
  for (const [name, expected] of Object.entries(expectedBindings)) {
    if (root[name] !== expected) throw new Error(`lifecycle preflight result substitutes ${name}`);
  }
  if (canonicalJson(root.toolBindings) !== canonicalJson(plan.toolBindings)) {
    throw new Error("lifecycle preflight result substitutes native tool bindings");
  }
  if (canonicalJson(root.paths) !== canonicalJson(plan.paths)) {
    throw new Error("lifecycle preflight result substitutes an exact lifecycle path");
  }
  const artifactsRoot = record(root.artifacts, "lifecycle preflight artifacts");
  exactKeys(artifactsRoot, ["envoyConfig", "nftablesPolicy"], "lifecycle preflight artifacts");
  const expectedArtifacts = {
    envoyConfig: { path: plan.paths.envoyConfigPath, digest: plan.gatewayDeployment.envoyConfigDigest },
    nftablesPolicy: { path: plan.paths.nftablesPolicyPath, digest: plan.gatewayDeployment.nftablesPolicyDigest },
  };
  if (canonicalJson(artifactsRoot) !== canonicalJson(expectedArtifacts)) {
    throw new Error("lifecycle preflight result substitutes rendered native artifacts");
  }
  const startedAt = timestamp(root.startedAt, "lifecycle preflight start");
  const finishedAt = timestamp(root.finishedAt, "lifecycle preflight finish");
  if (
    startedAt < plan.observerReadiness.event.observedAt || finishedAt < startedAt ||
    startedAt < plan.plan.job.createdAt || finishedAt >= plan.plan.job.expiresAt
  ) {
    throw new Error("lifecycle preflight result timeline is invalid or stale");
  }
  if (!Array.isArray(root.commands) || root.commands.length !== plan.commands.length) {
    throw new Error("lifecycle preflight native command results are incomplete");
  }
  let previousCommandFinishedAt = startedAt;
  const commands = root.commands.map((entry, index) => {
    const validated = validateCommandEvidence(entry, plan.commands[index], previousCommandFinishedAt, finishedAt);
    previousCommandFinishedAt = validated.finishedAt;
    return validated;
  });
  return deepFreeze({
    ...structuredClone(root),
    artifacts: expectedArtifacts,
    commands,
    startedAt,
    finishedAt,
  });
}

export function parseCanonicalLifecyclePreflightResult(text, plan) {
  const value = parseCanonicalObject(text, "lifecycle preflight result", MAX_RESULT_BYTES);
  const result = validateLifecyclePreflightResult(value, plan);
  const canonical = canonicalJson(result);
  if (canonical !== text) throw new Error("lifecycle preflight result is not exact canonical JSON");
  return deepFreeze({ result, canonicalJson: canonical, digest: sha256(Buffer.from(canonical, "utf8")) });
}

/** Execute the immutable check-only plan using fully injectable I/O boundaries. */
export async function runLifecyclePreflight(input, dependencies = {}) {
  const request = record(input, "lifecycle preflight run input");
  exactKeys(request, ["jobPath"], "lifecycle preflight run input");
  absolutePath(request.jobPath, "lifecycle preflight job path");
  assertLinuxRootPreflightHost({
    platform: dependencies.platform,
    getuid: dependencies.getuid,
    env: dependencies.env,
  });

  const clock = dependencies.clock ?? Date.now;
  const read = dependencies.read ?? defaultReadRootSealedFile;
  const wait = dependencies.wait ?? defaultWaitForObserver;
  const exists = dependencies.exists ?? defaultExists;
  const createDirectory = dependencies.createDirectory ?? defaultCreateDirectory;
  const write = dependencies.write ?? defaultWriteExclusive;
  const executor = dependencies.executor ?? defaultNativeExecutor;
  const verifyRuntimeManifest = dependencies.verifyRuntimeManifest ?? verifyLifecycleRuntimeManifestFiles;
  const verifyFileBinding = dependencies.verifyFileBinding ?? defaultVerifyFileBinding;

  const jobText = await read(request.jobPath, { label: "deployment job descriptor", maxBytes: MAX_INPUT_BYTES });
  const job = validateJobDescriptor(parseCanonicalObject(jobText, "deployment job descriptor", MAX_INPUT_BYTES));
  if (dirname(request.jobPath) !== dirname(job.planPath)) {
    throw new Error("deployment job descriptor must share the exact canonical job root");
  }
  const profileText = await read(job.hostProfilePath, { label: "runner host profile", maxBytes: MAX_INPUT_BYTES });
  const profile = validateHostProfile(parseCanonicalObject(profileText, "runner host profile", MAX_INPUT_BYTES));
  const runtimeIdentity = record(dependencies.runtimeIdentity, "lifecycle preflight runtime identity");
  exactKeys(runtimeIdentity, ["nodePath", "entrypointPath"], "lifecycle preflight runtime identity");
  if (
    runtimeIdentity.nodePath !== profile.executables.node.path ||
    runtimeIdentity.entrypointPath !== profile.artifacts.lifecycleOrchestratorPath
  ) {
    throw new Error("lifecycle preflight process does not match the pinned Node and orchestrator paths");
  }
  await verifyFileBinding(profile.executables.node);
  await verifyFileBinding({
    path: profile.artifacts.lifecycleOrchestratorPath,
    digest: profile.artifacts.lifecycleOrchestratorDigest,
  });
  const planText = await read(job.planPath, { label: "runner plan", maxBytes: MAX_INPUT_BYTES });
  const gatewayContractText = await read(job.gatewayContractPath, { label: "gateway contract", maxBytes: MAX_INPUT_BYTES });
  const runtimeManifestText = await read(profile.artifacts.lifecycleRuntimeManifestPath, {
    label: "lifecycle runtime manifest",
    maxBytes: MAX_INPUT_BYTES,
  });
  const parsedRuntimeManifest = parseCanonicalLifecycleRuntimeManifest(runtimeManifestText, profile);
  const runtimeManifest = parsedRuntimeManifest.manifest ?? parsedRuntimeManifest;
  const verifiedClosure = await verifyRuntimeManifest(runtimeManifest, {
    manifestPath: profile.artifacts.lifecycleRuntimeManifestPath,
    expectedManifestDigest: profile.artifacts.lifecycleRuntimeManifestDigest,
  });
  if (verifiedClosure === false || verifiedClosure?.verified === false) {
    throw new Error("lifecycle runtime manifest filesystem verification failed");
  }
  await verifyFileBinding(profile.executables.envoy);
  await verifyFileBinding(profile.executables.nft);

  if (await exists(job.runtimeRootPath) || await exists(job.lifecyclePreflightPath)) {
    throw new Error("lifecycle preflight refuses pre-existing runtime or result paths");
  }
  const initialNow = timestamp(await clock(), "lifecycle preflight initial clock");
  const planBeforeWait = parseCanonicalPlan(planText, job.planDigest, job.jobId);
  if (
    initialNow < planBeforeWait.job.createdAt || initialNow >= planBeforeWait.job.expiresAt ||
    planBeforeWait.job.expiresAt - initialNow < MIN_PREFLIGHT_REMAINING_MS
  ) {
    throw new Error("runner plan is stale before observer readiness");
  }
  const waitTimeoutMs = Math.min(OBSERVER_WAIT_TIMEOUT_MS, planBeforeWait.job.expiresAt - initialNow - 1);
  if (waitTimeoutMs <= 0) throw new Error("runner plan expired before observer readiness");
  const observerEventText = await wait({
    path: job.lifecycleEventsPath,
    timeoutMs: waitTimeoutMs,
    maxBytes: MAX_EVENT_BYTES,
    read,
    clock,
  });
  const plannedAt = timestamp(await clock(), "lifecycle preflight planning clock");
  const plan = renderLifecyclePreflightPlan({
    jobText,
    profileText,
    planText,
    gatewayContractText,
    runtimeManifestText,
    observerEventText,
    nowMs: plannedAt,
  });
  if (await exists(job.runtimeRootPath) || await exists(job.lifecyclePreflightPath)) {
    throw new Error("lifecycle preflight path appeared during observer readiness");
  }

  const startedAt = timestamp(await clock(), "lifecycle preflight start clock");
  assertWithinPlan(startedAt, plan, "lifecycle preflight start");
  if (startedAt < plannedAt) throw new Error("lifecycle preflight clock moved backwards before mutation");
  await createDirectory(job.runtimeRootPath, { mode: 0o700 });
  await write(plan.paths.envoyConfigPath, plan.gatewayDeployment.envoyConfigJson, { mode: 0o600 });
  await write(plan.paths.nftablesPolicyPath, plan.gatewayDeployment.nftablesPolicy, { mode: 0o600 });

  const commandEvidence = [];
  let previousCommandFinishedAt = startedAt;
  for (const command of plan.commands) {
    const commandStartedAt = timestamp(await clock(), `${command.name} start clock`);
    assertWithinPlan(commandStartedAt, plan, command.name);
    if (commandStartedAt < previousCommandFinishedAt) throw new Error("lifecycle preflight command clock moved backwards");
    await verifyFileBinding({ path: command.path, digest: command.digest });
    const raw = await executor(command);
    const commandFinishedAt = timestamp(await clock(), `${command.name} finish clock`);
    assertWithinPlan(commandFinishedAt, plan, command.name);
    if (commandFinishedAt < commandStartedAt) throw new Error("lifecycle preflight command clock moved backwards");
    commandEvidence.push(normalizeCommandExecution(raw, command, commandStartedAt, commandFinishedAt));
    previousCommandFinishedAt = commandFinishedAt;
  }
  const finishedAt = timestamp(await clock(), "lifecycle preflight finish clock");
  assertWithinPlan(finishedAt, plan, "lifecycle preflight finish");
  if (finishedAt < previousCommandFinishedAt) throw new Error("lifecycle preflight finish clock moved backwards");
  const result = validateLifecyclePreflightResult({
    schemaVersion: 1,
    kind: PREFLIGHT_RESULT_KIND,
    jobId: job.jobId,
    planDigest: job.planDigest,
    hostId: profile.hostId,
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
    commands: commandEvidence,
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
  const resultText = canonicalJson(result);
  await write(job.lifecyclePreflightPath, resultText, { mode: 0o600 });
  return deepFreeze({ plan, result, canonicalJson: resultText, digest: sha256(Buffer.from(resultText, "utf8")) });
}

function validateLifecyclePreflightEvent(value) {
  const root = record(value, "lifecycle preflight event");
  exactKeys(root, [
    "schemaVersion", "kind", "sequence", "event", "jobId", "planDigest", "hostProfileDigest",
    "runtimeManifestDigest", "gatewayContractDigest", "observedAt", "evidenceDigest",
    "releaseEvidenceEligible", "activationBlocked", "externalSigningEligible", "authorizationStatus",
  ], "lifecycle preflight event");
  if (
    root.schemaVersion !== 1 || root.kind !== PREFLIGHT_EVENT_KIND ||
    root.releaseEvidenceEligible !== false || root.activationBlocked !== true ||
    root.externalSigningEligible !== false || root.authorizationStatus !== PREFLIGHT_AUTHORIZATION_STATUS
  ) {
    throw new Error("lifecycle preflight observer event is unsupported or authorizing");
  }
  return buildLifecyclePreflightEvent({
    sequence: root.sequence,
    event: root.event,
    jobId: root.jobId,
    planDigest: root.planDigest,
    hostProfileDigest: root.hostProfileDigest,
    runtimeManifestDigest: root.runtimeManifestDigest,
    gatewayContractDigest: root.gatewayContractDigest,
    observedAt: root.observedAt,
    evidenceDigest: root.evidenceDigest,
  });
}

function nativeCommand(name, tool, binding, args) {
  return {
    name,
    tool,
    path: binding.path,
    digest: binding.digest,
    args,
    cwd: "/",
    env: structuredClone(CHILD_ENVIRONMENT),
    shell: false,
    timeoutMs: NATIVE_COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_NATIVE_OUTPUT_BYTES,
  };
}

function normalizeCommandExecution(value, expected, startedAt, finishedAt) {
  const root = record(value, `${expected.name} executor result`);
  exactKeys(root, ["command", "exitCode", "signal", "timedOut", "stdout", "stderr"], `${expected.name} executor result`);
  if (canonicalJson(root.command) !== canonicalJson(expected)) {
    throw new Error(`${expected.name} executor reported command drift`);
  }
  if (root.exitCode !== 0 || root.signal !== null || root.timedOut !== false) {
    throw new Error(`${expected.name} native validation failed closed`);
  }
  const stdout = bytes(root.stdout, `${expected.name} stdout`);
  const stderr = bytes(root.stderr, `${expected.name} stderr`);
  if (stdout.length > expected.maxOutputBytes || stderr.length > expected.maxOutputBytes) {
    throw new Error(`${expected.name} native output exceeds the bounded limit`);
  }
  return deepFreeze({
    name: expected.name,
    tool: expected.tool,
    path: expected.path,
    digest: expected.digest,
    args: [...expected.args],
    cwd: expected.cwd,
    environmentDigest: sha256(Buffer.from(canonicalJson(expected.env), "utf8")),
    shell: false,
    exitCode: 0,
    stdoutBytes: stdout.length,
    stdoutDigest: sha256(stdout),
    stderrBytes: stderr.length,
    stderrDigest: sha256(stderr),
    startedAt,
    finishedAt,
    status: "passed",
  });
}

function validateCommandEvidence(value, expected, runStartedAt, runFinishedAt) {
  const root = record(value, `${expected.name} command evidence`);
  exactKeys(root, [
    "name", "tool", "path", "digest", "args", "cwd", "environmentDigest", "shell", "exitCode",
    "stdoutBytes", "stdoutDigest", "stderrBytes", "stderrDigest", "startedAt", "finishedAt", "status",
  ], `${expected.name} command evidence`);
  const fixed = {
    name: expected.name,
    tool: expected.tool,
    path: expected.path,
    digest: expected.digest,
    args: expected.args,
    cwd: "/",
    environmentDigest: sha256(Buffer.from(canonicalJson(expected.env), "utf8")),
    shell: false,
    exitCode: 0,
    status: "passed",
  };
  for (const [name, expectedValue] of Object.entries(fixed)) {
    if (canonicalJson(root[name]) !== canonicalJson(expectedValue)) {
      throw new Error(`${expected.name} command evidence substitutes ${name}`);
    }
  }
  for (const name of ["stdoutBytes", "stderrBytes"]) {
    if (!Number.isSafeInteger(root[name]) || root[name] < 0 || root[name] > MAX_NATIVE_OUTPUT_BYTES) {
      throw new Error(`${expected.name} command output length is invalid`);
    }
  }
  digest(root.stdoutDigest, `${expected.name} stdout digest`);
  digest(root.stderrDigest, `${expected.name} stderr digest`);
  const startedAt = timestamp(root.startedAt, `${expected.name} start`);
  const finishedAt = timestamp(root.finishedAt, `${expected.name} finish`);
  if (startedAt < runStartedAt || finishedAt < startedAt || finishedAt > runFinishedAt) {
    throw new Error(`${expected.name} command timeline is invalid`);
  }
  return deepFreeze(structuredClone(root));
}

function bindManifestArtifact(manifest, role, path, expectedDigest) {
  const artifact = runtimeManifestArtifact(manifest, role);
  if (artifact.path !== path || artifact.digest !== expectedDigest) {
    throw new Error(`runtime manifest substitutes the ${role} profile binding`);
  }
}

function assertWithinPlan(nowMs, plan, label) {
  if (nowMs < plan.plan.job.createdAt || nowMs >= plan.plan.job.expiresAt) {
    throw new Error(`${label} occurred outside the canonical plan lifetime`);
  }
}

function parseCanonicalObject(text, label, maxBytes) {
  if (
    typeof text !== "string" || Buffer.byteLength(text, "utf8") === 0 ||
    Buffer.byteLength(text, "utf8") > maxBytes
  ) {
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

function bytes(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error(`${label} is not bytes`);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const fixed = [...expected].sort();
  if (actual.length !== fixed.length || actual.some((name, index) => name !== fixed[index])) {
    throw new Error(`${label} contains missing or unexpected fields`);
  }
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || !/^\/[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error(`${label} is not an exact absolute path`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function jobId(value, label) {
  if (typeof value !== "string" || !JOB_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8_640_000_000_000_000) {
    throw new Error(`${label} is invalid`);
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

async function defaultReadRootSealedFile(path, options = {}) {
  absolutePath(path, options.label ?? "input path");
  assertRootSealedAncestors(path, options.label ?? "input");
  const maxBytes = options.maxBytes ?? MAX_INPUT_BYTES;
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      info.size < 1 || info.size > maxBytes || realpathSync(path) !== path
    ) {
      throw new Error(`${options.label ?? "input"} is not a bounded root-sealed regular file`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

async function defaultWaitForObserver({ path, timeoutMs, maxBytes, read, clock }) {
  const startedAt = await clock();
  while (await clock() - startedAt <= timeoutMs) {
    try {
      return await read(path, { label: "observer readiness event", maxBytes });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("observer readiness event did not arrive within the bounded wait");
}

async function defaultExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function defaultCreateDirectory(path, options = {}) {
  absolutePath(path, "runtime root path");
  assertRootSealedDirectory(dirname(path), "runtime root parent");
  mkdirSync(path, { mode: options.mode ?? 0o700, recursive: false });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o777) !== 0o700) {
    throw new Error("created runtime root is not exact root-owned mode 0700");
  }
}

async function defaultWriteExclusive(path, contents, options = {}) {
  absolutePath(path, "preflight output path");
  if (typeof contents !== "string") throw new Error("preflight output must be exact text bytes");
  assertRootSealedDirectory(dirname(path), "preflight output parent");
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, options.mode ?? 0o600);
  try {
    writeFileSync(fd, contents, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function defaultVerifyFileBinding(binding) {
  const root = record(binding, "native executable binding");
  exactKeys(root, ["path", "digest"], "native executable binding");
  absolutePath(root.path, "native executable path");
  assertRootSealedAncestors(root.path, "native executable");
  digest(root.digest, "native executable digest");
  const info = lstatSync(root.path);
  if (
    !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0 ||
    (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0 || realpathSync(root.path) !== root.path
  ) {
    throw new Error("native executable is not an exact root-sealed file");
  }
  const actual = `sha256:${createHash("sha256").update(readFileSync(root.path)).digest("hex")}`;
  if (actual !== root.digest) throw new Error("native executable digest does not match the host profile");
  return true;
}

async function defaultNativeExecutor(command) {
  const result = spawnSync(command.path, command.args, {
    cwd: command.cwd,
    env: command.env,
    shell: false,
    encoding: null,
    timeout: command.timeoutMs,
    maxBuffer: command.maxOutputBytes,
    windowsHide: true,
  });
  if (result.error) {
    const reason = result.error.code === "ETIMEDOUT" ? "timed out" : "could not execute";
    throw new Error(`${command.name} ${reason}`);
  }
  return {
    command: structuredClone(command),
    exitCode: result.status,
    signal: result.signal,
    timedOut: false,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

function assertRootSealedDirectory(path, label) {
  const info = statSync(path);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 || realpathSync(path) !== path) {
    throw new Error(`${label} is not a canonical root-sealed directory`);
  }
  assertRootSealedAncestors(join(path, ".boundary"), label);
}

function assertRootSealedAncestors(path, label) {
  let ancestor = dirname(path);
  while (true) {
    const info = lstatSync(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 ||
        (info.mode & 0o022) !== 0 || realpathSync(ancestor) !== ancestor) {
      throw new Error(`${label} has an unsealed ancestor`);
    }
    if (ancestor === "/") break;
    ancestor = dirname(ancestor);
  }
}
