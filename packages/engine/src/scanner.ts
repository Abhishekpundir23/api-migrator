/**
 * Scanner — finds files in a repo that are likely to contain transformable
 * API usage.
 *
 * Matches on Inngest-SPECIFIC identifiers only. Generic patterns like `.send(`
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

const INNGEST_USAGE: RegExp[] = [
  /\bnew\s+Inngest\s*\(/, //     new Inngest(
  /\bcreateFunction\s*\(/, //    inngest.createFunction(
  /\bEventSchemas\b/, //         v3 schema helper
  /\breferenceFunction\b/, //    v4 helper
  /\bInngestFunction\b/, //      internal helper
  /from\s+["']@?inngest/, //     direct import
  /require\(\s*["']@?inngest/, // require import
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

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

/**
 * Walk `root` and return all source files that look like they use the Inngest SDK.
 * Single source of truth — the diagnostic tool and the driver both call this.
 */
export function findInngestFiles(root: string, opts: ScanOptions = {}): ScannedFile[] {
  const skip = opts.skip ?? DEFAULT_SKIP;
  const out: ScannedFile[] = [];
  const stack: string[] = [root];

  while (stack.length) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        let text: string;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (INNGEST_USAGE.some((re) => re.test(text))) {
          out.push({ absolute: full, relative: relative(root, full) });
        }
      }
    }
  }

  return out.sort((a, b) => a.relative.localeCompare(b.relative));
}

/** True if a path is a directory. */
export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
