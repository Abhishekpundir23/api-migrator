import assert from "node:assert/strict";
import test from "node:test";
import { validateLocalPreviewExecution } from "../src/preview-evidence.js";

const captured = {
  schemaVersion: 1,
  kind: "local-preview",
  source: {
    repository: { slug: "owner/repo", id: 123, ownerId: 456 },
    base: {
      branch: "release/v4",
      sha: "a".repeat(40),
      treeSha: "b".repeat(40),
    },
    manifestDigest: `sha256:${"c".repeat(64)}`,
    sourceArchiveDigest: `sha256:${"d".repeat(64)}`,
  },
} as const;

test("validates captured and explicitly unavailable local preview evidence as detached data", () => {
  const valid = structuredClone(captured);
  const result = validateLocalPreviewExecution(valid);
  assert.deepEqual(result, captured);
  assert.notEqual(result, valid);
  assert.notEqual(result.source, valid.source);
  if (result.source && valid.source) {
    assert.notEqual(result.source.repository, valid.source.repository);
    assert.notEqual(result.source.base, valid.source.base);
    (valid.source.repository as { slug: string }).slug = "changed/repo";
    assert.equal(result.source.repository.slug, "owner/repo");
  }

  for (const unavailableReason of [
    "repository_identity_unavailable",
    "source_bundle_unavailable",
  ] as const) {
    assert.deepEqual(validateLocalPreviewExecution({
      schemaVersion: 1,
      kind: "local-preview",
      source: null,
      unavailableReason,
    }), {
      schemaVersion: 1,
      kind: "local-preview",
      source: null,
      unavailableReason,
    });
  }
});

test("canonicalizes GitHub repository case without changing case-sensitive branch identity", () => {
  const mixedCase = structuredClone(captured);
  (mixedCase.source.repository as { slug: string }).slug = "Owner/Repo";
  (mixedCase.source.base as { branch: string }).branch = "Release/V4";

  const result = validateLocalPreviewExecution(mixedCase);

  assert.equal(result.source?.repository.slug, "owner/repo");
  assert.equal(result.source?.base.branch, "Release/V4");
});

test("rejects malformed versions, kinds, discriminants, identities, and unknown fields", () => {
  const mutations: unknown[] = [
    null,
    { ...captured, schemaVersion: 2 },
    { ...captured, kind: "verified-runner" },
    { ...captured, extra: true },
    { ...captured, unavailableReason: "source_bundle_unavailable" },
    { schemaVersion: 1, kind: "local-preview", source: null },
    { schemaVersion: 1, kind: "local-preview", source: null, unavailableReason: "api_error" },
    { ...captured, source: { ...captured.source, extra: true } },
    { ...captured, source: { ...captured.source, repository: { ...captured.source.repository, id: 0 } } },
    { ...captured, source: { ...captured.source, repository: { ...captured.source.repository, ownerId: Number.MAX_SAFE_INTEGER + 1 } } },
    { ...captured, source: { ...captured.source, repository: { ...captured.source.repository, slug: "https://github.com/owner/repo" } } },
    { ...captured, source: { ...captured.source, base: { ...captured.source.base, branch: "bad..branch" } } },
    { ...captured, source: { ...captured.source, base: { ...captured.source.base, sha: "A".repeat(40) } } },
    { ...captured, source: { ...captured.source, base: { ...captured.source.base, treeSha: "b".repeat(64) } } },
    { ...captured, source: { ...captured.source, manifestDigest: `sha256:${"C".repeat(64)}` } },
    { ...captured, source: { ...captured.source, sourceArchiveDigest: "d".repeat(64) } },
  ];

  for (const value of mutations) {
    assert.throws(() => validateLocalPreviewExecution(value), /local preview|repository|branch|object|digest/i);
  }
});
