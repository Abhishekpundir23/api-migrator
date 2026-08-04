import { constants, openSync, closeSync, writeSync, fsyncSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  parseCanonicalJson,
  type PublicationRunnerPlanRecord,
} from "@api-migrator/app/runner-internal";
import type { CheckResult } from "@api-migrator/engine";
import {
  assertPreparedTreePristine,
  dependencyTreeDigest,
  regularTreeDigest,
  regularTreeDigestExcluding,
  sha256,
} from "./filesystem.js";

const STATE_KIND = "api-migrator-dependency-state-v1";
const PREPARED_STATE_KIND = "api-migrator-prepared-dependency-state-v1";
const INSTALL_STATE_KIND = "api-migrator-install-output-state-v1";
const MAX_STATE_BYTES = 32 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface DependencyStateV1 {
  schemaVersion: 1;
  kind: typeof STATE_KIND;
  planDigest: string;
  jobId: string;
  sourceArchiveDigest: string;
  manifestDigest: string;
  commandScopeDigest: string;
  preparedStateDigest: string;
  installStateDigest: string;
  createdAt: number;
  roots: {
    original: { path: "original"; treeDigest: string };
    baseline: { path: "baseline"; treeDigest: string };
    candidate: { path: "candidate"; treeDigest: string };
  };
  install: {
    manager: "npm";
    baseline: StoredInstallCheck;
    candidate: StoredInstallCheck;
  };
}

export interface StoredInstallCheck {
  status: "passed";
  command: string;
  exitCode: 0;
}

export interface DependencyStateRecord {
  state: Readonly<DependencyStateV1>;
  canonicalJson: string;
  digest: string;
}

export interface PreparedDependencyStateV1 {
  schemaVersion: 1;
  kind: typeof PREPARED_STATE_KIND;
  planDigest: string;
  jobId: string;
  sourceArchiveDigest: string;
  manifestDigest: string;
  commandScopeDigest: string;
  createdAt: number;
  roots: {
    original: PreparedSourceRoot<"original">;
    baseline: PreparedSourceRoot<"baseline">;
    candidate: PreparedSourceRoot<"candidate">;
  };
  installRoots: {
    baseline: PreparedInstallRoot<"baseline">;
    candidate: PreparedInstallRoot<"candidate">;
  };
}

export interface PreparedSourceRoot<Name extends "original" | "baseline" | "candidate"> {
  path: Name;
  treeDigest: string;
  sourceTreeDigest: string;
  lockfile: "package-lock.json" | "npm-shrinkwrap.json";
}

export interface PreparedInstallRoot<Name extends "baseline" | "candidate"> {
  path: Name;
  treeDigest: string;
  packageJsonDigest: string;
  lockfile: "package-lock.json" | "npm-shrinkwrap.json";
}

export interface PreparedDependencyStateRecord {
  state: Readonly<PreparedDependencyStateV1>;
  canonicalJson: string;
  digest: string;
}

export interface InstallOutputStateV1 {
  schemaVersion: 1;
  kind: typeof INSTALL_STATE_KIND;
  planDigest: string;
  jobId: string;
  preparedStateDigest: string;
  createdAt: number;
  roots: {
    baseline: { path: "baseline"; treeDigest: string };
    candidate: { path: "candidate"; treeDigest: string };
  };
  install: {
    manager: "npm";
    baseline: StoredInstallCheck;
    candidate: StoredInstallCheck;
  };
}

export interface InstallOutputStateRecord {
  state: Readonly<InstallOutputStateV1>;
  canonicalJson: string;
  digest: string;
}

