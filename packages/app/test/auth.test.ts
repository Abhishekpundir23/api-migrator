import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_GITHUB_APP_PERMISSIONS,
  assertConfiguredInstallationId,
  assertGitHubAppPolicy,
  assertGitHubInstallationPolicy,
  assertGitHubInstallationTokenPolicy,
  githubInstallationTokenOptions,
  readAppCredentials,
  readAuthConfig,
  readOptionalAuthConfig,
} from "../src/auth.js";

const generatedPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const privateKey = generatedPrivateKey.replace(/\n/g, "\\n");

test("auth mode must be explicit", () => {
  assert.throws(() => readAuthConfig({}), /API_MIGRATOR_AUTH_MODE/);
  assert.throws(() => readAuthConfig({ API_MIGRATOR_AUTH_MODE: "auto" }), /API_MIGRATOR_AUTH_MODE/);
});

test("preview auth fallback is absent unless an auth mode was explicitly selected", () => {
  assert.equal(readOptionalAuthConfig({}), null);
  assert.equal(readOptionalAuthConfig({ GH_APP_ID: "123", GH_APP_PRIVATE_KEY: privateKey }), null);
  assert.deepEqual(
    readOptionalAuthConfig({ API_MIGRATOR_AUTH_MODE: "gh-cli", NODE_ENV: "development" }),
    { mode: "gh-cli" }
  );
  assert.throws(
    () => readOptionalAuthConfig({ API_MIGRATOR_AUTH_MODE: "github-app", GH_APP_ID: "123" }),
    /Partial GitHub App configuration/
  );
});

test("partial or malformed GitHub App configuration fails closed", () => {
  assert.throws(
    () => readAuthConfig({ API_MIGRATOR_AUTH_MODE: "github-app", GH_APP_ID: "123" }),
    /Partial GitHub App configuration/
  );
  assert.throws(
    () =>
      readAuthConfig({
        API_MIGRATOR_AUTH_MODE: "github-app",
        GH_APP_ID: "not-numeric",
        GH_APP_PRIVATE_KEY: privateKey,
      }),
    /positive integer/
  );
  assert.throws(
    () =>
      readAuthConfig({
        API_MIGRATOR_AUTH_MODE: "github-app",
        GH_APP_ID: "123",
        GH_APP_PRIVATE_KEY: privateKey,
        GH_APP_INSTALLATION_ID: "0",
      }),
    /positive integer/
  );
});

test("complete GitHub App configuration is parsed without fallback", () => {
  const env = {
    API_MIGRATOR_AUTH_MODE: "github-app",
    GH_APP_ID: "123",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_APP_INSTALLATION_ID: "456",
  };
  assert.deepEqual(readAuthConfig(env), {
    mode: "github-app",
    app: { appId: "123", privateKey: privateKey.replace(/\\n/g, "\n"), installationId: 456 },
  });
  assert.equal(readAppCredentials(env)?.installationId, 456);
});

test("a blank optional installation id is omitted while nonblank malformed values fail", () => {
  const base = {
    GH_APP_ID: "123",
    GH_APP_PRIVATE_KEY: privateKey,
  };
  assert.equal(readAppCredentials({ ...base, GH_APP_INSTALLATION_ID: "" })?.installationId, null);
  assert.equal(readAppCredentials({ ...base, GH_APP_INSTALLATION_ID: "   " })?.installationId, null);
  assert.equal(readAppCredentials({ GH_APP_INSTALLATION_ID: "" }), null);
  assert.throws(
    () => readAppCredentials({ ...base, GH_APP_INSTALLATION_ID: " 456 " }),
    /positive integer/
  );
  assert.throws(
    () => readAppCredentials({ ...base, GH_APP_INSTALLATION_ID: "invalid" }),
    /positive integer/
  );
});

