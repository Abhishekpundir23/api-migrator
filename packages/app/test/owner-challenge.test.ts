import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalSha256,
  type ExpectedOwnerAuthorizationBindings,
} from "../src/owner-authorization.js";
import {
  createOwnerAuthorizationChallenge,
  OWNER_AUTHORIZATION_CHALLENGE_MAX_AGE_MS,
  parseOwnerAuthorizationChallenge,
} from "../src/owner-challenge.js";
import { canonicalJson, parseCanonicalJson } from "../src/canonical-json.js";

const NOW = 2_000_000_000_000;
const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function bindings(): ExpectedOwnerAuthorizationBindings {
  return {
    pilotId: "pilot-sandbox-v1",
    approvalEvidenceDigest: digest("approval"),
    preRunAuthorizationDigest: digest("pre-run"),
    previewCompletedAt: NOW - 1_000,
    authorizationExpiresAt: NOW + 60 * 60_000,
    repository: {
      slug: "example-org/example-repo",
      id: 1_234_567,
      ownerId: 7_654_321,
    },
    github: {
      appId: 123_456,
      installationId: 654_321,
    },
    base: {
      branch: "main",
      sha: "a".repeat(40),
    },
    engine: {
      tag: "v0.1.0-pilot",
      commit: "b".repeat(40),
    },
    manifest: {
      byteLength: 1_024,
      digest: digest("manifest"),
    },
    preview: {
      preflightId: `pf_${"c".repeat(64)}`,
      artifactDigest: digest("artifact"),
      candidateBranch: "codex/api-migrator/candidate-0123456789abcdef",
      candidateTreeSha: "d".repeat(40),
      findingsDigest: canonicalSha256([]),
      resolutionsDigest: canonicalSha256([]),
      commandScopeDigest: digest("command-scope"),
      runnerAttestationDigest: digest("runner-attestation"),
      rulesetDigest: digest("ruleset"),
      requiredCiDigest: digest("required-ci"),
    },
    allowedActions: ["create_branch", "create_pull_request"],
    pullRequestNumber: null,
  };
}

function artifact(overrides: Partial<Parameters<typeof createOwnerAuthorizationChallenge>[0]> = {}) {
  return createOwnerAuthorizationChallenge({
    bindings: bindings(),
    blockers: [],
    now: NOW,
    ...overrides,
  });
}

test("creates and parses one canonical blocker-free challenge bound to every runtime field", () => {
  const value = artifact();
  assert.equal(value.challengeJson, canonicalJson(value.challenge));
  assert.equal(value.challengeDigest, value.challenge.challengeDigest);
  assert.match(value.challengeDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(parseOwnerAuthorizationChallenge(value.challengeJson, NOW), value.challenge);
  assert.equal(value.challenge.bindings.preview.findingsDigest, canonicalSha256([]));
  assert.equal(Object.isFrozen(value.challenge), true);
  assert.equal(Object.isFrozen(value.challenge.bindings.preview), true);
  assert.equal(value.expiresAt, NOW + 30 * 60_000);
});

test("shared canonical JSON rejects ambiguous values and non-canonical or invalid UTF-8 bytes", () => {
  assert.equal(canonicalJson({ b: 2, a: [true, null] }), '{"a":[true,null],"b":2}');
  for (const unsafe of [1.5, -0, Number.NaN, Number.POSITIVE_INFINITY, undefined, new Date(0)]) {
    assert.throws(() => canonicalJson(unsafe), /Canonical JSON rejected/);
  }
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /cyclic/);
  assert.throws(() => canonicalJson({ missing: undefined }), /undefined/);
  assert.throws(() => canonicalJson([, "value"]), /sparse/);
  assert.throws(() => canonicalJson("\ud800"), /surrogate/);
  const symbolic = { value: 1 } as Record<PropertyKey, unknown>;
  symbolic[Symbol("hidden")] = true;
  assert.throws(() => canonicalJson(symbolic), /symbolic/);
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
  assert.throws(() => canonicalJson(accessor), /accessor/);
  assert.throws(
    () => parseCanonicalJson(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), 100, "fixture"),
    /UTF-8/
  );
  assert.throws(() => parseCanonicalJson('{"a":1,"a":1}', 100, "fixture"), /canonical/);
  assert.throws(() => parseCanonicalJson('{ "a":1}', 100, "fixture"), /canonical/);
});

