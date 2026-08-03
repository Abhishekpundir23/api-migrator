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
import { consumeOwnerAuthorization } from "@api-migrator/db";
import {
  assertConsumedOwnerGrant,
  assertCurrentConsumedOwnerGrant,
  assertCurrentOwnerGrant,
  markGrantConsumed,
  ownerAuthorizationConsumption,
  ownerAuthorizationReceipt,
  type ExpectedOwnerAuthorizationBindings,
  type OwnerAuthorizationGrant,
  type OwnerAuthorizationReceipt,
} from "./owner-authorization.js";
import { parseRepositorySlug } from "./repository.js";
import { safeErrorMessage } from "./security.js";

export type AuthMode = "github-app" | "gh-cli";
type AuthCapability = "read" | "write";

export const REQUIRED_GITHUB_APP_PERMISSIONS = Object.freeze({
  contents: "write",
  metadata: "read",
  pull_requests: "write",
} as const);

const READ_TOKEN_PERMISSIONS = Object.freeze({
  contents: "read",
  metadata: "read",
  pull_requests: "read",
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
  capability: AuthCapability;
  /** Exact App, installation, repository, and owner identities observed from GitHub. */
  githubApp: GitHubAppAuthIdentity | null;
}

export interface GitHubAppAuthIdentity {
  appId: number;
  appSlug: string;
  installationId: number;
  repositoryId: number;
  repositoryOwnerId: number;
  repositorySlug: string;
}

export interface AuthorizedWriteAuthResult {
  auth: AuthResult;
  ownerAuthorizationReceipt: Readonly<OwnerAuthorizationReceipt>;
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

export async function resolveReadAuth(slug: string): Promise<AuthResult> {
  const repository = parseRepositorySlug(slug);
  const config = readAuthConfig();
  return resolveReadAuthConfig(config, repository);
}

/** Resolve auth only when the operator explicitly configured a mode. */
export async function resolveOptionalReadAuth(slug: string): Promise<AuthResult | null> {
  const repository = parseRepositorySlug(slug);
  const config = readOptionalAuthConfig();
  if (!config) return null;
  return resolveReadAuthConfig(config, repository);
}

function resolveReadAuthConfig(
  config: AuthConfig,
  repository: ReturnType<typeof parseRepositorySlug>
): Promise<AuthResult> | AuthResult {
  return config.mode === "github-app" ? appAuth(config.app, repository, "read") : ghAuth("read");
}

/**
 * The sole write-credential broker. It rechecks live repository/base identity,
 * re-reads owner revocation state, irreversibly consumes the envelope in the
 * durable replay ledger, and only then asks GitHub for one repository-scoped
 * write token. gh-cli can never enter this path.
 */
export async function resolveAuthorizedWriteAuth(
  slug: string,
  input: {
    readAuth: AuthResult;
    ownerGrant: OwnerAuthorizationGrant;
    expected: ExpectedOwnerAuthorizationBindings;
    registryPath: string;
  }
): Promise<AuthorizedWriteAuthResult> {
  const repository = parseRepositorySlug(slug);
  const readIdentity = input.readAuth.githubApp;
  if (
    input.readAuth.mode !== "github-app" ||
    input.readAuth.capability !== "read" ||
    readIdentity === null
  ) {
    throw new Error("Owner-authorized publication requires GitHub App read authentication");
  }
  assertIdentityMatchesExpected(repository.slug, readIdentity, input.expected);
  await assertLiveReadIdentityAndBase(
    input.readAuth,
    repository,
    input.expected,
    readIdentity
  );

  // Keep the revocation/time check as close as possible to irreversible
  // consumption. ownerAuthorizationConsumption performs a second registry read.
  assertCurrentOwnerGrant(input.ownerGrant, {
    expected: input.expected,
    registryPath: input.registryPath,
  });
  const consumption = ownerAuthorizationConsumption(input.ownerGrant, {
    expected: input.expected,
    registryPath: input.registryPath,
  });
  const stored = consumeOwnerAuthorization(consumption);
  markGrantConsumed(input.ownerGrant, stored);
  assertConsumedOwnerGrant(input.ownerGrant);

  const config = readAuthConfig();
  if (config.mode !== "github-app") {
    throw new Error("Owner-authorized publication cannot use gh-cli authentication");
  }
  const writeAuth = await appAuth(config.app, repository, "write", {
    beforeMint: async (observed) => {
      assertObservedGitHubAppAndInstallationMatches(
        observed,
        readIdentity,
        input.expected
      );
      await assertLiveReadIdentityAndBase(
        input.readAuth,
        repository,
        input.expected,
        readIdentity
      );
      assertCurrentConsumedOwnerGrant(input.ownerGrant, {
        expected: input.expected,
        registryPath: input.registryPath,
      });
    },
    afterMint: async (minted) => {
      if (minted.githubApp === null) {
        throw new Error("GitHub App write credential is missing repository identity");
      }
      await assertLiveReadIdentityAndBase(
        minted,
        repository,
        input.expected,
        minted.githubApp
      );
      assertCurrentConsumedOwnerGrant(input.ownerGrant, {
        expected: input.expected,
        registryPath: input.registryPath,
      });
    },
  });
  try {
    if (writeAuth.githubApp === null || !sameGitHubIdentity(writeAuth.githubApp, readIdentity)) {
      throw new Error("GitHub App identity changed while minting the write credential");
    }
    assertIdentityMatchesExpected(repository.slug, writeAuth.githubApp, input.expected);
    return {
      auth: writeAuth,
      ownerAuthorizationReceipt: ownerAuthorizationReceipt(input.ownerGrant),
    };
  } catch (error) {
    await revokeInstallationToken(writeAuth.token);
    throw error;
  }
}

async function appAuth(
  app: AppCredentials,
  repository: ReturnType<typeof parseRepositorySlug>,
  capability: AuthCapability,
  writeGuards?: {
    beforeMint: (identity: ObservedGitHubAppInstallationIdentity) => Promise<void>;
    afterMint: (auth: AuthResult) => Promise<void>;
  }
): Promise<AuthResult> {
  if ((capability === "write") !== (writeGuards !== undefined)) {
    throw new Error("GitHub App write authentication requires consumed owner-authorization guards");
  }
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
    if (writeGuards) {
      await writeGuards.beforeMint({
        appId: Number(app.appId),
        appSlug: appInfo.slug!,
        installationId: installation.id,
      });
    }
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
    const result: AuthResult = {
      token: installationAuth.token,
      actor,
      octokit,
      mode: "github-app",
      capability,
      githubApp: {
        appId: Number(app.appId),
        appSlug: appInfo.slug!,
        installationId: installation.id,
        repositoryId: repositoryInfo.id,
        repositoryOwnerId: repositoryInfo.owner.id,
        repositorySlug: repositoryInfo.full_name,
      },
    };
    if (writeGuards) await writeGuards.afterMint(result);
    return result;
  } catch (error) {
    if (issuedToken) await revokeInstallationToken(issuedToken);
    throw new Error(
      `GitHub App authentication failed: ${safeErrorMessage(error, [app.privateKey, issuedToken ?? ""])}`
    );
  }
}

type PermissionPolicy = Readonly<Record<string, string>>;

interface ObservedGitHubAppInstallationIdentity {
  appId: number;
  appSlug: string;
  installationId: number;
}

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

function ghAuth(capability: AuthCapability): AuthResult {
  if (capability !== "read") {
    throw new Error("gh-cli cannot mint API Migrator write credentials");
  }
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
      capability: "read",
      githubApp: null,
    };
  } catch (error) {
    throw new Error(`gh-cli authentication failed: ${safeErrorMessage(error)}`);
  }
}

