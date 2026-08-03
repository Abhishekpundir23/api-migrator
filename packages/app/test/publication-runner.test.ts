import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import {
  PUBLICATION_RUNNER_ATTESTATION_DOMAIN,
  PUBLICATION_RUNNER_PROFILE,
  assertPublicationRunnerPlanCurrent,
  createPublicationRunnerPlan,
  validatePublicationRunnerPlan,
  verifyPublicationRunnerAttestation,
  type CreatePublicationRunnerPlanInput,
  type PublicationRunnerAttestation,
  type PublicationRunnerOutput,
  type PublicationRunnerPlanRecord,
  type RunnerAttestationTrust,
} from "../src/publication-runner.js";

const NOW = 2_000_000_000_000;
const EXPIRES_AT = NOW + 10 * 60 * 1_000;

function digest(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function planInput(): CreatePublicationRunnerPlanInput {
  return {
    pilotId: "pilot_sandbox_001",
    repository: {
      slug: "example-org/example-repo",
      id: 1_234_567,
      ownerId: 7_654_321,
    },
    base: { branch: "main", sha: "1".repeat(40) },
    sourceArchiveDigest: digest("source"),
    manifestDigest: digest("manifest"),
    commandScopeDigest: digest("command"),
    imageDigest: digest("migration-image"),
    migrationInstallEgress: [{
      host: "registry.npmjs.org",
      protocol: "tcp",
      port: 443,
      tls: true,
      // Deliberately out of order; the constructor canonicalizes exact IPs.
      addresses: ["2606:4700::6810:123", "104.16.1.35"],
      resolutionEvidenceDigest: digest("npm-resolution"),
      resolutionObservedAt: NOW - 60_000,
      resolutionExpiresAt: NOW + 20 * 60 * 1_000,
    }],
    expiresAt: EXPIRES_AT,
    now: NOW,
  };
}

function reviewedOutput(): PublicationRunnerOutput {
  return {
    preflightId: `pf_${"2".repeat(64)}`,
    artifactDigest: digest("artifact"),
    candidateTreeSha: "3".repeat(40),
  };
}

function plan(): PublicationRunnerPlanRecord {
  return createPublicationRunnerPlan(planInput());
}

function trustPair(): { privateKey: KeyObject; trust: RunnerAttestationTrust } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    privateKey,
    trust: {
      keyId: "runner-key-001",
      algorithm: "Ed25519",
      publicKeyPem,
      fingerprint: digestBytes(publicKey.export({ type: "spki", format: "der" })),
      validFrom: NOW - 60_000,
      validUntil: NOW + 24 * 60 * 60 * 1_000,
      revokedAt: null,
    },
  };
}

function attestation(
  record: PublicationRunnerPlanRecord,
  output = reviewedOutput()
): PublicationRunnerAttestation {
  const evidence = (name: string) => ({
    status: "passed" as const,
    evidenceReference: `evidence/run-001#${name}`,
    evidenceDigest: digest(`check-${name}`),
  });
  return {
    schemaVersion: 1,
    profile: PUBLICATION_RUNNER_PROFILE,
    planDigest: record.digest,
    jobId: record.plan.job.id,
    runnerInstanceDigest: digest("runner-instance"),
    subject: structuredClone(record.plan.subject),
    inputs: structuredClone(record.plan.inputs),
    output: structuredClone(output),
    execution: {
      identity: record.plan.execution.identity,
      imageDigest: record.plan.imageDigest,
      executionInstanceDigest: digest("execution-containers"),
      startedAt: NOW + 1_000,
      finishedAt: NOW + 100_000,
      credentialsObserved: "none",
      sourceReadOnly: true,
      proxyEnvironmentObserved: "absent",
      installEgressPolicyDigest: record.plan.egress.install.policyDigest,
      egressEvidenceReference: "evidence/run-001#egress",
      egressEvidenceDigest: digest("egress-evidence"),
      checksNetwork: "none",
      checks: {
        install: evidence("install"),
        typecheck: evidence("typecheck"),
        test: evidence("test"),
        lint: evidence("lint"),
        runtime: evidence("runtime"),
      },
      outputArtifactDigest: output.artifactDigest,
      candidateTreeSha: output.candidateTreeSha,
      status: "passed",
      evidenceReference: "evidence/run-001#execution",
      evidenceDigest: digest("execution-evidence"),
    },
    teardown: {
      containersDestroyedAt: NOW + 101_000,
      networkNamespaceDestroyedAt: NOW + 102_000,
      nftablesPolicyRemovedAt: NOW + 103_000,
      workspaceDestroyedAt: NOW + 102_000,
      complete: true,
      evidenceReference: "evidence/run-001#teardown",
      evidenceDigest: digest("teardown-evidence"),
    },
    observedAt: NOW + 104_000,
  };
}

