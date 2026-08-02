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
import { Manifest, type MigrationReport } from "@api-migrator/engine";
import { safeErrorMessage } from "../security.js";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    throw new Error(`ASSERT FAILED: ${msg}`);
  }
  console.log(`  ✓ ${msg}`);
}

function assertVerifiedF12Only(report: MigrationReport, label: string): void {
  assert(report.verification.ok === true, `${label} verification is explicitly successful`);
  assert(report.summary.verified === true, `${label} summary records successful verification`);
  assert(report.verification.checks.runtime?.status === "passed", `${label} Node runtime attestation passed`);
  const reviews = report.entries.filter((entry) => entry.kind === "review");
  assert(
    report.summary.review === 1 && reviews.length === 1,
    `${label} has exactly one unresolved review`
  );
  assert(
    reviews[0]?.code === "F12" && /runtime container is unknown/i.test(reviews[0].message),
    `${label} sole review is F12 for an unknown deployment kind`
  );
}

function assertOnlyManualReviewBlocker(
  blockers: ReadonlyArray<{ code?: string; message?: string }>,
  label: string
): void {
  assert(
    blockers.length === 1
      && blockers[0]?.code === "manual_review_required"
      && /^1 unresolved item\(s\) require manual review$/.test(blockers[0].message ?? ""),
    `${label} contains only the F12-derived manual-review blocker`
  );
  assert(
    !blockers.some((blocker) => blocker.code === "verification_failed" || blocker.code === "verification_skipped"),
    `${label} contains no verification blocker`
  );
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
    runtime: { node: { minimumMajor: 20, profile: "node22-bookworm-slim-2026-07", packageJson: "package.json", dockerfile: "Dockerfile" } },
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
  const result = summary.results[0]!;
  assert(Boolean(result.report), "campaign returned the migration report");
  assertVerifiedF12Only(result.report!, "campaign result");
  assert(Boolean(result.publication), "campaign returned the publication decision");
  assertOnlyManualReviewBlocker(result.publication!.blockers, "campaign blocker set");

  const runs = listRunsForCampaign(campaign.id);
  assert(runs.length === 1, "1 migration_run row persisted in DB");
  const run = runs[0]!;
  console.log(`\n=== Run row ===`);
  console.log(`  status : ${run.status}`);
  console.log(`  pr_url : ${run.prUrl}`);
  console.log(`  summary: ${run.summary}`);
  assert(run.status === "blocked", "F12 blocks the preview until deployment kind is reviewed");
  assert(!run.prUrl, "preview did not open a PR");
  assert(Boolean(run.report), "run stored the full report JSON");
  const persistedReport = JSON.parse(run.report!) as MigrationReport;
  assertVerifiedF12Only(persistedReport, "durable report");
  const persistedBlockers = JSON.parse(run.publicationBlockers ?? "[]") as Array<{
    code?: string;
    message?: string;
  }>;
  assertOnlyManualReviewBlocker(persistedBlockers, "durable publication blocker set");
  assert(
    run.error === persistedBlockers[0]?.message,
    "the blocked run stores the exact publication blocker reason"
  );

  console.log(`\n=== Campaign rollup ===`);
  console.log(JSON.stringify(campaignRollup(campaign.id), null, 2));

  console.log("\n✅ Phase 3 preview gate passed.");
}

main().catch((error) => {
  console.error(safeErrorMessage(error));
  process.exit(1);
});
