import {
  createOwnerAuthorizationChallenge,
  OWNER_AUTHORIZATION_CHALLENGE_MAX_TTL_MS,
  type OwnerAuthorizationChallengeArtifact,
} from "./owner-challenge.js";
import type { ExpectedOwnerAuthorizationBindings } from "./owner-authorization.js";
import type { PublicationBlocker } from "./publication.js";

const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PREFLIGHT_ID = /^pf_[a-f0-9]{64}$/;
const PREVIEW_RECEIPT_MAX_REMAINING_MS = 10 * 60 * 1_000;

/** Exact preview receipt fields accepted by the read-only challenge path. */
export interface OwnerChallengePreparationRequest {
  preflightId: string;
  artifactDigest: string;
  candidateTreeSha: string;
  previewCompletedAt: number;
  previewReceiptExpiresAt: number;
}

export interface CurrentOwnerChallengePreview {
  preflightId: string;
  artifactDigest: string;
  candidateTreeSha: string;
}

/**
 * Validate the console receipt projection before any repository work starts.
 * The receipt itself remains the console's HMAC-authenticated authority.
 */
export function validateOwnerChallengePreparationRequest(
  value: unknown,
  now = Date.now()
): OwnerChallengePreparationRequest {
  const object = asRecord(value, "owner challenge request");
  assertExactKeys(object, [
    "preflightId",
    "artifactDigest",
    "candidateTreeSha",
    "previewCompletedAt",
    "previewReceiptExpiresAt",
  ]);
  const clock = timestamp(now, "challenge clock");
  const previewCompletedAt = timestamp(object.previewCompletedAt, "preview completion time");
  const previewReceiptExpiresAt = timestamp(
    object.previewReceiptExpiresAt,
    "preview receipt expiry"
  );
  if (previewCompletedAt > clock) throw new Error("Owner challenge preview is from the future");
  if (previewReceiptExpiresAt <= clock) throw new Error("Owner challenge preview receipt has expired");
  if (previewReceiptExpiresAt - clock > PREVIEW_RECEIPT_MAX_REMAINING_MS) {
    throw new Error("Owner challenge preview receipt exceeds the supported lifetime");
  }
  const preflightId = boundedString(object.preflightId, "preflight id", 67);
  if (!PREFLIGHT_ID.test(preflightId)) throw new Error("Owner challenge preflight id is invalid");
  const artifactDigest = boundedString(object.artifactDigest, "artifact digest", 71);
  if (!DIGEST.test(artifactDigest)) throw new Error("Owner challenge artifact digest is invalid");
  const candidateTreeSha = boundedString(object.candidateTreeSha, "candidate tree", 64);
  if (!GIT_SHA.test(candidateTreeSha)) throw new Error("Owner challenge candidate tree is invalid");
  return {
    preflightId,
    artifactDigest,
    candidateTreeSha,
    previewCompletedAt,
    previewReceiptExpiresAt,
  };
}

/**
 * Bind a recomputed, live repository view to the exact unconsumed preview
 * receipt and produce a short-lived canonical owner challenge.
 */
export function prepareOwnerAuthorizationChallenge(input: {
  request: OwnerChallengePreparationRequest;
  current: CurrentOwnerChallengePreview;
  expected: ExpectedOwnerAuthorizationBindings;
  blockers: readonly PublicationBlocker[];
  now?: number;
}): OwnerAuthorizationChallengeArtifact {
  const now = timestamp(input.now ?? Date.now(), "challenge clock");
  const request = validateOwnerChallengePreparationRequest(input.request, now);
  const current = validateCurrentPreview(input.current);
  if (
    current.preflightId !== request.preflightId ||
    normalizeDigest(current.artifactDigest) !== normalizeDigest(request.artifactDigest) ||
    current.candidateTreeSha !== request.candidateTreeSha
  ) {
    throw new Error("Owner challenge preview is stale; run a new preview");
  }
  if (
    input.expected.preview.preflightId !== request.preflightId ||
    input.expected.preview.artifactDigest !== normalizeDigest(request.artifactDigest) ||
    input.expected.preview.candidateTreeSha !== request.candidateTreeSha ||
    input.expected.previewCompletedAt !== request.previewCompletedAt
  ) {
    throw new Error("Owner challenge runtime bindings do not match the reviewed preview");
  }
  return createOwnerAuthorizationChallenge({
    bindings: input.expected,
    blockers: input.blockers,
    now,
    // The preview receipt remains necessary to attach the signed envelope.
    // Never advertise a challenge lifetime beyond that usable ceremony.
    ttlMs: Math.min(
      OWNER_AUTHORIZATION_CHALLENGE_MAX_TTL_MS,
      request.previewReceiptExpiresAt - now
    ),
  });
}

function validateCurrentPreview(value: unknown): CurrentOwnerChallengePreview {
  const object = asRecord(value, "current owner challenge preview");
  assertExactKeys(object, ["preflightId", "artifactDigest", "candidateTreeSha"]);
  const preflightId = boundedString(object.preflightId, "current preflight id", 67);
  const artifactDigest = boundedString(object.artifactDigest, "current artifact digest", 71);
  const candidateTreeSha = boundedString(object.candidateTreeSha, "current candidate tree", 64);
  if (!PREFLIGHT_ID.test(preflightId) || !DIGEST.test(artifactDigest) || !GIT_SHA.test(candidateTreeSha)) {
    throw new Error("Current owner challenge preview is invalid");
  }
  return { preflightId, artifactDigest, candidateTreeSha };
}

function normalizeDigest(value: string): string {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Owner challenge has invalid ${label}`);
  }
  return value as number;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxLength ||
    value !== value.trim()
  ) {
    throw new Error(`Owner challenge has invalid ${label}`);
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(object: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(object).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error("Owner challenge request has unknown or missing fields");
  }
}
