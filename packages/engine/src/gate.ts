/**
 * Phase 1 gate test: run the full migration pipeline against a fresh clone of
 * the v3 fixture and assert the report matches the proven prototype result.
 *
 *   tsx packages/engine/src/gate.ts
 *
 * This is the integration test for the engine. It:
 *   1. Clones AI-tamago to a temp dir (clean v3 state).
 *   2. Runs runMigration with the Inngest v3->v4 manifest.
 *   3. Asserts source, client-mode, runtime, and behavioral review evidence.
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
    throw new Error(`ASSERT FAILED: ${msg}`);
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
      runtime: { node: { minimumMajor: 20, profile: "node22-bookworm-slim-2026-07", packageJson: "package.json", dockerfile: "Dockerfile" } },
      package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
      peerFloors: [{ name: "typescript", range: "^5.8.0" }],
    };

    console.log("Running pipeline (dry-run)...\n");
    const { report } = await runMigration(manifest, tmp, { writeChanges: false, skipVerify: true });

    console.log("=== Assertions ===");
    assert(report.scannedFiles.length >= 2, "scanner finds Inngest files");
    assert(report.changedFiles.includes("package.json"), "target dependency would change");
    assert(report.summary.applied >= 2, "dependency and source transforms applied");
    assert(report.summary.review >= 1, "manual review inventory is present");
    assert(report.entries.some((e) => e.code === "T1"), "T1 present in report");
    assert(report.entries.some((e) => e.code === "T5" && e.kind === "applied"), "T5 explicit client mode applied");
    assert(!report.entries.some((e) => e.code === "F1"), "resolved client mode does not leave F1 behind");
    assert(
      report.entries.some((e) => e.code === "F12" && /runtime container is unknown/i.test(e.message)),
      "F12 remains review-required without a validated deployment kind"
    );
    assert(report.verification.checks.runtime?.status === "passed", "Node runtime attestation passed");

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
