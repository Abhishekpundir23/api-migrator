/** GitHub authentication with explicit, fail-closed mode selection. */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { execFileSync } from "node:child_process";
import { parseRepositorySlug } from "./repository.js";
import { safeErrorMessage } from "./security.js";

export type AuthMode = "github-app" | "gh-cli";

export interface AppCredentials {
  appId: string;
  privateKey: string;
  /** A fixed installation id, or null to resolve per-repo. */
  installationId: number | null;
}

export type AuthConfig =
  | { mode: "github-app"; app: AppCredentials }
  | { mode: "gh-cli" };

export interface AuthResult {
  /** Short-lived credential used only in child env/API auth; never URL/argv. */
  token: string;
  actor: string;
  octokit: Octokit;
  mode: AuthMode;
}

/**
 * Resolve configuration without touching GitHub. Mode is always explicit;
 * partial App configuration and production gh auth are rejected.
 */
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const rawMode = env.API_MIGRATOR_AUTH_MODE;
  if (rawMode !== "github-app" && rawMode !== "gh-cli") {
    throw new Error("Set API_MIGRATOR_AUTH_MODE to github-app or gh-cli");
  }

  const app = readAppCredentials(env);
  if (rawMode === "github-app") {
    if (!app) {
      throw new Error("github-app auth requires GH_APP_ID and GH_APP_PRIVATE_KEY");
    }
    return { mode: "github-app", app };
  }

  if (app) {
    throw new Error("gh-cli auth cannot be combined with GitHub App credentials");
  }
  if (env.NODE_ENV === "production") {
    throw new Error("gh-cli auth is disabled in production; configure github-app auth");
  }
  return { mode: "gh-cli" };
}

/**
 * Return explicitly selected authentication, or null when no mode was
 * configured. This never guesses gh-cli merely because it is installed.
 */
export function readOptionalAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | null {
  if (env.API_MIGRATOR_AUTH_MODE === undefined) return null;
  return readAuthConfig(env);
}

/** Read and validate App credentials, or null when none are present. */
export function readAppCredentials(env: NodeJS.ProcessEnv = process.env): AppCredentials | null {
  const appId = env.GH_APP_ID;
  const privateKey = env.GH_APP_PRIVATE_KEY;
  const rawInstallationId = env.GH_APP_INSTALLATION_ID;
  const installationIdPresent = rawInstallationId !== undefined && rawInstallationId.trim().length > 0;
  const anyPresent = appId !== undefined || privateKey !== undefined || installationIdPresent;
  if (!anyPresent) return null;

  if (!appId || !privateKey) {
    throw new Error("Partial GitHub App configuration: both GH_APP_ID and GH_APP_PRIVATE_KEY are required");
  }
  if (!/^[1-9]\d*$/.test(appId)) throw new Error("GH_APP_ID must be a positive integer");

  let installationId: number | null = null;
  if (installationIdPresent) {
    if (!/^[1-9]\d*$/.test(rawInstallationId)) {
      throw new Error("GH_APP_INSTALLATION_ID must be a positive integer");
    }
    installationId = Number(rawInstallationId);
    if (!Number.isSafeInteger(installationId)) {
      throw new Error("GH_APP_INSTALLATION_ID is outside the supported range");
    }
  }

  return {
    appId,
    privateKey: privateKey.replace(/\\n/g, "\n"),
    installationId,
  };
}

export function isAppMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return readAuthConfig(env).mode === "github-app";
}

export async function resolveAuth(slug: string): Promise<AuthResult> {
  const repository = parseRepositorySlug(slug);
  const config = readAuthConfig();
  return resolveAuthConfig(config, repository);
}

/** Resolve auth only when the operator explicitly configured a mode. */
export async function resolveOptionalAuth(slug: string): Promise<AuthResult | null> {
  const repository = parseRepositorySlug(slug);
  const config = readOptionalAuthConfig();
  if (!config) return null;
  return resolveAuthConfig(config, repository);
}

function resolveAuthConfig(
  config: AuthConfig,
  repository: ReturnType<typeof parseRepositorySlug>
): Promise<AuthResult> | AuthResult {
  return config.mode === "github-app" ? appAuth(config.app, repository) : ghAuth();
}

async function appAuth(
  app: AppCredentials,
  repository: ReturnType<typeof parseRepositorySlug>
): Promise<AuthResult> {
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: app.appId, privateKey: app.privateKey },
  });

  try {
    let installationId = app.installationId;
    if (installationId == null) {
      const { data } = await appOctokit.request("GET /repos/{owner}/{repo}/installation", {
        owner: repository.owner,
        repo: repository.repo,
      });
      installationId = data.id;
    }

    const installationAuth = (await appOctokit.auth({
      type: "installation",
      installationId,
    } as never)) as { token: string };
    if (!installationAuth.token) throw new Error("GitHub App returned an empty installation token");

    const octokit = new Octokit({ auth: installationAuth.token });
    const { data: appInfo } = await appOctokit.request("GET /app");
    const actor = `${appInfo?.slug ?? "api-migrator"}[bot]`;
    return { token: installationAuth.token, actor, octokit, mode: "github-app" };
  } catch (error) {
    throw new Error(`GitHub App authentication failed: ${safeErrorMessage(error, [app.privateKey])}`);
  }
}

function ghAuth(): AuthResult {
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!token) throw new Error("gh auth token returned empty");
    return {
      token,
      actor: "api-migrator",
      octokit: new Octokit({ auth: token }),
      mode: "gh-cli",
    };
  } catch (error) {
    throw new Error(`gh-cli authentication failed: ${safeErrorMessage(error)}`);
  }
}
