#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  parseCanonicalPlan,
  parseJson,
  sha256,
  validateHostProfile,
  validateJobDescriptor,
  writeExclusiveEvidence,
} from "./lib.mjs";
import {
  renderGatewayDeployment,
  validateGatewayDeploymentRecord,
} from "../gateway/gateway-contract.mjs";
import {
  parseCanonicalRuntimeManifest,
  validateRuntimeManifest,
  verifyRuntimeManifestFilesystem,
} from "./runtime-manifest.mjs";
import {
  PREFLIGHT_AUTHORIZATION_STATUS,
  assertLinuxRootPreflightHost,
  buildLifecyclePreflightEvent,
  parseCanonicalLifecyclePreflightResult,
  renderLifecyclePreflightPlan,
  validateLifecyclePreflightResult,
} from "./lifecycle-preflight.mjs";

export const LIFECYCLE_OBSERVER_REPORT_KIND = "api_migrator_linux_l7_preflight_observer_report";
export const LIFECYCLE_OBSERVER_EVIDENCE_CLASS = "non_authorizing_native_config_preflight";

const MAX_JOB_BYTES = 32 * 1024;
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_PROFILE_BYTES = 128 * 1024;
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_GATEWAY_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PREFLIGHT_BYTES = 256 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_WAIT_MS = 60_000;
const DEFAULT_POLL_MS = 25;
const SAFE_COMMAND_ENV = Object.freeze({
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
});

const FIXED_STATIC_ARGUMENTS = deepFreeze({
  nft_list_tables: ["-j", "list", "tables"],
});

/** Parse only the intentionally narrow non-authorizing CLI. */
export function parseObserverArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== "--preflight" || argv[1] !== "--job") {
    throw new Error("usage: observe-gateway-lifecycle.mjs --preflight --job ABSOLUTE_PATH");
  }
  const jobPath = argv[2];
  if (typeof jobPath !== "string" || !isAbsolute(jobPath) || resolve(jobPath) !== jobPath) {
    throw new Error("lifecycle observer job path must be canonical and absolute");
  }
  return Object.freeze({ mode: "preflight", jobPath });
}

/** Read one stable, root-sealed input through a single O_NOFOLLOW descriptor. */
export function readRootSealedInput(path, maxBytes, label, dependencies = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_INPUT_BYTES ||
      typeof label !== "string" || label.length === 0) {
    throw new Error("root-sealed input request is invalid");
  }
  const open = dependencies.openSync ?? openSync;
  const fstat = dependencies.fstatSync ?? fstatSync;
  const read = dependencies.readSync ?? readSync;
  const realpath = dependencies.realpathSync ?? realpathSync;
  const close = dependencies.closeSync ?? closeSync;
  const fd = open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstat(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || (before.mode & 0o022) !== 0 ||
        before.size < 1 || before.size > maxBytes || realpath(path) !== path) {
      throw new Error(`${label} is not a bounded root-sealed regular file`);
    }
    const bytes = readExactFd(fd, before.size, read);
    const after = fstat(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.nlink !== 1 || after.uid !== 0 || (after.mode & 0o022) !== 0 || realpath(path) !== path) {
      throw new Error(`${label} changed during its exact read`);
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`${label} is not exact UTF-8`);
    return text;
  } finally {
    close(fd);
  }
}

/**
 * Execute one of four fixed read-only observations/checks. The public request
 * is deliberately an operation name rather than a caller-supplied command.
 */
