/** Fail-closed, runner-isolated verification for proposed migrations. */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  detectPackageManager,
  findLockfiles,
  isRootLockfileName,
  readRootLockfile,
  type PackageManager,
} from "./dependencies.js";
import {
  MAX_COMPILER_ENTRY_BYTES,
  MAX_PACKAGE_MANIFEST_BYTES,
  readRepositoryFile,
  readRepositoryText,
  validateRepositoryFile,
} from "./repository-files.js";

export type CheckStatus = "passed" | "failed" | "skipped";

export interface CheckResult {
  status: CheckStatus;
  command: string | null;
  exitCode: number | null;
  output: string;
  reason?: string;
}

export interface VerificationChecks {
  install: CheckResult;
  typecheck: CheckResult;
  /** Optional repository-authored typecheck script; never used as the compiler oracle. */
  repoTypecheck?: CheckResult;
  test: CheckResult;
  lint: CheckResult;
}

export interface RunnerCommand {
  command: string;
  args: string[];
  timeoutMs: number;
  /**
   * Install uses Docker's ordinary bridge network; this is not an egress
   * filter. Repository-controlled checks receive no network at all.
   */
  network: "default" | "none";
  env: NodeJS.ProcessEnv;
}

export interface RunnerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOut: boolean;
}

/** Injectable runner for tests and alternative production sandboxes. */
export interface VerificationRunner {
  readonly kind: string;
  run(repoPath: string, command: RunnerCommand): RunnerResult;
}

export interface DockerRunnerOptions {
  image?: string;
  cpus?: number;
  memory?: string;
  pidsLimit?: number;
}

/** Injectable Docker CLI boundary used by cleanup regression tests. */
export type DockerCommandExecutor = (args: string[], timeoutMs: number) => RunnerResult;

export interface VerifyOptions {
  /** Local is explicitly non-production. Docker never silently falls back. */
  runner?: "local" | "docker" | VerificationRunner;
  /** Install/update dependencies before checking. */
  install?: boolean;
  /** Extra package-manager install arguments. */
  installArgs?: string[];
  /** Lifecycle scripts are disabled by default. */
  lifecycleScripts?: boolean;
  /** Run the repository's test script after type-checking. */
  runTests?: boolean;
  /** Run the repository's lint script after type-checking. */
  runLint?: boolean;
  /** Run a repository-authored typecheck script as an additional, strict check. */
  runTypecheckScript?: boolean;
  /** Explicit environment for repository-controlled commands. Never merged with process.env. */
  env?: NodeJS.ProcessEnv;
  installTimeoutMs?: number;
  typecheckTimeoutMs?: number;
  testTimeoutMs?: number;
  lintTimeoutMs?: number;
  docker?: DockerRunnerOptions;
}

export interface TypeError {
  file: string;
  line: number | null;
  col: number | null;
  code: string;
  message: string;
  raw: string;
}

export interface VerifyResult {
  /** False for skipped/incomplete checks, process failures, new errors, or failed requested scripts. */
  ok: boolean;
  baseline: TypeError[];
  after: TypeError[];
  introduced: TypeError[];
  skipped: boolean;
  skipReason?: string;
  runner: string;
  checks: VerificationChecks;
}

export interface InstallResult {
  ok: boolean;
  reason?: string;
  check: CheckResult;
}

const TS_ERROR = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;
const MAX_OUTPUT = 24_000;
const DEFAULT_DOCKER_IMAGE =
  "node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46";
const PACKAGE_MANIFEST_POLICY = {
  label: "package manifest",
  maxBytes: MAX_PACKAGE_MANIFEST_BYTES,
} as const;
const COMPILER_ENTRY_POLICY = {
  label: "TypeScript compiler entry",
  maxBytes: MAX_COMPILER_ENTRY_BYTES,
} as const;

export class LocalVerificationRunner implements VerificationRunner {
  readonly kind = "local-unsafe";

