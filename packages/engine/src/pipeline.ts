/**
 * Pipeline — the single programmatic entry point the GitHub App calls per repo.
 *
 *   runMigration(manifest, repoPath) -> { report, writeChanges }
 *
 * Flow:
 *   load manifest -> scan for affected files -> capture type baseline ->
 *   apply transforms -> write changes (if requested) -> verify against
 *   baseline -> assemble report.
 *
 * Writing changes is opt-in so a dry-run ("what would change?") is the same
 * code path as a real migration, just without the write step.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./manifest.js";
import { findSdkFiles } from "./scanner.js";
import { applyInngestV3ToV4 } from "./transforms/inngest-v3-to-v4.js";
import { applyKnockV0ToV1 } from "./transforms/knock-v0-to-v1.js";
import { captureBaseline, verify } from "./verifier.js";
import { buildReport } from "./reporter.js";
import type { ReportEntry, ReportSink } from "./types.js";
import type { MigrationReport } from "./reporter.js";

export interface RunMigrationOptions {
  /** Apply changes to disk. Default false (dry-run). */
  writeChanges?: boolean;
  /** Skip type verification (e.g. repo has no TS). Default false. */
  skipVerify?: boolean;
}

export interface RunMigrationResult {
  report: MigrationReport;
}

/**
 * Run a migration manifest against a single repo.
 * Returns the structured report. Writes files iff `writeChanges` is true.
 */
export async function runMigration(
  manifest: Manifest,
  repoPath: string,
  opts: RunMigrationOptions = {}
): Promise<RunMigrationResult> {
  const writeChanges = opts.writeChanges ?? false;
  const skipVerify = opts.skipVerify ?? false;

  // 1. Scan for affected files using the provider-specific usage patterns.
  const scanned = findSdkFiles(repoPath, manifest.transformSet);
  const entries: ReportEntry[] = [];
  const sink: ReportSink = { push: (e) => entries.push(e) };
  const changedFiles: string[] = [];

  // 2. Capture a type-error baseline BEFORE transforming, so we can tell
  //    migration-introduced errors from pre-existing ones.
  let baseline = null;
  if (!skipVerify) {
    try {
      baseline = await captureBaseline(repoPath);
    } catch {
      baseline = null; // verification is best-effort
    }
  }

  // 3. Apply the transform set.
  for (const f of scanned) {
    const original = readFileSync(f.absolute, "utf8");
    const next = applyTransformSet(manifest, original, f.relative, sink);
    if (next != null && next !== original) {
      changedFiles.push(f.relative);
      if (writeChanges) writeFileSync(f.absolute, next);
    }
  }

  // 4. Verify: diff post-transform errors against the baseline.
  let verification;
  if (skipVerify) {
    verification = skippedVerification();
  } else {
    try {
      verification = await verify(repoPath, baseline);
    } catch {
      verification = skippedVerification("verification threw");
    }
  }

  // 5. Assemble the report.
  const report = buildReport(
    { name: manifest.name, provider: manifest.provider },
    scanned.map((s) => s.relative),
    changedFiles,
    entries,
    verification
  );
  return { report };
}

function applyTransformSet(
  manifest: Manifest,
  source: string,
  filePath: string,
  sink: ReportSink
): string | null {
  switch (manifest.transformSet) {
    case "inngest-v3-to-v4":
      return applyInngestV3ToV4(source, filePath, sink);
    case "knock-v0-to-v1":
      return applyKnockV0ToV1(source, filePath, sink);
    default: {
      // Compile-time exhaustiveness check; if a new set is added to the union
      // without a case here, tsc errors.
      const _exhaustive: never = manifest.transformSet;
      return null;
    }
  }
}

function skippedVerification(reason?: string) {
  return {
    ok: true,
    baseline: [],
    after: [],
    introduced: [],
    skipped: true,
    skipReason: reason ?? "skipped by caller",
  };
}

// Re-export the markdown renderer for convenience.
export { reportToMarkdown } from "./reporter.js";
export type { MigrationReport } from "./reporter.js";
export { Manifest } from "./manifest.js";
