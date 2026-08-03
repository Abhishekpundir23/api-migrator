import {
  canonicalSha256,
  OWNER_AUTHORIZATION_AUDIENCE,
  OWNER_AUTHORIZATION_MAX_TTL_MS,
  type ExpectedOwnerAuthorizationBindings,
  type OwnerAuthorizationAction,
} from "./owner-authorization.js";
import {
  parseRepositorySlug,
  validateBranchName,
} from "./repository.js";
import {
  canonicalJson,
  parseCanonicalJson as parseExactCanonicalJson,
} from "./canonical-json.js";

export const OWNER_AUTHORIZATION_CHALLENGE_KIND = "owner_publication_challenge";
export const OWNER_AUTHORIZATION_CHALLENGE_MAX_AGE_MS = 10 * 60 * 1_000;
export const OWNER_AUTHORIZATION_CHALLENGE_MAX_TTL_MS = OWNER_AUTHORIZATION_MAX_TTL_MS;

const MAX_CHALLENGE_BYTES = 64 * 1024;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const PREFLIGHT_ID = /^pf_[a-f0-9]{64}$/;
const EMPTY_SET_DIGEST = canonicalSha256([]);

export interface OwnerAuthorizationChallengeV1 {
  version: 1;
  kind: typeof OWNER_AUTHORIZATION_CHALLENGE_KIND;
  audience: typeof OWNER_AUTHORIZATION_AUDIENCE;
  createdAt: number;
  expiresAt: number;
  /** Publication blockers are absolute. A signable challenge always binds an empty set. */
  blockers: [];
  bindings: ExpectedOwnerAuthorizationBindings;
  /** SHA-256 of every preceding field using owner-authorization canonical JSON. */
  challengeDigest: string;
}

export interface OwnerAuthorizationChallengeArtifact {
  challengeJson: string;
  challengeDigest: string;
  expiresAt: number;
  challenge: Readonly<OwnerAuthorizationChallengeV1>;
}

export interface CreateOwnerAuthorizationChallengeInput {
  bindings: ExpectedOwnerAuthorizationBindings;
  /** Must be the complete blocker list from the exact preview. */
  blockers: readonly unknown[];
  now?: number;
  ttlMs?: number;
}

/**
 * Produce a canonical, read-only challenge for one exact blocker-free preview.
 * This function performs no authentication, database, Git, or GitHub operation.
 */
export function createOwnerAuthorizationChallenge(
  input: CreateOwnerAuthorizationChallengeInput
): OwnerAuthorizationChallengeArtifact {
  if (!Array.isArray(input.blockers)) reject("complete preview blockers are required");
  if (input.blockers.length !== 0) reject("blocked previews cannot produce an owner challenge");

  const now = validTimestamp(input.now ?? Date.now(), "challenge clock");
  const bindings = validateBindings(input.bindings);
  assertPreviewFresh(bindings, now);
  if (bindings.authorizationExpiresAt <= now) reject("underlying owner authorization has expired");

  const ttlMs = validDuration(
    input.ttlMs ?? OWNER_AUTHORIZATION_CHALLENGE_MAX_TTL_MS,
    "challenge TTL",
    OWNER_AUTHORIZATION_CHALLENGE_MAX_TTL_MS
  );
  const expiresAt = Math.min(now + ttlMs, bindings.authorizationExpiresAt);
  if (expiresAt <= now) reject("challenge authorization window is empty");

  const body: Omit<OwnerAuthorizationChallengeV1, "challengeDigest"> = {
    version: 1 as const,
    kind: OWNER_AUTHORIZATION_CHALLENGE_KIND,
    audience: OWNER_AUTHORIZATION_AUDIENCE,
    createdAt: now,
    expiresAt,
    blockers: [] as [],
    bindings,
  };
  const challengeDigest = canonicalSha256(body);
  const challenge = deepFreeze<OwnerAuthorizationChallengeV1>({
    ...body,
    challengeDigest,
  });
  return {
    challengeJson: canonicalJson(challenge),
    challengeDigest,
    expiresAt,
    challenge,
  };
}

