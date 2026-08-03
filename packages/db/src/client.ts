/**
 * DB client — opens a SQLite database and exposes a typed Drizzle handle plus
 * a couple of helpers. SQLite for dev/demos; the schema is portable to Postgres
 * for a local, single-operator pilot.
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  type BigIntStats,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as schema from "./schema.js";

export type DB = BetterSQLite3Database<typeof schema>;

const SCHEMA_VERSION = 5;
const REPLAY_STORE_ID_ENV = "API_MIGRATOR_REPLAY_STORE_ID";
const REPLAY_ANCHOR_PATH_ENV = "API_MIGRATOR_REPLAY_ANCHOR_PATH";
const REPLAY_STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{15,127}$/;
const REPLAY_ANCHOR_NONCE = /^[a-f0-9]{64}$/;
const MAX_REPLAY_ANCHOR_BYTES = 8_192;

let _db: DB | null = null;
let _sqlite: Database.Database | null = null;
let _dbPath: string | null = null;
let _openFileIdentity: DurableFileIdentity | null = null;

interface DurableFileIdentity {
  databasePath: string;
  device: string;
  inode: string;
  linkCount: number;
}

interface ReplayAnchorDocument {
  version: 1;
  storeId: string;
  databasePath: string;
  databaseDevice: string;
  databaseInode: string;
  initializedAt: number;
  nonce: string;
}

interface DurableReplayAnchor {
  anchorPath: string;
  anchorDevice: string;
  anchorInode: string;
  anchorDigest: string;
  document: ReplayAnchorDocument;
}

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
  try {
    // Inspect before journal-mode selection. Journal mode changes persistent
    // database state, which must not happen when this binary cannot understand
    // a future schema version.
    assertSupportedSchemaVersion(sqlite);
    const fileIdentity =
      normalizedPath === ":memory:" ? null : readDurableFileIdentity(sqlite);
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    if (normalizedPath !== ":memory:") configureDurableJournal(sqlite);
    _sqlite = sqlite;
    _dbPath = normalizedPath;
    _openFileIdentity = fileIdentity;
    _db = drizzle(sqlite, { schema });
    return _db;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/** Close the singleton connection. Primarily useful for tests and clean shutdown. */
export function closeDb(): void {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
  _dbPath = null;
  _openFileIdentity = null;
}

/** Create all tables if absent. Idempotent. */
export function migrate(db: DB = getDb()): void {
  const sqlite = sqliteClient(db);
  sqlite
    .transaction(() => {
      const currentVersion = assertSupportedSchemaVersion(sqlite);
      // A v5 database with a missing or weakened replay table must never be
      // silently repaired: doing so could erase already-consumed nonces.
      if (currentVersion === SCHEMA_VERSION) verifyOwnerAuthorizationSchema(sqlite);
      applySchema(sqlite);
    })
    .immediate();
}

