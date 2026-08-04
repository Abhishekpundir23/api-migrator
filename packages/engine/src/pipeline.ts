/** Candidate-tree migration pipeline with rollback-capable file commits. */

import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  updateManifestDependencies,
  findLockfiles,
  isRootLockfileName,
  readRootLockfile,
} from "./dependencies.js";
import { enabledTransforms, parseManifest, type Manifest } from "./manifest.js";
import { findSourceFiles, selectSdkFiles } from "./scanner.js";
import {
  applyInngestV3ToV4,
  inngestBehavioralReviewEntries,
  type InngestProvenanceContext,
} from "./transforms/inngest-v3-to-v4.js";
import { applyKnockV0ToV1 } from "./transforms/knock-v0-to-v1.js";
import { runTsc, verify, verifyNodeRuntime, type VerifyOptions, type VerifyResult } from "./verifier.js";
import { applyNodeRuntimeMigration, planNodeRuntimeMigration } from "./runtime.js";
import { buildReport } from "./reporter.js";
import {
  MAX_PACKAGE_MANIFEST_BYTES,
  readRepositoryFile,
} from "./repository-files.js";
import type { ReportEntry, ReportSink } from "./types.js";
import type { MigrationReport } from "./reporter.js";

export interface RunMigrationOptions {
  /** Apply the proposed tree to the target. False verifies a temporary copy. */
  writeChanges?: boolean;
  /** Explicit opt-out; produces verification.ok=false and must never be publishable. */
  skipVerify?: boolean;
  verify?: VerifyOptions;
}

export interface RunMigrationResult {
  report: MigrationReport;
  /** Provider-owned and changed source files that trusted TypeScript verification must select. */
  requiredVerificationFiles: string[];
}

