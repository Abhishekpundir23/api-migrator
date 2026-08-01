import { createRequire } from "node:module";
import { closeSync, constants, existsSync, fstatSync, openSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
const MAX_ENV_BYTES = 256 * 1024;

/** Validate every root env file Next may load before it receives any secrets. */
export function assertWorkspaceEnvFilesSecure(workspaceRoot, development) {
  const mode = process.env.NODE_ENV === "test" ? "test" : development ? "development" : "production";
  const names = [
    `.env.${mode}.local`,
    ...(mode === "test" ? [] : [".env.local"]),
    `.env.${mode}`,
    ".env",
  ];
  for (const name of names) {
    const file = join(workspaceRoot, name);
    if (!existsSync(file)) continue;
    let descriptor = null;
    try {
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = fstatSync(descriptor);
      if (!stats.isFile() || stats.size > MAX_ENV_BYTES) throw new Error("invalid env file");
      if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
        throw new Error("env file permissions are too broad");
      }
      if (
        process.platform !== "win32" &&
        typeof process.getuid === "function" &&
        stats.uid !== process.getuid()
      ) {
        throw new Error("env file has the wrong owner");
      }
    } catch {
      throw new Error("Workspace env files must be owner-only, regular, non-symlink files");
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }
}

/** Load the monorepo-root env even though Next is launched from this workspace. */
export function loadWorkspaceEnv(workspaceRoot) {
  const development = process.env.NODE_ENV !== "production";
  assertWorkspaceEnvFilesSecure(workspaceRoot, development);
  const loaded = loadEnvConfig(workspaceRoot, development, console, true);
  process.env.API_MIGRATOR_WORKSPACE_ROOT = workspaceRoot;
  return loaded;
}