export function executeFixedReadOnlyOperation(request, dependencies = {}) {
  const root = plainRecord(request, "fixed read-only operation");
  const operation = root.operation;
  if (operation === "process_uid_snapshot") {
    exactKeys(root, ["operation"], "process UID snapshot request");
    const list = dependencies.readdirSync ?? readdirSync;
    const stat = dependencies.statSync ?? statSync;
    const uids = [];
    for (const name of list("/proc")) {
      if (!/^[1-9][0-9]*$/.test(name)) continue;
      try {
        const uid = stat(`/proc/${name}`).uid;
        if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("process UID snapshot is invalid");
        uids.push(uid);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return deepFreeze({ uids: [...new Set(uids)].sort((left, right) => left - right) });
  }

  exactKeys(root, ["operation", "executable", "artifactPath"], "native read-only command request");
  if (!["nft_list_tables", "envoy_validate", "nft_check"].includes(operation)) {
    throw new Error("native read-only operation is unsupported");
  }
  if (typeof root.executable !== "string" || !isAbsolute(root.executable) || resolve(root.executable) !== root.executable) {
    throw new Error("native read-only executable path is invalid");
  }
  if (operation === "nft_list_tables" && root.artifactPath !== null) {
    throw new Error("nft table observation cannot receive an artifact path");
  }
  if (operation !== "nft_list_tables" &&
      (typeof root.artifactPath !== "string" || !isAbsolute(root.artifactPath) || resolve(root.artifactPath) !== root.artifactPath)) {
    throw new Error("native config validation artifact path is invalid");
  }
  const args = operation === "nft_list_tables"
    ? FIXED_STATIC_ARGUMENTS.nft_list_tables
    : operation === "envoy_validate"
      ? ["--mode", "validate", "-c", root.artifactPath]
      : ["-c", "-f", root.artifactPath];
  const spawn = dependencies.spawnSync ?? spawnSync;
  const result = spawn(root.executable, args, {
    cwd: "/",
    encoding: "utf8",
    env: SAFE_COMMAND_ENV,
    maxBuffer: MAX_COMMAND_BYTES,
    shell: false,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(`native read-only operation failed: ${operation}`);
  }
  const stdout = boundedCommandText(result.stdout, `${operation} stdout`);
  const stderr = boundedCommandText(result.stderr, `${operation} stderr`);
  return deepFreeze({ stdout, stderr });
}

/**
 * Prove that neither job table nor any dedicated job identity is active.
 * This is raw local preflight evidence only and can never authorize release.
 */
export function collectLifecycleAbsenceEvidence(input, dependencies = {}) {
  const root = plainRecord(input, "lifecycle absence input");
  exactKeys(root, ["profile", "gatewayDeployment", "observedAt"], "lifecycle absence input");
  const profile = validateHostProfile(root.profile);
  const gateway = validateGatewayDeploymentRecord(root.gatewayDeployment);
  const observedAt = timestamp(root.observedAt, "lifecycle absence observation");
  const execute = dependencies.execute ?? executeFixedReadOnlyOperation;
  const verifyExecutable = dependencies.verifyExecutableBinding ?? verifyExecutableBinding;
  verifyExecutable(profile.executables.nft);
  const nftResult = normalizeCommandResult(execute({
    operation: "nft_list_tables",
    executable: profile.executables.nft.path,
    artifactPath: null,
  }), "nft table observation");
  const nftTables = parseNftTableSnapshot(nftResult.stdout);
  const processResult = normalizeProcessResult(execute({ operation: "process_uid_snapshot" }));
  const processUids = processResult.uids;
  const legacyTable = `api_migrator_${gateway.contract.jobId.slice(11, 27)}`;
  const gatewayTable = gateway.nftablesTable;
  const namedTables = new Set(nftTables.map(({ family, name }) => `${family}:${name}`));
  const subuidStart = profile.runner.subuid.start;
  const subuidEnd = subuidStart + profile.runner.subuid.count - 1;
  const gatewayTableAbsent = !namedTables.has(`inet:${gatewayTable}`);
  const legacyTableAbsent = !namedTables.has(`inet:${legacyTable}`);
  const runnerUidIdle = !processUids.includes(profile.runner.uid);
  const gatewayUidIdle = !processUids.includes(profile.gateway.uid);
  const subuidRangeIdle = !processUids.some((uid) => uid >= subuidStart && uid <= subuidEnd);
  if (!gatewayTableAbsent || !legacyTableAbsent) {
    throw new Error("job nftables table exists before or after native-config preflight");
  }
  if (!runnerUidIdle || !gatewayUidIdle || !subuidRangeIdle) {
    throw new Error("a dedicated lifecycle identity is not idle");
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: "api_migrator_linux_l7_preflight_absence_snapshot",
    jobId: gateway.contract.jobId,
    observedAt,
    gatewayTable,
    legacyTable,
    runnerUid: profile.runner.uid,
    gatewayUid: profile.gateway.uid,
    subuidStart,
    subuidEnd,
    nftTablesSnapshotDigest: sha256(Buffer.from(nftResult.stdout, "utf8")),
    processUidsSnapshotDigest: sha256(Buffer.from(canonicalJson(processUids), "utf8")),
    gatewayTableAbsent: true,
    legacyTableAbsent: true,
    runnerUidIdle: true,
    gatewayUidIdle: true,
    subuidRangeIdle: true,
    gatewayLifecycleMutationObserved: false,
  });
}

/** Independently repeat the two native check-only validations. */
export function runIndependentNativeConfigValidation(input, dependencies = {}) {
  const root = plainRecord(input, "independent native validation input");
  exactKeys(root, ["profile", "gatewayDeployment", "preflightPlan", "observedAt"], "independent native validation input");
  const profile = validateHostProfile(root.profile);
  const gateway = validateGatewayDeploymentRecord(root.gatewayDeployment);
  const plan = plainRecord(root.preflightPlan, "rendered lifecycle preflight plan");
  const observedAt = timestamp(root.observedAt, "independent native validation observation");
  const execute = dependencies.execute ?? executeFixedReadOnlyOperation;
  const verifyExecutable = dependencies.verifyExecutableBinding ?? verifyExecutableBinding;
  const verifyArtifact = dependencies.verifyArtifactBinding ?? verifyArtifactBinding;
  if (plan.gatewayDeployment.digest !== gateway.digest || plan.profile.hostId !== profile.hostId ||
      plan.paths.envoyConfigPath !== `${plan.job.runtimeRootPath}/envoy-config.json` ||
      plan.paths.nftablesPolicyPath !== `${plan.job.runtimeRootPath}/nftables-policy.nft`) {
    throw new Error("independent native validation plan substitutes a bound input or artifact path");
  }
  verifyExecutable(profile.executables.envoy);
  verifyExecutable(profile.executables.nft);
  verifyArtifact({
    path: plan.paths.envoyConfigPath,
    digest: gateway.envoyConfigDigest,
    exactText: gateway.envoyConfigJson,
  });
  verifyArtifact({
    path: plan.paths.nftablesPolicyPath,
    digest: gateway.nftablesPolicyDigest,
    exactText: gateway.nftablesPolicy,
  });
  const envoy = normalizeCommandResult(execute({
    operation: "envoy_validate",
    executable: profile.executables.envoy.path,
    artifactPath: plan.paths.envoyConfigPath,
  }), "Envoy native validation");
  const nft = normalizeCommandResult(execute({
    operation: "nft_check",
    executable: profile.executables.nft.path,
    artifactPath: plan.paths.nftablesPolicyPath,
  }), "nftables check-only validation");
  verifyArtifact({
    path: plan.paths.envoyConfigPath,
    digest: gateway.envoyConfigDigest,
    exactText: gateway.envoyConfigJson,
  });
  verifyArtifact({
    path: plan.paths.nftablesPolicyPath,
    digest: gateway.nftablesPolicyDigest,
    exactText: gateway.nftablesPolicy,
  });
  return deepFreeze({
    schemaVersion: 1,
    kind: "api_migrator_linux_l7_independent_native_config_validation",
    observedAt,
    envoy: {
      executablePath: profile.executables.envoy.path,
      executableDigest: profile.executables.envoy.digest,
      arguments: ["--mode", "validate", "-c", plan.paths.envoyConfigPath],
      artifactPath: plan.paths.envoyConfigPath,
      configDigest: gateway.envoyConfigDigest,
      stdoutDigest: sha256(Buffer.from(envoy.stdout, "utf8")),
      stderrDigest: sha256(Buffer.from(envoy.stderr, "utf8")),
      status: "native_validate_passed",
    },
    nftables: {
      executablePath: profile.executables.nft.path,
      executableDigest: profile.executables.nft.digest,
      arguments: ["-c", "-f", plan.paths.nftablesPolicyPath],
      artifactPath: plan.paths.nftablesPolicyPath,
      policyDigest: gateway.nftablesPolicyDigest,
      stdoutDigest: sha256(Buffer.from(nft.stdout, "utf8")),
      stderrDigest: sha256(Buffer.from(nft.stderr, "utf8")),
      status: "native_check_only_passed",
    },
    filesystemArtifactsObserved: true,
    gatewayLifecycleMutationObserved: false,
  });
}

/** Verify a native executable immediately before use against its pinned digest. */
export function verifyExecutableBinding(binding, dependencies = {}) {
  const root = plainRecord(binding, "native executable binding");
  exactKeys(root, ["path", "digest"], "native executable binding");
  digest(root.digest, "native executable digest");
  if (!isAbsolute(root.path) || resolve(root.path) !== root.path) throw new Error("native executable path is invalid");
  const lstat = dependencies.lstatSync ?? lstatSync;
  const realpath = dependencies.realpathSync ?? realpathSync;
  const read = dependencies.readFileSync ?? readFileSync;
  const info = lstat(root.path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0 ||
      (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0 || realpath(root.path) !== root.path) {
    throw new Error("native executable is not an exact root-sealed file");
  }
  if (sha256(read(root.path)) !== root.digest) throw new Error("native executable digest does not match its host binding");
  return true;
}

/** Verify the exact root-sealed artifact bytes created by the preflight. */
export function verifyArtifactBinding(binding, dependencies = {}) {
  const root = plainRecord(binding, "native preflight artifact binding");
  exactKeys(root, ["path", "digest", "exactText"], "native preflight artifact binding");
  digest(root.digest, "native preflight artifact digest");
  if (!isAbsolute(root.path) || resolve(root.path) !== root.path || typeof root.exactText !== "string" || root.exactText.length === 0) {
    throw new Error("native preflight artifact binding is invalid");
  }
  const lstat = dependencies.lstatSync ?? lstatSync;
  const realpath = dependencies.realpathSync ?? realpathSync;
  const read = dependencies.readFileSync ?? readFileSync;
  const info = lstat(root.path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0 ||
      (info.mode & 0o777) !== 0o600 || realpath(root.path) !== root.path) {
    throw new Error("native preflight artifact is not an exact root-sealed mode-0600 file");
  }
  const bytes = read(root.path);
  if (!Buffer.isBuffer(bytes) || !bytes.equals(Buffer.from(root.exactText, "utf8")) || sha256(bytes) !== root.digest) {
    throw new Error("native preflight artifact bytes drifted from the rendered gateway binding");
  }
  return true;
}

/** Bind the running Node binary and this exact observer module before evidence collection. */
export function verifyObserverRuntimeIdentity(profileValue, dependencies = {}) {
  const profile = validateHostProfile(profileValue);
  const supplied = dependencies.runtimeIdentity;
  const identity = supplied === undefined ? {
    schemaVersion: 1,
    kind: "api_migrator_linux_l7_observer_runtime_identity",
    node: observeRuntimeFile(process.execPath, profile.executables.node, true, dependencies),
    observer: observeRuntimeFile(
      fileURLToPath(import.meta.url),
      { path: profile.artifacts.lifecycleObserverPath, digest: profile.artifacts.lifecycleObserverDigest },
      false,
      dependencies
    ),
    verified: true,
  } : structuredClone(supplied);
  const root = plainRecord(identity, "lifecycle observer runtime identity");
  exactKeys(root, ["schemaVersion", "kind", "node", "observer", "verified"], "lifecycle observer runtime identity");
  if (root.schemaVersion !== 1 || root.kind !== "api_migrator_linux_l7_observer_runtime_identity" || root.verified !== true) {
    throw new Error("lifecycle observer runtime identity is unsupported");
  }
  for (const [name, expected] of [
    ["node", profile.executables.node],
    ["observer", { path: profile.artifacts.lifecycleObserverPath, digest: profile.artifacts.lifecycleObserverDigest }],
  ]) {
    const binding = plainRecord(root[name], `lifecycle observer ${name} runtime binding`);
    exactKeys(binding, ["path", "digest"], `lifecycle observer ${name} runtime binding`);
    if (binding.path !== expected.path || binding.digest !== expected.digest) {
      throw new Error(`running lifecycle observer ${name} does not match its exact host binding`);
    }
  }
  return deepFreeze(root);
}

/** Construct the permanently blocked observer report from exact raw evidence. */
export function buildLifecycleObserverReport(input) {
  const root = plainRecord(input, "lifecycle observer report input");
  exactKeys(root, [
    "jobId", "planDigest", "profile", "hostProfileDigest", "runtimeManifestDigest", "gatewayDeployment",
    "preflightResult", "preflightResultDigest", "startedEvent", "finishedEvent", "initialAbsenceEvidence",
    "finalAbsenceEvidence", "nativeValidation", "planCreatedAt", "planExpiresAt", "preflightPlan",
    "runtimeIdentity",
  ], "lifecycle observer report input");
  const profile = validateHostProfile(root.profile);
  const runtimeIdentity = verifyObserverRuntimeIdentity(profile, { runtimeIdentity: root.runtimeIdentity });
  const runtimeIdentityDigest = sha256(Buffer.from(canonicalJson(runtimeIdentity), "utf8"));
  const gateway = validateGatewayDeploymentRecord(root.gatewayDeployment);
  const preflightResult = validateLifecyclePreflightResult(root.preflightResult, root.preflightPlan);
  if (canonicalJson(preflightResult) !== canonicalJson(root.preflightResult)) {
    throw new Error("observer report preflight result is not exactly normalized");
  }
  const preflightResultDigest = digest(root.preflightResultDigest, "lifecycle preflight result digest");
  const planCreatedAt = timestamp(root.planCreatedAt, "observer plan creation");
  const planExpiresAt = timestamp(root.planExpiresAt, "observer plan expiry");
  if (planExpiresAt <= planCreatedAt) throw new Error("observer plan lifetime is invalid");
  if (sha256(Buffer.from(canonicalJson(preflightResult), "utf8")) !== preflightResultDigest ||
      preflightResult.jobId !== root.jobId || preflightResult.planDigest !== root.planDigest ||
      preflightResult.hostProfileDigest !== root.hostProfileDigest ||
      preflightResult.runtimeManifestDigest !== root.runtimeManifestDigest ||
      preflightResult.gatewayContractDigest !== gateway.digest) {
    throw new Error("observer report substitutes the canonical preflight result or binding");
  }
  const started = validateObserverEvent(root.startedEvent, 1, "observer_started", root);
  const finished = validateObserverEvent(root.finishedEvent, 2, "observer_finished", root);
  if (finished.observedAt <= started.observedAt) throw new Error("observer event timestamps are not increasing");
  const initialEvidence = validateAbsenceEvidence(root.initialAbsenceEvidence, gateway, profile, started.observedAt);
  const finalEvidence = validateAbsenceEvidence(root.finalAbsenceEvidence, gateway, profile, undefined);
  if (finalEvidence.observedAt < started.observedAt || finalEvidence.observedAt > finished.observedAt) {
    throw new Error("final absence evidence is outside the observer interval");
  }
  const nativeValidation = validateNativeValidation(root.nativeValidation, gateway, profile, preflightResult.artifacts);
  for (const [label, value] of [
    ["observer start", started.observedAt],
    ["preflight start", preflightResult.startedAt],
    ["preflight finish", preflightResult.finishedAt],
    ["independent native validation", nativeValidation.observedAt],
    ["final absence observation", finalEvidence.observedAt],
    ["observer finish", finished.observedAt],
  ]) {
    if (value < planCreatedAt || value >= planExpiresAt) throw new Error(`${label} is outside the canonical plan lifetime`);
  }
  if (initialEvidence.subuidStart !== finalEvidence.subuidStart || initialEvidence.subuidEnd !== finalEvidence.subuidEnd) {
    throw new Error("lifecycle absence evidence substitutes the subordinate UID boundary");
  }
  if (nativeValidation.observedAt < started.observedAt || nativeValidation.observedAt > finalEvidence.observedAt) {
    throw new Error("native validation is outside the observer interval");
  }
  if (preflightResult.filesystemArtifactsCreated !== true ||
      preflightResult.gatewayLifecycleMutationPerformed !== false ||
      preflightResult.finishedAt > nativeValidation.observedAt) {
    throw new Error("observer report does not follow the non-authorizing filesystem preflight");
  }
  if (started.evidenceDigest !== sha256(Buffer.from(canonicalJson(initialEvidence), "utf8"))) {
    throw new Error("observer start event does not bind its exact absence evidence");
  }
  const finishedEvidence = {
    preflightResultDigest: root.preflightResultDigest,
    runtimeIdentityDigest,
    independentNativeValidation: nativeValidation,
    finalAbsenceEvidence: finalEvidence,
  };
  if (finished.evidenceDigest !== sha256(Buffer.from(canonicalJson(finishedEvidence), "utf8"))) {
    throw new Error("observer finish event does not bind its exact final evidence");
  }
  const eventStream = `${canonicalJson(started)}\n${canonicalJson(finished)}\n`;
  return deepFreeze({
    schemaVersion: 1,
    kind: LIFECYCLE_OBSERVER_REPORT_KIND,
    jobId: root.jobId,
    planDigest: root.planDigest,
    hostProfileDigest: digest(root.hostProfileDigest, "host profile digest"),
    runtimeManifestDigest: digest(root.runtimeManifestDigest, "runtime manifest digest"),
    gatewayContractDigest: gateway.digest,
    envoyConfigDigest: gateway.envoyConfigDigest,
    nftablesPolicyDigest: gateway.nftablesPolicyDigest,
    preflightResultDigest,
    planCreatedAt,
    planExpiresAt,
    startedAt: started.observedAt,
    finishedAt: finished.observedAt,
    events: [started, finished],
    eventStreamDigest: sha256(Buffer.from(eventStream, "utf8")),
    runtimeIdentity,
    runtimeIdentityDigest,
    filesystemArtifacts: structuredClone(preflightResult.artifacts),
    filesystemArtifactsObserved: true,
    initialAbsenceEvidence: initialEvidence,
    independentNativeValidation: nativeValidation,
    finalAbsenceEvidence: finalEvidence,
    evidenceClass: LIFECYCLE_OBSERVER_EVIDENCE_CLASS,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: PREFLIGHT_AUTHORIZATION_STATUS,
    gatewayLifecycleMutationObserved: false,
    status: "passed",
  });
}

export async function waitForLifecyclePreflight(path, options = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error("lifecycle preflight result path must be canonical and absolute");
  }
  const timeoutMs = options.timeoutMs ?? MAX_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS ||
      !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1_000) {
    throw new Error("lifecycle preflight wait bounds are invalid");
  }
  const exists = options.existsSync ?? existsSync;
  const read = options.readRootSealedInput ?? readRootSealedInput;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delay) => new Promise((accept) => setTimeout(accept, delay)));
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    if (exists(path)) return read(path, MAX_PREFLIGHT_BYTES, "lifecycle preflight result");
    await sleep(pollMs);
  }
  throw new Error("bounded wait for lifecycle preflight result expired");
}

