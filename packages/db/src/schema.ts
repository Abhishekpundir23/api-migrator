/**
 * Database schema — the data model for a migration campaign platform.
 *
 *   provider 1—* campaign 1—* repo 1—* migration_run
 *
 * A provider (e.g. Inngest) creates a campaign (e.g. "v3 -> v4"). The campaign
 * targets many repos (customer codebases the provider's customers install the
 * app on). Each repo has migration_runs recording each attempt to migrate it.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** An API provider who runs campaigns. */
export const providers = sqliteTable(
  "providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(), // "Inngest"
    slug: text("slug").notNull().unique(), // "inngest"
    createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (table) => [
    check("providers_name_not_empty", sql`length(trim(${table.name})) > 0`),
    check("providers_slug_not_empty", sql`length(trim(${table.slug})) > 0`),
  ]
);

/** A single migration campaign — one breaking change for one provider. */
export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict", onUpdate: "cascade" }),
    name: text("name").notNull(), // "Inngest TS SDK v3 -> v4"
    /** The validated manifest as JSON. */
    manifest: text("manifest").notNull(),
    /** Draft / active / completed / archived. */
    status: text("status", { enum: ["draft", "active", "completed", "archived"] })
      .notNull()
      .default("draft"),
    createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (table) => [
    index("campaigns_provider_id_idx").on(table.providerId),
    index("campaigns_status_idx").on(table.status),
    check("campaigns_name_not_empty", sql`length(trim(${table.name})) > 0`),
    check(
      "campaigns_status_valid",
      sql`${table.status} in ('draft', 'active', 'completed', 'archived')`
    ),
  ]
);

/** A target repo enrolled in one or more campaigns. */
export const repos = sqliteTable(
  "repos",
  {
    id: text("id").primaryKey(),
    /** "owner/name" GitHub slug. */
    slug: text("slug").notNull().unique(),
    /** Last-known default branch. */
    defaultBranch: text("default_branch"),
    /** installation id once a GitHub App is wired. */
    installationId: integer("installation_id"),
    createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (table) => [
    check("repos_slug_not_empty", sql`length(trim(${table.slug})) > 0`),
    check(
      "repos_installation_id_positive",
      sql`${table.installationId} is null or ${table.installationId} > 0`
    ),
  ]
);

/** One attempt to migrate one repo under one campaign. */
export const migrationRuns = sqliteTable(
  "migration_runs",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade", onUpdate: "cascade" }),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "restrict", onUpdate: "cascade" }),
    status: text("status", {
      enum: [
        "queued",
        "scanning",
        "transforming",
        "verifying",
        "preview_ready",
        "blocked",
        "pr_opened",
        // Kept for compatibility with existing pilot databases. The console does
        // not claim merge tracking until a webhook/reconciliation job exists.
        "merged",
        "failed",
        "no_changes",
      ],
    })
      .notNull()
      .default("queued"),
    /** Branch pushed. */
    branch: text("branch"),
    /** PR url if opened. */
    prUrl: text("pr_url"),
    /** Summary counts JSON, for dashboards. */
    summary: text("summary"),
    /** Full structured report JSON. */
    report: text("report"),
    /** Error message if status = failed/blocked. */
    error: text("error"),
    /** Durable operator-publication audit fields. */
    publicationMode: text("publication_mode", { enum: ["preview", "publish"] }),
    preflightId: text("preflight_id"),
    /** Exact publication identity captured for this individual attempt. */
    artifactDigest: text("artifact_digest"),
    baseSha: text("base_sha"),
    baseBranch: text("base_branch"),
    /** Exact PR head observed and approved at publication time. */
    headSha: text("head_sha"),
    /** Sanitized JSON array of { code, message } publication blockers. */
    publicationBlockers: text("publication_blockers"),
    approvedBy: text("approved_by"),
    overrideUnsafe: integer("override_unsafe", { mode: "boolean" }).notNull().default(false),
    overrideReason: text("override_reason"),
    startedAt: integer("started_at").notNull().$defaultFn(() => Date.now()),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    index("migration_runs_campaign_id_idx").on(table.campaignId),
    index("migration_runs_repo_id_idx").on(table.repoId),
    index("migration_runs_campaign_status_idx").on(table.campaignId, table.status),
    index("migration_runs_preflight_id_idx").on(table.preflightId),
    check(
      "migration_runs_status_valid",
      sql`${table.status} in ('queued', 'scanning', 'transforming', 'verifying', 'preview_ready', 'blocked', 'pr_opened', 'merged', 'failed', 'no_changes')`
    ),
    check(
      "migration_runs_publication_mode_valid",
      sql`${table.publicationMode} is null or ${table.publicationMode} in ('preview', 'publish')`
    ),
  ]
);

/**
 * Immutable, one-use owner-publication authorizations.
 *
 * Only digests and the minimum publication binding needed for replay defense
 * are retained. In particular, signed payload bytes and signatures never
 * belong in this table.
 */
