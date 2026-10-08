import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyFixtureIdentity } from "../../../scripts/test-git-identity.mjs";
import type { Manifest, MigrationReport } from "@api-migrator/engine";
import { copyGitFreeTree } from "../src/artifact.js";
import {
  createPreviewMigrateRepoDependencies,
  migrateRepo,
} from "../src/github.js";
import { captureLocalPreviewExecution } from "../src/preview-source.js";

const manifest: Manifest = {
  name: "Inngest v3 to v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  runtime: {
    node: {
      minimumMajor: 20,
      profile: "node22-bookworm-slim-2026-07",
      packageJson: "package.json",
      dockerfile: "Dockerfile",
    },
  },
  package: { name: "inngest", from: "^3", to: "^4" },
  peerFloors: [],
};

const manifestJson = "{\"name\":\"Inngest v3 to v4\",\"package\":{\"from\":\"^3\",\"name\":\"inngest\",\"to\":\"^4\"},\"peerFloors\":[],\"provider\":\"inngest\",\"runtime\":{\"node\":{\"dockerfile\":\"Dockerfile\",\"minimumMajor\":20,\"packageJson\":\"package.json\",\"profile\":\"node22-bookworm-slim-2026-07\"}},\"transformSet\":\"inngest-v3-to-v4\"}";
const EXPECTED_BASE_SHA = "72920f83f33b9706eaa0d643eae35f4e18b229e1";
const EXPECTED_TREE_SHA = "48479afc6120f8440951aa958a052b651ffbd699";
const EXPECTED_MANIFEST_DIGEST = "sha256:9d7bce547e77b82237978312f48b73a06d51ef410c634ad455b4d6e11f535bcf";
const EXPECTED_SOURCE_DIGEST = "sha256:8a8b925739e4c6bc33d9731f08d9bace28f7a1e6d360f07ce7a33cc8168ec6b7";

const gitEnvironment = {
  PATH: process.env.PATH,
  GIT_AUTHOR_NAME: "Abhishekpundir23",
  GIT_AUTHOR_EMAIL: "74260202+Abhishekpundir23@users.noreply.github.com",
  GIT_AUTHOR_DATE: "2025-01-02T03:04:05Z",
  GIT_COMMITTER_NAME: "Abhishekpundir23",
  GIT_COMMITTER_EMAIL: "74260202+Abhishekpundir23@users.noreply.github.com",
  GIT_COMMITTER_DATE: "2025-01-02T03:04:05Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = gitEnvironment): string {
  const committing = args[0] === "commit";
  if (committing) verifyFixtureIdentity(cwd, env);
  const output = execFileSync("git", ["-c", "commit.gpgSign=false", ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (committing) verifyFixtureIdentity(cwd, env, true);
  return output;
}

function repositoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "api-migrator-preview-pipeline-test-"));
  git(root, ["init", "--initial-branch=main"]);
  writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
  git(root, ["add", "index.ts"]);
  git(root, ["commit", "-m", "fixture"]);
  assert.equal(git(root, ["rev-parse", "HEAD"]), EXPECTED_BASE_SHA);
  assert.equal(git(root, ["rev-parse", "HEAD^{tree}"]), EXPECTED_TREE_SHA);
  return root;
}

function verifiedReport(): MigrationReport {
  return {
    manifest: { name: manifest.name, provider: manifest.provider },
    scannedFiles: ["index.ts"],
    changedFiles: [],
    entries: [],
    verification: {
      ok: true,
      baseline: [],
      after: [],
      introduced: [],
      skipped: false,
      runner: "controlled-test",
      checks: {
        install: { status: "passed", command: "install", exitCode: 0, output: "raw install" },
        typecheck: { status: "passed", command: "typecheck", exitCode: 0, output: "raw typecheck" },
        test: { status: "passed", command: "test", exitCode: 0, output: "raw test" },
        lint: { status: "passed", command: "lint", exitCode: 0, output: "raw lint" },
        runtime: { status: "passed", command: "runtime", exitCode: 0, output: "raw runtime" },
      },
    },
    summary: { applied: 0, review: 0, changedFiles: 0, introducedErrors: 0, verified: true },
  };
}

