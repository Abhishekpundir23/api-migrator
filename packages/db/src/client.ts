/**
 * DB client — opens a SQLite database and exposes a typed Drizzle handle plus
 * a couple of helpers. SQLite for dev/demos; the schema is portable to Postgres
 * for a local, single-operator pilot.
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as schema from "./schema.js";

export type DB = BetterSQLite3Database<typeof schema>;

let _db: DB | null = null;
let _sqlite: Database.Database | null = null;
let _dbPath: string | null = null;

/**
 * Resolve operator-configured paths relative to the workspace root so every
 * workspace command opens the same database. Explicit function arguments keep
 * the conventional current-working-directory behavior used by tests and tools.
 */
export function resolveDatabasePath(
  path?: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configured = path ?? env.API_MIGRATOR_DB_PATH ?? "data/api-migrator.db";
  if (configured === ":memory:" || isAbsolute(configured)) return configured;
  const configRoot = env.API_MIGRATOR_WORKSPACE_ROOT;
  return resolve(path === undefined && configRoot ? configRoot : process.cwd(), configured);
}

/**
 * Get (or create) the singleton DB connection. `path` defaults to a local file
 * under the repo for dev; production points this at a persistent volume.
 */
export function getDb(path?: string): DB {
  // Repository helpers call getDb() without a path. Once a caller has opened an
  // explicit test/pilot database, those helpers must keep using that connection.
  if (_db && path === undefined) return _db;
  const normalizedPath = resolveDatabasePath(path);
  if (_db) {
    if (_dbPath !== normalizedPath) {
      throw new Error(
        `database already open at ${_dbPath}; call closeDb() before opening ${normalizedPath}`
      );
    }
    return _db;
  }
  if (normalizedPath !== ":memory:") {
    mkdirSync(dirname(normalizedPath), { recursive: true });
  }
  const sqlite = new Database(normalizedPath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  if (normalizedPath !== ":memory:") sqlite.pragma("journal_mode = WAL");
  _sqlite = sqlite;
  _dbPath = normalizedPath;
  _db = drizzle(sqlite, { schema });
  return _db;
}

/** Close the singleton connection. Primarily useful for tests and clean shutdown. */
export function closeDb(): void {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
  _dbPath = null;
}

/** Create all tables if absent. Idempotent. */
export function migrate(db: DB = getDb()): void {
  // Drizzle-kit generates migrations normally; for the dev bootstrap we create
  // tables directly so a fresh checkout runs without a migration step.
  const sqlite = sqliteClient(db);
  sqlite.exec(SCHEMA_SQL);
  ensurePilotAuditColumns(sqlite);
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS migration_runs_preflight_id_idx ON migration_runs(preflight_id)"
  );
  sqlite.pragma("user_version = 4");
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL CHECK(length(trim(name)) > 0),
  slug       TEXT NOT NULL UNIQUE CHECK(length(trim(slug)) > 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  name        TEXT NOT NULL CHECK(length(trim(name)) > 0),
  manifest    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'completed', 'archived')),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE CHECK(length(trim(slug)) > 0),
  default_branch  TEXT,
  installation_id INTEGER CHECK(installation_id IS NULL OR installation_id > 0),
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_runs (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON UPDATE CASCADE ON DELETE CASCADE,
  repo_id     TEXT NOT NULL REFERENCES repos(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'scanning', 'transforming', 'verifying', 'preview_ready', 'blocked', 'pr_opened', 'merged', 'failed', 'no_changes')),
  branch      TEXT,
  pr_url      TEXT,
  summary     TEXT,
  report      TEXT,
  error       TEXT,
  publication_mode TEXT CHECK(publication_mode IS NULL OR publication_mode IN ('preview', 'publish')),
  preflight_id TEXT,
  artifact_digest TEXT,
  base_sha TEXT,
  base_branch TEXT,
  head_sha TEXT,
  publication_blockers TEXT,
  approved_by TEXT,
  override_unsafe INTEGER NOT NULL DEFAULT 0 CHECK(override_unsafe IN (0, 1)),
  override_reason TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS campaigns_provider_id_idx ON campaigns(provider_id);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns(status);
CREATE INDEX IF NOT EXISTS migration_runs_campaign_id_idx ON migration_runs(campaign_id);
CREATE INDEX IF NOT EXISTS migration_runs_repo_id_idx ON migration_runs(repo_id);
CREATE INDEX IF NOT EXISTS migration_runs_campaign_status_idx ON migration_runs(campaign_id, status);
`;

/** Reset — drop and recreate all tables. DEV/TEST ONLY. */
export function resetDb(db: DB = getDb()): void {
  const sqlite = sqliteClient(db);
  sqlite.exec(`
    DROP TABLE IF EXISTS migration_runs;
    DROP TABLE IF EXISTS repos;
    DROP TABLE IF EXISTS campaigns;
    DROP TABLE IF EXISTS providers;
  `);
  migrate(db);
}

function sqliteClient(db: DB): Database.Database {
  return (db as unknown as { session: { client: Database.Database } }).session.client;
}

/** Add pilot audit fields to databases created by the pre-migration prototype. */
function ensurePilotAuditColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.pragma("table_info(migration_runs)") as Array<{ name: string }>).map((column) => column.name)
  );
  const additions: Array<[string, string]> = [
    ["publication_mode", "TEXT CHECK(publication_mode IS NULL OR publication_mode IN ('preview', 'publish'))"],
    ["preflight_id", "TEXT"],
    ["artifact_digest", "TEXT"],
    ["base_sha", "TEXT"],
    ["base_branch", "TEXT"],
    ["head_sha", "TEXT"],
    ["publication_blockers", "TEXT"],
    ["approved_by", "TEXT"],
    ["override_unsafe", "INTEGER NOT NULL DEFAULT 0 CHECK(override_unsafe IN (0, 1))"],
    ["override_reason", "TEXT"],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name)) sqlite.exec(`ALTER TABLE migration_runs ADD COLUMN ${name} ${definition}`);
  }
}
