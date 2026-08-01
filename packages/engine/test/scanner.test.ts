import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSdkFiles, findSourceFiles, selectSdkFiles, SourceScanError } from "../src/index.js";

test("scanner covers Node and TypeScript module extensions", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-scanner-test-"));
  try {
    for (const extension of ["cjs", "mjs", "cts", "mts"]) {
      writeFileSync(
        join(directory, `usage.${extension}`),
        extension.startsWith("c")
          ? `const sdk = require("@knocklabs/node");\n`
          : `const sdk = await import("@knocklabs/node");\n`
      );
    }
    assert.deepEqual(
      findSdkFiles(directory, "knock-v0-to-v1").map((file) => file.relative),
      ["usage.cjs", "usage.cts", "usage.mjs", "usage.mts"]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scanner finds configured local Knock clients for review", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-scanner-test-"));
  try {
    writeFileSync(
      join(directory, "worker.ts"),
      `import { knock } from "./client";\nknock.notify("welcome");\n`
    );
    assert.deepEqual(
      findSdkFiles(directory, "knock-v0-to-v1").map((file) => file.relative),
      ["worker.ts"]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source inventory retains unmatched files for conservative module resolution", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-source-inventory-test-"));
  try {
    writeFileSync(join(directory, "client.ts"), `export const client = unrelated();\n`);
    writeFileSync(join(directory, "client.js"), `import { Inngest } from "inngest";\n`);
    assert.deepEqual(findSourceFiles(directory).map((file) => file.relative), ["client.js", "client.ts"]);
    assert.deepEqual(
      findSdkFiles(directory, "inngest-v3-to-v4").map((file) => file.relative),
      ["client.js"]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source inventory and selection surface filesystem failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-source-error-test-"));
  const missing = join(directory, "missing.ts");
  try {
    assert.throws(() => findSourceFiles(join(directory, "missing-directory")), SourceScanError);
    assert.throws(
      () => selectSdkFiles([{ absolute: missing, relative: "missing.ts" }], "inngest-v3-to-v4"),
      SourceScanError
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source inventory rejects source-like symbolic links", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-source-symlink-test-"));
  try {
    writeFileSync(join(directory, "actual.ts"), `export const value = 1;\n`);
    symlinkSync("actual.ts", join(directory, "client.ts"));
    assert.throws(
      () => findSourceFiles(directory),
      (error: unknown) => error instanceof SourceScanError
        && /Source-like symbolic link is unsupported: client\.ts/.test(error.message)
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