export function appendExclusiveLifecycleEvent(path, expectedCurrentText, event, dependencies = {}) {
  if (typeof expectedCurrentText !== "string" || expectedCurrentText.length === 0) {
    throw new Error("expected lifecycle event stream is invalid");
  }
  const nextLine = `${canonicalJson(event)}\n`;
  const expectedBytes = Buffer.from(expectedCurrentText, "utf8");
  const expectedFullBytes = Buffer.from(`${expectedCurrentText}${nextLine}`, "utf8");
  const open = dependencies.openSync ?? openSync;
  const fstat = dependencies.fstatSync ?? fstatSync;
  const read = dependencies.readSync ?? readSync;
  const write = dependencies.writeSync ?? writeSync;
  const fd = open(path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstat(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== 0 || (opened.mode & 0o777) !== 0o600 ||
        opened.size !== expectedBytes.length) {
      throw new Error("lifecycle event stream is not the exclusive root-owned mode-0600 file");
    }
    const existing = readExactFd(fd, expectedBytes.length, read);
    if (!existing.equals(expectedBytes) || sha256(existing) !== sha256(expectedBytes)) {
      throw new Error("lifecycle event stream changed before observer append");
    }
    writeAllFd(fd, Buffer.from(nextLine, "utf8"), write);
    (dependencies.fsyncSync ?? fsyncSync)(fd);
    const completed = fstat(fd);
    if (completed.dev !== opened.dev || completed.ino !== opened.ino || completed.nlink !== 1 ||
        completed.uid !== 0 || (completed.mode & 0o777) !== 0o600 || completed.size !== expectedFullBytes.length) {
      throw new Error("lifecycle event stream metadata changed during observer append");
    }
    const observedFullBytes = readExactFd(fd, expectedFullBytes.length, read);
    if (!observedFullBytes.equals(expectedFullBytes) || sha256(observedFullBytes) !== sha256(expectedFullBytes)) {
      throw new Error("lifecycle event stream bytes drifted during observer append");
    }
  } finally {
    (dependencies.closeSync ?? closeSync)(fd);
  }
}

