import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseStoredManifest } from "@api-migrator/app";
import { HttpInputError, normalizeRepoSlugs } from "./request";

const PREVIEW_RECEIPT_PREFIX = "preview-v1";
const PREVIEW_RECEIPT_DOMAIN = "api-migrator:console-preview-receipt:v1\0";
const OPERATOR_APPROVAL_PREFIX = "operator-v2";
const OPERATOR_APPROVAL_DOMAIN = "api-migrator:console-operator-approval:v2\0";
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_OWNER_ENVELOPE_BYTES = 64 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ARTIFACT_DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PREFLIGHT_ID = /^pf_[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export interface ReviewedPreview {
  slug: string;
  preflightId: string;
  artifactDigest: string;
  candidateTreeSha: string;
  previewCompletedAt: number;
}

export interface PreviewReceipt {
  version: 1;
  kind: "preview_receipt";
  campaignId: string;
  manifestDigest: string;
  repository: ReviewedPreview;
  expiresAt: number;
  nonce: string;
}

export interface OperatorApproval {
  version: 2;
  kind: "operator_publication_approval";
  campaignId: string;
  manifestDigest: string;
  repository: ReviewedPreview;
  ownerAuthorizationDigest: string;
  confirmationPhrase: string;
  expiresAt: number;
  nonce: string;
}

export interface PreparedOperatorApproval {
  operatorApprovalToken: string;
  confirmationPhrase: string;
  expiresAt: number;
  ownerAuthorizationDigest: string;
  repository: ReviewedPreview;
  manifestDigest: string;
}

const consumedPreviewReceipts = new Map<string, number>();
const consumedOperatorApprovals = new Map<string, number>();

/** Digest the canonical JSON value stored for a campaign manifest. */
export function digestManifest(manifestJson: string): string {
  const manifest = parseStoredManifest(manifestJson);
  return sha256(canonicalJson(manifest));
}

/** Hash the exact UTF-8 bytes without parsing, trimming, or reserializing them. */
export function digestOwnerAuthorizationEnvelope(ownerAuthorizationEnvelope: string): string {
  return sha256(ownerAuthorizationEnvelope);
}

/** Validate but preserve the exact owner-supplied string. */
export function validateOwnerAuthorizationEnvelope(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_OWNER_ENVELOPE_BYTES
  ) {
    throw new HttpInputError("a non-empty ownerAuthorizationEnvelope of at most 65536 bytes is required");
  }
  return value;
}

/** Create a signed receipt that can prepare, but can never authorize, publication. */
export function createPreviewReceipt(input: {
  campaignId: string;
  manifestJson: string;
  repository: ReviewedPreview;
  now?: number;
  secret?: string;
}): { previewReceipt: string; expiresAt: number; repository: ReviewedPreview; manifestDigest: string } {
  const repository = validateReviewedPreview(input.repository);
  const now = validNow(input.now);
  const payload: PreviewReceipt = {
    version: 1,
    kind: "preview_receipt",
    campaignId: validCampaignId(input.campaignId),
    manifestDigest: digestManifest(input.manifestJson),
    repository,
    expiresAt: now + TOKEN_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
  };
  return {
    previewReceipt: encodeToken(PREVIEW_RECEIPT_PREFIX, PREVIEW_RECEIPT_DOMAIN, payload, input.secret),
    expiresAt: payload.expiresAt,
    repository,
    manifestDigest: payload.manifestDigest,
  };
}

export function verifyPreviewReceipt(input: {
  previewReceipt: unknown;
  campaignId: string;
  manifestJson: string;
  now?: number;
  secret?: string;
}): PreviewReceipt {
  const raw = decodeToken(
    input.previewReceipt,
    "previewReceipt",
    PREVIEW_RECEIPT_PREFIX,
    PREVIEW_RECEIPT_DOMAIN,
    input.secret
  );
  assertExactKeys(raw, [
    "version",
    "kind",
    "campaignId",
    "manifestDigest",
    "repository",
    "expiresAt",
    "nonce",
  ]);
  if (raw.version !== 1 || raw.kind !== "preview_receipt") {
    throw new HttpInputError("invalid preview receipt");
  }
  const payload: PreviewReceipt = {
    version: 1,
    kind: "preview_receipt",
    campaignId: validCampaignId(raw.campaignId),
    manifestDigest: validDigest(raw.manifestDigest, "manifest digest"),
    repository: validateReviewedPreview(raw.repository),
    expiresAt: validTimestamp(raw.expiresAt, "preview receipt expiry"),
    nonce: validNonce(raw.nonce),
  };
  if (
    payload.campaignId !== input.campaignId ||
    payload.manifestDigest !== digestManifest(input.manifestJson)
  ) {
    throw new HttpInputError("preview receipt does not match this campaign");
  }
  if (payload.expiresAt <= validNow(input.now)) {
    throw new HttpInputError("preview receipt expired; run a new preview", 409);
  }
  return payload;
}

