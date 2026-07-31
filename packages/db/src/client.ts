/**
 * DB client — opens a SQLite database and exposes a typed Drizzle handle plus
 * a couple of helpers. SQLite for dev/demos; the schema is portable to Postgres
 * for production (swap the driver, keep the table definitions).
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";

export type DB = BetterSQLite3Database<typeof schema>;

let _db: DB | null = null;

/**
 * Get (or create) the singleton DB connection. `path` defaults to a local file
 * under the repo for dev; production points this at a persistent volume.
 */
export function getDb(path = "data/api-migrator.db"): DB {
  if (_db) return _db;
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  _db = drizzle(sqlite, { schema });
  return _db;
}

/** Create all tables if absent. Idempotent. */
export function migrate(db: DB = getDb()): void {
  // Drizzle-kit generates migrations normally; for the dev bootstrap we create
  // tables directly so a fresh checkout runs without a migration step.
  const sqlite = (db as any).session.client as Database.Database;
  sqlite.exec(SCHEMA_SQL);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  name        TEXT NOT NULL,
  manifest    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  default_branch  TEXT,
  installation_id INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_runs (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  repo_id     TEXT NOT NULL REFERENCES repos(id),
  status      TEXT NOT NULL DEFAULT 'queued',
  branch      TEXT,
  pr_url      TEXT,
  summary     TEXT,
  report      TEXT,
  error       TEXT,
  started_at  INTEGER,
  finished_at INTEGER
);
`;

/** Reset — drop and recreate all tables. DEV/TEST ONLY. */
export function resetDb(db: DB = getDb()): void {
  const sqlite = (db as any).session.client as Database.Database;
  sqlite.exec(`
    DROP TABLE IF EXISTS migration_runs;
    DROP TABLE IF EXISTS repos;
    DROP TABLE IF EXISTS campaigns;
    DROP TABLE IF EXISTS providers;
  `);
  migrate(db);
}
