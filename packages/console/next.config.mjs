import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspaceEnv } from "./workspace-env.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadWorkspaceEnv(workspaceRoot);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages (@api-migrator/*) ship compiled dist/ JS now, so they're
  // consumed as normal packages — no transpilation needed here.
  serverExternalPackages: ["better-sqlite3"],
};
export default nextConfig;