/**
 * Exchange one exact preview receipt and one exact owner envelope for the
 * operator's final publication control. Neither token contains the envelope.
 */
export function prepareOperatorApproval(input: {
  previewReceipt: unknown;
  ownerAuthorizationEnvelope: unknown;
  campaignId: string;
  manifestJson: string;
  now?: number;
  secret?: string;
}): PreparedOperatorApproval {
  const preview = verifyPreviewReceipt(input);
  const envelope = validateOwnerAuthorizationEnvelope(input.ownerAuthorizationEnvelope);
  const ownerAuthorizationDigest = digestOwnerAuthorizationEnvelope(envelope);
  const now = validNow(input.now);
  const confirmationPhrase = `PUBLISH ${preview.repository.slug} ${ownerAuthorizationDigest.slice(7, 19)}`;
  const payload: OperatorApproval = {
    version: 2,
    kind: "operator_publication_approval",
    campaignId: preview.campaignId,
    manifestDigest: preview.manifestDigest,
    repository: preview.repository,
    ownerAuthorizationDigest,
    confirmationPhrase,
    expiresAt: Math.min(preview.expiresAt, now + TOKEN_TTL_MS),
    nonce: randomBytes(16).toString("base64url"),
  };
  if (payload.expiresAt <= now) {
    throw new HttpInputError("preview receipt expired; run a new preview", 409);
  }
  const operatorApprovalToken = encodeToken(
    OPERATOR_APPROVAL_PREFIX,
    OPERATOR_APPROVAL_DOMAIN,
    payload,
    input.secret
  );
  consumeOneShot(consumedPreviewReceipts, input.previewReceipt as string, preview.expiresAt, now, "preview receipt");
  return {
    operatorApprovalToken,
    confirmationPhrase,
    expiresAt: payload.expiresAt,
    ownerAuthorizationDigest,
    repository: payload.repository,
    manifestDigest: payload.manifestDigest,
  };
}

export function verifyOperatorApprovalToken(input: {
  operatorApprovalToken: unknown;
  confirmation: unknown;
  ownerAuthorizationEnvelope: unknown;
  campaignId: string;
  manifestJson: string;
  now?: number;
  secret?: string;
}): OperatorApproval {
  const envelope = validateOwnerAuthorizationEnvelope(input.ownerAuthorizationEnvelope);
  const raw = decodeToken(
    input.operatorApprovalToken,
    "operatorApprovalToken",
    OPERATOR_APPROVAL_PREFIX,
    OPERATOR_APPROVAL_DOMAIN,
    input.secret
  );
  assertExactKeys(raw, [
    "version",
    "kind",
    "campaignId",
    "manifestDigest",
    "repository",
    "ownerAuthorizationDigest",
    "confirmationPhrase",
    "expiresAt",
    "nonce",
  ]);
  if (raw.version !== 2 || raw.kind !== "operator_publication_approval") {
    throw new HttpInputError("invalid operator approval token");
  }
  const repository = validateReviewedPreview(raw.repository);
  const ownerAuthorizationDigest = validDigest(raw.ownerAuthorizationDigest, "owner authorization digest");
  const expectedPhrase = `PUBLISH ${repository.slug} ${ownerAuthorizationDigest.slice(7, 19)}`;
  if (raw.confirmationPhrase !== expectedPhrase) {
    throw new HttpInputError("invalid operator approval token");
  }
  const payload: OperatorApproval = {
    version: 2,
    kind: "operator_publication_approval",
    campaignId: validCampaignId(raw.campaignId),
    manifestDigest: validDigest(raw.manifestDigest, "manifest digest"),
    repository,
    ownerAuthorizationDigest,
    confirmationPhrase: expectedPhrase,
    expiresAt: validTimestamp(raw.expiresAt, "operator approval expiry"),
    nonce: validNonce(raw.nonce),
  };
  if (
    payload.campaignId !== input.campaignId ||
    payload.manifestDigest !== digestManifest(input.manifestJson) ||
    payload.ownerAuthorizationDigest !== digestOwnerAuthorizationEnvelope(envelope)
  ) {
    throw new HttpInputError("operator approval does not match this publication");
  }
  if (payload.expiresAt <= validNow(input.now)) {
    throw new HttpInputError("operator approval expired; run a new preview", 409);
  }
  if (input.confirmation !== payload.confirmationPhrase) {
    throw new HttpInputError(`type ${payload.confirmationPhrase} to publish`, 409);
  }
  return payload;
}

