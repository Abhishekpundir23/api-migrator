import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { fork, type ChildProcess } from "node:child_process";
import { createJobStoreTestAccess, setJobStoreTransactionTestHook } from "../src/runner-job-store-sqlite.js";
import { initializeJobStore, openJobStore } from "../src/runner-job-store-internal.js";
import type { StoredJobRow } from "../src/runner-job-store-contract.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function row(label: string): StoredJobRow {
  const canonicalRecord = JSON.stringify({ label });
  return { campaignId: `campaign_${label}`, runId: `run_${label}`, jobId: `previewjob_${hash(label)}`,
    revision: 1, intentDigest: `sha256:${hash(canonicalRecord)}`, recordDigest: `sha256:${hash(canonicalRecord)}`, canonicalRecord };
}
function fixture(t: TestContext, initialize = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-job-store-test-")));
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) {
      const exit = exited(child);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const directory = join(root, "store");
  mkdirSync(directory, { mode: 0o700 });
  const policy = { applicationCheckout: process.cwd(), migrationWorkspaceRoots: [join(root, "workspace")] };
  const access = createJobStoreTestAccess(root);
  const storeId = initialize ? access.initialize(directory, policy).storeId : randomUUID();
  return { root, directory, policy, access, storeId, children, databasePath: join(directory, "runner-jobs.sqlite") };
}

test("persists rows and time across handles without replacing existing keys", (t) => {
  const f = fixture(t);
  const first = f.access.open(f.directory, f.storeId, f.policy);
  first.observeTime(1000);
  assert.deepEqual(first.insert(row("one")), { inserted: true, row: row("one") });
  assert.deepEqual(first.insert({ ...row("one"), canonicalRecord: "{}" }), { inserted: false, row: row("one") });
  first.close();
  const reopened = f.access.open(f.directory, f.storeId, f.policy);
  t.after(() => reopened.close());
  assert.equal(reopened.list().length, 1);
  assert.throws(() => reopened.observeTime(999), { code: "clock_rollback" });
  assert.deepEqual(reopened.read("campaign_one", "run_one"), row("one"));
});

test("open never initializes and requires the expected UUID", (t) => {
  const f = fixture(t, false);
  assert.throws(() => f.access.open(f.directory, f.storeId, f.policy), { code: "store_unavailable" });
  const { storeId } = f.access.initialize(f.directory, f.policy);
  assert.throws(() => f.access.open(f.directory, "", f.policy), { code: "input_invalid" });
  assert.throws(() => f.access.open(f.directory, f.storeId, f.policy), { code: "store_mismatch" });
  assert.throws(() => f.access.initialize(f.directory, f.policy), { code: "store_unsafe" });
  assert.match(storeId, /^[a-f0-9-]{36}$/);
});

test("normal operations exclude temporary roots and test admission does not bypass policy", (t) => {
  const f = fixture(t);
  assert.throws(() => openJobStore(f.directory, f.storeId, f.policy), { code: "store_unsafe" });
  assert.throws(() => initializeJobStore(f.directory, f.policy), { code: "store_unsafe" });
  for (const migrationWorkspaceRoots of [[f.directory], [join(f.directory, "nested")], [f.root]]) {
    assert.throws(() => f.access.open(f.directory, f.storeId, { ...f.policy, migrationWorkspaceRoots }), { code: "store_unsafe" });
  }
  assert.throws(() => f.access.open(`${f.directory}/../store`, f.storeId, f.policy), { code: "store_unsafe" });
  assert.throws(() => f.access.open("relative", f.storeId, f.policy), { code: "store_unsafe" });
});