  run(repoPath: string, command: RunnerCommand): RunnerResult {
    const result = spawnSync(command.command, command.args, {
      cwd: repoPath,
      env: command.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: command.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      spawnError: result.error?.message,
      timedOut: result.signal === "SIGKILL" && Boolean(result.error),
    };
  }
}

export class DockerVerificationRunner implements VerificationRunner {
  readonly kind = "docker";
  readonly options: Required<DockerRunnerOptions>;
  private readonly executeDocker: DockerCommandExecutor;

  constructor(options: DockerRunnerOptions = {}, executeDocker?: DockerCommandExecutor) {
    this.options = {
      image: options.image ?? DEFAULT_DOCKER_IMAGE,
      cpus: options.cpus ?? 2,
      memory: options.memory ?? "2g",
      pidsLimit: options.pidsLimit ?? 256,
    };
    this.executeDocker = executeDocker ?? executeDockerCommand;
  }

  run(repoPath: string, command: RunnerCommand): RunnerResult {
    const containerName = `api-migrator-${randomUUID()}`;
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    const args = [
      "run", "--rm", "--init",
      "--name", containerName,
      // Match the host process so a capability-free container can access the
      // bind mount on native Linux and leaves install artifacts host-owned.
      "--user", `${uid}:${gid}`,
      "--network", command.network === "none" ? "none" : "bridge",
      "--cpus", String(this.options.cpus),
      "--memory", this.options.memory,
      "--pids-limit", String(this.options.pidsLimit),
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
      "--tmpfs", `/npm-cache:rw,noexec,nosuid,size=512m,mode=0700,uid=${uid},gid=${gid}`,
      "--mount", `type=bind,src=${repoPath},dst=/workspace${command.network === "none" ? ",readonly" : ""}`,
      "--workdir", "/workspace",
    ];
    for (const [key, value] of Object.entries(command.env)) {
      if (value != null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) args.push("--env", `${key}=${value}`);
    }
    args.push(this.options.image, command.command, ...command.args);
    let result: RunnerResult | undefined;
    try {
      result = this.executeDocker(args, command.timeoutMs + 10_000);
      return result;
    } finally {
      // Killing an attached `docker run` client does not stop its container.
      // A known name lets us synchronously remove any networked/writable runner
      // that might otherwise survive a timeout or client failure.
      if (!result || result.timedOut || result.spawnError || result.exitCode !== 0) {
        try {
          this.executeDocker(["rm", "--force", containerName], 15_000);
        } catch {
          // Preserve the verification failure. Production monitoring should
          // still alert on Docker daemon failures, but never mask the root cause.
        }
      }
    }
  }
}

function executeDockerCommand(args: string[], timeoutMs: number): RunnerResult {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    // This environment belongs to the trusted Docker client, not the container.
    env: process.env,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: result.error?.message,
    timedOut: result.signal === "SIGKILL" && Boolean(result.error),
  };
}

export function parseTscErrors(output: string): TypeError[] {
  const out: TypeError[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(TS_ERROR);
    if (!match) continue;
    out.push({
      file: match[1]!,
      line: Number(match[2]),
      col: Number(match[3]),
      code: match[4]!,
      message: match[5]!,
      raw: line,
    });
  }
  return out;
}

/** Install dependencies and update the active lockfile with scripts disabled by default. */
export function installDeps(repoPath: string, opts: VerifyOptions = {}): InstallResult {
  if (!existsSync(join(repoPath, "package.json"))) return installFailure("no package.json");
  if (!opts.install) return {
    ok: true,
    reason: "install not requested",
    check: skippedCheck("install not requested"),
  };

  const trustFailure = dependencyTrustFailure(repoPath, opts);
  if (trustFailure) return installFailure(trustFailure);
  const manager = packageManager(repoPath);
  const command = installCommand(manager, opts);
  if (!command) return installFailure(`${manager} is unavailable in the selected runner image`);
  const runner = resolveRunner(opts);
  const result = runner.run(repoPath, {
    ...command,
    timeoutMs: opts.installTimeoutMs ?? 300_000,
    network: "default",
    env: childEnvironment(opts.env, opts.lifecycleScripts ?? false),
  });
  const check = commandCheck(command, result);
  return check.status === "passed"
    ? { ok: true, check }
    : { ok: false, reason: check.reason ?? "dependency install failed", check };
}

