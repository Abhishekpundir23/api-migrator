#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, release } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  renderGatewayDeployment,
} from "../gateway/gateway-contract.mjs";
import {
  HOSTED_SMOKE_EVENT_ORDER,
  HOSTED_SMOKE_SCENARIO_MATRIX,
  buildHostedSmokeEventStream,
  buildHostedSmokeScenarioReport,
} from "./hosted-lifecycle-smoke.mjs";
import {
  HOSTED_SMOKE_GATEWAY_UID,
  HOSTED_SMOKE_LISTENER_PORT,
  HOSTED_SMOKE_RUNNER_UID,
  buildHostedSmokeOwnershipMarker,
  deriveHostedSmokeResources,
  validateHostedSmokeOwnershipMarker,
} from "./hosted-smoke-runtime.mjs";

const USAGE = "usage: run-hosted-smoke.mjs --scenario NAME --output-dir ABSOLUTE_PATH";
const EXPECTED_ENVOY_DIGEST = "sha256:7af83300cd615004f8b8fe58954705014c92754c5b68a1edf0dba1f3e9cc9920";
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_CGROUP_DIRECTORIES = 128;
const PLAN_MAX_MS = 14 * 60 * 1000;
const DNS_MIN_TTL_SECONDS = 75;
const DNS_REFRESH_WAIT_MAX_MS = 90_000;
const HOSTED_SMOKE_RUNNER_ACCOUNT = "api-migrator-smoke-runner";
const HOSTED_SMOKE_GATEWAY_ACCOUNT = "api-migrator-smoke-gateway";
const TOOL_SPECS = Object.freeze({
  nft: ["/usr/sbin/nft", "/usr/bin/nft"],
  ss: ["/usr/bin/ss", "/usr/sbin/ss"],
  systemctl: ["/usr/bin/systemctl", "/bin/systemctl"],
  systemdRun: ["/usr/bin/systemd-run", "/bin/systemd-run"],
  journalctl: ["/usr/bin/journalctl", "/bin/journalctl"],
  setpriv: ["/usr/bin/setpriv", "/bin/setpriv"],
  ip: ["/usr/sbin/ip", "/usr/bin/ip"],
});
const NFT_COMMENTS = Object.freeze({
  redirect: "api-migrator force runner through gateway",
  runnerV4: "api-migrator runner to IPv4 gateway",
  runnerV6: "api-migrator runner to IPv6 gateway",
  runnerReject: "api-migrator reject runner direct egress",
  gatewayV4: "api-migrator gateway to exact npm IPv4",
  gatewayV6: "api-migrator gateway to exact npm IPv6",
  gatewayReject: "api-migrator reject gateway non-npm egress",
});

export function parseHostedSmokeCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "--scenario" || argv[2] !== "--output-dir") {
    throw new Error(USAGE);
  }
  const scenario = argv[1];
  const outputDir = argv[3];
  const broadOutput = new Set(["/", "/tmp", "/var", "/var/tmp", "/run", "/run/api-migrator-hosted-smoke"]);
  if (!HOSTED_SMOKE_SCENARIO_MATRIX.some(({ name }) => name === scenario) ||
      typeof outputDir !== "string" || !isAbsolute(outputDir) || resolve(outputDir) !== outputDir ||
      !/^\/[A-Za-z0-9._/-]+$/.test(outputDir) || broadOutput.has(outputDir)) {
    throw new Error(USAGE);
  }
  return Object.freeze({ scenario, outputDir });
}

export function parseHostedSmokeEnvironment(environment) {
  const env = environment ?? {};
  const exact = (name, pattern) => {
    const value = env[name];
    if (typeof value !== "string" || !pattern.test(value)) throw new Error(`hosted smoke ${name} is missing or invalid`);
    return value;
  };
  const runAttemptText = exact("API_MIGRATOR_SMOKE_RUN_ATTEMPT", /^[1-9][0-9]{0,9}$/);
  const runAttempt = Number(runAttemptText);
  return Object.freeze({
    runId: exact("API_MIGRATOR_SMOKE_RUN_ID", /^[1-9][0-9]{0,19}$/),
    runAttempt,
    sourceRevision: exact("API_MIGRATOR_SMOKE_SOURCE_REVISION", /^[a-f0-9]{40}$/),
    repository: exact("API_MIGRATOR_SMOKE_REPOSITORY", /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    workflowRef: exact("API_MIGRATOR_SMOKE_WORKFLOW_REF", /^[A-Za-z0-9._/@+-]{1,500}$/),
    imageVersion: exact("API_MIGRATOR_SMOKE_IMAGE_VERSION", /^[A-Za-z0-9._+-]{1,100}$/),
    envoyPath: exact("API_MIGRATOR_HOSTED_ENVOY_PATH", /^\/[A-Za-z0-9._/+:-]+$/),
  });
}

export function parseNftCounterSnapshot(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error("hosted smoke nftables snapshot is invalid or excessive");
  }
  const counters = Object.fromEntries(Object.keys(NFT_COMMENTS).map((name) => [name, 0]));
  for (const [name, comment] of Object.entries(NFT_COMMENTS)) {
    const escaped = comment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expressions = [
      new RegExp(`counter packets ([0-9]+) bytes [0-9]+[^\\n]*comment \\"${escaped}\\"`),
      new RegExp(`comment \\"${escaped}\\"[^\\n]*counter packets ([0-9]+) bytes [0-9]+`),
    ];
    const match = expressions.map((expression) => expression.exec(text)).find(Boolean);
    if (!match) throw new Error(`hosted smoke nftables snapshot is missing counter: ${comment}`);
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("hosted smoke nftables counter is invalid");
    counters[name] = value;
  }
  return Object.freeze(counters);
}

export function nftCounterDelta(before, after, name) {
  if (!(name in NFT_COMMENTS) || !Number.isSafeInteger(before?.[name]) || !Number.isSafeInteger(after?.[name])) {
    throw new Error("hosted smoke nftables counter delta input is invalid");
  }
  const delta = after[name] - before[name];
  if (delta < 0) throw new Error("hosted smoke nftables counter moved backwards");
  return delta;
}

export async function resolveHostedNpmOrigin(options = {}) {
  const resolver = options.resolver ?? resolve4;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const deadline = now() + DNS_REFRESH_WAIT_MAX_MS;
  let attempts = 0;
  while (true) {
    attempts += 1;
    const observedAt = now();
    const answer = await resolver("registry.npmjs.org", { ttl: true });
    if (!Array.isArray(answer) || answer.length < 1 || answer.length > 32) {
      throw new Error("hosted smoke npm DNS resolution is missing or excessive");
    }
    const addresses = [...new Set(answer.map(({ address }) => address))].sort();
    const minimumTtlSeconds = Math.min(...answer.map(({ ttl }) => ttl));
    if (addresses.length >= 1 && addresses.length <= 32 && Number.isSafeInteger(minimumTtlSeconds) &&
        minimumTtlSeconds >= DNS_MIN_TTL_SECONDS) {
      return Object.freeze({ addresses, minimumTtlSeconds, observedAt, attempts });
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0 || attempts >= 100) {
      throw new Error("hosted smoke npm DNS resolution never provided a bounded active plan window");
    }
    await sleep(Math.min(5_000, remainingMs));
  }
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function runCommand(path, args, options = {}) {
  const result = spawnSync(path, args, {
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? 30_000,
    cwd: "/",
    env: options.env ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error(`hosted smoke command output is excessive: ${basename(path)}`);
  }
  if (result.error || (!options.allowFailure && result.status !== 0)) {
    throw new Error(`hosted smoke command failed: ${basename(path)} ${args.join(" ")} (${result.error?.message ?? stderr.trim() ?? result.status})`);
  }
  return Object.freeze({ status: result.status ?? 1, stdout, stderr });
}

function findTool(candidates, label) {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const path = realpathSync(candidate);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) continue;
    return path;
  }
  throw new Error(`hosted smoke ${label} executable is unavailable or writable`);
}

function normalizedVersion(path, args = ["--version"]) {
  const result = runCommand(path, args, { allowFailure: true });
  const value = `${result.stdout}\n${result.stderr}`.trim().replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ");
  if (result.status !== 0 || value.length < 1 || Buffer.byteLength(value, "utf8") > 512) {
    throw new Error(`hosted smoke could not bind ${basename(path)} version`);
  }
  return value;
}

