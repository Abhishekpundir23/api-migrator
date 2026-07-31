/**
 * Auth — resolves how the migrator authenticates to GitHub.
 *
 * Two modes, selected by environment variables:
 *
 *   1. GitHub App (production): set GH_APP_ID + GH_APP_PRIVATE_KEY (+
 *      optionally GH_APP_INSTALLATION_ID). An App installation authenticates
 *      as itself with scoped repo access, which is what customers trust.
 *      We mint a per-installation token via @octokit/auth-app.
 *
 *   2. gh CLI (pilot): when no App credentials are present, we use the token
 *      from the local `gh` CLI. Fine for demos and pilots on your own repos;
 *      NOT suitable for customer repos (no scoped trust boundary).
 *
 * The rest of the app asks `resolveAuth()` and gets back an AuthResult it can
 * embed in a clone URL and use to call the API. It never branches on "which
 * mode" itself — that decision lives here.
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { execSync } from "node:child_process";

export interface AppCredentials {
  appId: string;
  privateKey: string;
  /** A fixed installation id, or null to resolve per-repo. */
  installationId: number | null;
}

export interface AuthResult {
  /** A token suitable for embedding in a clone URL or REST Authorization. */
  token: string;
  /** The GitHub login this token acts as (for commit authoring). */
  actor: string;
  /** A REST client authenticated with this token. */
  octokit: Octokit;
  /** Which mode produced this auth — useful for logs/PR body footers. */
  mode: "github-app" | "gh-cli";
}

/** Read App credentials from env, or null if not configured. */
export function readAppCredentials(): AppCredentials | null {
  const appId = process.env.GH_APP_ID;
  const privateKey = process.env.GH_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  const installationId = process.env.GH_APP_INSTALLATION_ID
    ? Number(process.env.GH_APP_INSTALLATION_ID)
    : null;
  return { appId, privateKey, installationId };
}

export function isAppMode(): boolean {
  return readAppCredentials() !== null;
}

/**
 * Resolve auth for a given "owner/repo" slug.
 * - App mode: mint an installation token (resolving the installation id for the
 *   repo if one isn't fixed).
 * - gh mode: use the `gh` CLI's token.
 */
export async function resolveAuth(slug?: string): Promise<AuthResult> {
  const app = readAppCredentials();
  if (app) return appAuth(app, slug);
  return ghAuth();
}

// --- App mode ---------------------------------------------------------------

async function appAuth(app: AppCredentials, slug?: string): Promise<AuthResult> {
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: app.appId, privateKey: app.privateKey },
  });

  let installationId = app.installationId;
  if (installationId == null) {
    if (!slug) throw new Error("App mode without GH_APP_INSTALLATION_ID requires a repo slug");
    const { data } = await appOctokit.request("GET /repos/{owner}/{repo}/installation", {
      owner: slug.split("/")[0]!,
      repo: slug.split("/")[1]!,
    });
    installationId = data.id;
  }

  const { token } = await appOctokit.auth({
    type: "installation",
    installationId,
  } as any) as { token: string };

  const octokit = new Octokit({ auth: token });
  const { data: appInfo } = await appOctokit.request("GET /app");
  const appSlug = appInfo?.slug ?? "api-migrator";
  const actor = `${appSlug}[bot]`;

  return { token, actor, octokit, mode: "github-app" };
}

// --- gh CLI mode (pilot) ----------------------------------------------------

function ghAuth(): AuthResult {
  const token = execSync("gh auth token", { encoding: "utf8" }).trim();
  if (!token) throw new Error("No GitHub App env vars AND `gh auth token` returned empty");
  const octokit = new Octokit({ auth: token });
  // The gh user's login — resolved lazily by callers if needed; default here.
  return { token, actor: "api-migrator", octokit, mode: "gh-cli" };
}