/** Capture the repository's existing TypeScript errors before migration. */
export async function captureBaseline(repoPath: string, opts: VerifyOptions = {}): Promise<TypeError[] | null> {
  const result = await runTsc(repoPath, opts);
  return result.skipped ? null : result.after;
}

/** Run only dependency installation and TypeScript compilation. */
export async function runTsc(repoPath: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const runner = resolveRunner(opts);
  const checks = emptyChecks();
  try {
    if (!validateRepositoryFile(repoPath, "package.json", PACKAGE_MANIFEST_POLICY, true)) {
      return failedVerification(runner.kind, checks, "no package.json");
    }
  } catch (error) {
    return failedVerification(runner.kind, checks, (error as Error).message);
  }

  if (!existsSync(join(repoPath, "tsconfig.json"))) {
    return failedVerification(runner.kind, checks, "no tsconfig.json for trusted compiler invocation");
  }

  const declarationFailure = typescriptConfigurationTrustFailure(repoPath, false);
  if (declarationFailure) {
    checks.install = failedCheck(declarationFailure);
    return failedVerification(runner.kind, checks, declarationFailure);
  }

  const installed = installDeps(repoPath, { ...opts, runner });
  checks.install = installed.check;
  if (!installed.ok) return failedVerification(runner.kind, checks, installed.reason ?? "install failed");

  const compilerFailure = installedTypeScriptTrustFailure(repoPath);
  if (compilerFailure) {
    checks.typecheck = failedCheck(compilerFailure);
    return failedVerification(runner.kind, checks, compilerFailure);
  }

  // Bypass the repository-controlled .bin namespace. Docker uses the Node
  // executable from the digest-pinned image and an inspected official package.
  const command = {
    command: runner.kind === "docker" ? "/usr/local/bin/node" : process.execPath,
    args: ["./node_modules/typescript/bin/tsc", "--noEmit", "--pretty", "false"],
  };
  const before = repositoryDigest(repoPath);
  const raw = runner.run(repoPath, {
    ...command,
    timeoutMs: opts.typecheckTimeoutMs ?? 120_000,
    network: "none",
    env: childEnvironment(opts.env, false),
  });
  const afterDigest = repositoryDigest(repoPath);
  const output = combinedOutput(raw);
  const errors = parseTscErrors(output);
  checks.typecheck = commandCheck(command, raw);

  if (before !== afterDigest) {
    const reason = "trusted compiler invocation modified the repository tree";
    checks.typecheck = { ...checks.typecheck, status: "failed", reason };
    return failedVerification(runner.kind, checks, reason);
  }

  if (raw.spawnError || raw.timedOut || raw.exitCode == null || (raw.exitCode !== 0 && errors.length === 0)) {
    const reason = raw.spawnError
      ? `compiler spawn failed: ${raw.spawnError}`
      : raw.timedOut
        ? "compiler timed out"
        : `compiler exited ${raw.exitCode ?? "without status"} without parseable TypeScript diagnostics`;
    checks.typecheck = { ...checks.typecheck, status: "failed", reason };
    return failedVerification(runner.kind, checks, reason);
  }

  return {
    ok: raw.exitCode === 0,
    baseline: [],
    after: errors,
    introduced: errors,
    skipped: false,
    runner: runner.kind,
    checks,
  };
}

