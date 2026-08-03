import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  closeDb,
  createCampaign,
  createProvider,
  createRun,
  getDb,
  getRun,
  listRunsWithReposForCampaign,
  migrate,
  updateRun,
  upsertRepo,
} from "../src/index";

test("database enforces relationships and atomically refreshes repository metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-db-test-"));
  const path = join(directory, "test.db");
  try {
    const db = getDb(path);
    migrate(db);

    assert.throws(
      () =>
        createCampaign({
          providerId: "missing-provider",
          name: "invalid",
          manifest: {},
        }),
      /FOREIGN KEY constraint failed/
    );

    const provider = createProvider({ name: "Inngest", slug: "inngest" });
    const refreshedProvider = createProvider({ name: "Inngest API", slug: "inngest" });
    assert.equal(refreshedProvider.id, provider.id);
    assert.equal(refreshedProvider.name, "Inngest API");

    const repo = upsertRepo({ slug: "example/customer", defaultBranch: "master" });
    const refreshedRepo = upsertRepo({
      slug: "example/customer",
      defaultBranch: "main",
      installationId: 42,
    });
    assert.equal(refreshedRepo.id, repo.id);
    assert.equal(refreshedRepo.defaultBranch, "main");
    assert.equal(refreshedRepo.installationId, 42);

    const campaign = createCampaign({
      providerId: provider.id,
      name: "v3 to v4",
      manifest: { provider: "inngest" },
      status: "active",
    });
    const run = createRun({ campaignId: campaign.id, repoId: repo.id, branch: "pilot/preview" });
    const scanning = updateRun(run.id, { status: "scanning" });
    assert.equal(scanning.finishedAt, null);
    for (const length of [41, 63]) {
      assert.throws(
        () => updateRun(run.id, { status: "scanning", baseSha: "a".repeat(length) }),
        /invalid base commit audit value/
      );
      assert.throws(
        () => updateRun(run.id, { status: "scanning", headSha: "b".repeat(length) }),
        /invalid base commit audit value/
      );
    }
    const ready = updateRun(run.id, {
      status: "preview_ready",
      summary: { applied: 2, review: 0, changedFiles: 1, introducedErrors: 0, verified: true },
      publicationMode: "preview",
      preflightId: "preflight-0123456789",
      artifactDigest: "a".repeat(64),
      baseSha: "b".repeat(40),
      baseBranch: "main",
      headSha: "c".repeat(40),
      publicationBlockers: [],
      overrideUnsafe: false,
    });
    assert.equal(typeof ready.finishedAt, "number");
    assert.equal(ready.publicationMode, "preview");
    assert.equal(ready.preflightId, "preflight-0123456789");
    assert.equal(ready.artifactDigest, "a".repeat(64));
    assert.equal(ready.baseSha, "b".repeat(40));
    assert.equal(ready.baseBranch, "main");
    assert.equal(ready.headSha, "c".repeat(40));
    assert.equal(ready.publicationBlockers, "[]");

    const rows = listRunsWithReposForCampaign(campaign.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.repoSlug, "example/customer");
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration preserves legacy rows and adds nullable publication identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-db-forward-test-"));
  const path = join(directory, "legacy.db");
  try {
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name TEXT NOT NULL,
        manifest TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE repos (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, default_branch TEXT,
        installation_id INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE migration_runs (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, repo_id TEXT NOT NULL,
        status TEXT NOT NULL, branch TEXT, pr_url TEXT, summary TEXT, report TEXT, error TEXT,
        publication_mode TEXT, preflight_id TEXT, approved_by TEXT,
        override_unsafe INTEGER NOT NULL DEFAULT 0, override_reason TEXT,
        started_at INTEGER NOT NULL, finished_at INTEGER
      );
      INSERT INTO providers VALUES ('provider-1', 'Provider', 'provider', 1);
      INSERT INTO campaigns VALUES ('campaign-1', 'provider-1', 'Campaign', '{}', 'active', 1);
      INSERT INTO repos VALUES ('repo-1', 'owner/repo', 'main', NULL, 1);
      INSERT INTO migration_runs VALUES (
        'run-1', 'campaign-1', 'repo-1', 'preview_ready', 'legacy/branch', NULL,
        '{"changedFiles":1}', NULL, NULL, 'preview', 'pf_legacy', NULL, 0, NULL, 1, 2
      );
    `);
    legacy.close();

    const db = getDb(path);
    migrate(db);
    migrate(db);
    const versionReader = new Database(path, { readonly: true });
    assert.equal(versionReader.pragma("user_version", { simple: true }), 5);
    versionReader.close();
    const migrated = getRun("run-1");
    assert.ok(migrated);
    assert.equal(migrated.branch, "legacy/branch");
    assert.equal(migrated.preflightId, "pf_legacy");
    assert.equal(migrated.artifactDigest, null);
    assert.equal(migrated.baseSha, null);
    assert.equal(migrated.baseBranch, null);
    assert.equal(migrated.headSha, null);
    assert.equal(migrated.publicationBlockers, null);

    const updated = updateRun("run-1", {
      status: "blocked",
      artifactDigest: `sha256:${"c".repeat(64)}`,
      baseSha: "d".repeat(40),
      baseBranch: "main",
      publicationBlockers: [
        {
          code: "verification_failed",
          message: "Authorization: Bearer ghp_1234567890secret failed",
        },
      ],
      overrideReason: "Reviewed with token=ghp_1234567890secret",
    });
    assert.equal(updated.artifactDigest, `sha256:${"c".repeat(64)}`);
    assert.deepEqual(JSON.parse(updated.publicationBlockers ?? "null"), [
      { code: "verification_failed", message: "Authorization: Bearer [REDACTED] failed" },
    ]);
    assert.equal(updated.overrideReason, "Reviewed with token=[REDACTED]");
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});