function signedEnvelope(
  payload: PublicationRunnerAttestation,
  privateKey: KeyObject,
  keyId: string,
  domain = PUBLICATION_RUNNER_ATTESTATION_DOMAIN
): string {
  const payloadBytes = Buffer.from(canonicalJson(payload), "utf8");
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(domain, "utf8"), payloadBytes]),
    privateKey
  ).toString("base64url");
  return canonicalJson({
    schemaVersion: 1,
    keyId,
    payload: payloadBytes.toString("base64url"),
    signature,
  });
}

test("creates an immutable credential-free pre-publication plan without circular evidence", () => {
  const record = plan();
  assert.match(record.plan.job.id, /^previewjob_[a-f0-9]{64}$/);
  assert.equal(record.plan.job.disposable, true);
  assert.equal(record.plan.execution.credentials, "none");
  assert.equal(record.plan.execution.checksNetwork, "none");
  assert.equal(record.plan.execution.proxyEnvironment, "absent");
  assert.equal("expectedOutput" in record.plan, false);
  assert.equal(record.plan.egress.enforcement, "host_nftables_output_exact_ip_tcp443");
  assert.equal(
    record.plan.egress.install.applicationLayerEnforcement,
    "external_l7_gateway_required"
  );
  assert.equal(record.plan.execution.onlinePhase, "dependency_install_only");
  assert.equal(record.plan.execution.storage.enforcement, "bounded_tmpfs");
  assert.deepEqual(record.plan.execution.requiredChecks, [
    "install",
    "typecheck",
    "test",
    "lint",
    "runtime",
  ]);
  assert.equal(record.digest, digestBytes(Buffer.from(record.canonicalJson, "utf8")));
  for (const forbidden of ["ownerAuthorization", "publisher", "token", "pullRequest", "revocation"]) {
    assert.equal(record.canonicalJson.includes(forbidden), false, forbidden);
  }
  assert(Object.isFrozen(record.plan.execution));
  assert.equal(assertPublicationRunnerPlanCurrent(record, NOW + 1).digest, record.digest);
  assert.throws(() => assertPublicationRunnerPlanCurrent(record, EXPIRES_AT), /not currently valid/);
  assert.throws(
    () => createPublicationRunnerPlan({ ...planInput(), expiresAt: NOW + 59_999 }),
    /between 1 and 15 minutes/
  );
});

