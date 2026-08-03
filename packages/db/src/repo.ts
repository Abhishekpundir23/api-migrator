/**
 * Repository functions — typed CRUD over the schema. Used by the campaign
 * runner (writes run status) and the console (reads campaign/repo/run state).
 */

import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, migrate, persistOwnerAuthorizationConsumption } from "./client.js";
import {
  providers,
  campaigns,
  repos,
  migrationRuns,
  ownerAuthorizationConsumptions,
} from "./schema.js";
import type { MigrationRunStatus, OwnerAuthorizationConsumption } from "./schema.js";

export interface PublicationBlockerAudit {
  code: string;
  message: string;
}

export interface OwnerAuthorizationConsumptionInput {
  authorizationId: string;
  envelopeId: string;
  envelopeDigest: string;
  nonceDigest: string;
  signerId: string;
  keyId: string;
  repositorySlug: string;
  repositoryId: number;
  baseSha: string;
  preflightId: string;
  artifactDigest: string;
  manifestDigest: string;
  candidateBranch: string;
  candidateTreeSha: string;
  expiresAt: number;
}

/** Deliberately does not reveal which replay key or persistence check failed. */
export const OWNER_AUTHORIZATION_CONSUMPTION_REJECTED =
  "owner authorization already consumed or unavailable";

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

// --- owner authorization replay/audit ----------------------------------------

/**
 * Atomically reserve an owner authorization before any write token is minted.
 *
 * The row is intentionally immutable and this package exposes no release or
 * delete operation. A failed publication therefore cannot make the same
 * authorization, envelope, or nonce reusable.
 */
export function consumeOwnerAuthorization(
  input: OwnerAuthorizationConsumptionInput
): OwnerAuthorizationConsumption {
  const expiresAt = auditTimestamp(input.expiresAt, "expiresAt");

  const value: Omit<OwnerAuthorizationConsumption, "consumedAt"> = {
    authorizationId: auditIdentifier(input.authorizationId, "authorizationId"),
    envelopeId: auditIdentifier(input.envelopeId, "envelopeId"),
    envelopeDigest: auditSha256(input.envelopeDigest, "envelopeDigest"),
    nonceDigest: auditSha256(input.nonceDigest, "nonceDigest"),
    signerId: auditIdentifier(input.signerId, "signerId"),
    keyId: auditIdentifier(input.keyId, "keyId"),
    repositorySlug: auditRepositorySlug(input.repositorySlug),
    repositoryId: auditGitHubId(input.repositoryId),
    baseSha: auditGitSha(input.baseSha, "baseSha"),
    preflightId: auditPreflightId(input.preflightId),
    artifactDigest: auditSha256(input.artifactDigest, "artifactDigest"),
    manifestDigest: auditSha256(input.manifestDigest, "manifestDigest"),
    candidateBranch: auditGitBranch(input.candidateBranch),
    candidateTreeSha: auditGitSha(input.candidateTreeSha, "candidateTreeSha"),
    expiresAt,
  };

  try {
    const db = getDb();
    const result = persistOwnerAuthorizationConsumption(db, value);
    if (result.expiredAfterInsert) throw new Error(OWNER_AUTHORIZATION_CONSUMPTION_REJECTED);
    return result.stored;
  } catch {
    // Unique conflicts, database locks/corruption, and all other persistence
    // failures are intentionally indistinguishable to the caller.
    throw new Error(OWNER_AUTHORIZATION_CONSUMPTION_REJECTED);
  }
}

/** Read-only audit lookup. There is intentionally no mutation/removal helper. */
export function getOwnerAuthorizationConsumption(authorizationId: string) {
  return getDb()
    .select()
    .from(ownerAuthorizationConsumptions)
    .where(
      eq(
        ownerAuthorizationConsumptions.authorizationId,
        auditIdentifier(authorizationId, "authorizationId")
      )
    )
    .get();
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
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error("invalid base commit audit value");
  }
  return value;
}

function auditBranch(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!value || value.length > 240 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("invalid base branch audit value");
  }
  return value;
}

const MAX_AUDIT_TIMESTAMP = 8_640_000_000_000_000;
const OWNER_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function auditIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(value)
  ) {
    throw new Error(`invalid owner authorization ${label}`);
  }
  return value;
}

function auditSha256(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`invalid owner authorization ${label}`);
  const canonical = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!/^[a-f0-9]{64}$/.test(canonical)) {
    throw new Error(`invalid owner authorization ${label}`);
  }
  return canonical;
}

function auditGitSha(value: string, label: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error(`invalid owner authorization ${label}`);
  }
  return value;
}

function auditPreflightId(value: string): string {
  if (typeof value !== "string" || !/^pf_[a-f0-9]{64}$/.test(value)) {
    throw new Error("invalid owner authorization preflightId");
  }
  return value;
}

function auditGitHubId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("invalid owner authorization repositoryId");
  }
  return value;
}

function auditTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_AUDIT_TIMESTAMP) {
    throw new Error(`invalid owner authorization ${label}`);
  }
  return value;
}

function auditRepositorySlug(value: string): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new Error("invalid owner authorization repositorySlug");
  }
  const parts = value.split("/");
  if (parts.length !== 2) throw new Error("invalid owner authorization repositorySlug");
  const [owner, repo] = parts as [string, string];
  if (
    !OWNER_SLUG.test(owner) ||
    owner.includes("--") ||
    !REPOSITORY_NAME.test(repo) ||
    repo === "." ||
    repo === ".." ||
    repo.toLowerCase().endsWith(".git")
  ) {
    throw new Error("invalid owner authorization repositorySlug");
  }
  return `${owner}/${repo}`.toLowerCase();
}

function auditGitBranch(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    value !== value.trim() ||
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(value) ||
    value.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith("."))
  ) {
    throw new Error("invalid owner authorization candidateBranch");
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