const OWNER_AUTHORIZATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS owner_authorization_consumptions (
  authorization_id  TEXT PRIMARY KEY CHECK(length(authorization_id) BETWEEN 1 AND 128),
  envelope_id       TEXT NOT NULL UNIQUE CHECK(length(envelope_id) BETWEEN 1 AND 128),
  envelope_digest   TEXT NOT NULL UNIQUE CHECK(length(envelope_digest) = 64 AND envelope_digest NOT GLOB '*[^0-9a-f]*'),
  nonce_digest      TEXT NOT NULL UNIQUE CHECK(length(nonce_digest) = 64 AND nonce_digest NOT GLOB '*[^0-9a-f]*'),
  signer_id         TEXT NOT NULL CHECK(length(signer_id) BETWEEN 1 AND 128),
  key_id            TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 128),
  repository_slug   TEXT NOT NULL CHECK(length(repository_slug) BETWEEN 3 AND 140),
  repository_id     INTEGER NOT NULL CHECK(repository_id > 0),
  base_sha          TEXT NOT NULL CHECK(length(base_sha) IN (40, 64) AND base_sha NOT GLOB '*[^0-9a-f]*'),
  preflight_id      TEXT NOT NULL CHECK(length(preflight_id) = 67 AND substr(preflight_id, 1, 3) = 'pf_' AND substr(preflight_id, 4) NOT GLOB '*[^0-9a-f]*'),
  artifact_digest   TEXT NOT NULL CHECK(length(artifact_digest) = 64 AND artifact_digest NOT GLOB '*[^0-9a-f]*'),
  manifest_digest   TEXT NOT NULL CHECK(length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  candidate_branch  TEXT NOT NULL CHECK(length(candidate_branch) BETWEEN 1 AND 240),
  candidate_tree_sha TEXT NOT NULL CHECK(length(candidate_tree_sha) IN (40, 64) AND candidate_tree_sha NOT GLOB '*[^0-9a-f]*'),
  expires_at        INTEGER NOT NULL,
  consumed_at       INTEGER NOT NULL,
  CHECK(consumed_at > 0 AND expires_at > consumed_at)
);`;

const OWNER_AUTHORIZATION_STORE_IDENTITY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS owner_authorization_store_identity (
  singleton      INTEGER PRIMARY KEY CHECK(singleton = 1),
  store_id       TEXT NOT NULL UNIQUE CHECK(length(store_id) BETWEEN 16 AND 128),
  database_path  TEXT NOT NULL CHECK(length(database_path) BETWEEN 1 AND 4096),
  device         TEXT NOT NULL CHECK(length(device) BETWEEN 1 AND 32 AND device NOT GLOB '*[^0-9]*'),
  inode          TEXT NOT NULL CHECK(length(inode) BETWEEN 1 AND 32 AND inode NOT GLOB '*[^0-9]*'),
  link_count     INTEGER NOT NULL CHECK(link_count > 0),
  anchor_path    TEXT NOT NULL CHECK(length(anchor_path) BETWEEN 1 AND 4096),
  anchor_device  TEXT NOT NULL CHECK(length(anchor_device) BETWEEN 1 AND 32 AND anchor_device NOT GLOB '*[^0-9]*'),
  anchor_inode   TEXT NOT NULL CHECK(length(anchor_inode) BETWEEN 1 AND 32 AND anchor_inode NOT GLOB '*[^0-9]*'),
  anchor_digest  TEXT NOT NULL CHECK(length(anchor_digest) = 64 AND anchor_digest NOT GLOB '*[^0-9a-f]*'),
  initialized_at INTEGER NOT NULL CHECK(initialized_at > 0)
);`;

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

${OWNER_AUTHORIZATION_TABLE_SQL}
${OWNER_AUTHORIZATION_STORE_IDENTITY_TABLE_SQL}

CREATE INDEX IF NOT EXISTS campaigns_provider_id_idx ON campaigns(provider_id);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns(status);
CREATE INDEX IF NOT EXISTS migration_runs_campaign_id_idx ON migration_runs(campaign_id);
CREATE INDEX IF NOT EXISTS migration_runs_repo_id_idx ON migration_runs(repo_id);
CREATE INDEX IF NOT EXISTS migration_runs_campaign_status_idx ON migration_runs(campaign_id, status);
CREATE INDEX IF NOT EXISTS owner_authorization_consumptions_repository_idx
  ON owner_authorization_consumptions(repository_id, consumed_at);
CREATE INDEX IF NOT EXISTS owner_authorization_consumptions_preflight_idx
  ON owner_authorization_consumptions(preflight_id);