export function createPreparedDependencyState(
  root: string,
  installRoot: string,
  lockfile: "package-lock.json" | "npm-shrinkwrap.json",
  plan: PublicationRunnerPlanRecord,
  now = Date.now()
): PreparedDependencyStateRecord {
  return preparedStateRecord({
    schemaVersion: 1,
    kind: PREPARED_STATE_KIND,
    planDigest: plan.digest,
    jobId: plan.plan.job.id,
    sourceArchiveDigest: plan.plan.inputs.sourceArchiveDigest,
    manifestDigest: plan.plan.inputs.manifestDigest,
    commandScopeDigest: plan.plan.inputs.commandScopeDigest,
    createdAt: timestampWithinPlan(now, plan),
    roots: {
      original: preparedSourceRoot(root, "original", lockfile),
      baseline: preparedSourceRoot(root, "baseline", lockfile),
      candidate: preparedSourceRoot(root, "candidate", lockfile),
    },
    installRoots: {
      baseline: preparedInstallRoot(installRoot, "baseline", lockfile),
      candidate: preparedInstallRoot(installRoot, "candidate", lockfile),
    },
  });
}

export function writePreparedDependencyState(
  root: string,
  record: PreparedDependencyStateRecord
): string {
  return writeCanonicalState(join(root, "prepared-state.json"), record.canonicalJson);
}

export function readAndVerifyPreparedDependencyState(
  root: string,
  plan: PublicationRunnerPlanRecord,
  expectedDigest?: string
): PreparedDependencyStateRecord {
  const bytes = readFileSync(join(root, "prepared-state.json"));
  const parsed = parseCanonicalJson(bytes, MAX_STATE_BYTES, "prepared dependency state");
  const state = validatePreparedState(parsed, plan);
  const record = preparedStateRecord(state);
  if (expectedDigest !== undefined && record.digest !== digest(expectedDigest, "expected prepared state digest")) {
    throw new Error("prepared dependency state does not match the host-sealed digest");
  }
  for (const name of ["original", "baseline", "candidate"] as const) {
    if (preparedRootDigest(root, name) !== state.roots[name].treeDigest) {
      throw new Error(`${name} prepared tree does not match its sealed state`);
    }
  }
  return record;
}

export function readAndVerifyPreparedInstallState(
  root: string,
  plan: PublicationRunnerPlanRecord,
  expectedDigest: string
): PreparedDependencyStateRecord {
  const bytes = readFileSync(join(root, "prepared-state.json"));
  const parsed = parseCanonicalJson(bytes, MAX_STATE_BYTES, "prepared install state");
  const record = preparedStateRecord(validatePreparedState(parsed, plan));
  if (record.digest !== digest(expectedDigest, "expected prepared state digest")) {
    throw new Error("prepared install state does not match the host-sealed digest");
  }
  for (const name of ["baseline", "candidate"] as const) {
    if (preparedRootDigest(root, name) !== record.state.installRoots[name].treeDigest) {
      throw new Error(`${name} install projection does not match its sealed state`);
    }
  }
  return record;
}

export function createInstallOutputState(
  root: string,
  plan: PublicationRunnerPlanRecord,
  preparedStateDigest: string,
  baselineCheck: CheckResult,
  candidateCheck: CheckResult,
  now = Date.now()
): InstallOutputStateRecord {
  return installStateRecord({
    schemaVersion: 1,
    kind: INSTALL_STATE_KIND,
    planDigest: plan.digest,
    jobId: plan.plan.job.id,
    preparedStateDigest: digest(preparedStateDigest, "prepared state digest"),
    createdAt: timestampWithinPlan(now, plan),
    roots: {
      baseline: { path: "baseline", treeDigest: dependencyTreeDigest(join(root, "baseline")) },
      candidate: { path: "candidate", treeDigest: dependencyTreeDigest(join(root, "candidate")) },
    },
    install: {
      manager: "npm",
      baseline: passedInstallCheck(baselineCheck, "baseline"),
      candidate: passedInstallCheck(candidateCheck, "candidate"),
    },
  });
}

export function writeInstallOutputState(root: string, record: InstallOutputStateRecord): string {
  return writeCanonicalState(join(root, "state.json"), record.canonicalJson);
}