test("rejects DNS rebinding shapes, redirects, broad networks, ports, and protocols", () => {
  const cases: Array<[string, (input: CreatePublicationRunnerPlanInput) => void]> = [
    ["direct-IP host", (input) => { input.migrationInstallEgress[0]!.host = "104.16.1.35"; }],
    ["wildcard host", (input) => { input.migrationInstallEgress[0]!.host = "*.npmjs.org"; }],
    ["redirect host", (input) => { input.migrationInstallEgress[0]!.host = "evil.example"; }],
    ["alternate port", (input) => {
      (input.migrationInstallEgress[0] as { port: number }).port = 80;
    }],
    ["alternate protocol", (input) => {
      (input.migrationInstallEgress[0] as { protocol: string }).protocol = "udp";
    }],
    ["TLS disabled", (input) => {
      (input.migrationInstallEgress[0] as { tls: boolean }).tls = false;
    }],
    ["CIDR", (input) => { input.migrationInstallEgress[0]!.addresses = ["0.0.0.0/0"]; }],
    ["hostname address", (input) => {
      input.migrationInstallEgress[0]!.addresses = ["evil.example"];
    }],
    ["IPv6 zone", (input) => { input.migrationInstallEgress[0]!.addresses = ["fe80::1%eth0"]; }],
    ["loopback", (input) => { input.migrationInstallEgress[0]!.addresses = ["127.0.0.1"]; }],
    ["link-local metadata", (input) => {
      input.migrationInstallEgress[0]!.addresses = ["169.254.169.254"];
    }],
    ["private address", (input) => { input.migrationInstallEgress[0]!.addresses = ["10.0.0.1"]; }],
    ["IPv6 loopback", (input) => { input.migrationInstallEgress[0]!.addresses = ["::1"]; }],
    ["IPv6 documentation", (input) => {
      input.migrationInstallEgress[0]!.addresses = ["2001:db8::1"];
    }],
    ["noncanonical equivalent IPv6", (input) => {
      input.migrationInstallEgress[0]!.addresses = [
        "2606:4700::6810:123",
        "2606:4700:0:0:0:0:6810:123",
      ];
    }],
    ["duplicate IP", (input) => {
      input.migrationInstallEgress[0]!.addresses = ["104.16.1.35", "104.16.1.35"];
    }],
    ["stale resolution", (input) => {
      input.migrationInstallEgress[0]!.resolutionObservedAt = NOW - 6 * 60 * 1_000;
    }],
    ["short resolution", (input) => {
      input.migrationInstallEgress[0]!.resolutionExpiresAt = EXPIRES_AT - 1;
    }],
  ];
  for (const [name, mutate] of cases) {
    const input = planInput();
    mutate(input);
    assert.throws(() => createPublicationRunnerPlan(input), undefined, name);
  }
});

test("rejects ordinary bridge claims, proxy inheritance, credentials, and plan substitution", () => {
  const original = plan();
  const cases: Array<[string, (value: Record<string, any>) => void]> = [
    ["credential injection", (value) => { value.execution.credentials = "environment"; }],
    ["ordinary bridge", (value) => { value.egress.enforcement = "docker_bridge"; }],
    ["proxy inheritance", (value) => { value.execution.proxyEnvironment = "inherited"; }],
    ["writable source", (value) => { value.execution.sourceReadOnly = false; }],
    ["online checks", (value) => { value.execution.checksNetwork = "bridge"; }],
    ["mutable job", (value) => { value.job.disposable = false; }],
    ["job substitution", (value) => { value.job.id = `previewjob_${"f".repeat(64)}`; }],
    ["free-form shell", (value) => { value.execution.shell = "bash"; }],
  ];
  for (const [name, mutate] of cases) {
    const value = structuredClone(original.plan) as unknown as Record<string, any>;
    mutate(value);
    assert.throws(() => validatePublicationRunnerPlan(value), undefined, name);
  }
  assert.throws(
    () => assertPublicationRunnerPlanCurrent({ ...original, digest: digest("substitute") }, NOW),
    /digest or canonical bytes/
  );
});

test("verifies a domain-separated pinned control-plane attestation for owner binding", () => {
  const record = plan();
  const { privateKey, trust } = trustPair();
  const payload = attestation(record);
  const envelope = signedEnvelope(payload, privateKey, trust.keyId);
  const verified = verifyPublicationRunnerAttestation(envelope, record, reviewedOutput(), trust);
  assert.deepEqual(verified.attestation, payload);
  assert.equal(verified.payloadDigest, digestBytes(Buffer.from(canonicalJson(payload), "utf8")));
  assert.equal(verified.envelopeDigest, digestBytes(Buffer.from(envelope, "utf8")));
  assert.equal(verified.signer.fingerprint, trust.fingerprint);
  assert(Object.isFrozen(verified.attestation));
  assert.throws(
    () => verifyPublicationRunnerAttestation(
      envelope,
      record,
      { ...reviewedOutput(), artifactDigest: digest("different-reviewed-output") },
      trust
    ),
    /output binding does not match/
  );
});

