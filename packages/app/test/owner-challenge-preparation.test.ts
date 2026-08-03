import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSha256,
  type ExpectedOwnerAuthorizationBindings,
} from "../src/owner-authorization.js";
import {
  prepareOwnerAuthorizationChallenge,
  validateOwnerChallengePreparationRequest,
} from "../src/owner-challenge-preparation.js";

const NOW = 2_000_000_000_000;
const digest = (label: string) =>
  `sha256:${Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64)}`;

function bindings(): ExpectedOwnerAuthorizationBindings {
  return {
    pilotId: "pilot_owner_challenge",
    approvalEvidenceDigest: digest("approval"),
    preRunAuthorizationDigest: digest("pre-run"),
    previewCompletedAt: NOW - 1_000,
    authorizationExpiresAt: NOW + 60_000,
    repository: { slug: "example/repo", id: 10, ownerId: 20 },
    github: { appId: 30, installationId: 40 },
    base: { branch: "main", sha: "a".repeat(40) },
    engine: { tag: "v0.1.0-pilot", commit: "b".repeat(40) },
    manifest: { byteLength: 123, digest: digest("manifest") },
    preview: {
      preflightId: `pf_${"c".repeat(64)}`,
      artifactDigest: digest("artifact"),
      candidateBranch: "codex/api-migrator/change",
      candidateTreeSha: "d".repeat(40),
      findingsDigest: canonicalSha256([]),
      resolutionsDigest: canonicalSha256([]),
      commandScopeDigest: digest("commands"),
      runnerAttestationDigest: digest("runner"),
      rulesetDigest: digest("ruleset"),
      requiredCiDigest: digest("ci"),
    },
    allowedActions: ["create_branch", "create_pull_request"],
    pullRequestNumber: null,
  };
}

function request(value = bindings()) {
  return {
    preflightId: value.preview.preflightId,
    artifactDigest: value.preview.artifactDigest.slice("sha256:".length),
    candidateTreeSha: value.preview.candidateTreeSha,
    previewCompletedAt: value.previewCompletedAt,
    previewReceiptExpiresAt: NOW + 30_000,
  };
}

test("prepares one short-lived canonical challenge from the exact reviewed preview", () => {
  const expected = bindings();
  const prepared = prepareOwnerAuthorizationChallenge({
    request: request(expected),
    current: {
      preflightId: expected.preview.preflightId,
      artifactDigest: expected.preview.artifactDigest.slice("sha256:".length),
      candidateTreeSha: expected.preview.candidateTreeSha,
    },
    expected,
    blockers: [],
    now: NOW,
  });
  assert.equal(prepared.challenge.bindings.preview.preflightId, expected.preview.preflightId);
  assert.equal(prepared.challenge.expiresAt, NOW + 30_000);
  assert.equal(prepared.challenge.challengeDigest, prepared.challengeDigest);
  assert.deepEqual(JSON.parse(prepared.challengeJson), prepared.challenge);
});

test("fails closed for stale preview fields, blockers, expiry, and unknown input", () => {
  const expected = bindings();
  const base = {
    request: request(expected),
    current: {
      preflightId: expected.preview.preflightId,
      artifactDigest: expected.preview.artifactDigest,
      candidateTreeSha: expected.preview.candidateTreeSha,
    },
    expected,
    blockers: [],
    now: NOW,
  } as const;

  for (const [label, mutate] of [
    ["preflight", (value: ReturnType<typeof request>) => { value.preflightId = `pf_${"e".repeat(64)}`; }],
    ["artifact", (value: ReturnType<typeof request>) => { value.artifactDigest = "f".repeat(64); }],
    ["tree", (value: ReturnType<typeof request>) => { value.candidateTreeSha = "e".repeat(40); }],
    ["timestamp", (value: ReturnType<typeof request>) => { value.previewCompletedAt -= 1; }],
  ] as const) {
    const changed = request(expected);
    mutate(changed);
    assert.throws(
      () => prepareOwnerAuthorizationChallenge({ ...base, request: changed }),
      /stale|runtime bindings/,
      label
    );
  }

  assert.throws(
    () => prepareOwnerAuthorizationChallenge({
      ...base,
      blockers: [{ code: "manual_review_required", message: "review" }],
    }),
    /blocked previews/
  );
  assert.throws(
    () => validateOwnerChallengePreparationRequest({
      ...request(expected),
      previewReceiptExpiresAt: NOW,
    }, NOW),
    /expired/
  );
  assert.throws(
    () => validateOwnerChallengePreparationRequest({ ...request(expected), extra: true }, NOW),
    /unknown or missing/
  );
});

test("caps the challenge at the earlier preview-receipt or owner-authorization deadline", () => {
  const expected = bindings();
  const current = {
    preflightId: expected.preview.preflightId,
    artifactDigest: expected.preview.artifactDigest,
    candidateTreeSha: expected.preview.candidateTreeSha,
  };
  const receiptBound = prepareOwnerAuthorizationChallenge({
    request: { ...request(expected), previewReceiptExpiresAt: NOW + 5_000 },
    current,
    expected,
    blockers: [],
    now: NOW,
  });
  assert.equal(receiptBound.expiresAt, NOW + 5_000);

  const authorizationBoundExpected = {
    ...expected,
    authorizationExpiresAt: NOW + 2_000,
  };
  const authorizationBound = prepareOwnerAuthorizationChallenge({
    request: request(authorizationBoundExpected),
    current,
    expected: authorizationBoundExpected,
    blockers: [],
    now: NOW,
  });
  assert.equal(authorizationBound.expiresAt, NOW + 2_000);
});
