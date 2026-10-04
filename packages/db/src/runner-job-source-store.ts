import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { JobStoreError, type StorePolicy } from "./runner-job-store-contract.js";
import { validateDirectory, validateTestRoot } from "./runner-job-store-path.js";

export const MAX_JOB_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 100;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ENTRY = new RegExp(`^(${UUID})_(previewjob_[a-f0-9]{64})$`);
const PENDING = new RegExp(`^\\.pending-${UUID}$`);

/** Opaque bytes only. Binding them to a canonical job is the app's responsibility. */
export interface JobSourceStore {
  put(jobId: string, bytes: Uint8Array): void;
  read(jobId: string): Buffer;
  close(): void;
}

export function openJobSourceStore(directory: string, storeId: string, policy: StorePolicy): JobSourceStore {
  return open(directory, storeId, policy);
}

/** Source-only disposable-root seam, not part of the package exports. */
export function createJobSourceStoreTestAccess(root: string) {
  const checked = validateTestRoot(root);
  return { open: (directory: string, storeId: string, policy: StorePolicy) => open(directory, storeId, policy, checked) };
}

function fail(code: "input_invalid" | "store_unsafe" | "store_full" | "store_mismatch" | "job_conflict"): never {
  throw new JobStoreError(code);
}
function guarded<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof JobStoreError) throw error;
    throw new JobStoreError("store_unavailable");
  }
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
}
function privateDirectory(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o700) fail("store_unsafe");
  return stat;
}
function sourceFile(path: string, pending = false): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 ||
    stat.size > MAX_JOB_SOURCE_BYTES || (!pending && stat.size === 0)) fail("store_unsafe");
  return stat;
}
function validJobId(id: string): string {
  if (typeof id !== "string" || !/^previewjob_[a-f0-9]{64}$/.test(id)) fail("input_invalid");
  return id;
}
function inventory(directory: string, storeId: string) {
  const entries = readdirSync(directory);
  if (entries.length > MAX_ENTRIES) fail("store_full");
  let bytes = 0;
  for (const entry of entries) {
    const pending = PENDING.test(entry);
    const match = ENTRY.exec(entry);
    if (!pending && !match) fail("store_unsafe");
    if (match && match[1] !== storeId) fail("store_mismatch");
    const path = join(directory, entry);
    privateDirectory(path);
    const children = readdirSync(path);
    if (children.length === 0 && pending) continue;
    if (children.length !== 1 || children[0] !== "source.bundle") fail("store_unsafe");
    bytes += sourceFile(join(path, "source.bundle"), pending).size;
    if (bytes > MAX_TOTAL_BYTES) fail("store_full");
  }
  return { count: entries.length, bytes };
}

function open(directory: string, storeId: string, inputPolicy: StorePolicy, testRoot?: string): JobSourceStore {
  return guarded(() => {
    if (typeof storeId !== "string" || !new RegExp(`^${UUID}$`).test(storeId)) fail("input_invalid");
    // Capture exclusions rather than retaining mutable caller arrays.
    const policy = { applicationCheckout: inputPolicy.applicationCheckout,
      migrationWorkspaceRoots: [...inputPolicy.migrationWorkspaceRoots] };
    validateDirectory(directory, policy, testRoot);
    const pinned = privateDirectory(directory);
    const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    let closed = false;
    const check = () => {
      if (closed) throw new JobStoreError("store_unavailable");
      validateDirectory(directory, policy, testRoot);
      if (!same(pinned, privateDirectory(directory)) || !same(pinned, fstatSync(fd))) fail("store_unsafe");
      return inventory(directory, storeId);
    };
    const entryPath = (jobId: string) => join(directory, `${storeId}_${validJobId(jobId)}`);
    const readEntry = (path: string): Buffer => {
      const parent = privateDirectory(path);
      const source = join(path, "source.bundle");
      const before = sourceFile(source);
      const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(sourceFd);
        if (!same(before, opened) || opened.nlink !== 1 || opened.size !== before.size) fail("store_unsafe");
        // Bound allocation even if the file grows while being read.
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(sourceFd, bytes, offset, bytes.length - offset, offset);
          if (count === 0) fail("store_unsafe");
          offset += count;
        }
        const after = sourceFile(source);
        const observed = fstatSync(sourceFd);
        if (!same(before, after) || !same(before, observed) || after.size !== before.size || observed.size !== before.size ||
          after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || observed.nlink !== 1 ||
          !same(parent, privateDirectory(path))) fail("store_unsafe");
        return bytes;
      } finally { closeSync(sourceFd); }
    };
    try { check(); }
    catch (error) { closeSync(fd); throw error; }
    return Object.freeze({
      read: (jobId: string) => guarded(() => {
        const path = entryPath(jobId);
        check();
        const bytes = readEntry(path);
        check();
        return bytes;
      }),
      put: (jobId: string, input: Uint8Array) => guarded(() => {
        const target = entryPath(jobId);
        if (!(input instanceof Uint8Array) || input.byteLength === 0 || input.byteLength > MAX_JOB_SOURCE_BYTES) fail("input_invalid");
        const bytes = Buffer.from(input);
        const observed = check();
        try {
          const existing = readEntry(target);
          if (!existing.equals(bytes)) fail("job_conflict");
          check();
          fsyncSync(fd);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (observed.count >= MAX_ENTRIES || observed.bytes + bytes.length > MAX_TOTAL_BYTES) fail("store_full");
        const stage = join(directory, `.pending-${randomUUID()}`);
        mkdirSync(stage, { mode: 0o700 });
        const stageIdentity = privateDirectory(stage);
        let published = false;
        try {
          const sourceFd = openSync(join(stage, "source.bundle"),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { writeFileSync(sourceFd, bytes); fsyncSync(sourceFd); }
          finally { closeSync(sourceFd); }
          const stageFd = openSync(stage, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
          try { fsyncSync(stageFd); } finally { closeSync(stageFd); }
          check();
          try { renameSync(stage, target); published = true; }
          catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
          fsyncSync(fd);
          if (!readEntry(target).equals(bytes)) fail("job_conflict");
          check();
        } finally {
          // Delete only this invocation's unpublished stage, and only while its
          // parent and own directory identity still match. Never prune or repair.
          if (!published && same(pinned, lstatSync(directory)) && same(stageIdentity, lstatSync(stage))) {
            try { unlinkSync(join(stage, "source.bundle")); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            rmdirSync(stage);
            fsyncSync(fd);
          }
        }
      }),
      close: () => { if (!closed) { closed = true; closeSync(fd); } },
    });
  });
}