test("rejects forged, unpinned, noncanonical, unexpected, and revoked envelopes", () => {
  const record = plan();
  const { privateKey, trust } = trustPair();
  const payload = attestation(record);
  const valid = signedEnvelope(payload, privateKey, trust.keyId);
  const other = trustPair();
  assert.throws(
    () => verifyPublicationRunnerAttestation(
      signedEnvelope(payload, other.privateKey, trust.keyId),
      record,
      reviewedOutput(),
      trust
    ),
    /signature verification failed/
  );
  assert.throws(
    () => verifyPublicationRunnerAttestation(
      signedEnvelope(payload, privateKey, trust.keyId, "wrong-domain\0"),
      record,
      reviewedOutput(),
      trust
    ),
    /signature verification failed/
  );
  assert.throws(
    () => verifyPublicationRunnerAttestation(
      signedEnvelope(payload, privateKey, "other-key"),
      record,
      reviewedOutput(),
      trust
    ),
    /signer is not pinned/
  );
  assert.throws(
    () => verifyPublicationRunnerAttestation(`${valid}\n`, record, reviewedOutput(), trust),
    /not canonical JSON/
  );
  const unexpected = JSON.parse(valid) as Record<string, unknown>;
  unexpected.token = "must-never-cross-this-boundary";
  assert.throws(
    () => verifyPublicationRunnerAttestation(
      canonicalJson(unexpected),
      record,
      reviewedOutput(),
      trust
    ),
    /unexpected fields/
  );
  assert.throws(
    () => verifyPublicationRunnerAttestation(
      valid,
      record,
      reviewedOutput(),
      { ...trust, revokedAt: NOW + 1 }
    ),
    /key is revoked/
  );
});

test("rejects output drift, egress self-assertion, weak checks, and interrupted teardown", () => {
  const record = plan();
  const { privateKey, trust } = trustPair();
  const cases: Array<[string, (value: Record<string, any>) => void]> = [
    ["migration credential", (value) => { value.execution.credentialsObserved = "present"; }],
    ["writable source", (value) => { value.execution.sourceReadOnly = false; }],
    ["proxy inherited", (value) => { value.execution.proxyEnvironmentObserved = "present"; }],
    ["egress digest", (value) => {
      value.execution.installEgressPolicyDigest = digest("self-asserted");
    }],
    ["check skipped", (value) => { value.execution.checks.test.status = "skipped"; }],
    ["artifact drift", (value) => { value.output.artifactDigest = digest("different"); }],
    ["extra secret", (value) => { value.execution.token = "secret"; }],
    ["incomplete teardown", (value) => { value.teardown.complete = false; }],
    ["container survives", (value) => {
      value.teardown.containersDestroyedAt = value.execution.finishedAt - 1;
    }],
    ["network survives", (value) => {
      value.teardown.networkNamespaceDestroyedAt = value.teardown.containersDestroyedAt - 1;
    }],
    ["nft removed early", (value) => {
      value.teardown.nftablesPolicyRemovedAt = value.teardown.networkNamespaceDestroyedAt - 1;
    }],
    ["attestation after expiry", (value) => { value.observedAt = EXPIRES_AT; }],
  ];
  for (const [name, mutate] of cases) {
    const value = structuredClone(attestation(record)) as unknown as Record<string, any>;
    mutate(value);
    const envelope = signedEnvelope(value as PublicationRunnerAttestation, privateKey, trust.keyId);
    assert.throws(
      () => verifyPublicationRunnerAttestation(envelope, record, reviewedOutput(), trust),
      undefined,
      name
    );
  }
});

function digestBytes(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
