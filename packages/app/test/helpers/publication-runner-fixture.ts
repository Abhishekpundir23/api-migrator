import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { canonicalJson } from "../../src/canonical-json.js";
import {
  PUBLICATION_RUNNER_ATTESTATION_DOMAIN,
  PUBLICATION_RUNNER_PROFILE,
  type CreatePublicationRunnerPlanInput,
  type PublicationRunnerAttestation,
  type PublicationRunnerOutput,
  type PublicationRunnerPlanRecord,
  type RunnerAttestationTrust,
} from "../../src/publication-runner.js";

export function fixtureDigest(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

export function publicationRunnerPlanInput(createdAt: number): CreatePublicationRunnerPlanInput {
  return {
    pilotId: "pilot_sandbox_001",
    repository: {
      slug: "example-org/example-repo",
      id: 1_234_567,
      ownerId: 7_654_321,
    },
    base: { branch: "main", sha: "1".repeat(40) },
    sourceArchiveDigest: fixtureDigest("source"),
    manifestDigest: fixtureDigest("manifest"),
    imageDigest: fixtureDigest("migration-image"),
    migrationInstallEgress: [{
      host: "registry.npmjs.org",
      protocol: "tcp",
      port: 443,
      tls: true,
      // Deliberately out of order; the constructor canonicalizes exact IPs.
      addresses: ["2606:4700::6810:123", "104.16.1.35"],
      resolutionEvidenceDigest: fixtureDigest("npm-resolution"),
      resolutionObservedAt: createdAt - 60_000,
      resolutionExpiresAt: createdAt + 20 * 60 * 1_000,
    }],
    expiresAt: createdAt + 10 * 60 * 1_000,
    now: createdAt,
  };
}

export function publicationRunnerReviewedOutput(): PublicationRunnerOutput {
  return {
    preflightId: `pf_${"2".repeat(64)}`,
    artifactDigest: fixtureDigest("artifact"),
    candidateTreeSha: "3".repeat(40),
  };
}

export function publicationRunnerTrustPair(createdAt: number): {
  privateKey: KeyObject;
  trust: RunnerAttestationTrust;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    privateKey,
    trust: {
      keyId: "runner-key-001",
      algorithm: "Ed25519",
      publicKeyPem,
      fingerprint: digestBytes(publicKey.export({ type: "spki", format: "der" })),
      validFrom: createdAt - 60_000,
      validUntil: createdAt + 24 * 60 * 60 * 1_000,
      revokedAt: null,
    },
  };
}

export function publicationRunnerAttestation(
  record: PublicationRunnerPlanRecord,
  createdAt: number,
  output = publicationRunnerReviewedOutput()
): PublicationRunnerAttestation {
  const evidence = (name: string) => ({
    status: "passed" as const,
    evidenceReference: `evidence/run-001#${name}`,
    evidenceDigest: fixtureDigest(`check-${name}`),
  });
  return {
    schemaVersion: 1,
    profile: PUBLICATION_RUNNER_PROFILE,
    planDigest: record.digest,
    jobId: record.plan.job.id,
    runnerInstanceDigest: fixtureDigest("runner-instance"),
    subject: structuredClone(record.plan.subject),
    inputs: structuredClone(record.plan.inputs),
    output: structuredClone(output),
    execution: {
      identity: record.plan.execution.identity,
      imageDigest: record.plan.imageDigest,
      executionInstanceDigest: fixtureDigest("execution-containers"),
      startedAt: createdAt + 1_000,
      finishedAt: createdAt + 100_000,
      credentialsObserved: "none",
      sourceReadOnly: true,
      proxyEnvironmentObserved: "absent",
      installEgressPolicyDigest: record.plan.egress.install.policyDigest,
      egressEvidenceReference: "evidence/run-001#egress",
      egressEvidenceDigest: fixtureDigest("egress-evidence"),
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
      evidenceDigest: fixtureDigest("execution-evidence"),
    },
    teardown: {
      containersDestroyedAt: createdAt + 101_000,
      networkNamespaceDestroyedAt: createdAt + 102_000,
      nftablesPolicyRemovedAt: createdAt + 103_000,
      workspaceDestroyedAt: createdAt + 102_000,
      complete: true,
      evidenceReference: "evidence/run-001#teardown",
      evidenceDigest: fixtureDigest("teardown-evidence"),
    },
    observedAt: createdAt + 104_000,
  };
}

export function signedPublicationRunnerEnvelope(
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

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