/** Run the read-only observer state machine with injectable host operations. */
export async function runLifecyclePreflightObserver(context, dependencies = {}) {
  const root = plainRecord(context, "lifecycle observer context");
  exactKeys(root, [
    "job", "profile", "plan", "gatewayDeployment", "runtimeManifest", "runtimeManifestDigest",
    "hostProfileDigest", "jobText", "profileText", "planText", "gatewayContractText",
    "runtimeManifestText", "runtimeIdentity",
  ], "lifecycle observer context");
  const job = validateJobDescriptor(root.job);
  const profile = validateHostProfile(root.profile);
  const gateway = validateGatewayDeploymentRecord(root.gatewayDeployment);
  const runtimeIdentity = verifyObserverRuntimeIdentity(profile, { runtimeIdentity: root.runtimeIdentity });
  const runtimeManifest = validateRuntimeManifest(root.runtimeManifest);
  if (sha256(Buffer.from(canonicalJson(runtimeManifest), "utf8")) !== root.runtimeManifestDigest ||
      profile.artifacts.lifecycleRuntimeManifestDigest !== root.runtimeManifestDigest ||
      sha256(Buffer.from(canonicalJson(profile), "utf8")) !== root.hostProfileDigest) {
    throw new Error("lifecycle observer context substitutes the host or runtime manifest binding");
  }
  const now = dependencies.now ?? Date.now;
  const execute = dependencies.execute ?? executeFixedReadOnlyOperation;
  const writeExclusive = dependencies.writeExclusiveEvidence ?? writeExclusiveEvidence;
  const appendEvent = dependencies.appendExclusiveLifecycleEvent ?? appendExclusiveLifecycleEvent;
  const wait = dependencies.waitForLifecyclePreflight ?? waitForLifecyclePreflight;
  const exists = dependencies.existsSync ?? existsSync;
  if (exists(job.lifecyclePreflightPath) || exists(job.lifecycleEventsPath) || exists(job.lifecycleReportPath) ||
      exists(job.runtimeRootPath)) {
    throw new Error("lifecycle preflight evidence path already exists");
  }

  const initialObservedAt = now();
  assertWithinPlanTimestamp(initialObservedAt, root.plan, "initial lifecycle absence observation");
  const initialAbsenceEvidence = collectLifecycleAbsenceEvidence({
    profile,
    gatewayDeployment: gateway,
    observedAt: initialObservedAt,
  }, { execute, verifyExecutableBinding: dependencies.verifyExecutableBinding });
  const startedEvent = buildLifecyclePreflightEvent({
    sequence: 1,
    event: "observer_started",
    jobId: job.jobId,
    planDigest: job.planDigest,
    hostProfileDigest: root.hostProfileDigest,
    runtimeManifestDigest: root.runtimeManifestDigest,
    gatewayContractDigest: gateway.digest,
    observedAt: initialAbsenceEvidence.observedAt,
    evidenceDigest: sha256(Buffer.from(canonicalJson(initialAbsenceEvidence), "utf8")),
  });
  const startedText = `${canonicalJson(startedEvent)}\n`;
  writeExclusive(job.lifecycleEventsPath, startedText);

  const plannedAt = now();
  const preflightPlan = (dependencies.renderLifecyclePreflightPlan ?? renderLifecyclePreflightPlan)({
    jobText: root.jobText,
    profileText: root.profileText,
    planText: root.planText,
    gatewayContractText: root.gatewayContractText,
    runtimeManifestText: root.runtimeManifestText,
    observerEventText: startedText,
    nowMs: plannedAt,
  });

  const preflightText = await wait(job.lifecyclePreflightPath, {
    timeoutMs: Math.min(job.runtimeMaxMs, MAX_WAIT_MS, preflightPlan.plan.job.expiresAt - plannedAt - 1),
  });
  const parsedPreflight = parseCanonicalLifecyclePreflightResult(preflightText, preflightPlan);
  const nativeObservedAt = now();
  assertWithinPlanTimestamp(nativeObservedAt, preflightPlan.plan, "independent native validation");
  const nativeValidation = runIndependentNativeConfigValidation({
    profile,
    gatewayDeployment: gateway,
    preflightPlan,
    observedAt: nativeObservedAt,
  }, {
    execute,
    verifyExecutableBinding: dependencies.verifyExecutableBinding,
    verifyArtifactBinding: dependencies.verifyArtifactBinding,
  });
  const finalObservedAt = now();
  assertWithinPlanTimestamp(finalObservedAt, preflightPlan.plan, "final lifecycle absence observation");
  const finalAbsenceEvidence = collectLifecycleAbsenceEvidence({
    profile,
    gatewayDeployment: gateway,
    observedAt: finalObservedAt,
  }, { execute, verifyExecutableBinding: dependencies.verifyExecutableBinding });
  const finishedEvidence = deepFreeze({
    preflightResultDigest: parsedPreflight.digest,
    runtimeIdentityDigest: sha256(Buffer.from(canonicalJson(runtimeIdentity), "utf8")),
    independentNativeValidation: nativeValidation,
    finalAbsenceEvidence,
  });
  const finishedAt = now();
  assertWithinPlanTimestamp(finishedAt, preflightPlan.plan, "observer finish");
  const finishedEvent = buildLifecyclePreflightEvent({
    sequence: 2,
    event: "observer_finished",
    jobId: job.jobId,
    planDigest: job.planDigest,
    hostProfileDigest: root.hostProfileDigest,
    runtimeManifestDigest: root.runtimeManifestDigest,
    gatewayContractDigest: gateway.digest,
    observedAt: finishedAt,
    evidenceDigest: sha256(Buffer.from(canonicalJson(finishedEvidence), "utf8")),
  });
  appendEvent(job.lifecycleEventsPath, startedText, finishedEvent);
  const report = buildLifecycleObserverReport({
    jobId: job.jobId,
    planDigest: job.planDigest,
    profile,
    hostProfileDigest: root.hostProfileDigest,
    runtimeManifestDigest: root.runtimeManifestDigest,
    gatewayDeployment: gateway,
    preflightPlan,
    runtimeIdentity,
    preflightResult: parsedPreflight.result,
    preflightResultDigest: parsedPreflight.digest,
    startedEvent,
    finishedEvent,
    initialAbsenceEvidence,
    finalAbsenceEvidence,
    nativeValidation,
    planCreatedAt: preflightPlan.plan.job.createdAt,
    planExpiresAt: preflightPlan.plan.job.expiresAt,
  });
  writeExclusive(job.lifecycleReportPath, canonicalJson(report));
  return deepFreeze({ report, preflight: parsedPreflight });
}

