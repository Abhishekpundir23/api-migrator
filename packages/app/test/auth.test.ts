import test from "node:test";
import assert from "node:assert/strict";
import { readAppCredentials, readAuthConfig, readOptionalAuthConfig } from "../src/auth.js";

const privateKey = "-----BEGIN PRIVATE KEY-----\\nprivate\\n-----END PRIVATE KEY-----";

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
