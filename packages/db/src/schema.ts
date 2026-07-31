/**
 * Database schema — the data model for a migration campaign platform.
 *
 *   provider 1—* campaign 1—* repo 1—* migration_run
 *
 * A provider (e.g. Inngest) creates a campaign (e.g. "v3 -> v4"). The campaign
 * targets many repos (customer codebases the provider's customers install the
 * app on). Each repo has migration_runs recording each attempt to migrate it.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/** An API provider who runs campaigns. */
export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(), // "Inngest"
  slug: text("slug").notNull().unique(), // "inngest"
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

/** A single migration campaign — one breaking change for one provider. */
export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(),
  providerId: text("provider_id")
    .notNull()
    .references(() => providers.id),
  name: text("name").notNull(), // "Inngest TS SDK v3 -> v4"
  /** The validated manifest as JSON. */
  manifest: text("manifest").notNull(),
  /** Draft / active / completed / archived. */
  status: text("status", { enum: ["draft", "active", "completed", "archived"] })
    .notNull()
    .default("draft"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

/** A target repo enrolled in one or more campaigns. */
export const repos = sqliteTable("repos", {
  id: text("id").primaryKey(),
  /** "owner/name" GitHub slug. */
  slug: text("slug").notNull().unique(),
  /** Last-known default branch. */
  defaultBranch: text("default_branch"),
  /** installation id once a GitHub App is wired. */
  installationId: integer("installation_id"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

/** One attempt to migrate one repo under one campaign. */
export const migrationRuns = sqliteTable("migration_runs", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  repoId: text("repo_id")
    .notNull()
    .references(() => repos.id),
  status: text("status", {
    enum: [
      "queued",
      "scanning",
      "transforming",
      "verifying",
      "pr_opened",
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
  /** Error message if status = failed. */
  error: text("error"),
  startedAt: integer("started_at").$defaultFn(() => Date.now()),
  finishedAt: integer("finished_at"),
});

export type Provider = typeof providers.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Repo = typeof repos.$inferSelect;
export type MigrationRun = typeof migrationRuns.$inferSelect;
export type MigrationRunStatus = MigrationRun["status"];
