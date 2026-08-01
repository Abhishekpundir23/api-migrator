/**
 * Scanner — finds files in a repo that are likely to contain transformable
 * API usage.
 *
 * Matches on PROVIDER-SPECIFIC identifiers only. Generic patterns like `.send(`
 * or `serve(` would false-positive on every Express/Next route handler
 * (`res.send(...)`, etc.) and make the tool look unreliable.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const DEFAULT_SKIP = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  ".turbo",
  "coverage",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".cts", ".mts", ".cjs", ".mjs",
]);

/** Usage patterns per provider, selected by the manifest's transformSet. */
const USAGE_PATTERNS: Record<string, RegExp[]> = {
  "inngest-v3-to-v4": [
    /(?:from\s+|require\(\s*|import\(\s*)["'](?:inngest(?:\/[^"']*)?|@inngest\/[^"']+)["']/,
    /\b[A-Za-z_$][\w$]*\.createFunction\s*\(/,
  ],
  "knock-v0-to-v1": [
    /(?:from\s+|require\(\s*|import\(\s*)["']@knocklabs\/node(?:\/[^"']*)?["']/,
    // Configured clients are commonly re-exported from a local wrapper. The
    // transform does not rewrite these without provenance; it emits a review
    // blocker when the receiver resolves to a local import.
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:notify|identify|list|setPreferences|getPreferences|addChannelData|setChannelData)\s*\(/,
  ],
};

export interface ScanOptions {
  /** Directory names to skip. Defaults to node_modules/.git/etc. */
  skip?: Set<string>;
}

export interface ScannedFile {
  /** Absolute path to the file. */
  absolute: string;
  /** Path relative to the scan root. */
  relative: string;
}

export class SourceScanError extends Error {
  override name = "SourceScanError";
}

/** Walk the repository once and return every supported regular source file. */
export function findSourceFiles(root: string, opts: ScanOptions = {}): ScannedFile[] {
  const skip = opts.skip ?? DEFAULT_SKIP;
  const out: ScannedFile[] = [];
  const stack: string[] = [root];

  while (stack.length) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch (error) {
      throw new SourceScanError(`Unable to enumerate source directory ${cur}: ${errorMessage(error)}`);
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        out.push({ absolute: full, relative: relative(root, full) });
      } else if (entry.isSymbolicLink() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        throw new SourceScanError(
          `Source-like symbolic link is unsupported: ${relative(root, full)}`
        );
      }
    }
  }

  return out.sort((a, b) => a.relative.localeCompare(b.relative));
}

/** Select provider-relevant files from an already enumerated source inventory. */
export function selectSdkFiles(files: readonly ScannedFile[], transformSet: string): ScannedFile[] {
  const patterns = USAGE_PATTERNS[transformSet] ?? [];
  const out: ScannedFile[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file.absolute, "utf8");
    } catch (error) {
      throw new SourceScanError(`Unable to read source file ${file.relative}: ${errorMessage(error)}`);
    }
    if (patterns.some((pattern) => pattern.test(text))) out.push(file);
  }
  return out;
}

/**
 * Walk `root` and return all source files that look like they use a given SDK.
 * `transformSet` selects the provider-specific usage patterns to match.
 */
export function findSdkFiles(root: string, transformSet: string, opts: ScanOptions = {}): ScannedFile[] {
  return selectSdkFiles(findSourceFiles(root, opts), transformSet);
}

/**
 * Back-compat: Inngest-specific scan. Equivalent to findSdkFiles(root, "inngest-v3-to-v4").
 * Kept so existing callers (CLI, gate) compile; prefer findSdkFiles.
 */
export function findInngestFiles(root: string, opts: ScanOptions = {}): ScannedFile[] {
  return findSdkFiles(root, "inngest-v3-to-v4", opts);
}

/** True if a path is a directory. */
export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
