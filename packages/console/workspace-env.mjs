import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

/** Load the monorepo-root env even though Next is launched from this workspace. */
export function loadWorkspaceEnv(workspaceRoot) {
  const development = process.env.NODE_ENV !== "production";
  const loaded = loadEnvConfig(workspaceRoot, development, console, true);
  process.env.API_MIGRATOR_WORKSPACE_ROOT = workspaceRoot;
  return loaded;
}