export function loadLifecycleObserverContext(jobPath, dependencies = {}) {
  const read = dependencies.readRootSealedInput ?? readRootSealedInput;
  const jobText = read(jobPath, MAX_JOB_BYTES, "lifecycle observer job descriptor");
  const job = validateJobDescriptor(parseCanonicalObject(jobText, "lifecycle observer job descriptor", MAX_JOB_BYTES));
  if (dirname(jobPath) !== dirname(job.planPath)) throw new Error("lifecycle observer job descriptor escapes the sealed job root");
  const profileText = read(job.hostProfilePath, MAX_PROFILE_BYTES, "lifecycle observer host profile");
  const profile = validateHostProfile(parseCanonicalObject(profileText, "lifecycle observer host profile", MAX_PROFILE_BYTES));
  const runtimeIdentity = verifyObserverRuntimeIdentity(profile, { runtimeIdentity: dependencies.runtimeIdentity });
  const planText = read(job.planPath, MAX_PLAN_BYTES, "lifecycle observer plan");
  const plan = parseCanonicalPlan(planText, job.planDigest, job.jobId);
  const gatewayText = read(job.gatewayContractPath, MAX_GATEWAY_BYTES, "lifecycle observer gateway contract");
  const gatewayContract = parseCanonicalObject(gatewayText, "lifecycle observer gateway contract", MAX_GATEWAY_BYTES);
  const gatewayDeployment = renderGatewayDeployment(gatewayContract);
  if (gatewayDeployment.canonicalJson !== gatewayText) throw new Error("lifecycle observer gateway contract is not normalized");
  const manifestText = read(
    profile.artifacts.lifecycleRuntimeManifestPath,
    MAX_MANIFEST_BYTES,
    "lifecycle runtime manifest"
  );
  const parsedManifest = parseCanonicalRuntimeManifest(manifestText, profile);
  const closure = (dependencies.verifyRuntimeManifestFilesystem ?? verifyRuntimeManifestFilesystem)(parsedManifest.manifest, {
    manifestPath: profile.artifacts.lifecycleRuntimeManifestPath,
    expectedManifestDigest: profile.artifacts.lifecycleRuntimeManifestDigest,
  });
  if (closure === false || closure?.verified === false) {
    throw new Error("lifecycle runtime manifest filesystem verification failed");
  }
  return deepFreeze({
    job,
    profile,
    plan,
    gatewayDeployment,
    runtimeManifest: parsedManifest.manifest,
    runtimeManifestDigest: parsedManifest.digest,
    hostProfileDigest: sha256(Buffer.from(canonicalJson(profile), "utf8")),
    jobText,
    profileText,
    planText,
    gatewayContractText: gatewayText,
    runtimeManifestText: manifestText,
    runtimeIdentity,
  });
}

