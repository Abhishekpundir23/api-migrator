/** GitHub authentication with explicit, fail-closed mode selection. */

import {
  createAppAuth,
  type InstallationAccessTokenAuthentication,
  type InstallationAuthOptions,
} from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRepositorySlug } from "./repository.js";
import { safeErrorMessage } from "./security.js";

export type AuthMode = "github-app" | "gh-cli";
export type AuthCapability = "read" | "write";

export const REQUIRED_GITHUB_APP_PERMISSIONS = Object.freeze({
  contents: "write",
  metadata: "read",
  pull_requests: "write",
} as const);

const READ_TOKEN_PERMISSIONS = Object.freeze({
  contents: "read",
  metadata: "read",
} as const);

const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_INSTALLATION_TOKEN_LIFETIME_MS = 65 * 60 * 1_000;
const TOKEN_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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
      throw new Error(
        "github-app auth requires GH_APP_ID and exactly one of GH_APP_PRIVATE_KEY or GH_APP_PRIVATE_KEY_PATH"
      );
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
  const inlinePrivateKey = env.GH_APP_PRIVATE_KEY;
  const privateKeyPath = env.GH_APP_PRIVATE_KEY_PATH;
  const rawInstallationId = env.GH_APP_INSTALLATION_ID;
  const installationIdPresent = rawInstallationId !== undefined && rawInstallationId.trim().length > 0;
  const privateKeyPathPresent = privateKeyPath !== undefined && privateKeyPath.length > 0;
  const anyPresent =
    appId !== undefined || inlinePrivateKey !== undefined || privateKeyPathPresent || installationIdPresent;
  if (!anyPresent) return null;

  if (!appId || (!inlinePrivateKey && !privateKeyPathPresent)) {
    throw new Error(
      "Partial GitHub App configuration: GH_APP_ID and exactly one private-key source are required"
    );
  }
  if (inlinePrivateKey && privateKeyPathPresent) {
    throw new Error("GH_APP_PRIVATE_KEY and GH_APP_PRIVATE_KEY_PATH are mutually exclusive");
  }
  if (!/^[1-9]\d*$/.test(appId)) throw new Error("GH_APP_ID must be a positive integer");
  if (!Number.isSafeInteger(Number(appId))) {
    throw new Error("GH_APP_ID is outside the supported range");
  }

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
    privateKey: inlinePrivateKey
      ? validatePrivateKey(inlinePrivateKey.replace(/\\n/g, "\n"))
      : readPrivateKeyFile(privateKeyPath!),
    installationId,
  };
}

function readPrivateKeyFile(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error("GH_APP_PRIVATE_KEY_PATH must be an absolute path");
  }

  let descriptor: number | null = null;
  try {
    const canonicalPath = realpathSync.native(path);
    const canonicalWorkspace = realpathSync.native(WORKSPACE_ROOT);
    const workspaceRelativePath = relative(canonicalWorkspace, canonicalPath);
    if (
      workspaceRelativePath === "" ||
      (workspaceRelativePath !== ".." &&
        !workspaceRelativePath.startsWith(`..${sep}`) &&
        !isAbsolute(workspaceRelativePath))
    ) {
      throw new Error("private-key file is inside the workspace");
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PRIVATE_KEY_BYTES) {
      throw new Error("invalid private-key file");
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error("private-key file permissions are too broad");
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw new Error("private-key file is not owned by the current user");
    }
    return validatePrivateKey(readFileSync(descriptor, "utf8"));
  } catch {
    throw new Error(
      "GH_APP_PRIVATE_KEY_PATH must reference an owner-only, regular RSA private-key file outside the workspace"
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function validatePrivateKey(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_PRIVATE_KEY_BYTES) {
    throw new Error("GH_APP_PRIVATE_KEY exceeds the supported size");
  }
  try {
    const key = createPrivateKey(value);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error("unsupported private key");
    }
  } catch {
    throw new Error("GH_APP_PRIVATE_KEY must contain a valid RSA private key of at least 2048 bits");
  }
  return value;
}

export function isAppMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return readAuthConfig(env).mode === "github-app";
}

