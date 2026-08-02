/**
 * #2 gate: verification works on a FRESH clone (no node_modules) when
 * `install: true` is passed. This closes the "skipped" gap from Phase 1.
 *
 *   tsx packages/engine/src/gate-verify.ts
 *
 * Clones the v3 fixture, lets the migration update dependencies and source,
 * runs an isolated install plus type-check, and asserts verification actually
 * ran (verified !== "skipped") with zero newly introduced type errors.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runMigration } from "./index.js";
import type { Manifest } from "./index.js";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    throw new Error(`ASSERT FAILED: ${msg}`);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "api-migrator-verify-"));
  try {
    console.log("Cloning v3 fixture (bare, no node_modules)...");
    execSync(`git clone --depth 1 https://github.com/ykhli/AI-tamago.git ${tmp}`, { stdio: "pipe" });

    const manifest: Manifest = {
      name: "Inngest TS SDK v3 -> v4",
      provider: "inngest",
      transformSet: "inngest-v3-to-v4",
      runtime: { node: { minimumMajor: 20, profile: "node22-bookworm-slim-2026-07", packageJson: "package.json", dockerfile: "Dockerfile" } },
      package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
      peerFloors: [{ name: "typescript", range: "^5.8.0" }],
    };

    console.log("Running migration WITH install + verification...\n");
    const { report } = await runMigration(manifest, tmp, {
      writeChanges: true,
      verify: { runner: "docker", install: true },
    });

    const v = report.summary.verified;
    console.log("=== Verification result ===");
    console.log("  verified  :", v);
    console.log("  baseline  :", report.verification.baseline.length, "pre-existing errors");
    console.log("  introduced:", report.verification.introduced.length, "new errors");
    if (report.verification.skipReason) console.log("  skipReason:", report.verification.skipReason);
    for (const error of report.verification.introduced) {
      console.log(`  - ${error.file}:${error.line ?? "?"}:${error.col ?? "?"} ${error.code} ${error.message}`);
    }

    console.log("\n=== Assertions ===");
    assert(v === true, "verification completed successfully");
    assert(report.verification.ok === true, "verification result is explicitly successful");
    assert(report.summary.introducedErrors === 0, "transform introduced 0 new type errors");
    assert(report.verification.checks.runtime?.status === "passed", "Node runtime attestation passed");
    assert(
      report.entries.some((entry) => entry.code === "T5" && entry.kind === "applied"),
      "T5 explicit client mode applied"
    );
    assert(
      report.entries.some((entry) => entry.code === "F12" && /runtime container is unknown/i.test(entry.message)),
      "F12 remains review-required without a validated deployment kind"
    );
    // The migrated file must not appear among introduced errors.
    assert(
      !report.verification.introduced.some((e) => e.file.includes("inngest/functions")),
      "no new errors in the migrated functions.ts"
    );

    console.log("\n✅ #2 gate passed — bare-clone verification works.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
