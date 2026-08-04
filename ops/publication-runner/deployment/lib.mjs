import {
  createHash,
} from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const RUNNER_PROFILE = "disposable-egress-filtered-pilot-v1";
export const RUNNER_UNIT = "api-migrator-runner.service";
export const OBSERVER_UNIT = "api-migrator-runner-observer.service";
export const SIGNING_DOMAIN = "api-migrator:publication-runner-attestation:v1\0";
export const HOST_CONTRACT_AUTHORIZATION_STATUS = "blocked_pending_linux_gateway_lifecycle_drill";
export const L7_GATEWAY_PROFILE = "static-envoy-sni-passthrough-v1";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const JOB_ID = /^previewjob_[a-f0-9]{64}$/;
const INVOCATION_ID = /^[a-f0-9]{32}$/;
const PATH = /^\/[A-Za-z0-9._/-]+$/;
const REFERENCE_CONTROL = /[\u0000-\u001f\u007f]/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PREFLIGHT_ID = /^pf_[a-f0-9]{64}$/;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_PROFILE_BYTES = 128 * 1024;
const MAX_DESCRIPTOR_BYTES = 32 * 1024;
const MAX_L7_BYTES = 64 * 1024;
const MAX_EVENTS_BYTES = 64 * 1024;
const MAX_EVENT_LINE_BYTES = 4 * 1024;
const MAX_RESULT_BYTES = 98_304;

const SUCCESS_EVENTS = [
  "nftables_policy_installed",
  "offline_preparation_started",
  "offline_preparation_finished",
  "dependency_install_started",
  "dependency_install_finished",
  "offline_network_enforced",
  "offline_migration_started",
  "offline_migration_finished",
  "offline_verification_started",
  "offline_checks_finished",
  "output_ownership_revoked",
  "offline_verification_finished",
  "output_sealed",
  "containers_destroyed",
  "podman_cleanup_observed",
  "nftables_policy_removed",
  "workspace_destroyed",
  "wrapper_teardown_complete",
];

const SENSITIVE_OBSERVER_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_APP_ID",
  "GH_APP_PRIVATE_KEY",
  "GH_APP_PRIVATE_KEY_PATH",
  "GH_APP_INSTALLATION_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SESSION_TOKEN",
  "GOOGLE_CLOUD_PROJECT",
  "AZURE_CLIENT_ID",
  "OPERATOR_APPROVAL_SECRET",
  "AWS_SECRET_ACCESS_KEY",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "DATABASE_URL",
  "API_MIGRATOR_DB_PATH",
  "API_MIGRATOR_OWNER_KEY_REGISTRY_PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
  "NPM_CONFIG_USERCONFIG",
  "npm_config_proxy",
  "npm_config_https_proxy",
  "npm_config_userconfig",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "NODE_OPTIONS",
  "NODE_PATH",
  "DOCKER_HOST",
  "CONTAINER_HOST",
  "BASH_ENV",
  "ENV",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "SSH_AUTH_SOCK",
  "KUBECONFIG",
  "RUNNER_ATTESTATION_PRIVATE_KEY",
  "ATTESTATION_SIGNING_KEY",
];

export function canonicalJson(value) {
  return encodeCanonical(value, new Set());
}

function encodeCanonical(value, seen) {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error("canonical JSON numbers must be safe non-negative-zero integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("canonical JSON cannot contain cycles");
    seen.add(value);
    try {
      const keys = Object.keys(value);
      const ownKeys = Reflect.ownKeys(value);
      if (keys.length !== value.length ||
          keys.some((key, index) => key !== String(index)) ||
          ownKeys.length !== value.length + 1 ||
          ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !keys.includes(key)))) {
        throw new Error("canonical JSON cannot contain sparse or extended arrays");
      }
      return `[${value.map((entry) => encodeCanonical(entry, seen)).join(",")}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (isRecord(value)) {
    if (seen.has(value)) throw new Error("canonical JSON cannot contain cycles");
    seen.add(value);
    try {
      const keys = Object.keys(value).sort();
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== keys.length ||
          ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
        throw new Error("canonical JSON cannot contain hidden or symbolic members");
      }
      for (const key of keys) {
        assertValidUnicode(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("canonical JSON cannot contain accessors or hidden members");
        }
        if (descriptor.value === undefined) {
          throw new Error("canonical JSON cannot contain undefined members");
        }
      }
      return `{${keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return `${JSON.stringify(key)}:${encodeCanonical(descriptor.value, seen)}`;
      }).join(",")}}`;
    } finally {
      seen.delete(value);
    }
  }
  throw new Error("canonical JSON contains an unsupported value");
}

function assertValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("canonical JSON contains an unpaired high surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("canonical JSON contains an unpaired low surrogate");
    }
  }
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function sha256File(path) {
  absolutePath(path, "digest input path");
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync(path) !== path) {
    throw new Error("digest input must be a canonical single-link regular file");
  }
  const state = createHash("sha256");
  for await (const chunk of createReadStream(path)) state.update(chunk);
  return `sha256:${state.digest("hex")}`;
}

export function parseJson(text, label, maxBytes) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") === 0) {
    throw new Error(`${label} is empty`);
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${label} is too large`);
  try {
    const value = JSON.parse(text);
    if (!isRecord(value)) throw new Error("root must be an object");
    canonicalJson(value);
    return value;
  } catch (error) {
    throw new Error(`${label} is not valid bounded JSON: ${safeMessage(error)}`);
  }
}

export function parseCanonicalPlan(planText, expectedDigest, expectedJobId) {
  const plan = parseJson(planText, "runner plan", MAX_PLAN_BYTES);
  if (canonicalJson(plan) !== planText) throw new Error("runner plan is not exact canonical JSON");
  if (!DIGEST.test(expectedDigest) || sha256(Buffer.from(planText, "utf8")) !== expectedDigest) {
    throw new Error("runner plan digest does not match its exact bytes");
  }
  exactKeys(plan, [
    "schemaVersion", "profile", "job", "subject", "inputs", "imageDigest", "egress", "execution", "teardown",
  ], "runner plan");
  if (plan.schemaVersion !== 1 || plan.profile !== RUNNER_PROFILE) {
    throw new Error("runner plan profile is unsupported");
  }
  const job = record(plan.job, "runner plan job");
  exactKeys(job, ["id", "nonceDigest", "createdAt", "expiresAt", "disposable"], "runner plan job");
  if (!JOB_ID.test(job.id) || job.id !== expectedJobId || job.disposable !== true) {
    throw new Error("runner plan job identity is invalid");
  }
  timestamp(job.createdAt, "runner plan creation");
  timestamp(job.expiresAt, "runner plan expiry");
  if (job.expiresAt <= job.createdAt || job.expiresAt - job.createdAt > 15 * 60 * 1000) {
    throw new Error("runner plan lifetime is invalid");
  }
  digest(plan.imageDigest, "runner image digest");
  const inputs = record(plan.inputs, "runner plan inputs");
  digest(inputs.sourceArchiveDigest, "source archive digest");
  const egress = record(plan.egress, "runner plan egress");
  const install = record(egress.install, "runner install egress");
  digest(install.policyDigest, "install egress policy digest");
  return plan;
}

