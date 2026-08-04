import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PublicationRunnerPlanRecord } from "@api-migrator/app/runner-internal";
import {
  createPreparedDependencyState,
  readAndVerifyPreparedDependencyState,
  writePreparedDependencyState,
} from "../src/dependency-state.js";
import { removeNodeModulesTrees } from "../src/filesystem.js";

const NOW = 2_000_000_000_000;

test("prepared state rejects unsealed node_modules and Git metadata at every depth", (t) => {
  const { root, installation } = preparedRoots(t);
  const nestedModules = join(root, "baseline", "packages", "worker", "node_modules");
  mkdirSync(nestedModules, { recursive: true });
  writeFileSync(join(nestedModules, "injected.js"), "module.exports = 'injected';\n");
  assert.throws(
    () => createPreparedDependencyState(root, installation, "package-lock.json", plan(), NOW),
    /baseline prepared tree contains forbidden pre-install state: packages\/worker\/node_modules/
  );

  rmSync(nestedModules, { recursive: true, force: true });
  const nestedGit = join(root, "candidate", "packages", "worker", ".GIT");
  mkdirSync(nestedGit, { recursive: true });
  assert.throws(
    () => createPreparedDependencyState(root, installation, "package-lock.json", plan(), NOW),
    /candidate prepared tree contains forbidden pre-install state: packages\/worker\/.GIT/
  );
});

test("prepared state verification detects node_modules injected after sealing", (t) => {
  const { root, installation } = preparedRoots(t);
  const currentPlan = plan();
  writePreparedDependencyState(
    root,
    createPreparedDependencyState(root, installation, "package-lock.json", currentPlan, NOW)
  );

  const injected = join(root, "original", "nested", "node_modules");
  mkdirSync(injected, { recursive: true });
  writeFileSync(join(injected, "payload.js"), "throw new Error('unexpected');\n");
  assert.throws(
    () => readAndVerifyPreparedDependencyState(root, currentPlan),
    /original prepared tree contains forbidden pre-install state: nested\/node_modules/
  );
});

test("failed-install cleanup removes root and workspace node_modules only", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "api-migrator-install-cleanup-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rootModules = join(root, "node_modules");
  const workspaceModules = join(root, "packages", "worker", "Node_Modules");
  mkdirSync(rootModules, { recursive: true });
  mkdirSync(workspaceModules, { recursive: true });
  writeFileSync(join(rootModules, "partial.js"), "partial\n");
  writeFileSync(join(workspaceModules, "partial.js"), "partial\n");
  writeFileSync(join(root, "package-lock.json"), "sealed\n");

  removeNodeModulesTrees(root);

  assert.equal(existsSync(rootModules), false);
  assert.equal(existsSync(workspaceModules), false);
  assert.equal(existsSync(join(root, "package-lock.json")), true);
});

function preparedRoots(t: TestContext): { root: string; installation: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "api-migrator-prepared-state-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["original", "baseline", "candidate"]) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "package.json"), "{}\n");
    writeFileSync(join(root, name, "package-lock.json"), "{}\n");
  }
  const installation = realpathSync(mkdtempSync(join(tmpdir(), "api-migrator-prepared-install-")));
  t.after(() => rmSync(installation, { recursive: true, force: true }));
  for (const name of ["baseline", "candidate"]) {
    mkdirSync(join(installation, name));
    writeFileSync(join(installation, name, "package.json"), "{}\n");
    writeFileSync(join(installation, name, "package-lock.json"), "{}\n");
  }
  return { root, installation };
}

function plan(): PublicationRunnerPlanRecord {
  const digest = (character: string) => `sha256:${character.repeat(64)}`;
  return {
    digest: digest("a"),
    canonicalJson: "{}",
    plan: {
      job: {
        id: `previewjob_${"b".repeat(64)}`,
        createdAt: NOW - 1_000,
        expiresAt: NOW + 60_000,
      },
      inputs: {
        sourceArchiveDigest: digest("c"),
        manifestDigest: digest("d"),
        commandScopeDigest: digest("e"),
      },
    },
  } as unknown as PublicationRunnerPlanRecord;
}