/** Compare post-migration type errors to baseline, then run requested scripts. */
export async function verify(
  repoPath: string,
  baseline: TypeError[] | null,
  opts: VerifyOptions = {}
): Promise<VerifyResult> {
  const result = await runTsc(repoPath, opts);
  if (result.skipped) return result;
  if (baseline == null) {
    return {
      ...result,
      ok: false,
      skipped: true,
      skipReason: "baseline type-check was unavailable",
    };
  }

  const baseSet = new Set(baseline.map(signature));
  const introduced = result.after.filter((error) => !baseSet.has(signature(error)));
  result.baseline = baseline;
  result.introduced = introduced;
  result.checks.typecheck = introduced.length === 0
    ? { ...result.checks.typecheck, status: "passed", reason: result.after.length ? "only pre-existing errors remain" : undefined }
    : { ...result.checks.typecheck, status: "failed", reason: `${introduced.length} new TypeScript error(s)` };

  if (opts.runTests) result.checks.test = runPackageScript(repoPath, "test", opts);
  if (opts.runLint) result.checks.lint = runPackageScript(repoPath, "lint", opts);
  if (opts.runTypecheckScript) {
    result.checks.repoTypecheck = runPackageScript(repoPath, "typecheck", opts);
  }

  result.ok = introduced.length === 0
    && (!opts.runTests || result.checks.test.status === "passed")
    && (!opts.runLint || result.checks.lint.status === "passed")
    && (!opts.runTypecheckScript || result.checks.repoTypecheck?.status === "passed");
  return result;
}

export function hasTestScript(repoPath: string): boolean {
  return hasScript(repoPath, "test");
}

function runPackageScript(repoPath: string, script: "typecheck" | "test" | "lint", opts: VerifyOptions): CheckResult {
  if (!hasScript(repoPath, script)) return failedCheck(`requested ${script} script is not declared`);
  const runner = resolveRunner(opts);
  const command = packageScriptCommand(packageManager(repoPath), script);
  const before = repositoryDigest(repoPath);
  const result = runner.run(repoPath, {
    ...command,
    timeoutMs: script === "test"
      ? opts.testTimeoutMs ?? 180_000
      : script === "typecheck"
        ? opts.typecheckTimeoutMs ?? 120_000
        : opts.lintTimeoutMs ?? 120_000,
    network: "none",
    env: childEnvironment(opts.env, false),
  });
  const check = commandCheck(command, result);
  if (before !== repositoryDigest(repoPath)) {
    return { ...check, status: "failed", reason: `${script} modified the repository tree` };
  }
  return check;
}

function resolveRunner(opts: VerifyOptions): VerificationRunner {
  if (typeof opts.runner === "object") return opts.runner;
  if (opts.runner === "docker") return new DockerVerificationRunner(opts.docker);
  return new LocalVerificationRunner();
}

function packageManager(repoPath: string): PackageManager {
  const pkg = readPackage(repoPath);
  return detectPackageManager(repoPath, pkg);
}

function installCommand(manager: PackageManager, opts: VerifyOptions): { command: string; args: string[] } | null {
  const custom = opts.installArgs ?? [];
  const ignoreScripts = opts.lifecycleScripts ? [] : ["--ignore-scripts"];
  switch (manager) {
    case "npm":
      return { command: "npm", args: ["install", ...ignoreScripts, "--no-audit", "--no-fund", ...custom] };
    case "pnpm":
      return { command: "corepack", args: ["pnpm", "install", ...ignoreScripts, "--no-frozen-lockfile", ...custom] };
    case "yarn":
      return { command: "corepack", args: ["yarn", "install", ...ignoreScripts, ...custom] };
    case "bun":
      return { command: "bun", args: ["install", ...ignoreScripts, ...custom] };
  }
}

function packageScriptCommand(manager: PackageManager, script: string): { command: string; args: string[] } {
  switch (manager) {
    case "npm": return { command: "npm", args: ["run", script] };
    case "pnpm": return { command: "corepack", args: ["pnpm", "run", script] };
    case "yarn": return { command: "corepack", args: ["yarn", "run", script] };
    case "bun": return { command: "bun", args: ["run", script] };
  }
}

function childEnvironment(input: NodeJS.ProcessEnv | undefined, lifecycleScripts: boolean): NodeJS.ProcessEnv {
  return {
    ...input,
    PATH: input?.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: input?.HOME ?? "/tmp",
    CI: input?.CI ?? "true",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: lifecycleScripts ? "false" : "true",
    // Docker provisions a dedicated cache tmpfs outside /root. HOME
    // intentionally remains /tmp, whose smaller tmpfs must not become npm's
    // package cache.
    npm_config_cache: "/npm-cache",
    npm_config_registry: "https://registry.npmjs.org/",
    YARN_NPM_REGISTRY_SERVER: "https://registry.npmjs.org/",
    COREPACK_NPM_REGISTRY: "https://registry.npmjs.org/",
  };
}

