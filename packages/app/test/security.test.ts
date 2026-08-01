import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT_TOKEN_ENV,
  createAskPassScript,
  gitAuthenticationEnv,
  redactText,
  safeErrorMessage,
  sanitizedExecutionEnv,
} from "../src/security.js";

test("redaction strips explicit tokens, token patterns, credentials, and private keys", () => {
  const secret = "ghp_explicit_secret_123456";
  const pem = "-----BEGIN PRIVATE KEY-----\nsomething\n-----END PRIVATE KEY-----";
  const text = redactText(
    `failed ${secret} authorization: bearer github_pat_abcdefghijk https://user:pass@github.com/x/y ${pem}`,
    [secret]
  );
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes("github_pat_abcdefghijk"), false);
  assert.equal(text.includes("user:pass"), false);
  assert.equal(text.includes("something"), false);
  assert.match(text, /REDACTED/);
});

test("subprocess errors are bounded and secret-safe", () => {
  const secret = "ghs_child_secret_123456";
  const error = Object.assign(new Error(`command failed with ${secret}`), {
    stderr: Buffer.from(`Authorization: token ${secret}`),
  });
  const safe = safeErrorMessage(error, [secret]);
  assert.equal(safe.includes(secret), false);
  assert.ok(safe.length <= 2_000);
});

test("repository execution environment is allowlisted and isolated", () => {
  const env = sanitizedExecutionEnv("/tmp/isolated", {
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
    GH_TOKEN: "must-not-leak",
    GH_APP_PRIVATE_KEY: "must-not-leak",
    DATABASE_URL: "must-not-leak",
    NODE_OPTIONS: "--require /malicious.js",
    NPM_TOKEN: "must-not-leak",
  });
  assert.equal(env.HOME, "/tmp/isolated");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.LANG, "en_US.UTF-8");
  for (const forbidden of ["GH_TOKEN", "GH_APP_PRIVATE_KEY", "DATABASE_URL", "NODE_OPTIONS", "NPM_TOKEN"]) {
    assert.equal(env[forbidden], undefined);
  }
});

test("askpass keeps a token out of the helper and exposes it only to the git child env", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-security-test-"));
  const token = "ghp_never_in_url_or_argv_123456";
  try {
    const askpass = createAskPassScript(directory);
    const script = readFileSync(askpass, "utf8");
    const env = gitAuthenticationEnv(token, askpass, { PATH: "/usr/bin", HOME: directory });
    assert.equal(script.includes(token), false);
    assert.match(script, new RegExp(GIT_TOKEN_ENV));
    assert.equal(env[GIT_TOKEN_ENV], token);
    assert.equal(env.GIT_ASKPASS, askpass);
    assert.equal(statSync(askpass).mode & 0o077, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
