/**
 * Job queue — processes per-repo migration jobs with bounded concurrency.
 *
 * Pilot: a simple in-process queue (p-queue-style). The interface is shaped so
 * we can swap in BullMQ/Redis later for durability at scale without changing
 * callers.
 */

import { migrateRepo, type MigrateRepoInput, type MigrateRepoResult } from "./github.js";

export interface MigrationJob extends MigrateRepoInput {
  id: string;
}

export interface MigrationJobResult extends MigrateRepoResult {
  id: string;
  error?: string;
}

export interface QueueOptions {
  concurrency?: number;
}

/**
 * Run a batch of migration jobs with bounded concurrency.
 * Returns one result per job (failures captured, not thrown).
 *
 * Lower-level than campaign/runner.runCampaign (which wires DB persistence);
 * exported as runCampaignJobs to avoid a name clash.
 */
export async function runCampaignJobs(
  jobs: MigrationJob[],
  opts: QueueOptions = {}
): Promise<MigrationJobResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const results: MigrationJobResult[] = new Array(jobs.length);

  // Simple bounded-concurrency runner (avoids a p-queue dependency for now).
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const job = jobs[i]!;
      try {
        const r = await migrateRepo(job);
        results[i] = { ...r, id: job.id };
      } catch (e: any) {
        results[i] = {
          id: job.id,
          report: emptyReport(job.manifest),
          prUrl: null,
          changed: false,
          error: e?.message ?? String(e),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

function emptyReport(manifest: MigrationJob["manifest"]): import("@api-migrator/engine").MigrationReport {
  return {
    manifest: { name: manifest.name, provider: manifest.provider },
    scannedFiles: [],
    changedFiles: [],
    entries: [],
    verification: { ok: true, baseline: [], after: [], introduced: [], skipped: true, skipReason: "job failed" },
    summary: { applied: 0, review: 0, changedFiles: 0, introducedErrors: 0, verified: "skipped" },
  };
}
