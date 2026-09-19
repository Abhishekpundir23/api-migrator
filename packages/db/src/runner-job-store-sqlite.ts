import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JobStoreError, type JobStore, type StoredJobRow, type StorePolicy, type StoreFailureCode } from "./runner-job-store-contract.js";
import { DATABASE_BASENAME, MAX_DATABASE_BYTES, pinStore, validateDirectory, validateTestRoot } from "./runner-job-store-path.js";

const META_SQL = `CREATE TABLE job_store_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  store_id TEXT NOT NULL UNIQUE,
  wall_high_water INTEGER NOT NULL CHECK (wall_high_water >= 0)
)`;
const JOB_SQL = `CREATE TABLE runner_jobs (
  campaign_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision IN (1, 2, 3)),
  intent_digest TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  canonical_record TEXT NOT NULL
    CHECK (length(CAST(canonical_record AS BLOB)) BETWEEN 1 AND 262144),
  PRIMARY KEY (campaign_id, run_id)
)`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COLUMNS = `CAST(campaign_id AS BLOB) AS campaignId, CAST(run_id AS BLOB) AS runId,
  CAST(job_id AS BLOB) AS jobId, revision, CAST(intent_digest AS BLOB) AS intentDigest,
  CAST(record_digest AS BLOB) AS recordDigest, CAST(canonical_record AS BLOB) AS canonicalRecord`;
