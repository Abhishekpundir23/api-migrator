import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { isIP } from "node:net";
import { canonicalJson, parseCanonicalJson } from "./canonical-json.js";
import { parseRepositorySlug, validateBranchName } from "./repository.js";

export const PUBLICATION_RUNNER_PROFILE = "disposable-egress-filtered-pilot-v1" as const;
export const PUBLICATION_RUNNER_PLAN_MIN_TTL_MS = 60 * 1_000;
export const PUBLICATION_RUNNER_PLAN_MAX_TTL_MS = 15 * 60 * 1_000;
export const PUBLICATION_RUNNER_ATTESTATION_DOMAIN =
  "api-migrator:publication-runner-attestation:v1\0" as const;

const RESOLUTION_MAX_AGE_MS = 5 * 60 * 1_000;
const RESOLUTION_MAX_TTL_MS = 30 * 60 * 1_000;
const MAX_ATTESTATION_ENVELOPE_BYTES = 128 * 1_024;
const MAX_ATTESTATION_PAYLOAD_BYTES = 96 * 1_024;
const MAX_EVIDENCE_REFERENCE_BYTES = 500;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PREFLIGHT_ID = /^pf_[a-f0-9]{64}$/;
const PILOT_ID = /^pilot_[A-Za-z0-9_-]{6,80}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const JOB_ID = /^previewjob_[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MIGRATION_HOSTS = ["registry.npmjs.org"] as const;

export interface RunnerEgressDestination {
  host: string;
  protocol: "tcp";
  port: 443;
  tls: true;
  /** Exact numeric destinations installed into the host nftables set. */
  addresses: string[];
  resolutionEvidenceDigest: string;
  resolutionObservedAt: number;
  resolutionExpiresAt: number;
}

export interface CreatePublicationRunnerPlanInput {
  pilotId: string;
  repository: {
    slug: string;
    id: number;
    ownerId: number;
  };
  base: {
    branch: string;
    sha: string;
  };
  sourceArchiveDigest: string;
  manifestDigest: string;
  commandScopeDigest: string;
  imageDigest: string;
  migrationInstallEgress: RunnerEgressDestination[];
  expiresAt: number;
  /** Testable trusted clock. Production callers should omit it. */
  now?: number;
}

export interface PublicationRunnerPlan {
  schemaVersion: 1;
  profile: typeof PUBLICATION_RUNNER_PROFILE;
  job: {
    id: string;
    nonceDigest: string;
    createdAt: number;
    expiresAt: number;
    disposable: true;
  };
  subject: {
    pilotId: string;
    repository: {
      slug: string;
      id: number;
      ownerId: number;
    };
    base: {
      branch: string;
      sha: string;
    };
  };
  inputs: {
    sourceArchiveDigest: string;
    manifestDigest: string;
    commandScopeDigest: string;
  };
  imageDigest: string;
  egress: {
    enforcement: "host_nftables_output_exact_ip_tcp443";
    dnsInsideJob: "disabled";
    install: {
      destinations: RunnerEgressDestination[];
      policyDigest: string;
      applicationLayerEnforcement: "external_l7_gateway_required";
    };
    checks: {
      network: "none";
    };
  };
  execution: {
    identity: string;
    credentials: "none";
    repositoryCodeExecution: true;
    sourceReadOnly: true;
    writableOutput: "bounded_tmpfs_then_root_sealed_transfer";
    rootlessContainer: true;
    readOnlyRoot: true;
    capabilities: "none";
    noNewPrivileges: true;
    proxyEnvironment: "absent";
    dependencyLifecycleScripts: "disabled";
    onlinePhase: "dependency_install_only";
    phaseOrder: ["dependency_install", "migration", "verification"];
    installEgressPolicyDigest: string;
    checksNetwork: "none";
    requiredChecks: ["install", "typecheck", "test", "lint", "runtime"];
    outputBinding: "signed_attestation_reviewed_output";
    storage: {
      enforcement: "bounded_tmpfs";
      workspaceBytes: 1_073_741_824;
      workspaceInodes: 200_000;
      maxLogBytesPerPhase: 10_485_760;
      maxRunnerEvidenceBytes: 98_304;
      maxOutputBytes: 536_870_912;
      maxOutputFileBytes: 268_435_456;
      maxOutputEntries: 50_000;
      maxOutputDepth: 64;
    };
  };
  teardown: {
    destroyContainer: true;
    destroyWorkspace: true;
    destroyNetworkNamespace: true;
    removeNftablesPolicy: true;
    evidenceRequired: true;
  };
}

export interface PublicationRunnerPlanRecord {
  plan: Readonly<PublicationRunnerPlan>;
  /** Exact canonical UTF-8 JSON passed to the runner control plane. */
  canonicalJson: string;
  digest: string;
}

export interface RunnerCheckEvidence {
  status: "passed";
  evidenceReference: string;
  evidenceDigest: string;
}

/** Output observed after the first isolated execution and reviewed separately. */
export interface PublicationRunnerOutput {
  preflightId: string;
  artifactDigest: string;
  candidateTreeSha: string;
}

/**
 * Successful pre-publication execution evidence. It is intentionally complete
 * before the owner challenge exists, and therefore contains no owner envelope,
 * write token, publisher, PR, or revocation claim.
 */
export interface PublicationRunnerAttestation {
  schemaVersion: 1;
  profile: typeof PUBLICATION_RUNNER_PROFILE;
  planDigest: string;
  jobId: string;
  runnerInstanceDigest: string;
  subject: PublicationRunnerPlan["subject"];
  inputs: PublicationRunnerPlan["inputs"];
  output: PublicationRunnerOutput;
  execution: {
    identity: string;
    imageDigest: string;
    /** Digest of the ordered install/migrate and offline-check container instances. */
    executionInstanceDigest: string;
    startedAt: number;
    finishedAt: number;
    credentialsObserved: "none";
    sourceReadOnly: true;
    proxyEnvironmentObserved: "absent";
    installEgressPolicyDigest: string;
    egressEvidenceReference: string;
    egressEvidenceDigest: string;
    checksNetwork: "none";
    checks: {
      install: RunnerCheckEvidence;
      typecheck: RunnerCheckEvidence;
      test: RunnerCheckEvidence;
      lint: RunnerCheckEvidence;
      runtime: RunnerCheckEvidence;
    };
    outputArtifactDigest: string;
    candidateTreeSha: string;
    status: "passed";
    evidenceReference: string;
    evidenceDigest: string;
  };
  teardown: {
    containersDestroyedAt: number;
    networkNamespaceDestroyedAt: number;
    nftablesPolicyRemovedAt: number;
    workspaceDestroyedAt: number;
    complete: true;
    evidenceReference: string;
    evidenceDigest: string;
  };
  observedAt: number;
}

export interface RunnerAttestationTrust {
  keyId: string;
  algorithm: "Ed25519";
  publicKeyPem: string;
  fingerprint: string;
  validFrom: number;
  validUntil: number;
  revokedAt: number | null;
}

export interface VerifiedPublicationRunnerAttestation {
  attestation: Readonly<PublicationRunnerAttestation>;
  canonicalJson: string;
  /** Owner challenge binds this digest of the exact signed payload bytes. */
  payloadDigest: string;
  /** Outer signed-envelope digest retained as provenance. */
  envelopeDigest: string;
  signer: Readonly<{ keyId: string; fingerprint: string }>;
}

interface AttestationEnvelope {
  schemaVersion: 1;
  keyId: string;
  payload: string;
  signature: string;
}

/**
 * Build the only supported pre-publication runner plan. The caller supplies
 * identities and immutable digests; every isolation control is fixed here.
 */
export function createPublicationRunnerPlan(
  input: CreatePublicationRunnerPlanInput
): PublicationRunnerPlanRecord {
  const createdAt = timestamp(input.now ?? Date.now(), "plan creation time");
  const expiresAt = timestamp(input.expiresAt, "plan expiry");
  assertPlanLifetime(createdAt, expiresAt);
  const subject = validateSubject({
    pilotId: input.pilotId,
    repository: input.repository,
    base: input.base,
  });
  const inputs = validateInputs({
    sourceArchiveDigest: input.sourceArchiveDigest,
    manifestDigest: input.manifestDigest,
    commandScopeDigest: input.commandScopeDigest,
  });
  const imageDigest = digest(input.imageDigest, "migration image digest");
  const destinations = normalizeAndValidateDestinations(
    input.migrationInstallEgress,
    createdAt,
    expiresAt
  );
  const nonceDigest = sha256(randomBytes(32));
  const jobId = deriveJobId({
    nonceDigest,
    createdAt,
    expiresAt,
    subject,
    inputs,
    imageDigest,
  });
  return recordForPlan(buildPlan({
    jobId,
    nonceDigest,
    createdAt,
    expiresAt,
    subject,
    inputs,
    imageDigest,
    destinations,
  }));
}

/** Rebuild and freeze a plan, rejecting every unknown or weakened control. */
export function validatePublicationRunnerPlan(value: unknown): PublicationRunnerPlanRecord {
  const root = record(value, "publication runner plan");
  exactKeys(root, [
    "schemaVersion",
    "profile",
    "job",
    "subject",
    "inputs",
    "imageDigest",
    "egress",
    "execution",
    "teardown",
  ], "publication runner plan");
  if (root.schemaVersion !== 1 || root.profile !== PUBLICATION_RUNNER_PROFILE) {
    throw new Error("Publication runner plan profile is unsupported");
  }
  const job = record(root.job, "runner job");
  exactKeys(job, ["id", "nonceDigest", "createdAt", "expiresAt", "disposable"], "runner job");
  const jobId = boundedString(job.id, "runner job id", 76);
  if (!JOB_ID.test(jobId) || job.disposable !== true) {
    throw new Error("Publication runner job identity is invalid or not disposable");
  }
  const nonceDigest = digest(job.nonceDigest, "runner nonce digest");
  const createdAt = timestamp(job.createdAt, "plan creation time");
  const expiresAt = timestamp(job.expiresAt, "plan expiry");
  assertPlanLifetime(createdAt, expiresAt);
  const subject = validateSubject(root.subject);
  const inputs = validateInputs(root.inputs);
  const imageDigest = digest(root.imageDigest, "migration image digest");
  const egress = record(root.egress, "runner egress policy");
  exactKeys(egress, ["enforcement", "dnsInsideJob", "install", "checks"], "runner egress policy");
  const install = record(egress.install, "installation egress policy");
  exactKeys(
    install,
    ["destinations", "policyDigest", "applicationLayerEnforcement"],
    "installation egress policy"
  );
  const destinations = normalizeAndValidateDestinations(install.destinations, createdAt, expiresAt);
  const expectedJobId = deriveJobId({
    nonceDigest,
    createdAt,
    expiresAt,
    subject,
    inputs,
    imageDigest,
  });
  if (jobId !== expectedJobId) throw new Error("Publication runner job identity does not bind its inputs");
  const expected = buildPlan({
    jobId,
    nonceDigest,
    createdAt,
    expiresAt,
    subject,
    inputs,
    imageDigest,
    destinations,
  });
  if (canonicalJson(root) !== canonicalJson(expected)) {
    throw new Error("Publication runner plan contains unsupported or weakened controls");
  }
  return recordForPlan(expected);
}

/** Refuse an early, expired, or internally altered plan at execution time. */
export function assertPublicationRunnerPlanCurrent(
  value: PublicationRunnerPlanRecord,
  now = Date.now()
): PublicationRunnerPlanRecord {
  const current = validatePlanRecord(value);
  const observedAt = timestamp(now, "runner execution clock");
  if (observedAt < current.plan.job.createdAt || observedAt >= current.plan.job.expiresAt) {
    throw new Error("Publication runner plan is not currently valid");
  }
  return current;
}

/**
 * Verify an independently signed control-plane attestation against both the
 * pre-run plan and the separately reviewed post-run output. Wrapper output or
 * a container self-report cannot satisfy this boundary without the pinned key.
 */
export function verifyPublicationRunnerAttestation(
  envelopeJson: string,
  expectedPlan: PublicationRunnerPlanRecord,
  expectedReviewedOutput: PublicationRunnerOutput,
  trust: RunnerAttestationTrust
): VerifiedPublicationRunnerAttestation {
  const planRecord = validatePlanRecord(expectedPlan);
  const reviewedOutput = validateRunnerOutput(expectedReviewedOutput);
  const envelopeRoot = parseCanonicalJson(
    envelopeJson,
    MAX_ATTESTATION_ENVELOPE_BYTES,
    "runner attestation envelope"
  );
  const envelopeObject = record(envelopeRoot, "runner attestation envelope");
  exactKeys(
    envelopeObject,
    ["schemaVersion", "keyId", "payload", "signature"],
    "runner attestation envelope"
  );
  if (envelopeObject.schemaVersion !== 1) {
    throw new Error("Runner attestation envelope version is unsupported");
  }
  const envelope: AttestationEnvelope = {
    schemaVersion: 1,
    keyId: identifier(envelopeObject.keyId, "runner attestation key id"),
    payload: boundedString(
      envelopeObject.payload,
      "runner attestation payload",
      MAX_ATTESTATION_ENVELOPE_BYTES
    ),
    signature: boundedString(envelopeObject.signature, "runner attestation signature", 256),
  };
  const trusted = validateAttestationTrust(trust);
  if (envelope.keyId !== trusted.keyId) throw new Error("Runner attestation signer is not pinned");
  const payloadBytes = canonicalBase64Url(envelope.payload, "runner attestation payload");
  if (payloadBytes.length === 0 || payloadBytes.length > MAX_ATTESTATION_PAYLOAD_BYTES) {
    throw new Error("Runner attestation payload exceeds the supported size");
  }
  const payloadJson = exactUtf8(payloadBytes, "runner attestation payload");
  const payloadRoot = parseCanonicalJson(
    payloadJson,
    MAX_ATTESTATION_PAYLOAD_BYTES,
    "runner attestation payload"
  );
  const signatureBytes = canonicalBase64Url(envelope.signature, "runner attestation signature");
  if (signatureBytes.length !== 64) throw new Error("Runner attestation signature must be 64 bytes");
  if (!verifySignature(
    null,
    Buffer.concat([
      Buffer.from(PUBLICATION_RUNNER_ATTESTATION_DOMAIN, "utf8"),
      payloadBytes,
    ]),
    trusted.publicKey,
    signatureBytes
  )) {
    throw new Error("Runner control-plane signature verification failed");
  }
  const attestation = validateAttestationPayload(payloadRoot, planRecord.plan, reviewedOutput);
  if (trusted.revokedAt !== null) throw new Error("Runner attestation key is revoked");
  if (attestation.observedAt < trusted.validFrom || attestation.observedAt >= trusted.validUntil) {
    throw new Error("Runner attestation was observed outside the signing-key validity window");
  }
  return deepFreeze({
    attestation,
    canonicalJson: payloadJson,
    payloadDigest: sha256(payloadBytes),
    envelopeDigest: sha256(Buffer.from(envelopeJson, "utf8")),
    signer: { keyId: trusted.keyId, fingerprint: trusted.fingerprint },
  });
}

function buildPlan(input: {
  jobId: string;
  nonceDigest: string;
  createdAt: number;
  expiresAt: number;
  subject: PublicationRunnerPlan["subject"];
  inputs: PublicationRunnerPlan["inputs"];
  imageDigest: string;
  destinations: RunnerEgressDestination[];
}): PublicationRunnerPlan {
  const policyDigest = egressPolicyDigest(input.destinations);
  return {
    schemaVersion: 1,
    profile: PUBLICATION_RUNNER_PROFILE,
    job: {
      id: input.jobId,
      nonceDigest: input.nonceDigest,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      disposable: true,
    },
    subject: input.subject,
    inputs: input.inputs,
    imageDigest: input.imageDigest,
    egress: {
      enforcement: "host_nftables_output_exact_ip_tcp443",
      dnsInsideJob: "disabled",
      install: {
        destinations: input.destinations,
        policyDigest,
        applicationLayerEnforcement: "external_l7_gateway_required",
      },
      checks: { network: "none" },
    },
    execution: {
      identity: `${input.jobId}:migration`,
      credentials: "none",
      repositoryCodeExecution: true,
      sourceReadOnly: true,
      writableOutput: "bounded_tmpfs_then_root_sealed_transfer",
      rootlessContainer: true,
      readOnlyRoot: true,
      capabilities: "none",
      noNewPrivileges: true,
      proxyEnvironment: "absent",
      dependencyLifecycleScripts: "disabled",
      onlinePhase: "dependency_install_only",
      phaseOrder: ["dependency_install", "migration", "verification"],
      installEgressPolicyDigest: policyDigest,
      checksNetwork: "none",
      requiredChecks: ["install", "typecheck", "test", "lint", "runtime"],
      outputBinding: "signed_attestation_reviewed_output",
      storage: {
        enforcement: "bounded_tmpfs",
        workspaceBytes: 1_073_741_824,
        workspaceInodes: 200_000,
        maxLogBytesPerPhase: 10_485_760,
        maxRunnerEvidenceBytes: 98_304,
        maxOutputBytes: 536_870_912,
        maxOutputFileBytes: 268_435_456,
        maxOutputEntries: 50_000,
        maxOutputDepth: 64,
      },
    },
    teardown: {
      destroyContainer: true,
      destroyWorkspace: true,
      destroyNetworkNamespace: true,
      removeNftablesPolicy: true,
      evidenceRequired: true,
    },
  };
}

function validateAttestationPayload(
  value: unknown,
  plan: Readonly<PublicationRunnerPlan>,
  expectedReviewedOutput: PublicationRunnerOutput
): PublicationRunnerAttestation {
  const root = record(value, "runner attestation");
  exactKeys(root, [
    "schemaVersion",
    "profile",
    "planDigest",
    "jobId",
    "runnerInstanceDigest",
    "subject",
    "inputs",
    "output",
    "execution",
    "teardown",
    "observedAt",
  ], "runner attestation");
  if (root.schemaVersion !== 1 || root.profile !== PUBLICATION_RUNNER_PROFILE) {
    throw new Error("Runner attestation profile is unsupported");
  }
  const planDigest = digest(root.planDigest, "attested plan digest");
  if (planDigest !== sha256(Buffer.from(canonicalJson(plan), "utf8"))) {
    throw new Error("Runner attestation does not bind the expected plan");
  }
  const jobId = boundedString(root.jobId, "attested job id", 76);
  if (jobId !== plan.job.id) throw new Error("Runner attestation job identity does not match");
  const runnerInstanceDigest = digest(root.runnerInstanceDigest, "runner instance digest");
  const subject = validateSubject(root.subject);
  const inputs = validateInputs(root.inputs);
  const output = validateRunnerOutput(root.output);
  if (
    canonicalJson(subject) !== canonicalJson(plan.subject) ||
    canonicalJson(inputs) !== canonicalJson(plan.inputs) ||
    canonicalJson(output) !== canonicalJson(expectedReviewedOutput)
  ) {
    throw new Error("Runner attestation immutable input or output binding does not match");
  }
  const execution = validateExecutionAttestation(root.execution, plan, expectedReviewedOutput);
  const teardown = validateTeardownAttestation(root.teardown);
  const observedAt = timestamp(root.observedAt, "runner attestation observation time");
  if (
    execution.startedAt < plan.job.createdAt ||
    execution.finishedAt < execution.startedAt ||
    teardown.containersDestroyedAt < execution.finishedAt ||
    teardown.networkNamespaceDestroyedAt < teardown.containersDestroyedAt ||
    teardown.nftablesPolicyRemovedAt < teardown.networkNamespaceDestroyedAt ||
    teardown.workspaceDestroyedAt < teardown.containersDestroyedAt ||
    observedAt < teardown.nftablesPolicyRemovedAt ||
    observedAt < teardown.workspaceDestroyedAt ||
    observedAt >= plan.job.expiresAt
  ) {
    throw new Error("Runner attestation execution or teardown timeline is invalid");
  }
  return deepFreeze({
    schemaVersion: 1,
    profile: PUBLICATION_RUNNER_PROFILE,
    planDigest,
    jobId,
    runnerInstanceDigest,
    subject,
    inputs,
    output,
    execution,
    teardown,
    observedAt,
  });
}

function validateExecutionAttestation(
  value: unknown,
  plan: Readonly<PublicationRunnerPlan>,
  expectedReviewedOutput: PublicationRunnerOutput
): PublicationRunnerAttestation["execution"] {
  const root = record(value, "runner execution attestation");
  exactKeys(root, [
    "identity",
    "imageDigest",
    "executionInstanceDigest",
    "startedAt",
    "finishedAt",
    "credentialsObserved",
    "sourceReadOnly",
    "proxyEnvironmentObserved",
    "installEgressPolicyDigest",
    "egressEvidenceReference",
    "egressEvidenceDigest",
    "checksNetwork",
    "checks",
    "outputArtifactDigest",
    "candidateTreeSha",
    "status",
    "evidenceReference",
    "evidenceDigest",
  ], "runner execution attestation");
  if (
    root.identity !== plan.execution.identity ||
    root.imageDigest !== plan.imageDigest ||
    root.credentialsObserved !== "none" ||
    root.sourceReadOnly !== true ||
    root.proxyEnvironmentObserved !== "absent" ||
    root.installEgressPolicyDigest !== plan.egress.install.policyDigest ||
    root.checksNetwork !== "none" ||
    root.outputArtifactDigest !== expectedReviewedOutput.artifactDigest ||
    root.candidateTreeSha !== expectedReviewedOutput.candidateTreeSha ||
    root.status !== "passed"
  ) {
    throw new Error("Runner execution attestation does not satisfy the fixed phase policy");
  }
  return {
    identity: plan.execution.identity,
    imageDigest: plan.imageDigest,
    executionInstanceDigest: digest(root.executionInstanceDigest, "execution instance-set digest"),
    startedAt: timestamp(root.startedAt, "runner execution start"),
    finishedAt: timestamp(root.finishedAt, "runner execution finish"),
    credentialsObserved: "none",
    sourceReadOnly: true,
    proxyEnvironmentObserved: "absent",
    installEgressPolicyDigest: plan.egress.install.policyDigest,
    egressEvidenceReference: evidenceReference(root.egressEvidenceReference, "egress evidence"),
    egressEvidenceDigest: digest(root.egressEvidenceDigest, "egress evidence digest"),
    checksNetwork: "none",
    checks: validateChecks(root.checks),
    outputArtifactDigest: expectedReviewedOutput.artifactDigest,
    candidateTreeSha: expectedReviewedOutput.candidateTreeSha,
    status: "passed",
    evidenceReference: evidenceReference(root.evidenceReference, "execution evidence"),
    evidenceDigest: digest(root.evidenceDigest, "execution evidence digest"),
  };
}

function validateTeardownAttestation(
  value: unknown
): PublicationRunnerAttestation["teardown"] {
  const root = record(value, "runner teardown attestation");
  exactKeys(root, [
    "containersDestroyedAt",
    "networkNamespaceDestroyedAt",
    "nftablesPolicyRemovedAt",
    "workspaceDestroyedAt",
    "complete",
    "evidenceReference",
    "evidenceDigest",
  ], "runner teardown attestation");
  if (root.complete !== true) throw new Error("Runner teardown is incomplete");
  return {
    containersDestroyedAt: timestamp(root.containersDestroyedAt, "container destruction time"),
    networkNamespaceDestroyedAt: timestamp(
      root.networkNamespaceDestroyedAt,
      "network namespace destruction time"
    ),
    nftablesPolicyRemovedAt: timestamp(root.nftablesPolicyRemovedAt, "nftables removal time"),
    workspaceDestroyedAt: timestamp(root.workspaceDestroyedAt, "workspace destruction time"),
    complete: true,
    evidenceReference: evidenceReference(root.evidenceReference, "teardown evidence"),
    evidenceDigest: digest(root.evidenceDigest, "teardown evidence digest"),
  };
}

function validateChecks(value: unknown): PublicationRunnerAttestation["execution"]["checks"] {
  const root = record(value, "runner checks");
  exactKeys(root, ["install", "typecheck", "test", "lint", "runtime"], "runner checks");
  return {
    install: validateCheck(root.install, "install"),
    typecheck: validateCheck(root.typecheck, "typecheck"),
    test: validateCheck(root.test, "test"),
    lint: validateCheck(root.lint, "lint"),
    runtime: validateCheck(root.runtime, "runtime"),
  };
}

function validateCheck(value: unknown, name: string): RunnerCheckEvidence {
  const root = record(value, `${name} check`);
  exactKeys(root, ["status", "evidenceReference", "evidenceDigest"], `${name} check`);
  if (root.status !== "passed") throw new Error(`Runner ${name} check did not pass`);
  return {
    status: "passed",
    evidenceReference: evidenceReference(root.evidenceReference, `${name} check evidence`),
    evidenceDigest: digest(root.evidenceDigest, `${name} check evidence digest`),
  };
}

function validateSubject(value: unknown): PublicationRunnerPlan["subject"] {
  const root = record(value, "runner subject");
  exactKeys(root, ["pilotId", "repository", "base"], "runner subject");
  const pilotId = boundedString(root.pilotId, "pilot id", 86);
  if (!PILOT_ID.test(pilotId)) throw new Error("Publication runner pilot id is invalid");
  const repositoryRoot = record(root.repository, "runner repository");
  exactKeys(repositoryRoot, ["slug", "id", "ownerId"], "runner repository");
  const repository = parseRepositorySlug(
    boundedString(repositoryRoot.slug, "runner repository slug", 140)
  );
  if (repository.slug !== repository.slug.toLowerCase()) {
    throw new Error("Publication runner repository slug must be canonical lowercase");
  }
  const baseRoot = record(root.base, "runner base");
  exactKeys(baseRoot, ["branch", "sha"], "runner base");
  const sha = boundedString(baseRoot.sha, "runner base commit", 64);
  if (!GIT_SHA.test(sha)) throw new Error("Publication runner base commit is invalid");
  return {
    pilotId,
    repository: {
      slug: repository.slug,
      id: positiveInteger(repositoryRoot.id, "runner repository id"),
      ownerId: positiveInteger(repositoryRoot.ownerId, "runner repository owner id"),
    },
    base: {
      branch: validateBranchName(boundedString(baseRoot.branch, "runner base branch", 240)),
      sha,
    },
  };
}

function validateInputs(value: unknown): PublicationRunnerPlan["inputs"] {
  const root = record(value, "runner immutable inputs");
  exactKeys(
    root,
    ["sourceArchiveDigest", "manifestDigest", "commandScopeDigest"],
    "runner immutable inputs"
  );
  return {
    sourceArchiveDigest: digest(root.sourceArchiveDigest, "source archive digest"),
    manifestDigest: digest(root.manifestDigest, "manifest digest"),
    commandScopeDigest: digest(root.commandScopeDigest, "command scope digest"),
  };
}

function validateRunnerOutput(value: unknown): PublicationRunnerOutput {
  const root = record(value, "runner reviewed output");
  exactKeys(root, ["preflightId", "artifactDigest", "candidateTreeSha"], "runner reviewed output");
  const preflightId = boundedString(root.preflightId, "runner preflight id", 67);
  const candidateTreeSha = boundedString(root.candidateTreeSha, "candidate tree commit", 64);
  if (!PREFLIGHT_ID.test(preflightId) || !GIT_SHA.test(candidateTreeSha)) {
    throw new Error("Publication runner reviewed output identity is invalid");
  }
  return {
    preflightId,
    artifactDigest: digest(root.artifactDigest, "artifact digest"),
    candidateTreeSha,
  };
}

function normalizeAndValidateDestinations(
  value: unknown,
  createdAt: number,
  planExpiresAt: number
): RunnerEgressDestination[] {
  if (!Array.isArray(value) || value.length !== MIGRATION_HOSTS.length) {
    throw new Error("Publication runner installation egress must contain the exact destination set");
  }
  const destinations = value.map((entry) => validateDestination(entry, createdAt, planExpiresAt));
  destinations.sort((left, right) => left.host.localeCompare(right.host));
  if (destinations.map(({ host }) => host).join("\0") !== [...MIGRATION_HOSTS].sort().join("\0")) {
    throw new Error("Publication runner installation egress destination is not allowlisted");
  }
  return destinations;
}

function validateDestination(
  value: unknown,
  createdAt: number,
  planExpiresAt: number
): RunnerEgressDestination {
  const root = record(value, "installation egress destination");
  exactKeys(root, [
    "host",
    "protocol",
    "port",
    "tls",
    "addresses",
    "resolutionEvidenceDigest",
    "resolutionObservedAt",
    "resolutionExpiresAt",
  ], "installation egress destination");
  const host = boundedString(root.host, "installation egress host", 253);
  if (
    host !== host.toLowerCase() ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ||
    isIP(host) !== 0 ||
    root.protocol !== "tcp" ||
    root.port !== 443 ||
    root.tls !== true
  ) {
    throw new Error("Publication runner installation egress requires a canonical TLS host on TCP 443");
  }
  if (!Array.isArray(root.addresses) || root.addresses.length < 1 || root.addresses.length > 32) {
    throw new Error("Publication runner installation egress addresses are missing or excessive");
  }
  const addresses = root.addresses.map((address) => {
    const literal = boundedString(address, "installation egress address", 64);
    if (
      literal !== literal.toLowerCase() ||
      literal.includes("%") ||
      isIP(literal) === 0 ||
      canonicalIpLiteral(literal) !== literal ||
      !isGlobalUnicastLiteral(literal)
    ) {
      throw new Error(
        "Publication runner installation egress address must be an exact global-unicast IP"
      );
    }
    return literal;
  }).sort();
  if (new Set(addresses).size !== addresses.length) {
    throw new Error("Publication runner installation egress contains duplicate addresses");
  }
  const resolutionObservedAt = timestamp(root.resolutionObservedAt, "resolution observation time");
  const resolutionExpiresAt = timestamp(root.resolutionExpiresAt, "resolution expiry");
  if (
    resolutionObservedAt > createdAt ||
    createdAt - resolutionObservedAt > RESOLUTION_MAX_AGE_MS ||
    resolutionExpiresAt < planExpiresAt ||
    resolutionExpiresAt <= resolutionObservedAt ||
    resolutionExpiresAt - resolutionObservedAt > RESOLUTION_MAX_TTL_MS
  ) {
    throw new Error("Publication runner DNS resolution evidence is stale or unbounded");
  }
  return {
    host,
    protocol: "tcp",
    port: 443,
    tls: true,
    addresses,
    resolutionEvidenceDigest: digest(
      root.resolutionEvidenceDigest,
      "resolution evidence digest"
    ),
    resolutionObservedAt,
    resolutionExpiresAt,
  };
}

function canonicalIpLiteral(value: string): string {
  if (isIP(value) === 4) return value.split(".").map((part) => String(Number(part))).join(".");
  if (isIP(value) !== 6) return "";
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : "";
  } catch {
    return "";
  }
}