async function main() {
  const args = parseObserverArguments(process.argv.slice(2));
  assertLinuxRootPreflightHost({
    platform: process.platform,
    getuid: process.getuid,
    env: process.env,
  });
  const context = loadLifecycleObserverContext(args.jobPath);
  const result = await runLifecyclePreflightObserver(context);
  process.stdout.write(`${canonicalJson({
    status: "non_authorizing_native_config_preflight_observed",
    jobId: result.report.jobId,
    reportPath: context.job.lifecycleReportPath,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: PREFLIGHT_AUTHORIZATION_STATUS,
  })}\n`);
}

function parseCanonicalObject(text, label, maxBytes) {
  const value = parseJson(text, label, maxBytes);
  if (canonicalJson(value) !== text) throw new Error(`${label} is not exact canonical JSON`);
  return value;
}

function parseNftTableSnapshot(text) {
  const root = parseJson(text, "nft table observation", MAX_COMMAND_BYTES);
  if (!Array.isArray(root.nftables)) throw new Error("nft table observation has no nftables array");
  const output = [];
  for (const entry of root.nftables) {
    if (entry?.metainfo !== undefined) continue;
    const table = entry?.table;
    if (!table || typeof table !== "object" || Array.isArray(table) ||
        !new Set(["ip", "ip6", "inet", "arp", "bridge", "netdev"]).has(table.family) ||
        typeof table.name !== "string" || !/^[A-Za-z0-9_.-]{1,255}$/.test(table.name)) {
      throw new Error("nft table observation contains an unsupported entry");
    }
    output.push({ family: table.family, name: table.name });
  }
  return output.sort((left, right) => `${left.family}:${left.name}`.localeCompare(`${right.family}:${right.name}`));
}

