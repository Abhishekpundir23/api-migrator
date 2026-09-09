import assert from "node:assert/strict";
import test from "node:test";
import { verifyPublicationRunnerAttestation } from "../src/publication-runner.js";
import {
  RunnerEvidenceError,
  runnerEvidenceDigest,
  runnerEvidenceFailure,
  validateRetainedRunnerEvidenceIdentity,
  validateRunnerEvidenceConfiguration,
  validateRunnerEvidenceContext,
  type RetainedRunnerEvidenceIdentity,
} from "../src/runner-evidence-contract.js";
import { fixtureDigest, publicationRunnerPlanInput } from "./helpers/publication-runner-fixture.js";
import { runnerEvidenceFixture } from "./helpers/runner-evidence-fixture.js";

const NOW = 2_000_000_000_000;

function assertCode(code: "configuration_invalid" | "expected_context_invalid" | "expired") {
  return (error: unknown) => error instanceof RunnerEvidenceError && error.code === code;
}

function validIdentity(f: ReturnType<typeof runnerEvidenceFixture>): RetainedRunnerEvidenceIdentity {
  return {
    schemaVersion: 1,
    contextDigest: fixtureDigest("context"),
    jobId: f.context.plan.plan.job.id,
    planDigest: f.context.plan.digest,
    attestationPayloadDigest: fixtureDigest("payload"),
    attestationEnvelopeDigest: fixtureDigest("envelope"),
    signerKeyId: f.trust.keyId,
    signerFingerprint: f.trust.fingerprint,
    signerTrustDigest: fixtureDigest("trust"),
    expiresAt: NOW + 1_000,
  };
}

test("context is detached, source-bound, and rejects getters before invocation", () => {
  const f = runnerEvidenceFixture(NOW);
  try {
    const original = structuredClone(f.context);
    const accepted = validateRunnerEvidenceContext(original, NOW);
    original.source.base.branch = "changed";
    assert.equal(accepted.source.base.branch, "main");
    assert(Object.isFrozen(accepted.source.base));
    const wrong = structuredClone(f.context);
    wrong.source.repository.id += 1;
    assert.throws(() => validateRunnerEvidenceContext(wrong, NOW), assertCode("expected_context_invalid"));
    let reads = 0;
    const accessor = { ...f.context };
    Object.defineProperty(accessor, "source", {
      enumerable: true, get() { reads += 1; return f.context.source; },
    });
    assert.throws(() => validateRunnerEvidenceContext(accessor, NOW), assertCode("expected_context_invalid"));
    assert.equal(reads, 0);
  } finally { f.close(); }
});

test("real source bundle fixture produces a genuinely verifiable domain-separated envelope", () => {
  const f = runnerEvidenceFixture(NOW);
  try {
    const verified = verifyPublicationRunnerAttestation(
      f.envelope,
      f.context.plan,
      f.context.reviewedOutput,
      f.trust,
      NOW
    );
    assert.deepEqual(verified.attestation, f.payload);
    const changed = structuredClone(f.payload);
    changed.output.artifactDigest = fixtureDigest("changed-artifact");
    assert.throws(() => verifyPublicationRunnerAttestation(
      f.signPayload(changed),
      f.context.plan,
      f.context.reviewedOutput,
      f.trust,
      NOW
    ), /output binding does not match/);
  } finally { f.close(); }
});

test("context validates every source and output field without weakening GitHub casing or branch identity", () => {
  const f = runnerEvidenceFixture(NOW);
  try {
    const mixedCase = structuredClone(f.context);
    mixedCase.source.repository.slug = "Fixture-Org/Fixture-Repo";
    assert.equal(validateRunnerEvidenceContext(mixedCase, NOW).source.repository.slug, "fixture-org/fixture-repo");

    const mutations: Array<[string, (value: any) => void]> = [
      ["repository slug", (value) => { value.source.repository.slug = "other-org/fixture-repo"; }],
      ["repository id", (value) => { value.source.repository.id += 1; }],
      ["repository owner", (value) => { value.source.repository.ownerId += 1; }],
      ["branch case", (value) => { value.source.base.branch = "Main"; }],
      ["base commit", (value) => { value.source.base.sha = "f".repeat(40); }],
      ["tree format", (value) => { value.source.base.treeSha = "F".repeat(40); }],
      ["manifest", (value) => { value.source.manifestDigest = fixtureDigest("other-manifest"); }],
      ["archive", (value) => { value.source.sourceArchiveDigest = fixtureDigest("other-archive"); }],
      ["preflight", (value) => { value.reviewedOutput.preflightId = "pf_short"; }],
      ["artifact", (value) => { value.reviewedOutput.artifactDigest = "sha256:no"; }],
      ["candidate tree", (value) => { value.reviewedOutput.candidateTreeSha = "x".repeat(40); }],
    ];
    for (const [name, mutate] of mutations) {
      const value = structuredClone(f.context) as any;
      mutate(value);
      assert.throws(
        () => validateRunnerEvidenceContext(value, NOW),
        assertCode("expected_context_invalid"),
        name
      );
    }
  } finally { f.close(); }
});