export async function resolveAuth(slug: string, capability: AuthCapability): Promise<AuthResult> {
  const repository = parseRepositorySlug(slug);
  const config = readAuthConfig();
  return resolveAuthConfig(config, repository, capability);
}

/** Resolve auth only when the operator explicitly configured a mode. */
export async function resolveOptionalAuth(
  slug: string,
  capability: AuthCapability
): Promise<AuthResult | null> {
  const repository = parseRepositorySlug(slug);
  const config = readOptionalAuthConfig();
  if (!config) return null;
  return resolveAuthConfig(config, repository, capability);
}

function resolveAuthConfig(
  config: AuthConfig,
  repository: ReturnType<typeof parseRepositorySlug>,
  capability: AuthCapability
): Promise<AuthResult> | AuthResult {
  return config.mode === "github-app" ? appAuth(config.app, repository, capability) : ghAuth();
}

async function appAuth(
  app: AppCredentials,
  repository: ReturnType<typeof parseRepositorySlug>,
  capability: AuthCapability
): Promise<AuthResult> {
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: app.appId, privateKey: app.privateKey },
  });
  let issuedToken: string | null = null;

  try {
    const { data: appInfo } = await appOctokit.request("GET /app");
    if (!appInfo) throw new Error("GitHub did not return App metadata");
    assertGitHubAppPolicy(appInfo, Number(app.appId));

    const { data: installation } = await appOctokit.request(
      "GET /repos/{owner}/{repo}/installation",
      {
        owner: repository.owner,
        repo: repository.repo,
      }
    );
    assertGitHubInstallationPolicy(installation);
    assertConfiguredInstallationId(app.installationId, installation.id);

    const tokenPermissions =
      capability === "write" ? REQUIRED_GITHUB_APP_PERMISSIONS : READ_TOKEN_PERMISSIONS;
    const installationAuth = (await appOctokit.auth(
      githubInstallationTokenOptions(installation.id, repository.repo, capability) as never
    )) as InstallationAccessTokenAuthentication;
    if (!installationAuth.token) throw new Error("GitHub App returned an empty installation token");
    issuedToken = installationAuth.token;
    assertGitHubInstallationTokenPolicy(
      installationAuth,
      installation.id,
      repository.repo,
      tokenPermissions
    );

    const octokit = new Octokit({ auth: installationAuth.token });
    const { data: repositoryInfo } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: repository.owner,
      repo: repository.repo,
    });
    if (
      repositoryInfo.full_name.toLowerCase() !== repository.slug.toLowerCase() ||
      installationAuth.repositoryIds?.length !== 1 ||
      installationAuth.repositoryIds[0] !== repositoryInfo.id
    ) {
      throw new Error("GitHub installation token is not bound to the requested repository identity");
    }

    const actor = `${appInfo.slug!}[bot]`;
    return { token: installationAuth.token, actor, octokit, mode: "github-app" };
  } catch (error) {
    if (issuedToken) await revokeInstallationToken(issuedToken);
    throw new Error(
      `GitHub App authentication failed: ${safeErrorMessage(error, [app.privateKey, issuedToken ?? ""])}`
    );
  }
}

type PermissionPolicy = Readonly<Record<string, string>>;

export function githubInstallationTokenOptions(
  installationId: number,
  repositoryName: string,
  capability: AuthCapability
): InstallationAuthOptions {
  if (!Number.isSafeInteger(installationId) || installationId <= 0 || repositoryName.length === 0) {
    throw new Error("Cannot create a token for an invalid GitHub installation or repository");
  }
  const permissions =
    capability === "write" ? REQUIRED_GITHUB_APP_PERMISSIONS : READ_TOKEN_PERMISSIONS;
  return {
    type: "installation",
    installationId,
    repositoryNames: [repositoryName],
    permissions: { ...permissions },
  };
}

export function assertConfiguredInstallationId(
  configuredInstallationId: number | null,
  resolvedInstallationId: number
): void {
  if (
    !Number.isSafeInteger(resolvedInstallationId) ||
    resolvedInstallationId <= 0 ||
    (configuredInstallationId !== null && configuredInstallationId !== resolvedInstallationId)
  ) {
    throw new Error("Configured GitHub App installation does not own the requested repository");
  }
}

