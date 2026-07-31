/**
 * Campaign runner — orchestrates a migration campaign across many repos.
 *
 * Given a campaign (manifest + list of repo slugs), it:
 *   1. Records a migration_run row per repo (status = queued).
 *   2. Dispatches each repo through the queue (Phase 2's migrateRepo).
 *   3. Writes the resulting status + PR url + report back to the run row.
 *
 * This is the glue between the DB (Phase 3) and the GitHub workflow (Phase 2).
 */

import {
  createRun,
  updateRun,
  upsertRepo,
  getCampaign,
  getRepoBySlug,
  type MigrationRunStatus,
} from "@api-migrator/db";
import { migrateRepo, type MigrateRepoResult } from "../github.js";
import { Manifest } from "@api-migrator/engine";

export interface RunCampaignInput {
  campaignId: string;
  /** "owner/repo" slugs to migrate. */
  repoSlugs: string[];
  /** Branch suffix; final branch is `${suffix}`. */
  branchSuffix?: string;
  concurrency?: number;
}

export interface CampaignRunSummary {
  campaignId: string;
  total: number;
  results: Array<{ slug: string; status: MigrationRunStatus; prUrl: string | null; error?: string }>;
}

/**
 * Run a campaign. Processes repos with bounded concurrency, persisting run
 * status as each completes.
 */
export async function runCampaign(input: RunCampaignInput): Promise<CampaignRunSummary> {
  const campaign = getCampaign(input.campaignId);
  if (!campaign) throw new Error(`campaign ${input.campaignId} not found`);
  const manifest = JSON.parse(campaign.manifest) as Manifest;
  const suffix = input.branchSuffix ?? "api-migrator/migration";

  const results: CampaignRunSummary["results"] = [];
  const concurrency = Math.max(1, input.concurrency ?? 2);
  const queue = [...input.repoSlugs];

  async function worker() {
    while (queue.length) {
      const slug = queue.shift()!;
      const repo = upsertRepo({ slug });
      const run = createRun({ campaignId: input.campaignId, repoId: repo.id, branch: suffix });
      try {
        const r: MigrateRepoResult = await migrateRepo({
          cloneUrl: `https://github.com/${slug}.git`,
          slug,
          baseBranch: repo.defaultBranch ?? "main",
          manifest,
          branch: suffix,
        });
        const status: MigrationRunStatus = r.changed ? "pr_opened" : "no_changes";
        updateRun(run.id, {
          status,
          prUrl: r.prUrl ?? null,
          summary: r.report.summary,
          report: r.report,
        });
        results.push({ slug, status, prUrl: r.prUrl });
      } catch (e: any) {
        updateRun(run.id, { status: "failed", error: e?.message ?? String(e) });
        results.push({ slug, status: "failed", prUrl: null, error: e?.message ?? String(e) });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, input.repoSlugs.length) }, worker)
  );

  return {
    campaignId: input.campaignId,
    total: input.repoSlugs.length,
    results,
  };
}