test("gh-cli is pilot-only and cannot silently coexist with App credentials", () => {
  assert.deepEqual(readAuthConfig({ API_MIGRATOR_AUTH_MODE: "gh-cli", NODE_ENV: "development" }), {
    mode: "gh-cli",
  });
  assert.throws(
    () => readAuthConfig({ API_MIGRATOR_AUTH_MODE: "gh-cli", NODE_ENV: "production" }),
    /disabled in production/
  );
  assert.throws(
    () =>
      readAuthConfig({
        API_MIGRATOR_AUTH_MODE: "gh-cli",
        GH_APP_ID: "123",
        GH_APP_PRIVATE_KEY: privateKey,
      }),
    /cannot be combined/
  );
});

test("private-key files must be absolute, owner-only, regular RSA keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-app-key-"));
  const keyPath = join(directory, "app.pem");
  const linkPath = join(directory, "app-link.pem");
  try {
    chmodSync(directory, 0o700);
    writeFileSync(keyPath, generatedPrivateKey, { encoding: "utf8", mode: 0o600 });
    const config = readAuthConfig({
      API_MIGRATOR_AUTH_MODE: "github-app",
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY_PATH: keyPath,
    });
    assert.equal(config.mode, "github-app");
    if (config.mode === "github-app") assert.equal(config.app.privateKey, generatedPrivateKey);

    assert.throws(
      () =>
        readAuthConfig({
          API_MIGRATOR_AUTH_MODE: "github-app",
          GH_APP_ID: "123",
          GH_APP_PRIVATE_KEY_PATH: "relative.pem",
        }),
      /absolute path/
    );
    assert.throws(
      () =>
        readAuthConfig({
          API_MIGRATOR_AUTH_MODE: "github-app",
          GH_APP_ID: "123",
          GH_APP_PRIVATE_KEY: privateKey,
          GH_APP_PRIVATE_KEY_PATH: keyPath,
        }),
      /mutually exclusive/
    );

    chmodSync(keyPath, 0o644);
    assert.throws(
      () =>
        readAuthConfig({
          API_MIGRATOR_AUTH_MODE: "github-app",
          GH_APP_ID: "123",
          GH_APP_PRIVATE_KEY_PATH: keyPath,
        }),
      /owner-only/
    );

    chmodSync(keyPath, 0o600);
    symlinkSync(keyPath, linkPath);
    assert.throws(
      () =>
        readAuthConfig({
          API_MIGRATOR_AUTH_MODE: "github-app",
          GH_APP_ID: "123",
          GH_APP_PRIVATE_KEY_PATH: linkPath,
        }),
      /owner-only/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("private-key files cannot be stored inside the trusted workspace", () => {
  const directory = mkdtempSync(
    join(dirname(fileURLToPath(import.meta.url)), "api-migrator-workspace-key-")
  );
  const keyPath = join(directory, "app.pem");
  try {
    chmodSync(directory, 0o700);
    writeFileSync(keyPath, generatedPrivateKey, { encoding: "utf8", mode: 0o600 });
    assert.throws(
      () =>
        readAuthConfig({
          API_MIGRATOR_AUTH_MODE: "github-app",
          GH_APP_ID: "123",
          GH_APP_PRIVATE_KEY_PATH: keyPath,
        }),
      /outside the workspace/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("private keys must be valid RSA keys with at least 2048 bits", () => {
  const undersized = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  for (const invalid of ["not a key", undersized]) {
    assert.throws(
      () =>
        readAuthConfig({
          API_MIGRATOR_AUTH_MODE: "github-app",
          GH_APP_ID: "123",
          GH_APP_PRIVATE_KEY: invalid,
        }),
      /valid RSA private key/
    );
  }
});

test("App and installation policy is exact and fail-closed", () => {
  const app = {
    id: 123,
    slug: "api-migrator",
    permissions: { ...REQUIRED_GITHUB_APP_PERMISSIONS },
    events: [],
  };
  assert.doesNotThrow(() => assertGitHubAppPolicy(app, 123));
  assert.throws(
    () =>
      assertGitHubAppPolicy(
        { ...app, permissions: { contents: "read", metadata: "read", pull_requests: "write" } },
        123
      ),
    /least-privilege/
  );
  assert.throws(
    () =>
      assertGitHubAppPolicy(
        { ...app, permissions: { contents: "write", metadata: "read" } },
        123
      ),
    /least-privilege/
  );
  assert.throws(
    () => assertGitHubAppPolicy({ ...app, permissions: { ...app.permissions, actions: "read" } }, 123),
    /least-privilege/
  );
  assert.throws(() => assertGitHubAppPolicy({ ...app, events: ["push"] }, 123), /webhook events/);
  assert.throws(() => assertGitHubAppPolicy(app, 456), /identity/);

  const installation = {
    repository_selection: "selected",
    permissions: { ...REQUIRED_GITHUB_APP_PERMISSIONS },
    events: [],
    suspended_at: null,
  };
  assert.doesNotThrow(() => assertGitHubInstallationPolicy(installation));
  assert.throws(
    () => assertGitHubInstallationPolicy({ ...installation, repository_selection: "all" }),
    /selected repositories/
  );
  assert.throws(
    () => assertGitHubInstallationPolicy({ ...installation, suspended_at: "2026-08-01" }),
    /suspended/
  );
  assert.throws(
    () => assertGitHubInstallationPolicy({ ...installation, events: ["installation"] }),
    /webhook events/
  );
});

test("installation IDs and token requests are repository- and capability-scoped", () => {
  assert.doesNotThrow(() => assertConfiguredInstallationId(null, 456));
  assert.doesNotThrow(() => assertConfiguredInstallationId(456, 456));
  assert.throws(() => assertConfiguredInstallationId(789, 456), /does not own/);

  assert.deepEqual(githubInstallationTokenOptions(456, "sandbox", "read"), {
    type: "installation",
    installationId: 456,
    repositoryNames: ["sandbox"],
    permissions: { contents: "read", metadata: "read", pull_requests: "read" },
  });
  assert.deepEqual(githubInstallationTokenOptions(456, "sandbox", "write"), {
    type: "installation",
    installationId: 456,
    repositoryNames: ["sandbox"],
    permissions: { ...REQUIRED_GITHUB_APP_PERMISSIONS },
  });
});

test("returned installation tokens must be exact, single-repository capabilities", () => {
  const token = {
    type: "token" as const,
    tokenType: "installation" as const,
    installationId: 456,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    repositorySelection: "selected" as const,
    repositoryIds: [789],
    repositoryNames: ["sandbox"],
    permissions: { contents: "read", metadata: "read", pull_requests: "read" },
  };
  assert.doesNotThrow(() =>
    assertGitHubInstallationTokenPolicy(token, 456, "sandbox", {
      contents: "read",
      metadata: "read",
      pull_requests: "read",
    })
  );
  assert.throws(
    () => assertGitHubInstallationTokenPolicy({ ...token, repositorySelection: "all" }, 456, "sandbox", token.permissions),
    /not repository-scoped/
  );
  assert.throws(
    () => assertGitHubInstallationTokenPolicy(token, 999, "sandbox", token.permissions),
    /unexpected installation/
  );
  assert.throws(
    () =>
      assertGitHubInstallationTokenPolicy(
        { ...token, tokenType: "oauth" as never },
        456,
        "sandbox",
        token.permissions
      ),
    /authentication type/
  );
  assert.throws(
    () =>
      assertGitHubInstallationTokenPolicy(
        { ...token, expiresAt: new Date(Date.now() - 1_000).toISOString() },
        456,
        "sandbox",
        token.permissions
      ),
    /invalid lifetime/
  );
  assert.throws(
    () => assertGitHubInstallationTokenPolicy({ ...token, repositoryIds: [789, 790] }, 456, "sandbox", token.permissions),
    /exactly the requested repository/
  );
  assert.throws(
    () => assertGitHubInstallationTokenPolicy({ ...token, repositoryNames: ["other"] }, 456, "sandbox", token.permissions),
    /exactly the requested repository/
  );
  assert.throws(
    () =>
      assertGitHubInstallationTokenPolicy(
        { ...token, permissions: { ...token.permissions, pull_requests: "write" } },
        456,
        "sandbox",
        token.permissions
      ),
    /least-privilege/
  );
});
