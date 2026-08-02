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
    throw new Error(`ASSERT FAILED: ${msg}`);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "api-migrator-knock-"));
  try {
    mkdirSync(join(tmp, "src"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@knocklabs/node": "^0.6.0" } }, null, 2) + "\n"
    );
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
    const { report } = await runMigration(manifest, tmp, { writeChanges: false, skipVerify: true });

    console.log("=== Assertions ===");
    assert(report.scannedFiles.length >= 1, "Knock scanner finds the file");
    assert(report.changedFiles.includes("src/notify.ts"), "the source file would change");
    assert(report.changedFiles.includes("package.json"), "the SDK dependency would change");
    assert(report.summary.applied >= 7, "dependency/import/client/method/parameter transforms applied");
    assert(report.entries.some((e) => e.code === "K1" && e.kind === "applied"), "K1 (notify -> workflows.trigger) applied");
    assert(report.entries.some((e) => e.code === "K2" && e.kind === "applied"), "K2 (users.identify -> users.update) applied");
    assert(report.entries.some((e) => e.code === "K3" && e.kind === "applied"), "K3 (param rename) applied");
    assert(report.entries.some((e) => e.code === "K4" && e.kind === "applied"), "K4 (default import) applied");
    assert(report.entries.some((e) => e.code === "K5" && e.kind === "applied"), "K5 (options-object client init) applied");
    assert(report.summary.review === 0, "the audited Knock fixture has no unresolved review items");
    // Crucially: NO Inngest transforms leaked into a Knock migration.
    assert(
      !report.entries.some((e) => e.code.startsWith("T") && e.code.length === 2),
      "no Inngest transforms ran against a Knock migration (dispatch isolation)"
    );
    assert(
      !report.entries.some((e) => /^F\d+$/.test(e.code)),
      "no Inngest findings ran against a Knock migration (dispatch isolation)"
    );
    assert(
      report.summary.verified === "skipped" && report.verification.skipped === true,
      "the dry-run gate reports verification as incomplete"
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