export function assertGitHubAppPolicy(
  appInfo: { id?: unknown; slug?: unknown; permissions?: unknown; events?: unknown },
  expectedAppId: number
): void {
  if (appInfo.id !== expectedAppId || typeof appInfo.slug !== "string" || appInfo.slug.length === 0) {
    throw new Error("GitHub App identity does not match the configured App ID");
  }
  assertExactPermissions(appInfo.permissions, REQUIRED_GITHUB_APP_PERMISSIONS, "GitHub App");
  assertNoEvents(appInfo.events, "GitHub App");
}

export function assertGitHubInstallationPolicy(installation: {
  repository_selection?: unknown;
  permissions?: unknown;
  events?: unknown;
  suspended_at?: unknown;
}): void {
  if (installation.repository_selection !== "selected") {
    throw new Error("GitHub App installation must be restricted to selected repositories");
  }
  if (installation.suspended_at !== null) {
    throw new Error("GitHub App installation is suspended or has an invalid suspension state");
  }
  assertExactPermissions(
    installation.permissions,
    REQUIRED_GITHUB_APP_PERMISSIONS,
    "GitHub App installation"
  );
  assertNoEvents(installation.events, "GitHub App installation");
}

export function assertGitHubInstallationTokenPolicy(
  authentication: Pick<
    InstallationAccessTokenAuthentication,
    | "type"
    | "tokenType"
    | "installationId"
    | "createdAt"
    | "expiresAt"
    | "permissions"
    | "repositorySelection"
    | "repositoryIds"
    | "repositoryNames"
  >,
  expectedInstallationId: number,
  expectedRepositoryName: string,
  expectedPermissions: PermissionPolicy
): void {
  if (authentication.type !== "token" || authentication.tokenType !== "installation") {
    throw new Error("GitHub returned an unexpected authentication type");
  }
  if (
    !Number.isSafeInteger(expectedInstallationId) ||
    expectedInstallationId <= 0 ||
    authentication.installationId !== expectedInstallationId
  ) {
    throw new Error("GitHub returned a token for an unexpected installation identity");
  }
  const createdAt = Date.parse(authentication.createdAt);
  const expiresAt = Date.parse(authentication.expiresAt);
  const now = Date.now();
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    createdAt > now + TOKEN_CLOCK_SKEW_MS ||
    expiresAt <= now ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > MAX_INSTALLATION_TOKEN_LIFETIME_MS
  ) {
    throw new Error("GitHub installation token has an invalid lifetime");
  }
  if (authentication.repositorySelection !== "selected") {
    throw new Error("GitHub installation token is not repository-scoped");
  }
  if (
    authentication.repositoryNames?.length !== 1 ||
    authentication.repositoryNames[0]?.toLowerCase() !== expectedRepositoryName.toLowerCase() ||
    authentication.repositoryIds?.length !== 1 ||
    !Number.isSafeInteger(authentication.repositoryIds[0]) ||
    authentication.repositoryIds[0]! <= 0
  ) {
    throw new Error("GitHub installation token does not select exactly the requested repository");
  }
  assertExactPermissions(authentication.permissions, expectedPermissions, "GitHub installation token");
}

async function revokeInstallationToken(token: string): Promise<void> {
  try {
    await new Octokit({ auth: token }).request("DELETE /installation/token");
  } catch {
    // The token may already be invalid or revoked; never mask the original
    // policy failure with best-effort credential cleanup.
  }
}

function assertExactPermissions(
  actual: unknown,
  expected: PermissionPolicy,
  context: string
): void {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    throw new Error(`${context} permissions are unavailable`);
  }
  const actualEntries = Object.entries(actual as Record<string, unknown>)
    .filter(([, value]) => value !== "none")
    .sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some(
      ([key, value], index) =>
        key !== expectedEntries[index]?.[0] || value !== expectedEntries[index]?.[1]
    )
  ) {
    throw new Error(`${context} permissions exceed or differ from the required least-privilege policy`);
  }
}

function assertNoEvents(events: unknown, context: string): void {
  if (!Array.isArray(events) || events.length !== 0) {
    throw new Error(`${context} must not subscribe to webhook events`);
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