`;

/** Reset campaign data while preserving the owner-authorization security ledger. */
export function resetDb(db: DB = getDb()): void {
  const sqlite = sqliteClient(db);
  sqlite
    .transaction(() => {
      sqlite.exec(`
        DROP TABLE IF EXISTS migration_runs;
        DROP TABLE IF EXISTS repos;
        DROP TABLE IF EXISTS campaigns;
        DROP TABLE IF EXISTS providers;
      `);
      applySchema(sqlite);
    })
    .immediate();
}

export function sqliteClient(db: DB): Database.Database {
  return (db as unknown as { session: { client: Database.Database } }).session.client;
}

/**
 * Pin a fresh replay ledger to an exclusive, durable filesystem anchor outside
 * the database directory. The anchor is created before the SQLite identity row:
 * if the process crashes in between, the orphan anchor deliberately blocks all
 * future initialization until the operator restores or investigates the store.
 *
 * Replacing the SQLite file cannot be authorized by calling this function
 * again. The surviving anchor makes that state distinguishable from first use.
 */
export function initializeOwnerAuthorizationStore(
  db: DB = getDb()
): schema.OwnerAuthorizationStoreIdentity {
  const sqlite = sqliteClient(db);
  const storeId = configuredReplayStoreId();
  const stored = sqlite
    .transaction(() => {
      verifyOwnerAuthorizationSchema(sqlite);
      const file = assertStableOpenFileIdentity(sqlite);
      const anchorPath = configuredReplayAnchorPath(file);
      const existing = readOwnerAuthorizationStoreIdentity(sqlite);
      if (existing) {
        const anchor = readDurableReplayAnchor(anchorPath);
        assertExactStoreIdentity(existing, storeId, file, anchor);
        return existing;
      }

      const initializedAt = sqliteEpochMilliseconds(sqlite);
      // O_EXCL is the external one-use ceremony. An anchor with no matching
      // SQLite identity is an interrupted or lost-store incident, never a fresh
      // store that this process may silently adopt.
      const anchor = createDurableReplayAnchor(anchorPath, {
        version: 1,
        storeId,
        databasePath: file.databasePath,
        databaseDevice: file.device,
        databaseInode: file.inode,
        initializedAt,
        nonce: randomBytes(32).toString("hex"),
      });
      sqlite
        .prepare(
          `INSERT INTO owner_authorization_store_identity
            (singleton, store_id, database_path, device, inode, link_count,
             anchor_path, anchor_device, anchor_inode, anchor_digest, initialized_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          storeId,
          file.databasePath,
          file.device,
          file.inode,
          file.linkCount,
          anchor.anchorPath,
          anchor.anchorDevice,
          anchor.anchorInode,
          anchor.anchorDigest,
          initializedAt
        );
      const inserted = readOwnerAuthorizationStoreIdentity(sqlite);
      if (!inserted) throw new Error("owner authorization store identity was not persisted");
      assertExactStoreIdentity(inserted, storeId, file, anchor, initializedAt);
      return inserted;
    })
    .immediate();

  // The anchor is already durable before COMMIT. Force the committed identity
  // through the main database file before returning, then verify both sides.
  // A crash after this function reports success therefore cannot make an
  // orphaned rollback/WAL sidecar the only copy of the activation record.
  const file = syncDurableDatabaseFile(sqlite);
  const anchor = readDurableReplayAnchor(configuredReplayAnchorPath(file));
  assertExactStoreIdentity(stored, storeId, file, anchor);
  return stored;
}

type OwnerAuthorizationLedgerInsert = Omit<schema.OwnerAuthorizationConsumption, "consumedAt">;

export interface OwnerAuthorizationLedgerResult {
  stored: schema.OwnerAuthorizationConsumption;
  expiredAfterInsert: boolean;
}

/**
 * Security-critical persistence primitive used by the public repository helper.
 * It owns the immediate transaction, native clock, schema/trigger inspection,
 * physical-store verification, and exact durable readback.
 */
