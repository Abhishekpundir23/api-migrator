import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import {
  closeDb,
  consumeOwnerAuthorization,
  getDb,
  getOwnerAuthorizationConsumption,
  initializeOwnerAuthorizationStore,
  migrate,
  OWNER_AUTHORIZATION_CONSUMPTION_REJECTED,
  resetDb,
  type OwnerAuthorizationConsumptionInput,
} from "../src/index.js";
import { sqliteClient } from "../src/client.js";

const TEST_STORE_ID = "api-migrator-test-replay-store-v1";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function authorization(
  suffix = "one",
  patch: Partial<OwnerAuthorizationConsumptionInput> = {}
): OwnerAuthorizationConsumptionInput {
  return {
    authorizationId: `authorization-${suffix}`,
    envelopeId: `envelope-${suffix}`,
    envelopeDigest: digest(`envelope-${suffix}`),
    nonceDigest: digest(`nonce-${suffix}`),
    signerId: "github-owner-1234",
    keyId: "owner-key-v1",
    repositorySlug: "Example-Org/Example-Repo",
    repositoryId: 1_234_567,
    baseSha: digest("base").slice(0, 40),
    preflightId: `pf_${digest("preflight")}`,
    artifactDigest: digest("artifact"),
    manifestDigest: digest("manifest"),
    candidateBranch: "codex/api-migrator/candidate-0123456789abcdef",
    candidateTreeSha: digest("candidate-tree").slice(0, 40),
    expiresAt: Date.now() + 60_000,
    ...patch,
  };
}

function withDatabase(
  prefix: string,
  run: (path: string, db: ReturnType<typeof getDb>) => void | Promise<void>
): Promise<void> | void {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const databaseDirectory = join(directory, "database");
  const anchorDirectory = join(directory, "anchor");
  mkdirSync(databaseDirectory, { mode: 0o700 });
  mkdirSync(anchorDirectory, { mode: 0o700 });
  const path = join(databaseDirectory, "test.db");
  const anchorPath = join(anchorDirectory, "replay.anchor");
  const execute = async () => {
    const previousStoreId = process.env.API_MIGRATOR_REPLAY_STORE_ID;
    const previousAnchorPath = process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH;
    try {
      process.env.API_MIGRATOR_REPLAY_STORE_ID = TEST_STORE_ID;
      process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH = anchorPath;
      const db = getDb(path);
      migrate(db);
      initializeOwnerAuthorizationStore(db);
      await run(path, db);
    } finally {
      closeDb();
      if (previousStoreId === undefined) delete process.env.API_MIGRATOR_REPLAY_STORE_ID;
      else process.env.API_MIGRATOR_REPLAY_STORE_ID = previousStoreId;
      if (previousAnchorPath === undefined) delete process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH;
      else process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH = previousAnchorPath;
      rmSync(directory, { recursive: true, force: true });
    }
  };
  return execute();
}

test("consumes a minimal immutable authorization audit record", () =>
  withDatabase("api-migrator-owner-auth-test-", (path) => {
    const input = authorization("canonical", {
      envelopeDigest: `sha256:${digest("envelope-canonical")}`,
      nonceDigest: `sha256:${digest("nonce-canonical")}`,
      artifactDigest: `sha256:${digest("artifact-canonical")}`,
      manifestDigest: `sha256:${digest("manifest-canonical")}`,
    });
    const before = Date.now();
    const stored = consumeOwnerAuthorization(input);
    const after = Date.now();

    assert.equal(stored.authorizationId, input.authorizationId);
    assert.equal(stored.envelopeId, input.envelopeId);
    assert.equal(stored.repositorySlug, "example-org/example-repo");
    assert.equal(stored.envelopeDigest, digest("envelope-canonical"));
    assert.equal(stored.nonceDigest, digest("nonce-canonical"));
    assert.equal(stored.artifactDigest, digest("artifact-canonical"));
    assert.equal(stored.manifestDigest, digest("manifest-canonical"));
    assert.ok(stored.consumedAt >= before);
    assert.ok(stored.consumedAt <= after);
    assert.deepEqual(getOwnerAuthorizationConsumption(input.authorizationId), stored);

    const reader = new Database(path, { readonly: true });
    const columns = (reader.pragma("table_info(owner_authorization_consumptions)") as Array<{
      name: string;
    }>).map(({ name }) => name);
    const rows = reader.prepare("SELECT * FROM owner_authorization_consumptions").all();
    reader.close();

    assert.deepEqual(columns, [
      "authorization_id",
      "envelope_id",
      "envelope_digest",
      "nonce_digest",
      "signer_id",
      "key_id",
      "repository_slug",
      "repository_id",
      "base_sha",
      "preflight_id",
      "artifact_digest",
      "manifest_digest",
      "candidate_branch",
      "candidate_tree_sha",
      "expires_at",
      "consumed_at",
    ]);
    assert.equal(rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /signature|payload|private/i);
  }));