const mutations: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  "weak directory": (f) => chmodSync(f.directory, 0o755),
  "weak database": (f) => chmodSync(f.databasePath, 0o644),
  "database hardlink": (f) => linkSync(f.databasePath, join(f.root, "second-link")),
  "WAL": (f) => writeFileSync(`${f.databasePath}-wal`, "unexpected", { mode: 0o600 }),
  "SHM": (f) => writeFileSync(`${f.databasePath}-shm`, "unexpected", { mode: 0o600 }),
  "database symlink": (f) => { renameSync(f.databasePath, join(f.root, "actual")); symlinkSync(join(f.root, "actual"), f.databasePath); },
  "ancestor symlink": (f) => { renameSync(f.directory, join(f.root, "actual")); symlinkSync(join(f.root, "actual"), f.directory); },
  "journal symlink": (f) => symlinkSync(f.databasePath, `${f.databasePath}-journal`),
  "journal hardlink": (f) => { writeFileSync(join(f.root, "journal"), "", { mode: 0o600 }); linkSync(join(f.root, "journal"), `${f.databasePath}-journal`); },
  "weak journal": (f) => writeFileSync(`${f.databasePath}-journal`, "", { mode: 0o644 }),
  "oversized database": (f) => truncateSync(f.databasePath, 67_108_865),
  "oversized journal": (f) => { writeFileSync(`${f.databasePath}-journal`, "", { mode: 0o600 }); truncateSync(`${f.databasePath}-journal`, 71_303_169); },
  "unsafe ancestor below test root": (f) => chmodSync(f.root, 0o777),
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name} without repairing it`, (t) => {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => f.access.open(f.directory, f.storeId, f.policy), { code: "store_unsafe" });
  });
}

test("pins database and directory inodes for each handle", (t) => {
  for (const replaceDirectory of [false, true]) {
    const f = fixture(t);
    const store = f.access.open(f.directory, f.storeId, f.policy);
    t.after(() => store.close());
    if (replaceDirectory) {
      renameSync(f.directory, join(f.root, "old"));
      mkdirSync(f.directory, { mode: 0o700 });
      copyFileSync(join(f.root, "old", "runner-jobs.sqlite"), f.databasePath);
    } else {
      renameSync(f.databasePath, join(f.root, "old"));
      copyFileSync(join(f.root, "old"), f.databasePath);
    }
    assert.throws(() => store.list(), { code: "store_unsafe" });
  }
});

for (const [name, sql] of Object.entries({
  "extra trigger": "CREATE TRIGGER evil AFTER INSERT ON runner_jobs BEGIN DELETE FROM runner_jobs; END",
  "extra table": "CREATE TABLE extra (data TEXT)",
  "wrong schema": "ALTER TABLE runner_jobs ADD COLUMN extra TEXT",
  "malformed UTF-8": "UPDATE runner_jobs SET canonical_record = CAST(x'80' AS TEXT)",
  "malformed key": "UPDATE runner_jobs SET campaign_id = '../unsafe'",
  "malformed digest": "UPDATE runner_jobs SET record_digest = 'bad'",
  "wrong metadata": "UPDATE job_store_meta SET store_id = 'not-a-uuid'",
  "blob instead of text": "UPDATE runner_jobs SET canonical_record = CAST('{}' AS BLOB)",
})) {
  test(`rejects ${name}`, (t) => {
    const f = fixture(t);
    const store = f.access.open(f.directory, f.storeId, f.policy);
    store.insert(row("one")); store.close();
    const attacker = new Database(f.databasePath); attacker.exec(sql); attacker.close();
    assert.throws(() => f.access.open(f.directory, f.storeId, f.policy), { code: "store_corrupt" });
  });
}

test("enforces capacity after existing-key lookup and bounds input bytes", (t) => {
  const f = fixture(t);
  const store = f.access.open(f.directory, f.storeId, f.policy);
  t.after(() => store.close());
  assert.throws(() => store.insert({ ...row("large"), canonicalRecord: "x".repeat(262145) }), { code: "input_invalid" });
  assert.throws(() => store.insert({ ...row("unicode"), canonicalRecord: "\ud800" }), { code: "input_invalid" });
  for (let index = 0; index < 100; index++) store.insert(row(String(index)));
  assert.equal(store.insert(row("0")).inserted, false);
  assert.throws(() => store.insert(row("101")), { code: "store_full" });
  assert.equal(store.list().length, 100);
});

test("reports lock contention without retry or sensitive SQL details", (t) => {
  const f = fixture(t);
  const store = f.access.open(f.directory, f.storeId, f.policy);
  const locked = new Database(f.databasePath);
  t.after(() => { locked.close(); store.close(); });
  locked.exec("BEGIN IMMEDIATE");
  assert.throws(() => store.insert(row("one")), { code: "store_unavailable", message: "store_unavailable" });
  locked.exec("ROLLBACK");
  assert.equal(store.read("campaign_one", "run_one"), null);
});

function event(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`worker timed out: ${expected}`)), 8000);
    const onExit = () => done(new Error(`worker exited before ${expected}`));
    const onError = (error: Error) => done(error);
    const onMessage = (message: unknown) => { if ((message as { event?: string }).event === expected) done(); };
    function done(error?: Error) {
      clearTimeout(timer); child.off("exit", onExit); child.off("error", onError); child.off("message", onMessage);
      if (error) reject(error); else resolve();
    }
    child.on("exit", onExit); child.on("error", onError); child.on("message", onMessage);
  });
}
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker exit timeout")), 8000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
for (const point of ["before_commit", "after_commit"] as const) {
  test(`child interruption at ${point} leaves a complete old or new row`, { timeout: 10000 }, async (t) => {
    const f = fixture(t);
    const child = fork(new URL("./runner-job-store-process.ts", import.meta.url), [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    f.children.push(child);
    t.after(async () => { const exit = exited(child); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit; });
    await event(child, "ready");
    const barrier = event(child, point);
    child.send({ root: f.root, directory: f.directory, policy: f.policy, storeId: f.storeId, point, row: row("one") });
    await barrier;
    const exit = exited(child); child.kill("SIGKILL"); await exit;
    const store = f.access.open(f.directory, f.storeId, f.policy);
    try { assert.deepEqual(store.read("campaign_one", "run_one"), point === "before_commit" ? null : row("one")); }
    finally { store.close(); }
  });
}

test("job identity conflicts and CAS preserve the actual winner", (t) => {
  const f = fixture(t);
  const a = f.access.open(f.directory, f.storeId, f.policy);
  const b = f.access.open(f.directory, f.storeId, f.policy);
  t.after(() => { a.close(); b.close(); });
  const previous = row("one"); a.insert(previous);
  assert.throws(() => b.insert({ ...row("two"), jobId: previous.jobId }), { code: "job_conflict" });
  const next: StoredJobRow = { ...previous, revision: 2, canonicalRecord: '{"winner":"A"}', recordDigest: `sha256:${hash("A")}` };
  assert.deepEqual(a.compareAndSwap(previous, next), { committed: true, row: next });
  assert.deepEqual(b.compareAndSwap(previous, { ...next, canonicalRecord: '{"winner":"B"}' }), { committed: false, row: next });
  assert.throws(() => b.compareAndSwap(next, { ...next, revision: 3, intentDigest: `sha256:${hash("other")}` }), { code: "input_invalid" });
  assert.throws(() => b.compareAndSwap(next, { ...next, revision: 2 }), { code: "input_invalid" });
});

test("a held rollback journal preserves committed reads and bounds a write contender", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const store = f.access.open(f.directory, f.storeId, f.policy);
  t.after(() => store.close());
  const child = fork(new URL("./runner-job-store-process.ts", import.meta.url), [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  f.children.push(child);
  await event(child, "ready");
  const barrier = event(child, "before_commit");
  child.send({ root: f.root, directory: f.directory, policy: f.policy, storeId: f.storeId, point: "before_commit", row: row("held") });
  await barrier;
  assert.deepEqual(store.list(), []);
  const startedAt = performance.now();
  assert.throws(() => store.insert(row("contender")), { code: "store_unavailable", message: "store_unavailable" });
  const elapsed = performance.now() - startedAt;
  assert(elapsed <= 1250, `contender exceeded 250 ms busy budget plus 1000 ms scheduling allowance: ${elapsed}`);
  assert.deepEqual(store.list(), []);
  const exit = exited(child); child.kill("SIGKILL"); await exit;
  assert.deepEqual(store.list(), []);
});

for (const operation of ["initialize", "observe_time"] as const) {
  for (const point of ["before_commit", "after_commit"] as const) {
    test(`${operation} interruption ${point} does not invent committed state`, { timeout: 10000 }, async (t) => {
      const f = fixture(t, operation !== "initialize");
      if (operation === "observe_time") {
        const store = f.access.open(f.directory, f.storeId, f.policy);
        store.observeTime(1000); store.close();
      }
      const child = fork(new URL("./runner-job-store-process.ts", import.meta.url), [operation], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
      f.children.push(child);
      await event(child, "ready");
      const barrier = event(child, point);
      child.send({ root: f.root, directory: f.directory, policy: f.policy, storeId: f.storeId, point, operation, now: 2000 });
      await barrier;
      const exit = exited(child); child.kill("SIGKILL"); await exit;
      if (operation === "initialize" && point === "before_commit") {
        assert.throws(() => f.access.open(f.directory, f.storeId, f.policy), { code: "store_corrupt" });
        assert.throws(() => f.access.initialize(f.directory, f.policy), { code: "store_unsafe" });
        return;
      }
      // Read only the committed identity for interrupted initialization; no repair or reinitialization.
      const native = new Database(f.databasePath, { readonly: true, fileMustExist: true });
      const metadata = native.prepare("SELECT store_id, wall_high_water FROM job_store_meta").get() as { store_id: string; wall_high_water: number };
      native.close();
      assert.equal(metadata.wall_high_water, operation === "initialize" ? 0 : point === "before_commit" ? 1000 : 2000);
      const store = f.access.open(f.directory, operation === "initialize" ? metadata.store_id : f.storeId, f.policy);
      try {
        assert.deepEqual(store.list(), []);
        if (operation === "observe_time") {
          assert.throws(() => store.observeTime(metadata.wall_high_water - 1), { code: "clock_rollback" });
          assert.doesNotThrow(() => store.observeTime(metadata.wall_high_water));
        }
      } finally { store.close(); }
    });
  }
}

test("failure after commit does not erase a committed row or high-water mark", (t) => {
  const f = fixture(t);
  const store = f.access.open(f.directory, f.storeId, f.policy);
  t.after(() => { setJobStoreTransactionTestHook(undefined); store.close(); });
  setJobStoreTransactionTestHook(({ point }) => { if (point === "after_commit") throw new Error("sensitive injected path"); });
  assert.throws(() => store.insert(row("one")), { code: "store_unavailable", message: "store_unavailable" });
  assert.throws(() => store.observeTime(2000), { code: "store_unavailable" });
  setJobStoreTransactionTestHook(undefined);
  assert.deepEqual(store.read("campaign_one", "run_one"), row("one"));
  assert.equal(store.insert(row("one")).inserted, false);
  assert.throws(() => store.observeTime(1999), { code: "clock_rollback" });
});

test("rejects accessor inputs without executing them", (t) => {
  const f = fixture(t);
  const store = f.access.open(f.directory, f.storeId, f.policy);
  t.after(() => store.close());
  let invoked = false;
  const input = row("one");
  Object.defineProperty(input, "campaignId", { enumerable: true, get() { invoked = true; return "campaign_one"; } });
  assert.throws(() => store.insert(input), { code: "input_invalid" });
  assert.equal(invoked, false);
  assert.equal(store.list().length, 0);
});

test("accepts the byte boundary and compares every prior CAS field", (t) => {
  const f = fixture(t);
  const store = f.access.open(f.directory, f.storeId, f.policy);
  t.after(() => store.close());
  const previous = { ...row("one"), canonicalRecord: "a".repeat(262144) };
  assert.equal(store.insert(previous).inserted, true);
  const next: StoredJobRow = { ...previous, revision: 2, canonicalRecord: "{}" };
  for (const patch of [{ recordDigest: `sha256:${hash("wrong")}` }, { canonicalRecord: "wrong" }, { jobId: `previewjob_${hash("wrong")}` }]) {
    const prior = { ...previous, ...patch };
    const candidate = { ...next, jobId: prior.jobId };
    assert.deepEqual(store.compareAndSwap(prior, candidate), { committed: false, row: previous });
  }
  assert.deepEqual(store.compareAndSwap(previous, next), { committed: true, row: next });
});

test("rejects out-of-band row count overflow before exposing a handle", (t) => {
  const f = fixture(t);
  const native = new Database(f.databasePath);
  try {
    const insert = native.prepare("INSERT INTO runner_jobs VALUES (@campaignId, @runId, @jobId, @revision, @intentDigest, @recordDigest, @canonicalRecord)");
    native.transaction(() => { for (let n = 0; n < 101; n++) insert.run(row(String(n))); })();
  } finally { native.close(); }
  assert.throws(() => f.access.open(f.directory, f.storeId, f.policy), { code: "store_corrupt" });
});