export function validateJobDescriptor(value) {
  const job = record(value, "deployment job descriptor");
  exactKeys(job, [
    "schemaVersion", "jobId", "unitRenderedAt", "runtimeMaxMs", "planPath", "planDigest", "sourceArchivePath", "outputPath",
    "rawEventsPath", "runnerResultPath", "hostProfilePath", "l7IntegrationStatusPath", "observationPath",
    "signingRequestPath",
  ], "deployment job descriptor");
  if (job.schemaVersion !== 1 || !JOB_ID.test(job.jobId)) {
    throw new Error("deployment job descriptor identity is invalid");
  }
  timestamp(job.unitRenderedAt, "deployment unit render time");
  if (!Number.isSafeInteger(job.runtimeMaxMs) || job.runtimeMaxMs < 30_000 || job.runtimeMaxMs > 900_000) {
    throw new Error("deployment unit runtime maximum is invalid");
  }
  for (const name of [
    "planPath", "sourceArchivePath", "outputPath", "rawEventsPath", "runnerResultPath",
    "hostProfilePath", "l7IntegrationStatusPath", "observationPath", "signingRequestPath",
  ]) {
    absolutePath(job[name], name);
  }
  digest(job.planDigest, "deployment plan digest");
  const distinctOutputs = [job.outputPath, job.rawEventsPath, job.runnerResultPath, job.observationPath, job.signingRequestPath];
  if (new Set(distinctOutputs).size !== distinctOutputs.length) {
    throw new Error("deployment job output and evidence paths must be distinct");
  }
  if (job.runnerResultPath !== `${job.rawEventsPath}.runner.json`) {
    throw new Error("runner result path must use the wrapper's exact sidecar identity");
  }
  const jobRoot = dirname(job.planPath);
  if (jobRoot === "/" || jobRoot.split("/").filter(Boolean).length < 3) {
    throw new Error("deployment job root is too broad");
  }
  for (const name of [
    "sourceArchivePath", "outputPath", "rawEventsPath", "runnerResultPath", "l7IntegrationStatusPath",
    "observationPath", "signingRequestPath",
  ]) {
    if (job[name] !== jobRoot && !job[name].startsWith(`${jobRoot}/`)) {
      throw new Error(`deployment ${name} escapes the exact job root`);
    }
  }
  return structuredClone(job);
}

export function validateHostProfile(value) {
  const root = record(value, "runner host profile");
  exactKeys(root, [
    "schemaVersion", "profile", "hostId", "dedicatedHost", "platform", "systemd", "runner",
    "executables", "artifacts", "deploymentEvidence",
  ], "runner host profile");
  if (root.schemaVersion !== 1 || root.profile !== "api-migrator-runner-host-v1" || root.dedicatedHost !== true) {
    throw new Error("runner host profile is unsupported or not dedicated");
  }
  identifier(root.hostId, "runner host id");
  const platform = record(root.platform, "runner host platform");
  exactKeys(platform, ["osId", "osVersion", "architecture", "kernelRelease", "cgroupVersion"], "runner host platform");
  boundedToken(platform.osId, "host OS id", /^[a-z0-9._-]{2,32}$/);
  boundedToken(platform.osVersion, "host OS version", /^[A-Za-z0-9._-]{1,32}$/);
  if (!new Set(["x86_64", "aarch64"]).has(platform.architecture) || platform.cgroupVersion !== 2) {
    throw new Error("runner host architecture or cgroup version is unsupported");
  }
  boundedToken(platform.kernelRelease, "host kernel release", /^[A-Za-z0-9._+-]{3,80}$/);

  const systemd = record(root.systemd, "runner systemd profile");
  exactKeys(systemd, ["version", "serializedRunnerUnit", "observerUnit", "killMode", "oomPolicy", "delegate"], "runner systemd profile");
  if (!Number.isInteger(systemd.version) || systemd.version < 252 || systemd.version > 999 ||
      systemd.serializedRunnerUnit !== RUNNER_UNIT || systemd.observerUnit !== OBSERVER_UNIT ||
      systemd.killMode !== "control-group" || systemd.oomPolicy !== "kill" || systemd.delegate !== true) {
    throw new Error("runner systemd profile is unsupported");
  }

  const runner = record(root.runner, "runner identity profile");
  exactKeys(runner, ["user", "uid", "group", "gid", "storageRoot", "storageDriver", "subuid", "subgid"], "runner identity profile");
  accountName(runner.user, "runner user");
  accountName(runner.group, "runner group");
  positiveInteger(runner.uid, "runner uid");
  positiveInteger(runner.gid, "runner gid");
  absolutePath(runner.storageRoot, "runner storage root");
  if (runner.storageDriver !== "vfs" && runner.storageDriver !== "overlay") {
    throw new Error("runner storage driver is unsupported");
  }
  validateSubid(runner.subuid, "runner subuid");
  validateSubid(runner.subgid, "runner subgid");

  const executables = record(root.executables, "runner executable profile");
  exactKeys(executables, ["node", "podman", "nft", "jq", "python3", "systemctl", "ociRuntime", "conmon"], "runner executable profile");
  for (const name of Object.keys(executables)) validateFileBinding(executables[name], `runner executable ${name}`);

  const artifacts = record(root.artifacts, "runner artifact profile");
  exactKeys(artifacts, [
    "wrapperPath", "wrapperDigest", "cleanupPath", "cleanupDigest", "observerPath", "observerDigest",
    "imageReference", "imageDigest",
  ], "runner artifact profile");
  for (const name of ["wrapperPath", "cleanupPath", "observerPath"]) absolutePath(artifacts[name], name);
  for (const name of ["wrapperDigest", "cleanupDigest", "observerDigest", "imageDigest"]) digest(artifacts[name], name);
  if (typeof artifacts.imageReference !== "string" ||
      !/^[A-Za-z0-9._/:@+-]+@sha256:[a-f0-9]{64}$/.test(artifacts.imageReference) ||
      !artifacts.imageReference.endsWith(`@${artifacts.imageDigest}`)) {
    throw new Error("runner image reference does not bind its exact digest");
  }

  const evidence = record(root.deploymentEvidence, "runner deployment evidence");
  exactKeys(evidence, ["observedAt", "reference", "digest"], "runner deployment evidence");
  timestamp(evidence.observedAt, "runner deployment evidence observation");
  reference(evidence.reference, "runner deployment evidence reference");
  digest(evidence.digest, "runner deployment evidence digest");
  return structuredClone(root);
}

