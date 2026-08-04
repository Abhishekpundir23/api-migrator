import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PublicationVerificationRunner } from "../src/verification-runner.js";

test("publication runner rejects a network mode outside its fixed phase", (t) => {
  const root = mkdtempSync(join(tmpdir(), "api-migrator-phase-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runner = new PublicationVerificationRunner("none");
  assert.equal(runner.kind, "docker");
  const result = runner.run(root, {
    command: process.execPath,
    args: ["--version"],
    timeoutMs: 1_000,
    network: "default",
    env: {},
  });
  assert.equal(result.exitCode, null);
  assert.match(result.spawnError ?? "", /forbids default network/);
});

test("publication runner uses only the explicit child environment", (t) => {
  const root = mkdtempSync(join(tmpdir(), "api-migrator-phase-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runner = new PublicationVerificationRunner("none");
  const result = runner.run(root, {
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.ONLY_VALUE ?? 'missing')"],
    timeoutMs: 1_000,
    network: "none",
    env: { ONLY_VALUE: "expected" },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "expected");
});
