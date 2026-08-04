import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_SOURCE_ENTRIES = 50_000;
const MAX_SOURCE_BYTES = 536_870_912;
const MAX_SOURCE_FILE_BYTES = 268_435_456;
const MAX_DEPENDENCY_ENTRIES = 200_000;
const MAX_DEPENDENCY_BYTES = 1_073_741_824;
const MAX_DEPTH = 64;
const FORBIDDEN_PREPARED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

export interface RegularTreeEntry {
  mode: 0o100644 | 0o100755;
  size: number;
  digest: string;
}

export function assertCanonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes("\0") || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute canonical path`);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${label} must be a real canonical directory`);
  }
  return path;
}

export function assertEmptyDirectory(path: string, label: string): string {
  const root = assertCanonicalDirectory(path, label);
  if (readdirSync(root).length !== 0) throw new Error(`${label} must be empty`);
  return root;
}

/**
 * Prepared roots cross from the offline preparation container into the only
 * online phase. `regularTreeDigest` deliberately ignores Git metadata and
 * installed dependencies, so reject those names explicitly before trusting a
 * prepared-state digest. This applies at every depth and to every entry type.
 */
export function assertPreparedTreePristine(rootPath: string, label: string): void {
  const root = assertCanonicalDirectory(rootPath, label);
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(compareNames)) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replace(/\\/g, "/");
      assertSafeRelativePath(path);
      if (FORBIDDEN_PREPARED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
        throw new Error(`${label} contains forbidden pre-install state: ${path}`);
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(absolute);
    }
  }
}

/** Remove only npm-created install trees after a failed online attempt. */
export function removeNodeModulesTrees(rootPath: string): void {
  const root = assertCanonicalDirectory(rootPath, "dependency cleanup root");
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(compareNames)) {
      const absolute = join(directory, entry.name);
      if (entry.name.toLowerCase() === "node_modules") {
        rmSync(absolute, { recursive: true, force: true });
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(absolute);
      }
    }
  }
}

export function collectRegularTree(rootPath: string): Map<string, RegularTreeEntry> {
  const root = assertCanonicalDirectory(rootPath, "tree root");
  const entries = new Map<string, RegularTreeEntry>();
  const stack = [root];
  let totalBytes = 0;
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(compareNames)) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replace(/\\/g, "/");
      assertSafeRelativePath(path);
      if (path.split("/").length > MAX_DEPTH) throw new Error(`tree path exceeds depth limit: ${path}`);
      const stat = lstatSync(absolute);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw new Error(`tree contains a non-regular entry: ${path}`);
      }
      if (stat.size > MAX_SOURCE_FILE_BYTES) throw new Error(`tree file exceeds size limit: ${path}`);
      totalBytes += stat.size;
      if (entries.size + 1 > MAX_SOURCE_ENTRIES || totalBytes > MAX_SOURCE_BYTES) {
        throw new Error("tree exceeds entry or byte limit");
      }
      entries.set(path, {
        mode: (stat.mode & 0o111) === 0 ? 0o100644 : 0o100755,
        size: stat.size,
        digest: sha256(readFileSync(absolute)),
      });
    }
  }
  return entries;
}

export function regularTreeDigest(root: string): string {
  return regularTreeDigestExcluding(root, []);
}

/** Hash regular source bytes while excluding an exact, caller-owned path set. */
export function regularTreeDigestExcluding(
  root: string,
  excludedPaths: readonly string[]
): string {
  const excluded = new Set(excludedPaths);
  if (excluded.size !== excludedPaths.length) {
    throw new Error("tree digest exclusions contain duplicates");
  }
  for (const path of excluded) assertSafeRelativePath(path);
  const hash = createHash("sha256").update("api-migrator:regular-tree:v1\0");
  for (const [path, entry] of collectRegularTree(root)) {
    if (excluded.has(path)) continue;
    hashRecord(hash, [path, entry.mode, entry.size, entry.digest]);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function changedRegularPaths(baseRoot: string, candidateRoot: string): string[] {
  const base = collectRegularTree(baseRoot);
  const candidate = collectRegularTree(candidateRoot);
  return [...new Set([...base.keys(), ...candidate.keys()])]
    .filter((path) => !sameRegularEntry(base.get(path), candidate.get(path)))
    .sort();
}

export function assertRegularTreesEqual(
  expectedRoot: string,
  actualRoot: string,
  label: string
): void {
  const changed = changedRegularPaths(expectedRoot, actualRoot);
  if (changed.length > 0) {
    throw new Error(`${label} differs at ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", …" : ""}`);
  }
}

/** Hash an npm-created dependency tree, including bounded internal symlinks. */
export function dependencyTreeDigest(rootPath: string): string {
  const root = assertCanonicalDirectory(rootPath, "dependency tree root");
  const hash = createHash("sha256").update("api-migrator:dependency-tree:v1\0");
  const stack = [root];
  let entries = 0;
  let totalBytes = 0;
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(compareNames)) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replace(/\\/g, "/");
      assertSafeRelativePath(path);
      if (path.split("/").length > MAX_DEPTH) throw new Error(`dependency path exceeds depth limit: ${path}`);
      const stat = lstatSync(absolute);
      entries += 1;
      if (entries > MAX_DEPENDENCY_ENTRIES) throw new Error("dependency tree exceeds entry limit");
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        hashRecord(hash, ["directory", path, stat.mode & 0o777]);
        stack.push(absolute);
      } else if (entry.isFile() && !entry.isSymbolicLink() && stat.nlink === 1) {
        totalBytes += stat.size;
        if (stat.size > MAX_SOURCE_FILE_BYTES || totalBytes > MAX_DEPENDENCY_BYTES) {
          throw new Error(`dependency tree exceeds byte limit at ${path}`);
        }
        hashRecord(hash, ["file", path, stat.mode & 0o777, stat.size, sha256(readFileSync(absolute))]);
      } else if (entry.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        if (!target || isAbsolute(target) || target.includes("\0")) {
          throw new Error(`dependency symlink has an unsafe target: ${path}`);
        }
        const resolvedTarget = resolve(directory, target);
        if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) {
          throw new Error(`dependency symlink escapes its tree: ${path}`);
        }
        if (!existsSync(resolvedTarget)) throw new Error(`dependency symlink is dangling: ${path}`);
        hashRecord(hash, ["symlink", path, target]);
      } else {
        throw new Error(`dependency tree contains a special or linked file: ${path}`);
      }
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

export function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameRegularEntry(a: RegularTreeEntry | undefined, b: RegularTreeEntry | undefined): boolean {
  return a?.mode === b?.mode && a?.size === b?.size && a?.digest === b?.digest;
}

function assertSafeRelativePath(path: string): void {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    throw new Error("tree path is invalid");
  }
  if (path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`tree path is not normalized: ${path}`);
  }
}

function compareNames(a: { name: string }, b: { name: string }): number {
  return Buffer.compare(Buffer.from(a.name), Buffer.from(b.name));
}

function hashRecord(hash: ReturnType<typeof createHash>, value: unknown): void {
  const record = JSON.stringify(value);
  hash.update(String(Buffer.byteLength(record))).update(":").update(record);
}