export function readAndVerifyInstallOutputState(
  root: string,
  plan: PublicationRunnerPlanRecord,
  prepared: PreparedDependencyStateRecord,
  expectedDigest: string
): InstallOutputStateRecord {
  const bytes = readFileSync(join(root, "state.json"));
  const parsed = parseCanonicalJson(bytes, MAX_STATE_BYTES, "install output state");
  const record = installStateRecord(validateInstallState(parsed, plan));
  if (record.digest !== digest(expectedDigest, "expected install state digest")) {
    throw new Error("install output state does not match the host-sealed digest");
  }
  if (record.state.preparedStateDigest !== prepared.digest) {
    throw new Error("install output state does not bind the prepared source state");
  }
  for (const name of ["baseline", "candidate"] as const) {
    if (dependencyTreeDigest(join(root, name)) !== record.state.roots[name].treeDigest) {
      throw new Error(`${name} install output does not match its sealed state`);
    }
  }
  return record;
}

export function createDependencyState(
  root: string,
  plan: PublicationRunnerPlanRecord,
  baselineCheck: CheckResult,
  candidateCheck: CheckResult,
  preparedStateDigest: string,
  installStateDigest: string,
  now = Date.now()
): DependencyStateRecord {
  const state: DependencyStateV1 = {
    schemaVersion: 1,
    kind: STATE_KIND,
    planDigest: plan.digest,
    jobId: plan.plan.job.id,
    sourceArchiveDigest: plan.plan.inputs.sourceArchiveDigest,
    manifestDigest: plan.plan.inputs.manifestDigest,
    commandScopeDigest: plan.plan.inputs.commandScopeDigest,
    preparedStateDigest: digest(preparedStateDigest, "prepared state digest"),
    installStateDigest: digest(installStateDigest, "install state digest"),
    createdAt: timestampWithinPlan(now, plan),
    roots: {
      original: { path: "original", treeDigest: regularTreeDigest(join(root, "original")) },
      baseline: { path: "baseline", treeDigest: dependencyTreeDigest(join(root, "baseline")) },
      candidate: { path: "candidate", treeDigest: dependencyTreeDigest(join(root, "candidate")) },
    },
    install: {
      manager: "npm",
      baseline: passedInstallCheck(baselineCheck, "baseline"),
      candidate: passedInstallCheck(candidateCheck, "candidate"),
    },
  };
  return stateRecord(state);
}

export function writeDependencyState(root: string, record: DependencyStateRecord): string {
  return writeCanonicalState(join(root, "state.json"), record.canonicalJson);
}

export function readAndVerifyDependencyState(
  root: string,
  plan: PublicationRunnerPlanRecord,
  expectedDigest?: string
): DependencyStateRecord {
  const bytes = readFileSync(join(root, "state.json"));
  const parsed = parseCanonicalJson(bytes, MAX_STATE_BYTES, "dependency state");
  const state = validateState(parsed, plan);
  const record = stateRecord(state);
  if (expectedDigest !== undefined && record.digest !== digest(expectedDigest, "expected dependency state digest")) {
    throw new Error("dependency state does not match the host-sealed digest");
  }
  const preparedBytes = readFileSync(join(root, "prepared-state.json"));
  const prepared = preparedStateRecord(validatePreparedState(
    parseCanonicalJson(preparedBytes, MAX_STATE_BYTES, "prepared dependency state"),
    plan
  ));
  if (prepared.digest !== state.preparedStateDigest) {
    throw new Error("dependency state does not bind the retained prepared state");
  }
  if (regularTreeDigest(join(root, "original")) !== state.roots.original.treeDigest) {
    throw new Error("original source tree does not match its sealed state");
  }
  if (dependencyTreeDigest(join(root, "baseline")) !== state.roots.baseline.treeDigest) {
    throw new Error("baseline dependency tree does not match its sealed state");
  }
  if (dependencyTreeDigest(join(root, "candidate")) !== state.roots.candidate.treeDigest) {
    throw new Error("candidate dependency tree does not match its sealed state");
  }
  if (regularTreeDigest(join(root, "original")) !== prepared.state.roots.original.treeDigest) {
    throw new Error("original source tree no longer matches its offline preparation anchor");
  }
  for (const name of ["baseline", "candidate"] as const) {
    const anchor = prepared.state.roots[name];
    if (regularTreeDigestExcluding(join(root, name), [anchor.lockfile]) !== anchor.sourceTreeDigest) {
      throw new Error(`${name} source bytes no longer match the offline preparation anchor`);
    }
  }
  return record;
}

