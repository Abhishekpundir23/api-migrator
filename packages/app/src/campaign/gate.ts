/**
 * Phase 3 gate: create a campaign + run it against the sandbox repo via the
 * DB-backed campaign runner, then assert a non-publishing preview persisted.
 *
 *   SANDBOX_SLUG="owner/repo" tsx packages/app/src/campaign/gate.ts
 */

import {
  init,
  resetDb,
  createProvider,
  createCampaign,
  listRunsForCampaign,
  campaignRollup,
} from "@api-migrator/db";
import { runCampaign } from "./runner.js";
import { Manifest } from "@api-migrator/engine";
import { safeErrorMessage } from "../security.js";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`❌ ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const slug = process.env.SANDBOX_SLUG;
  if (!slug) {
    console.error("Set SANDBOX_SLUG=owner/repo to run the Phase 3 gate.");
    process.exit(1);
  }

  console.log("Resetting dev DB...");
  init();
  resetDb();

  // 1. Provider + campaign.
  const provider = createProvider({ name: "Inngest", slug: "inngest" });
  const manifest: Manifest = {
    name: "Inngest TS SDK v3 -> v4",
    provider: "inngest",
    transformSet: "inngest-v3-to-v4",
    package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
    peerFloors: [{ name: "typescript", range: "^5.8.0" }],
  };
  const campaign = createCampaign({
    providerId: provider.id,
    name: "Inngest TS SDK v3 -> v4",
    manifest,
    status: "active",
  });
  console.log(`Created campaign ${campaign.id}`);

  // 2. Run against the sandbox repo.
  console.log(`\nRunning campaign against ${slug}...\n`);
  const summary = await runCampaign({
    campaignId: campaign.id,
    repoSlugs: [slug],
    concurrency: 1,
    publication: { mode: "preview" },
  });

  console.log("=== Assertions ===");
  assert(summary.total === 1, "campaign processed 1 repo");
  assert(summary.results.length === 1, "1 result recorded");

  const runs = listRunsForCampaign(campaign.id);
  assert(runs.length === 1, "1 migration_run row persisted in DB");
  const run = runs[0]!;
  console.log(`\n=== Run row ===`);
  console.log(`  status : ${run.status}`);
  console.log(`  pr_url : ${run.prUrl}`);
  console.log(`  summary: ${run.summary}`);
  assert(
    ["preview_ready", "blocked", "no_changes"].includes(run.status),
    "run finished as a non-publishing preview"
  );
  assert(!run.prUrl, "preview did not open a PR");
  assert(Boolean(run.report), "run stored the full report JSON");

  console.log(`\n=== Campaign rollup ===`);
  console.log(JSON.stringify(campaignRollup(campaign.id), null, 2));

  console.log("\n✅ Phase 3 preview gate passed.");
}

main().catch((error) => {
  console.error(safeErrorMessage(error));
  process.exit(1);
});
