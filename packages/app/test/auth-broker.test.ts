import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Octokit } from "@octokit/rest";
import {
  closeDb,
  consumeOwnerAuthorization,
  getDb,
  getOwnerAuthorizationConsumption,
  initializeOwnerAuthorizationStore,
  migrate,
} from "@api-migrator/db";
import {
  REQUIRED_GITHUB_APP_PERMISSIONS,
  resolveAuthorizedWriteAuth,
  type AuthResult,
  type GitHubAppAuthIdentity,
} from "../src/auth.js";
import {
  OWNER_AUTHORIZATION_AUDIENCE,
  OWNER_AUTHORIZATION_SIGNATURE_DOMAIN,
  ownerAuthorizationConsumption,
  verifyOwnerAuthorizationEnvelope,
  type ExpectedOwnerAuthorizationBindings,
  type OwnerAuthorizationGrant,
  type OwnerAuthorizationPayload,
} from "../src/owner-authorization.js";

const REPOSITORY_SLUG = "example-org/example-repo";
const REPOSITORY_NAME = "example-repo";
const REPOSITORY_ID = 1_234_567;
const REPOSITORY_OWNER_ID = 7_654_321;
const APP_ID = 123_456;
const INSTALLATION_ID = 654_321;
const BASE_SHA = "a".repeat(40);

const appPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

interface OwnerFixture {
  directory: string;
  registryPath: string;
  payload: OwnerAuthorizationPayload;
  expected: ExpectedOwnerAuthorizationBindings;
  registry: {
    version: number;
    keys: Array<Record<string, unknown>>;
    revokedAuthorizationIds: string[];
  };
  grant: OwnerAuthorizationGrant;
  rewriteRegistry(): void;
  cleanup(): void;
}

interface ReplayStoreFixture {
  directory: string;
  cleanup(): void;
}