function buildToolInventory(envoyPath) {
  const nodePath = realpathSync(process.execPath);
  const exactEnvoyPath = realpathSync(envoyPath);
  for (const [name, path] of [["node", nodePath], ["envoy", exactEnvoyPath]]) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
      throw new Error(`hosted smoke ${name} executable is not root sealed`);
    }
  }
  const paths = { node: nodePath, envoy: exactEnvoyPath };
  for (const [name, candidates] of Object.entries(TOOL_SPECS)) paths[name] = findTool(candidates, name);
  const args = {
    nft: ["--version"], ss: ["--version"], systemctl: ["--version"],
    systemdRun: ["--version"], journalctl: ["--version"], setpriv: ["--version"], ip: ["-V"],
  };
  const tools = {};
  for (const [name, path] of Object.entries(paths)) {
    const bytes = readFileSync(path);
    tools[name] = {
      path,
      digest: sha256Bytes(bytes),
      version: normalizedVersion(path, args[name] ?? ["--version"]),
    };
  }
  if (tools.envoy.digest !== EXPECTED_ENVOY_DIGEST) throw new Error("hosted smoke Envoy binary digest is not pinned v1.39.0");
  return Object.freeze({ tools: Object.freeze(tools), paths: Object.freeze(paths) });
}

function ensureOutputDirectory(path) {
  const broad = new Set(["/", "/tmp", "/var", "/var/tmp", "/run", "/run/api-migrator-hosted-smoke"]);
  if (broad.has(path) || !existsSync(path)) throw new Error("hosted smoke output directory is broad or absent");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("hosted smoke output directory is not the exact root-owned 0700 directory");
  }
  const evidenceDir = join(path, "evidence");
  mkdirSync(evidenceDir, { mode: 0o700 });
  return evidenceDir;
}

function createEvidenceWriter(evidenceDir) {
  const entries = [];
  return {
    write(label, value) {
      const name = `${String(entries.length + 1).padStart(2, "0")}-${label.replace(/[^A-Za-z0-9._-]/g, "-")}.txt`;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
      if (bytes.length < 1 || bytes.length > MAX_EVIDENCE_BYTES) throw new Error(`hosted smoke ${label} evidence is missing or excessive`);
      const path = join(evidenceDir, name);
      writeFileSync(path, bytes, { flag: "wx", mode: 0o644 });
      const digest = sha256Bytes(bytes);
      entries.push({ name, digest, size: bytes.length });
      return digest;
    },
    manifest() { return structuredClone(entries); },
  };
}

function assertLinuxHostedRoot() {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("hosted smoke requires a Linux root process");
  }
  if (readFileSync("/proc/1/comm", "utf8").trim() !== "systemd" || !existsSync("/sys/fs/cgroup/cgroup.controllers")) {
    throw new Error("hosted smoke requires systemd and cgroup v2");
  }
}

