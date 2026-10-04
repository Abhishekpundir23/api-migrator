import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as implementation from "../src/runner-job-source-store.js";

const jobId = `previewjob_${"a".repeat(64)}`;
function fixture(t: test.TestContext) {
  assert.equal(typeof implementation.createJobSourceStoreTestAccess, "function", "protected source storage is implemented");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "job-source-store-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "sources");
  mkdirSync(directory, { mode: 0o700 });
  const storeId = randomUUID();
  const policy = { applicationCheckout: process.cwd(), migrationWorkspaceRoots: [join(root, "workspace")] };
  const access = implementation.createJobSourceStoreTestAccess(root);
  const open = () => access.open(directory, storeId, policy);
  const store = open();
  t.after(() => store.close());
  const entry = join(directory, `${storeId}_${jobId}`);
  return { root, directory, storeId, policy, access, open, store, entry, file: join(entry, "source.bundle") };
}

test("publishes immutable exact bytes, detached reads, and a durable reopened source", (t) => {
  const f = fixture(t);
  const input = Buffer.from([0, 255, 10, 128, 42]);
  f.store.put(jobId, input);
  input.fill(1);
  assert.deepEqual(f.store.read(jobId), Buffer.from([0, 255, 10, 128, 42]));
  f.store.read(jobId).fill(2);
  assert.deepEqual(readFileSync(f.file), Buffer.from([0, 255, 10, 128, 42]));
  assert.equal(statSync(f.entry).mode & 0o7777, 0o700);
  assert.equal(statSync(f.file).mode & 0o7777, 0o600);
  f.store.close();
  const reopened = f.open();
  try { assert.deepEqual(reopened.read(jobId), Buffer.from([0, 255, 10, 128, 42])); }
  finally { reopened.close(); }
});

test("two independent writers preserve the original complete entry", (t) => {
  const f = fixture(t);
  const other = f.open();
  try {
    f.store.put(jobId, Buffer.from("original"));
    const inode = statSync(f.file).ino;
    other.put(jobId, Buffer.from("original"));
    assert.equal(statSync(f.file).ino, inode);
    assert.throws(() => other.put(jobId, Buffer.from("changed")), { code: "job_conflict" });
    assert.equal(f.store.read(jobId).toString(), "original");
    assert.deepEqual(readdirSync(f.directory), [`${f.storeId}_${jobId}`]);
  } finally { other.close(); }
});

test("missing source and closed handles fail without creating data", (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.read(jobId), { code: "store_unavailable" });
  assert.deepEqual(readdirSync(f.directory), []);
  f.store.close();
  assert.throws(() => f.store.put(jobId, Buffer.from("bytes")), { code: "store_unavailable" });
  assert.throws(() => f.store.read(jobId), { code: "store_unavailable" });
});

test("invalid IDs and empty or oversized bytes fail before writing", (t) => {
  const f = fixture(t);
  for (const id of ["../escape", `${jobId}/x`, "a".repeat(64), ""]) {
    assert.throws(() => f.store.put(id, Buffer.from("x")), { code: "input_invalid" });
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(8 * 1024 * 1024 + 1), "source"]) {
    assert.throws(() => f.store.put(jobId, bytes), { code: "input_invalid" });
  }
  assert.deepEqual(readdirSync(f.directory), []);
});

for (const mutation of ["mode", "hardlink", "symlink", "oversized", "extra-file"] as const) {
  test(`source ${mutation} replacement is refused without repair`, (t) => {
    const f = fixture(t);
    f.store.put(jobId, Buffer.from("original"));
    if (mutation === "mode") chmodSync(f.file, 0o644);
    if (mutation === "hardlink") linkSync(f.file, join(f.root, "linked"));
    if (mutation === "symlink") {
      renameSync(f.file, join(f.root, "moved"));
      symlinkSync(join(f.root, "moved"), f.file);
    }
    if (mutation === "oversized") truncateSync(f.file, 8 * 1024 * 1024 + 1);
    if (mutation === "extra-file") writeFileSync(join(f.entry, "extra"), "x", { mode: 0o600 });
    assert.throws(() => f.store.read(jobId), { code: "store_unsafe" });
    assert.throws(() => f.store.put(jobId, Buffer.from("original")), { code: "store_unsafe" });
  });
}

