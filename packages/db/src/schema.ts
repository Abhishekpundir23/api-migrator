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

export type Provider = typeof providers.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Repo = typeof repos.$inferSelect;
export type MigrationRun = typeof migrationRuns.$inferSelect;
export type MigrationRunStatus = MigrationRun["status"];
