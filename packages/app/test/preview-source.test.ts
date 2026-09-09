import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuthResult } from "../src/auth.js";
import { captureLocalPreviewExecution } from "../src/preview-source.js";
import {
  createSourceBundle,
  MAX_CANONICAL_MANIFEST_BYTES,
} from "../src/runner-source-bundle.js";

const manifestJson = '{"name":"Migration","provider":"inngest"}';

function git(path: string, args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgSign=false", ...args], {
    cwd: path,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: "Preview Source Test",
      GIT_AUTHOR_EMAIL: "preview-source@example.invalid",
      GIT_COMMITTER_NAME: "Preview Source Test",
      GIT_COMMITTER_EMAIL: "preview-source@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  }).trim();
}

function fixture(): { path: string; baseSha: string; treeSha: string } {
  const path = mkdtempSync(join(tmpdir(), "api-migrator-preview-source-test-"));
  git(path, ["init", "--initial-branch=main"]);
  writeFileSync(join(path, "index.ts"), "export const value = 1;\n");
  git(path, ["add", "index.ts"]);
  git(path, ["commit", "-m", "fixture"]);
  return {
    path,
    baseSha: git(path, ["rev-parse", "HEAD"]),
    treeSha: git(path, ["rev-parse", "HEAD^{tree}"]),
  };
}

function client(data: { full_name?: string; id?: number; ownerId?: number } = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    repositoryClient: {
      repos: {
        get: async (options: unknown) => {
          calls.push(options);
          return {
            data: {
              full_name: data.full_name ?? "Owner/Repo",
              id: data.id ?? 123,
              owner: { id: data.ownerId ?? 456 },
            },
          };
        },
      },
    },
  };
}

function captureInput(repo: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  return {
    checkoutPath: repo.path,
    repositorySlug: "owner/repo",
    baseBranch: "main",
    baseSha: repo.baseSha,
    treeSha: repo.treeSha,
    manifestJson,
    auth: null,
    ...overrides,
  };
}

test("captures exact canonical bundle identity with one bounded repository metadata read", async () => {
  const repo = fixture();
  try {
    const transport = client();
    const result = await captureLocalPreviewExecution(captureInput(repo), transport);
    const expected = createSourceBundle({
      checkoutPath: repo.path,
      repository: { slug: "owner/repo", id: 123, ownerId: 456 },
      base: { branch: "main", sha: repo.baseSha, treeSha: repo.treeSha },
      manifestJson,
    });
    assert.deepEqual(result, {
      schemaVersion: 1,
      kind: "local-preview",
      source: {
        repository: { slug: "owner/repo", id: 123, ownerId: 456 },
        base: { branch: "main", sha: repo.baseSha, treeSha: repo.treeSha },
        manifestDigest: expected.header.manifest.digest,
        sourceArchiveDigest: expected.digest,
      },
    });
    assert.deepEqual(transport.calls, [{ owner: "owner", repo: "repo", request: { timeout: 10_000 } }]);
    assert.equal("bytes" in (result.source ?? {}), false);
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
});

test("source, base, canonical manifest, and deployment changes produce different identities", async () => {
  const repo = fixture();
  try {
    const first = await captureLocalPreviewExecution(captureInput(repo), client());
    const differentBranch = await captureLocalPreviewExecution(
      captureInput(repo, { baseBranch: "release/v4" }),
      client()
    );
    const differentManifest = await captureLocalPreviewExecution(
      captureInput(repo, { manifestJson: '{"name":"Other","provider":"inngest"}' }),
      client()
    );
    const differentDeployment = await captureLocalPreviewExecution(
      captureInput(repo, { manifestJson: '{"deployment":{"kind":"long-running"},"name":"Migration","provider":"inngest"}' }),
      client()
    );

    writeFileSync(join(repo.path, "index.ts"), "export const value = 2;\n");
    git(repo.path, ["add", "index.ts"]);
    git(repo.path, ["commit", "-m", "source change"]);
    const changedSourceFixture = {
      path: repo.path,
      baseSha: git(repo.path, ["rev-parse", "HEAD"]),
      treeSha: git(repo.path, ["rev-parse", "HEAD^{tree}"]),
    };
    const differentSource = await captureLocalPreviewExecution(captureInput(changedSourceFixture), client());

    const digests = [first, differentBranch, differentManifest, differentDeployment, differentSource]
      .map((entry) => entry.source?.sourceArchiveDigest);
    assert.equal(new Set(digests).size, digests.length);
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
});

test("metadata failures, mismatches, unsafe IDs, and pinned App identity drift never fabricate identity", async () => {
  const repo = fixture();
  try {
    const pinnedAuth = {
      token: "read-token",
      mode: "github-app",
      capability: "read",
      githubApp: {
        appId: 1,
        appSlug: "migrator",
        installationId: 2,
        repositoryId: 123,
        repositoryOwnerId: 456,
        repositorySlug: "owner/repo",
      },
    } as AuthResult;
    const unavailable = {
      schemaVersion: 1,
      kind: "local-preview",
      source: null,
      unavailableReason: "repository_identity_unavailable",
    };

    for (const repositoryClient of [
      { repos: { get: async () => { throw new Error("secret-bearing API error"); } } },
      client({ full_name: "other/repo" }).repositoryClient,
      client({ id: 0 }).repositoryClient,
      client({ ownerId: Number.MAX_SAFE_INTEGER + 1 }).repositoryClient,
      client({ id: 124 }).repositoryClient,
      client({ ownerId: 457 }).repositoryClient,
    ]) {
      assert.deepEqual(
        await captureLocalPreviewExecution(captureInput(repo, { auth: pinnedAuth }), { repositoryClient }),
        unavailable
      );
    }
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
});

test("dirty, symlinked, and oversized source bundles remain explicit unavailable local previews", async () => {
  const unavailable = {
    schemaVersion: 1,
    kind: "local-preview",
    source: null,
    unavailableReason: "source_bundle_unavailable",
  };

  const dirty = fixture();
  try {
    writeFileSync(join(dirty.path, "index.ts"), "dirty\n");
    assert.deepEqual(await captureLocalPreviewExecution(captureInput(dirty), client()), unavailable);
  } finally {
    rmSync(dirty.path, { recursive: true, force: true });
  }

  const symlinked = fixture();
  try {
    symlinkSync("index.ts", join(symlinked.path, "linked.ts"));
    git(symlinked.path, ["add", "linked.ts"]);
    git(symlinked.path, ["commit", "-m", "symlink"]);
    const linkedFixture = {
      path: symlinked.path,
      baseSha: git(symlinked.path, ["rev-parse", "HEAD"]),
      treeSha: git(symlinked.path, ["rev-parse", "HEAD^{tree}"]),
    };
    assert.deepEqual(await captureLocalPreviewExecution(captureInput(linkedFixture), client()), unavailable);
  } finally {
    rmSync(symlinked.path, { recursive: true, force: true });
  }

  const oversized = fixture();
  try {
    assert.deepEqual(await captureLocalPreviewExecution(captureInput(oversized, {
      manifestJson: `{"padding":"${"x".repeat(MAX_CANONICAL_MANIFEST_BYTES)}"}`,
    }), client()), unavailable);
  } finally {
    rmSync(oversized.path, { recursive: true, force: true });
  }
});