export function validateL7IntegrationStatus(value, expected) {
  const root = record(value, "L7 gateway integration status");
  exactKeys(root, [
    "schemaVersion", "kind", "jobId", "planDigest", "gatewayProfile", "targetOrigin",
    "integrationStatus", "receiptValidation", "liveActivation", "linuxLifecycleDrillRequired",
    "blockReason",
  ], "L7 gateway integration status");
  if (root.schemaVersion !== 1 || root.kind !== "api_migrator_l7_gateway_integration_status" ||
      root.jobId !== expected.jobId || root.planDigest !== expected.planDigest ||
      root.gatewayProfile !== L7_GATEWAY_PROFILE || root.targetOrigin !== "registry.npmjs.org" ||
      root.integrationStatus !== "not_wired" || root.receiptValidation !== "not_performed" ||
      root.liveActivation !== "blocked" || root.linuxLifecycleDrillRequired !== true ||
      root.blockReason !== "forced_gateway_lifecycle_not_integrated") {
    throw new Error("L7 gateway integration must remain explicitly blocked and unverified");
  }
  return structuredClone(root);
}

export function parseWrapperEvents(eventsText, expected) {
  if (typeof eventsText !== "string" || Buffer.byteLength(eventsText, "utf8") > MAX_EVENTS_BYTES ||
      !eventsText.endsWith("\n")) {
    throw new Error("wrapper events are missing, oversized, or not newline terminated");
  }
  const lines = eventsText.slice(0, -1).split("\n");
  if (lines.length !== SUCCESS_EVENTS.length) throw new Error("wrapper success event count is invalid");
  const events = lines.map((line, index) => {
    if (Buffer.byteLength(line, "utf8") === 0 || Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
      throw new Error(`wrapper event ${index} is empty or oversized`);
    }
    const raw = parseJson(line, `wrapper event ${index}`, MAX_EVENT_LINE_BYTES);
    exactKeys(raw, ["event", "detail", "jobId", "planDigest", "systemdInvocation", "observedAt"], `wrapper event ${index}`);
    boundedToken(raw.event, `wrapper event ${index} name`, /^[a-z][a-z0-9_]{2,63}$/);
    if (typeof raw.detail !== "string" || Buffer.byteLength(raw.detail, "utf8") > 512 || REFERENCE_CONTROL.test(raw.detail)) {
      throw new Error(`wrapper event ${index} detail is invalid`);
    }
    if (raw.jobId !== expected.jobId || raw.planDigest !== expected.planDigest ||
        !INVOCATION_ID.test(raw.systemdInvocation)) {
      throw new Error(`wrapper event ${index} identity is invalid`);
    }
    timestamp(raw.observedAt, `wrapper event ${index} time`);
    const exactWire = JSON.stringify({
      event: raw.event,
      detail: raw.detail,
      jobId: raw.jobId,
      planDigest: raw.planDigest,
      systemdInvocation: raw.systemdInvocation,
      observedAt: raw.observedAt,
    });
    if (line !== exactWire) throw new Error(`wrapper event ${index} is not exact bounded wire JSON`);
    return raw;
  });
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.event !== SUCCESS_EVENTS[index]) throw new Error(`wrapper event order diverged at ${index}`);
    if (index > 0 && event.observedAt < events[index - 1].observedAt) {
      throw new Error("wrapper event time moved backwards");
    }
    if (event.observedAt < expected.createdAt || event.observedAt >= expected.expiresAt) {
      throw new Error("wrapper event occurred outside the plan lifetime");
    }
    if (event.systemdInvocation !== events[0].systemdInvocation) {
      throw new Error("wrapper events span multiple systemd invocations");
    }
  }
  const byName = Object.fromEntries(events.map((event) => [event.event, event]));
  for (const name of [
    "nftables_policy_installed", "offline_preparation_finished", "dependency_install_started",
    "dependency_install_finished",
    "offline_migration_finished", "offline_checks_finished", "output_ownership_revoked",
    "offline_verification_finished", "output_sealed",
  ]) digest(byName[name].detail, `${name} detail`);
  if (byName.offline_preparation_started.detail !== "network-none+read-only-source" ||
      byName.dependency_install_started.detail !== expected.installEgressPolicyDigest ||
      byName.offline_network_enforced.detail !== "podman-network-none+nft-empty-sets" ||
      byName.offline_migration_started.detail !== "network-none+read-only-source" ||
      byName.offline_verification_started.detail !== "typecheck,test,lint,runtime") {
    throw new Error("wrapper phase policy evidence does not match the plan");
  }
  for (const name of ["containers_destroyed", "podman_cleanup_observed", "nftables_policy_removed", "workspace_destroyed"]) {
    if (byName[name].detail !== "status=0") throw new Error(`${name} did not report exact successful cleanup`);
  }
  if (byName.wrapper_teardown_complete.detail !== "raw-events-require-control-plane-signature") {
    throw new Error("wrapper teardown terminal evidence is invalid");
  }
  return { events, byName, invocationId: events[0].systemdInvocation };
}

export function parseRunnerResult(resultText, expected = undefined) {
  const result = parseJson(resultText, "runner result", MAX_RESULT_BYTES);
  exactKeys(result, [
    "schemaVersion", "kind", "profile", "planDigest", "jobId", "sourceArchiveDigest",
    "manifestDigest", "commandScopeDigest", "dependencyStateDigest", "outputTreeDigest",
    "output", "targetBranch", "checks", "report", "reportDigest", "blockers",
  ], "runner result");
  if (result.schemaVersion !== 1 || result.kind !== "api-migrator-runner-evidence-v1" ||
      result.profile !== RUNNER_PROFILE) {
    throw new Error("runner result profile is unsupported");
  }
  for (const [name, label] of [
    ["planDigest", "runner plan digest"],
    ["sourceArchiveDigest", "runner source digest"],
    ["manifestDigest", "runner manifest digest"],
    ["commandScopeDigest", "runner command scope digest"],
    ["dependencyStateDigest", "runner dependency state digest"],
    ["outputTreeDigest", "runner output tree digest"],
    ["reportDigest", "runner report digest"],
  ]) digest(result[name], label);
  if (!JOB_ID.test(result.jobId)) throw new Error("runner result job identity is invalid");
  if (expected !== undefined) {
    const bindings = {
      planDigest: expected.planDigest,
      jobId: expected.jobId,
      sourceArchiveDigest: expected.sourceArchiveDigest,
      manifestDigest: expected.manifestDigest,
      commandScopeDigest: expected.commandScopeDigest,
    };
    for (const [name, value] of Object.entries(bindings)) {
      if (result[name] !== value) throw new Error(`runner result ${name} does not match the plan`);
    }
  }
  const output = record(result.output, "runner output");
  exactKeys(output, ["artifactDigest", "candidateTreeSha", "preflightId"], "runner output");
  digest(output.artifactDigest, "runner artifact digest");
  if (!GIT_SHA.test(output.candidateTreeSha) || !PREFLIGHT_ID.test(output.preflightId)) {
    throw new Error("runner result output identity is invalid");
  }
  if (typeof result.targetBranch !== "string" || result.targetBranch.length > 240 ||
      !result.targetBranch.startsWith("codex/api-migrator/") || REFERENCE_CONTROL.test(result.targetBranch)) {
    throw new Error("runner target branch is invalid");
  }
  const checks = record(result.checks, "runner checks");
  exactKeys(checks, ["install", "typecheck", "test", "lint", "runtime"], "runner checks");
  const report = record(result.report, "runner report");
  if (sha256(Buffer.from(canonicalJson(report), "utf8")) !== result.reportDigest) {
    throw new Error("runner report digest does not match its canonical report");
  }
  const verification = record(report.verification, "runner report verification");
  const reportChecks = record(verification.checks, "runner report checks");
  if (verification.ok !== true || verification.skipped !== false) {
    throw new Error("runner report verification did not pass");
  }
  const summary = record(report.summary, "runner report summary");
  if (summary.verified !== true || summary.review !== 0 ||
      !Array.isArray(report.entries) || report.entries.some((entry) => entry?.kind === "review")) {
    throw new Error("runner report contains a publication blocker");
  }
  for (const name of ["install", "typecheck", "test", "lint", "runtime"]) {
    const check = record(checks[name], `runner ${name} check`);
    const expectedKeys = check.reason === undefined
      ? ["status", "command", "exitCode"]
      : ["status", "command", "exitCode", "reason"];
    exactKeys(check, expectedKeys, `runner ${name} check`);
    if (check.status !== "passed" || check.exitCode !== 0 || typeof check.command !== "string" ||
        check.command.length === 0 || Buffer.byteLength(check.command, "utf8") > 4_096 ||
        REFERENCE_CONTROL.test(check.command) ||
        (check.reason !== undefined && (typeof check.reason !== "string" ||
          Buffer.byteLength(check.reason, "utf8") > 4_096 || REFERENCE_CONTROL.test(check.reason)))) {
      throw new Error(`runner ${name} check did not pass exact bounded validation`);
    }
    const reportCheck = record(reportChecks[name], `runner report ${name} check`);
    if (reportCheck.status !== check.status || reportCheck.command !== check.command ||
        reportCheck.exitCode !== check.exitCode || reportCheck.reason !== check.reason) {
      throw new Error(`runner ${name} check diverges from the canonical report`);
    }
  }
  if (!Array.isArray(result.blockers) || result.blockers.length !== 0) {
    throw new Error("runner result contains publication blockers");
  }
  const exactWire = canonicalJson(result);
  if (resultText !== exactWire) throw new Error("runner result is not exact canonical bounded wire JSON");
  return structuredClone(result);
}