export const ownerAuthorizationConsumptions = sqliteTable(
  "owner_authorization_consumptions",
  {
    authorizationId: text("authorization_id").primaryKey(),
    envelopeId: text("envelope_id").notNull().unique(),
    envelopeDigest: text("envelope_digest").notNull().unique(),
    nonceDigest: text("nonce_digest").notNull().unique(),
    signerId: text("signer_id").notNull(),
    keyId: text("key_id").notNull(),
    repositorySlug: text("repository_slug").notNull(),
    repositoryId: integer("repository_id").notNull(),
    baseSha: text("base_sha").notNull(),
    preflightId: text("preflight_id").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    candidateBranch: text("candidate_branch").notNull(),
    candidateTreeSha: text("candidate_tree_sha").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at").notNull(),
  },
  (table) => [
    index("owner_authorization_consumptions_repository_idx").on(
      table.repositoryId,
      table.consumedAt
    ),
    index("owner_authorization_consumptions_preflight_idx").on(table.preflightId),
    check(
      "owner_authorization_consumptions_authorization_id_valid",
      sql`length(${table.authorizationId}) between 1 and 128`
    ),
    check(
      "owner_authorization_consumptions_envelope_id_valid",
      sql`length(${table.envelopeId}) between 1 and 128`
    ),
    check(
      "owner_authorization_consumptions_envelope_digest_valid",
      sql`length(${table.envelopeDigest}) = 64 and ${table.envelopeDigest} not glob '*[^0-9a-f]*'`
    ),
    check(
      "owner_authorization_consumptions_nonce_digest_valid",
      sql`length(${table.nonceDigest}) = 64 and ${table.nonceDigest} not glob '*[^0-9a-f]*'`
    ),
    check(
      "owner_authorization_consumptions_signer_id_valid",
      sql`length(${table.signerId}) between 1 and 128`
    ),
    check(
      "owner_authorization_consumptions_key_id_valid",
      sql`length(${table.keyId}) between 1 and 128`
    ),
    check(
      "owner_authorization_consumptions_repository_slug_valid",
      sql`length(${table.repositorySlug}) between 3 and 140`
    ),
    check(
      "owner_authorization_consumptions_repository_id_valid",
      sql`${table.repositoryId} > 0`
    ),
    check(
      "owner_authorization_consumptions_base_sha_valid",
      sql`length(${table.baseSha}) in (40, 64) and ${table.baseSha} not glob '*[^0-9a-f]*'`
    ),
    check(
      "owner_authorization_consumptions_preflight_id_valid",
      sql`length(${table.preflightId}) = 67 and substr(${table.preflightId}, 1, 3) = 'pf_' and substr(${table.preflightId}, 4) not glob '*[^0-9a-f]*'`
    ),
    check(
      "owner_authorization_consumptions_artifact_digest_valid",
      sql`length(${table.artifactDigest}) = 64 and ${table.artifactDigest} not glob '*[^0-9a-f]*'`
    ),
    check(
      "owner_authorization_consumptions_manifest_digest_valid",
      sql`length(${table.manifestDigest}) = 64 and ${table.manifestDigest} not glob '*[^0-9a-f]*'`
    ),
    check(
      "owner_authorization_consumptions_candidate_branch_valid",
      sql`length(${table.candidateBranch}) between 1 and 240`
    ),
    check(
      "owner_authorization_consumptions_candidate_tree_sha_valid",
      sql`length(${table.candidateTreeSha}) in (40, 64) and ${table.candidateTreeSha} not glob '*[^0-9a-f]*'`
    ),
    check(
      "owner_authorization_consumptions_times_valid",
      sql`${table.consumedAt} > 0 and ${table.expiresAt} > ${table.consumedAt}`
    ),
  ]
);

/** Operator-pinned identity for the durable replay ledger's physical store. */
export const ownerAuthorizationStoreIdentity = sqliteTable(
  "owner_authorization_store_identity",
  {
    singleton: integer("singleton").primaryKey(),
    storeId: text("store_id").notNull().unique(),
    databasePath: text("database_path").notNull(),
    device: text("device").notNull(),
    inode: text("inode").notNull(),
    linkCount: integer("link_count").notNull(),
    anchorPath: text("anchor_path").notNull(),
    anchorDevice: text("anchor_device").notNull(),
    anchorInode: text("anchor_inode").notNull(),
    anchorDigest: text("anchor_digest").notNull(),
    initializedAt: integer("initialized_at").notNull(),
  },
  (table) => [
    check("owner_authorization_store_identity_singleton", sql`${table.singleton} = 1`),
    check(
      "owner_authorization_store_identity_store_id_valid",
      sql`length(${table.storeId}) between 16 and 128`
    ),
    check(
      "owner_authorization_store_identity_path_valid",
      sql`length(${table.databasePath}) between 1 and 4096`
    ),
    check(
      "owner_authorization_store_identity_device_valid",
      sql`length(${table.device}) between 1 and 32 and ${table.device} not glob '*[^0-9]*'`
    ),
    check(
      "owner_authorization_store_identity_inode_valid",
      sql`length(${table.inode}) between 1 and 32 and ${table.inode} not glob '*[^0-9]*'`
    ),
    check("owner_authorization_store_identity_link_count_valid", sql`${table.linkCount} > 0`),
    check(
      "owner_authorization_store_identity_anchor_path_valid",
      sql`length(${table.anchorPath}) between 1 and 4096`
    ),
    check(
      "owner_authorization_store_identity_anchor_device_valid",
      sql`length(${table.anchorDevice}) between 1 and 32 and ${table.anchorDevice} not glob '*[^0-9]*'`
    ),
    check(
      "owner_authorization_store_identity_anchor_inode_valid",
      sql`length(${table.anchorInode}) between 1 and 32 and ${table.anchorInode} not glob '*[^0-9]*'`
    ),
    check(
      "owner_authorization_store_identity_anchor_digest_valid",
      sql`length(${table.anchorDigest}) = 64 and ${table.anchorDigest} not glob '*[^0-9a-f]*'`
    ),
    check("owner_authorization_store_identity_time_valid", sql`${table.initializedAt} > 0`),
  ]
);

export type Provider = typeof providers.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Repo = typeof repos.$inferSelect;
export type MigrationRun = typeof migrationRuns.$inferSelect;
export type MigrationRunStatus = MigrationRun["status"];
export type OwnerAuthorizationConsumption = typeof ownerAuthorizationConsumptions.$inferSelect;
export type OwnerAuthorizationStoreIdentity = typeof ownerAuthorizationStoreIdentity.$inferSelect;