export async function runMigration(
  input: Manifest | unknown,
  repoPath: string,
  opts: RunMigrationOptions = {}
): Promise<RunMigrationResult> {
  // Runtime validation occurs before any copy, child process, or write.
  const manifest = parseManifest(input);
  assertRepository(repoPath);
  const writeChanges = opts.writeChanges ?? false;
  const skipVerify = opts.skipVerify ?? false;
  const enabled = enabledTransforms(manifest);
  const temporaryRoots: string[] = [];
  // Reject unsafe lockfile entries before making any candidate copies.
  findLockfiles(repoPath).forEach((file) => readRootLockfile(repoPath, file));

  try {
    const expectedPath = writeChanges
      ? copyRepository(repoPath, temporaryRoots, "original")
      : repoPath;
    const workPath = copyRepository(expectedPath, temporaryRoots, "proposed");
    const sourceFiles = findSourceFiles(workPath);
    const sdkMatchedFiles = selectSdkFiles(sourceFiles, manifest.transformSet);
    const providerSourceFiles = sdkMatchedFiles.map((file) => file.relative);
    let baseline: Awaited<ReturnType<typeof runTsc>>["after"] | null = null;
    let baselineReason: string | undefined;

    if (!skipVerify) {
      const baselinePath = copyRepository(expectedPath, temporaryRoots, "baseline");
      const baselineResult = await runTsc(
        baselinePath,
        withRequiredVerificationFiles(opts.verify, providerSourceFiles)
      );
      baseline = baselineResult.skipped ? null : baselineResult.after;
      baselineReason = baselineResult.skipReason;
    }

    const entries: ReportEntry[] = [];
    const sink: ReportSink = { push: (entry) => entries.push(entry) };

    // Validate the deployment declaration before any package or source write.
    const runtimePlan = manifest.runtime
      ? planNodeRuntimeMigration(workPath, manifest.runtime.node)
      : null;

    // Configured clients can arrive through wrappers, aliases, or computed
    // calls whose syntax defeats regex discovery. Parse every supported source
    // file so unresolved provider usage becomes a review blocker.
    const scanned = sourceFiles;
    const scannedSources = new Map(sdkMatchedFiles.map((file) => [file.relative, readFileSync(file.absolute, "utf8")] as const));
    const provenance: InngestProvenanceContext | undefined = manifest.transformSet === "inngest-v3-to-v4"
      ? { scannedSources, sourcePaths: new Set(sourceFiles.map((file) => file.relative)) }
      : undefined;
    const sourceEntries: ReportEntry[] = [];
    const sourceSink: ReportSink = { push: (entry) => sourceEntries.push(entry) };
    const sourceEdits: Array<{ absolute: string; relative: string; before: string; after: string }> = [];
    for (const file of scanned) {
      const original = readFileSync(file.absolute, "utf8");
      const next = applyTransformSet(manifest, original, file.relative, sourceSink, enabled, provenance);
      if (next != null && next !== original) {
        sourceEdits.push({ absolute: file.absolute, relative: file.relative, before: original, after: next });
      }
    }
    for (const edit of sourceEdits) {
      if (readFileSync(edit.absolute, "utf8") !== edit.before) {
        throw new Error(`Source file changed after migration planning: ${edit.relative}`);
      }
    }

    // All semantic parsing is complete before the first candidate write.
    // Package, peer-floor, and Node engine-floor updates are mandatory.
    const dependencyResult = updateManifestDependencies(workPath, manifest, sink);
    const runtimeResult = runtimePlan
      ? applyNodeRuntimeMigration(workPath, runtimePlan, sink)
      : { runtimeFiles: [] };
    for (const edit of sourceEdits) writeFileSync(edit.absolute, edit.after);
    entries.push(...sourceEntries);
    const sourceChanges = sourceEdits.map((edit) => edit.relative);

    if (manifest.transformSet === "inngest-v3-to-v4") {
      entries.push(...inngestBehavioralReviewEntries(enabled, {
        // A Node image/runtime floor does not prove whether the deployment is
        // serverless or long-running. Keep F12 unresolved until a separately
        // validated deployment-kind signal exists.
        runtimeContainer: "unknown",
      }));
    }

    let verification: VerifyResult;
    if (skipVerify) {
      verification = skippedVerification("verification explicitly skipped by caller");
    } else {
      verification = await verify(
        workPath,
        baseline,
        withRequiredVerificationFiles(opts.verify, [...providerSourceFiles, ...sourceChanges])
      );
      if (baseline == null && baselineReason) {
        verification.skipReason = `baseline unavailable: ${baselineReason}`;
        verification.ok = false;
        verification.skipped = true;
      }
    }
    if (manifest.runtime) {
      verification.checks.runtime = verifyNodeRuntime(workPath, manifest.runtime.node);
      if (verification.checks.runtime.status !== "passed") verification.ok = false;
    }

    const postInstallLocks = findLockfiles(workPath);
    const candidateChanges = new Set([
      ...sourceChanges,
      ...dependencyResult.packageFiles,
      ...runtimeResult.runtimeFiles,
      ...dependencyResult.lockfiles,
      ...postInstallLocks,
    ]);
    const changedFiles = [...candidateChanges]
      .filter((file) => filesDiffer(expectedPath, workPath, file))
      .sort();

    if (dependencyResult.lockfiles.length > 0
      && dependencyResult.packageFiles.length > 0
      && !opts.verify?.install) {
      entries.push({
        file: dependencyResult.lockfiles[0]!,
        kind: "review",
        code: "PKG3",
        message: "Dependency versions changed but lockfile installation/update was not requested; this result is not publishable.",
        line: null,
      });
      verification.ok = false;
    }

    const report = buildReport(
      { name: manifest.name, provider: manifest.provider, notes: manifest.notes },
      scanned.map((file) => file.relative),
      changedFiles,
      entries,
      verification
    );
    if (writeChanges) applyCandidateFiles(repoPath, expectedPath, workPath, changedFiles);
    return {
      report,
      requiredVerificationFiles: [...new Set([...providerSourceFiles, ...sourceChanges])].sort(),
    };
  } finally {
    for (const root of temporaryRoots.reverse()) rmSync(root, { recursive: true, force: true });
  }
}

function applyTransformSet(
  manifest: Manifest,
  source: string,
  filePath: string,
  sink: ReportSink,
  enabled: ReadonlySet<string>,
  provenance?: InngestProvenanceContext
): string | null {
  switch (manifest.transformSet) {
    case "inngest-v3-to-v4": return applyInngestV3ToV4(source, filePath, sink, enabled, provenance);
    case "knock-v0-to-v1": return applyKnockV0ToV1(source, filePath, sink, enabled);
  }
}

function copyRepository(repoPath: string, roots: string[], label: string): string {
  const root = mkdtempSync(join(tmpdir(), `api-migrator-${label}-`));
  roots.push(root);
  const target = join(root, "repo");
  cpSync(repoPath, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (source) => {
      const rel = relative(repoPath, source);
      if (!rel) return true;
      const first = rel.split(/[\\/]/)[0];
      return first !== ".git" && first !== "node_modules";
    },
  });
  return target;
}

