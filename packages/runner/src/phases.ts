import {
  chmodSync,
  cpSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  copyGitFreeTree,
  createPreflightId,
  inspectVerifiedArtifact,
  publicationBlockers,
  resolveMigrationBranch,
  sanitizeMigrationReport,
} from "@api-migrator/app/runner-internal";
import {
  buildReport,
  detectPackageManager,
  findLockfiles,
  installDeps,
  runMigration,
  runTsc,
  verify,
  verifyNodeRuntime,
  type Manifest,
  type MigrationReport,
  type VerifyOptions,
} from "@api-migrator/engine";
import {
  createPreparedDependencyState,
  createDependencyState,
  createInstallOutputState,
  installCheckFromState,
  readAndVerifyPreparedDependencyState,
  readAndVerifyPreparedInstallState,
  readAndVerifyDependencyState,
  readAndVerifyInstallOutputState,
  writePreparedDependencyState,
  writeDependencyState,
  writeInstallOutputState,
  type DependencyStateRecord,
  type InstallOutputStateRecord,
  type PreparedDependencyStateRecord,
} from "./dependency-state.js";
import { createRunnerEvidence, writeRunnerEvidence, type RunnerEvidenceRecord } from "./evidence.js";
import {
  assertCanonicalDirectory,
  assertEmptyDirectory,
  assertRegularTreesEqual,
  changedRegularPaths,
  collectRegularTree,
  regularTreeDigest,
  removeNodeModulesTrees,
  sha256,
} from "./filesystem.js";
import { gitObjectFormatFromOid, gitTreeOid, type GitTreeEntry } from "./git-tree.js";
import {
  loadDependencyManifest,
  loadPlan,
  loadRunnerInputs,
  persistDependencyManifest,
} from "./inputs.js";
import { extractSourceBundle, extractSourceBundleIntoDirectory } from "./source-bundle.js";
import { PublicationVerificationRunner } from "./verification-runner.js";

const PILOT_LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);

export interface InstallPhaseInput {
  planPath: string;
  installationPath: string;
  preparedStateDigest: string;
  now?: number;
}

export interface PreparePhaseInput {
  planPath: string;
  sourcePath: string;
  dependenciesPath: string;
  installationPath: string;
  now?: number;
}

export interface MigratePhaseInput {
  planPath: string;
  sourcePath: string;
  dependenciesPath: string;
  installationPath: string;
  outputPath: string;
  preparedStateDigest: string;
  installStateDigest: string;
  now?: number;
}

export interface VerifyPhaseInput {
  planPath: string;
  inputPath: string;
  dependenciesPath: string;
  resultPath: string;
  dependencyStateDigest: string;
  now?: number;
}