export function persistOwnerAuthorizationConsumption(
  db: DB,
  input: OwnerAuthorizationLedgerInsert
): OwnerAuthorizationLedgerResult {
  const sqlite = sqliteClient(db);
  const result = sqlite
    .transaction(() => {
      verifyOwnerAuthorizationSchema(sqlite);
      assertInitializedOwnerAuthorizationStore(sqlite);
      const consumedAt = sqliteEpochMilliseconds(sqlite);
      if (input.expiresAt <= consumedAt) {
        throw new Error("owner authorization is expired");
      }
      const expected: schema.OwnerAuthorizationConsumption = { ...input, consumedAt };
      sqlite
        .prepare(
          `INSERT INTO owner_authorization_consumptions (
             authorization_id, envelope_id, envelope_digest, nonce_digest,
             signer_id, key_id, repository_slug, repository_id, base_sha,
             preflight_id, artifact_digest, manifest_digest, candidate_branch,
             candidate_tree_sha, expires_at, consumed_at
           ) VALUES (
             @authorizationId, @envelopeId, @envelopeDigest, @nonceDigest,
             @signerId, @keyId, @repositorySlug, @repositoryId, @baseSha,
             @preflightId, @artifactDigest, @manifestDigest, @candidateBranch,
             @candidateTreeSha, @expiresAt, @consumedAt
           )`
        )
        .run(expected);
      const stored = readOwnerAuthorizationConsumption(sqlite, input.authorizationId);
      assertExactConsumption(stored, expected);
      return {
        stored: expected,
        expiredAfterInsert: input.expiresAt <= sqliteEpochMilliseconds(sqlite),
      };
    })
    .immediate();

  // Force the committed replay row through the main database file before the
  // caller may mint a write token. Any mismatch fails closed while leaving the
  // consumed row durable.
  syncDurableDatabaseFile(sqlite);
  verifyOwnerAuthorizationSchema(sqlite);
  assertInitializedOwnerAuthorizationStore(sqlite);
  assertExactConsumption(
    readOwnerAuthorizationConsumption(sqlite, input.authorizationId),
    result.stored
  );
  return {
    stored: result.stored,
    expiredAfterInsert:
      result.expiredAfterInsert || input.expiresAt <= sqliteEpochMilliseconds(sqlite),
  };
}

function assertInitializedOwnerAuthorizationStore(
  sqlite: Database.Database
): schema.OwnerAuthorizationStoreIdentity {
  const file = assertStableOpenFileIdentity(sqlite);
  const storeId = configuredReplayStoreId();
  const stored = readOwnerAuthorizationStoreIdentity(sqlite);
  if (!stored) throw new Error("owner authorization store is not initialized");
  const anchor = readDurableReplayAnchor(configuredReplayAnchorPath(file));
  assertExactStoreIdentity(stored, storeId, file, anchor);
  return stored;
}

function readOwnerAuthorizationStoreIdentity(
  sqlite: Database.Database
): schema.OwnerAuthorizationStoreIdentity | undefined {
  return sqlite
    .prepare(
      `SELECT singleton, store_id AS storeId, database_path AS databasePath,
              device, inode, link_count AS linkCount, anchor_path AS anchorPath,
              anchor_device AS anchorDevice, anchor_inode AS anchorInode,
              anchor_digest AS anchorDigest, initialized_at AS initializedAt
         FROM owner_authorization_store_identity WHERE singleton = 1`
    )
    .get() as schema.OwnerAuthorizationStoreIdentity | undefined;
}

function assertExactStoreIdentity(
  stored: schema.OwnerAuthorizationStoreIdentity,
  storeId: string,
  file: DurableFileIdentity,
  anchor: DurableReplayAnchor,
  initializedAt = stored.initializedAt
): void {
  if (
    stored.singleton !== 1 ||
    stored.storeId !== storeId ||
    stored.databasePath !== file.databasePath ||
    stored.device !== file.device ||
    stored.inode !== file.inode ||
    stored.linkCount !== file.linkCount ||
    stored.anchorPath !== anchor.anchorPath ||
    stored.anchorDevice !== anchor.anchorDevice ||
    stored.anchorInode !== anchor.anchorInode ||
    stored.anchorDigest !== anchor.anchorDigest ||
    anchor.document.version !== 1 ||
    anchor.document.storeId !== storeId ||
    anchor.document.databasePath !== file.databasePath ||
    anchor.document.databaseDevice !== file.device ||
    anchor.document.databaseInode !== file.inode ||
    anchor.document.initializedAt !== initializedAt ||
    stored.initializedAt !== initializedAt
  ) {
    throw new Error("owner authorization store identity does not match the initialized file");
  }
}