export function validateLiveSnapshot(value, expected) {
  const root = record(value, "independent live snapshot");
  exactKeys(root, ["schemaVersion", "kind", "capturedAt", "systemd", "teardown"], "independent live snapshot");
  if (root.schemaVersion !== 1 || root.kind !== "api_migrator_runner_live_snapshot") {
    throw new Error("independent live snapshot profile is unsupported");
  }
  const capturedAt = timestamp(root.capturedAt, "independent snapshot capture");
  const systemd = record(root.systemd, "independent systemd snapshot");
  exactKeys(systemd, [
    "unitName", "invocationId", "serviceType", "remainAfterExit", "activeState", "subState",
    "result", "execMainCode", "execMainStatus", "killMode", "oomPolicy", "delegate",
    "timeoutStartUSec", "timeoutStartFailureMode", "timeoutStopUSec", "timeoutStopFailureMode",
    "controlGroup", "cgroupEmpty",
  ], "independent systemd snapshot");
  if (systemd.unitName !== RUNNER_UNIT || systemd.invocationId !== expected.invocationId ||
      systemd.serviceType !== "oneshot" || systemd.remainAfterExit !== true ||
      systemd.activeState !== "active" || systemd.subState !== "exited" || systemd.result !== "success" ||
      systemd.execMainCode !== 1 || systemd.execMainStatus !== 0 ||
      systemd.killMode !== "control-group" || systemd.oomPolicy !== "kill" || systemd.delegate !== true ||
      systemd.timeoutStartFailureMode !== "kill" || systemd.timeoutStopFailureMode !== "kill" ||
      systemd.cgroupEmpty !== true || typeof systemd.controlGroup !== "string" ||
      !/^\/[^\u0000-\u001f\u007f]{1,500}$/.test(systemd.controlGroup)) {
    throw new Error("independent systemd snapshot does not prove a successful quiescent unit");
  }
  positiveInteger(systemd.timeoutStartUSec, "systemd activation timeout");
  positiveInteger(systemd.timeoutStopUSec, "systemd stop timeout");
  if (systemd.timeoutStartUSec !== (expected.expiresAt - expected.renderedAt) * 1000 ||
      systemd.timeoutStopUSec !== 20_000_000) {
    throw new Error("systemd timeouts do not match the rendered fail-closed limits");
  }
  const teardown = record(root.teardown, "independent teardown snapshot");
  exactKeys(teardown, [
    "runnerUidIdle", "containersAbsent", "networkNamespacesAbsent", "nftablesTableAbsent",
    "workspaceAbsent", "observedAt",
  ], "independent teardown snapshot");
  if (teardown.runnerUidIdle !== true || teardown.containersAbsent !== true ||
      teardown.networkNamespacesAbsent !== true || teardown.nftablesTableAbsent !== true ||
      teardown.workspaceAbsent !== true) {
    throw new Error("independent teardown snapshot is incomplete");
  }
  const teardownObservedAt = timestamp(teardown.observedAt, "independent teardown observation");
  if (teardownObservedAt > capturedAt || teardownObservedAt < expected.executionFinishedAt ||
      capturedAt >= expected.expiresAt) {
    throw new Error("independent teardown snapshot timeline is invalid");
  }
  return structuredClone(root);
}

export function deriveRuntimeMaxMs(plan, nowMs) {
  timestamp(nowMs, "unit render clock");
  if (nowMs < plan.job.createdAt || nowMs >= plan.job.expiresAt) {
    throw new Error("runner plan is not current at unit rendering");
  }
  const remaining = plan.job.expiresAt - nowMs;
  if (remaining < 30_000) throw new Error("runner plan has less than 30 seconds remaining");
  return remaining;
}

export function deriveRunnerContainerSet(jobId) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) {
    throw new Error("runner container-set job identity is invalid");
  }
  const prefix = jobId.slice(0, 54);
  return [
    { phase: "offline_preparation", name: `${prefix}-prepare` },
    { phase: "dependency_install", name: `${prefix}-install` },
    { phase: "migration", name: `${prefix}-migrate` },
    { phase: "verification", name: `${prefix}-verify` },
  ];
}

