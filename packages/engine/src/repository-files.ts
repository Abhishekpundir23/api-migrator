/** Symlink-safe, bounded reads of repository-controlled metadata. */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
export const MAX_ROOT_LOCKFILE_BYTES = 32 * 1024 * 1024;
export const MAX_COMPILER_ENTRY_BYTES = 1024 * 1024;

export interface RepositoryFilePolicy {
  label: string;
  maxBytes: number;
}

export interface ValidatedRepositoryFile {
  absolute: string;
  relative: string;
  size: number;
}

export class RepositoryFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryFileError";
  }
}

/** Validate an existing repository file without following a final symlink. */
export function validateRepositoryFile(
  root: string,
  path: string,
  policy: RepositoryFilePolicy,
  optional = false
): ValidatedRepositoryFile | null {
  const normalized = normalizeRepositoryPath(path, policy.label);
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, normalized);
  if (!isInside(absoluteRoot, absolute)) {
    throw new RepositoryFileError(`${policy.label} escapes the repository: ${normalized}`);
  }

  const stat = lstatIfExists(absolute);
  if (!stat) {
    if (optional) return null;
    throw new RepositoryFileError(`${policy.label} is missing: ${normalized}`);
  }
  if (stat.isSymbolicLink()) {
    throw new RepositoryFileError(`${policy.label} must not be a symlink: ${normalized}`);
  }
  if (!stat.isFile()) {
    throw new RepositoryFileError(`${policy.label} must be a regular file: ${normalized}`);
  }
  assertBounded(stat.size, normalized, policy);

  const realRoot = realpathSync(absoluteRoot);
  const realFile = realpathSync(absolute);
  if (!isInside(realRoot, realFile)) {
    throw new RepositoryFileError(`${policy.label} resolves outside the repository: ${normalized}`);
  }
  return { absolute, relative: normalized, size: stat.size };
}

/** Validate and read exact bytes, guarding against a final-path replacement race. */
export function readRepositoryFile(
  root: string,
  path: string,
  policy: RepositoryFilePolicy
): Buffer {
  const validated = validateRepositoryFile(root, path, policy);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      validated!.absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new RepositoryFileError(`${policy.label} must remain a regular file: ${validated!.relative}`);
    }
    assertBounded(opened.size, validated!.relative, policy);
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) {
        throw new RepositoryFileError(`${policy.label} changed while being read: ${validated!.relative}`);
      }
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, null) !== 0) {
      throw new RepositoryFileError(`${policy.label} changed or exceeded its size limit: ${validated!.relative}`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof RepositoryFileError) throw error;
    throw new RepositoryFileError(
      `Could not safely read ${policy.label} ${validated!.relative}: ${(error as Error).message}`
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readRepositoryText(
  root: string,
  path: string,
  policy: RepositoryFilePolicy
): string {
  return readRepositoryFile(root, path, policy).toString("utf8");
}

function normalizeRepositoryPath(path: string, label: string): string {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0")) {
    throw new RepositoryFileError(`Invalid ${label} path`);
  }
  const normalized = path.replace(/\\/g, "/");
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new RepositoryFileError(`Invalid ${label} path: ${path}`);
  }
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function assertBounded(size: number, path: string, policy: RepositoryFilePolicy): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > policy.maxBytes) {
    throw new RepositoryFileError(`${policy.label} exceeds ${policy.maxBytes} bytes: ${path}`);
  }
}

function lstatIfExists(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