function isGlobalUnicastLiteral(value: string): boolean {
  if (isIP(value) === 4) {
    const [first, second, third] = value.split(".").map(Number) as [number, number, number];
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  if (isIP(value) !== 6 || value.includes(".")) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":").map((part) => Number.parseInt(part, 16)) : [];
  const right = halves[1] ? halves[1].split(":").map((part) => Number.parseInt(part, 16)) : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) return false;
  const words = halves.length === 2
    ? [...left, ...Array<number>(omitted).fill(0), ...right]
    : left;
  if (words.length !== 8) return false;
  const [first, second, third] = words as [number, number, number, ...number[]];
  // Conservatively admit native global unicast only; transition, benchmark,
  // documentation, and protocol-assignment ranges are not registry endpoints.
  return (
    first >= 0x2000 &&
    first <= 0x3ffe &&
    !(first === 0x2001 && second <= 0x01ff) &&
    !(first === 0x2001 && second === 0x0db8) &&
    !(first === 0x2001 && second === 0x0002 && third === 0) &&
    first !== 0x2002
  );
}

function egressPolicyDigest(destinations: RunnerEgressDestination[]): string {
  return sha256(Buffer.from(canonicalJson({
    schemaVersion: 1,
    phase: "dependency_install",
    enforcement: "host_nftables_output_exact_ip_tcp443",
    dnsInsideJob: "disabled",
    applicationLayerEnforcement: "external_l7_gateway_required",
    destinations,
  }), "utf8"));
}

