/** Exact, symlink-safe transfer of a verified migration artifact. */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Stats } from "node:fs";

interface TreeEntry {
  type: "file" | "symlink";
  /** Canonical Git index mode; host owner/group permission bits are not identity. */
  mode: number;
  digest: string;
}

export interface VerifiedArtifact {
  files: string[];
  digest: string;
}

/** Copy source without Git metadata or installed dependencies. */
export function copyGitFreeTree(sourceRoot: string, targetRoot: string): void {
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const path = relative(sourceRoot, source);
      if (!path) return true;
      const parts = path.split(/[\\/]/);
      return !parts.includes(".git") && !parts.includes("node_modules");
    },
  });
  if (lstatIfExists(join(targetRoot, ".git"))) throw new Error("Verification tree unexpectedly contains .git metadata");
}

/** Ensure report.changedFiles is the complete tree delta and hash exact bytes/modes. */
export function inspectVerifiedArtifact(
  baseRoot: string,
  proposedRoot: string,
  reportedFiles: readonly string[]
): VerifiedArtifact {
  const files = [...new Set(reportedFiles.map(normalizeArtifactPath))].sort();
  const base = collectTree(baseRoot);
  const proposed = collectTree(proposedRoot);
  const actual = [...new Set([...base.keys(), ...proposed.keys()])]
    .filter((path) => !sameEntry(base.get(path), proposed.get(path)))
    .sort();
  if (actual.join("\0") !== files.join("\0")) {
    const unexpected = actual.filter((path) => !files.includes(path));
    const missing = files.filter((path) => !actual.includes(path));
    throw new Error(
      `Verified tree differs from engine report` +
      `${unexpected.length ? `; unexpected: ${unexpected.join(", ")}` : ""}` +
      `${missing.length ? `; missing: ${missing.join(", ")}` : ""}`
    );
  }

  const hash = createHash("sha256").update("api-migrator-artifact-v1\0");
  for (const path of files) {
    assertRegularArtifactEntry(baseRoot, path, base.get(path), true);
    assertRegularArtifactEntry(proposedRoot, path, proposed.get(path), true);
    hash.update(path).update("\0");
    hash.update(entryIdentity(base.get(path))).update("\0");
    hash.update(entryIdentity(proposed.get(path))).update("\0");
  }
  return { files, digest: hash.digest("hex") };
}

/** Apply only inspected files into the untouched Git clone. */
export function applyVerifiedArtifact(
  destinationRoot: string,
  proposedRoot: string,
  artifact: VerifiedArtifact
): void {
  for (const path of artifact.files) {
    const normalized = normalizeArtifactPath(path);
    const source = inside(proposedRoot, normalized);
    const destination = inside(destinationRoot, normalized);
    assertNoSymlinkComponents(proposedRoot, normalized);
    assertNoSymlinkComponents(destinationRoot, normalized);

    const sourceStat = lstatIfExists(source);
    const destinationStat = lstatIfExists(destination);
    if (!sourceStat) {
      if (destinationStat) {
        const target = destinationStat;
        if (!target.isFile() || target.isSymbolicLink()) throw new Error(`Refusing to delete non-regular artifact path: ${normalized}`);
        unlinkSync(destination);
      }
      continue;
    }

    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Refusing to publish non-regular artifact path: ${normalized}`);
    }
    if (destinationStat) {
      if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
        throw new Error(`Refusing to overwrite non-regular artifact path: ${normalized}`);
      }
    } else {
      mkdirSync(dirname(destination), { recursive: true });
      assertNoSymlinkComponents(destinationRoot, normalized);
    }
    copyFileSync(source, destination);
    chmodSync(destination, sourceStat.mode & 0o777);
  }
}

/** Confirm the clean clone now contains exactly the proposed bytes for each artifact path. */
export function assertAppliedArtifact(
  destinationRoot: string,
  proposedRoot: string,
  artifact: VerifiedArtifact
): void {
  for (const path of artifact.files) {
    assertNoSymlinkComponents(destinationRoot, path);
    assertNoSymlinkComponents(proposedRoot, path);
    const destination = treeEntry(destinationRoot, path);
    const proposed = treeEntry(proposedRoot, path);
    if (!sameEntry(destination, proposed)) throw new Error(`Published artifact differs from verified bytes: ${path}`);
  }
}

export function normalizeArtifactPath(value: string): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) {
    throw new Error(`Invalid artifact path: ${JSON.stringify(value)}`);
  }
  const normalized = value.split("/").filter((part) => part !== ".").join("/");
  if (value !== normalized || !normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "..")) {
    throw new Error(`Invalid artifact path: ${JSON.stringify(value)}`);
  }
  if (normalized === ".git" || normalized.startsWith(".git/")
    || normalized === "node_modules" || normalized.startsWith("node_modules/")) {
    throw new Error(`Forbidden artifact path: ${normalized}`);
  }
  return normalized;
}

function collectTree(root: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // Installed dependency trees are intentionally excluded. Everything
      // else, including test/build artifacts, must match the engine report.
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replace(/\\/g, "/");
      const stat = lstatSync(absolute);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isSymbolicLink()) {
        out.set(path, {
          type: "symlink",
          mode: 0o120000,
          digest: createHash("sha256").update(readlinkSync(absolute)).digest("hex"),
        });
      } else if (entry.isFile()) {
        out.set(path, {
          type: "file",
          mode: canonicalGitFileMode(stat.mode),
          digest: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
        });
      }
    }
  }
  return out;
}

function assertRegularArtifactEntry(root: string, path: string, entry: TreeEntry | undefined, allowMissing: boolean): void {
  assertNoSymlinkComponents(root, path);
  if (!entry && allowMissing) return;
  if (!entry || entry.type !== "file") throw new Error(`Artifact path is not a regular file: ${path}`);
}

function assertNoSymlinkComponents(root: string, path: string): void {
  let current = resolve(root);
  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = lstatIfExists(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`Artifact path traverses a symlink: ${path}`);
  }
}

function inside(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, path);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Artifact path escapes root: ${path}`);
  }
  return absolute;
}

function sameEntry(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  return a?.type === b?.type && a?.mode === b?.mode && a?.digest === b?.digest;
}

function entryIdentity(entry: TreeEntry | undefined): string {
  return entry ? `${entry.type}:${entry.mode}:${entry.digest}` : "missing";
}

function treeEntry(root: string, path: string): TreeEntry | undefined {
  const absolute = inside(root, path);
  const stat = lstatIfExists(absolute);
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) {
    return { type: "symlink", mode: 0o120000, digest: createHash("sha256").update(readlinkSync(absolute)).digest("hex") };
  }
  if (!stat.isFile()) throw new Error(`Artifact path is not a regular file: ${path}`);
  return { type: "file", mode: canonicalGitFileMode(stat.mode), digest: createHash("sha256").update(readFileSync(absolute)).digest("hex") };
}

function canonicalGitFileMode(mode: number): number {
  return (mode & 0o111) === 0 ? 0o100644 : 0o100755;
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path) as Stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