test("defaults the trusted consumption timestamp to the current clock", () =>
  withDatabase("api-migrator-owner-clock-test-", () => {
    const before = Date.now();
    const stored = consumeOwnerAuthorization(
      authorization("clock", {
        expiresAt: before + 60_000,
      })
    );
    const after = Date.now();
    assert.ok(stored.consumedAt >= before);
    assert.ok(stored.consumedAt <= after);
  }));

test("rejects authorization, envelope, envelope-digest, and nonce replays generically", () =>
  withDatabase("api-migrator-owner-replay-test-", () => {
    const first = authorization("original");
    consumeOwnerAuthorization(first);

    const attempts = [
      authorization("new-auth-fields", { authorizationId: first.authorizationId }),
      authorization("new-envelope-fields", { envelopeId: first.envelopeId }),
      authorization("new-envelope-digest", {
        envelopeDigest: `sha256:${first.envelopeDigest}`,
      }),
      authorization("new-nonce-digest", { nonceDigest: `sha256:${first.nonceDigest}` }),
    ];

    for (const attempt of attempts) {
      assert.throws(
        () => consumeOwnerAuthorization(attempt),
        (error: unknown) =>
          error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
      );
    }
  }));

test("consumption survives restart and is never released after a later failure", () =>
  withDatabase("api-migrator-owner-restart-test-", (path) => {
    const input = authorization("restart");
    const first = consumeOwnerAuthorization(input);

    // Simulate a failure after durable consumption and restart the process-local
    // connection. There is deliberately no rollback/release operation.
    closeDb();
    const reopened = getDb(path);
    migrate(reopened);

    assert.deepEqual(getOwnerAuthorizationConsumption(input.authorizationId), {
      ...input,
      repositorySlug: "example-org/example-repo",
      consumedAt: first.consumedAt,
    });
    assert.throws(
      () => consumeOwnerAuthorization(input),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );

    const reader = new Database(path, { readonly: true });
    assert.equal(reader.pragma("user_version", { simple: true }), 5);
    reader.close();
  }));

test("a successful consumption survives abrupt process death without WAL sidecars", () =>
  withDatabase("api-migrator-owner-crash-test-", async (path) => {
    const input = authorization("crash-durable");
    closeDb();

    const worker = new Worker(new URL("./owner-authorization.worker.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
      workerData: { path, authorization: input, holdAfterConsume: true },
    });
    await new Promise<void>((resolve, reject) => {
      worker.once("message", (message: WorkerResult) => {
        if (message.ok) resolve();
        else reject(new Error(message.message ?? "owner authorization worker failed"));
      });
      worker.once("error", reject);
    });
    await worker.terminate();

    // Model cleanup or recovery code moving every SQLite sidecar away after an
    // ungraceful exit. The accepted replay record must already be in the main
    // database file.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = `${path}${suffix}`;
      if (existsSync(sidecar)) renameSync(sidecar, `${sidecar}.moved`);
    }

    const reopened = getDb(path);
    migrate(reopened);
    assert.ok(getOwnerAuthorizationConsumption(input.authorizationId));
    assert.throws(
      () => consumeOwnerAuthorization(input),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
  }));

test("two concurrent processes can consume an envelope only once", () =>
  withDatabase("api-migrator-owner-concurrency-test-", async (path) => {
    const input = authorization("concurrent");
    closeDb();

    const results = await Promise.all([
      runConsumptionWorker(path, input),
      runConsumptionWorker(path, input),
    ]);

    assert.equal(results.filter((result) => result.ok).length, 1);
    const rejection = results.find((result) => !result.ok);
    assert.deepEqual(rejection, {
      ok: false,
      message: OWNER_AUTHORIZATION_CONSUMPTION_REJECTED,
    });

    const reopened = getDb(path);
    migrate(reopened);
    assert.ok(getOwnerAuthorizationConsumption(input.authorizationId));
  }));