export function computeNormalizedTreeDigest(rootPath, options = {}) {
  const root = realpathSync(rootPath);
  if (root !== resolve(rootPath)) throw new Error("sealed output path is not canonical");
  const digestState = createHash("sha256");
  let entries = 0;
  let totalBytes = 0;
  const requireRootOwnership = options.requireRootOwnership === true;

  function visit(directory, relativeDirectory, depth) {
    if (depth > 64) throw new Error("sealed output exceeds the maximum depth");
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o7777) !== 0o700) {
      throw new Error("sealed output contains a non-normalized directory");
    }
    if (requireRootOwnership && (directoryStat.uid !== 0 || directoryStat.gid !== 0)) {
      throw new Error("sealed output is not root-owned");
    }
    const names = readdirSync(directory);
    const entriesHere = names.map((name) => ({ name, path: join(directory, name), info: lstatSync(join(directory, name)) }));
    const directories = entriesHere.filter((entry) => entry.info.isDirectory())
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    const files = entriesHere.filter((entry) => entry.info.isFile())
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    if (directories.length + files.length !== entriesHere.length) {
      throw new Error("sealed output contains a non-regular object");
    }
    for (const { name, path, info } of [...directories, ...files]) {
      if (name === "." || name === ".." || Buffer.from(name, "utf8").toString("utf8") !== name) {
        throw new Error("sealed output contains an unsupported filename");
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      entries += 1;
      if (entries > 50_000) throw new Error("sealed output contains too many entries");
      let kind;
      let size = 0;
      if (info.isDirectory()) {
        if ((info.mode & 0o7777) !== 0o700) throw new Error("sealed directory mode is not normalized");
        kind = "d";
      } else if (info.isFile()) {
        const mode = info.mode & 0o7777;
        if ((mode !== 0o600 && mode !== 0o700) || info.nlink !== 1 || info.size > 268_435_456) {
          throw new Error("sealed file metadata is not normalized");
        }
        kind = mode === 0o700 ? "x" : "f";
        size = info.size;
        totalBytes += size;
        if (totalBytes > 536_870_912) throw new Error("sealed output is too large");
      } else {
        throw new Error("sealed output contains a non-regular object");
      }
      if (requireRootOwnership && (info.uid !== 0 || info.gid !== 0)) {
        throw new Error("sealed output entry is not root-owned");
      }
      const encoded = Buffer.from(relativePath, "utf8");
      const header = Buffer.alloc(5);
      header.write(kind, 0, 1, "ascii");
      header.writeUInt32BE(encoded.length, 1);
      digestState.update(header);
      digestState.update(encoded);
      const encodedSize = Buffer.alloc(8);
      encodedSize.writeBigUInt64BE(BigInt(size));
      digestState.update(encodedSize);
      if (kind === "f" || kind === "x") digestState.update(readFileSync(path));
    }
    for (const { name, path } of directories) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      visit(path, relativePath, depth + 1);
    }
  }

  visit(root, "", 0);
  if (options.checkExtendedMetadata === true) assertNoExtendedMetadata(root, options.pythonPath ?? "/usr/bin/python3");
  return `sha256:${digestState.digest("hex")}`;
}

/**
 * Recompute the two repository identities emitted by Runner v1 without using
 * runner package code or Git configuration. This intentionally mirrors the
 * runner's bounded regular-file walk and Git object framing at the independent
 * observer boundary.
 */
export function computeRunnerOutputIdentity(rootPath, baseSha) {
  const entries = collectRunnerRegularTree(rootPath);
  const regularDigest = createHash("sha256").update("api-migrator:regular-tree:v1\0");
  for (const entry of entries) {
    hashRunnerRecord(regularDigest, [entry.path, entry.mode, entry.size, entry.digest]);
  }
  return {
    regularTreeDigest: `sha256:${regularDigest.digest("hex")}`,
    candidateTreeSha: runnerGitTreeOid(entries, gitObjectFormatFromBaseSha(baseSha)),
  };
}

function collectRunnerRegularTree(rootPath) {
  if (typeof rootPath !== "string" || !isAbsolute(rootPath) || rootPath.includes("\0") || resolve(rootPath) !== rootPath) {
    throw new Error("runner output root must be an absolute canonical path");
  }
  const rootInfo = lstatSync(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || realpathSync(rootPath) !== rootPath) {
    throw new Error("runner output root must be a real canonical directory");
  }
  const root = rootPath;
  const entries = [];
  const stack = [root];
  let totalBytes = 0;
  while (stack.length > 0) {
    const directory = stack.pop();
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of children) {
      if (child.name === ".git" || child.name === "node_modules") continue;
      const absolute = join(directory, child.name);
      const path = relative(root, absolute).replace(/\\/g, "/");
      assertRunnerRelativePath(path);
      if (path.split("/").length > 64) {
        throw new Error(`runner output path exceeds depth limit: ${path}`);
      }
      const info = lstatSync(absolute);
      if (child.isDirectory() && !child.isSymbolicLink()) {
        stack.push(absolute);
        continue;
      }
      if (!child.isFile() || child.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
        throw new Error(`runner output contains a non-regular entry: ${path}`);
      }
      if (info.size > 268_435_456) {
        throw new Error(`runner output file exceeds size limit: ${path}`);
      }
      totalBytes += info.size;
      if (entries.length + 1 > 50_000 || totalBytes > 536_870_912) {
        throw new Error("runner output exceeds entry or byte limit");
      }
      const content = readFileSync(absolute);
      entries.push({
        path,
        mode: (info.mode & 0o111) === 0 ? 0o100644 : 0o100755,
        size: info.size,
        digest: sha256(content),
        content,
      });
    }
  }
  return entries;
}

function assertRunnerRelativePath(path) {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    throw new Error("runner output path is invalid");
  }
  if (path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`runner output path is not normalized: ${path}`);
  }
}

function hashRunnerRecord(hash, value) {
  const record = JSON.stringify(value);
  hash.update(String(Buffer.byteLength(record))).update(":").update(record);
}

function gitObjectFormatFromBaseSha(baseSha) {
  if (/^[a-f0-9]{40}$/.test(baseSha)) return "sha1";
  if (/^[a-f0-9]{64}$/.test(baseSha)) return "sha256";
  throw new Error("runner base Git object id must be a lowercase SHA-1 or SHA-256 value");
}

function runnerGitTreeOid(entries, objectFormat) {
  const root = runnerGitDirectory();
  for (const entry of entries) {
    validateRunnerGitPath(entry.path);
    insertRunnerGitEntry(root, entry);
  }
  return encodeRunnerGitDirectory(root, objectFormat).toString("hex");
}

function validateRunnerGitPath(path) {
  if (REFERENCE_CONTROL.test(path) || Buffer.byteLength(path, "utf8") > 4_096) {
    throw new Error("runner output Git path is oversized or non-portable");
  }
  assertValidUnicode(path);
  if (path.split("/").some((part) => part.toLowerCase() === ".git" || part.toLowerCase() === "node_modules")) {
    throw new Error(`runner output Git path contains a forbidden component: ${path}`);
  }
}

function runnerGitDirectory() {
  return { directories: new Map(), files: new Map() };
}

function insertRunnerGitEntry(root, entry) {
  const parts = entry.path.split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    if (directory.files.has(part)) {
      throw new Error(`runner output Git path collides with a file: ${entry.path}`);
    }
    let child = directory.directories.get(part);
    if (!child) {
      child = runnerGitDirectory();
      directory.directories.set(part, child);
    }
    directory = child;
  }
  const name = parts.at(-1);
  if (directory.directories.has(name) || directory.files.has(name)) {
    throw new Error(`runner output Git path is duplicated or colliding: ${entry.path}`);
  }
  directory.files.set(name, entry);
}

