import test from "node:test";
import assert from "node:assert/strict";
import type { Manifest } from "@api-migrator/engine";
import {
  defaultMigrationBranch,
  githubDefaultCloneArgs,
  githubCloneArgs,
  githubCloneUrl,
  parseRepositorySlug,
  resolveMigrationBranch,
  validateBranchName,
} from "../src/repository.js";

const manifest: Manifest = {
  name: "Inngest v3 to v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  package: { name: "inngest", from: "^3", to: "^4" },
  peerFloors: [],
};

test("accepts an exact GitHub owner/repo slug and derives the URL", () => {
  const repo = parseRepositorySlug("Example-Org/api_repo.js");
  assert.deepEqual(repo, {
    owner: "Example-Org",
    repo: "api_repo.js",
    slug: "Example-Org/api_repo.js",
  });
  assert.equal(githubCloneUrl(repo), "https://github.com/Example-Org/api_repo.js.git");
});

test("rejects URL-like, ambiguous, and non-canonical repository inputs", () => {
  for (const value of [
    "https://github.com/owner/repo",
    "owner/repo.git",
    "owner/repo/branch",
    " owner/repo",
    "owner/repo?x=1",
    "-owner/repo",
    "owner--name/repo",
    "owner/..",
    "owner\\repo",
  ]) {
    assert.throws(() => parseRepositorySlug(value), /Repository/);
  }
});

test("clone arguments are credential-free", () => {
  const secret = "ghp_super_secret_token_123";
  const args = githubCloneArgs(parseRepositorySlug("owner/repo"), "main");
  assert.deepEqual(args, [
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--branch",
    "main",
    "https://github.com/owner/repo.git",
    "repo",
  ]);
  assert.equal(args.join(" ").includes(secret), false);
  assert.equal(args.join(" ").includes("@github.com"), false);
  assert.deepEqual(githubDefaultCloneArgs(parseRepositorySlug("owner/repo")), [
    "clone", "--depth", "1", "--single-branch", "https://github.com/owner/repo.git", "repo",
  ]);
});

test("manifest branches are stable, migration/base-specific, owned, and valid", () => {
  const baseSha = "a".repeat(40);
  const artifactDigest = "b".repeat(64);
  const first = defaultMigrationBranch(manifest, "main", baseSha, artifactDigest);
  const second = defaultMigrationBranch(manifest, "main", baseSha, artifactDigest);
  const changed = defaultMigrationBranch(
    { ...manifest, name: "Inngest v3 to v4 patch 2" },
    "main",
    baseSha,
    artifactDigest
  );
  const otherBase = defaultMigrationBranch(manifest, "release", baseSha, artifactDigest);
  const otherCommit = defaultMigrationBranch(manifest, "main", "c".repeat(40), artifactDigest);
  const otherArtifact = defaultMigrationBranch(manifest, "main", baseSha, "d".repeat(64));
  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.notEqual(first, otherBase);
  assert.notEqual(first, otherCommit);
  assert.notEqual(first, otherArtifact);
  assert.match(first, /^codex\/api-migrator\//);
  assert.equal(validateBranchName(first), first);
  assert.equal(resolveMigrationBranch(manifest, "main", baseSha, artifactDigest), first);
  assert.equal(resolveMigrationBranch(manifest, "main", baseSha, artifactDigest, first), first);
  assert.throws(() => resolveMigrationBranch(manifest, "main", baseSha, artifactDigest, "main"), /owned branch/);
  assert.throws(
    () => resolveMigrationBranch(manifest, "main", baseSha, artifactDigest, "codex/api-migrator/unrelated"),
    /owned branch/
  );
  for (const invalid of ["-danger", "refs/../main", "feature.lock", "bad branch", "x@{y", ".hidden/x"]) {
    assert.throws(() => validateBranchName(invalid), /Invalid git branch/);
  }
});