test("context enforces identifiers, plan-record exactness, timelines, and nested array descriptor safety", () => {
  const f = runnerEvidenceFixture(NOW);
  try {
    for (const id of ["a", "A".repeat(128), "a-b_C9"]) {
      const value = structuredClone(f.context);
      value.campaignId = id;
      value.runId = id;
      assert.equal(validateRunnerEvidenceContext(value, NOW).campaignId, id);
    }
    for (const id of ["", "a".repeat(129), "has.dot", "has space"]) {
      const value = structuredClone(f.context);
      value.campaignId = id;
      assert.throws(() => validateRunnerEvidenceContext(value, NOW), assertCode("expected_context_invalid"));
    }
    const extra = structuredClone(f.context) as any;
    extra.plan.extra = true;
    assert.throws(() => validateRunnerEvidenceContext(extra, NOW), assertCode("expected_context_invalid"));
    const nestedExtra = structuredClone(f.context) as any;
    nestedExtra.plan.plan.inputs.extra = true;
    assert.throws(
      () => validateRunnerEvidenceContext(nestedExtra, NOW),
      assertCode("expected_context_invalid")
    );

    for (const completedAt of [0, f.context.plan.plan.job.createdAt - 1, NOW + 1]) {
      const value = structuredClone(f.context);
      value.previewCompletedAt = completedAt;
      assert.throws(() => validateRunnerEvidenceContext(value, NOW), assertCode("expected_context_invalid"));
    }
    assert.throws(
      () => validateRunnerEvidenceContext(f.context, f.context.previewCompletedAt + 600_000),
      assertCode("expired")
    );
    assert.throws(
      () => validateRunnerEvidenceContext(f.context, f.context.plan.plan.job.expiresAt),
      assertCode("expired")
    );

    let reads = 0;
    const accessor = structuredClone(f.context) as any;
    Object.defineProperty(accessor.plan.plan.execution.phaseOrder, "0", {
      enumerable: true,
      configurable: true,
      get() { reads += 1; return "offline_preparation"; },
    });
    assert.throws(() => validateRunnerEvidenceContext(accessor, NOW), assertCode("expected_context_invalid"));
    assert.equal(reads, 0);
  } finally { f.close(); }
});

test("retained evidence identity is exact, detached, frozen, and validates all ten fields", () => {
  const f = runnerEvidenceFixture(NOW);
  try {
    const original = validIdentity(f);
    const accepted = validateRetainedRunnerEvidenceIdentity(original);
    original.contextDigest = fixtureDigest("mutated");
    assert.notEqual(accepted.contextDigest, original.contextDigest);
    assert(Object.isFrozen(accepted));
    for (const signerKeyId of ["a", `a${".".repeat(127)}`]) {
      assert.equal(
        validateRetainedRunnerEvidenceIdentity({ ...validIdentity(f), signerKeyId }).signerKeyId,
        signerKeyId
      );
    }

    const mutations: Array<[string, (value: any) => void]> = [
      ["schema", (value) => { value.schemaVersion = 2; }],
      ["context", (value) => { value.contextDigest = "sha256:BAD"; }],
      ["job", (value) => { value.jobId = `previewjob_${"F".repeat(64)}`; }],
      ["plan", (value) => { value.planDigest = "sha256:short"; }],
      ["payload", (value) => { value.attestationPayloadDigest = null; }],
      ["envelope", (value) => { value.attestationEnvelopeDigest = fixtureDigest("x").toUpperCase(); }],
      ["key id", (value) => { value.signerKeyId = "bad key"; }],
      ["key id length", (value) => { value.signerKeyId = "a".repeat(129); }],
      ["fingerprint", (value) => { value.signerFingerprint = "no"; }],
      ["trust", (value) => { value.signerTrustDigest = "no"; }],
      ["expiry", (value) => { value.expiresAt = Number.MAX_SAFE_INTEGER; }],
      ["extra", (value) => { value.extra = true; }],
    ];
    for (const [name, mutate] of mutations) {
      const value = structuredClone(validIdentity(f)) as any;
      mutate(value);
      assert.throws(() => validateRetainedRunnerEvidenceIdentity(value), undefined, name);
    }
  } finally { f.close(); }
});