function normalizeCommandResult(value, label) {
  const root = plainRecord(value, label);
  exactKeys(root, ["stdout", "stderr"], label);
  return {
    stdout: boundedCommandText(root.stdout, `${label} stdout`),
    stderr: boundedCommandText(root.stderr, `${label} stderr`),
  };
}

function normalizeProcessResult(value) {
  const root = plainRecord(value, "process UID snapshot");
  exactKeys(root, ["uids"], "process UID snapshot");
  if (!Array.isArray(root.uids) || root.uids.some((uid) => !Number.isSafeInteger(uid) || uid < 0)) {
    throw new Error("process UID snapshot contains an invalid UID");
  }
  const uids = [...new Set(root.uids)].sort((left, right) => left - right);
  if (uids.length !== root.uids.length || uids.some((uid, index) => uid !== root.uids[index])) {
    throw new Error("process UID snapshot must be unique and sorted");
  }
  return { uids };
}

function validateObserverEvent(value, sequence, event, expected) {
  const root = plainRecord(value, "lifecycle observer event");
  if (root.sequence !== sequence || root.event !== event || root.jobId !== expected.jobId ||
      root.planDigest !== expected.planDigest || root.hostProfileDigest !== expected.hostProfileDigest ||
      root.runtimeManifestDigest !== expected.runtimeManifestDigest ||
      root.gatewayContractDigest !== expected.gatewayDeployment.digest) {
    throw new Error("lifecycle observer event substitutes its binding or sequence");
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

function validateAbsenceEvidence(value, gateway, profile, expectedObservedAt) {
  const root = plainRecord(value, "lifecycle absence evidence");
  exactKeys(root, [
    "schemaVersion", "kind", "jobId", "observedAt", "gatewayTable", "legacyTable", "runnerUid",
    "gatewayUid", "subuidStart", "subuidEnd", "nftTablesSnapshotDigest", "processUidsSnapshotDigest",
    "gatewayTableAbsent", "legacyTableAbsent", "runnerUidIdle", "gatewayUidIdle", "subuidRangeIdle",
    "gatewayLifecycleMutationObserved",
  ], "lifecycle absence evidence");
  if (root.schemaVersion !== 1 || root.kind !== "api_migrator_linux_l7_preflight_absence_snapshot" ||
      root.jobId !== gateway.contract.jobId || root.gatewayTable !== gateway.nftablesTable ||
      root.legacyTable !== `api_migrator_${gateway.contract.jobId.slice(11, 27)}` ||
      root.runnerUid !== gateway.contract.runnerUid || root.gatewayUid !== gateway.contract.gatewayUid ||
      root.subuidStart !== profile.runner.subuid.start ||
      root.subuidEnd !== profile.runner.subuid.start + profile.runner.subuid.count - 1 ||
      root.gatewayTableAbsent !== true || root.legacyTableAbsent !== true || root.runnerUidIdle !== true ||
      root.gatewayUidIdle !== true || root.subuidRangeIdle !== true || root.gatewayLifecycleMutationObserved !== false) {
    throw new Error("lifecycle absence evidence is substituted or not idle");
  }
  if (!Number.isSafeInteger(root.subuidStart) || root.subuidStart < 65_536 ||
      !Number.isSafeInteger(root.subuidEnd) || root.subuidEnd < root.subuidStart ||
      root.subuidEnd - root.subuidStart + 1 < 65_536) {
    throw new Error("lifecycle absence evidence subordinate UID range is invalid");
  }
  timestamp(root.observedAt, "lifecycle absence observation");
  if (expectedObservedAt !== undefined && root.observedAt !== expectedObservedAt) {
    throw new Error("initial absence evidence does not bind observer start");
  }
  digest(root.nftTablesSnapshotDigest, "nft table snapshot digest");
  digest(root.processUidsSnapshotDigest, "process UID snapshot digest");
  return deepFreeze(structuredClone(root));
}

function validateNativeValidation(value, gateway, profile, artifactsValue) {
  const root = plainRecord(value, "independent native validation");
  exactKeys(root, [
    "schemaVersion", "kind", "observedAt", "envoy", "nftables", "filesystemArtifactsObserved",
    "gatewayLifecycleMutationObserved",
  ], "independent native validation");
  if (root.schemaVersion !== 1 || root.kind !== "api_migrator_linux_l7_independent_native_config_validation" ||
      root.filesystemArtifactsObserved !== true || root.gatewayLifecycleMutationObserved !== false) {
    throw new Error("independent native validation is invalid");
  }
  timestamp(root.observedAt, "independent native validation observation");
  const envoy = plainRecord(root.envoy, "independent Envoy validation");
  const nftables = plainRecord(root.nftables, "independent nftables validation");
  exactKeys(envoy, ["executablePath", "executableDigest", "arguments", "artifactPath", "configDigest", "stdoutDigest", "stderrDigest", "status"], "independent Envoy validation");
  exactKeys(nftables, ["executablePath", "executableDigest", "arguments", "artifactPath", "policyDigest", "stdoutDigest", "stderrDigest", "status"], "independent nftables validation");
  const artifacts = plainRecord(artifactsValue, "lifecycle preflight artifacts");
  exactKeys(artifacts, ["envoyConfig", "nftablesPolicy"], "lifecycle preflight artifacts");
  if (canonicalJson(envoy.arguments) !== canonicalJson(["--mode", "validate", "-c", artifacts.envoyConfig.path]) ||
      canonicalJson(nftables.arguments) !== canonicalJson(["-c", "-f", artifacts.nftablesPolicy.path]) ||
      envoy.artifactPath !== artifacts.envoyConfig.path || nftables.artifactPath !== artifacts.nftablesPolicy.path ||
      envoy.executablePath !== profile.executables.envoy.path || envoy.executableDigest !== profile.executables.envoy.digest ||
      nftables.executablePath !== profile.executables.nft.path || nftables.executableDigest !== profile.executables.nft.digest ||
      envoy.configDigest !== gateway.envoyConfigDigest || nftables.policyDigest !== gateway.nftablesPolicyDigest ||
      envoy.status !== "native_validate_passed" || nftables.status !== "native_check_only_passed") {
    throw new Error("independent native validation substitutes fixed config or command bindings");
  }
  for (const value of [envoy.executableDigest, envoy.stdoutDigest, envoy.stderrDigest, nftables.executableDigest, nftables.stdoutDigest, nftables.stderrDigest]) {
    digest(value, "independent native evidence digest");
  }
  return deepFreeze(structuredClone(root));
}

function boundedCommandText(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_COMMAND_BYTES) {
    throw new Error(`${label} is invalid or oversized`);
  }
  return value;
}

function readExactFd(fd, length, read) {
  const output = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = read(fd, output, offset, length - offset, offset);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("lifecycle event stream ended during exact read");
    offset += count;
  }
  return output;
}

