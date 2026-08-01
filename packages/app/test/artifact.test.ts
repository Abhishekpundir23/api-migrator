import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyVerifiedArtifact,
  assertAppliedArtifact,
  copyGitFreeTree,
  inspectVerifiedArtifact,
  normalizeArtifactPath,
} from "../src/artifact.js";

test("git-free candidate transfers only exact reported regular files", () => {
  withTrees(({ base, proposed, destination }) => {
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, ".git", "config"), "secret metadata");
    mkdirSync(join(base, "node_modules"));
    writeFileSync(join(base, "node_modules", "ignored.js"), "ignored");
    mkdirSync(join(base, "src"));
    writeFileSync(join(base, "src", "app.ts"), "old\n");
    writeFileSync(join(base, "package.json"), "{}\n");

    copyGitFreeTree(base, proposed);
    copyGitFreeTree(base, destination);
    writeFileSync(join(proposed, "src", "app.ts"), "new\n");
    const artifact = inspectVerifiedArtifact(base, proposed, ["src/app.ts"]);
    assert.match(artifact.digest, /^[a-f0-9]{64}$/);
    applyVerifiedArtifact(destination, proposed, artifact);
    assertAppliedArtifact(destination, proposed, artifact);
    assert.equal(readFileSync(join(destination, "src", "app.ts"), "utf8"), "new\n");
    assert.throws(
      () => {
        writeFileSync(join(proposed, "generated.txt"), "test artifact");
        inspectVerifiedArtifact(base, proposed, ["src/app.ts"]);
      },
      /unexpected: generated\.txt/
    );
  });
});

test("artifact paths reject traversal, non-normal forms, and symlinks", () => {
  for (const path of ["../escape", "/absolute", "a/../b", "a/./b", "a//b", ".git/config", "node_modules/x"]) {
    assert.throws(() => normalizeArtifactPath(path), /artifact path/i);
  }
  withTrees(({ base, proposed, destination }) => {
    mkdirSync(join(base, "src"));
    writeFileSync(join(base, "src", "safe.ts"), "old\n");
    copyGitFreeTree(base, proposed);
    copyGitFreeTree(base, destination);
    rmSync(join(proposed, "src", "safe.ts"));
    symlinkSync("/tmp/does-not-exist-api-migrator", join(proposed, "src", "safe.ts"));
    assert.throws(() => inspectVerifiedArtifact(base, proposed, ["src/safe.ts"]), /symlink|not a regular file/);
  });
});

test("destination dangling symlinks are never followed", () => {
  withTrees(({ base, proposed, destination }) => {
    mkdirSync(join(base, "src"));
    writeFileSync(join(base, "src", "safe.ts"), "old\n");
    copyGitFreeTree(base, proposed);
    copyGitFreeTree(base, destination);
    writeFileSync(join(proposed, "src", "safe.ts"), "new\n");
    const artifact = inspectVerifiedArtifact(base, proposed, ["src/safe.ts"]);
    rmSync(join(destination, "src", "safe.ts"));
    symlinkSync("/tmp/does-not-exist-api-migrator", join(destination, "src", "safe.ts"));
    assert.throws(() => applyVerifiedArtifact(destination, proposed, artifact), /symlink|non-regular/);
  });
});

function withTrees(run: (roots: { base: string; proposed: string; destination: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "api-migrator-artifact-test-"));
  const roots = {
    base: join(root, "base"),
    proposed: join(root, "proposed"),
    destination: join(root, "destination"),
  };
  mkdirSync(roots.base);
  try { run(roots); } finally { rmSync(root, { recursive: true, force: true }); }
}