function readOsRelease() {
  const values = {};
  for (const line of readFileSync("/etc/os-release", "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  if (values.ID !== "ubuntu" || values.VERSION_ID !== "24.04") throw new Error("hosted smoke requires Ubuntu 24.04");
  return values;
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`hosted smoke timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

function pidsForUid(uid) {
  const pids = [];
  for (const value of readdirSync("/proc").filter((entry) => /^[0-9]+$/.test(entry))) {
    const statusPath = `/proc/${value}/status`;
    try {
      const match = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)/m.exec(readFileSync(statusPath, "utf8"));
      if (!match) throw new Error("hosted smoke process UID status is malformed");
      if (match.slice(1).some((entry) => Number(entry) === uid)) pids.push(Number(value));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return pids.sort((left, right) => left - right);
}

export function validateHostedSmokeAccounts(passwdText, groupText) {
  if (typeof passwdText !== "string" || typeof groupText !== "string") {
    throw new Error("hosted smoke account databases are invalid");
  }
  const passwdEntries = passwdText.split("\n").filter(Boolean).map((line) => line.split(":"));
  const groupEntries = groupText.split("\n").filter(Boolean).map((line) => line.split(":"));
  for (const [name, uid] of [
    [HOSTED_SMOKE_RUNNER_ACCOUNT, HOSTED_SMOKE_RUNNER_UID],
    [HOSTED_SMOKE_GATEWAY_ACCOUNT, HOSTED_SMOKE_GATEWAY_UID],
  ]) {
    const uidText = String(uid);
    const passwdMatches = passwdEntries.filter((entry) => entry[0] === name || entry[2] === uidText);
    const groupMatches = groupEntries.filter((entry) => entry[0] === name || entry[2] === uidText);
    if (passwdMatches.length !== 1 || groupMatches.length !== 1 ||
        passwdMatches[0].length !== 7 || groupMatches[0].length !== 4 ||
        passwdMatches[0][0] !== name || passwdMatches[0][1] !== "x" ||
        passwdMatches[0][2] !== uidText || passwdMatches[0][3] !== uidText ||
        passwdMatches[0][4] !== "" || passwdMatches[0][5] !== "/nonexistent" ||
        passwdMatches[0][6] !== "/usr/sbin/nologin" ||
        groupMatches[0][0] !== name || groupMatches[0][1] !== "x" ||
        groupMatches[0][2] !== uidText || groupMatches[0][3] !== "") {
      throw new Error(`hosted smoke ${name} account is missing, duplicated, or substituted`);
    }
  }
  return Object.freeze({
    runner: Object.freeze({ name: HOSTED_SMOKE_RUNNER_ACCOUNT, uid: HOSTED_SMOKE_RUNNER_UID, gid: HOSTED_SMOKE_RUNNER_UID }),
    gateway: Object.freeze({ name: HOSTED_SMOKE_GATEWAY_ACCOUNT, uid: HOSTED_SMOKE_GATEWAY_UID, gid: HOSTED_SMOKE_GATEWAY_UID }),
  });
}

function unitSnapshot(systemctlPath, unit) {
  const result = runCommand(systemctlPath, [
    "show", unit, "--no-pager",
    "--property=LoadState", "--property=ActiveState", "--property=SubState",
    "--property=MainPID", "--property=InvocationID", "--property=ControlGroup",
    "--property=Result", "--property=ExecMainCode", "--property=ExecMainStatus",
  ]);
  const expectedNames = new Set([
    "LoadState", "ActiveState", "SubState", "MainPID", "InvocationID", "ControlGroup",
    "Result", "ExecMainCode", "ExecMainStatus",
  ]);
  const values = {};
  for (const line of result.stdout.trim().split("\n")) {
    const index = line.indexOf("=");
    const name = index > 0 ? line.slice(0, index) : "";
    if (!expectedNames.has(name) || Object.hasOwn(values, name)) {
      throw new Error(`hosted smoke ${unit} systemd observation is malformed`);
    }
    values[name] = line.slice(index + 1);
  }
  if (Object.keys(values).length !== expectedNames.size ||
      !new Set(["loaded", "not-found"]).has(values.LoadState) ||
      !new Set(["active", "inactive", "failed", "activating", "deactivating"]).has(values.ActiveState)) {
    throw new Error(`hosted smoke ${unit} systemd observation is incomplete or unsupported`);
  }
  return Object.freeze({ status: result.status, raw: result.stdout + result.stderr, values });
}

function tableSnapshot(nftPath, table, allowAbsent = false) {
  const inventory = runCommand(nftPath, ["-j", "list", "tables"]);
  let parsed;
  try { parsed = JSON.parse(inventory.stdout); } catch { throw new Error("hosted smoke nftables inventory is not JSON"); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.nftables)) {
    throw new Error("hosted smoke nftables inventory is malformed");
  }
  const matches = parsed.nftables.filter((entry) =>
    entry && typeof entry === "object" && entry.table && typeof entry.table === "object" &&
    entry.table.family === "inet" && entry.table.name === table
  );
  if (matches.length > 1) throw new Error("hosted smoke nftables inventory contains duplicate exact tables");
  if (matches.length === 0) {
    if (!allowAbsent) throw new Error("hosted smoke owned nftables table is absent");
    return Object.freeze({ exists: false, text: inventory.stdout });
  }
  const result = runCommand(nftPath, ["list", "table", "inet", table]);
  return Object.freeze({ exists: true, text: result.stdout });
}

function listenerSnapshot(ssPath, port) {
  const result = runCommand(ssPath, ["-H", "-ltnp", `sport = :${port}`], { allowFailure: true });
  if (result.status !== 0) throw new Error("hosted smoke could not inspect listener ownership");
  return result.stdout;
}

function assertNoResourceCollision(resources, tools) {
  validateHostedSmokeAccounts(readFileSync("/etc/passwd", "utf8"), readFileSync("/etc/group", "utf8"));
  if (existsSync(resources.runtimeRoot) || existsSync(resources.workspacePath)) {
    throw new Error("hosted smoke runtime root or workspace already exists");
  }
  for (const unit of [resources.gatewayUnit, resources.canaryUnit]) {
    const snapshot = unitSnapshot(tools.systemctl, unit);
    if (snapshot.values.LoadState && snapshot.values.LoadState !== "not-found") {
      throw new Error(`hosted smoke unit already exists: ${unit}`);
    }
  }
  if (pidsForUid(HOSTED_SMOKE_RUNNER_UID).length > 0 || pidsForUid(HOSTED_SMOKE_GATEWAY_UID).length > 0) {
    throw new Error("hosted smoke dedicated UID is already active");
  }
  if (tableSnapshot(tools.nft, resources.nftTable, true).exists) {
    throw new Error("hosted smoke nftables table already exists");
  }
  if (listenerSnapshot(tools.ss, HOSTED_SMOKE_LISTENER_PORT).trim() !== "") {
    throw new Error("hosted smoke listener port is already occupied");
  }
}

function createRootRuntime(resources) {
  mkdirSync(dirname(resources.runtimeRoot), { recursive: true, mode: 0o755 });
  const parent = lstatSync(dirname(resources.runtimeRoot));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.gid !== 0 || (parent.mode & 0o022) !== 0) {
    throw new Error("hosted smoke runtime parent is writable or substituted");
  }
  mkdirSync(resources.runtimeRoot, { mode: 0o700 });
  mkdirSync(dirname(resources.workspacePath), { recursive: true, mode: 0o755 });
  const workspaceParent = lstatSync(dirname(resources.workspacePath));
  if (!workspaceParent.isDirectory() || workspaceParent.isSymbolicLink() || workspaceParent.uid !== 0 ||
      workspaceParent.gid !== 0 || (workspaceParent.mode & 0o022) !== 0) {
    throw new Error("hosted smoke workspace parent is writable or substituted");
  }
  mkdirSync(resources.workspacePath, { mode: 0o700 });
  const ownership = buildHostedSmokeOwnershipMarker(resources);
  writeFileSync(resources.ownershipMarkerPath, ownership.canonicalJson, { flag: "wx", mode: 0o600 });
  validateHostedSmokeOwnershipMarker(JSON.parse(readFileSync(resources.ownershipMarkerPath, "utf8")), resources);
}

async function renderHostedGateway(resources, toolBindings, evidence) {
  const resolution = await resolveHostedNpmOrigin();
  const { addresses, minimumTtlSeconds, observedAt: resolutionObservedAt } = resolution;
  const createdAt = Date.now();
  const resolutionExpiresAt = resolutionObservedAt + Math.min(30 * 60 * 1000, minimumTtlSeconds * 1000);
  const expiresAt = Math.min(createdAt + PLAN_MAX_MS, resolutionExpiresAt);
  if (expiresAt - createdAt < 60_000) throw new Error("hosted smoke npm DNS resolution cannot bind a complete plan lifetime");
  const resolutionBytes = canonicalJson({ addresses, minimumTtlSeconds, resolutionObservedAt, resolutionExpiresAt, attempts: resolution.attempts });
  const resolutionEvidenceDigest = evidence.write("dns-resolution", resolutionBytes);
  const planDigest = sha256Bytes(Buffer.from(canonicalJson({
    schemaVersion: 1,
    kind: "api_migrator_github_hosted_l7_smoke_plan",
    suiteId: resources.suiteId,
    scenario: resources.scenario,
    jobId: resources.jobId,
    createdAt,
    expiresAt,
    releaseEvidenceEligible: false,
    activationBlocked: true,
  }), "utf8"));
  const contract = {
    schemaVersion: 1,
    profile: "static-envoy-sni-passthrough-v1",
    jobId: resources.jobId,
    plan: { digest: planDigest, createdAt, expiresAt },
    egressPolicyDigest: sha256Bytes(Buffer.from("github-hosted-smoke:forced-gateway-egress-v1", "utf8")),
    gatewayRuntimeDigest: toolBindings.envoy.digest,
    runnerUid: HOSTED_SMOKE_RUNNER_UID,
    gatewayUid: HOSTED_SMOKE_GATEWAY_UID,
    listener: { addresses: ["127.0.0.1", "::1"], port: HOSTED_SMOKE_LISTENER_PORT },
    origin: {
      host: "registry.npmjs.org",
      port: 443,
      addresses,
      resolutionEvidenceDigest,
      resolutionObservedAt,
      resolutionExpiresAt,
    },
  };
  const deployment = renderGatewayDeployment(contract);
  if (deployment.nftablesTable !== resources.nftTable) throw new Error("hosted smoke resource identity diverges from gateway contract");
  const contractPath = join(resources.workspacePath, "gateway-contract.json");
  const envoyConfigPath = join(resources.workspacePath, "envoy-config.json");
  const nftablesPolicyPath = join(resources.workspacePath, "gateway-policy.nft");
  writeFileSync(contractPath, deployment.canonicalJson, { flag: "wx", mode: 0o444 });
  writeFileSync(envoyConfigPath, deployment.envoyConfigJson, { flag: "wx", mode: 0o444 });
  writeFileSync(nftablesPolicyPath, deployment.nftablesPolicy, { flag: "wx", mode: 0o444 });
  chmodSync(contractPath, 0o444);
  chmodSync(envoyConfigPath, 0o444);
  chmodSync(nftablesPolicyPath, 0o444);
  chmodSync(resources.workspacePath, 0o555);
  return Object.freeze({ deployment, contractPath, envoyConfigPath, nftablesPolicyPath });
}

function toolEvidence(inventory, environment) {
  const osRelease = readOsRelease();
  const systemdVersion = inventory.tools.systemctl.version.match(/systemd\s+([0-9]+(?:\.[0-9]+)?)/)?.[1] ??
    inventory.tools.systemctl.version.match(/^([0-9]+(?:\.[0-9]+)?)/)?.[1];
  if (!systemdVersion) throw new Error("hosted smoke systemd version is unrecognized");
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9-]{36}$/.test(bootId)) throw new Error("hosted smoke boot identity is invalid");
  return Object.freeze({
    host: {
      provider: "github_hosted",
      runnerLabel: "ubuntu-24.04",
      osId: osRelease.ID,
      osVersion: osRelease.VERSION_ID,
      architecture: arch() === "x64" ? "x86_64" : arch(),
      dedicatedHost: false,
      selfAttested: true,
      imageVersion: environment.imageVersion,
      kernelRelease: release(),
      systemdVersion,
      cgroupVersion: 2,
      bootIdDigest: sha256Bytes(Buffer.from(bootId, "utf8")),
    },
    tools: inventory.tools,
  });
}

function nativeValidate(rendered, tools, evidence) {
  const envoy = runCommand(tools.envoy, ["--mode", "validate", "-c", rendered.envoyConfigPath], { timeoutMs: 30_000 });
  const nft = runCommand(tools.nft, ["-c", "-f", rendered.nftablesPolicyPath]);
  return Object.freeze({
    envoyEvidenceDigest: evidence.write("envoy-native-validation", envoy.stdout + envoy.stderr),
    nftablesEvidenceDigest: evidence.write("nftables-native-validation", nft.stdout + nft.stderr || "nftables validation passed"),
  });
}

function installPolicy(rendered, resources, tools, evidence) {
  runCommand(tools.nft, ["-f", rendered.nftablesPolicyPath]);
  const snapshot = tableSnapshot(tools.nft, resources.nftTable);
  if (sha256Bytes(Buffer.from(rendered.deployment.nftablesPolicy, "utf8")) !== rendered.deployment.nftablesPolicyDigest) {
    throw new Error("hosted smoke rendered nftables policy digest drifted before install");
  }
  return evidence.write("nftables-policy-installed", snapshot.text);
}

function gatewaySystemdArguments(resources, rendered, tools) {
  return [
    `--unit=${resources.gatewayUnit}`,
    "--collect",
    "--quiet",
    "--property=Type=exec",
    `--property=User=${HOSTED_SMOKE_GATEWAY_UID}`,
    `--property=Group=${HOSTED_SMOKE_GATEWAY_UID}`,
    "--property=NoNewPrivileges=yes",
    "--property=PrivateTmp=yes",
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=yes",
    "--property=RestrictSUIDSGID=yes",
    "--property=LockPersonality=yes",
    "--property=MemoryDenyWriteExecute=yes",
    "--property=RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=10s",
    "--property=StandardOutput=journal",
    "--property=StandardError=journal",
    tools.envoy,
    "--disable-hot-restart",
    "--concurrency", "1",
    "--log-level", "info",
    "-c", rendered.envoyConfigPath,
  ];
}

async function startGateway(resources, rendered, tools, evidence) {
  runCommand(tools.systemdRun, gatewaySystemdArguments(resources, rendered, tools));
  const identity = await waitFor(() => {
    const snapshot = unitSnapshot(tools.systemctl, resources.gatewayUnit);
    if (snapshot.values.ActiveState !== "active" || snapshot.values.SubState !== "running") return false;
    const pid = Number(snapshot.values.MainPID);
    if (!Number.isSafeInteger(pid) || pid < 2) return false;
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const uid = Number(/^Uid:\s+([0-9]+)/m.exec(status)?.[1]);
    if (uid !== HOSTED_SMOKE_GATEWAY_UID) throw new Error("gateway MainPID is owned by the wrong UID");
    const executable = realpathSync(`/proc/${pid}/exe`);
    if (executable !== tools.envoy || sha256Bytes(readFileSync(executable)) !== EXPECTED_ENVOY_DIGEST) {
      throw new Error("gateway MainPID executable is substituted");
    }
    const cgroupLine = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
    const cgroup = cgroupLine.split(":").at(-1);
    if (!cgroup || cgroup !== snapshot.values.ControlGroup) throw new Error("gateway MainPID cgroup is substituted");
    const namespace = readlinkSync(`/proc/${pid}/ns/net`);
    return Object.freeze({ pid, cgroup, namespace, invocationId: snapshot.values.InvocationID, snapshot });
  }, "the exact gateway process");
  const digest = evidence.write("gateway-start", canonicalJson({
    unit: resources.gatewayUnit,
    pid: identity.pid,
    cgroup: identity.cgroup,
    namespace: identity.namespace,
    invocationId: identity.invocationId,
    systemd: identity.snapshot.raw,
  }));
  return Object.freeze({ ...identity, evidenceDigest: digest });
}

async function waitForListener(identity, resources, tools, evidence) {
  const snapshot = await waitFor(() => {
    const text = listenerSnapshot(tools.ss, HOSTED_SMOKE_LISTENER_PORT);
    const pidToken = `pid=${identity.pid},`;
    const hasV4 = text.split("\n").some((line) => line.includes(`127.0.0.1:${HOSTED_SMOKE_LISTENER_PORT}`) && line.includes(pidToken));
    const hasV6 = text.split("\n").some((line) =>
      (line.includes(`[::1]:${HOSTED_SMOKE_LISTENER_PORT}`) || line.includes(`::1:${HOSTED_SMOKE_LISTENER_PORT}`)) && line.includes(pidToken));
    return hasV4 && hasV6 ? text : false;
  }, "both exact Envoy loopback listeners");
  return Object.freeze({
    snapshot,
    digest: evidence.write("gateway-listeners", snapshot),
  });
}

function runProbe(scenario, rendered, tools, timeoutMs = 15_000) {
  const probePath = realpathSync(new URL("../gateway/gateway-probe.mjs", import.meta.url));
  const expectedUid = scenario === "non_npm" ? HOSTED_SMOKE_GATEWAY_UID : HOSTED_SMOKE_RUNNER_UID;
  const result = runCommand(tools.setpriv, [
    `--reuid=${expectedUid}`,
    `--regid=${expectedUid}`,
    "--clear-groups",
    tools.node,
    probePath,
    "--scenario",
    scenario,
    rendered.contractPath,
  ], { timeoutMs });
  let parsed;
  try { parsed = JSON.parse(result.stdout.trim()); } catch { throw new Error(`hosted smoke ${scenario} probe did not emit JSON`); }
  if (parsed.scenario !== scenario || parsed.status !== "passed" || parsed.jobId !== rendered.deployment.contract.jobId) {
    throw new Error(`hosted smoke ${scenario} probe emitted substituted output`);
  }
  return Object.freeze({ result: parsed, raw: result.stdout + result.stderr });
}

function captureTableCounters(resources, tools, evidence, label) {
  const snapshot = tableSnapshot(tools.nft, resources.nftTable);
  return Object.freeze({
    counters: parseNftCounterSnapshot(snapshot.text),
    text: snapshot.text,
    digest: evidence.write(label, snapshot.text),
  });
}

function readGatewayJournal(resources, tools, evidence, label) {
  const result = runCommand(tools.journalctl, ["--boot", "--no-pager", "-o", "cat", "-u", resources.gatewayUnit]);
  const text = result.stdout + result.stderr || "journal empty";
  return Object.freeze({ text, digest: evidence.write(label, text) });
}

export function countMatchingAccessLogs(text, deployment) {
  let count = 0;
  for (const line of text.split("\n")) {
    try {
      const value = JSON.parse(line);
      const rawUpstream = String(value.upstream_host ?? "");
      const match = /^\[([0-9a-f:]+)\]:([0-9]+)$/.exec(rawUpstream) ?? /^([0-9.]+):([0-9]+)$/.exec(rawUpstream);
      const upstream = match?.[1];
      const upstreamPort = Number(match?.[2]);
      if (value.job_id === deployment.contract.jobId &&
          value.requested_server_name === "registry.npmjs.org" &&
          upstreamPort === 443 && deployment.contract.origin.addresses.includes(upstream)) {
        count += 1;
      }
    } catch {
      // Envoy/systemd diagnostic lines are retained as evidence but are not access records.
    }
  }
  return count;
}

async function runFaultScenario(name, resources, tools, evidence) {
  const baseArgs = [
    `--unit=${resources.canaryUnit}`,
    "--quiet", "--property=Type=exec",
    `--property=User=${HOSTED_SMOKE_RUNNER_UID}`,
    `--property=Group=${HOSTED_SMOKE_RUNNER_UID}`,
    "--property=NoNewPrivileges=yes",
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=2s",
  ];
  if (name === "timeout") baseArgs.push("--property=RuntimeMaxSec=1s");
  baseArgs.push(tools.node, "-e", "setInterval(() => {}, 1000)");
  runCommand(tools.systemdRun, baseArgs);
  await waitFor(() => unitSnapshot(tools.systemctl, resources.canaryUnit).values.ActiveState === "active", "fault canary start");
  if (name === "sigkill") runCommand(tools.systemctl, ["kill", "--kill-whom=all", "--signal=SIGKILL", resources.canaryUnit]);
  await waitFor(() => {
    const state = unitSnapshot(tools.systemctl, resources.canaryUnit).values.ActiveState;
    return state === "inactive" || state === "failed";
  }, `${name} fault completion`, 10_000);
  const snapshot = unitSnapshot(tools.systemctl, resources.canaryUnit);
  const expected = name === "timeout"
    ? { Result: "timeout", ExecMainCode: "2", ExecMainStatus: "15" }
    : { Result: "signal", ExecMainCode: "2", ExecMainStatus: "9" };
  for (const [property, value] of Object.entries(expected)) {
    if (snapshot.values[property] !== value) {
      throw new Error(`hosted smoke ${name} fault has unexpected ${property}`);
    }
  }
  if (!tableSnapshot(tools.nft, resources.nftTable).exists) {
    throw new Error(`hosted smoke containment disappeared during ${name} fault`);
  }
  return evidence.write(`${name}-fault-process`, canonicalJson({
    unit: resources.canaryUnit,
    result: snapshot.values.Result,
    execMainCode: snapshot.values.ExecMainCode,
    execMainStatus: snapshot.values.ExecMainStatus,
    containmentInstalled: true,
    systemd: snapshot.raw,
  }));
}

async function stopExactUnit(unit, tools) {
  const before = unitSnapshot(tools.systemctl, unit);
  const expectedCgroup = `/system.slice/${unit}`;
  if (before.values.ControlGroup && before.values.ControlGroup !== expectedCgroup) {
    throw new Error(`hosted smoke ${unit} cgroup is substituted`);
  }
  if (before.values.LoadState && before.values.LoadState !== "not-found" && before.values.ActiveState !== "inactive") {
    runCommand(tools.systemctl, ["stop", unit], { allowFailure: true, timeoutMs: 20_000 });
  }
  runCommand(tools.systemctl, ["reset-failed", unit], { allowFailure: true });
  const after = await waitFor(() => {
    const snapshot = unitSnapshot(tools.systemctl, unit);
    return snapshot.values.LoadState === "not-found" && cgroupIsAbsent(expectedCgroup) ? snapshot : false;
  }, `${unit} unload and cgroup removal`, 20_000);
  return Object.freeze({ before, after, cgroup: expectedCgroup, absent: true });
}

function createTimeline() {
  let last = 0;
  return Object.freeze({
    tick() {
      last = Math.max(Date.now(), last + 1);
      return last;
    },
  });
}

async function captureScenarioAfter(resources, rendered, tools, evidence, before, needsAccessLog) {
  if (needsAccessLog) {
    await waitFor(() => {
      const journal = runCommand(tools.journalctl, ["--boot", "--no-pager", "-o", "cat", "-u", resources.gatewayUnit]);
      return countMatchingAccessLogs(journal.stdout, rendered.deployment) > before.accessCount;
    }, "correlated Envoy access log", 8_000);
  } else {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const counters = captureTableCounters(resources, tools, evidence, "scenario-counters-after");
  const journal = readGatewayJournal(resources, tools, evidence, "scenario-journal-after");
  return Object.freeze({
    ...counters,
    journal,
    accessCount: countMatchingAccessLogs(journal.text, rendered.deployment),
  });
}

async function executeOnlineScenario(name, resources, rendered, tools, evidence, listenerDigest, timeline) {
  const beforeCounters = captureTableCounters(resources, tools, evidence, "scenario-counters-before");
  const beforeJournal = readGatewayJournal(resources, tools, evidence, "scenario-journal-before");
  const before = {
    ...beforeCounters,
    journal: beforeJournal,
    accessCount: countMatchingAccessLogs(beforeJournal.text, rendered.deployment),
  };
  let actionEvidenceDigest;
  let faultEvidenceDigest;
  if (["success", "wrong_sni", "absent_sni", "plaintext", "direct_bypass", "non_443", "non_npm"].includes(name)) {
    const probeName = name === "success" ? "correct_sni" : name;
    const result = runProbe(probeName, rendered, tools);
    actionEvidenceDigest = evidence.write(`${name}-probe`, result.raw);
  } else if (name === "timeout" || name === "sigkill") {
    faultEvidenceDigest = await runFaultScenario(name, resources, tools, evidence);
    actionEvidenceDigest = faultEvidenceDigest;
  } else {
    actionEvidenceDigest = evidence.write(`${name}-online-noop`, canonicalJson({ name, status: "deferred_to_teardown" }));
  }
  const after = await captureScenarioAfter(
    resources,
    rendered,
    tools,
    evidence,
    before,
    name === "success" || name === "direct_bypass"
  );
  const observedAt = timeline.tick();
  const gatewayDelta = nftCounterDelta(before.counters, after.counters, "gatewayV4") +
    nftCounterDelta(before.counters, after.counters, "gatewayV6");
  const loopbackDelta = nftCounterDelta(before.counters, after.counters, "runnerV4") +
    nftCounterDelta(before.counters, after.counters, "runnerV6");
  const accessDelta = after.accessCount - before.accessCount;
  let proof;
  switch (name) {
    case "success":
      proof = {
        type: "positive_route", correctSni: true, tcpConnectedToOwnedListener: true,
        tlsAuthorized: true, httpPingPassed: true,
        runnerLoopbackCounterDelta: loopbackDelta,
        gatewayUpstreamCounterDelta: gatewayDelta,
        envoyAccessLogMatches: accessDelta,
        listenerSnapshotDigest: listenerDigest,
        counterSnapshotBeforeDigest: before.digest,
        counterSnapshotAfterDigest: after.digest,
        accessLogDigest: after.journal.digest,
      };
      break;
    case "timeout":
    case "sigkill":
      proof = {
        type: "fault_teardown", fault: name, workloadStarted: true, faultObserved: true,
        containmentInstalledAtFault: true, processEvidenceDigest: faultEvidenceDigest,
      };
      break;
    case "wrong_sni":
    case "absent_sni":
      proof = {
        type: "sni_rejection", sni: name === "wrong_sni" ? "wrong" : "absent",
        tcpConnectedToOwnedListener: true, listenerOwnedByGatewayUid: true,
        deniedAfterTcpConnect: true, tlsHandshakeSucceeded: false,
        runnerLoopbackCounterDelta: loopbackDelta,
        gatewayUpstreamCounterDelta: gatewayDelta,
        envoyUpstreamAccessLogMatches: accessDelta,
        listenerSnapshotDigest: listenerDigest,
        counterSnapshotBeforeDigest: before.digest,
        counterSnapshotAfterDigest: after.digest,
        accessLogDigest: after.journal.digest,
      };
      break;
    case "plaintext":
      proof = {
        type: "plaintext_rejection", tcpConnectedToOwnedListener: true,
        listenerOwnedByGatewayUid: true, closedByListener: true, responseBytes: 0,
        gatewayUpstreamCounterDelta: gatewayDelta,
        listenerSnapshotDigest: listenerDigest,
        counterSnapshotBeforeDigest: before.digest,
        counterSnapshotAfterDigest: after.digest,
      };
      break;
    case "direct_bypass":
      proof = {
        type: "forced_gateway_route", directDestinationAttempted: true, tcpConnected: true,
        tlsAuthorized: true, httpPingPassed: true, requestedServerName: "registry.npmjs.org",
        upstreamAddressBoundToContract: true,
        redirectCounterDelta: nftCounterDelta(before.counters, after.counters, "redirect"),
        runnerLoopbackCounterDelta: loopbackDelta,
        gatewayUpstreamCounterDelta: gatewayDelta,
        envoyAccessLogMatches: accessDelta,
        counterSnapshotBeforeDigest: before.digest,
        counterSnapshotAfterDigest: after.digest,
        accessLogDigest: after.journal.digest,
      };
      break;
    case "non_443":
    case "non_npm":
      proof = {
        type: "egress_rejection", target: name, connectionBlocked: true,
        runnerRejectCounterDelta: nftCounterDelta(before.counters, after.counters, "runnerReject"),
        gatewayRejectCounterDelta: nftCounterDelta(before.counters, after.counters, "gatewayReject"),
        counterSnapshotBeforeDigest: before.digest,
        counterSnapshotAfterDigest: after.digest,
      };
      break;
    default:
      proof = null;
  }
  return Object.freeze({ observedAt, actionEvidenceDigest, proof });
}

async function stopGatewayAndCheckOffline(resources, rendered, tools, evidence, identity) {
  const stopped = await stopExactUnit(resources.gatewayUnit, tools);
  await waitFor(() => !existsSync(`/proc/${identity.pid}`), "gateway MainPID exit");
  const listeners = await waitFor(() => {
    const value = listenerSnapshot(tools.ss, HOSTED_SMOKE_LISTENER_PORT);
    return value.trim() === "" ? value : false;
  }, "gateway listener removal");
  const stopEvidenceDigest = evidence.write("gateway-stop", canonicalJson({
    before: stopped.before.raw,
    after: stopped.after.raw,
    mainPidAbsent: !existsSync(`/proc/${identity.pid}`),
    listeners,
  }));
  const before = captureTableCounters(resources, tools, evidence, "offline-counters-before");
  const offline = runProbe("offline_network", rendered, tools);
  const actionDigest = evidence.write("offline-probe", offline.raw);
  const after = captureTableCounters(resources, tools, evidence, "offline-counters-after");
  const redirectDelta = nftCounterDelta(before.counters, after.counters, "redirect");
  const runnerLoopbackDelta = nftCounterDelta(before.counters, after.counters, "runnerV4") +
    nftCounterDelta(before.counters, after.counters, "runnerV6");
  const gatewayUpstreamDelta = nftCounterDelta(before.counters, after.counters, "gatewayV4") +
    nftCounterDelta(before.counters, after.counters, "gatewayV6");
  if (redirectDelta < 1 || runnerLoopbackDelta < 1 || gatewayUpstreamDelta !== 0) {
    throw new Error("hosted smoke offline check did not prove fail-closed correlated routing");
  }
  const offlineEvidenceDigest = evidence.write("offline-fail-closed", canonicalJson({
    gatewayStopped: true,
    listenerAbsent: true,
    policyInstalled: tableSnapshot(tools.nft, resources.nftTable).exists,
    redirectDelta,
    runnerLoopbackDelta,
    gatewayUpstreamDelta,
    actionDigest,
  }));
  return Object.freeze({
    stopEvidenceDigest, offlineEvidenceDigest,
    redirectDelta, runnerLoopbackDelta, gatewayUpstreamDelta,
    listenerDigest: evidence.write("gateway-listeners-absent", listeners || "listeners absent"),
    beforeDigest: before.digest, afterDigest: after.digest,
  });
}

function cgroupIsAbsent(cgroup) {
  if (typeof cgroup !== "string" || !cgroup.startsWith("/") || cgroup.includes("..")) return false;
  const path = join("/sys/fs/cgroup", cgroup);
  if (!existsSync(path)) return true;
  let seen = 0;
  const visit = (current) => {
    seen += 1;
    if (seen > MAX_CGROUP_DIRECTORIES) throw new Error("hosted smoke cgroup subtree is excessive");
    const procsPath = join(current, "cgroup.procs");
    if (!existsSync(procsPath) || readFileSync(procsPath, "utf8").trim() !== "") return false;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !visit(join(current, entry.name))) return false;
    }
    return true;
  };
  return visit(path);
}

function removeExactRuntime(resources) {
  const markerStat = lstatSync(resources.ownershipMarkerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.uid !== 0 || markerStat.gid !== 0 ||
      markerStat.nlink !== 1 || (markerStat.mode & 0o7777) !== 0o600) {
    throw new Error("hosted smoke ownership marker is linked, writable, or substituted");
  }
  const marker = JSON.parse(readFileSync(resources.ownershipMarkerPath, "utf8"));
  validateHostedSmokeOwnershipMarker(marker, resources);
  const runtimeStat = lstatSync(resources.runtimeRoot);
  const workspaceStat = lstatSync(resources.workspacePath);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || runtimeStat.uid !== 0 || runtimeStat.gid !== 0 ||
      (runtimeStat.mode & 0o7777) !== 0o700 || !workspaceStat.isDirectory() || workspaceStat.isSymbolicLink() ||
      workspaceStat.uid !== 0 || workspaceStat.gid !== 0 || (workspaceStat.mode & 0o7777) !== 0o555) {
    throw new Error("hosted smoke owned runtime directories are substituted");
  }
  const runtimeEntries = readdirSync(resources.runtimeRoot, { withFileTypes: true });
  if (runtimeEntries.length !== 1 || runtimeEntries[0].name !== basename(resources.ownershipMarkerPath) ||
      !runtimeEntries[0].isFile() || runtimeEntries[0].isSymbolicLink()) {
    throw new Error("hosted smoke runtime root contains unexpected objects");
  }
  const expectedWorkspace = new Set(["envoy-config.json", "gateway-contract.json", "gateway-policy.nft"]);
  const workspaceEntries = readdirSync(resources.workspacePath, { withFileTypes: true });
  if (workspaceEntries.length !== expectedWorkspace.size || workspaceEntries.some((entry) =>
    !expectedWorkspace.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("hosted smoke workspace contains unexpected objects");
  }
  for (const entry of workspaceEntries) {
    const stat = lstatSync(join(resources.workspacePath, entry.name));
    if (stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o444) {
      throw new Error("hosted smoke workspace artifact is writable, linked, or substituted");
    }
  }
  rmSync(resources.workspacePath, { recursive: true, force: false });
  rmSync(resources.ownershipMarkerPath, { force: false });
  rmSync(resources.runtimeRoot, { recursive: false, force: false });
}

function deleteExactTable(resources, tools) {
  runCommand(tools.nft, ["delete", "table", "inet", resources.nftTable]);
  if (tableSnapshot(tools.nft, resources.nftTable, true).exists) {
    throw new Error("hosted smoke exact nftables table survived deletion");
  }
}

function assertSanitizedRunnerEnvironment(environment) {
  const allowed = new Set([
    "PATH", "LANG", "LC_ALL", "TZ",
    "API_MIGRATOR_HOSTED_ENVOY_PATH", "API_MIGRATOR_SMOKE_RUN_ID",
    "API_MIGRATOR_SMOKE_RUN_ATTEMPT", "API_MIGRATOR_SMOKE_SOURCE_REVISION",
    "API_MIGRATOR_SMOKE_REPOSITORY", "API_MIGRATOR_SMOKE_WORKFLOW_REF",
    "API_MIGRATOR_SMOKE_IMAGE_VERSION",
  ]);
  const extras = Object.keys(environment).filter((name) => !allowed.has(name));
  if (extras.length > 0 || environment.PATH !== "/usr/local/libexec/api-migrator-hosted-smoke:/usr/sbin:/usr/bin:/sbin:/bin" ||
      environment.LANG !== "C" || environment.LC_ALL !== "C" || environment.TZ !== "UTC") {
    throw new Error("hosted smoke process environment is not the exact sanitized allowlist");
  }
}

function markEvent(state, name, evidenceDigest) {
  const expected = HOSTED_SMOKE_EVENT_ORDER[state.index];
  if (name !== expected) throw new Error(`hosted smoke event order expected ${expected}, received ${name}`);
  state.observedAt[name] = state.timeline.tick();
  state.evidenceDigests[name] = evidenceDigest;
  state.index += 1;
  return state.observedAt[name];
}

function buildDeferredScenarioEvidence(name, values) {
  switch (name) {
    case "offline_network":
      return {
        observedAt: values.offline.offlineNetworkCheckedAt,
        actionEvidenceDigest: values.offline.offlineEvidenceDigest,
        proof: {
          type: "offline_fail_closed", gatewayStopped: true, nftablesPolicyInstalled: true,
          connectionBlocked: true, redirectCounterDelta: values.offline.redirectDelta,
          runnerLoopbackCounterDelta: values.offline.runnerLoopbackDelta,
          gatewayUpstreamCounterDelta: values.offline.gatewayUpstreamDelta,
          listenerAbsent: true, evidenceDigest: values.offline.offlineEvidenceDigest,
        },
      };
    case "gateway_stop":
      return {
        observedAt: values.offline.gatewayStoppedAt,
        actionEvidenceDigest: values.offline.stopEvidenceDigest,
        proof: {
          type: "gateway_stop", processAbsent: true, ipv4ListenerAbsent: true,
          ipv6ListenerAbsent: true, processSnapshotDigest: values.offline.stopEvidenceDigest,
          listenerSnapshotDigest: values.offline.listenerDigest,
        },
      };
    case "uid_idle":
      return {
        observedAt: values.gatewayUidIdleAt,
        actionEvidenceDigest: values.gatewayUidIdleEvidenceDigest,
        proof: {
          type: "uid_idle", runnerUidIdle: true, gatewayUidIdle: true,
          processSnapshotDigest: values.uidSnapshotDigest,
        },
      };
    case "policy_removal":
      return {
        observedAt: values.nftablesPolicyRemovedAt,
        actionEvidenceDigest: values.nftablesRemovalEvidenceDigest,
        proof: {
          type: "policy_removal", tablePresentBeforeCleanup: true, tableAbsentAfterCleanup: true,
          beforeSnapshotDigest: values.tableBeforeRemovalDigest,
          afterSnapshotDigest: values.tableAfterRemovalDigest,
        },
      };
    case "cgroup_namespace_cleanup":
      return {
        observedAt: values.cgroupNamespaceCleanupAt,
        actionEvidenceDigest: values.cgroupNamespaceEvidenceDigest,
        proof: {
          type: "cgroup_namespace_cleanup", cgroupEmpty: true,
          processNetworkNamespaceReferenceAbsent: true,
          cgroupEvidenceDigest: values.cgroupNamespaceEvidenceDigest,
          namespaceEvidenceDigest: values.namespaceEvidenceDigest,
        },
      };
    case "workspace_cleanup":
      return {
        observedAt: values.workspaceCleanupAt,
        actionEvidenceDigest: values.workspaceEvidenceDigest,
        proof: {
          type: "workspace_cleanup", workspaceAbsent: true,
          parentSnapshotDigest: values.workspaceEvidenceDigest,
        },
      };
    default:
      throw new Error(`hosted smoke deferred scenario is unsupported: ${name}`);
  }
}

async function emergencyCleanup(resources, tools) {
  if (!resources || !tools) return;
  try {
    await stopExactUnit(resources.canaryUnit, tools);
    await stopExactUnit(resources.gatewayUnit, tools);
  } catch {
    return; // Never remove the owned paths or containment while a unit/cgroup may survive.
  }
  if (pidsForUid(HOSTED_SMOKE_RUNNER_UID).length > 0 || pidsForUid(HOSTED_SMOKE_GATEWAY_UID).length > 0) {
    return; // Keep containment installed if either dedicated identity is still active.
  }
  try {
    if (existsSync(resources.ownershipMarkerPath)) removeExactRuntime(resources);
  } catch { return; }
  if (existsSync(resources.workspacePath) || existsSync(resources.runtimeRoot)) return;
  try {
    if (tableSnapshot(tools.nft, resources.nftTable, true).exists) deleteExactTable(resources, tools);
  } catch {}
}

export async function runHostedSmoke(argv, dependencies = {}) {
  const { scenario, outputDir } = parseHostedSmokeCli(argv);
  const environmentSource = dependencies.environment ?? process.env;
  assertSanitizedRunnerEnvironment(environmentSource);
  const environment = parseHostedSmokeEnvironment(environmentSource);
  assertLinuxHostedRoot();
  const resources = deriveHostedSmokeResources({
    runId: environment.runId,
    runAttempt: environment.runAttempt,
    scenario,
  });
  const inventory = buildToolInventory(environment.envoyPath);
  const tools = inventory.paths;
  const evidenceDir = ensureOutputDirectory(outputDir);
  const evidence = createEvidenceWriter(evidenceDir);
  const timeline = createTimeline();
  const eventState = { index: 0, observedAt: {}, evidenceDigests: {}, timeline };
  let policyInstalled = false;
  let runtimeCreated = false;

  try {
    assertNoResourceCollision(resources, tools);
    const preMutationEvidenceDigest = evidence.write("pre-mutation", canonicalJson({
      nftablesTableAbsent: true,
      runnerUidIdle: true,
      gatewayUidIdle: true,
      gatewayUnitAbsent: true,
      canaryUnitAbsent: true,
      listenerPortAbsent: true,
      runtimeRootAbsent: true,
      workspaceAbsent: !existsSync(resources.workspacePath),
    }));
    markEvent(eventState, "observer_started", preMutationEvidenceDigest);

    createRootRuntime(resources);
    runtimeCreated = true;
    const rendered = await renderHostedGateway(resources, inventory.tools, evidence);
    markEvent(eventState, "contract_validated", rendered.deployment.digest);

    const validation = nativeValidate(rendered, tools, evidence);
    markEvent(eventState, "envoy_config_validated", validation.envoyEvidenceDigest);
    markEvent(eventState, "nftables_policy_validated", validation.nftablesEvidenceDigest);

    const policyInstallationEvidenceDigest = installPolicy(rendered, resources, tools, evidence);
    policyInstalled = true;
    markEvent(eventState, "nftables_policy_installed", policyInstallationEvidenceDigest);

    const gatewayIdentity = await startGateway(resources, rendered, tools, evidence);
    markEvent(eventState, "gateway_started", gatewayIdentity.evidenceDigest);
    const listeners = await waitForListener(gatewayIdentity, resources, tools, evidence);
    const readinessJournalBefore = readGatewayJournal(resources, tools, evidence, "listener-readiness-journal-before");
    const readinessAccessCountBefore = countMatchingAccessLogs(readinessJournalBefore.text, rendered.deployment);
    const positiveV4 = runProbe("correct_sni", rendered, tools);
    const positiveV6 = runProbe("correct_sni_ipv6", rendered, tools);
    const readinessJournalText = await waitFor(() => {
      const journal = runCommand(tools.journalctl, ["--boot", "--no-pager", "-o", "cat", "-u", resources.gatewayUnit]);
      return countMatchingAccessLogs(journal.stdout, rendered.deployment) >= readinessAccessCountBefore + 2
        ? journal.stdout
        : false;
    }, "both positive readiness access logs", 8_000);
    const readinessJournalDigest = evidence.write("listener-readiness-journal-after", readinessJournalText);
    const listenerReadinessEvidenceDigest = evidence.write("listener-positive-readiness", canonicalJson({
      listenerSnapshotDigest: listeners.digest,
      ipv4PositiveProbe: positiveV4.result,
      ipv6PositiveProbe: positiveV6.result,
      accessLogCountBefore: readinessAccessCountBefore,
      accessLogCountAfter: countMatchingAccessLogs(readinessJournalText, rendered.deployment),
      accessLogEvidenceDigest: readinessJournalDigest,
    }));
    markEvent(eventState, "gateway_ready", listenerReadinessEvidenceDigest);

    const scenarioStartEvidenceDigest = evidence.write("scenario-start", canonicalJson({
      scenario, suiteId: resources.suiteId, jobId: resources.jobId,
      nftablesTable: resources.nftTable, gatewayUnit: resources.gatewayUnit,
    }));
    markEvent(eventState, "scenario_started", scenarioStartEvidenceDigest);

    const onlineScenario = new Set([
      "success", "timeout", "sigkill", "wrong_sni", "absent_sni", "plaintext",
      "direct_bypass", "non_443", "non_npm",
    ]).has(scenario)
      ? await executeOnlineScenario(scenario, resources, rendered, tools, evidence, listeners.digest, timeline)
      : null;

    await stopExactUnit(resources.canaryUnit, tools);
    const offlineBase = await stopGatewayAndCheckOffline(resources, rendered, tools, evidence, gatewayIdentity);
    const gatewayStoppedAt = markEvent(eventState, "gateway_stopped", offlineBase.stopEvidenceDigest);
    const offlineNetworkCheckedAt = markEvent(eventState, "offline_network_checked", offlineBase.offlineEvidenceDigest);
    const offline = Object.freeze({ ...offlineBase, gatewayStoppedAt, offlineNetworkCheckedAt });

    await waitFor(() => pidsForUid(HOSTED_SMOKE_RUNNER_UID).length === 0, "runner UID idle");
    const runnerUidIdleEvidenceDigest = evidence.write("runner-uid-idle", canonicalJson({
      uid: HOSTED_SMOKE_RUNNER_UID, pids: pidsForUid(HOSTED_SMOKE_RUNNER_UID), idle: true,
    }));
    const runnerUidIdleAt = markEvent(eventState, "runner_uid_idle", runnerUidIdleEvidenceDigest);

    await waitFor(() => pidsForUid(HOSTED_SMOKE_GATEWAY_UID).length === 0, "gateway UID idle");
    const gatewayUidIdleEvidenceDigest = evidence.write("gateway-uid-idle", canonicalJson({
      uid: HOSTED_SMOKE_GATEWAY_UID, pids: pidsForUid(HOSTED_SMOKE_GATEWAY_UID), idle: true,
    }));
    const gatewayUidIdleAt = markEvent(eventState, "gateway_uid_idle", gatewayUidIdleEvidenceDigest);
    const uidSnapshotDigest = evidence.write("dedicated-uids-idle", canonicalJson({
      runner: pidsForUid(HOSTED_SMOKE_RUNNER_UID), gateway: pidsForUid(HOSTED_SMOKE_GATEWAY_UID),
    }));

    await waitFor(() => cgroupIsAbsent(gatewayIdentity.cgroup), "gateway cgroup cleanup");
    const cgroupNamespaceEvidenceDigest = evidence.write("cgroup-cleanup", canonicalJson({
      gatewayCgroup: gatewayIdentity.cgroup,
      cgroupEmptyOrAbsent: cgroupIsAbsent(gatewayIdentity.cgroup),
      gatewayPidAbsent: !existsSync(`/proc/${gatewayIdentity.pid}`),
    }));
    const namespaceEvidenceDigest = evidence.write("namespace-cleanup", canonicalJson({
      observedNamespace: gatewayIdentity.namespace,
      gatewayPidAbsent: !existsSync(`/proc/${gatewayIdentity.pid}`),
      networkNamespaceReferenceAbsent: !existsSync(`/proc/${gatewayIdentity.pid}/ns/net`),
    }));
    const cgroupNamespaceCleanupAt = markEvent(eventState, "cgroup_namespace_cleanup", cgroupNamespaceEvidenceDigest);

    const settledGatewayUnit = unitSnapshot(tools.systemctl, resources.gatewayUnit);
    const settledCanaryUnit = unitSnapshot(tools.systemctl, resources.canaryUnit);
    if (settledGatewayUnit.values.LoadState !== "not-found" || settledCanaryUnit.values.LoadState !== "not-found" ||
        !cgroupIsAbsent(`/system.slice/${resources.gatewayUnit}`) || !cgroupIsAbsent(`/system.slice/${resources.canaryUnit}`)) {
      throw new Error("hosted smoke exact units or cgroups survived before workspace cleanup");
    }
    if (!tableSnapshot(tools.nft, resources.nftTable).exists) throw new Error("hosted smoke containment vanished before workspace cleanup");
    removeExactRuntime(resources);
    runtimeCreated = false;
    if (existsSync(resources.workspacePath) || existsSync(resources.runtimeRoot)) {
      throw new Error("hosted smoke exact workspace or runtime survived cleanup");
    }
    const workspaceEvidenceDigest = evidence.write("workspace-cleanup", canonicalJson({
      workspacePath: resources.workspacePath, workspaceAbsent: true,
      runtimeRoot: resources.runtimeRoot, runtimeRootAbsent: true,
      containmentStillInstalled: tableSnapshot(tools.nft, resources.nftTable).exists,
    }));
    const workspaceCleanupAt = markEvent(eventState, "workspace_cleanup", workspaceEvidenceDigest);

    const tableBefore = tableSnapshot(tools.nft, resources.nftTable);
    const tableBeforeRemovalDigest = evidence.write("nftables-before-removal", tableBefore.text);
    deleteExactTable(resources, tools);
    policyInstalled = false;
    const tableAfterRemovalDigest = evidence.write("nftables-after-removal", "exact owned nftables table absent");
    const nftablesRemovalEvidenceDigest = evidence.write("nftables-removal", canonicalJson({
      nftablesTable: resources.nftTable,
      beforeDigest: tableBeforeRemovalDigest,
      afterDigest: tableAfterRemovalDigest,
      absent: true,
    }));
    const nftablesPolicyRemovedAt = markEvent(eventState, "nftables_policy_removed", nftablesRemovalEvidenceDigest);

    const finalGatewayUnit = unitSnapshot(tools.systemctl, resources.gatewayUnit);
    const finalCanaryUnit = unitSnapshot(tools.systemctl, resources.canaryUnit);
    if (pidsForUid(HOSTED_SMOKE_RUNNER_UID).length > 0 || pidsForUid(HOSTED_SMOKE_GATEWAY_UID).length > 0 ||
        finalGatewayUnit.values.LoadState !== "not-found" || finalCanaryUnit.values.LoadState !== "not-found" ||
        !cgroupIsAbsent(`/system.slice/${resources.gatewayUnit}`) || !cgroupIsAbsent(`/system.slice/${resources.canaryUnit}`) ||
        existsSync(resources.workspacePath) || tableSnapshot(tools.nft, resources.nftTable, true).exists) {
      throw new Error("hosted smoke final resource boundary is not absent and idle");
    }

    const deferredValues = {
      offline, gatewayUidIdleAt, gatewayUidIdleEvidenceDigest, uidSnapshotDigest,
      nftablesPolicyRemovedAt, nftablesRemovalEvidenceDigest, tableBeforeRemovalDigest,
      tableAfterRemovalDigest, cgroupNamespaceCleanupAt, cgroupNamespaceEvidenceDigest,
      namespaceEvidenceDigest, workspaceCleanupAt, workspaceEvidenceDigest,
    };
    const selected = onlineScenario ?? buildDeferredScenarioEvidence(scenario, deferredValues);
    const scenarioEvidence = {
      kind: "api_migrator_github_hosted_l7_smoke_scenario_evidence",
      scenarioName: scenario,
      observedAt: selected.observedAt,
      actionEvidenceDigest: selected.actionEvidenceDigest,
      proof: selected.proof,
    };
    const scenarioEvidenceDigest = sha256Bytes(Buffer.from(canonicalJson(scenarioEvidence), "utf8"));
    markEvent(eventState, "scenario_finished", scenarioEvidenceDigest);

    const finalSnapshotEvidenceDigest = evidence.write("final-snapshot", canonicalJson({
      gatewayUnit: finalGatewayUnit,
      canaryUnit: finalCanaryUnit,
      nftablesTableAbsent: !tableSnapshot(tools.nft, resources.nftTable, true).exists,
      runnerUidIdle: pidsForUid(HOSTED_SMOKE_RUNNER_UID).length === 0,
      gatewayUidIdle: pidsForUid(HOSTED_SMOKE_GATEWAY_UID).length === 0,
      workspaceAbsent: !existsSync(resources.workspacePath),
      runtimeRootAbsent: !existsSync(resources.runtimeRoot),
    }));
    markEvent(eventState, "observer_finished", finalSnapshotEvidenceDigest);

    const hostAndTools = toolEvidence(inventory, environment);
    const checks = {
      preMutation: {
        nftablesTableAbsent: true, runnerUidIdle: true, gatewayUidIdle: true,
        evidenceDigest: preMutationEvidenceDigest,
      },
      nativeValidation: {
        envoyStatus: "passed", nftablesStatus: "passed",
        envoyEvidenceDigest: validation.envoyEvidenceDigest,
        nftablesEvidenceDigest: validation.nftablesEvidenceDigest,
      },
      policyInstallation: {
        installed: true, policyDigest: rendered.deployment.nftablesPolicyDigest,
        evidenceDigest: policyInstallationEvidenceDigest,
      },
      gatewayRuntime: {
        started: true, stopped: true, startEvidenceDigest: gatewayIdentity.evidenceDigest,
        stopEvidenceDigest: offline.stopEvidenceDigest,
      },
      listenerReadiness: {
        ipv4: true, ipv6: true, ipv4PositiveProbePassed: true, ipv6PositiveProbePassed: true,
        ownedByGatewayUid: true, evidenceDigest: listenerReadinessEvidenceDigest,
      },
      offlineFailClosed: {
        gatewayStopped: true, nftablesPolicyInstalled: true, connectionBlocked: true,
        redirectCounterDelta: offline.redirectDelta,
        runnerLoopbackCounterDelta: offline.runnerLoopbackDelta,
        gatewayUpstreamCounterDelta: offline.gatewayUpstreamDelta,
        evidenceDigest: offline.offlineEvidenceDigest,
      },
      scenarioStartEvidenceDigest,
      finalSnapshotEvidenceDigest,
    };
    const teardown = {
      gatewayStoppedAt: offline.gatewayStoppedAt,
      runnerUidIdleAt,
      gatewayUidIdleAt,
      cgroupNamespaceCleanupAt,
      workspaceCleanupAt,
      nftablesPolicyRemovedAt,
      runnerUidIdle: true,
      gatewayUidIdle: true,
      cgroupEmpty: true,
      processNetworkNamespaceReferenceAbsent: true,
      workspaceAbsent: true,
      nftablesPolicyAbsent: true,
      complete: true,
      runnerUidIdleEvidenceDigest,
      gatewayUidIdleEvidenceDigest,
      cgroupNamespaceEvidenceDigest,
      workspaceEvidenceDigest,
      nftablesRemovalEvidenceDigest,
    };
    const gateway = {
      profile: rendered.deployment.contract.profile,
      gatewayContractDigest: rendered.deployment.digest,
      envoyConfigDigest: rendered.deployment.envoyConfigDigest,
      nftablesPolicyDigest: rendered.deployment.nftablesPolicyDigest,
      gatewayRuntimeDigest: rendered.deployment.contract.gatewayRuntimeDigest,
      nftablesTable: rendered.deployment.nftablesTable,
      runnerUid: rendered.deployment.contract.runnerUid,
      gatewayUid: rendered.deployment.contract.gatewayUid,
      listenerAddresses: [...rendered.deployment.contract.listener.addresses],
      listenerPort: rendered.deployment.contract.listener.port,
      originHost: rendered.deployment.contract.origin.host,
      originPort: rendered.deployment.contract.origin.port,
    };
    const events = buildHostedSmokeEventStream({
      observedAt: eventState.observedAt,
      evidenceDigests: eventState.evidenceDigests,
    });
    const built = buildHostedSmokeScenarioReport({
      suiteId: resources.suiteId,
      scenarioName: scenario,
      sourceRevision: environment.sourceRevision,
      githubRun: {
        repository: environment.repository,
        workflowRef: environment.workflowRef,
        runId: environment.runId,
        runAttempt: environment.runAttempt,
      },
      host: hostAndTools.host,
      toolBindings: hostAndTools.tools,
      gateway,
      checks,
      scenarioEvidence,
      events,
      teardown,
      startedAt: eventState.observedAt.observer_started,
      finishedAt: eventState.observedAt.observer_finished,
    });
    const reportPath = join(outputDir, "scenario-report.json");
    writeFileSync(reportPath, built.canonicalJson, { flag: "wx", mode: 0o644 });
    const manifest = {
      schemaVersion: 1,
      kind: "api_migrator_github_hosted_l7_smoke_evidence_manifest",
      scenario,
      scenarioReportDigest: built.digest,
      entries: evidence.manifest(),
      releaseEvidenceEligible: false,
      activationBlocked: true,
      externalSigningEligible: false,
      authorizationStatus: "non_authorizing_github_hosted_smoke_only",
    };
    writeFileSync(join(outputDir, "evidence-manifest.json"), canonicalJson(manifest), { flag: "wx", mode: 0o644 });
    return Object.freeze({
      schemaVersion: 1,
      kind: "api_migrator_github_hosted_l7_smoke_cli_result",
      scenario,
      scenarioReportPath: reportPath,
      scenarioReportDigest: built.digest,
      status: "passed",
      releaseEvidenceEligible: false,
      activationBlocked: true,
      externalSigningEligible: false,
      authorizationStatus: "non_authorizing_github_hosted_smoke_only",
    });
  } catch (error) {
    await emergencyCleanup(runtimeCreated || policyInstalled ? resources : undefined, tools);
    throw error;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runHostedSmoke(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${canonicalJson(result)}\n`),
    (error) => {
      process.stderr.write(`hosted smoke refused: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