function filesDiffer(originalRoot: string, proposedRoot: string, file: string): boolean {
  const original = join(originalRoot, file);
  const proposed = join(proposedRoot, file);
  if (!existsSync(original) || !existsSync(proposed)) return existsSync(original) !== existsSync(proposed);
  if (isRootLockfileName(file)) {
    return !readRootLockfile(originalRoot, file).equals(readRootLockfile(proposedRoot, file));
  }
  if (file === "package.json" || file.endsWith("/package.json")) {
    const policy = { label: "package manifest", maxBytes: MAX_PACKAGE_MANIFEST_BYTES } as const;
    return !readRepositoryFile(originalRoot, file, policy).equals(readRepositoryFile(proposedRoot, file, policy));
  }
  return !readFileSync(original).equals(readFileSync(proposed));
}

interface PreparedCandidateFile {
  relative: string;
  destination: string;
  expected: string;
  staged: string | null;
  stagedCreated: boolean;
  candidate: RepositoryTreeEntry | null;
  expectedExists: boolean;
  candidateInstalled: boolean;
}

interface RepositoryTreeEntry {
  type: "directory" | "file" | "symlink";
  mode: number;
  digest: string;
}

interface CandidateApplyHooks {
  beforeCommit?: (file: string, index: number) => void;
}

/**
 * Apply a verified candidate tree as a rollback-capable transaction.
 *
 * Every candidate is copied to the destination filesystem and every original
 * byte sequence is rechecked before the first rename. Each replacement then
 * uses same-directory renames. If a later rename fails, prior replacements are
 * restored from the immutable expected-tree snapshot in reverse order.
 */