const PACKAGE_CONFIG_FILES = [
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  ".pnpmfile.js",
  "bunfig.toml",
] as const;
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * Install has ordinary bridge egress and is only suitable for operator-approved
 * source. Reject known repository-controlled routing and non-registry sources,
 * but do not mistake this policy for a network-level egress filter. Hostile
 * inputs still require a dedicated egress-filtered runner.
 */
function dependencyTrustFailure(repoPath: string, opts: VerifyOptions): string | null {
  try {
    for (const name of PACKAGE_CONFIG_FILES) {
      if (existsSync(join(repoPath, name))) return `custom package-manager configuration is not allowed: ${name}`;
    }
    if ((opts.installArgs ?? []).some((arg) => /registry|config|ignore-scripts\s*=\s*false/i.test(arg))) {
      return "custom install arguments may not override registry or script-safety settings";
    }

    const compilerFailure = typescriptConfigurationTrustFailure(repoPath, false);
    if (compilerFailure) return compilerFailure;

    for (const packagePath of packageJsonFiles(repoPath)) {
      const path = relative(repoPath, packagePath).replace(/\\/g, "/");
      const pkg = readPackageJson(repoPath, path);
      for (const sectionName of DEPENDENCY_SECTIONS) {
        const section = pkg?.[sectionName];
        if (!section || typeof section !== "object") continue;
        for (const [name, spec] of Object.entries(section as Record<string, unknown>)) {
          if (typeof spec === "string" && isDirectNetworkDependency(spec)) {
            return `direct URL/git dependency is not allowed: ${name}@${spec}`;
          }
        }
      }
    }

  } catch (error) {
    return (error as Error).message;
  }
  return null;
}

function isDirectNetworkDependency(spec: string): boolean {
  return /^(?:https?:|git(?:\+|:)|ssh:|github:|gitlab:|bitbucket:)/i.test(spec)
    || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#|$)/.test(spec);
}

function isUntrustedTypeScriptSpec(spec: string): boolean {
  if (!spec || spec !== spec.trim()) return true;
  if (/^(?:npm:|file:|link:|workspace:|portal:|patch:|catalog:)/i.test(spec)) return true;
  if (/^(?:\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(spec)) return true;
  if (/[\\/:@]/.test(spec) || /\.(?:tgz|tar|tar\.gz)(?:#.*)?$/i.test(spec)) return true;

  // Registry dist-tags are resolved only within the official `typescript`
  // package namespace. All other accepted forms must look like semver ranges.
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(spec)) return false;
  if (/^~(?!\s*(?:v?\d|[xX*]))/.test(spec)) return true;
  return !/^(?:[vV]?\d|[<>=~^*]|[xX])[\dA-Za-z*<>=~^| .+-]*$/.test(spec);
}

function typescriptConfigurationTrustFailure(repoPath: string, requireLockEntry: boolean): string | null {
  try {
    let declared = false;
    for (const packagePath of packageJsonFiles(repoPath)) {
      const path = relative(repoPath, packagePath).replace(/\\/g, "/");
      const pkg = readPackageJson(repoPath, path);
      const override = typescriptOverrideSource(pkg);
      if (override) return `${override} in ${path} can redirect the TypeScript compiler`;
      for (const sectionName of DEPENDENCY_SECTIONS) {
        const section = pkg?.[sectionName];
        if (!section || typeof section !== "object") continue;
        const spec = (section as Record<string, unknown>).typescript;
        if (spec === undefined) continue;
        declared = true;
        if (typeof spec !== "string" || isUntrustedTypeScriptSpec(spec) || isDirectNetworkDependency(spec)) {
          return `TypeScript compiler must use the official registry package, not ${JSON.stringify(spec)} in ${path}`;
        }
      }
    }
    if (!declared) return "the official typescript package must be declared directly";

    const rootPackage = readPackageJson(repoPath, "package.json");
    const managerFailure = packageManagerTrustFailure(rootPackage);
    if (managerFailure) return managerFailure;
    const lockfiles = findLockfiles(repoPath);
    const manager = detectPackageManager(repoPath, rootPackage);
    const packageLockFailure = packageLockTrustFailure(repoPath, manager, lockfiles);
    if (packageLockFailure) return packageLockFailure;
    return typescriptLockfileTrustFailure(repoPath, manager, lockfiles, requireLockEntry);
  } catch (error) {
    return (error as Error).message;
  }
}

function typescriptOverrideSource(pkg: any): string | null {
  if (overrideTreeTargetsTypeScript(pkg?.overrides)) return "overrides";
  if (overrideTreeTargetsTypeScript(pkg?.resolutions)) return "resolutions";
  if (overrideTreeTargetsTypeScript(pkg?.pnpm?.overrides)) return "pnpm.overrides";
  return null;
}

function overrideTreeTargetsTypeScript(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [selector, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(^|[/>])typescript(?:@[^/>]+)?(?:$|>)/.test(selector)) return true;
    if (overrideTreeTargetsTypeScript(nested)) return true;
  }
  return false;
}

function packageManagerTrustFailure(pkg: any): string | null {
  if (pkg?.devEngines?.packageManager !== undefined) {
    return "devEngines.packageManager is not supported by the pinned verification runner";
  }
  if (pkg?.packageManager === undefined) return null;
  if (
    typeof pkg.packageManager !== "string"
    || !/^(?:npm|pnpm|yarn|bun)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.packageManager)
  ) {
    return "packageManager must name an official manager at an exact registry version";
  }
  return null;
}

