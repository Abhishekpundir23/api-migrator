/**
 * Repository functions — typed CRUD over the schema. Used by the campaign
 * runner (writes run status) and the console (reads campaign/repo/run state).
 */

import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, migrate } from "./client.js";
import { providers, campaigns, repos, migrationRuns } from "./schema.js";
import type { MigrationRunStatus } from "./schema.js";

export interface PublicationBlockerAudit {
  code: string;
  message: string;
}

/** Ensure tables exist. Call at app boot. */
export function init() {
  migrate(getDb());
}

// --- providers ----------------------------------------------------------------

export function createProvider(input: { name: string; slug: string }) {
  const db = getDb();
  const id = randomUUID();
  db.insert(providers)
    .values({ id, name: input.name, slug: input.slug })
    .onConflictDoUpdate({ target: providers.slug, set: { name: input.name } })
    .run();
  return db.select().from(providers).where(eq(providers.slug, input.slug)).get()!;
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
  return getDb().select().from(campaigns).orderBy(desc(campaigns.createdAt)).all();
}

// --- repos --------------------------------------------------------------------

export function upsertRepo(input: { slug: string; defaultBranch?: string; installationId?: number }) {
  const db = getDb();
  const id = randomUUID();
  const refresh: Partial<typeof repos.$inferInsert> = {};
  if (input.defaultBranch !== undefined) refresh.defaultBranch = input.defaultBranch;
  if (input.installationId !== undefined) refresh.installationId = input.installationId;
  db.insert(repos)
    .values({
      id,
      slug: input.slug,
      defaultBranch: input.defaultBranch,
      installationId: input.installationId,
    })
    .onConflictDoUpdate({
      target: repos.slug,
      // Slug is always safe to write, and prevents an empty SET clause when
      // callers only need an atomic fetch-or-create.
      set: { slug: input.slug, ...refresh },
    })
    .run();
  return db.select().from(repos).where(eq(repos.slug, input.slug)).get()!;
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
    branch?: string | null;
    publicationMode?: "preview" | "publish" | null;
    preflightId?: string | null;
    artifactDigest?: string | null;
    baseSha?: string | null;
    baseBranch?: string | null;
    headSha?: string | null;
    publicationBlockers?: readonly PublicationBlockerAudit[] | null;
    approvedBy?: string | null;
    overrideUnsafe?: boolean;
    overrideReason?: string | null;
  }
) {
  const db = getDb();
  const terminal = ["preview_ready", "blocked", "pr_opened", "merged", "failed", "no_changes"].includes(
    patch.status
  );
  db.update(migrationRuns)
    .set({
      status: patch.status,
      prUrl: patch.prUrl,
      summary: patch.summary !== undefined ? JSON.stringify(patch.summary) : undefined,
      report: patch.report !== undefined ? JSON.stringify(patch.report) : undefined,
      error: patch.error,
      branch: patch.branch,
      publicationMode: patch.publicationMode,
      preflightId: patch.preflightId,
      artifactDigest: auditDigest(patch.artifactDigest),
      baseSha: auditCommit(patch.baseSha),
      baseBranch: auditBranch(patch.baseBranch),
      headSha: auditCommit(patch.headSha),
      publicationBlockers: serializePublicationBlockers(patch.publicationBlockers),
      approvedBy: patch.approvedBy,
      overrideUnsafe: patch.overrideUnsafe,
      overrideReason: sanitizeOverrideReason(patch.overrideReason),
      finishedAt: terminal ? Date.now() : null,
    })
    .where(eq(migrationRuns.id, id))
    .run();
  return db.select().from(migrationRuns).where(eq(migrationRuns.id, id)).get()!;
}

export function getRun(id: string) {
  return getDb().select().from(migrationRuns).where(eq(migrationRuns.id, id)).get();
}

export function listRunsForCampaign(campaignId: string) {
  return getDb()
    .select()
    .from(migrationRuns)
    .where(eq(migrationRuns.campaignId, campaignId))
    .orderBy(desc(migrationRuns.startedAt))
    .all();
}

/** Run rows plus the human-readable repo slug used by the operator console. */
export function listRunsWithReposForCampaign(campaignId: string) {
  return getDb()
    .select({ run: migrationRuns, repoSlug: repos.slug })
    .from(migrationRuns)
    .innerJoin(repos, eq(migrationRuns.repoId, repos.id))
    .where(eq(migrationRuns.campaignId, campaignId))
    .orderBy(desc(migrationRuns.startedAt))
    .all()
    .map(({ run, repoSlug }) => ({ ...run, repoSlug }));
}

/** Dashboard rollup: count runs by status for a campaign. */
export function campaignRollup(campaignId: string): Record<string, number> {
  const runs = listRunsForCampaign(campaignId);
  const counts: Record<string, number> = {};
  for (const r of runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
  counts["_total"] = runs.length;
  return counts;
}

function serializePublicationBlockers(
  blockers: readonly PublicationBlockerAudit[] | null | undefined
): string | null | undefined {
  if (blockers === undefined || blockers === null) return blockers;
  if (blockers.length > 100) throw new Error("publication blocker audit exceeds 100 entries");
  return JSON.stringify(
    blockers.map((blocker, index) => {
      if (!blocker || typeof blocker.code !== "string" || typeof blocker.message !== "string") {
        throw new Error(`publication blocker ${index + 1} is invalid`);
      }
      const code = safeAuditText(blocker.code, 100);
      const message = safeAuditText(blocker.message, 1_000);
      if (!code || !message) throw new Error(`publication blocker ${index + 1} is empty`);
      return { code, message };
    })
  );
}

function auditDigest(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(value)) throw new Error("invalid artifact digest audit value");
  return value;
}

function auditCommit(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error("invalid base commit audit value");
  return value;
}

function auditBranch(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!value || value.length > 240 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("invalid base branch audit value");
  }
  return value;
}

function sanitizeOverrideReason(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const safe = safeAuditText(value, 500);
  if (!safe) throw new Error("override reason audit value is empty");
  return safe;
}

function safeAuditText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /(\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]"
    )
    .replace(/([?&](?:token|password|secret|api[-_]?key|access[-_]?key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .trim()
    .slice(0, maxLength);
}