function cloneFixture(source: string, destinationPath: string, environment: NodeJS.ProcessEnv): void {
  execFileSync(
    "git",
    ["-c", "commit.gpgSign=false", "clone", "--quiet", "--branch", "main", "--single-branch", "--", source, destinationPath],
    {
      env: {
        ...environment,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

test("migrateRepo captures the same canonical source identity for GitHub slug case variants", async () => {
  const source = repositoryFixture();
  const events: string[] = [];
  try {
    const dependencies = createPreviewMigrateRepoDependencies({
      cloneRepository({ destinationPath, environment }) {
        events.push("clone");
        cloneFixture(source, destinationPath, environment);
      },
      async captureExecution(input) {
        events.push("capture");
        assert.equal(git(input.checkoutPath, ["status", "--porcelain"]), "");
        assert.equal(readFileSync(join(input.checkoutPath, "index.ts"), "utf8"), "export const value = 1;\n");
        return captureLocalPreviewExecution(input, {
          repositoryClient: {
            repos: {
              get: async () => ({
                data: { full_name: "Owner/Repo", id: 123, owner: { id: 456 } },
              }),
            },
          },
        });
      },
      copyRepository(sourcePath, destinationPath) {
        events.push("copy");
        copyGitFreeTree(sourcePath, destinationPath);
      },
      async runMigration(_manifest, repoPath) {
        events.push("migration");
        assert.equal(existsSync(join(repoPath, ".git")), false);
        assert.equal(readFileSync(join(repoPath, "index.ts"), "utf8"), "export const value = 1;\n");
        return { report: verifiedReport(), requiredVerificationFiles: [] };
      },
    });

    const results = [];
    for (const slug of ["owner/repo", "Owner/Repo"]) {
      results.push(await migrateRepo({
        slug,
        manifest,
        manifestJson,
        baseBranch: "main",
        publication: { mode: "preview" },
      }, dependencies));
    }

    assert.deepEqual(events, [
      "clone", "capture", "copy", "migration",
      "clone", "capture", "copy", "migration",
    ]);
    for (const result of results) {
      assert.equal(result.changed, false);
      assert.equal(result.publication.status, "no_changes");
      assert.equal("previewBundle" in result, false);
    }
    assert.deepEqual(results[0]!.report.previewExecution, results[1]!.report.previewExecution);
    assert.deepEqual(results[1]!.report.previewExecution, {
      schemaVersion: 1,
      kind: "local-preview",
      source: {
        repository: { slug: "owner/repo", id: 123, ownerId: 456 },
        base: { branch: "main", sha: EXPECTED_BASE_SHA, treeSha: EXPECTED_TREE_SHA },
        manifestDigest: EXPECTED_MANIFEST_DIGEST,
        sourceArchiveDigest: EXPECTED_SOURCE_DIGEST,
      },
    });
    assert.equal(results[1]!.report.verification.checks.install.output, "");
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

// Catches export after checkout cleanup, synthetic metadata, or patch leakage into ordinary results.
test("explicit preview export binds the actual staged candidate and survives disposable checkout cleanup", async () => {
  const source = repositoryFixture();
  const privateParent = mkdtempSync(join(tmpdir(), "preview-integration-bundle-"));
  let checkoutPath = "";
  try {
    const dependencies = createPreviewMigrateRepoDependencies({
      cloneRepository({ destinationPath, environment }) {
        checkoutPath = destinationPath;
        cloneFixture(source, destinationPath, environment);
      },
      async captureExecution() {
        return { schemaVersion: 1, kind: "local-preview", source: null, unavailableReason: "repository_identity_unavailable" };
      },
      copyRepository: copyGitFreeTree,
      async runMigration(_manifest, repoPath) {
        writeFileSync(join(repoPath, "index.ts"), "export const value = 2; // PRIVATE_SOURCE_SENTINEL\n");
        const report = verifiedReport();
        report.changedFiles = ["index.ts"];
        report.summary.applied = 1;
        report.summary.changedFiles = 1;
        return { report, requiredVerificationFiles: [] };
      },
    });
    const result = await migrateRepo({ slug: "owner/repo", manifest, manifestJson, baseBranch: "main",
      previewBundlePath: join(privateParent, "bundle") }, dependencies);
    assert.equal(result.changed, true);
    assert.equal(result.publication.status, "preview_ready");
    assert.ok(result.previewBundle);
    assert.equal(result.previewBundle.receipt.preflightId, result.preflightId);
    assert.equal(result.previewBundle.receipt.candidateTreeSha, result.publication.candidateTreeSha);
    assert.equal(result.previewBundle.receipt.artifactDigest, result.artifactDigest);
    assert.equal(result.previewBundle.receipt.baseSha, EXPECTED_BASE_SHA);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SOURCE_SENTINEL|diff --git/);
    assert.equal(existsSync(checkoutPath), false);
    const reconstruction = join(privateParent, "reconstruction");
    cloneFixture(source, reconstruction, gitEnvironment);
    git(reconstruction, ["apply", "--index", "--", join(result.previewBundle.path, "candidate.patch")]);
    assert.equal(git(reconstruction, ["write-tree"]), result.publication.candidateTreeSha);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(privateParent, { recursive: true, force: true });
  }
});

// Catches exporting only successful changed previews, or silently promoting blocked outcomes.
test("explicit export retains blocked and no-change preview outcomes", async () => {
  const source = repositoryFixture();
  const privateParent = mkdtempSync(join(tmpdir(), "preview-integration-status-"));
  try {
    for (const status of ["no_changes", "blocked"] as const) {
      const dependencies = createPreviewMigrateRepoDependencies({
        cloneRepository({ destinationPath, environment }) { cloneFixture(source, destinationPath, environment); },
        async captureExecution() {
          return { schemaVersion: 1, kind: "local-preview", source: null, unavailableReason: "repository_identity_unavailable" };
        },
        copyRepository: copyGitFreeTree,
        async runMigration(_manifest, repoPath) {
          const report = verifiedReport();
          if (status === "blocked") {
            writeFileSync(join(repoPath, "index.ts"), "export const value = 2;\n");
            report.changedFiles = ["index.ts"];
            report.summary.changedFiles = 1;
            report.summary.review = 1;
          }
          return { report, requiredVerificationFiles: [] };
        },
      });
      const result = await migrateRepo({ slug: "owner/repo", manifest, baseBranch: "main",
        previewBundlePath: join(privateParent, status) }, dependencies);
      assert.equal(result.publication.status, status);
      assert.ok(result.previewBundle);
      assert.equal(result.previewBundle.receipt.previewStatus, status);
      assert.deepEqual(result.previewBundle.receipt.blockers, result.publication.blockers.map((b) => b.message));
      assert.equal(result.previewBundle.receipt.authorizesPublication, false);
      if (status === "no_changes") {
        assert.equal(readFileSync(join(result.previewBundle.path, "candidate.patch")).length, 0);
        assert.equal(result.previewBundle.receipt.candidateTreeSha, EXPECTED_TREE_SHA);
      } else assert.equal(result.previewBundle.receipt.blockers.length, 1);
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(privateParent, { recursive: true, force: true });
  }
});

// Sensitive-path preconditions must execute before any clone, capture, auth, or migration callback.
test("bundle paths and privileged usage are rejected before external preview callbacks or auth", async () => {
  const privateParent = mkdtempSync(join(tmpdir(), "preview-integration-reject-"));
  let callbacks = 0;
  const dependencies = createPreviewMigrateRepoDependencies({
    cloneRepository() { callbacks++; throw new Error("external callback reached"); },
    async captureExecution() { callbacks++; throw new Error("external callback reached"); },
    copyRepository() { callbacks++; throw new Error("external callback reached"); },
    async runMigration() { callbacks++; throw new Error("external callback reached"); },
  });
  try {
    mkdirSync(join(privateParent, "existing"));
    for (const path of ["relative", join(privateParent, "existing"), join(privateParent, "missing", "new")]) {
      await assert.rejects(() => migrateRepo({ slug: "owner/repo", manifest, previewBundlePath: path }, dependencies), /preview bundle/i);
      assert.equal(callbacks, 0);
    }
    const now = Date.now();
    const privileged = [
      { publication: { mode: "publish", approvedBy: "operator", preflightId: `pf_${"a".repeat(64)}`,
        previewCompletedAt: now - 1_000, ownerAuthorizationEnvelope: "{}", ownerChallengeDigest: `sha256:${"b".repeat(64)}` } },
      { ownerChallenge: { preflightId: `pf_${"a".repeat(64)}`, artifactDigest: `sha256:${"b".repeat(64)}`,
        candidateTreeSha: "c".repeat(40), previewCompletedAt: now - 1_000, previewReceiptExpiresAt: now + 30_000 } },
      { runnerAttestation: {} as never },
    ];
    for (const input of privileged) {
      // Without the preview dependency seam this also proves the export's own privileged gate.
      await assert.rejects(() => migrateRepo({ slug: "owner/repo", manifest, previewBundlePath: join(privateParent, "new"),
        ...input } as never), /preview bundle.*plain preview/i);
    }
    assert.equal(existsSync(join(privateParent, "new")), false);
    assert.equal(callbacks, 0);
  } finally { rmSync(privateParent, { recursive: true, force: true }); }
});

test("explicit capture unavailability remains attached and does not stop migration", async () => {
  const source = repositoryFixture();
  const events: string[] = [];
  try {
    const dependencies = createPreviewMigrateRepoDependencies({
      cloneRepository({ destinationPath, environment }) {
        cloneFixture(source, destinationPath, environment);
      },
      async captureExecution(input) {
        events.push("capture");
        return captureLocalPreviewExecution(input, {
          repositoryClient: {
            repos: { get: async () => { throw new Error("metadata unavailable"); } },
          },
        });
      },
      copyRepository(sourcePath, destinationPath) {
        events.push("copy");
        copyGitFreeTree(sourcePath, destinationPath);
      },
      async runMigration() {
        events.push("migration");
        return { report: verifiedReport(), requiredVerificationFiles: [] };
      },
    });

    const result = await migrateRepo({
      slug: "owner/repo",
      manifest,
      manifestJson,
      baseBranch: "main",
    }, dependencies);

    assert.deepEqual(events, ["capture", "copy", "migration"]);
    assert.deepEqual(result.report.previewExecution, {
      schemaVersion: 1,
      kind: "local-preview",
      source: null,
      unavailableReason: "repository_identity_unavailable",
    });
    assert.equal(result.publication.status, "no_changes");
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("preview dependency seam rejects publish, owner challenge, and attestation before callbacks", async () => {
  let callbackReached = false;
  const dependencies = createPreviewMigrateRepoDependencies({
    cloneRepository() { callbackReached = true; },
    async captureExecution() {
      callbackReached = true;
      throw new Error("unreachable");
    },
    copyRepository() { callbackReached = true; },
    async runMigration() {
      callbackReached = true;
      throw new Error("unreachable");
    },
  });
  const now = Date.now();
  const privilegedInputs = [
    {
      publication: {
        mode: "publish",
        approvedBy: "operator",
        preflightId: `pf_${"a".repeat(64)}`,
        previewCompletedAt: now - 1_000,
        ownerAuthorizationEnvelope: "{}",
        ownerChallengeDigest: `sha256:${"b".repeat(64)}`,
      },
    },
    {
      ownerChallenge: {
        preflightId: `pf_${"a".repeat(64)}`,
        artifactDigest: `sha256:${"b".repeat(64)}`,
        candidateTreeSha: "c".repeat(40),
        previewCompletedAt: now - 1_000,
        previewReceiptExpiresAt: now + 30_000,
      },
    },
    { runnerAttestation: {} as never },
  ];

  for (const privileged of privilegedInputs) {
    await assert.rejects(
      () => migrateRepo({
        slug: "owner/repo",
        manifest,
        manifestJson,
        baseBranch: "main",
        ...privileged,
      } as never, dependencies),
      /preview-only.*dependencies/i
    );
  }
  assert.equal(callbackReached, false);
});
