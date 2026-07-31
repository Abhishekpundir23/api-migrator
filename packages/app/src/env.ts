/**
 * Minimal .env loader — no dependency. Parses a .env file and populates
 * process.env for any keys not already set (real env vars win over the file).
 *
 * Next.js loads .env natively, so the console doesn't need this; the CLIs do.
 * Searches upward from cwd for a .env so it works from any package dir.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export function loadEnv(path?: string): void {
  const files = path ? [path] : candidatePaths();
  for (const f of files) {
    if (!existsSync(f)) continue;
    applyFile(f);
    return;
  }
}

function candidatePaths(): string[] {
  // Walk up from cwd looking for a .env (covers running from a package dir).
  const out: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    out.push(join(dir, ".env"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function applyFile(file: string): void {
  const text = readFileSync(file, "utf8");
  // A key's value may span multiple lines if quoted (e.g. an embedded PEM).
  // Walk the text matching `KEY="..."` / `KEY='...'` / `KEY=value` blocks.
  const re = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\n\r]*))\r?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = m[1]!;
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}
