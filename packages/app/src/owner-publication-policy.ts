import { createHash } from "node:crypto";
import type { MigrationReport } from "@api-migrator/engine";
import {
  canonicalSha256,
  type ExpectedOwnerAuthorizationBindings,
  type OwnerAuthorizationAction,
} from "./owner-authorization.js";
import type { GitHubAppAuthIdentity } from "./auth.js";
import type { OpenPullRequestIdentity } from "./publication.js";
import {
  assertVerifiedPublicationRunnerAttestation,
  type VerifiedPublicationRunnerAttestation,
} from "./publication-runner.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;

export interface OwnerPublicationPolicy {
  registryPath: string;
  pilotId: string;
  approvalEvidenceDigest: string;
  preRunAuthorizationDigest: string;
  authorizationExpiresAt: number;
  engineTag: string;
  engineCommit: string;
  commandScopeDigest: string;
  rulesetDigest: string;
  requiredCiDigest: string;
}

export interface RemotePublicationState {
  sha: string | null;
  pullRequest: OpenPullRequestIdentity | null;
  pushRequired: boolean;
}

/**
 * Load non-runner owner-authorization bindings from trusted runtime
 * configuration. Runner identity is accepted only as an opaque capability
 * returned by the signed-attestation verifier; a configured digest is refused.
 */
export function readOwnerPublicationPolicy(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): OwnerPublicationPolicy {
  if (Object.prototype.hasOwnProperty.call(env, "API_MIGRATOR_RUNNER_ATTESTATION_DIGEST")) {
    throw new Error(
      "Owner publication rejects raw API_MIGRATOR_RUNNER_ATTESTATION_DIGEST configuration"
    );
  }
  const authorizationExpiresAt = timestamp(
    required(env, "API_MIGRATOR_PRE_RUN_AUTHORIZATION_EXPIRES_AT"),
    "API_MIGRATOR_PRE_RUN_AUTHORIZATION_EXPIRES_AT"
  );
  if (authorizationExpiresAt <= now) {
    throw new Error("Owner publication policy is expired");
  }
  return {
    registryPath: required(env, "API_MIGRATOR_OWNER_KEY_REGISTRY_PATH"),
    pilotId: identifier(required(env, "API_MIGRATOR_PILOT_ID"), "API_MIGRATOR_PILOT_ID"),
    approvalEvidenceDigest: digest(
      required(env, "API_MIGRATOR_APPROVAL_EVIDENCE_DIGEST"),
      "API_MIGRATOR_APPROVAL_EVIDENCE_DIGEST"
    ),
    preRunAuthorizationDigest: digest(
      required(env, "API_MIGRATOR_PRE_RUN_AUTHORIZATION_DIGEST"),
      "API_MIGRATOR_PRE_RUN_AUTHORIZATION_DIGEST"
    ),
    authorizationExpiresAt,
    engineTag: engineTag(required(env, "API_MIGRATOR_ENGINE_TAG")),
    engineCommit: gitSha(required(env, "API_MIGRATOR_ENGINE_COMMIT"), "API_MIGRATOR_ENGINE_COMMIT"),
    commandScopeDigest: digest(
      required(env, "API_MIGRATOR_COMMAND_SCOPE_DIGEST"),
      "API_MIGRATOR_COMMAND_SCOPE_DIGEST"
    ),
    rulesetDigest: digest(
      required(env, "API_MIGRATOR_RULESET_DIGEST"),
      "API_MIGRATOR_RULESET_DIGEST"
    ),
    requiredCiDigest: digest(
      required(env, "API_MIGRATOR_REQUIRED_CI_DIGEST"),
      "API_MIGRATOR_REQUIRED_CI_DIGEST"
    ),
  };
}

export function ownerAuthorizedRemoteAction(
  remote: RemotePublicationState
): { allowedActions: OwnerAuthorizationAction[]; pullRequestNumber: number | null } {
  if (remote.pushRequired) {
    if (remote.sha !== null || remote.pullRequest !== null) {
      throw new Error("Remote publication state is internally inconsistent");
    }
    return {
      allowedActions: ["create_branch", "create_pull_request"],
      pullRequestNumber: null,
    };
  }
  if (!remote.sha || !GIT_SHA.test(remote.sha)) {
    throw new Error("Remote publication state is missing the immutable branch head");
  }
  if (remote.pullRequest === null) {
    return { allowedActions: ["create_pull_request"], pullRequestNumber: null };
  }
  if (!Number.isSafeInteger(remote.pullRequest.number) || remote.pullRequest.number <= 0) {
    throw new Error("Remote publication state has an invalid pull request identity");
  }
  return {
    allowedActions: ["update_pull_request"],
    pullRequestNumber: remote.pullRequest.number,
  };
}