function fail(code: StoreFailureCode): never { throw new JobStoreError(code); }
function guarded<T>(action: () => T): T {
  try { return action(); } catch (error) {
    if (error instanceof JobStoreError) throw error;
    const code = (error as { code?: string })?.code;
    if (code === "SQLITE_FULL" || code === "ENOSPC" || code === "EDQUOT") fail("store_full");
    if (code?.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB") fail("store_corrupt");
    fail("store_unavailable");
  }
}
type TransactionEvent = { point: "before_commit" | "after_commit"; operation: "initialize" | "insert" | "compare_and_swap" | "observe_time" };
// Source-only seams: not exported by any package subpath and never selected by environment.
let transactionTestHook: ((event: TransactionEvent) => void) | undefined;
export function setJobStoreTransactionTestHook(hook: ((event: TransactionEvent) => void) | undefined): void { transactionTestHook = hook; }
export function createJobStoreTestAccess(testRoot: string) {
  const root = guarded(() => validateTestRoot(testRoot));
  return Object.freeze({
    initialize: (directory: string, policy: StorePolicy) => initialize(directory, policy, root),
    open: (directory: string, expectedStoreId: string, policy: StorePolicy) => open(directory, expectedStoreId, policy, root),
  });
}
function transaction<T>(db: Database.Database, operation: TransactionEvent["operation"], action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    transactionTestHook?.({ point: "before_commit", operation });
    db.exec("COMMIT");
    transactionTestHook?.({ point: "after_commit", operation });
    return result;
  } catch (error) {
    // A committed transaction is an uncertain success after a later failure.
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
function configure(db: Database.Database): void {
  if (db.pragma("journal_mode", { simple: true }) !== "delete") fail("store_unsafe");
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = FULL"); db.pragma("fullfsync = ON"); db.pragma("busy_timeout = 250");
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  if (!Number.isInteger(pageSize) || pageSize < 512 || pageSize > 65536) fail("store_corrupt");
  db.pragma(`max_page_count = ${Math.floor(MAX_DATABASE_BYTES / pageSize)}`);
  settings(db);
}
function settings(db: Database.Database): void {
  const databases = db.pragma("database_list") as { name: string; file: string }[];
  // integrity_check opens SQLite's intrinsic temp schema; it is not ATTACH.
  if (databases.filter((entry) => entry.name === "main").length !== 1 || !databases.find((entry) => entry.name === "main")?.file ||
    databases.some((entry) => entry.name !== "main" && (entry.name !== "temp" || entry.file !== "")) ||
    (db.prepare("SELECT count(*) AS count FROM sqlite_temp_master").get() as { count: number }).count !== 0 ||
    db.pragma("journal_mode", { simple: true }) !== "delete" || db.pragma("synchronous", { simple: true }) !== 2 ||
    db.pragma("fullfsync", { simple: true }) !== 1 || db.pragma("busy_timeout", { simple: true }) !== 250 ||
    db.pragma("max_page_count", { simple: true }) !== Math.floor(MAX_DATABASE_BYTES / (db.pragma("page_size", { simple: true }) as number))) fail("store_unsafe");
}
function validateRow(input: StoredJobRow, code: StoreFailureCode): StoredJobRow {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.getOwnPropertySymbols(input).length !== 0) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)) fail(code);
  const row = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as StoredJobRow;
  if (!row || Object.keys(row).sort().join(",") !== "campaignId,canonicalRecord,intentDigest,jobId,recordDigest,revision,runId" ||
    typeof row.campaignId !== "string" || !KEY.test(row.campaignId) || typeof row.runId !== "string" || !KEY.test(row.runId) ||
    typeof row.jobId !== "string" || !/^previewjob_[a-f0-9]{64}$/.test(row.jobId) || ![1, 2, 3].includes(row.revision) ||
    typeof row.intentDigest !== "string" || !DIGEST.test(row.intentDigest) || typeof row.recordDigest !== "string" || !DIGEST.test(row.recordDigest) ||
    typeof row.canonicalRecord !== "string" || Buffer.byteLength(row.canonicalRecord) < 1 || Buffer.byteLength(row.canonicalRecord) > 262144 ||
    Buffer.from(row.canonicalRecord).toString("utf8") !== row.canonicalRecord) fail(code);
  return { ...row };
}
function decode(value: unknown): StoredJobRow {
  const raw = value as Record<string, unknown>;
  const result: Record<string, unknown> = { revision: raw.revision };
  for (const key of ["campaignId", "runId", "jobId", "intentDigest", "recordDigest", "canonicalRecord"]) {
    const bytes = raw[key];
    if (!Buffer.isBuffer(bytes) || bytes.length > (key === "canonicalRecord" ? 262144 : 128)) fail("store_corrupt");
    try { result[key] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail("store_corrupt"); }
  }
  return validateRow(result as StoredJobRow, "store_corrupt");
}
function count(db: Database.Database): number {
  const value = (db.prepare("SELECT count(*) AS count FROM runner_jobs").get() as { count: number }).count;
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) fail("store_corrupt");
  // SQLite affinities are not strict types. Bound raw bytes before allocating
  // them and reject BLOB substitutions that would change comparison semantics.
  if (db.prepare(`SELECT 1 FROM runner_jobs WHERE typeof(revision) != 'integer'
    OR typeof(campaign_id) != 'text' OR length(CAST(campaign_id AS BLOB)) NOT BETWEEN 1 AND 128
    OR typeof(run_id) != 'text' OR length(CAST(run_id AS BLOB)) NOT BETWEEN 1 AND 128
    OR typeof(job_id) != 'text' OR length(CAST(job_id AS BLOB)) != 75
    OR typeof(intent_digest) != 'text' OR length(CAST(intent_digest AS BLOB)) != 71
    OR typeof(record_digest) != 'text' OR length(CAST(record_digest AS BLOB)) != 71
    OR typeof(canonical_record) != 'text' OR length(CAST(canonical_record AS BLOB)) NOT BETWEEN 1 AND 262144
    LIMIT 1`).get()) fail("store_corrupt");
  return value;
}
function read(db: Database.Database, campaign: string, run: string): StoredJobRow | null {
  const value = db.prepare(`SELECT ${COLUMNS} FROM runner_jobs WHERE campaign_id = ? AND run_id = ?`).get(campaign, run);
  return value ? decode(value) : null;
}
function rows(db: Database.Database): StoredJobRow[] {
  count(db);
  return db.prepare(`SELECT ${COLUMNS} FROM runner_jobs ORDER BY campaign_id, run_id`).all().map(decode);
}
function metadata(db: Database.Database, expectedStoreId: string): number {
  const values = db.prepare("SELECT singleton, schema_version, store_id, wall_high_water FROM job_store_meta").all() as Record<string, unknown>[];
  if (values.length !== 1) fail("store_corrupt");
  const value = values[0];
  if (value.singleton !== 1 || value.schema_version !== 1 || typeof value.store_id !== "string" || !UUID.test(value.store_id) ||
    !Number.isSafeInteger(value.wall_high_water) || (value.wall_high_water as number) < 0) fail("store_corrupt");
  if (value.store_id !== expectedStoreId) fail("store_mismatch");
  return value.wall_high_water as number;
}
const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim();
function schema(db: Database.Database): void {
  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").all();
  const expected = [
    { type: "table", name: "job_store_meta", tbl_name: "job_store_meta", sql: META_SQL },
    { type: "table", name: "runner_jobs", tbl_name: "runner_jobs", sql: JOB_SQL },
    { type: "index", name: "sqlite_autoindex_job_store_meta_1", tbl_name: "job_store_meta", sql: null },
    { type: "index", name: "sqlite_autoindex_runner_jobs_1", tbl_name: "runner_jobs", sql: null },
    { type: "index", name: "sqlite_autoindex_runner_jobs_2", tbl_name: "runner_jobs", sql: null },
  ];
  const normalizeObjects = (values: unknown[]) => values.map((value) => {
    const entry = value as { sql: string | null };
    return { ...entry, sql: entry.sql === null ? null : normalized(entry.sql) };
  });
  if (JSON.stringify(normalizeObjects(objects)) !== JSON.stringify(normalizeObjects(expected))) fail("store_corrupt");
  for (const [table, expectedColumns] of [["job_store_meta", [["store_id"]]], ["runner_jobs", [["campaign_id", "run_id"], ["job_id"]]]] as const) {
    const indexes = db.pragma(`index_list(${table})`) as { name: string; unique: number; partial: number; origin: string }[];
    if (indexes.length !== expectedColumns.length) fail("store_corrupt");
    const columns = indexes.map((index) => {
      if (index.unique !== 1 || index.partial !== 0 || !["pk", "u"].includes(index.origin)) fail("store_corrupt");
      return (db.pragma(`index_info(${index.name})`) as { name: string }[]).map((column) => column.name);
    });
    if (JSON.stringify(columns.sort()) !== JSON.stringify([...expectedColumns].sort())) fail("store_corrupt");
  }
  if (db.pragma("encoding", { simple: true }) !== "UTF-8" || db.pragma("integrity_check", { simple: true }) !== "ok") fail("store_corrupt");
}
function detachPolicy(policy: StorePolicy): StorePolicy {
  if (!policy || typeof policy.applicationCheckout !== "string" || !Array.isArray(policy.migrationWorkspaceRoots) ||
    policy.migrationWorkspaceRoots.some((value) => typeof value !== "string")) fail("input_invalid");
  return { applicationCheckout: policy.applicationCheckout, migrationWorkspaceRoots: [...policy.migrationWorkspaceRoots] };
}
export function initializeJobStore(directory: string, policy: StorePolicy): { storeId: string } { return initialize(directory, policy); }
function initialize(directory: string, inputPolicy: StorePolicy, testRoot?: string): { storeId: string } {
  return guarded(() => {
    const policy = detachPolicy(inputPolicy);
    validateDirectory(directory, policy, testRoot);
    if (readdirSync(directory).length !== 0) fail("store_unsafe");
    const path = join(directory, DATABASE_BASENAME);
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
    closeSync(fd);
    const custody = pinStore(directory, policy, testRoot);
    let db: Database.Database | undefined;
    try {
      db = new Database(path, { fileMustExist: true, timeout: 250 }); custody.check(); configure(db);
      const storeId = randomUUID();
      transaction(db, "initialize", () => {
        db!.exec(`${META_SQL}; ${JOB_SQL};`);
        db!.prepare("INSERT INTO job_store_meta VALUES (1, 1, ?, 0)").run(storeId);
      });
      custody.sync(); settings(db); schema(db); metadata(db, storeId);
      return { storeId };
    } finally { db?.close(); custody.close(); }
  });
}
export function openJobStore(directory: string, expectedStoreId: string, policy: StorePolicy): JobStore { return open(directory, expectedStoreId, policy); }
function open(directory: string, expectedStoreId: string, inputPolicy: StorePolicy, testRoot?: string): JobStore {
  return guarded(() => {
    if (typeof expectedStoreId !== "string" || !UUID.test(expectedStoreId)) fail("input_invalid");
    const policy = detachPolicy(inputPolicy);
    const custody = pinStore(directory, policy, testRoot);
    let db: Database.Database | undefined;
    let closed = false;
    try {
      db = new Database(join(directory, DATABASE_BASENAME), { fileMustExist: true, timeout: 250 });
      custody.check(); configure(db); schema(db); metadata(db, expectedStoreId); rows(db);
      const connection = db;
      const check = () => {
        if (closed) fail("store_unavailable");
        custody.check(); settings(connection); schema(connection); metadata(connection, expectedStoreId); count(connection);
      };
      const sync = () => { custody.sync(); check(); };
      return Object.freeze({
        storeId: expectedStoreId,
        list: () => guarded(() => { check(); return rows(connection); }),
        read: (campaignId: string, runId: string) => guarded(() => {
          if (typeof campaignId !== "string" || !KEY.test(campaignId) || typeof runId !== "string" || !KEY.test(runId)) fail("input_invalid");
          check(); return read(connection, campaignId, runId);
        }),
        observeTime: (now: number) => guarded(() => {
          if (!Number.isSafeInteger(now) || now < 0) fail("input_invalid");
          check();
          transaction(connection, "observe_time", () => {
            if (now < metadata(connection, expectedStoreId)) fail("clock_rollback");
            connection.prepare("UPDATE job_store_meta SET wall_high_water = ? WHERE singleton = 1").run(now);
          });
          sync(); if (metadata(connection, expectedStoreId) < now) fail("store_corrupt");
        }),
        insert: (input: StoredJobRow) => guarded(() => {
          const row = validateRow(input, "input_invalid"); check();
          const inserted = transaction(connection, "insert", () => {
            if (read(connection, row.campaignId, row.runId)) return false;
            if (connection.prepare("SELECT 1 FROM runner_jobs WHERE job_id = ?").get(row.jobId)) fail("job_conflict");
            if (count(connection) >= 100) fail("store_full");
            connection.prepare(`INSERT INTO runner_jobs VALUES (@campaignId, @runId, @jobId, @revision, @intentDigest, @recordDigest, @canonicalRecord)`).run(row);
            return true;
          });
          sync(); const actual = read(connection, row.campaignId, row.runId);
          if (!actual) fail("store_corrupt");
          return { inserted, row: actual };
        }),
        compareAndSwap: (previousInput: StoredJobRow, nextInput: StoredJobRow) => guarded(() => {
          const previous = validateRow(previousInput, "input_invalid"); const next = validateRow(nextInput, "input_invalid");
          if (next.revision !== previous.revision + 1 || next.campaignId !== previous.campaignId || next.runId !== previous.runId ||
            next.jobId !== previous.jobId || next.intentDigest !== previous.intentDigest) fail("input_invalid");
          check();
          const committed = transaction(connection, "compare_and_swap", () => {
            if (!read(connection, previous.campaignId, previous.runId)) fail("job_conflict");
            return connection.prepare(`UPDATE runner_jobs SET revision = @next_revision, record_digest = @next_digest, canonical_record = @next_bytes
              WHERE campaign_id = @campaign AND run_id = @run AND job_id = @job AND revision = @previous_revision
              AND intent_digest = @intent AND record_digest = @previous_digest AND canonical_record = @previous_bytes`).run({
              next_revision: next.revision, next_digest: next.recordDigest, next_bytes: next.canonicalRecord,
              campaign: previous.campaignId, run: previous.runId, job: previous.jobId, previous_revision: previous.revision,
              intent: previous.intentDigest, previous_digest: previous.recordDigest, previous_bytes: previous.canonicalRecord,
            }).changes === 1;
          });
          sync(); const actual = read(connection, previous.campaignId, previous.runId);
          if (!actual) fail("store_corrupt");
          return { committed, row: actual };
        }),
        close: () => guarded(() => { if (!closed) { closed = true; try { connection.close(); } finally { custody.close(); } } }),
      });
    } catch (error) { db?.close(); custody.close(); throw error; }
  });
}