function applyCandidateFiles(
  repositoryRoot: string,
  expectedRoot: string,
  proposedRoot: string,
  changedFiles: readonly string[],
  hooks: CandidateApplyHooks = {}
): void {
  const prepared: PreparedCandidateFile[] = [];
  try {
    if (repositoryTreeDigest(repositoryRoot) !== repositoryTreeDigest(expectedRoot)) {
      throw new Error("Repository tree changed after migration planning");
    }
    for (const file of [...new Set(changedFiles)].sort()) {
      const destination = safeRepositoryPath(repositoryRoot, file);
      const expected = safeRepositoryPath(expectedRoot, file);
      const proposed = safeRepositoryPath(proposedRoot, file);
      assertExpectedFileState(destination, expected, file);

      const suffix = randomUUID();
      const parent = dirname(destination);
      const staged = pathEntryExists(proposed)
        ? join(parent, `.${basename(destination)}.api-migrator-${suffix}.stage`)
        : null;
      const item: PreparedCandidateFile = {
        relative: file,
        destination,
        expected,
        staged,
        stagedCreated: false,
        candidate: null,
        expectedExists: pathEntryExists(expected),
        candidateInstalled: false,
      };
      // Track the path before creating it so a copy/chmod failure cannot leave
      // an unreported staging artifact in the repository.
      prepared.push(item);
      if (staged) {
        const proposedStat = lstatSync(proposed);
        if (!proposedStat.isFile()) {
          throw new Error(`Proposed migration output is not a regular file: ${file}`);
        }
        copyFileSync(proposed, staged, constants.COPYFILE_EXCL);
        item.stagedCreated = true;
        chmodSync(staged, proposedStat.mode);
        item.candidate = repositoryTreeEntry(staged, file);
      }
    }

    const intendedTreeDigest = repositoryTreeDigest(expectedRoot, new Map(
      prepared.map((item) => [item.relative, item.candidate] as const)
    ));

    // Close the validation-to-commit window as much as possible by rechecking
    // the complete original set only after all candidate files are staged.
    for (const item of prepared) {
      assertExpectedFileState(
        safeRepositoryPath(repositoryRoot, item.relative),
        safeRepositoryPath(expectedRoot, item.relative),
        item.relative
      );
    }

    for (const [index, item] of prepared.entries()) {
      hooks.beforeCommit?.(item.relative, index);
      // Recheck each destination immediately before its rename as well. If a
      // concurrent editor touches a later file during commit, prior files are
      // rolled back instead of overwriting that edit.
      assertExpectedFileState(
        safeRepositoryPath(repositoryRoot, item.relative),
        safeRepositoryPath(expectedRoot, item.relative),
        item.relative
      );
      if (item.staged) {
        // On the supported POSIX pilot hosts, same-filesystem rename atomically
        // replaces the destination while the expected tree retains rollback
        // bytes outside the live repository.
        renameSync(item.staged, item.destination);
      } else {
        unlinkSync(item.destination);
      }
      item.candidateInstalled = true;
    }

    // A conflict can arrive after an earlier file's commit without touching a
    // later destination. Bind successful return to every staged candidate and
    // to the complete intended repository tree, not only the last rename.
    for (const item of prepared) {
      assertCandidateFileState(
        safeRepositoryPath(repositoryRoot, item.relative),
        item.candidate,
        item.relative
      );
    }
    if (repositoryTreeDigest(repositoryRoot) !== intendedTreeDigest) {
      throw new Error("Applied repository tree differs from the verified migration candidate");
    }

  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const item of [...prepared].reverse()) {
      try {
        if (item.candidateInstalled) {
          const destination = safeRepositoryPath(repositoryRoot, item.relative);
          assertCandidateFileState(destination, item.candidate, item.relative);
          restoreExpectedFile(destination, item.expected, item.expectedExists, item.relative);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${item.relative}: ${(rollbackError as Error).message}`);
      }
      try {
        if (item.stagedCreated && item.staged && pathEntryExists(item.staged)) unlinkSync(item.staged);
      } catch (cleanupError) {
        rollbackErrors.push(`${item.relative} staging cleanup: ${(cleanupError as Error).message}`);
      }
    }
    const suffix = rollbackErrors.length > 0
      ? ` Rollback also failed: ${rollbackErrors.join("; ")}`
      : "";
    throw new Error(`Could not apply the verified migration transaction: ${(error as Error).message}.${suffix}`);
  }
}

/** @internal Test seam for deterministic mid-commit fault injection. */
export function applyCandidateFilesForTest(
  repositoryRoot: string,
  expectedRoot: string,
  proposedRoot: string,
  changedFiles: readonly string[],
  beforeCommit: (file: string, index: number) => void
): void {
  applyCandidateFiles(repositoryRoot, expectedRoot, proposedRoot, changedFiles, { beforeCommit });
}

function assertCandidateFileState(
  destination: string,
  candidate: RepositoryTreeEntry | null,
  file: string
): void {
  const proposedExists = candidate !== null;
  const destinationExists = pathEntryExists(destination);
  if (proposedExists !== destinationExists) {
    throw new Error(`Repository file changed while rolling back: ${file}`);
  }
  if (!proposedExists) return;
  const destinationEntry = repositoryTreeEntry(destination, file);
  if (candidate.type !== "file"
    || destinationEntry.type !== candidate.type
    || destinationEntry.mode !== candidate.mode
    || destinationEntry.digest !== candidate.digest) {
    throw new Error(`Repository file changed while rolling back: ${file}`);
  }
}

function restoreExpectedFile(
  destination: string,
  expected: string,
  expectedExists: boolean,
  file: string
): void {
  if (!expectedExists) {
    if (pathEntryExists(destination)) unlinkSync(destination);
    return;
  }
  const expectedStat = lstatSync(expected);
  if (!expectedStat.isFile()) throw new Error(`Expected rollback source is not a regular file: ${file}`);
  const rollback = join(
    dirname(destination),
    `.${basename(destination)}.api-migrator-${randomUUID()}.rollback`
  );
  let rollbackCreated = false;
  try {
    copyFileSync(expected, rollback, constants.COPYFILE_EXCL);
    rollbackCreated = true;
    chmodSync(rollback, expectedStat.mode);
    renameSync(rollback, destination);
  } finally {
    if (rollbackCreated && pathEntryExists(rollback)) unlinkSync(rollback);
  }
}

function assertExpectedFileState(destination: string, expected: string, file: string): void {
  const expectedExists = pathEntryExists(expected);
  const destinationExists = pathEntryExists(destination);
  if (expectedExists !== destinationExists) {
    throw new Error(`Repository file changed after migration planning: ${file}`);
  }
  if (!expectedExists) return;
  const expectedStat = lstatSync(expected);
  const destinationStat = lstatSync(destination);
  if (!expectedStat.isFile() || !destinationStat.isFile()) {
    throw new Error(`Repository path is not a regular file: ${file}`);
  }
  if (expectedStat.mode !== destinationStat.mode
    || !readFileSync(expected).equals(readFileSync(destination))) {
    throw new Error(`Repository file changed after migration planning: ${file}`);
  }
}

function safeRepositoryPath(root: string, file: string): string {
  if (!file || file.includes("\0") || file.includes("\\") || isAbsolute(file)) {
    throw new Error("Migration output path is empty or invalid");
  }
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Migration output path is not normalized: ${file}`);
  }
  const absoluteRoot = resolve(root);
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Migration repository root must be a real directory: ${absoluteRoot}`);
  }
  let parent = absoluteRoot;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Migration output parent must be a real directory: ${file}`);
    }
  }
  const absolute = join(absoluteRoot, ...parts);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Migration output escapes the repository: ${file}`);
  }
  if (absolute === absoluteRoot) throw new Error("Migration output cannot replace the repository root");
  const realRoot = realpathSync(absoluteRoot);
  const realParent = realpathSync(parent);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`Migration output parent resolves outside the repository: ${file}`);
  }
  return absolute;
}

function repositoryTreeDigest(
  root: string,
  overlays: ReadonlyMap<string, RepositoryTreeEntry | null> = new Map()
): string {
  const absoluteRoot = resolve(root);
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Migration repository root must be a real directory: ${absoluteRoot}`);
  }
  const tree = new Map<string, RepositoryTreeEntry>();
  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      const path = relative(absoluteRoot, absolute).replace(/\\/g, "/");
      const stat = lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        tree.set(path, repositoryTreeEntry(absolute, path, stat));
        stack.push(absolute);
      } else if (stat.isSymbolicLink()) {
        tree.set(path, repositoryTreeEntry(absolute, path, stat));
      } else if (stat.isFile()) {
        tree.set(path, repositoryTreeEntry(absolute, path, stat));
      } else {
        throw new Error(`Repository contains an unsupported filesystem entry: ${path}`);
      }
    }
  }
  for (const [path, entry] of overlays) {
    if (entry) tree.set(path, entry);
    else tree.delete(path);
  }

  // Each record is independently content-hashed and explicitly length-framed;
  // repository-controlled file bytes cannot impersonate a following entry.
  const hash = createHash("sha256");
  for (const [path, entry] of [...tree.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const record = JSON.stringify([entry.type, path, entry.mode, entry.digest]);
    hash.update(String(Buffer.byteLength(record)));
    hash.update(":");
    hash.update(record);
  }
  return hash.digest("hex");
}