function packageLockTrustFailure(
  repoPath: string,
  manager: PackageManager,
  lockfiles: readonly string[]
): string | null {
  if (manager !== "npm") return null;
  const active = lockfiles.includes("npm-shrinkwrap.json")
    ? "npm-shrinkwrap.json"
    : lockfiles.includes("package-lock.json")
      ? "package-lock.json"
      : null;
  if (!active) return null;

  let lock: any;
  try {
    lock = JSON.parse(readRootLockfile(repoPath, active).toString("utf8"));
  } catch (error) {
    return `invalid ${active}: ${(error as Error).message}`;
  }
  if (lock?.lockfileVersion !== 2 && lock?.lockfileVersion !== 3) {
    return `${active} uses an unsupported lockfile version for dependency provenance`;
  }
  if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    return `${active} does not contain a verifiable packages map`;
  }

  for (const [location, raw] of Object.entries(lock.packages as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return `${active} contains invalid package metadata at ${location || "(root)"}`;
    }
    const entry = raw as Record<string, unknown>;
    if (entry.link === true) {
      const linkFailure = workspaceLinkTrustFailure(repoPath, entry.resolved);
      if (linkFailure) return `${active} ${location}: ${linkFailure}`;
      continue;
    }
    if (entry.resolved === undefined) {
      if (location === "" || !location.includes("node_modules/")) continue;
      return `${active} contains an unverifiable package resolution at ${location}`;
    }
    if (typeof entry.resolved !== "string") {
      return `${active} contains an invalid package resolution at ${location}`;
    }
    let resolved: URL;
    try {
      resolved = new URL(entry.resolved);
    } catch {
      return `${active} redirects ${location} to a non-registry source`;
    }
    if (
      resolved.protocol !== "https:"
      || resolved.hostname.toLowerCase() !== "registry.npmjs.org"
      || resolved.username !== ""
      || resolved.password !== ""
      || resolved.port !== ""
      || resolved.search !== ""
      || resolved.hash !== ""
      || !/\/-\/[^/]+\.tgz$/.test(resolved.pathname)
    ) {
      return `${active} does not resolve ${location} from the approved npm registry`;
    }
    if (typeof entry.integrity !== "string" || !/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity)) {
      return `${active} package resolution is missing integrity at ${location}`;
    }
  }
  return null;
}