function encodeRunnerGitDirectory(directory, objectFormat) {
  const items = [];
  for (const [name, child] of directory.directories) {
    items.push({ name, directory: true, mode: "40000", oid: encodeRunnerGitDirectory(child, objectFormat) });
  }
  for (const [name, file] of directory.files) {
    items.push({
      name,
      directory: false,
      mode: file.mode === 0o100755 ? "100755" : "100644",
      oid: hashRunnerGitObject("blob", file.content, objectFormat),
    });
  }
  items.sort((left, right) => Buffer.compare(
    Buffer.from(`${left.name}${left.directory ? "/" : ""}`, "utf8"),
    Buffer.from(`${right.name}${right.directory ? "/" : ""}`, "utf8")
  ));
  const body = Buffer.concat(items.flatMap((item) => [
    Buffer.from(`${item.mode} `, "ascii"),
    Buffer.from(item.name, "utf8"),
    Buffer.from([0]),
    item.oid,
  ]));
  return hashRunnerGitObject("tree", body, objectFormat);
}

function hashRunnerGitObject(type, body, objectFormat) {
  return createHash(objectFormat)
    .update(Buffer.from(`${type} ${body.length}\0`, "ascii"))
    .update(body)
    .digest();
}

export function buildObservation(input) {
  if (input.observationMode !== "contract_fixture") {
    throw new Error("live runner observation is disabled until the forced gateway lifecycle is integrated and drilled");
  }
  const job = validateJobDescriptor(input.job);
  const profile = validateHostProfile(input.profile);
  const plan = parseCanonicalPlan(input.planText, job.planDigest, job.jobId);
  if (typeof input.sourceArchiveDigest !== "string" || input.sourceArchiveDigest !== plan.inputs.sourceArchiveDigest) {
    throw new Error("source archive bytes do not match the runner plan");
  }
  if (profile.artifacts.imageDigest !== plan.imageDigest) {
    throw new Error("observed host image does not match the runner plan");
  }
  const result = parseRunnerResult(input.resultText, {
    planDigest: job.planDigest,
    jobId: job.jobId,
    sourceArchiveDigest: plan.inputs.sourceArchiveDigest,
    manifestDigest: plan.inputs.manifestDigest,
    commandScopeDigest: plan.inputs.commandScopeDigest,
  });
  const parsedEvents = parseWrapperEvents(input.eventsText, {
    jobId: job.jobId,
    planDigest: job.planDigest,
    createdAt: plan.job.createdAt,
    expiresAt: plan.job.expiresAt,
    installEgressPolicyDigest: plan.egress.install.policyDigest,
  });
  const outputTreeDigest = input.outputTreeDigest ?? computeNormalizedTreeDigest(job.outputPath, input.treeOptions);
  if (outputTreeDigest !== parsedEvents.byName.output_ownership_revoked.detail) {
    throw new Error("independently observed output tree digest does not match wrapper evidence");
  }
  const runnerOutputIdentity = computeRunnerOutputIdentity(job.outputPath, plan.subject?.base?.sha);
  if (runnerOutputIdentity.regularTreeDigest !== result.outputTreeDigest) {
    throw new Error("independently observed runner output tree digest does not match runner result");
  }
  if (runnerOutputIdentity.candidateTreeSha !== result.output.candidateTreeSha) {
    throw new Error("independently observed candidate Git tree does not match runner result");
  }
  if (parsedEvents.byName.offline_verification_finished.detail !== sha256(Buffer.from(input.resultText, "utf8")) ||
      parsedEvents.byName.output_sealed.detail !== result.output.artifactDigest) {
    throw new Error("runner result does not match wrapper output evidence");
  }
  const l7 = validateL7IntegrationStatus(input.l7IntegrationStatus, {
    jobId: job.jobId,
    planDigest: job.planDigest,
  });
  const renderedAt = timestamp(input.renderedAt, "systemd unit render time");
  if (renderedAt !== job.unitRenderedAt || job.runtimeMaxMs !== plan.job.expiresAt - renderedAt) {
    throw new Error("job descriptor does not bind the exact rendered unit deadline");
  }
  const snapshot = validateLiveSnapshot(input.snapshot, {
    invocationId: parsedEvents.invocationId,
    renderedAt,
    expiresAt: plan.job.expiresAt,
    executionFinishedAt: parsedEvents.byName.output_sealed.observedAt,
  });
  if (snapshot.teardown.observedAt < parsedEvents.byName.wrapper_teardown_complete.observedAt) {
    throw new Error("independent teardown observation predates wrapper teardown");
  }
  if (profile.deploymentEvidence.observedAt > snapshot.capturedAt) {
    throw new Error("host deployment evidence was observed after the runner snapshot");
  }
  const profileCanonical = canonicalJson(profile);
  const containerSet = deriveRunnerContainerSet(job.jobId);
  return {
    schemaVersion: 1,
    kind: "api_migrator_runner_observation",
    unsigned: true,
    linuxDrillRequired: true,
    observationMode: "contract_fixture",
    jobId: job.jobId,
    planDigest: job.planDigest,
    systemdInvocation: parsedEvents.invocationId,
    observedAt: snapshot.capturedAt,
    host: {
      hostId: profile.hostId,
      profileDigest: sha256(Buffer.from(profileCanonical, "utf8")),
      deploymentEvidenceReference: profile.deploymentEvidence.reference,
      deploymentEvidenceDigest: profile.deploymentEvidence.digest,
    },
    systemd: snapshot.systemd,
    execution: {
      startedAt: parsedEvents.byName.offline_preparation_started.observedAt,
      finishedAt: parsedEvents.byName.output_sealed.observedAt,
      imageDigest: plan.imageDigest,
      containerSet,
      containerSetDigest: sha256(Buffer.from(canonicalJson(containerSet), "utf8")),
      installEgressPolicyDigest: plan.egress.install.policyDigest,
      nftablesRulesetDigest: parsedEvents.byName.nftables_policy_installed.detail,
      preparationLogDigest: parsedEvents.byName.offline_preparation_finished.detail,
      installLogDigest: parsedEvents.byName.dependency_install_finished.detail,
      migrationLogDigest: parsedEvents.byName.offline_migration_finished.detail,
      aggregateChecksLogDigest: parsedEvents.byName.offline_checks_finished.detail,
      wrapperEventsDigest: sha256(Buffer.from(input.eventsText, "utf8")),
      runnerResultDigest: sha256(Buffer.from(input.resultText, "utf8")),
      l7Gateway: {
        profile: l7.gatewayProfile,
        targetOrigin: l7.targetOrigin,
        integrationStatus: l7.integrationStatus,
        receiptValidation: l7.receiptValidation,
        liveActivation: l7.liveActivation,
        linuxLifecycleDrillRequired: l7.linuxLifecycleDrillRequired,
        blockReason: l7.blockReason,
      },
    },
    output: {
      preflightId: result.output.preflightId,
      artifactDigest: result.output.artifactDigest,
      candidateTreeSha: result.output.candidateTreeSha,
      normalizedTreeDigest: outputTreeDigest,
    },
    teardown: snapshot.teardown,
  };
}