export async function runPreparePhase(input: PreparePhaseInput): Promise<PreparedDependencyStateRecord> {
  const validated = loadRunnerInputs(input.planPath, input.sourcePath, input.now);
  const dependencies = assertEmptyDirectory(
    resolve(input.dependenciesPath),
    "dependency output directory"
  );
  const installation = assertEmptyDirectory(
    resolve(input.installationPath),
    "online install output directory"
  );
  const original = join(dependencies, "original");
  const baseline = join(dependencies, "baseline");
  const candidate = join(dependencies, "candidate");
  try {
    extractSourceBundle(validated.source, original);
    extractSourceBundle(validated.source, baseline);
    extractSourceBundle(validated.source, candidate);
    const originalLockfile = assertNpmPilotRepository(original);
    const baselineLockfile = assertNpmPilotRepository(baseline);

    await runMigration(validated.manifest, candidate, {
      writeChanges: true,
      skipVerify: true,
      verify: { install: true },
    });
    const candidateLockfile = assertNpmPilotRepository(candidate);
    if (originalLockfile !== baselineLockfile || originalLockfile !== candidateLockfile) {
      throw new Error("Runner v1 requires one stable npm lockfile identity across preparation");
    }

    persistDependencyManifest(dependencies, validated.manifestJson);
    createInstallProjection(baseline, join(installation, "baseline"), baselineLockfile);
    createInstallProjection(candidate, join(installation, "candidate"), candidateLockfile);
    const prepared = createPreparedDependencyState(
      dependencies,
      installation,
      originalLockfile,
      validated.plan,
      input.now
    );
    writePreparedDependencyState(dependencies, prepared);
    writePreparedDependencyState(installation, prepared);
    return prepared;
  } catch (error) {
    for (const path of [
      join(dependencies, "prepared-state.json"), join(dependencies, "manifest.json"),
      candidate, baseline, original,
    ]) {
      rmSync(path, { recursive: true, force: true });
    }
    for (const path of [
      join(installation, "prepared-state.json"),
      join(installation, "candidate"),
      join(installation, "baseline"),
    ]) {
      rmSync(path, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function runInstallPhase(input: InstallPhaseInput): Promise<InstallOutputStateRecord> {
  const plan = loadPlan(input.planPath, input.now);
  const installation = assertCanonicalDirectory(
    resolve(input.installationPath),
    "prepared install directory"
  );
  const preparedState = readAndVerifyPreparedInstallState(
    installation,
    plan,
    input.preparedStateDigest
  );
  const baseline = join(installation, "baseline");
  const candidate = join(installation, "candidate");
  try {
    assertInstallProjection(baseline, preparedState, "baseline", false);
    assertInstallProjection(candidate, preparedState, "candidate", false);

    const installRunner = new PublicationVerificationRunner("default");
    const baselineInstall = installDeps(baseline, installOptions(installRunner));
    if (!baselineInstall.ok) {
      throw new Error(`Baseline dependency installation failed: ${baselineInstall.reason ?? "unknown failure"}`);
    }
    const candidateInstall = installDeps(candidate, installOptions(installRunner));
    if (!candidateInstall.ok) {
      throw new Error(`Candidate dependency installation failed: ${candidateInstall.reason ?? "unknown failure"}`);
    }
    assertInstallProjection(baseline, preparedState, "baseline", true);
    assertInstallProjection(candidate, preparedState, "candidate", true);

    const state = createInstallOutputState(
      installation,
      plan,
      preparedState.digest,
      baselineInstall.check,
      candidateInstall.check,
      input.now
    );
    writeInstallOutputState(installation, state);
    return state;
  } catch (error) {
    rmSync(join(installation, "state.json"), { force: true });
    try {
      removeNodeModulesTrees(baseline);
      removeNodeModulesTrees(candidate);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Dependency installation failed and partial node_modules cleanup was incomplete"
      );
    }
    throw error;
  }
}

export async function runMigratePhase(input: MigratePhaseInput): Promise<DependencyStateRecord> {
  const validated = loadRunnerInputs(input.planPath, input.sourcePath, input.now);
  const dependencies = assertCanonicalDirectory(resolve(input.dependenciesPath), "dependency state directory");
  const installation = assertCanonicalDirectory(resolve(input.installationPath), "install output directory");
  const prepared = readAndVerifyPreparedDependencyState(
    dependencies,
    validated.plan,
    input.preparedStateDigest
  );
  const installed = readAndVerifyInstallOutputState(
    installation,
    validated.plan,
    prepared,
    input.installStateDigest
  );
  const persistedManifest = loadDependencyManifest(dependencies, validated.plan);
  if (persistedManifest.canonical !== validated.manifestJson) {
    throw new Error("Dependency and source manifests do not match");
  }
  const output = assertEmptyDirectory(resolve(input.outputPath), "migration output directory");
  const lockBackups = capturePreparedLockfiles(dependencies, prepared);
  try {
    materializeInstalledDependencies(dependencies, installation, prepared);
    const dependencyState = createDependencyState(
      dependencies,
      validated.plan,
      { ...installed.state.install.baseline, output: "" },
      { ...installed.state.install.candidate, output: "" },
      prepared.digest,
      installed.digest,
      input.now
    );
    writeDependencyState(dependencies, dependencyState);
    extractSourceBundleIntoDirectory(validated.source, output);
    await runMigration(validated.manifest, output, {
      writeChanges: true,
      skipVerify: true,
    });
    synchronizeCandidateLockfile(join(dependencies, "candidate"), output);
    assertRegularTreesEqual(join(dependencies, "candidate"), output, "offline migration output");
    return dependencyState;
  } catch (error) {
    clearDirectory(output);
    rmSync(join(dependencies, "state.json"), { force: true });
    for (const name of ["baseline", "candidate"] as const) {
      removeNodeModulesTrees(join(dependencies, name));
      const backup = lockBackups[name];
      writeFileSync(join(dependencies, name, backup.name), backup.bytes, { mode: backup.mode });
      chmodSync(join(dependencies, name, backup.name), backup.mode);
    }
    throw error;
  }
}

export async function runVerifyPhase(input: VerifyPhaseInput): Promise<RunnerEvidenceRecord> {
  const plan = loadPlan(input.planPath, input.now);
  const dependencies = assertCanonicalDirectory(resolve(input.dependenciesPath), "dependency state directory");
  const proposed = assertCanonicalDirectory(resolve(input.inputPath), "sealed migration input");
  const result = assertEmptyDirectory(resolve(input.resultPath), "runner result directory");
  const state = readAndVerifyDependencyState(dependencies, plan, input.dependencyStateDigest);
  const { manifest } = loadDependencyManifest(dependencies, plan);
  const original = join(dependencies, "original");
  const baseline = join(dependencies, "baseline");
  const candidateDependencies = join(dependencies, "candidate");
  assertRegularTreesEqual(candidateDependencies, proposed, "sealed migration input");

  const temporary = mkdtempSync(join(tmpdir(), "api-migrator-runner-verify-"));
  const replay = join(temporary, "replay");
  try {
    copyGitFreeTree(original, replay);
    const { report: migrationReport, requiredVerificationFiles } = await runMigration(manifest, replay, {
      writeChanges: true,
      skipVerify: true,
      verify: { install: true },
    });
    synchronizeCandidateLockfile(candidateDependencies, replay);
    assertRegularTreesEqual(candidateDependencies, replay, "replayed migration output");
    assertRegularTreesEqual(proposed, replay, "sealed and replayed migration output");

    const verificationRunner = new PublicationVerificationRunner("none");
    const baselineResult = await runTsc(baseline, verificationOptions(
      verificationRunner,
      baseline,
      false,
      requiredVerificationFiles
    ));
    if (baselineResult.skipped) {
      throw new Error(`Baseline verification is unavailable: ${baselineResult.skipReason ?? "unknown failure"}`);
    }

    symlinkSync(join(candidateDependencies, "node_modules"), join(replay, "node_modules"));
    const verification = await verify(
      replay,
      baselineResult.after,
      verificationOptions(
        verificationRunner,
        candidateDependencies,
        true,
        requiredVerificationFiles
      )
    );
    verification.checks.install = installCheckFromState(state.state);
    verification.checks.runtime = verifyNodeRuntime(proposed, requiredRuntime(manifest));
    verification.ok = verification.ok
      && verification.checks.install.status === "passed"
      && verification.checks.runtime.status === "passed";
    if (!verification.ok || verification.skipped) {
      throw new Error(`Offline runner verification failed: ${verification.skipReason ?? "a required check failed"}`);
    }

    assertRegularTreesEqual(proposed, replay, "verified replay output");
    const sealedCandidate = deriveSealedCandidateIdentity(
      original,
      proposed,
      plan.plan.subject.base.sha
    );
    const { changedFiles, artifact, candidateTreeSha, outputTreeDigest } = sealedCandidate;
    const report = sanitizeMigrationReport(buildFinalReport(migrationReport, changedFiles, verification));
    const blockers = publicationBlockers(report);
    if (blockers.length > 0) {
      throw new Error(
        `Offline runner verification blocked publication: ${blockers
          .map((blocker) => blocker.message)
          .join("; ")}`
      );
    }
    const targetBranch = resolveMigrationBranch(
      manifest,
      plan.plan.subject.base.branch,
      plan.plan.subject.base.sha,
      artifact.digest
    );
    const output = {
      preflightId: createPreflightId({
        slug: plan.plan.subject.repository.slug,
        baseBranch: plan.plan.subject.base.branch,
        baseSha: plan.plan.subject.base.sha,
        targetBranch,
        candidateTreeSha,
        artifactDigest: artifact.digest,
        manifest,
        report,
      }),
      artifactDigest: `sha256:${artifact.digest}`,
      candidateTreeSha,
    };
    const evidence = createRunnerEvidence({
      plan,
      dependencyState: state,
      outputTreeDigest,
      output,
      targetBranch,
      report,
      blockers,
    });
    writeRunnerEvidence(join(result, "runner-evidence.json"), evidence);
    return evidence;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function deriveSealedCandidateIdentity(
  original: string,
  proposed: string,
  baseSha: string
) {
  const changedFiles = changedRegularPaths(original, proposed);
  const artifact = inspectVerifiedArtifact(original, proposed, changedFiles);
  return {
    changedFiles,
    artifact,
    candidateTreeSha: gitTreeOid(
      gitTreeEntries(proposed),
      gitObjectFormatFromOid(baseSha)
    ),
    outputTreeDigest: regularTreeDigest(proposed),
  };
}

function installOptions(runner: PublicationVerificationRunner): VerifyOptions {
  return {
    install: true,
    lifecycleScripts: false,
    runner,
    env: {},
    installTimeoutMs: 300_000,
  };
}

function verificationOptions(
  runner: PublicationVerificationRunner,
  dependenciesRoot: string,
  scripts = false,
  requiredFiles: string[] = []
): VerifyOptions {
  return {
    install: false,
    lifecycleScripts: false,
    runner,
    preinstalledDependenciesRoot: dependenciesRoot,
    requiredFiles,
    runTests: scripts,
    runLint: scripts,
    env: {},
    typecheckTimeoutMs: 120_000,
    testTimeoutMs: 180_000,
    lintTimeoutMs: 120_000,
  };
}

function assertNpmPilotRepository(
  root: string
): "package-lock.json" | "npm-shrinkwrap.json" {
  if (detectPackageManager(root) !== "npm") {
    throw new Error("Runner v1 supports only npm repositories");
  }
  const packageFiles = [...collectRegularTree(root).keys()]
    .filter((path) => path === "package.json" || path.endsWith("/package.json"));
  if (packageFiles.length !== 1 || packageFiles[0] !== "package.json") {
    throw new Error("Runner v1 supports only a single root npm package");
  }
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  if (packageJson.workspaces !== undefined) {
    throw new Error("Runner v1 does not expose npm workspaces to the online install phase");
  }
  const lockfiles = findLockfiles(root);
  if (lockfiles.length !== 1 || !PILOT_LOCKFILES.has(lockfiles[0]!)) {
    throw new Error("Runner v1 requires exactly one npm package-lock or shrinkwrap file");
  }
  return lockfiles[0] as "package-lock.json" | "npm-shrinkwrap.json";
}

function createInstallProjection(
  sourceRoot: string,
  destinationRoot: string,
  lockfile: "package-lock.json" | "npm-shrinkwrap.json"
): void {
  mkdirSync(destinationRoot, { mode: 0o700 });
  for (const name of ["package.json", lockfile]) {
    const source = join(sourceRoot, name);
    const destination = join(destinationRoot, name);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Install projection input must be a single regular file: ${name}`);
    }
    copyFileSync(source, destination);
    chmodSync(destination, stat.mode & 0o777);
  }
}

function assertInstallProjection(
  root: string,
  prepared: PreparedDependencyStateRecord,
  name: "baseline" | "candidate",
  installed: boolean
): void {
  const anchor = prepared.state.installRoots[name];
  const expected = ["package.json", anchor.lockfile, ...(installed ? ["node_modules"] : [])].sort();
  const actual = readdirSync(root).sort();
  if (actual.join("\0") !== expected.join("\0")) {
    throw new Error(`${name} install projection contains files outside the fixed npm scope`);
  }
  for (const file of ["package.json", anchor.lockfile]) {
    const stat = lstatSync(join(root, file));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`${name} install projection contains an invalid ${file}`);
    }
  }
  if (sha256(readFileSync(join(root, "package.json"))) !== anchor.packageJsonDigest) {
    throw new Error(`${name} package.json changed during the online install phase`);
  }
  if (installed) {
    const modules = join(root, "node_modules");
    const stat = lstatSync(modules);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(modules) !== modules) {
      throw new Error(`${name} install projection did not produce a real node_modules directory`);
    }
  }
}

function capturePreparedLockfiles(
  dependencies: string,
  prepared: PreparedDependencyStateRecord
): Record<"baseline" | "candidate", { name: string; bytes: Buffer; mode: number }> {
  return Object.fromEntries((["baseline", "candidate"] as const).map((name) => {
    const lockfile = prepared.state.roots[name].lockfile;
    const path = join(dependencies, name, lockfile);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`${name} prepared lockfile is not a single regular file`);
    }
    return [name, { name: lockfile, bytes: readFileSync(path), mode: stat.mode & 0o777 }];
  })) as Record<"baseline" | "candidate", { name: string; bytes: Buffer; mode: number }>;
}

function materializeInstalledDependencies(
  dependencies: string,
  installation: string,
  prepared: PreparedDependencyStateRecord
): void {
  for (const name of ["baseline", "candidate"] as const) {
    const sourceRoot = join(dependencies, name);
    const installRoot = join(installation, name);
    assertInstallProjection(installRoot, prepared, name, true);
    if (!readFileSync(join(sourceRoot, "package.json")).equals(readFileSync(join(installRoot, "package.json")))) {
      throw new Error(`${name} online package manifest does not match the offline source anchor`);
    }
    const lockfile = prepared.state.roots[name].lockfile;
    if (lockfile !== prepared.state.installRoots[name].lockfile) {
      throw new Error(`${name} install projection changed lockfile identity`);
    }
    const installedLock = join(installRoot, lockfile);
    const sourceLock = join(sourceRoot, lockfile);
    const lockStat = lstatSync(installedLock);
    if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.nlink !== 1) {
      throw new Error(`${name} installed lockfile is not a single regular file`);
    }
    copyFileSync(installedLock, sourceLock);
    chmodSync(sourceLock, lockStat.mode & 0o777);
    cpSync(join(installRoot, "node_modules"), join(sourceRoot, "node_modules"), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
      verbatimSymlinks: true,
    });
  }
}

function synchronizeCandidateLockfile(candidateRoot: string, outputRoot: string): void {
  const candidateLocks = findLockfiles(candidateRoot);
  const outputLocks = findLockfiles(outputRoot);
  if (
    candidateLocks.length !== 1
    || outputLocks.length !== 1
    || candidateLocks[0] !== outputLocks[0]
    || !PILOT_LOCKFILES.has(candidateLocks[0]!)
  ) {
    throw new Error("Candidate and output lockfile identities do not match the npm pilot profile");
  }
  const lockfile = candidateLocks[0]!;
  const source = join(candidateRoot, lockfile);
  const destination = join(outputRoot, lockfile);
  const sourceStat = lstatSync(source);
  const destinationStat = lstatSync(destination);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !destinationStat.isFile() || destinationStat.isSymbolicLink()) {
    throw new Error("Candidate lockfile must remain a regular file");
  }
  copyFileSync(source, destination);
  chmodSync(destination, sourceStat.mode & 0o777);
}

function requiredRuntime(manifest: Manifest): NonNullable<Manifest["runtime"]>["node"] {
  if (!manifest.runtime?.node) throw new Error("Runner v1 requires the audited Node runtime declaration");
  return manifest.runtime.node;
}

function buildFinalReport(
  migration: MigrationReport,
  changedFiles: string[],
  verification: Awaited<ReturnType<typeof verify>>
): MigrationReport {
  return buildReport(
    migration.manifest,
    migration.scannedFiles,
    changedFiles,
    migration.entries,
    verification
  );
}

function gitTreeEntries(root: string): GitTreeEntry[] {
  return [...collectRegularTree(root)].map(([path, entry]) => ({
    path,
    mode: entry.mode === 0o100755 ? "100755" as const : "100644" as const,
    content: readFileSync(join(root, ...path.split("/"))),
  }));
}

function clearDirectory(root: string): void {
  for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
}