function configuredReplayStoreId(): string {
  const value = process.env[REPLAY_STORE_ID_ENV];
  if (typeof value !== "string" || !REPLAY_STORE_ID.test(value)) {
    throw new Error(`${REPLAY_STORE_ID_ENV} must be a 16-128 character stable identifier`);
  }
  return value;
}

function configuredReplayAnchorPath(file: DurableFileIdentity): string {
  const configured = process.env[REPLAY_ANCHOR_PATH_ENV];
  if (
    typeof configured !== "string" ||
    configured.length < 1 ||
    configured.length > 4_096 ||
    !isAbsolute(configured)
  ) {
    throw new Error(`${REPLAY_ANCHOR_PATH_ENV} must be an absolute secure anchor path`);
  }
  const name = basename(configured);
  if (!name || name === "." || name === "..") {
    throw new Error(`${REPLAY_ANCHOR_PATH_ENV} must name an anchor file`);
  }
  const parent = realpathSync(dirname(configured));
  const parentStats = statSync(parent, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (
    !parentStats.isDirectory() ||
    (currentUid !== null && parentStats.uid !== currentUid) ||
    (parentStats.mode & 0o022n) !== 0n ||
    (parentStats.mode & 0o200n) === 0n
  ) {
    throw new Error("owner authorization anchor directory must be owner-controlled and writable");
  }
  const anchorPath = join(parent, name);
  const databaseDirectory = dirname(file.databasePath);
  const fromDatabaseDirectory = relative(databaseDirectory, anchorPath);
  if (
    anchorPath === file.databasePath ||
    fromDatabaseDirectory === "" ||
    (!fromDatabaseDirectory.startsWith("..") && !isAbsolute(fromDatabaseDirectory))
  ) {
    throw new Error("owner authorization anchor must be outside the database directory");
  }
  return anchorPath;
}

function createDurableReplayAnchor(
  anchorPath: string,
  document: ReplayAnchorDocument
): DurableReplayAnchor {
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_REPLAY_ANCHOR_BYTES) {
    throw new Error("owner authorization anchor document is invalid");
  }

  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(
      anchorPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600
    );
    writeFileSync(fileDescriptor, bytes);
    fsyncSync(fileDescriptor);
  } catch {
    // Never adopt or overwrite an existing anchor. An orphan anchor indicates
    // an interrupted ceremony or a missing/replaced database and must be
    // reconciled out of band.
    throw new Error("owner authorization anchor already exists or could not be created");
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }

  // Persist the directory entry as well as the file contents before the SQLite
  // identity can commit.
  let directoryDescriptor: number | undefined;
  try {
    directoryDescriptor = openSync(dirname(anchorPath), fsConstants.O_RDONLY);
    fsyncSync(directoryDescriptor);
  } finally {
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
  return readDurableReplayAnchor(anchorPath);
}