/** Parse and revalidate exact canonical challenge bytes at signing time. */
export function parseOwnerAuthorizationChallenge(
  challengeJson: string,
  now = Date.now()
): Readonly<OwnerAuthorizationChallengeV1> {
  const clock = validTimestamp(now, "challenge clock");
  const raw = parseChallengeJson(challengeJson);
  assertExactKeys(raw, [
    "version",
    "kind",
    "audience",
    "createdAt",
    "expiresAt",
    "blockers",
    "bindings",
    "challengeDigest",
  ], "challenge");
  if (raw.version !== 1) reject("unsupported challenge version");
  if (raw.kind !== OWNER_AUTHORIZATION_CHALLENGE_KIND) reject("invalid challenge kind");
  if (raw.audience !== OWNER_AUTHORIZATION_AUDIENCE) reject("invalid challenge audience");
  if (!Array.isArray(raw.blockers) || raw.blockers.length !== 0) {
    reject("blocked previews cannot be signed");
  }

  const createdAt = validTimestamp(raw.createdAt, "challenge createdAt");
  const expiresAt = validTimestamp(raw.expiresAt, "challenge expiresAt");
  if (createdAt > clock) reject("challenge was created in the future");
  if (expiresAt <= createdAt || expiresAt - createdAt > OWNER_AUTHORIZATION_CHALLENGE_MAX_TTL_MS) {
    reject("challenge validity window is invalid");
  }
  if (clock >= expiresAt) reject("challenge has expired");

  const bindings = validateBindings(raw.bindings);
  assertPreviewFresh(bindings, createdAt);
  if (expiresAt > bindings.authorizationExpiresAt) {
    reject("challenge outlives the underlying owner authorization");
  }
  const challengeDigest = validDigest(raw.challengeDigest, "challenge digest");
  const body: Omit<OwnerAuthorizationChallengeV1, "challengeDigest"> = {
    version: 1 as const,
    kind: OWNER_AUTHORIZATION_CHALLENGE_KIND,
    audience: OWNER_AUTHORIZATION_AUDIENCE,
    createdAt,
    expiresAt,
    blockers: [] as [],
    bindings,
  };
  if (canonicalSha256(body) !== challengeDigest) reject("challenge digest does not match");
  return deepFreeze<OwnerAuthorizationChallengeV1>({ ...body, challengeDigest });
}

function validateBindings(value: unknown): ExpectedOwnerAuthorizationBindings {
  const object = asRecord(value, "bindings");
  assertExactKeys(object, [
    "pilotId",
    "approvalEvidenceDigest",
    "preRunAuthorizationDigest",
    "previewCompletedAt",
    "authorizationExpiresAt",
    "repository",
    "github",
    "base",
    "engine",
    "manifest",
    "preview",
    "allowedActions",
    "pullRequestNumber",
  ], "bindings");

  const repository = asRecord(object.repository, "bindings.repository");
  assertExactKeys(repository, ["slug", "id", "ownerId"], "bindings.repository");
  const slug = validString(repository.slug, "repository slug", 140);
  parseRepositorySlug(slug);
  if (slug !== slug.toLowerCase()) reject("repository slug must be lowercase canonical owner/repo");

  const github = asRecord(object.github, "bindings.github");
  assertExactKeys(github, ["appId", "installationId"], "bindings.github");

  const base = asRecord(object.base, "bindings.base");
  assertExactKeys(base, ["branch", "sha"], "bindings.base");
  const baseBranch = validString(base.branch, "base branch", 240);
  validateBranchName(baseBranch);

  const engine = asRecord(object.engine, "bindings.engine");
  assertExactKeys(engine, ["tag", "commit"], "bindings.engine");
  const engineTag = validString(engine.tag, "engine tag", 128);
  if (engineTag !== engineTag.trim() || /[\u0000-\u0020\u007f]/.test(engineTag)) {
    reject("invalid engine tag");
  }

  const manifest = asRecord(object.manifest, "bindings.manifest");
  assertExactKeys(manifest, ["byteLength", "digest"], "bindings.manifest");

  const preview = asRecord(object.preview, "bindings.preview");
  assertExactKeys(preview, [
    "preflightId",
    "artifactDigest",
    "candidateBranch",
    "candidateTreeSha",
    "findingsDigest",
    "resolutionsDigest",
    "commandScopeDigest",
    "runnerAttestationDigest",
    "rulesetDigest",
    "requiredCiDigest",
  ], "bindings.preview");
  const preflightId = validString(preview.preflightId, "preflightId", 67);
  if (!PREFLIGHT_ID.test(preflightId)) reject("invalid preflightId");
  const candidateBranch = validString(preview.candidateBranch, "candidate branch", 240);
  validateBranchName(candidateBranch);
  if (candidateBranch === baseBranch) reject("candidate branch must differ from the base branch");

  const findingsDigest = validDigest(preview.findingsDigest, "findings digest");
  const resolutionsDigest = validDigest(preview.resolutionsDigest, "resolutions digest");
  if (findingsDigest !== EMPTY_SET_DIGEST || resolutionsDigest !== EMPTY_SET_DIGEST) {
    reject("owner challenges require canonical empty findings and resolutions");
  }

  const allowedActions = validateActions(object.allowedActions);
  const pullRequestNumber = object.pullRequestNumber === null
    ? null
    : validPositiveInteger(object.pullRequestNumber, "pullRequestNumber");
  if (allowedActions.includes("create_pull_request") && pullRequestNumber !== null) {
    reject("new pull-request action cannot bind an existing pull request");
  }
  if (allowedActions[0] === "update_pull_request" && pullRequestNumber === null) {
    reject("pull-request update action must bind its exact pull request number");
  }

  return {
    pilotId: validIdentifier(object.pilotId, "pilotId"),
    approvalEvidenceDigest: validDigest(object.approvalEvidenceDigest, "approval evidence digest"),
    preRunAuthorizationDigest: validDigest(object.preRunAuthorizationDigest, "pre-run authorization digest"),
    previewCompletedAt: validTimestamp(object.previewCompletedAt, "previewCompletedAt"),
    authorizationExpiresAt: validTimestamp(object.authorizationExpiresAt, "authorizationExpiresAt"),
    repository: {
      slug,
      id: validPositiveInteger(repository.id, "repository id"),
      ownerId: validPositiveInteger(repository.ownerId, "repository owner id"),
    },
    github: {
      appId: validPositiveInteger(github.appId, "GitHub App id"),
      installationId: validPositiveInteger(github.installationId, "GitHub installation id"),
    },
    base: {
      branch: baseBranch,
      sha: validGitSha(base.sha, "base sha"),
    },
    engine: {
      tag: engineTag,
      commit: validGitSha(engine.commit, "engine commit"),
    },
    manifest: {
      byteLength: validPositiveInteger(manifest.byteLength, "manifest byteLength"),
      digest: validDigest(manifest.digest, "manifest digest"),
    },
    preview: {
      preflightId,
      artifactDigest: validDigest(preview.artifactDigest, "artifact digest"),
      candidateBranch,
      candidateTreeSha: validGitSha(preview.candidateTreeSha, "candidate tree sha"),
      findingsDigest,
      resolutionsDigest,
      commandScopeDigest: validDigest(preview.commandScopeDigest, "command scope digest"),
      runnerAttestationDigest: validDigest(preview.runnerAttestationDigest, "runner attestation digest"),
      rulesetDigest: validDigest(preview.rulesetDigest, "ruleset digest"),
      requiredCiDigest: validDigest(preview.requiredCiDigest, "required CI digest"),
    },
    allowedActions,
    pullRequestNumber,
  };
}