export function buildUnsignedSigningRequest(observation) {
  const canonicalObservation = canonicalJson(observation);
  const request = {
    schemaVersion: 1,
    kind: "api_migrator_runner_attestation_signing_request",
    unsigned: true,
    externalSignerVerificationRequired: true,
    eligibleForExternalSigning: false,
    authorizationStatus: HOST_CONTRACT_AUTHORIZATION_STATUS,
    requestedAttestationProfile: RUNNER_PROFILE,
    signingDomain: SIGNING_DOMAIN,
    jobId: observation.jobId,
    planDigest: observation.planDigest,
    observationDigest: sha256(Buffer.from(canonicalObservation, "utf8")),
    observation,
  };
  const serialized = canonicalJson(request);
  if (/private.?key|"signature"|BEGIN [A-Z ]*PRIVATE KEY/i.test(serialized)) {
    throw new Error("unsigned signing request contains forbidden signing material");
  }
  return { request, canonicalJson: serialized, observationCanonicalJson: canonicalObservation };
}

export function collectLiveSnapshot(input) {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("live runner observation requires Linux root execution");
  }
  for (const name of SENSITIVE_OBSERVER_ENV) {
    if (Object.hasOwn(process.env, name)) throw new Error("observer environment contains forbidden signing or credential material");
  }
  const job = validateJobDescriptor(input.job);
  const profile = validateHostProfile(input.profile);
  verifyRootSealedJobFiles(input.jobDescriptorPath, job);
  verifyBoundFiles(profile);
  const systemctl = profile.executables.systemctl.path;
  const properties = parseSystemctlProperties(runChecked(systemctl, [
    "show", RUNNER_UNIT, "--no-pager",
    "--property=Id", "--property=InvocationID", "--property=Type", "--property=RemainAfterExit",
    "--property=ActiveState", "--property=SubState", "--property=Result", "--property=ExecMainCode",
    "--property=ExecMainStatus", "--property=KillMode", "--property=OOMPolicy", "--property=Delegate",
    "--property=TimeoutStartUSec", "--property=TimeoutStartFailureMode", "--property=TimeoutStopUSec",
    "--property=TimeoutStopFailureMode", "--property=ControlGroup",
  ]));
  const controlGroup = properties.ControlGroup;
  if (typeof controlGroup !== "string" || !/^\/[A-Za-z0-9_.@/-]+$/.test(controlGroup)) {
    throw new Error("systemd returned an invalid runner control group");
  }
  const cgroupPath = `/sys/fs/cgroup${controlGroup}`;
  const cgroupProcs = readFileSync(join(cgroupPath, "cgroup.procs"), "utf8").trim();
  const cgroupEvents = readFileSync(join(cgroupPath, "cgroup.events"), "utf8");
  if (cgroupProcs !== "" || !/(?:^|\n)populated 0(?:\n|$)/.test(cgroupEvents)) {
    throw new Error("runner control group is not independently quiescent");
  }
  const uid = profile.runner.uid;
  const runnerUidIdle = !uidOwnsProcess(uid);
  const table = `api_migrator_${job.jobId.slice(11, 27)}`;
  const nftables = JSON.parse(runChecked(profile.executables.nft.path, ["-j", "list", "tables"]));
  if (!Array.isArray(nftables.nftables)) throw new Error("nft returned an invalid tables document");
  const nftablesTableAbsent = !nftables.nftables.some((entry) =>
    entry?.table?.family === "inet" && entry.table.name === table
  );
  const workspaceAbsent = !readdirSync("/var/tmp").some((name) => name.startsWith("api-migrator-preview."));
  const networkNamespacesAbsent = networkNamespaceDirectoriesEmpty(uid);
  const now = input.now ?? Date.now();
  return {
    schemaVersion: 1,
    kind: "api_migrator_runner_live_snapshot",
    capturedAt: now,
    systemd: {
      unitName: properties.Id,
      invocationId: properties.InvocationID,
      serviceType: properties.Type,
      remainAfterExit: properties.RemainAfterExit === "yes",
      activeState: properties.ActiveState,
      subState: properties.SubState,
      result: properties.Result,
      execMainCode: Number(properties.ExecMainCode),
      execMainStatus: Number(properties.ExecMainStatus),
      killMode: properties.KillMode,
      oomPolicy: properties.OOMPolicy,
      delegate: properties.Delegate === "yes",
      timeoutStartUSec: parseSystemdDurationUSec(properties.TimeoutStartUSec, "systemd activation timeout"),
      timeoutStartFailureMode: properties.TimeoutStartFailureMode,
      timeoutStopUSec: parseSystemdDurationUSec(properties.TimeoutStopUSec, "systemd stop timeout"),
      timeoutStopFailureMode: properties.TimeoutStopFailureMode,
      controlGroup,
      cgroupEmpty: true,
    },
    teardown: {
      runnerUidIdle,
      containersAbsent: runnerUidIdle && cgroupProcs === "",
      networkNamespacesAbsent,
      nftablesTableAbsent,
      workspaceAbsent,
      observedAt: now,
    },
  };
}

export function readDeploymentInputs(jobPath) {
  const jobText = readBoundedFile(jobPath, MAX_DESCRIPTOR_BYTES, "job descriptor");
  const job = validateJobDescriptor(parseJson(jobText, "job descriptor", MAX_DESCRIPTOR_BYTES));
  if (dirname(jobPath) !== dirname(job.planPath)) {
    throw new Error("job descriptor is not in the exact sealed job root");
  }
  const profile = validateHostProfile(parseJson(
    readBoundedFile(job.hostProfilePath, MAX_PROFILE_BYTES, "host profile"),
    "host profile",
    MAX_PROFILE_BYTES
  ));
  const planText = readBoundedFile(job.planPath, MAX_PLAN_BYTES, "runner plan");
  const l7IntegrationStatus = validateL7IntegrationStatus(parseJson(
    readBoundedFile(job.l7IntegrationStatusPath, MAX_L7_BYTES, "L7 gateway integration status"),
    "L7 gateway integration status",
    MAX_L7_BYTES
  ), { jobId: job.jobId, planDigest: job.planDigest });
  return { job, profile, planText, l7IntegrationStatus };
}

