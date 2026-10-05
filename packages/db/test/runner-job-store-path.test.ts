import assert from "node:assert/strict";
import fs, { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pinStore, validateFiles } from "../src/runner-job-store-path.js";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-job-path-race-")));
  const directory = join(root, "store");
  mkdirSync(directory, { mode: 0o700 });
  const database = join(directory, "runner-jobs.sqlite");
  const journal = `${database}-journal`;
  writeFileSync(database, "fixture", { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory, database, journal,
    policy: { applicationCheckout: process.cwd(), migrationWorkspaceRoots: [] } };
}

// Schedule the actual filesystem change after its directory snapshot, avoiding
// timing-dependent sleeps and keeping lstat, custody checks and file data real.
function afterDirectorySnapshot(t: TestContext, directory: string, change: () => void, before: () => void = () => {}) {
  const original = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]) === directory) before();
    const entries = Reflect.apply(original, fs, args);
    if (String(args[0]) === directory) change();
    return entries;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("revalidates a rollback journal removed after the directory snapshot", (t) => {
  const f = fixture(t);
  const expectedInode = lstatSync(f.database).ino;
  const custody = pinStore(f.directory, f.policy, f.root);
  t.after(() => custody.close());
  writeFileSync(f.journal, "", { mode: 0o600 });
  let changed = false;
  afterDirectorySnapshot(t, f.directory, () => {
    if (!changed) { changed = true; rmSync(f.journal); }
  });
  assert.doesNotThrow(() => custody.check());
  assert.equal(validateFiles(f.directory).ino, expectedInode);
});

for (const [name, mutate] of [
  ["unknown entry", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.directory, "unowned"), "", { mode: 0o600 })],
  ["weak journal replacement", (f: ReturnType<typeof fixture>) => writeFileSync(f.journal, "", { mode: 0o644 })],
  ["main database replacement", (f: ReturnType<typeof fixture>) => {
    renameSync(f.database, join(f.root, "old-database"));
    copyFileSync(join(f.root, "old-database"), f.database);
  }],
  ["weak main database", (f: ReturnType<typeof fixture>) => chmodSync(f.database, 0o644)],
] as const) {
  test(`journal revalidation still rejects ${name}`, (t) => {
    const f = fixture(t);
    const custody = pinStore(f.directory, f.policy, f.root);
    t.after(() => custody.close());
    writeFileSync(f.journal, "", { mode: 0o600 });
    let snapshots = 0;
    afterDirectorySnapshot(t, f.directory, () => {
      if (++snapshots === 1) rmSync(f.journal);
    }, () => { if (snapshots === 1) mutate(f); });
    assert.throws(() => custody.check(), { code: "store_unsafe" });
  });
}

test("journal revalidation does not accept disappearance of the main database", (t) => {
  const f = fixture(t);
  writeFileSync(f.journal, "", { mode: 0o600 });
  let changed = false;
  afterDirectorySnapshot(t, f.directory, () => {
    if (!changed) { changed = true; rmSync(f.journal); rmSync(f.database); }
  });
  assert.throws(() => validateFiles(f.directory), (error: NodeJS.ErrnoException) => error.code === "ENOENT" && error.path === f.database);
});

test("repeated rollback journal disappearance exhausts a bounded revalidation", (t) => {
  const f = fixture(t);
  writeFileSync(f.journal, "", { mode: 0o600 });
  let snapshots = 0;
  afterDirectorySnapshot(t, f.directory, () => {
    snapshots++;
    rmSync(f.journal);
    // Recreate it only for the next enumeration, after the current lstat fails.
  });
  const originalStat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    try { return Reflect.apply(originalStat, fs, args); }
    catch (error) {
      if (String(args[0]) === f.journal) writeFileSync(f.journal, "", { mode: 0o600 });
      throw error;
    }
  });
  syncBuiltinESMExports();
  assert.throws(() => validateFiles(f.directory), { code: "ENOENT" });
  assert(snapshots > 1 && snapshots <= 3, `unbounded or missing revalidation: ${snapshots}`);
});

test("journal errors other than disappearance are not retried or swallowed", (t) => {
  const f = fixture(t);
  writeFileSync(f.journal, "", { mode: 0o600 });
  const originalStat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === f.journal) throw Object.assign(new Error("fixture denial"), { code: "EACCES" });
    return Reflect.apply(originalStat, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => validateFiles(f.directory), { code: "EACCES" });
});