function workspaceLinkTrustFailure(repoPath: string, value: unknown): string | null {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) {
    return "workspace link has an invalid target";
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return "workspace link escapes the repository";
  }
  const root = resolve(repoPath);
  const target = resolve(root, value);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return "workspace link escapes the repository";
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "workspace link target must be a real repository directory";
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
      return "workspace link resolves outside the repository";
    }
  } catch (error) {
    return `workspace link target is unavailable: ${(error as Error).message}`;
  }
  return null;
}

function typescriptLockfileTrustFailure(
  repoPath: string,
  manager: PackageManager,
  lockfiles: readonly string[],
  requireEntry: boolean
): string | null {
  // Narrow pilot policy: only npm package-lock/shrinkwrap v2/v3 currently has
  // a provenance check strong enough to select the compiler. Other managers
  // fail closed rather than trusting package metadata superficially.
  if (manager !== "npm") {
    return `trusted TypeScript lock resolution is not yet supported for ${manager}`;
  }
  const active = lockfiles.includes("npm-shrinkwrap.json")
    ? "npm-shrinkwrap.json"
    : lockfiles.includes("package-lock.json")
      ? "package-lock.json"
      : null;
  if (!active) return requireEntry ? "npm verification requires a lockfile containing typescript" : null;

  let lock: any;
  try {
    lock = JSON.parse(readRootLockfile(repoPath, active).toString("utf8"));
  } catch (error) {
    return `invalid ${active}: ${(error as Error).message}`;
  }
  if (lock?.lockfileVersion !== 2 && lock?.lockfileVersion !== 3) {
    return `${active} uses an unsupported lockfile version for compiler provenance`;
  }
  const entry = lock?.packages?.["node_modules/typescript"];
  if (!entry) return requireEntry ? `${active} does not resolve the typescript compiler` : null;
  if (entry.link === true || typeof entry.resolved !== "string") {
    return `${active} contains an unverifiable typescript resolution`;
  }
  let resolved: URL;
  try {
    resolved = new URL(entry.resolved);
  } catch {
    return `${active} redirects typescript to a non-registry source`;
  }
  if (resolved.protocol !== "https:") {
    return `${active} redirects typescript to a non-registry source`;
  }
  if (typeof entry.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version)) {
    return `${active} typescript resolution has an invalid version`;
  }
  if (
    resolved.hostname.toLowerCase() !== "registry.npmjs.org"
    || resolved.pathname !== `/typescript/-/typescript-${entry.version}.tgz`
  ) {
    return `${active} does not resolve the official typescript registry tarball`;
  }
  if (typeof entry.integrity !== "string" || !/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity)) {
    return `${active} typescript resolution is missing package integrity`;
  }
  return null;
}

function lockedTypeScriptVersion(repoPath: string): string | null {
  const lockfiles = findLockfiles(repoPath);
  const active = lockfiles.includes("npm-shrinkwrap.json")
    ? "npm-shrinkwrap.json"
    : lockfiles.includes("package-lock.json")
      ? "package-lock.json"
      : null;
  if (!active) return null;
  const lock = JSON.parse(readRootLockfile(repoPath, active).toString("utf8"));
  const version = lock?.packages?.["node_modules/typescript"]?.version;
  return typeof version === "string" ? version : null;
}

function packageJsonFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"].includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.name === "package.json") {
        if (!entry.isFile()) throw new Error(`package manifest must be a regular non-symlink file: ${relative(root, absolute)}`);
        out.push(absolute);
      } else if (entry.isDirectory()) stack.push(absolute);
    }
  }
  return out;
}