function repositoryTreeEntry(
  absolute: string,
  path: string,
  providedStat = lstatSync(absolute)
): RepositoryTreeEntry {
  const mode = providedStat.mode & 0o7777;
  if (providedStat.isDirectory() && !providedStat.isSymbolicLink()) {
    return { type: "directory", mode, digest: "" };
  }
  if (providedStat.isSymbolicLink()) {
    return {
      type: "symlink",
      mode,
      digest: createHash("sha256").update(readlinkSync(absolute)).digest("hex"),
    };
  }
  if (providedStat.isFile()) {
    return {
      type: "file",
      mode,
      digest: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    };
  }
  throw new Error(`Repository contains an unsupported filesystem entry: ${path}`);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function withRequiredVerificationFiles(
  opts: VerifyOptions | undefined,
  requiredFiles: readonly string[]
): VerifyOptions {
  return {
    ...opts,
    requiredFiles: [...new Set([...(opts?.requiredFiles ?? []), ...requiredFiles])].sort(),
  };
}

function assertRepository(repoPath: string): void {
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`Migration target is not a directory: ${repoPath}`);
  }
}

function skippedVerification(reason: string): VerifyResult {
  const skipped = (detail: string) => ({
    status: "skipped" as const,
    command: null,
    exitCode: null,
    output: "",
    reason: detail,
  });
  return {
    ok: false,
    baseline: [],
    after: [],
    introduced: [],
    skipped: true,
    skipReason: reason,
    runner: "none",
    checks: {
      install: skipped(reason),
      typecheck: skipped(reason),
      test: skipped(reason),
      lint: skipped(reason),
    },
  };
}

export { reportToMarkdown } from "./reporter.js";
export type { MigrationReport } from "./reporter.js";
export { Manifest } from "./manifest.js";