test("validates and bounds every persisted owner-authorization field", () =>
  withDatabase("api-migrator-owner-validation-test-", () => {
    const tooLong = "x".repeat(129);
    const invalid: Array<Partial<OwnerAuthorizationConsumptionInput>> = [
      { authorizationId: "" },
      { authorizationId: tooLong },
      { envelopeId: " envelope" },
      { envelopeDigest: "A".repeat(64) },
      { nonceDigest: "f".repeat(63) },
      { signerId: "signer/id" },
      { keyId: tooLong },
      { repositorySlug: "owner/repo.git" },
      { repositorySlug: "owner/repo/extra" },
      { repositoryId: 0 },
      { repositoryId: 1.5 },
      { repositoryId: Number.MAX_SAFE_INTEGER + 1 },
      { baseSha: "g".repeat(40) },
      { preflightId: `pf_${"A".repeat(64)}` },
      { artifactDigest: "0".repeat(65) },
      { manifestDigest: "-".repeat(64) },
      { candidateBranch: "../main" },
      { candidateBranch: "x".repeat(241) },
      { candidateTreeSha: "a".repeat(41) },
      { expiresAt: Date.now() - 1 },
      { expiresAt: Number.MAX_SAFE_INTEGER },
    ];

    for (const [index, patch] of invalid.entries()) {
      assert.throws(
        () => consumeOwnerAuthorization(authorization(`invalid-${index}`, patch)),
        /invalid owner authorization|owner authorization already consumed or unavailable/
      );
    }

    const first = consumeOwnerAuthorization(authorization("after-invalid"));
    assert.equal(first.authorizationId, "authorization-after-invalid");
  }));