interface GitHubHarness {
  mintCount: number;
  revokeCount: number;
  requests: string[];
  restore(): void;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function digest(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function publicKeyPem(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function publicKeyFingerprint(key: KeyObject): string {
  const spki = key.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(spki).digest("hex")}`;
}

function writeCanonical(path: string, value: unknown): void {
  writeFileSync(path, canonical(value), { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function ownerFixture(suffix: string): OwnerFixture {
  const now = Date.now();
  const directory = mkdtempSync(join(tmpdir(), `api-migrator-broker-owner-${suffix}-`));
  chmodSync(directory, 0o700);
  const registryPath = join(directory, "owner-keys.json");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload: OwnerAuthorizationPayload = {
    version: 1,
    audience: OWNER_AUTHORIZATION_AUDIENCE,
    envelopeId: `envelope-${suffix}`,
    authorizationId: `authorization-${suffix}`,
    pilotId: "pilot-broker-tests",
    signerId: "github-owner-1234",
    keyId: `owner-key-${suffix}`,
    approvalEvidenceDigest: digest(`approval-${suffix}`),
    preRunAuthorizationDigest: digest(`pre-run-${suffix}`),
    previewCompletedAt: now - 5_000,
    issuedAt: now - 4_000,
    notBefore: now - 3_000,
    expiresAt: now + 10 * 60_000,
    authorizationExpiresAt: now + 60 * 60_000,
    nonce: randomBytes(32).toString("base64url"),
    repository: {
      slug: REPOSITORY_SLUG,
      id: REPOSITORY_ID,
      ownerId: REPOSITORY_OWNER_ID,
    },
    github: {
      appId: APP_ID,
      installationId: INSTALLATION_ID,
    },
    base: {
      branch: "main",
      sha: BASE_SHA,
    },
    engine: {
      tag: "v0.1.0-pilot",
      commit: "b".repeat(40),
    },
    manifest: {
      byteLength: 1_024,
      digest: digest(`manifest-${suffix}`),
    },
    preview: {
      preflightId: `pf_${createHash("sha256").update(`preflight-${suffix}`).digest("hex")}`,
      artifactDigest: digest(`artifact-${suffix}`),
      candidateBranch: `codex/api-migrator/candidate-${createHash("sha256")
        .update(`branch-${suffix}`)
        .digest("hex")
        .slice(0, 16)}`,
      candidateTreeSha: createHash("sha256").update(`tree-${suffix}`).digest("hex").slice(0, 40),
      findingsDigest: digest(`findings-${suffix}`),
      resolutionsDigest: digest(`resolutions-${suffix}`),
      commandScopeDigest: digest(`command-${suffix}`),
      runnerAttestationDigest: digest(`runner-${suffix}`),
      rulesetDigest: digest(`ruleset-${suffix}`),
      requiredCiDigest: digest(`ci-${suffix}`),
    },
    allowedActions: ["create_branch", "create_pull_request"],
    pullRequestNumber: null,
  };
  const registry = {
    version: 1,
    keys: [{
      keyId: payload.keyId,
      signerId: payload.signerId,
      algorithm: "Ed25519",
      publicKeyPem: publicKeyPem(publicKey),
      fingerprint: publicKeyFingerprint(publicKey),
      repository: payload.repository,
      validFrom: now - 60 * 60_000,
      validUntil: now + 2 * 60 * 60_000,
      revokedAt: null,
    }],
    revokedAuthorizationIds: [] as string[],
  };
  writeCanonical(registryPath, registry);

  const payloadBytes = Buffer.from(canonical(payload), "utf8");
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(OWNER_AUTHORIZATION_SIGNATURE_DOMAIN, "utf8"), payloadBytes]),
    privateKey
  ).toString("base64url");
  const envelope = canonical({
    version: 1,
    keyId: payload.keyId,
    payload: payloadBytes.toString("base64url"),
    signature,
  });
  const expected: ExpectedOwnerAuthorizationBindings = JSON.parse(
    JSON.stringify({
      pilotId: payload.pilotId,
      approvalEvidenceDigest: payload.approvalEvidenceDigest,
      preRunAuthorizationDigest: payload.preRunAuthorizationDigest,
      previewCompletedAt: payload.previewCompletedAt,
      authorizationExpiresAt: payload.authorizationExpiresAt,
      repository: payload.repository,
      github: payload.github,
      base: payload.base,
      engine: payload.engine,
      manifest: payload.manifest,
      preview: payload.preview,
      allowedActions: payload.allowedActions,
      pullRequestNumber: payload.pullRequestNumber,
    })
  ) as ExpectedOwnerAuthorizationBindings;
  const grant = verifyOwnerAuthorizationEnvelope(envelope, {
    registryPath,
    expected,
  });

  return {
    directory,
    registryPath,
    payload,
    expected,
    registry,
    grant,
    rewriteRegistry: () => writeCanonical(registryPath, registry),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function replayStoreFixture(suffix: string): ReplayStoreFixture {
  const directory = mkdtempSync(join(tmpdir(), `api-migrator-broker-store-${suffix}-`));
  const databaseDirectory = join(directory, "database");
  const anchorDirectory = join(directory, "anchor");
  mkdirSync(databaseDirectory, { mode: 0o700 });
  mkdirSync(anchorDirectory, { mode: 0o700 });
  const databasePath = join(databaseDirectory, "broker.db");
  const anchorPath = join(anchorDirectory, "replay.anchor");

  process.env.API_MIGRATOR_DB_PATH = databasePath;
  process.env.API_MIGRATOR_REPLAY_STORE_ID = `api-migrator-broker-${suffix}`;
  process.env.API_MIGRATOR_REPLAY_ANCHOR_PATH = anchorPath;
  const db = getDb(databasePath);
  migrate(db);
  initializeOwnerAuthorizationStore(db);

  return {
    directory,
    cleanup: () => {
      closeDb();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function githubIdentity(patch: Partial<GitHubAppAuthIdentity> = {}): GitHubAppAuthIdentity {
  return {
    appId: APP_ID,
    appSlug: "api-migrator",
    installationId: INSTALLATION_ID,
    repositoryId: REPOSITORY_ID,
    repositoryOwnerId: REPOSITORY_OWNER_ID,
    repositorySlug: REPOSITORY_SLUG,
    ...patch,
  };
}

function readAuth(input: {
  baseSha?: string;
  identity?: GitHubAppAuthIdentity | null;
  mode?: "github-app" | "gh-cli";
} = {}): AuthResult {
  const identity = input.identity === undefined ? githubIdentity() : input.identity;
  const octokit = {
    repos: {
      get: async () => ({
        data: {
          full_name: identity?.repositorySlug ?? REPOSITORY_SLUG,
          id: identity?.repositoryId ?? REPOSITORY_ID,
          owner: { id: identity?.repositoryOwnerId ?? REPOSITORY_OWNER_ID },
        },
      }),
    },
    git: {
      getRef: async () => ({ data: { object: { sha: input.baseSha ?? BASE_SHA } } }),
    },
  } as unknown as Octokit;
  return {
    token: "read-token",
    actor: "api-migrator[bot]",
    octokit,
    mode: input.mode ?? "github-app",
    capability: "read",
    githubApp: identity,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function installGitHubHarness(input: {
  appId?: number;
  appSlug?: string;
  installationId?: number;
  mintedBaseSha?: string;
  onMint?: () => void;
} = {}): GitHubHarness {
  const originalFetch = globalThis.fetch;
  const observedAppId = input.appId ?? APP_ID;
  const observedAppSlug = input.appSlug ?? "api-migrator";
  const observedInstallationId = input.installationId ?? INSTALLATION_ID;
  const state = {
    mintCount: 0,
    revokeCount: 0,
    requests: [] as string[],
  };
  globalThis.fetch = async (request, init) => {
    const normalized = request instanceof Request ? request : new Request(request, init);
    const url = new URL(normalized.url);
    const route = `${normalized.method} ${url.pathname}`;
    state.requests.push(route);

    if (route === "GET /app") {
      return jsonResponse({
        id: observedAppId,
        slug: observedAppSlug,
        permissions: { ...REQUIRED_GITHUB_APP_PERMISSIONS },
        events: [],
      });
    }
    if (route === `GET /repos/${REPOSITORY_SLUG}/installation`) {
      return jsonResponse({
        id: observedInstallationId,
        repository_selection: "selected",
        permissions: { ...REQUIRED_GITHUB_APP_PERMISSIONS },
        events: [],
        suspended_at: null,
      });
    }
    if (route === `POST /app/installations/${observedInstallationId}/access_tokens`) {
      state.mintCount += 1;
      input.onMint?.();
      return jsonResponse({
        token: `write-token-${state.mintCount}`,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        permissions: { ...REQUIRED_GITHUB_APP_PERMISSIONS },
        repository_selection: "selected",
        repositories: [{ id: REPOSITORY_ID, name: REPOSITORY_NAME }],
      }, 201);
    }
    if (route === `GET /repos/${REPOSITORY_SLUG}`) {
      return jsonResponse({
        id: REPOSITORY_ID,
        full_name: REPOSITORY_SLUG,
        owner: { id: REPOSITORY_OWNER_ID },
      });
    }
    if (
      normalized.method === "GET" &&
      url.pathname.startsWith(`/repos/${REPOSITORY_SLUG}/git/ref/heads`)
    ) {
      return jsonResponse({ object: { sha: input.mintedBaseSha ?? BASE_SHA } });
    }
    if (route === "DELETE /installation/token") {
      state.revokeCount += 1;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected GitHub request: ${route}`);
  };

