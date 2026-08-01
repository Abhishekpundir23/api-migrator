/** Load the first .env found while walking upward from the current directory. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function loadEnv(path?: string): string | null {
  const files = path ? [path] : candidatePaths();
  for (const file of files) {
    if (!existsSync(file)) continue;
    applyFile(file);
    process.env.API_MIGRATOR_WORKSPACE_ROOT = dirname(file);
    return file;
  }
  return null;
}

function candidatePaths(): string[] {
  const files: string[] = [];
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth++) {
    files.push(join(directory, ".env"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return files;
}

function applyFile(file: string): void {
  const text = readFileSync(file, "utf8");
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\n\r]*))\r?$/gm;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(text)) !== null) {
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    process.env[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
}
