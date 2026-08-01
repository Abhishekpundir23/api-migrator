/** Transactional migration pipeline. Dry-runs verify a disposable proposed tree. */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
import { runTsc, verify, type VerifyOptions, type VerifyResult } from "./verifier.js";
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
  const initialLocks = new Map(
    findLockfiles(repoPath).map((file) => [file, readRootLockfile(repoPath, file)] as const)
  );

  try {
    const workPath = writeChanges ? repoPath : copyRepository(repoPath, temporaryRoots, "proposed");
    const sourceFiles = findSourceFiles(workPath);
    const sdkMatchedFiles = selectSdkFiles(sourceFiles, manifest.transformSet);
    const providerSourceFiles = sdkMatchedFiles.map((file) => file.relative);
    let baseline: Awaited<ReturnType<typeof runTsc>>["after"] | null = null;
    let baselineReason: string | undefined;

    if (!skipVerify) {
      const baselinePath = copyRepository(repoPath, temporaryRoots, "baseline");
      const baselineResult = await runTsc(
        baselinePath,
        withRequiredVerificationFiles(opts.verify, providerSourceFiles)
      );
      baseline = baselineResult.skipped ? null : baselineResult.after;
      baselineReason = baselineResult.skipReason;
    }

    const entries: ReportEntry[] = [];
    const sink: ReportSink = { push: (entry) => entries.push(entry) };

    // Package and peer-floor updates are mandatory, not optional transforms.
    const dependencyResult = updateManifestDependencies(workPath, manifest, sink);

    // Configured clients can arrive through wrappers, aliases, or computed
    // calls whose syntax defeats regex discovery. Parse every supported source
    // file so unresolved provider usage becomes a review blocker.
    const scanned = sourceFiles;
    const scannedSources = new Map(sdkMatchedFiles.map((file) => [file.relative, readFileSync(file.absolute, "utf8")] as const));
    const provenance: InngestProvenanceContext | undefined = manifest.transformSet === "inngest-v3-to-v4"
      ? { scannedSources, sourcePaths: new Set(sourceFiles.map((file) => file.relative)) }
      : undefined;
    const sourceChanges: string[] = [];
    for (const file of scanned) {
      const original = readFileSync(file.absolute, "utf8");
      const next = applyTransformSet(manifest, original, file.relative, sink, enabled, provenance);
      if (next != null && next !== original) {
        writeFileSync(file.absolute, next);
        sourceChanges.push(file.relative);
      }
    }

    if (manifest.transformSet === "inngest-v3-to-v4") {
      entries.push(...inngestBehavioralReviewEntries(enabled));
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

    const postInstallLocks = findLockfiles(workPath);
    const candidateChanges = new Set([
      ...sourceChanges,
      ...dependencyResult.packageFiles,
      ...dependencyResult.lockfiles,
      ...postInstallLocks,
    ]);
    const definiteWrites = new Set([...sourceChanges, ...dependencyResult.packageFiles]);
    const changedFiles = [...candidateChanges]
      .filter((file) => writeChanges
        ? definiteWrites.has(file) || lockChanged(repoPath, file, initialLocks)
        : filesDiffer(repoPath, workPath, file))
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

    return {
      report: buildReport(
        { name: manifest.name, provider: manifest.provider, notes: manifest.notes },
        scanned.map((file) => file.relative),
        changedFiles,
        entries,
        verification
      ),
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

function lockChanged(repoPath: string, file: string, initial: Map<string, Buffer>): boolean {
  const before = initial.get(file);
  const absolute = join(repoPath, file);
  if (!before) return existsSync(absolute);
  return !existsSync(absolute) || !before.equals(readRootLockfile(repoPath, file));
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