  return {
    get mintCount() {
      return state.mintCount;
    },
    get revokeCount() {
      return state.revokeCount;
    },
    requests: state.requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function callBroker(value: OwnerFixture, grant = value.grant, auth = readAuth()) {
  return resolveAuthorizedWriteAuth(REPOSITORY_SLUG, {
    readAuth: auth,
    ownerGrant: grant,
    expected: value.expected,
    registryPath: value.registryPath,
  });
}

const BROKER_ENV_KEYS = [
  "API_MIGRATOR_AUTH_MODE",
  "GH_APP_ID",
  "GH_APP_PRIVATE_KEY",
  "GH_APP_PRIVATE_KEY_PATH",
  "GH_APP_INSTALLATION_ID",
  "API_MIGRATOR_DB_PATH",
  "API_MIGRATOR_REPLAY_STORE_ID",
  "API_MIGRATOR_REPLAY_ANCHOR_PATH",
] as const;

test("the owner-authorized broker is the fail-closed write-token boundary", async (t) => {
  const savedEnv = Object.fromEntries(BROKER_ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.API_MIGRATOR_AUTH_MODE = "github-app";
  process.env.GH_APP_ID = String(APP_ID);
  process.env.GH_APP_PRIVATE_KEY = appPrivateKey;
  delete process.env.GH_APP_PRIVATE_KEY_PATH;
  process.env.GH_APP_INSTALLATION_ID = String(INSTALLATION_ID);

  try {
    await t.test("a forged grant mints zero write tokens", async () => {
      const store = replayStoreFixture("forged");
      const owner = ownerFixture("forged");
      const github = installGitHubHarness();
      try {
        await assert.rejects(
          callBroker(owner, {} as OwnerAuthorizationGrant),
          /invalid owner authorization grant/
        );
        assert.equal(github.mintCount, 0);
        assert.deepEqual(github.requests, []);
      } finally {
        github.restore();
        owner.cleanup();
        store.cleanup();
      }
    });

    await t.test("a durable replay mints zero write tokens", async () => {
      const store = replayStoreFixture("replay");
      const owner = ownerFixture("replay");
      const github = installGitHubHarness();
      try {
        consumeOwnerAuthorization(ownerAuthorizationConsumption(owner.grant));
        await assert.rejects(callBroker(owner), /already consumed or unavailable/);
        assert.equal(github.mintCount, 0);
        assert.deepEqual(github.requests, []);
      } finally {
        github.restore();
        owner.cleanup();
        store.cleanup();
      }
    });

    await t.test("gh-cli authentication mints zero write tokens", async () => {
      const store = replayStoreFixture("gh-cli");
      const owner = ownerFixture("gh-cli");
      const github = installGitHubHarness();
      try {
        await assert.rejects(
          callBroker(owner, owner.grant, readAuth({ mode: "gh-cli", identity: null })),
          /requires GitHub App read authentication/
        );
        assert.equal(github.mintCount, 0);
        assert.deepEqual(github.requests, []);
      } finally {
        github.restore();
        owner.cleanup();
        store.cleanup();
      }
    });

    await t.test("repository identity drift mints zero write tokens", async () => {
      const store = replayStoreFixture("repository-drift");
      const owner = ownerFixture("repository-drift");
      const github = installGitHubHarness();
      try {
        await assert.rejects(
          callBroker(owner, owner.grant, readAuth({
            identity: githubIdentity({ repositoryId: REPOSITORY_ID + 1 }),
          })),
          /does not match the owner-authorized repository scope/
        );
        assert.equal(github.mintCount, 0);
        assert.deepEqual(github.requests, []);
      } finally {
        github.restore();
        owner.cleanup();
        store.cleanup();
      }
    });

    await t.test("base drift mints zero write tokens", async () => {
      const store = replayStoreFixture("base-drift");
      const owner = ownerFixture("base-drift");
      const github = installGitHubHarness();
      try {
        await assert.rejects(
          callBroker(owner, owner.grant, readAuth({ baseSha: "f".repeat(40) })),
          /repository or base identity changed after owner approval/
        );
        assert.equal(github.mintCount, 0);
        assert.deepEqual(github.requests, []);
      } finally {
        github.restore();
        owner.cleanup();
        store.cleanup();
      }
    });

    await t.test("a valid alternate App identity mints zero write tokens", async () => {
      const store = replayStoreFixture("alternate-app");
      const owner = ownerFixture("alternate-app");
      const alternateAppId = APP_ID + 1;
      const github = installGitHubHarness({
        appId: alternateAppId,
        appSlug: "alternate-api-migrator",
      });
      process.env.GH_APP_ID = String(alternateAppId);
      try {
        await assert.rejects(
          callBroker(owner),
          /GitHub App or installation identity changed before write-token minting/
        );
        assert.equal(github.mintCount, 0);
        assert.deepEqual(github.requests, [
          "GET /app",
          `GET /repos/${REPOSITORY_SLUG}/installation`,
        ]);
      } finally {
        process.env.GH_APP_ID = String(APP_ID);
        github.restore();
        owner.cleanup();
        store.cleanup();
      }
    });

    await t.test("an unpinned installation drift mints zero write tokens", async () => {
      const store = replayStoreFixture("installation-drift");
      const owner = ownerFixture("installation-drift");
      const github = installGitHubHarness({ installationId: INSTALLATION_ID + 1 });
      delete process.env.GH_APP_INSTALLATION_ID;
      try {
        await assert.rejects(
          callBroker(owner),
          /GitHub App or installation identity changed before write-token minting/
        );
        assert.equal(github.mintCount, 0);
        assert.deepEqual(github.requests, [
          "GET /app",
          `GET /repos/${REPOSITORY_SLUG}/installation`,
        ]);
      } finally {
        process.env.GH_APP_INSTALLATION_ID = String(INSTALLATION_ID);
        github.restore();
        owner.cleanup();
        store.cleanup();
      }
    });

    await t.test("one valid consumed grant mints exactly one write token", async () => {
      const store = replayStoreFixture("valid");
      const owner = ownerFixture("valid");
      const github = installGitHubHarness();
      try {
        const result = await callBroker(owner);
        assert.equal(github.mintCount, 1);
        assert.equal(github.revokeCount, 0);
        assert.equal(result.auth.token, "write-token-1");
        assert.equal(result.auth.capability, "write");
        assert.equal(result.ownerAuthorizationReceipt.authorizationId, owner.payload.authorizationId);
        assert.equal(
          getOwnerAuthorizationConsumption(owner.payload.authorizationId)?.authorizationId,
          owner.payload.authorizationId
        );
      } finally {
        github.restore();
        owner.cleanup();
        store.cleanup();
      }
    });

    await t.test("post-mint owner revocation revokes the issued token and fails", async () => {
      const store = replayStoreFixture("post-mint-revocation");
      const owner = ownerFixture("post-mint-revocation");
      const github = installGitHubHarness({
        onMint: () => {
          owner.registry.revokedAuthorizationIds.push(owner.payload.authorizationId);
          owner.rewriteRegistry();
        },
      });
      try {
        await assert.rejects(callBroker(owner), /owner authorization has been revoked/);
        assert.equal(github.mintCount, 1);
        assert.equal(github.revokeCount, 1);
        assert.equal(
          getOwnerAuthorizationConsumption(owner.payload.authorizationId)?.authorizationId,
          owner.payload.authorizationId,
          "post-consumption failure must not release the authorization"
        );
      } finally {
        github.restore();
        owner.cleanup();
        store.cleanup();
      }
    });

    await t.test("post-mint base drift revokes the issued token and fails", async () => {
      const store = replayStoreFixture("post-mint-base-drift");
      const owner = ownerFixture("post-mint-base-drift");
      const github = installGitHubHarness({ mintedBaseSha: "f".repeat(40) });
      try {
        await assert.rejects(
          callBroker(owner),
          /repository or base identity changed after owner approval/
        );
        assert.equal(github.mintCount, 1);
        assert.equal(github.revokeCount, 1);
        assert.equal(
          getOwnerAuthorizationConsumption(owner.payload.authorizationId)?.authorizationId,
          owner.payload.authorizationId,
          "post-consumption failure must not release the authorization"
        );
      } finally {
        github.restore();
        owner.cleanup();
        store.cleanup();
      }
    });
  } finally {
    closeDb();
    for (const key of BROKER_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
