import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixturePhaseOperations, createFixturePlan, executeDockerFixturePhase,
  prepareFixtureWorkspace } from "./fixture-phases.mjs";

const image = process.argv[2];
if (!image || !/^[A-Za-z0-9._/:@+-]+$/.test(image)) {
  throw new Error("usage: run-phase-integration.mjs IMAGE");
}
const root = mkdtempSync(join(tmpdir(), "api-migrator-image-integration-"));
try {
  // Lockfile and source bundle generation is setup, not measured runner execution.
  const prepared = prepareFixtureWorkspace(root);
  const addresses = [...new Set((await lookup("registry.npmjs.org", { all: true }))
    .map((entry) => entry.address))].sort();
  assert(addresses.length > 0 && addresses.length <= 32);
  const now = Date.now();
  const imageDigest = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 * 1024,
  }).trim();
  const plan = createFixturePlan(prepared, {
    imageDigest, addresses, resolutionObservedAt: now,
    resolutionExpiresAt: now + 20 * 60_000,
    now, expiresAt: now + 14 * 60_000,
  });
  const phases = createFixturePhaseOperations({
    image, paths: prepared.paths, plan, addresses, execute: executeDockerFixturePhase,
  });
  const preparedState = await phases.prepare();
  const installedState = await phases.install(preparedState);
  const migratedState = await phases.migrate(installedState);
  const verified = await phases.verify(migratedState);
  process.stdout.write(`${JSON.stringify({ image, ...verified })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