function deriveJobId(input: {
  nonceDigest: string;
  createdAt: number;
  expiresAt: number;
  subject: PublicationRunnerPlan["subject"];
  inputs: PublicationRunnerPlan["inputs"];
  imageDigest: string;
}): string {
  return `previewjob_${createHash("sha256").update(canonicalJson(input), "utf8").digest("hex")}`;
}

function assertPlanLifetime(createdAt: number, expiresAt: number): void {
  const lifetime = expiresAt - createdAt;
  if (
    lifetime < PUBLICATION_RUNNER_PLAN_MIN_TTL_MS ||
    lifetime > PUBLICATION_RUNNER_PLAN_MAX_TTL_MS
  ) {
    throw new Error("Publication runner plan lifetime must be between 1 and 15 minutes");
  }
}

function recordForPlan(plan: PublicationRunnerPlan): PublicationRunnerPlanRecord {
  const canonical = canonicalJson(plan);
  return deepFreeze({
    plan,
    canonicalJson: canonical,
    digest: sha256(Buffer.from(canonical, "utf8")),
  });
}

function validatePlanRecord(value: PublicationRunnerPlanRecord): PublicationRunnerPlanRecord {
  if (!value || typeof value !== "object") throw new Error("Publication runner plan record is missing");
  const validated = validatePublicationRunnerPlan(value.plan);
  if (value.canonicalJson !== validated.canonicalJson || value.digest !== validated.digest) {
    throw new Error("Publication runner plan record digest or canonical bytes do not match");
  }
  return validated;
}