function validateActions(value: unknown): OwnerAuthorizationAction[] {
  if (!Array.isArray(value)) reject("allowedActions must be an array");
  if (value.some((entry) => typeof entry !== "string")) {
    reject("allowedActions contains a malformed action");
  }
  const joined = value.join("\0");
  if (![
    "create_branch\0create_pull_request",
    "create_pull_request",
    "update_pull_request",
  ].includes(joined)) {
    reject("allowedActions is not an exact canonical publication state");
  }
  return [...value] as OwnerAuthorizationAction[];
}

function assertPreviewFresh(bindings: ExpectedOwnerAuthorizationBindings, clock: number): void {
  if (bindings.previewCompletedAt > clock) reject("preview completion is in the future");
  if (clock - bindings.previewCompletedAt > OWNER_AUTHORIZATION_CHALLENGE_MAX_AGE_MS) {
    reject("preview is stale; run a new preview");
  }
  if (bindings.authorizationExpiresAt <= bindings.previewCompletedAt) {
    reject("preview falls outside the underlying owner authorization");
  }
}

function parseChallengeJson(input: unknown): Record<string, unknown> {
  try {
    return asRecord(
      parseExactCanonicalJson(input, MAX_CHALLENGE_BYTES, "owner challenge"),
      "challenge"
    );
  } catch {
    reject("challenge must contain exact canonical JSON within the supported size");
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  object: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string
): void {
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    reject(`${label} has unknown or missing fields`);
  }
}

function validString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    reject(`${label} is missing or exceeds the supported size`);
  }
  assertUnicode(value, label);
  return value;
}

function validIdentifier(value: unknown, label: string): string {
  const identifier = validString(value, label, 128);
  if (!IDENTIFIER.test(identifier)) reject(`${label} is not a canonical identifier`);
  return identifier;
}

function validDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    reject(`${label} must be lowercase sha256:<64hex>`);
  }
  return value;
}

function validGitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) reject(`${label} is invalid`);
  return value;
}

function validPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    reject(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function validTimestamp(value: unknown, label: string): number {
  const timestamp = validPositiveInteger(value, label);
  if (timestamp > MAX_TIMESTAMP) reject(`${label} exceeds the supported timestamp range`);
  return timestamp;
}

function validDuration(value: unknown, label: string, max: number): number {
  const duration = validPositiveInteger(value, label);
  if (duration > max) reject(`${label} exceeds the supported maximum`);
  return duration;
}

function assertUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject(`${label} contains invalid Unicode`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      reject(`${label} contains invalid Unicode`);
    }
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function reject(message: string): never {
  throw new Error(`Owner challenge rejected: ${message}`);
}
