import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadEnv, resolveDatabasePath } from "../src/index";

test("database migration can load a root env file without overriding real environment values", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-db-env-test-"));
  const file = join(directory, ".env");
  const firstKey = "API_MIGRATOR_TEST_ENV_FIRST";
  const existingKey = "API_MIGRATOR_TEST_ENV_EXISTING";
  const rootKey = "API_MIGRATOR_WORKSPACE_ROOT";
  const previousFirst = process.env[firstKey];
  const previousExisting = process.env[existingKey];
  const previousRoot = process.env[rootKey];
  try {
    delete process.env[firstKey];
    delete process.env[rootKey];
    process.env[existingKey] = "real-environment";
    writeFileSync(file, `${firstKey}=from-file\n${existingKey}=from-file\n`);

    assert.equal(loadEnv(file), file);
    assert.equal(process.env[firstKey], "from-file");
    assert.equal(process.env[existingKey], "real-environment");
  } finally {
    if (previousFirst === undefined) delete process.env[firstKey];
    else process.env[firstKey] = previousFirst;
    if (previousExisting === undefined) delete process.env[existingKey];
    else process.env[existingKey] = previousExisting;
    if (previousRoot === undefined) delete process.env[rootKey];
    else process.env[rootKey] = previousRoot;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("relative configured database paths are stable across workspace commands", () => {
  const configRoot = resolve(tmpdir(), "api-migrator-config-root");
  const resolved = resolveDatabasePath(undefined, {
    API_MIGRATOR_DB_PATH: "data/shared-pilot.db",
    API_MIGRATOR_WORKSPACE_ROOT: configRoot,
  });
  assert.equal(resolved, join(configRoot, "data", "shared-pilot.db"));
  assert.equal(resolveDatabasePath(":memory:", {}), ":memory:");
});