export function installCheckFromState(state: DependencyStateV1): CheckResult {
  return { ...state.install.candidate, output: "" };
}

function validateState(value: unknown, plan: PublicationRunnerPlanRecord): DependencyStateV1 {
  const root = object(value, "dependency state");
  exactKeys(root, [
    "schemaVersion", "kind", "planDigest", "jobId", "sourceArchiveDigest",
    "manifestDigest", "commandScopeDigest", "preparedStateDigest", "installStateDigest", "createdAt", "roots", "install",
  ], "dependency state");
  if (root.schemaVersion !== 1 || root.kind !== STATE_KIND) throw new Error("dependency state profile is unsupported");
  const roots = object(root.roots, "dependency roots");
  exactKeys(roots, ["original", "baseline", "candidate"], "dependency roots");
  const original = validateRoot(roots.original, "original");
  const baseline = validateRoot(roots.baseline, "baseline");
  const candidate = validateRoot(roots.candidate, "candidate");
  const install = object(root.install, "dependency install state");
  exactKeys(install, ["manager", "baseline", "candidate"], "dependency install state");
  if (install.manager !== "npm") throw new Error("dependency state package manager is unsupported");
  const state: DependencyStateV1 = {
    schemaVersion: 1,
    kind: STATE_KIND,
    planDigest: digest(root.planDigest, "state plan digest"),
    jobId: text(root.jobId, "state job id", 80),
    sourceArchiveDigest: digest(root.sourceArchiveDigest, "state source digest"),
    manifestDigest: digest(root.manifestDigest, "state manifest digest"),
    commandScopeDigest: digest(root.commandScopeDigest, "state command digest"),
    preparedStateDigest: digest(root.preparedStateDigest, "prepared state digest"),
    installStateDigest: digest(root.installStateDigest, "install state digest"),
    createdAt: timestampWithinPlan(root.createdAt, plan),
    roots: { original, baseline, candidate },
    install: {
      manager: "npm",
      baseline: validateStoredInstallCheck(install.baseline, "baseline"),
      candidate: validateStoredInstallCheck(install.candidate, "candidate"),
    },
  };
  if (
    state.planDigest !== plan.digest
    || state.jobId !== plan.plan.job.id
    || state.sourceArchiveDigest !== plan.plan.inputs.sourceArchiveDigest
    || state.manifestDigest !== plan.plan.inputs.manifestDigest
    || state.commandScopeDigest !== plan.plan.inputs.commandScopeDigest
  ) {
    throw new Error("dependency state does not bind the current runner plan");
  }
  return state;
}

function validatePreparedState(
  value: unknown,
  plan: PublicationRunnerPlanRecord
): PreparedDependencyStateV1 {
  const root = object(value, "prepared dependency state");
  exactKeys(root, [
    "schemaVersion", "kind", "planDigest", "jobId", "sourceArchiveDigest",
    "manifestDigest", "commandScopeDigest", "createdAt", "roots", "installRoots",
  ], "prepared dependency state");
  if (root.schemaVersion !== 1 || root.kind !== PREPARED_STATE_KIND) {
    throw new Error("prepared dependency state profile is unsupported");
  }
  const roots = object(root.roots, "prepared dependency roots");
  exactKeys(roots, ["original", "baseline", "candidate"], "prepared dependency roots");
  const installRoots = object(root.installRoots, "prepared install roots");
  exactKeys(installRoots, ["baseline", "candidate"], "prepared install roots");
  const state: PreparedDependencyStateV1 = {
    schemaVersion: 1,
    kind: PREPARED_STATE_KIND,
    planDigest: digest(root.planDigest, "prepared plan digest"),
    jobId: text(root.jobId, "prepared job id", 80),
    sourceArchiveDigest: digest(root.sourceArchiveDigest, "prepared source digest"),
    manifestDigest: digest(root.manifestDigest, "prepared manifest digest"),
    commandScopeDigest: digest(root.commandScopeDigest, "prepared command digest"),
    createdAt: timestampWithinPlan(root.createdAt, plan),
    roots: {
      original: validatePreparedSourceRoot(roots.original, "original"),
      baseline: validatePreparedSourceRoot(roots.baseline, "baseline"),
      candidate: validatePreparedSourceRoot(roots.candidate, "candidate"),
    },
    installRoots: {
      baseline: validatePreparedInstallRoot(installRoots.baseline, "baseline"),
      candidate: validatePreparedInstallRoot(installRoots.candidate, "candidate"),
    },
  };
  if (state.planDigest !== plan.digest || state.jobId !== plan.plan.job.id ||
      state.sourceArchiveDigest !== plan.plan.inputs.sourceArchiveDigest ||
      state.manifestDigest !== plan.plan.inputs.manifestDigest ||
      state.commandScopeDigest !== plan.plan.inputs.commandScopeDigest) {
    throw new Error("prepared dependency state does not bind the current runner plan");
  }
  return state;
}