test("blocked, stale, future, and expired previews cannot be challenged or signed", () => {
  assert.throws(
    () => artifact({ blockers: [{ code: "manual_review_required" }] }),
    /blocked previews/
  );
  assert.throws(
    () => artifact({ blockers: undefined as unknown as readonly unknown[] }),
    /blockers are required/
  );

  const stale = bindings();
  stale.previewCompletedAt = NOW - OWNER_AUTHORIZATION_CHALLENGE_MAX_AGE_MS - 1;
  assert.throws(
    () => artifact({ bindings: stale }),
    /preview is stale/
  );
  const future = bindings();
  future.previewCompletedAt = NOW + 1;
  assert.throws(() => artifact({ bindings: future }), /future/);
  const expiredAuthorization = bindings();
  expiredAuthorization.authorizationExpiresAt = NOW;
  assert.throws(() => artifact({ bindings: expiredAuthorization }), /expired/);

  const value = artifact({ ttlMs: 1_000 });
  assert.throws(
    () => parseOwnerAuthorizationChallenge(value.challengeJson, NOW + 1_000),
    /expired/
  );
});

test("canonical shape, digest, nested fields, and exact SHA lengths are strict", () => {
  const value = artifact();
  assert.throws(
    () => parseOwnerAuthorizationChallenge(`${value.challengeJson}\n`, NOW),
    /canonical JSON/
  );

  const unknown = JSON.parse(value.challengeJson) as Record<string, unknown>;
  unknown.unexpected = true;
  assert.throws(
    () => parseOwnerAuthorizationChallenge(canonicalJson(unknown), NOW),
    /unknown or missing fields/
  );

  const nestedUnknown = JSON.parse(value.challengeJson) as {
    bindings: { preview: Record<string, unknown> };
  };
  nestedUnknown.bindings.preview.unexpected = true;
  assert.throws(
    () => parseOwnerAuthorizationChallenge(canonicalJson(nestedUnknown), NOW),
    /unknown or missing fields/
  );

  for (const length of [41, 63]) {
    const malformed = JSON.parse(value.challengeJson) as {
      bindings: { base: { sha: string } };
    };
    malformed.bindings.base.sha = "e".repeat(length);
    assert.throws(
      () => parseOwnerAuthorizationChallenge(canonicalJson(malformed), NOW),
      /base sha is invalid/
    );
  }

  const validTamper = JSON.parse(value.challengeJson) as {
    bindings: { base: { sha: string } };
  };
  validTamper.bindings.base.sha = "f".repeat(40);
  assert.throws(
    () => parseOwnerAuthorizationChallenge(canonicalJson(validTamper), NOW),
    /challenge digest does not match/
  );
});

test("manual findings and malformed remote-state actions fail closed", () => {
  const findings = bindings();
  findings.preview.findingsDigest = digest("one finding");
  assert.throws(
    () => artifact({ bindings: findings }),
    /canonical empty findings and resolutions/
  );

  const malformedActions: Array<[string[], number | null]> = [
    [["create_pull_request", "create_branch"], null],
    [["create_branch"], null],
    [["update_pull_request", "create_pull_request"], 7],
    [["create_branch", "create_pull_request"], 7],
    [["update_pull_request"], null],
  ];
  for (const [allowedActions, pullRequestNumber] of malformedActions) {
    const current = bindings() as unknown as Record<string, unknown>;
    current.allowedActions = allowedActions;
    current.pullRequestNumber = pullRequestNumber;
    assert.throws(
      () => artifact({ bindings: current as unknown as ExpectedOwnerAuthorizationBindings }),
      /allowedActions|pull-request/
    );
  }

  for (const [allowedActions, pullRequestNumber] of [
    [["create_branch", "create_pull_request"], null],
    [["create_pull_request"], null],
    [["update_pull_request"], 42],
  ] as const) {
    const current = bindings();
    current.allowedActions = [...allowedActions];
    current.pullRequestNumber = pullRequestNumber;
    assert.doesNotThrow(() => artifact({ bindings: current }));
  }
});