test("ordinary reset preserves owner-authorization consumption history", () =>
  withDatabase("api-migrator-owner-reset-test-", (_path, db) => {
    const input = authorization("reset");
    consumeOwnerAuthorization(input);
    resetDb(db);
    assert.ok(getOwnerAuthorizationConsumption(input.authorizationId));
    assert.throws(
      () => consumeOwnerAuthorization(input),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
  }));

test("store initialization requires a separate durable anchor ceremony", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-owner-init-test-"));
  const databaseDirectory = join(directory, "database");
  const anchorDirectory = join(directory, "anchor");
  mkdirSync(databaseDirectory, { mode: 0o700 });
  mkdirSync(anchorDirectory, { mode: 0o700 });
  const path = join(databaseDirectory, "test.db");
  const anchorPath = join(anchorDirectory, "replay.anchor");
  const previousStoreId = process.env.API_MIGRATOR_REPLAY_STORE_ID;
  const previousAnchorPath = process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH;
  try {
    const db = getDb(path);
    migrate(db);
    process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH = anchorPath;
    delete process.env.API_MIGRATOR_REPLAY_STORE_ID;
    assert.throws(
      () => initializeOwnerAuthorizationStore(db),
      /API_MIGRATOR_REPLAY_STORE_ID/
    );
    process.env.API_MIGRATOR_REPLAY_STORE_ID = TEST_STORE_ID;
    delete process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH;
    assert.throws(
      () => initializeOwnerAuthorizationStore(db),
      /API_MIGRATOR_REPLAY_ANCHOR_PATH/
    );
    process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH = join(databaseDirectory, "unsafe.anchor");
    assert.throws(
      () => initializeOwnerAuthorizationStore(db),
      /outside the database directory/
    );
    process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH = anchorPath;
    const identity = initializeOwnerAuthorizationStore(db);
    assert.equal(identity.storeId, TEST_STORE_ID);
    assert.equal(identity.singleton, 1);
    assert.equal(identity.anchorPath, join(realpathSync(anchorDirectory), "replay.anchor"));
    assert.match(identity.anchorDigest, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(anchorPath), true);
    assert.equal(
      initializeOwnerAuthorizationStore(db).initializedAt,
      identity.initializedAt
    );
  } finally {
    closeDb();
    if (previousStoreId === undefined) delete process.env.API_MIGRATOR_REPLAY_STORE_ID;
    else process.env.API_MIGRATOR_REPLAY_STORE_ID = previousStoreId;
    if (previousAnchorPath === undefined) delete process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH;
    else process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH = previousAnchorPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a trigger on the replay table before insertion", () =>
  withDatabase("api-migrator-owner-trigger-test-", (path) => {
    const attacker = new Database(path);
    attacker.exec(`
      CREATE TRIGGER replay_row_mutator
      AFTER INSERT ON owner_authorization_consumptions
      BEGIN
        UPDATE owner_authorization_consumptions
           SET key_id = 'mutated-key'
         WHERE authorization_id = NEW.authorization_id;
      END;
    `);
    attacker.close();

    const input = authorization("trigger");
    assert.throws(
      () => consumeOwnerAuthorization(input),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
    assert.equal(getOwnerAuthorizationConsumption(input.authorizationId), undefined);
  }));

test("rejects case-folded replay triggers before they can erase older rows", () =>
  withDatabase("api-migrator-owner-case-trigger-test-", (path) => {
    const first = authorization("case-trigger-first");
    consumeOwnerAuthorization(first);
    const attacker = new Database(path);
    attacker.exec(`
      CREATE TRIGGER replay_row_eraser
      AFTER INSERT ON OWNER_AUTHORIZATION_CONSUMPTIONS
      BEGIN
        DELETE FROM owner_authorization_consumptions
         WHERE authorization_id <> NEW.authorization_id;
      END;
    `);
    attacker.close();

    const second = authorization("case-trigger-second");
    assert.throws(
      () => consumeOwnerAuthorization(second),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
    assert.ok(getOwnerAuthorizationConsumption(first.authorizationId));
    assert.equal(getOwnerAuthorizationConsumption(second.authorizationId), undefined);
  }));

test("rejects triggers attached to unrelated tables that can erase replay state", () =>
  withDatabase("api-migrator-owner-indirect-trigger-test-", (path) => {
    const first = authorization("indirect-trigger-first");
    consumeOwnerAuthorization(first);
    const attacker = new Database(path);
    attacker.exec(`
      CREATE TRIGGER provider_side_effect
      AFTER INSERT ON providers
      BEGIN
        DELETE FROM owner_authorization_consumptions;
      END;
    `);
    attacker.close();

    const second = authorization("indirect-trigger-second");
    assert.throws(
      () => consumeOwnerAuthorization(second),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
    assert.ok(getOwnerAuthorizationConsumption(first.authorizationId));
  }));

test("rejects temporary triggers in the active SQLite connection", () =>
  withDatabase("api-migrator-owner-temp-trigger-test-", (_path, db) => {
    sqliteClient(db).exec(`
      CREATE TEMP TRIGGER temporary_side_effect
      AFTER INSERT ON providers
      BEGIN
        DELETE FROM owner_authorization_consumptions;
      END;
    `);
    const input = authorization("temp-trigger");
    assert.throws(
      () => consumeOwnerAuthorization(input),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
    assert.equal(getOwnerAuthorizationConsumption(input.authorizationId), undefined);
  }));

test("rejects an unlinked store and a recreated path without silent reinitialization", () =>
  withDatabase("api-migrator-owner-unlink-test-", (path) => {
    const consumed = authorization("before-unlink");
    consumeOwnerAuthorization(consumed);
    unlinkSync(path);

    const input = authorization("unlinked");
    assert.throws(
      () => consumeOwnerAuthorization(input),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
    closeDb();

    const replacement = getDb(path);
    migrate(replacement);
    assert.throws(
      () => initializeOwnerAuthorizationStore(replacement),
      /anchor already exists or could not be created/
    );
    assert.throws(
      () => consumeOwnerAuthorization(input),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
    assert.equal(getOwnerAuthorizationConsumption(input.authorizationId), undefined);
    assert.throws(
      () => consumeOwnerAuthorization(consumed),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
  }));

test("rejects a missing or non-owner-only external anchor", () =>
  withDatabase("api-migrator-owner-anchor-integrity-test-", () => {
    const anchorPath = process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH!;
    chmodSync(anchorPath, 0o644);
    assert.throws(
      () => consumeOwnerAuthorization(authorization("weak-anchor")),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
    chmodSync(anchorPath, 0o600);
    unlinkSync(anchorPath);
    assert.throws(
      () => consumeOwnerAuthorization(authorization("missing-anchor")),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
  }));

test("rejects a group-writable database or database directory", () =>
  withDatabase("api-migrator-owner-db-permissions-test-", (path) => {
    chmodSync(path, 0o660);
    assert.throws(
      () => consumeOwnerAuthorization(authorization("weak-database")),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
    chmodSync(path, 0o600);

    const databaseDirectory = join(path, "..");
    chmodSync(databaseDirectory, 0o770);
    assert.throws(
      () => consumeOwnerAuthorization(authorization("weak-directory")),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
    chmodSync(databaseDirectory, 0o700);
  }));

test("rejects a changed operator-pinned store identity", () =>
  withDatabase("api-migrator-owner-store-id-test-", () => {
    process.env.API_MIGRATOR_REPLAY_STORE_ID = "api-migrator-different-store-v1";
    const input = authorization("wrong-store");
    assert.throws(
      () => consumeOwnerAuthorization(input),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
    assert.equal(getOwnerAuthorizationConsumption(input.authorizationId), undefined);
  }));

test("fails closed with the same generic error when durable storage is unavailable", () => {
  try {
    // Even a correctly migrated in-memory schema cannot supply durable replay
    // protection across a restart.
    const db = getDb(":memory:");
    migrate(db);
    process.env.API_MIGRATOR_REPLAY_STORE_ID = TEST_STORE_ID;
    assert.throws(
      () => initializeOwnerAuthorizationStore(db),
      /file-backed database/
    );
    assert.throws(
      () => consumeOwnerAuthorization(authorization("unavailable")),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
  } finally {
    closeDb();
    delete process.env.API_MIGRATOR_REPLAY_STORE_ID;
  }
});

test("ignores caller clock spoofing and rejects an already-expired authorization", () =>
  withDatabase("api-migrator-owner-backdate-test-", () => {
    const spoofed = {
      ...authorization("backdated", { expiresAt: Date.now() - 1 }),
      consumedAt: 1,
    };
    assert.throws(
      () => consumeOwnerAuthorization(spoofed),
      (error: unknown) =>
        error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
    );
    assert.equal(getOwnerAuthorizationConsumption(spoofed.authorizationId), undefined);
  }));

test("uses SQLite time even when the JavaScript clock is modified", () =>
  withDatabase("api-migrator-owner-native-clock-test-", () => {
    const originalNow = Date.now;
    const realNow = originalNow();
    Date.now = () => 1;
    try {
      const input = authorization("native-clock", { expiresAt: realNow - 1 });
      assert.throws(
        () => consumeOwnerAuthorization(input),
        (error: unknown) =>
          error instanceof Error && error.message === OWNER_AUTHORIZATION_CONSUMPTION_REJECTED
      );
      assert.equal(getOwnerAuthorizationConsumption(input.authorizationId), undefined);
    } finally {
      Date.now = originalNow;
    }
  }));

test("rejects a malformed replay table without stamping schema version 5", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-owner-malformed-schema-test-"));
  const path = join(directory, "malformed.db");
  try {
    const malformed = new Database(path);
    malformed.exec(`
      CREATE TABLE owner_authorization_consumptions (
        authorization_id TEXT, envelope_id TEXT, envelope_digest TEXT, nonce_digest TEXT,
        signer_id TEXT, key_id TEXT, repository_slug TEXT, repository_id INTEGER,
        base_sha TEXT, preflight_id TEXT, artifact_digest TEXT, manifest_digest TEXT,
        candidate_branch TEXT, candidate_tree_sha TEXT, expires_at INTEGER, consumed_at INTEGER
      );
      PRAGMA user_version = 4;
    `);
    malformed.close();

    const db = getDb(path);
    assert.throws(() => migrate(db), /replay schema is missing or invalid/);
    closeDb();

    const reader = new Database(path, { readonly: true });
    assert.equal(reader.pragma("user_version", { simple: true }), 4);
    const indexes = reader.pragma("index_list(owner_authorization_consumptions)") as unknown[];
    assert.equal(indexes.length, 0);
    reader.close();
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects future database versions without modifying them", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-owner-future-schema-test-"));
  const path = join(directory, "future.db");
  try {
    const future = new Database(path);
    future.pragma("user_version = 6");
    future.close();

    assert.throws(() => getDb(path), /newer than supported version 5/);

    const reader = new Database(path, { readonly: true });
    assert.equal(reader.pragma("user_version", { simple: true }), 6);
    assert.equal(reader.pragma("journal_mode", { simple: true }), "delete");
    const tableCount = reader
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'")
      .get() as { count: number };
    assert.equal(tableCount.count, 0);
    reader.close();
    assert.equal(existsSync(`${path}-wal`), false);
    assert.equal(existsSync(`${path}-shm`), false);
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

interface WorkerResult {
  ok: boolean;
  message?: string;
}

function runConsumptionWorker(
  path: string,
  input: OwnerAuthorizationConsumptionInput
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./owner-authorization.worker.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
      workerData: { path, authorization: input },
    });
    let result: WorkerResult | undefined;
    worker.once("message", (message: WorkerResult) => {
      result = message;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`owner authorization worker exited with code ${code}`));
      else if (!result) reject(new Error("owner authorization worker returned no result"));
      else resolve(result);
    });
  });
}