function validateInstallState(
  value: unknown,
  plan: PublicationRunnerPlanRecord
): InstallOutputStateV1 {
  const root = object(value, "install output state");
  exactKeys(root, [
    "schemaVersion", "kind", "planDigest", "jobId", "preparedStateDigest",
    "createdAt", "roots", "install",
  ], "install output state");
  if (root.schemaVersion !== 1 || root.kind !== INSTALL_STATE_KIND) {
    throw new Error("install output state profile is unsupported");
  }
  const roots = object(root.roots, "install output roots");
  exactKeys(roots, ["baseline", "candidate"], "install output roots");
  const install = object(root.install, "install output checks");
  exactKeys(install, ["manager", "baseline", "candidate"], "install output checks");
  if (install.manager !== "npm") throw new Error("install output package manager is unsupported");
  const state: InstallOutputStateV1 = {
    schemaVersion: 1,
    kind: INSTALL_STATE_KIND,
    planDigest: digest(root.planDigest, "install state plan digest"),
    jobId: text(root.jobId, "install state job id", 80),
    preparedStateDigest: digest(root.preparedStateDigest, "prepared state digest"),
    createdAt: timestampWithinPlan(root.createdAt, plan),
    roots: {
      baseline: validateRoot(roots.baseline, "baseline"),
      candidate: validateRoot(roots.candidate, "candidate"),
    },
    install: {
      manager: "npm",
      baseline: validateStoredInstallCheck(install.baseline, "baseline"),
      candidate: validateStoredInstallCheck(install.candidate, "candidate"),
    },
  };
  if (state.planDigest !== plan.digest || state.jobId !== plan.plan.job.id) {
    throw new Error("install output state does not bind the current runner plan");
  }
  return state;
}

function validateRoot<Name extends "original" | "baseline" | "candidate">(
  value: unknown,
  name: Name
): { path: Name; treeDigest: string } {
  const root = object(value, `${name} dependency root`);
  exactKeys(root, ["path", "treeDigest"], `${name} dependency root`);
  if (root.path !== name) throw new Error(`${name} dependency root path is invalid`);
  return { path: name, treeDigest: digest(root.treeDigest, `${name} dependency digest`) };
}

function validatePreparedSourceRoot<Name extends "original" | "baseline" | "candidate">(
  value: unknown,
  name: Name
): PreparedSourceRoot<Name> {
  const root = object(value, `${name} prepared source root`);
  exactKeys(root, ["path", "treeDigest", "sourceTreeDigest", "lockfile"], `${name} prepared source root`);
  if (root.path !== name) throw new Error(`${name} prepared source root path is invalid`);
  if (root.lockfile !== "package-lock.json" && root.lockfile !== "npm-shrinkwrap.json") {
    throw new Error(`${name} prepared source lockfile is invalid`);
  }
  return {
    path: name,
    treeDigest: digest(root.treeDigest, `${name} prepared tree digest`),
    sourceTreeDigest: digest(root.sourceTreeDigest, `${name} prepared source digest`),
    lockfile: root.lockfile,
  };
}