function validateAttestationTrust(value: RunnerAttestationTrust): RunnerAttestationTrust & {
  publicKey: KeyObject;
} {
  const root = record(value, "runner attestation trust");
  exactKeys(root, [
    "keyId",
    "algorithm",
    "publicKeyPem",
    "fingerprint",
    "validFrom",
    "validUntil",
    "revokedAt",
  ], "runner attestation trust");
  if (root.algorithm !== "Ed25519") throw new Error("Runner attestation key algorithm is unsupported");
  const validFrom = timestamp(root.validFrom, "runner attestation key validFrom");
  const validUntil = timestamp(root.validUntil, "runner attestation key validUntil");
  if (validUntil <= validFrom) throw new Error("Runner attestation key validity window is empty");
  const revokedAt = root.revokedAt === null
    ? null
    : timestamp(root.revokedAt, "runner attestation key revocation");
  const publicKeyPem = boundedMultilineString(
    root.publicKeyPem,
    "runner attestation public key",
    16 * 1_024
  );
  let publicKey: KeyObject;
  let canonicalPem: string;
  try {
    publicKey = createPublicKey(publicKeyPem);
    canonicalPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  } catch {
    throw new Error("Runner attestation public key must be canonical Ed25519 SPKI PEM");
  }
  if (publicKeyPem !== canonicalPem || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Runner attestation public key must be canonical Ed25519 SPKI PEM");
  }
  const fingerprint = digest(root.fingerprint, "runner attestation key fingerprint");
  if (fingerprint !== sha256(publicKey.export({ type: "spki", format: "der" }))) {
    throw new Error("Runner attestation key fingerprint does not match");
  }
  return {
    keyId: identifier(root.keyId, "runner attestation key id"),
    algorithm: "Ed25519",
    publicKeyPem,
    fingerprint,
    validFrom,
    validUntil,
    revokedAt,
    publicKey,
  };
}

function canonicalBase64Url(value: string, label: string): Buffer {
  if (!BASE64URL.test(value)) throw new Error(`${label} is not canonical base64url`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error(`${label} is not canonical base64url`);
  return decoded;
}

function exactUtf8(value: Buffer, label: string): string {
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) throw new Error(`${label} is not exact UTF-8`);
  return text;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} is invalid`);
  canonicalJson(value);
  return value as Record<string, unknown>;
}

function exactKeys(root: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(root).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} contains missing or unexpected fields`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function identifier(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 128);
  if (!IDENTIFIER.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function evidenceReference(value: unknown, label: string): string {
  const parsed = boundedString(value, label, MAX_EVIDENCE_REFERENCE_BYTES);
  if (Buffer.byteLength(parsed, "utf8") < 6 || /[\u0000-\u001f\u007f]/.test(parsed)) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`${label} is invalid`);
  }
  // Reuse the authorization boundary's Unicode and accessor checks.
  canonicalJson(value);
  return value;
}

function boundedMultilineString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`${label} is invalid`);
  }
  canonicalJson(value);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} is invalid`);
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_TIMESTAMP) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