function readDurableReplayAnchor(anchorPath: string): DurableReplayAnchor {
  const before = lstatSync(anchorPath, { bigint: true });
  let descriptor: number | undefined;
  let bytes: Buffer;
  let opened: BigIntStats;
  try {
    descriptor = openSync(anchorPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    opened = fstatSync(descriptor, { bigint: true });
    assertSecureReplayAnchorFile(opened);
    bytes = readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const after = lstatSync(anchorPath, { bigint: true });
  if (
    before.dev !== opened.dev ||
    before.ino !== opened.ino ||
    after.dev !== opened.dev ||
    after.ino !== opened.ino ||
    after.nlink !== opened.nlink ||
    bytes.length !== Number(opened.size)
  ) {
    throw new Error("owner authorization anchor file changed while being read");
  }
  if (bytes.length < 1 || bytes.length > MAX_REPLAY_ANCHOR_BYTES) {
    throw new Error("owner authorization anchor document is invalid");
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("owner authorization anchor document is invalid");
  }
  const document = parseReplayAnchorDocument(value);
  return {
    anchorPath,
    anchorDevice: opened.dev.toString(10),
    anchorInode: opened.ino.toString(10),
    anchorDigest: createHash("sha256").update(bytes).digest("hex"),
    document,
  };
}

function assertSecureReplayAnchorFile(stats: BigIntStats): void {
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (
    !stats.isFile() ||
    stats.nlink !== 1n ||
    stats.size < 1n ||
    stats.size > BigInt(MAX_REPLAY_ANCHOR_BYTES) ||
    (currentUid !== null && stats.uid !== currentUid) ||
    (stats.mode & 0o077n) !== 0n ||
    (stats.mode & 0o400n) === 0n
  ) {
    throw new Error("owner authorization anchor file is not owner-only and durable");
  }
}

function parseReplayAnchorDocument(value: unknown): ReplayAnchorDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("owner authorization anchor document is invalid");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "databaseDevice",
    "databaseInode",
    "databasePath",
    "initializedAt",
    "nonce",
    "storeId",
    "version",
  ];
  if (
    Object.keys(record).sort().join("\0") !== expectedKeys.join("\0") ||
    record.version !== 1 ||
    typeof record.storeId !== "string" ||
    !REPLAY_STORE_ID.test(record.storeId) ||
    typeof record.databasePath !== "string" ||
    !isAbsolute(record.databasePath) ||
    !decimalIdentity(record.databaseDevice) ||
    !decimalIdentity(record.databaseInode) ||
    typeof record.initializedAt !== "number" ||
    !Number.isSafeInteger(record.initializedAt) ||
    record.initializedAt <= 0 ||
    typeof record.nonce !== "string" ||
    !REPLAY_ANCHOR_NONCE.test(record.nonce)
  ) {
    throw new Error("owner authorization anchor document is invalid");
  }
  return record as unknown as ReplayAnchorDocument;
}

function decimalIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,32}$/.test(value);
}

function assertStableOpenFileIdentity(sqlite: Database.Database): DurableFileIdentity {
  if (sqlite !== _sqlite || !_openFileIdentity) {
    throw new Error("owner authorization requires an initialized file-backed database");
  }
  const current = readDurableFileIdentity(sqlite);
  if (!sameFileIdentity(current, _openFileIdentity)) {
    throw new Error("owner authorization database file identity changed after open");
  }
  return current;
}

function configureDurableJournal(sqlite: Database.Database): void {
  const journalMode = sqlite.pragma("journal_mode = DELETE", { simple: true });
  if (journalMode !== "delete") {
    throw new Error("owner authorization database requires DELETE journal mode");
  }
  sqlite.pragma("synchronous = FULL");
  sqlite.pragma("fullfsync = ON");
  if (
    sqlite.pragma("synchronous", { simple: true }) !== 2 ||
    sqlite.pragma("fullfsync", { simple: true }) !== 1
  ) {
    throw new Error("owner authorization database durability settings were not applied");
  }
}

/**
 * Complete the durability boundary after a security-state transaction. DELETE
 * journal mode plus synchronous=FULL makes SQLite sync the main file before
 * deleting its rollback journal. This additional descriptor fsync and exact
 * identity check ensure the function never reports success while the replay
 * record exists only in a removable sidecar or a substituted database file.
 */