function validatePreparedInstallRoot<Name extends "baseline" | "candidate">(
  value: unknown,
  name: Name
): PreparedInstallRoot<Name> {
  const root = object(value, `${name} prepared install root`);
  exactKeys(root, ["path", "treeDigest", "packageJsonDigest", "lockfile"], `${name} prepared install root`);
  if (root.path !== name) throw new Error(`${name} prepared install root path is invalid`);
  if (root.lockfile !== "package-lock.json" && root.lockfile !== "npm-shrinkwrap.json") {
    throw new Error(`${name} prepared install lockfile is invalid`);
  }
  return {
    path: name,
    treeDigest: digest(root.treeDigest, `${name} prepared install tree digest`),
    packageJsonDigest: digest(root.packageJsonDigest, `${name} package manifest digest`),
    lockfile: root.lockfile,
  };
}

function passedInstallCheck(check: CheckResult, name: string): StoredInstallCheck {
  if (check.status !== "passed" || check.exitCode !== 0 || typeof check.command !== "string") {
    throw new Error(`${name} dependency installation did not pass`);
  }
  if (check.command !== "npm install --ignore-scripts --no-audit --no-fund") {
    throw new Error(`${name} dependency installation command is not the fixed npm command`);
  }
  return { status: "passed", command: check.command, exitCode: 0 };
}

function validateStoredInstallCheck(value: unknown, name: string): StoredInstallCheck {
  const check = object(value, `${name} install check`);
  exactKeys(check, ["status", "command", "exitCode"], `${name} install check`);
  return passedInstallCheck({
    status: check.status as CheckResult["status"],
    command: check.command as string,
    exitCode: check.exitCode as number,
    output: "",
  }, name);
}

function stateRecord(state: DependencyStateV1): DependencyStateRecord {
  const text = canonicalJson(state);
  return Object.freeze({ state: deepFreeze(state), canonicalJson: text, digest: sha256(text) });
}

function installStateRecord(state: InstallOutputStateV1): InstallOutputStateRecord {
  const canonical = canonicalJson(state);
  return Object.freeze({ state: deepFreeze(state), canonicalJson: canonical, digest: sha256(canonical) });
}

function preparedStateRecord(state: PreparedDependencyStateV1): PreparedDependencyStateRecord {
  const canonical = canonicalJson(state);
  return Object.freeze({ state: deepFreeze(state), canonicalJson: canonical, digest: sha256(canonical) });
}

function preparedRootDigest(
  root: string,
  name: "original" | "baseline" | "candidate"
): string {
  const path = join(root, name);
  assertPreparedTreePristine(path, `${name} prepared tree`);
  return regularTreeDigest(path);
}

function preparedSourceRoot<Name extends "original" | "baseline" | "candidate">(
  root: string,
  name: Name,
  lockfile: "package-lock.json" | "npm-shrinkwrap.json"
): PreparedSourceRoot<Name> {
  return {
    path: name,
    treeDigest: preparedRootDigest(root, name),
    sourceTreeDigest: regularTreeDigestExcluding(join(root, name), [lockfile]),
    lockfile,
  };
}

function preparedInstallRoot<Name extends "baseline" | "candidate">(
  root: string,
  name: Name,
  lockfile: "package-lock.json" | "npm-shrinkwrap.json"
): PreparedInstallRoot<Name> {
  const path = join(root, name);
  return {
    path: name,
    treeDigest: preparedRootDigest(root, name),
    packageJsonDigest: sha256(readFileSync(join(path, "package.json"))),
    lockfile,
  };
}

function writeCanonicalState(path: string, canonical: string): string {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const bytes = Buffer.from(canonical, "utf8");
    if (bytes.length === 0 || bytes.length > MAX_STATE_BYTES) {
      throw new Error("dependency state exceeds its byte limit");
    }
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return path;
}

function timestampWithinPlan(value: unknown, plan: PublicationRunnerPlanRecord): number {
  if (!Number.isSafeInteger(value) || (value as number) < plan.plan.job.createdAt || (value as number) >= plan.plan.job.expiresAt) {
    throw new Error("dependency state timestamp is outside the runner plan");
  }
  return value as number;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label, 71);
  if (!DIGEST.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.join("\0") !== [...expected].sort().join("\0")) throw new Error(`${label} has unexpected or missing fields`);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
