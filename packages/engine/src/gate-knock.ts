/**
 * Phase 5 gate: prove the engine is provider-agnostic by running the Knock
 * v0->v1 transform set through the SAME pipeline used for Inngest.
 *
 *   tsx packages/engine/src/gate-knock.ts
 *
 * Builds a tiny synthetic Knock v0 codebase in a temp dir, runs runMigration
 * with a Knock manifest, and asserts the provider-specific dispatch worked.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigration, reportToMarkdown } from "./index.js";
import type { Manifest } from "./index.js";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`❌ ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "api-migrator-knock-"));
  try {
    mkdirSync(join(tmp, "src"));
    // A realistic Knock v0 codebase exercising every transform:
    writeFileSync(
      join(tmp, "src", "notify.ts"),
      `import { Knock } from "@knocklabs/node";
const knockClient = new Knock("sk_test_123");
export async function alertUser(userId: string) {
  await knockClient.notify("alert-workflow", { recipients: [userId], cancellationKey: "abc" });
  const users = await knockClient.users.list({ page: 1, pageSize: 20 });
  await knockClient.users.identify(userId, { name: "Sam" });
  return users;
}
`
    );

    const manifest: Manifest = {
      name: "Knock Node.js SDK v0.x -> v1.0",
      provider: "knock",
      transformSet: "knock-v0-to-v1",
      package: { name: "@knocklabs/node", from: "^0.6.0", to: "^1.0.0" },
      peerFloors: [],
    };

    console.log("Running Knock pipeline (dry-run)...\n");
    const { report } = await runMigration(manifest, tmp, { writeChanges: false });

    console.log("=== Assertions ===");
    assert(report.scannedFiles.length >= 1, "Knock scanner finds the file");
    assert(report.changedFiles.length === 1, "the file would change");
    assert(report.summary.applied >= 4, "multiple transforms applied (K1/K2/K3 x2)");
    assert(report.entries.some((e) => e.code === "K1"), "K1 (notify -> workflows.trigger) applied");
    assert(report.entries.some((e) => e.code === "K2"), "K2 (users.identify -> users.update) applied");
    assert(report.entries.some((e) => e.code === "K3"), "K3 (param rename) applied");
    assert(report.entries.some((e) => e.code === "KF1"), "KF1 (client init) flagged for review");
    // Crucially: NO Inngest transforms leaked into a Knock migration.
    assert(
      !report.entries.some((e) => e.code.startsWith("T") && e.code.length === 2),
      "no Inngest transforms ran against a Knock migration (dispatch isolation)"
    );

    console.log("\n=== Report summary ===");
    console.log(JSON.stringify(report.summary, null, 2));
    console.log("\n=== Markdown PR body ===");
    console.log(reportToMarkdown(report));

    console.log("\n✅ Phase 5 gate passed — engine is provider-agnostic.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
