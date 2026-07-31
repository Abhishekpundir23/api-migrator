/**
 * Phase 1 gate test: run the full migration pipeline against a fresh clone of
 * the v3 fixture and assert the report matches the proven prototype result.
 *
 *   tsx packages/engine/src/gate.ts
 *
 * This is the integration test for the engine. It:
 *   1. Clones AI-tamago to a temp dir (clean v3 state).
 *   2. Runs runMigration with the Inngest v3->v4 manifest.
 *   3. Asserts: 1 file changed, T1 applied, F1 flagged, no new type errors.
 *   4. Prints the rendered markdown PR body.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runMigration, reportToMarkdown, type MigrationReport, type Manifest } from "./index.js";

const FIXTURE_REPO = "https://github.com/ykhli/AI-tamago.git";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`❌ ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "api-migrator-gate-"));
  try {
    console.log(`Cloning fixture into ${tmp} ...`);
    execSync(`git clone --depth 1 ${FIXTURE_REPO} ${tmp}`, { stdio: "pipe" });

    const manifest: Manifest = {
      name: "Inngest TypeScript SDK v3 -> v4",
      provider: "inngest",
      transformSet: "inngest-v3-to-v4",
      package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
      peerFloors: [{ name: "typescript", range: ">=5.8.0" }],
    };

    console.log("Running pipeline (dry-run)...\n");
    const { report } = await runMigration(manifest, tmp, { writeChanges: false });

    console.log("=== Assertions ===");
    assert(report.scannedFiles.length >= 2, "scanner finds Inngest files");
    assert(report.changedFiles.length === 1, "exactly 1 file would change");
    assert(report.summary.applied === 1, "1 transform applied (T1)");
    assert(report.summary.review === 1, "1 item flagged for review (F1)");
    assert(report.entries.some((e) => e.code === "T1"), "T1 present in report");
    assert(report.entries.some((e) => e.code === "F1"), "F1 present in report");

    console.log("\n=== Report summary ===");
    console.log(JSON.stringify(report.summary, null, 2));

    console.log("\n=== Markdown PR body ===");
    console.log(reportToMarkdown(report satisfies MigrationReport));

    console.log("\n✅ Phase 1 gate passed.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