function syncDurableDatabaseFile(sqlite: Database.Database): DurableFileIdentity {
  if (
    sqlite.pragma("journal_mode", { simple: true }) !== "delete" ||
    sqlite.pragma("synchronous", { simple: true }) !== 2 ||
    sqlite.pragma("fullfsync", { simple: true }) !== 1
  ) {
    throw new Error("owner authorization database durability settings changed");
  }
  const file = assertStableOpenFileIdentity(sqlite);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      file.databasePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev.toString(10) !== file.device ||
      opened.ino.toString(10) !== file.inode ||
      Number(opened.nlink) !== file.linkCount
    ) {
      throw new Error("owner authorization database changed before durable sync");
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  let directoryDescriptor: number | undefined;
  try {
    directoryDescriptor = openSync(dirname(file.databasePath), fsConstants.O_RDONLY);
    fsyncSync(directoryDescriptor);
  } finally {
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
  return assertStableOpenFileIdentity(sqlite);
}

function readDurableFileIdentity(sqlite: Database.Database): DurableFileIdentity {
  const main = (
    sqlite.pragma("database_list") as Array<{ name: string; file: string }>
  ).find((entry) => entry.name === "main");
  if (!main?.file || !isAbsolute(main.file)) {
    throw new Error("owner authorization requires a file-backed database");
  }
  const databasePath = realpathSync(main.file);
  const stats = statSync(databasePath, { bigint: true });
  const directoryStats = statSync(dirname(databasePath), { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (
    !stats.isFile() ||
    stats.nlink !== 1n ||
    (currentUid !== null && stats.uid !== currentUid) ||
    (stats.mode & 0o022n) !== 0n ||
    (stats.mode & 0o600n) !== 0o600n ||
    !directoryStats.isDirectory() ||
    (currentUid !== null && directoryStats.uid !== currentUid) ||
    (directoryStats.mode & 0o022n) !== 0n ||
    (directoryStats.mode & 0o700n) !== 0o700n
  ) {
    throw new Error("owner authorization database and directory must be owner-controlled");
  }
  return {
    databasePath,
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    linkCount: Number(stats.nlink),
  };
}

function sameFileIdentity(left: DurableFileIdentity, right: DurableFileIdentity): boolean {
  return (
    left.databasePath === right.databasePath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.linkCount === right.linkCount
  );
}

function sqliteEpochMilliseconds(sqlite: Database.Database): number {
  const row = sqlite
    .prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now")
    .get() as { now?: unknown } | undefined;
  if (typeof row?.now !== "number" || !Number.isSafeInteger(row.now) || row.now <= 0) {
    throw new Error("SQLite returned an invalid authorization timestamp");
  }
  return row.now;
}

function readOwnerAuthorizationConsumption(
  sqlite: Database.Database,
  authorizationId: string
): schema.OwnerAuthorizationConsumption | undefined {
  return sqlite
    .prepare(
      `SELECT authorization_id AS authorizationId, envelope_id AS envelopeId,
              envelope_digest AS envelopeDigest, nonce_digest AS nonceDigest,
              signer_id AS signerId, key_id AS keyId, repository_slug AS repositorySlug,
              repository_id AS repositoryId, base_sha AS baseSha,
              preflight_id AS preflightId, artifact_digest AS artifactDigest,
              manifest_digest AS manifestDigest, candidate_branch AS candidateBranch,
              candidate_tree_sha AS candidateTreeSha, expires_at AS expiresAt,
              consumed_at AS consumedAt
         FROM owner_authorization_consumptions WHERE authorization_id = ?`
    )
    .get(authorizationId) as schema.OwnerAuthorizationConsumption | undefined;
}

function assertExactConsumption(
  stored: schema.OwnerAuthorizationConsumption | undefined,
  expected: schema.OwnerAuthorizationConsumption
): void {
  if (!stored) throw new Error("owner authorization consumption readback is missing");
  for (const key of Object.keys(expected) as Array<keyof schema.OwnerAuthorizationConsumption>) {
    if (stored[key] !== expected[key]) {
      throw new Error("owner authorization consumption readback does not match");
    }
  }
}

function applySchema(sqlite: Database.Database): void {
  sqlite.exec(SCHEMA_SQL);
  ensurePilotAuditColumns(sqlite);
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS migration_runs_preflight_id_idx ON migration_runs(preflight_id)"
  );
  verifyOwnerAuthorizationSchema(sqlite);
  sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function verifyOwnerAuthorizationSchema(sqlite: Database.Database): void {
  if (!matchesTableSql(sqlite, "owner_authorization_consumptions", OWNER_AUTHORIZATION_TABLE_SQL)) {
    throw new Error("owner authorization replay schema is missing or invalid");
  }
  if (
    !matchesTableSql(
      sqlite,
      "owner_authorization_store_identity",
      OWNER_AUTHORIZATION_STORE_IDENTITY_TABLE_SQL
    )
  ) {
    throw new Error("owner authorization store identity schema is missing or invalid");
  }

  const triggers = sqlite
    .prepare(
      `SELECT name, 'main' AS schema_name FROM sqlite_master WHERE type = 'trigger'
       UNION ALL
       SELECT name, 'temp' AS schema_name FROM sqlite_temp_master WHERE type = 'trigger'`
    )
    .all() as Array<{ name: string; schema_name: string }>;
  if (triggers.length > 0) {
    // No application schema in this pilot requires triggers. Rejecting the
    // complete set avoids case-folding bypasses and triggers attached to an
    // unrelated table that mutate the replay ledger as a side effect.
    throw new Error("owner authorization database must not contain triggers");
  }

  const requiredUniqueColumns = new Set([
    "authorization_id",
    "envelope_id",
    "envelope_digest",
    "nonce_digest",
  ]);
  const indexes = sqlite.pragma("index_list(owner_authorization_consumptions)") as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  for (const candidate of indexes) {
    if (candidate.unique !== 1 || candidate.partial !== 0) continue;
    const columns = sqlite.pragma(`index_info(${quotePragmaName(candidate.name)})`) as Array<{
      name: string;
    }>;
    if (columns.length === 1) requiredUniqueColumns.delete(columns[0]!.name);
  }
  if (requiredUniqueColumns.size > 0) {
    throw new Error("owner authorization replay uniqueness constraints are missing");
  }

  assertIndexColumns(sqlite, "owner_authorization_consumptions_repository_idx", [
    "repository_id",
    "consumed_at",
  ]);
  assertIndexColumns(sqlite, "owner_authorization_consumptions_preflight_idx", ["preflight_id"]);
}

function matchesTableSql(
  sqlite: Database.Database,
  tableName: string,
  expectedSql: string
): boolean {
  const table = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql?: string } | undefined;
  return (
    typeof table?.sql === "string" &&
    normalizeSchemaSql(table.sql) === normalizeSchemaSql(expectedSql)
  );
}

function assertSupportedSchemaVersion(sqlite: Database.Database): number {
  const currentVersion = Number(sqlite.pragma("user_version", { simple: true }));
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
    throw new Error("database schema version is invalid");
  }
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}`
    );
  }
  return currentVersion;
}

function assertIndexColumns(
  sqlite: Database.Database,
  indexName: string,
  expectedColumns: readonly string[]
): void {
  const indexes = sqlite.pragma("index_list(owner_authorization_consumptions)") as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  const index = indexes.find((candidate) => candidate.name === indexName);
  const columns = index
    ? (sqlite.pragma(`index_info(${quotePragmaName(indexName)})`) as Array<{ name: string }>).map(
        ({ name }) => name
      )
    : [];
  if (
    !index ||
    index.unique !== 0 ||
    index.partial !== 0 ||
    columns.length !== expectedColumns.length ||
    columns.some((column, position) => column !== expectedColumns[position])
  ) {
    throw new Error(`owner authorization replay index ${indexName} is missing or invalid`);
  }
}

function quotePragmaName(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizeSchemaSql(value: string): string {
  return value
    .replace(/\bif\s+not\s+exists\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();
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
