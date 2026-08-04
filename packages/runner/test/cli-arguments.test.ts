import assert from "node:assert/strict";
import test from "node:test";
import { parseRunnerCliArguments } from "../src/cli-arguments.js";

test("runner accepts only the exact fixed prepare, install, migrate, and verify argument order", () => {
  assert.deepEqual(parseRunnerCliArguments([
    "prepare", "--plan", "/plan", "--source", "/source", "--dependencies", "/dependencies",
    "--installation", "/installation",
  ]), {
    phase: "prepare", planPath: "/plan", sourcePath: "/source", dependenciesPath: "/dependencies",
    installationPath: "/installation",
  });
  assert.deepEqual(parseRunnerCliArguments([
    "install", "--plan", "/plan", "--installation", "/installation", "--prepared-state-digest",
    `sha256:${"a".repeat(64)}`,
  ]), {
    phase: "install", planPath: "/plan", installationPath: "/installation",
    preparedStateDigest: `sha256:${"a".repeat(64)}`,
  });
  assert.equal(parseRunnerCliArguments([
    "migrate", "--plan", "/plan", "--source", "/source", "--dependencies", "/dependencies",
    "--installation", "/installation", "--prepared-state-digest", `sha256:${"a".repeat(64)}`,
    "--install-state-digest", `sha256:${"b".repeat(64)}`, "--output", "/output",
  ]).phase, "migrate");
  assert.equal(parseRunnerCliArguments([
    "verify", "--plan", "/plan", "--input", "/input", "--dependencies", "/dependencies",
    "--dependency-state-digest", `sha256:${"c".repeat(64)}`, "--result", "/result",
  ]).phase, "verify");
});

test("runner rejects unknown, duplicated, reordered, relative, and extra arguments", () => {
  const invalid = [
    [],
    ["shell"],
    ["install", "--installation", "/installation", "--plan", "/plan", "--prepared-state-digest", `sha256:${"a".repeat(64)}`],
    ["install", "--plan", "/plan", "--plan", "/installation", "--prepared-state-digest", `sha256:${"a".repeat(64)}`],
    ["install", "--plan", "relative", "--installation", "/installation", "--prepared-state-digest", `sha256:${"a".repeat(64)}`],
    ["install", "--plan", "/plan", "--installation", "/installation", "--prepared-state-digest", "sha256:nope"],
    ["install", "--plan", "/plan", "--installation", "/installation", "--prepared-state-digest", `sha256:${"a".repeat(64)}`, "--extra"],
  ];
  for (const args of invalid) assert.throws(() => parseRunnerCliArguments(args));
});