/** Mark a final operator publication approval used after the run lock is held. */
export function consumeOperatorApprovalToken(token: string, expiresAt: number, now = Date.now()): void {
  consumeOneShot(consumedOperatorApprovals, token, expiresAt, now, "operator approval");
}

function validateReviewedPreview(value: unknown): ReviewedPreview {
  const record = asRecord(value, "reviewed preview");
  assertExactKeys(record, [
    "slug",
    "preflightId",
    "artifactDigest",
    "candidateTreeSha",
    "previewCompletedAt",
  ]);
  const [slug] = normalizeRepoSlugs([record.slug]);
  if (typeof record.preflightId !== "string" || !PREFLIGHT_ID.test(record.preflightId)) {
    throw new HttpInputError(`missing valid preflight id for ${slug}`, 409);
  }
  if (typeof record.artifactDigest !== "string" || !ARTIFACT_DIGEST.test(record.artifactDigest)) {
    throw new HttpInputError(`missing valid artifact digest for ${slug}`, 409);
  }
  if (typeof record.candidateTreeSha !== "string" || !GIT_SHA.test(record.candidateTreeSha)) {
    throw new HttpInputError(`missing valid candidate tree for ${slug}`, 409);
  }
  return {
    slug: slug!,
    preflightId: record.preflightId,
    artifactDigest: record.artifactDigest,
    candidateTreeSha: record.candidateTreeSha,
    previewCompletedAt: validTimestamp(record.previewCompletedAt, "preview completion time"),
  };
}

function encodeToken(prefix: string, domain: string, payload: object, override?: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${prefix}.${encoded}.${signature(domain, encoded, override)}`;
}

function decodeToken(
  token: unknown,
  label: string,
  prefix: string,
  domain: string,
  override?: string
): Record<string, unknown> {
  if (typeof token !== "string") throw new HttpInputError(`${label} required`);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== prefix || !parts[1] || !parts[2]) {
    throw new HttpInputError(`invalid ${humanLabel(label)}`);
  }
  const expected = signature(domain, parts[1], override);
  if (!safeEqual(parts[2], expected)) throw new HttpInputError(`invalid ${humanLabel(label)}`);
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    return asRecord(JSON.parse(decoded) as unknown, humanLabel(label));
  } catch (error) {
    if (error instanceof HttpInputError) throw error;
    throw new HttpInputError(`invalid ${humanLabel(label)}`);
  }
}

function signature(domain: string, encoded: string, override?: string): string {
  const secret = override ?? process.env.OPERATOR_APPROVAL_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("OPERATOR_APPROVAL_SECRET must be at least 32 bytes");
  }
  return createHmac("sha256", secret).update(domain).update(encoded).digest("base64url");
}

function consumeOneShot(
  store: Map<string, number>,
  token: string,
  expiresAt: number,
  now: number,
  label: string
): void {
  for (const [key, expiry] of store) {
    if (expiry <= now) store.delete(key);
  }
  const key = createHash("sha256").update(token).digest("hex");
  if (store.has(key)) {
    throw new HttpInputError(`${label} was already used; run a new preview`, 409);
  }
  store.set(key, expiresAt);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function validCampaignId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new HttpInputError("invalid campaign id");
  }
  return value;
}

function validDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new HttpInputError(`invalid ${label}`);
  }
  return value;
}

function validNonce(value: unknown): string {
  if (typeof value !== "string" || !NONCE.test(value)) {
    throw new HttpInputError("invalid token nonce");
  }
  return value;
}

function validNow(value: number | undefined): number {
  return validTimestamp(value ?? Date.now(), "clock");
}

function validTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HttpInputError(`invalid ${label}`);
  }
  return value as number;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpInputError(`invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new HttpInputError("invalid signed token payload");
  }
}

function humanLabel(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
