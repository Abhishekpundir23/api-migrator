import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../src/env.js";

test("explicit env files must be absolute, owner-only, and regular", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-env-"));
  const file = join(directory, ".env");
  const link = join(directory, ".env-link");
  const priorValue = process.env.API_MIGRATOR_ENV_TEST;
  const priorRoot = process.env.API_MIGRATOR_WORKSPACE_ROOT;
  try {
    chmodSync(directory, 0o700);
    writeFileSync(file, "API_MIGRATOR_ENV_TEST=loaded\n", { encoding: "utf8", mode: 0o600 });
    delete process.env.API_MIGRATOR_ENV_TEST;
    loadEnv(file);
    assert.equal(process.env.API_MIGRATOR_ENV_TEST, "loaded");
    assert.equal(process.env.API_MIGRATOR_WORKSPACE_ROOT, directory);

    assert.throws(() => loadEnv("relative.env"), /absolute/);
    chmodSync(file, 0o644);
    assert.throws(() => loadEnv(file), /owner-only/);

    chmodSync(file, 0o600);
    symlinkSync(file, link);
    assert.throws(() => loadEnv(link), /owner-only/);
  } finally {
    if (priorValue === undefined) delete process.env.API_MIGRATOR_ENV_TEST;
    else process.env.API_MIGRATOR_ENV_TEST = priorValue;
    if (priorRoot === undefined) delete process.env.API_MIGRATOR_WORKSPACE_ROOT;
    else process.env.API_MIGRATOR_WORKSPACE_ROOT = priorRoot;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real environment variables retain precedence over an env file", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-env-precedence-"));
  const file = join(directory, ".env");
  const priorValue = process.env.API_MIGRATOR_ENV_TEST;
  const priorRoot = process.env.API_MIGRATOR_WORKSPACE_ROOT;
  try {
    chmodSync(directory, 0o700);
    writeFileSync(file, "API_MIGRATOR_ENV_TEST=file\n", { encoding: "utf8", mode: 0o600 });
    process.env.API_MIGRATOR_ENV_TEST = "process";
    loadEnv(file);
    assert.equal(process.env.API_MIGRATOR_ENV_TEST, "process");
  } finally {
    if (priorValue === undefined) delete process.env.API_MIGRATOR_ENV_TEST;
    else process.env.API_MIGRATOR_ENV_TEST = priorValue;
    if (priorRoot === undefined) delete process.env.API_MIGRATOR_WORKSPACE_ROOT;
    else process.env.API_MIGRATOR_WORKSPACE_ROOT = priorRoot;
    rmSync(directory, { recursive: true, force: true });
  }
});