function observeRuntimeFile(actualPath, expected, executable, dependencies) {
  const realpath = dependencies.realpathSync ?? realpathSync;
  const canonicalActualPath = realpath(actualPath);
  if (canonicalActualPath !== expected.path) {
    throw new Error("running lifecycle observer runtime path does not match its exact host binding");
  }
  const open = dependencies.openSync ?? openSync;
  const fstat = dependencies.fstatSync ?? fstatSync;
  const read = dependencies.readFileSync ?? readFileSync;
  const close = dependencies.closeSync ?? closeSync;
  const fd = open(canonicalActualPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstat(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || (before.mode & 0o022) !== 0 ||
        (executable && (before.mode & 0o111) === 0)) {
      throw new Error("running lifecycle observer runtime file is not root-sealed");
    }
    const bytes = read(fd);
    const after = fstat(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== 1 ||
        sha256(bytes) !== expected.digest) {
      throw new Error("running lifecycle observer runtime file changed or drifted from its digest");
    }
    return { path: expected.path, digest: expected.digest };
  } finally {
    close(fd);
  }
}

function writeAllFd(fd, bytes, write) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = write(fd, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("lifecycle event stream append was incomplete");
    offset += count;
  }
}

function digest(value, label) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertWithinPlanTimestamp(value, plan, label) {
  const observedAt = timestamp(value, label);
  const root = plainRecord(plan, "canonical observer plan");
  const job = plainRecord(root.job, "canonical observer plan job");
  if (observedAt < job.createdAt || observedAt >= job.expiresAt) {
    throw new Error(`${label} is outside the canonical plan lifetime`);
  }
  return observedAt;
}

function plainRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`lifecycle preflight observer refused: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
