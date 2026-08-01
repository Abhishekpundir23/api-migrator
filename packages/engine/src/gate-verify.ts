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
    console.error(`❌ ASSERT FAILED: ${msg}`);
    process.exit(1);
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
    assert(v !== "skipped", "verification actually RAN (not skipped)");
    assert(report.summary.introducedErrors === 0, "transform introduced 0 new type errors");
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