export function writeExclusiveEvidence(path, contents) {
  if (!absolutePath(path, "evidence output path") || existsSync(path)) {
    throw new Error("evidence output path must not already exist");
  }
  const parent = dirname(path);
  if (realpathSync(parent) !== parent) throw new Error("evidence output parent is not canonical");
  const parentStat = statSync(parent);
  if (process.platform === "linux" && (parentStat.uid !== 0 || (parentStat.mode & 0o022) !== 0)) {
    throw new Error("evidence output parent is not root-owned and sealed");
  }
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, contents, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertNoExtendedMetadata(path, pythonPath) {
  const program = [
    "import os,sys",
    "root=sys.argv[1]",
    "for directory,names,files in os.walk(root,topdown=True,followlinks=False):",
    "  for path in [directory,*[os.path.join(directory,n) for n in [*names,*files]]]:",
    "    if os.path.islink(path) or os.listxattr(path,follow_symlinks=False): raise SystemExit(1)",
  ].join("\n");
  const result = spawnSync(pythonPath, ["-I", "-S", "-c", program, path], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error("sealed output contains links or extended metadata");
}

function verifyBoundFiles(profile) {
  const bindings = [
    ...Object.values(profile.executables),
    { path: profile.artifacts.wrapperPath, digest: profile.artifacts.wrapperDigest },
    { path: profile.artifacts.cleanupPath, digest: profile.artifacts.cleanupDigest },
    { path: profile.artifacts.observerPath, digest: profile.artifacts.observerDigest },
  ];
  for (const binding of bindings) {
    const info = lstatSync(binding.path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
        sha256(readFileSync(binding.path)) !== binding.digest) {
      throw new Error(`deployed host file does not match its root-sealed profile: ${basename(binding.path)}`);
    }
  }
  const storage = lstatSync(profile.runner.storageRoot);
  if (!storage.isDirectory() || storage.isSymbolicLink() || storage.uid !== profile.runner.uid ||
      (storage.mode & 0o077) !== 0) {
    throw new Error("runner storage root does not match its dedicated identity profile");
  }
}

function uidOwnsProcess(uid) {
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    try {
      if (statSync(`/proc/${name}`).uid === uid) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

function networkNamespaceDirectoriesEmpty(uid) {
  for (const path of ["/run/netns", `/run/user/${uid}/netns`]) {
    if (!existsSync(path)) continue;
    if (readdirSync(path).length !== 0) return false;
  }
  return true;
}

function parseSystemctlProperties(text) {
  const output = {};
  for (const line of text.trimEnd().split("\n")) {
    const offset = line.indexOf("=");
    if (offset <= 0) throw new Error("systemctl returned malformed property output");
    const key = line.slice(0, offset);
    if (Object.hasOwn(output, key)) throw new Error("systemctl returned a duplicate property");
    output[key] = line.slice(offset + 1);
  }
  const expected = [
    "Id", "InvocationID", "Type", "RemainAfterExit", "ActiveState", "SubState", "Result",
    "ExecMainCode", "ExecMainStatus", "KillMode", "OOMPolicy", "Delegate", "TimeoutStartUSec",
    "TimeoutStartFailureMode", "TimeoutStopUSec", "TimeoutStopFailureMode", "ControlGroup",
  ];
  exactKeys(output, expected, "systemctl property output");
  return output;
}

export function parseSystemdDurationUSec(value, label = "systemd duration") {
  if (typeof value !== "string" || value === "" || value === "infinity") {
    throw new Error(`${label} is not finite`);
  }
  const multipliers = new Map([
    ["us", 1],
    ["ms", 1_000],
    ["s", 1_000_000],
    ["min", 60_000_000],
    ["h", 3_600_000_000],
    ["d", 86_400_000_000],
  ]);
  let total = 0;
  for (const token of value.split(" ")) {
    const match = /^(0|[1-9][0-9]*)(us|ms|s|min|h|d)$/.exec(token);
    if (!match) throw new Error(`${label} has unsupported systemd syntax`);
    const amount = Number(match[1]);
    const component = amount * multipliers.get(match[2]);
    if (!Number.isSafeInteger(component) || !Number.isSafeInteger(total + component)) {
      throw new Error(`${label} exceeds the supported range`);
    }
    total += component;
  }
  if (total <= 0) throw new Error(`${label} must be positive`);
  return total;
}

function runChecked(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`trusted host command failed: ${basename(command)}`);
  }
  return result.stdout;
}

export function readBoundedFile(path, maxBytes, label) {
  absolutePath(path, label);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync(path) !== path) {
    throw new Error(`${label} is not a canonical single-link regular file`);
  }
  const value = readFileSync(path);
  if (value.length === 0 || value.length > maxBytes) throw new Error(`${label} is empty or oversized`);
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) throw new Error(`${label} is not exact UTF-8`);
  return text;
}

function verifyRootSealedJobFiles(jobDescriptorPath, job) {
  absolutePath(jobDescriptorPath, "live job descriptor path");
  const paths = [
    [jobDescriptorPath, "job descriptor", true],
    [job.planPath, "runner plan", true],
    [job.sourceArchivePath, "source archive", true],
    [job.hostProfilePath, "host profile", false],
    [job.l7IntegrationStatusPath, "L7 gateway integration status", true],
    [job.rawEventsPath, "wrapper events", true],
    [job.runnerResultPath, "runner result", true],
  ];
  for (const [path, label, ownerOnly] of paths) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0 ||
        (info.mode & (ownerOnly ? 0o077 : 0o022)) !== 0 || realpathSync(path) !== path) {
      throw new Error(`${label} is not a root-sealed canonical file`);
    }
    let ancestor = dirname(path);
    while (true) {
      const ancestorInfo = lstatSync(ancestor);
      if (!ancestorInfo.isDirectory() || ancestorInfo.isSymbolicLink() || ancestorInfo.uid !== 0 ||
          (ancestorInfo.mode & 0o022) !== 0) {
        throw new Error(`${label} has an unsealed ancestor`);
      }
      if (ancestor === "/") break;
      ancestor = dirname(ancestor);
    }
  }
}

function validateFileBinding(value, label) {
  const root = record(value, label);
  exactKeys(root, ["path", "digest"], label);
  absolutePath(root.path, `${label} path`);
  digest(root.digest, `${label} digest`);
}

function validateSubid(value, label) {
  const root = record(value, label);
  exactKeys(root, ["start", "count"], label);
  if (!Number.isSafeInteger(root.start) || root.start < 65_536 ||
      !Number.isSafeInteger(root.count) || root.count < 65_536 || root.count > 1_048_576 ||
      root.start + root.count - 1 > 2_147_483_647) {
    throw new Error(`${label} range is invalid`);
  }
}

function exactKeys(root, expected, label) {
  const actual = Object.keys(root).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unexpected fields`);
  }
}

function record(value, label) {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  canonicalJson(value);
  return value;
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !PATH.test(value) || value.length > 1024 ||
      value.includes("//") || value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`${label} is not a supported absolute path`);
  }
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMESTAMP) throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${label} is invalid`);
  return value;
}

function reference(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 6 ||
      Buffer.byteLength(value, "utf8") > 500 || REFERENCE_CONTROL.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function identifier(value, label) {
  boundedToken(value, label, /^[A-Za-z0-9][A-Za-z0-9._:@+-]{5,127}$/);
}

function accountName(value, label) {
  boundedToken(value, label, /^[a-z_][a-z0-9_-]{1,30}$/);
}

function boundedToken(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown error";
}