function assertIdentityMatchesExpected(
  requestedSlug: string,
  identity: GitHubAppAuthIdentity,
  expected: ExpectedOwnerAuthorizationBindings
): void {
  if (
    identity.repositorySlug.toLowerCase() !== requestedSlug.toLowerCase() ||
    expected.repository.slug !== requestedSlug.toLowerCase() ||
    identity.repositoryId !== expected.repository.id ||
    identity.repositoryOwnerId !== expected.repository.ownerId ||
    identity.appId !== expected.github.appId ||
    identity.installationId !== expected.github.installationId
  ) {
    throw new Error("GitHub App identity does not match the owner-authorized repository scope");
  }
}

function assertObservedGitHubAppAndInstallationMatches(
  observed: ObservedGitHubAppInstallationIdentity,
  readIdentity: GitHubAppAuthIdentity,
  expected: ExpectedOwnerAuthorizationBindings
): void {
  if (
    observed.appId !== readIdentity.appId ||
    observed.appId !== expected.github.appId ||
    observed.appSlug !== readIdentity.appSlug ||
    observed.installationId !== readIdentity.installationId ||
    observed.installationId !== expected.github.installationId
  ) {
    throw new Error("GitHub App or installation identity changed before write-token minting");
  }
}

async function assertLiveReadIdentityAndBase(
  auth: AuthResult,
  repository: ReturnType<typeof parseRepositorySlug>,
  expected: ExpectedOwnerAuthorizationBindings,
  identity: GitHubAppAuthIdentity
): Promise<void> {
  try {
    const [{ data: repositoryInfo }, { data: baseRef }] = await Promise.all([
      auth.octokit.repos.get({ owner: repository.owner, repo: repository.repo }),
      auth.octokit.git.getRef({
        owner: repository.owner,
        repo: repository.repo,
        ref: `heads/${expected.base.branch}`,
      }),
    ]);
    if (
      repositoryInfo.full_name.toLowerCase() !== expected.repository.slug ||
      repositoryInfo.id !== expected.repository.id ||
      repositoryInfo.owner.id !== expected.repository.ownerId ||
      repositoryInfo.id !== identity.repositoryId ||
      repositoryInfo.owner.id !== identity.repositoryOwnerId ||
      baseRef.object.sha !== expected.base.sha
    ) {
      throw new Error("repository or base identity changed after owner approval");
    }
  } catch (error) {
    throw new Error(
      `Could not revalidate owner-authorized repository identity: ${safeErrorMessage(error, [auth.token])}`
    );
  }
}

function sameGitHubIdentity(left: GitHubAppAuthIdentity, right: GitHubAppAuthIdentity): boolean {
  return (
    left.appId === right.appId &&
    left.appSlug === right.appSlug &&
    left.installationId === right.installationId &&
    left.repositoryId === right.repositoryId &&
    left.repositoryOwnerId === right.repositoryOwnerId &&
    left.repositorySlug.toLowerCase() === right.repositorySlug.toLowerCase()
  );
}