for (const mutation of ["mode", "replacement", "symlink"] as const) {
  test(`directory ${mutation} after open refuses subsequent source operations`, (t) => {
    const f = fixture(t);
    f.store.put(jobId, Buffer.from("original"));
    if (mutation === "mode") chmodSync(f.directory, 0o755);
    else {
      renameSync(f.directory, join(f.root, "old"));
      if (mutation === "replacement") mkdirSync(f.directory, { mode: 0o700 });
      else symlinkSync(join(f.root, "old"), f.directory);
    }
    assert.throws(() => f.store.read(jobId), { code: "store_unsafe" });
  });
}

test("production opener excludes temporary roots and migration workspaces", (t) => {
  const f = fixture(t);
  assert.throws(() => implementation.openJobSourceStore(f.directory, f.storeId, f.policy), { code: "store_unsafe" });
  assert.throws(() => f.access.open(f.directory, f.storeId,
    { ...f.policy, migrationWorkspaceRoots: [f.directory] }), { code: "store_unsafe" });
});

test("wrong store identity cannot open an existing source directory", (t) => {
  const f = fixture(t);
  f.store.put(jobId, Buffer.from("x"));
  assert.throws(() => f.access.open(f.directory, randomUUID(), f.policy), { code: "store_mismatch" });
});

test("interrupted stages are not jobs; retry can publish an independent complete entry", (t) => {
  const f = fixture(t);
  const stage = join(f.directory, `.pending-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  writeFileSync(join(stage, "source.bundle"), "partial", { mode: 0o600 });
  assert.throws(() => f.store.read(jobId), { code: "store_unavailable" });
  f.store.put(jobId, Buffer.from("complete"));
  assert.equal(f.store.read(jobId).toString(), "complete");
  assert.equal(readFileSync(join(stage, "source.bundle"), "utf8"), "partial");
});

test("abandoned stages count toward directory capacity, with no automatic pruning", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) mkdirSync(join(f.directory, `.pending-${randomUUID()}`), { mode: 0o700 });
  assert.throws(() => f.store.put(jobId, Buffer.from("x")), { code: "store_full" });
  assert.equal(readdirSync(f.directory).length, 100);
});

test("aggregate byte budget rejects new bytes but admits exact retries at capacity", (t) => {
  const f = fixture(t);
  const block = Buffer.alloc(8 * 1024 * 1024, 7);
  for (let i = 0; i < 8; i++) f.store.put(`previewjob_${String(i).repeat(64)}`, block);
  f.store.put(`previewjob_${"0".repeat(64)}`, block);
  assert.throws(() => f.store.put(jobId, Buffer.from("x")), { code: "store_full" });
  assert.equal(readdirSync(f.directory).length, 8);
});

test("simultaneous processes converge on immutable bytes that survive writer death", async (t) => {
  const f = fixture(t);
  const moduleUrl = new URL("../src/runner-job-source-store.ts", import.meta.url).href;
  const code = `
    import { createJobSourceStoreTestAccess } from ${JSON.stringify(moduleUrl)};
    const [root, directory, storeId, policy, jobId] = JSON.parse(process.argv[1]);
    const store = createJobSourceStoreTestAccess(root).open(directory, storeId, policy);
    process.send('ready');
    process.once('message', () => {
      try { store.put(jobId, Buffer.alloc(65536, 37)); process.send('written'); }
      catch (error) { process.send(error.code); }
      setInterval(() => {}, 1000);
    });`;
  const start = async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code,
      JSON.stringify([f.root, f.directory, f.storeId, f.policy, jobId])], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    t.after(() => child.kill("SIGKILL"));
    await new Promise<void>((resolve, reject) => {
      child.once("message", (message) => message === "ready" ? resolve() : reject(new Error(String(message))));
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`writer exited before readiness: ${code}`)));
    });
    return child;
  };
  const children = await Promise.all([start(), start()]);
  const results = children.map((child) => new Promise((resolve) => child.once("message", resolve)));
  children.forEach((child) => child.send("start"));
  const written = await Promise.all(results);
  assert.ok(written.includes("written"), JSON.stringify(written));
  // A racing inventory read may conservatively refuse, never overwrite.
  for (const result of written) assert.ok(["written", "store_unavailable"].includes(String(result)));
  await Promise.all(children.map((child) => new Promise<void>((resolve) => {
    child.once("exit", () => resolve()); child.kill("SIGKILL");
  })));
  f.store.close();
  const reader = f.open();
  try {
    reader.put(jobId, Buffer.alloc(65536, 37));
    assert.deepEqual(reader.read(jobId), Buffer.alloc(65536, 37));
  } finally { reader.close(); }
});
