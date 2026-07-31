/**
 * Repository functions — typed CRUD over the schema. Used by the campaign
 * runner (writes run status) and the console (reads campaign/repo/run state).
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, migrate } from "./client.js";
import { providers, campaigns, repos, migrationRuns } from "./schema.js";
import type { MigrationRunStatus } from "./schema.js";

/** Ensure tables exist. Call at app boot. */
export function init() {
  migrate(getDb());
}

// --- providers ----------------------------------------------------------------

export function createProvider(input: { name: string; slug: string }) {
  const db = getDb();
  const id = randomUUID();
  db.insert(providers).values({ id, name: input.name, slug: input.slug }).run();
  return db.select().from(providers).where(eq(providers.id, id)).get()!;
}

export function getProviderBySlug(slug: string) {
  return getDb().select().from(providers).where(eq(providers.slug, slug)).get();
}

// --- campaigns ----------------------------------------------------------------

export function createCampaign(input: {
  providerId: string;
  name: string;
  manifest: unknown;
  status?: "draft" | "active";
}) {
  const db = getDb();
  const id = randomUUID();
  db.insert(campaigns)
    .values({
      id,
      providerId: input.providerId,
      name: input.name,
      manifest: JSON.stringify(input.manifest),
      status: input.status ?? "draft",
    })
    .run();
  return db.select().from(campaigns).where(eq(campaigns.id, id)).get()!;
}

export function getCampaign(id: string) {
  return getDb().select().from(campaigns).where(eq(campaigns.id, id)).get();
}

export function listCampaigns() {
  return getDb().select().from(campaigns).all();
}

// --- repos --------------------------------------------------------------------

export function upsertRepo(input: { slug: string; defaultBranch?: string; installationId?: number }) {
  const db = getDb();
  const existing = db.select().from(repos).where(eq(repos.slug, input.slug)).get();
  if (existing) return existing;
  const id = randomUUID();
  db.insert(repos)
    .values({
      id,
      slug: input.slug,
      defaultBranch: input.defaultBranch,
      installationId: input.installationId,
    })
    .run();
  return db.select().from(repos).where(eq(repos.id, id)).get()!;
}

export function getRepoBySlug(slug: string) {
  return getDb().select().from(repos).where(eq(repos.slug, slug)).get();
}

// --- migration runs -----------------------------------------------------------

export function createRun(input: { campaignId: string; repoId: string; branch: string }) {
  const db = getDb();
  const id = randomUUID();
  db.insert(migrationRuns)
    .values({
      id,
      campaignId: input.campaignId,
      repoId: input.repoId,
      branch: input.branch,
      status: "queued",
      startedAt: Date.now(),
    })
    .run();
  return db.select().from(migrationRuns).where(eq(migrationRuns.id, id)).get()!;
}

export function updateRun(
  id: string,
  patch: {
    status: MigrationRunStatus;
    prUrl?: string | null;
    summary?: unknown;
    report?: unknown;
    error?: string | null;
  }
) {
  const db = getDb();
  db.update(migrationRuns)
    .set({
      status: patch.status,
      prUrl: patch.prUrl,
      summary: patch.summary ? JSON.stringify(patch.summary) : undefined,
      report: patch.report ? JSON.stringify(patch.report) : undefined,
      error: patch.error,
      finishedAt: Date.now(),
    })
    .where(eq(migrationRuns.id, id))
    .run();
  return db.select().from(migrationRuns).where(eq(migrationRuns.id, id)).get()!;
}

export function getRun(id: string) {
  return getDb().select().from(migrationRuns).where(eq(migrationRuns.id, id)).get();
}

export function listRunsForCampaign(campaignId: string) {
  return getDb().select().from(migrationRuns).where(eq(migrationRuns.campaignId, campaignId)).all();
}

/** Dashboard rollup: count runs by status for a campaign. */
export function campaignRollup(campaignId: string): Record<string, number> {
  const runs = listRunsForCampaign(campaignId);
  const counts: Record<string, number> = {};
  for (const r of runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
  counts["_total"] = runs.length;
  return counts;
}