test("configuration accepts canonical HTTPS and ordered global addresses then freezes detached inputs", () => {
  const config = {
    serviceOrigin: "https://runner.example.com/",
    serviceAddresses: ["1.1.1.1", "2606:4700::6810:123"],
    serviceTlsSpkiDigest: fixtureDigest("tls-spki"),
    registryDirectory: "/srv/api-migrator/runner-keys",
  };
  const policy = { migrationWorkspaceRoots: ["/srv/api-migrator/workspaces/a"] };
  const accepted = validateRunnerEvidenceConfiguration(config, policy);
  config.serviceAddresses.reverse();
  policy.migrationWorkspaceRoots[0] = "/changed";
  assert.equal(accepted.config.serviceOrigin, "https://runner.example.com");
  assert.deepEqual(accepted.config.serviceAddresses, ["1.1.1.1", "2606:4700::6810:123"]);
  assert.deepEqual(accepted.policy.migrationWorkspaceRoots, ["/srv/api-migrator/workspaces/a"]);
  assert(Object.isFrozen(accepted.config.serviceAddresses));
  assert(Object.isFrozen(accepted.policy.migrationWorkspaceRoots));

  const maxPath = `/${"a".repeat(4_095)}`;
  assert.equal(
    validateRunnerEvidenceConfiguration(
      { ...config, serviceAddresses: ["1.1.1.1"], registryDirectory: maxPath },
      { migrationWorkspaceRoots: [maxPath] }
    ).config.registryDirectory,
    maxPath
  );
});

test("configuration rejects URL tricks, noncanonical or reserved addresses, and path aliases", () => {
  const base = {
    serviceOrigin: "https://runner.example.com",
    serviceAddresses: ["1.1.1.1"],
    serviceTlsSpkiDigest: fixtureDigest("tls-spki"),
    registryDirectory: "/srv/api-migrator/runner-keys",
  };
  const policy = { migrationWorkspaceRoots: ["/srv/api-migrator/workspaces/a"] };
  for (const origin of [
    "http://runner.example.com", "https://Runner.example.com", "https://runnér.example.com",
    "https://%72unner.example.com", "https://runner.example.com:443", "https://runner.example.com/path",
    "https://runner.example.com?x", "https://runner.example.com#x", "https://user@runner.example.com",
    "https://127.0.0.1", "https://*.example.com", "https://runner.example.com.",
  ]) {
    assert.throws(
      () => validateRunnerEvidenceConfiguration({ ...base, serviceOrigin: origin }, policy),
      assertCode("configuration_invalid"),
      origin
    );
  }
  for (const address of [
    "01.1.1.1", "8.8.8.8 ", "127.0.0.1", "10.0.0.1", "169.254.169.254",
    "192.0.2.1", "198.18.0.1", "224.0.0.1", "::1", "fe80::1", "2001:db8::1",
    "2606:4700:0:0:0:0:6810:123", "::ffff:1.1.1.1",
  ]) {
    assert.throws(
      () => validateRunnerEvidenceConfiguration({ ...base, serviceAddresses: [address] }, policy),
      assertCode("configuration_invalid"),
      address
    );
  }
  assert.throws(
    () => validateRunnerEvidenceConfiguration({ ...base, serviceAddresses: ["1.1.1.1", "1.1.1.1"] }, policy),
    assertCode("configuration_invalid")
  );
  assert.throws(
    () => validateRunnerEvidenceConfiguration(
      { ...base, registryDirectory: `/${"a".repeat(4_096)}` },
      policy
    ),
    assertCode("configuration_invalid")
  );
  assert.throws(
    () => validateRunnerEvidenceConfiguration(base, {
      migrationWorkspaceRoots: ["/srv/workspaces/a", "/srv/workspaces/a"],
    }),
    assertCode("configuration_invalid")
  );

  let reads = 0;
  const accessorAddresses = ["1.1.1.1"];
  Object.defineProperty(accessorAddresses, "0", {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return "1.1.1.1"; },
  });
  assert.throws(
    () => validateRunnerEvidenceConfiguration({ ...base, serviceAddresses: accessorAddresses }, policy),
    assertCode("configuration_invalid")
  );
  assert.equal(reads, 0);

  for (const path of ["/", "//srv/keys", "/srv/../keys", "/srv/./keys", "/srv/keys/", "relative", "/srv/\0keys"]) {
    assert.throws(
      () => validateRunnerEvidenceConfiguration({ ...base, registryDirectory: path }, policy),
      assertCode("configuration_invalid"),
      path
    );
    assert.throws(
      () => validateRunnerEvidenceConfiguration(base, { migrationWorkspaceRoots: [path] }),
      assertCode("configuration_invalid"),
      path
    );
  }
});

test("digest and failure results are canonical and frozen", () => {
  assert.equal(
    runnerEvidenceDigest({ a: 1 }),
    "sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862"
  );
  const failure = runnerEvidenceFailure("identity_changed");
  assert.deepEqual(failure, { ok: false, code: "identity_changed" });
  assert(Object.isFrozen(failure));
});