function readPackageJson(root: string, path: string): any {
  const text = readRepositoryText(root, path, PACKAGE_MANIFEST_POLICY);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in package manifest ${path}: ${(error as Error).message}`);
  }
}

function installedTypeScriptTrustFailure(repoPath: string): string | null {
  const packagePath = "node_modules/typescript/package.json";
  const compilerPath = "node_modules/typescript/bin/tsc";
  try {
    const configurationFailure = typescriptConfigurationTrustFailure(repoPath, true);
    if (configurationFailure) return configurationFailure;
    const pkg = readPackageJson(repoPath, packagePath);
    if (pkg?.name !== "typescript") {
      return `installed compiler package is not official typescript: ${JSON.stringify(pkg?.name ?? null)}`;
    }
    if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
      return "installed typescript package has an invalid version";
    }
    const lockedVersion = lockedTypeScriptVersion(repoPath);
    if (!lockedVersion || pkg.version !== lockedVersion) {
      return `installed typescript version ${JSON.stringify(pkg.version)} does not match lockfile ${JSON.stringify(lockedVersion)}`;
    }
    const bin = typeof pkg.bin === "object" && pkg.bin !== null ? pkg.bin.tsc : undefined;
    if (bin !== "./bin/tsc" && bin !== "bin/tsc") {
      return "installed typescript package does not expose the official compiler entry";
    }
    validateRepositoryFile(repoPath, compilerPath, COMPILER_ENTRY_POLICY);
    return null;
  } catch (error) {
    return `installed typescript compiler is untrusted: ${(error as Error).message}`;
  }
}

/** Stable digest used to reject writes from compiler/test/lint processes. */
function repositoryDigest(root: string): string {
  const hash = createHash("sha256");
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).replace(/\\/g, "/");
      const stat = lstatSync(absolute);
      if (entry.isDirectory()) {
        hash.update(`d\0${rel}\0${stat.mode & 0o777}\0`);
        stack.push(absolute);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${rel}\0${readlinkSync(absolute)}\0`);
      } else if (entry.isFile()) {
        hash.update(`f\0${rel}\0${stat.mode & 0o777}\0`);
        if (entry.name === "package.json") {
          hash.update(readRepositoryFile(root, rel, PACKAGE_MANIFEST_POLICY));
        } else if (isRootLockfileName(rel)) {
          hash.update(readRootLockfile(root, rel));
        } else {
          hash.update(readFileSync(absolute));
        }
        hash.update("\0");
      }
    }
  }
  return hash.digest("hex");
}

function readPackage(repoPath: string): any {
  return readPackageJson(repoPath, "package.json");
}

function hasScript(repoPath: string, name: string): boolean {
  const script = readPackage(repoPath).scripts?.[name];
  return typeof script === "string" && script.trim().length > 0
    && script !== 'echo "Error: no test specified" && exit 1';
}

function commandCheck(command: { command: string; args: string[] }, result: RunnerResult): CheckResult {
  const output = combinedOutput(result);
  if (result.spawnError) return failedCheck(`spawn failed: ${result.spawnError}`, command, result, output);
  if (result.timedOut) return failedCheck("command timed out", command, result, output);
  if (result.exitCode !== 0) return failedCheck(`command exited ${result.exitCode ?? "without status"}`, command, result, output);
  return {
    status: "passed",
    command: displayCommand(command),
    exitCode: result.exitCode,
    output,
  };
}

function combinedOutput(result: RunnerResult): string {
  return `${result.stdout}${result.stderr}`.slice(-MAX_OUTPUT);
}

function displayCommand(command: { command: string; args: string[] }): string {
  return [command.command, ...command.args].join(" ");
}

function installFailure(reason: string): InstallResult {
  return { ok: false, reason, check: failedCheck(reason) };
}

function failedCheck(
  reason: string,
  command?: { command: string; args: string[] },
  result?: RunnerResult,
  output = ""
): CheckResult {
  return {
    status: "failed",
    command: command ? displayCommand(command) : null,
    exitCode: result?.exitCode ?? null,
    output,
    reason,
  };
}

function skippedCheck(reason: string): CheckResult {
  return { status: "skipped", command: null, exitCode: null, output: "", reason };
}

function emptyChecks(): VerificationChecks {
  return {
    install: skippedCheck("not run"),
    typecheck: skippedCheck("not run"),
    test: skippedCheck("not requested"),
    lint: skippedCheck("not requested"),
  };
}

function failedVerification(runner: string, checks: VerificationChecks, reason: string): VerifyResult {
  return {
    ok: false,
    baseline: [],
    after: [],
    introduced: [],
    skipped: true,
    skipReason: reason,
    runner,
    checks,
  };
}

function signature(error: TypeError): string {
  return `${error.file}:${error.line}:${error.code}:${error.message}`;
}
