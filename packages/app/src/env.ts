/**
 * Minimal .env loader — no dependency. Parses a .env file and populates
 * process.env for any keys not already set (real env vars win over the file).
 *
 * Next.js loads .env natively, so the console doesn't need this; the CLIs do.
 * The implicit file is anchored to this trusted workspace, never discovered by
 * walking through ambient parent directories.
 */

import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ENV_BYTES = 256 * 1024;
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function loadEnv(path?: string): void {
  if (path !== undefined && !isAbsolute(path)) {
    throw new Error("Explicit .env path must be absolute");
  }
  const files = path ? [path] : [join(WORKSPACE_ROOT, ".env")];
  for (const f of files) {
    if (!existsSync(f)) continue;
    applyFile(f);
    process.env.API_MIGRATOR_WORKSPACE_ROOT = dirname(f);
    return;
  }
}

function applyFile(file: string): void {
  let descriptor: number | null = null;
  let text: string;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_ENV_BYTES) {
      throw new Error("invalid .env file");
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error(".env permissions are too broad");
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw new Error(".env is not owned by the current user");
    }
    text = readFileSync(descriptor, "utf8");
  } catch {
    throw new Error(".env must be an owner-only, regular file within the trusted workspace");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }

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