export function buildExpectedOwnerAuthorizationBindings(input: {
  policy: OwnerPublicationPolicy;
  /** Must be the exact in-process capability returned by the runner verifier. */
  runnerAttestation: VerifiedPublicationRunnerAttestation | undefined;
  /** Testable trusted clock. Production callers should omit it. */
  now?: number;
  previewCompletedAt: number;
  repositorySlug: string;
  github: GitHubAppAuthIdentity;
  baseBranch: string;
  baseSha: string;
  manifestJson: string;
  preflightId: string;
  artifactDigest: string;
  candidateBranch: string;
  candidateTreeSha: string;
  report: MigrationReport;
  remote: RemotePublicationState;
}): ExpectedOwnerAuthorizationBindings {
  const action = ownerAuthorizedRemoteAction(input.remote);
  const runnerAttestationDigest = verifiedRunnerAttestationDigest(input);
  const findings = input.report.entries
    .filter((entry) => entry.kind === "review")
    .map((entry) => ({
      code: entry.code,
      file: entry.file,
      line: entry.line ?? null,
      message: entry.message,
    }))
    .sort((left, right) =>
      `${left.file}:${left.line ?? 0}:${left.code}:${left.message}`.localeCompare(
        `${right.file}:${right.line ?? 0}:${right.code}:${right.message}`
      )
    );
  return {
    pilotId: input.policy.pilotId,
    approvalEvidenceDigest: input.policy.approvalEvidenceDigest,
    preRunAuthorizationDigest: input.policy.preRunAuthorizationDigest,
    previewCompletedAt: timestamp(input.previewCompletedAt, "previewCompletedAt"),
    authorizationExpiresAt: input.policy.authorizationExpiresAt,
    repository: {
      slug: input.repositorySlug.toLowerCase(),
      id: positiveInteger(input.github.repositoryId, "repository id"),
      ownerId: positiveInteger(input.github.repositoryOwnerId, "repository owner id"),
    },
    github: {
      appId: positiveInteger(input.github.appId, "GitHub App id"),
      installationId: positiveInteger(input.github.installationId, "GitHub installation id"),
    },
    base: {
      branch: input.baseBranch,
      sha: gitSha(input.baseSha, "base sha"),
    },
    engine: {
      tag: input.policy.engineTag,
      commit: input.policy.engineCommit,
    },
    manifest: {
      byteLength: Buffer.byteLength(input.manifestJson, "utf8"),
      digest: sha256Utf8(input.manifestJson),
    },
    preview: {
      preflightId: input.preflightId,
      artifactDigest: normalizeDigest(input.artifactDigest, "artifact digest"),
      candidateBranch: input.candidateBranch,
      candidateTreeSha: gitSha(input.candidateTreeSha, "candidate tree sha"),
      findingsDigest: canonicalSha256(findings),
      resolutionsDigest: canonicalSha256([]),
      commandScopeDigest: input.policy.commandScopeDigest,
      runnerAttestationDigest,
      rulesetDigest: input.policy.rulesetDigest,
      requiredCiDigest: input.policy.requiredCiDigest,
    },
    allowedActions: action.allowedActions,
    pullRequestNumber: action.pullRequestNumber,
  };
}

function verifiedRunnerAttestationDigest(input: {
  policy: OwnerPublicationPolicy;
  runnerAttestation: VerifiedPublicationRunnerAttestation | undefined;
  now?: number;
  repositorySlug: string;
  github: GitHubAppAuthIdentity;
  baseBranch: string;
  baseSha: string;
  manifestJson: string;
  preflightId: string;
  artifactDigest: string;
  candidateTreeSha: string;
}): string {
  const verified = assertVerifiedPublicationRunnerAttestation(input.runnerAttestation, input.now);
  const attested = verified.attestation;
  const repositorySlug = input.repositorySlug.toLowerCase();
  const artifactDigest = normalizeDigest(input.artifactDigest, "artifact digest");
  if (
    attested.subject.pilotId !== input.policy.pilotId ||
    attested.subject.repository.slug !== repositorySlug ||
    attested.subject.repository.id !== input.github.repositoryId ||
    attested.subject.repository.ownerId !== input.github.repositoryOwnerId ||
    attested.subject.base.branch !== input.baseBranch ||
    attested.subject.base.sha !== input.baseSha ||
    attested.inputs.manifestDigest !== sha256Utf8(input.manifestJson) ||
    attested.inputs.commandScopeDigest !== input.policy.commandScopeDigest ||
    attested.output.preflightId !== input.preflightId ||
    attested.output.artifactDigest !== artifactDigest ||
    attested.output.candidateTreeSha !== input.candidateTreeSha
  ) {
    throw new Error("Verified runner attestation does not match current owner-publication bindings");
  }
  return verified.payloadDigest;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`Owner publication policy requires ${name}`);
  }
  if (Buffer.byteLength(value, "utf8") > 4_096 || /[\r\n\0]/.test(value)) {
    throw new Error(`Owner publication policy has invalid ${name}`);
  }
  return value;
}

function digest(value: string, label: string): string {
  if (!DIGEST.test(value)) throw new Error(`Owner publication policy has invalid ${label}`);
  return value;
}

function normalizeDigest(value: string, label: string): string {
  return digest(value.startsWith("sha256:") ? value : `sha256:${value}`, label);
}

function identifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Owner publication policy has invalid ${label}`);
  return value;
}

function engineTag(value: string): string {
  if (Buffer.byteLength(value, "utf8") > 128 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error("Owner publication policy has invalid API_MIGRATOR_ENGINE_TAG");
  }
  return value;
}

function gitSha(value: string, label: string): string {
  if (!GIT_SHA.test(value)) throw new Error(`Owner publication policy has invalid ${label}`);
  return value;
}

function timestamp(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== String(value)) {
    throw new Error(`Owner publication policy has invalid ${label}`);
  }
  return parsed;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Owner publication policy has invalid ${label}`);
  }
  return value;
}

function sha256Utf8(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
