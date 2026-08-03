import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRepositorySlug, validateBranchName } from "./repository.js";

export const OWNER_AUTHORIZATION_AUDIENCE = "api-migrator:owner-publication:v1";
export const OWNER_AUTHORIZATION_SIGNATURE_DOMAIN = `${OWNER_AUTHORIZATION_AUDIENCE}\0`;
export const OWNER_AUTHORIZATION_MAX_TTL_MS = 30 * 60 * 1_000;

const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_PUBLIC_KEY_BYTES = 16 * 1024;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const PREFLIGHT_ID = /^pf_[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ACTIONS = ["create_branch", "create_pull_request", "update_pull_request"] as const;

export type OwnerAuthorizationAction = (typeof ACTIONS)[number];

export interface OwnerAuthorizationPayload {
  version: 1;
  audience: typeof OWNER_AUTHORIZATION_AUDIENCE;
  envelopeId: string;
  authorizationId: string;
  pilotId: string;
  signerId: string;
  keyId: string;
  approvalEvidenceDigest: string;
  preRunAuthorizationDigest: string;
  previewCompletedAt: number;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  authorizationExpiresAt: number;
  nonce: string;
  repository: {
    slug: string;
    id: number;
    ownerId: number;
  };
  github: {
    appId: number;
    installationId: number;
  };
  base: {
    branch: string;
    sha: string;
  };
  engine: {
    tag: string;
    commit: string;
  };
  manifest: {
    byteLength: number;
    digest: string;
  };
  preview: {
    preflightId: string;
    artifactDigest: string;
    candidateBranch: string;
    candidateTreeSha: string;
    findingsDigest: string;
    resolutionsDigest: string;
    commandScopeDigest: string;
    runnerAttestationDigest: string;
    rulesetDigest: string;
    requiredCiDigest: string;
  };
  allowedActions: OwnerAuthorizationAction[];
  pullRequestNumber: number | null;
}

/**
 * Values already observed by the runtime and therefore required to match the
 * signed payload byte-for-byte (after canonical JSON serialization).
 */
export interface ExpectedOwnerAuthorizationBindings {
  pilotId: string;
  approvalEvidenceDigest: string;
  preRunAuthorizationDigest: string;
  previewCompletedAt: number;
  authorizationExpiresAt: number;
  repository: OwnerAuthorizationPayload["repository"];
  github: OwnerAuthorizationPayload["github"];
  base: OwnerAuthorizationPayload["base"];
  engine: OwnerAuthorizationPayload["engine"];
  manifest: OwnerAuthorizationPayload["manifest"];
  preview: OwnerAuthorizationPayload["preview"];
  allowedActions: OwnerAuthorizationAction[];
  pullRequestNumber: number | null;
}

export interface VerifyOwnerAuthorizationInput {
  expected: ExpectedOwnerAuthorizationBindings;
  /** Defaults to API_MIGRATOR_OWNER_KEY_REGISTRY_PATH. */
  registryPath?: string;
  /** Testable clock, expressed as Unix epoch milliseconds. */
  now?: number;
}

export interface AssertCurrentOwnerGrantInput {
  expected: ExpectedOwnerAuthorizationBindings;
  /** If supplied, it must resolve to the same registry used at verification. */
  registryPath?: string;
  now?: number;
}

declare const ownerAuthorizationGrantBrand: unique symbol;

/** Opaque capability. Runtime authenticity is held only in this module's WeakSet. */
export interface OwnerAuthorizationGrant {
  readonly [ownerAuthorizationGrantBrand]: true;
}

/** Exact safe projection accepted by the durable replay store. */
export interface OwnerAuthorizationConsumption {
  authorizationId: string;
  envelopeId: string;
  envelopeDigest: string;
  nonceDigest: string;
  signerId: string;
  keyId: string;
  repositorySlug: string;
  repositoryId: number;
  baseSha: string;
  preflightId: string;
  artifactDigest: string;
  manifestDigest: string;
  candidateBranch: string;
  candidateTreeSha: string;
  expiresAt: number;
}

/** Safe evidence returned only after the durable store accepted consumption. */
export interface OwnerAuthorizationReceipt extends OwnerAuthorizationConsumption {
  consumedAt: number;
}

interface OwnerAuthorizationEnvelope {
  version: 1;
  keyId: string;
  payload: string;
  signature: string;
}

interface OwnerAuthorizationRegistryKey {
  keyId: string;
  signerId: string;
  algorithm: "Ed25519";
  publicKeyPem: string;
  fingerprint: string;
  repository: OwnerAuthorizationPayload["repository"];
  validFrom: number;
  validUntil: number;
  revokedAt: number | null;
}

interface OwnerAuthorizationKeyRegistry {
  version: 1;
  keys: OwnerAuthorizationRegistryKey[];
  revokedAuthorizationIds: string[];
}

interface VerifiedRegistryKey {
  entry: OwnerAuthorizationRegistryKey;
  publicKey: KeyObject;
  canonicalPath: string;
}

interface GrantState {
  status: "verified" | "consumed";
  payload: Readonly<OwnerAuthorizationPayload>;
  expected: Readonly<ExpectedOwnerAuthorizationBindings>;
  registryPath: string;
  keyFingerprint: string;
  payloadBytes: Buffer;
  signatureBytes: Buffer;
  consumption: Readonly<OwnerAuthorizationConsumption>;
  receipt?: Readonly<OwnerAuthorizationReceipt>;
}

const verifiedGrants = new WeakSet<object>();
const grantStates = new WeakMap<object, GrantState>();

/** Hash a strictly JSON-safe value using the canonical serializer used here. */
export function canonicalSha256(value: unknown): string {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

/**
 * Verify one canonical Ed25519 owner envelope and return an in-memory opaque
 * grant. This function performs no GitHub or database operation.
 */
export function verifyOwnerAuthorizationEnvelope(
  envelopeJson: string,
  input: VerifyOwnerAuthorizationInput
): OwnerAuthorizationGrant {
  const now = validTimestamp(input.now ?? Date.now(), "verification clock");
  const expected = validateExpectedBindings(input.expected);
  const envelope = asRecord(
    parseCanonicalJson(envelopeJson, MAX_ENVELOPE_BYTES, "owner authorization envelope"),
    "owner authorization envelope"
  );
  assertExactKeys(envelope, ["version", "keyId", "payload", "signature"], "envelope");
  if (envelope.version !== 1) reject("unsupported envelope version");
  const envelopeKeyId = validIdentifier(envelope.keyId, "envelope keyId");
  const encodedPayload = validBoundedString(envelope.payload, "payload", MAX_ENVELOPE_BYTES);
  const encodedSignature = validBoundedString(envelope.signature, "signature", 256);

  const payloadBytes = decodeCanonicalBase64Url(encodedPayload, "payload");
  if (payloadBytes.length === 0 || payloadBytes.length > MAX_PAYLOAD_BYTES) {
    reject("payload exceeds the supported size");
  }
  const payloadJson = decodeUtf8Exactly(payloadBytes, "payload");
  const payload = validatePayload(
    parseCanonicalJson(payloadJson, MAX_PAYLOAD_BYTES, "owner authorization payload")
  );
  if (payload.keyId !== envelopeKeyId) reject("envelope keyId does not match payload keyId");

  const signatureBytes = decodeCanonicalBase64Url(encodedSignature, "signature");
  if (signatureBytes.length !== 64) reject("Ed25519 signature must be exactly 64 bytes");

  assertPayloadTimes(payload, now);
  assertExpectedBindings(payload, expected);

  const registryPath = resolveRegistryPath(input.registryPath);
  const registryKey = readAndSelectRegistryKey(registryPath, payload, now);
  const signedBytes = Buffer.concat([
    Buffer.from(OWNER_AUTHORIZATION_SIGNATURE_DOMAIN, "utf8"),
    payloadBytes,
  ]);
  if (!verifySignature(null, signedBytes, registryKey.publicKey, signatureBytes)) {
    reject("Ed25519 signature verification failed");
  }

  const envelopeDigest = sha256(Buffer.from(envelopeJson, "utf8"));
  const nonceDigest = sha256(decodeCanonicalBase64Url(payload.nonce, "nonce"));
  const consumption = deepFreeze<OwnerAuthorizationConsumption>({
    authorizationId: payload.authorizationId,
    envelopeId: payload.envelopeId,
    envelopeDigest,
    nonceDigest,
    signerId: payload.signerId,
    keyId: payload.keyId,
    repositorySlug: payload.repository.slug,
    repositoryId: payload.repository.id,
    baseSha: payload.base.sha,
    preflightId: payload.preview.preflightId,
    artifactDigest: payload.preview.artifactDigest,
    manifestDigest: payload.manifest.digest,
    candidateBranch: payload.preview.candidateBranch,
    candidateTreeSha: payload.preview.candidateTreeSha,
    expiresAt: payload.expiresAt,
  });

  const grant = Object.freeze({}) as OwnerAuthorizationGrant;
  verifiedGrants.add(grant);
  grantStates.set(grant, {
    status: "verified",
    payload: deepFreeze(payload),
    expected: deepFreeze(expected),
    registryPath: registryKey.canonicalPath,
    keyFingerprint: registryKey.entry.fingerprint,
    payloadBytes: Buffer.from(payloadBytes),
    signatureBytes: Buffer.from(signatureBytes),
    consumption,
  });
  return grant;
}

/**
 * Re-read the owner-controlled registry and re-check revocation, freshness,
 * scope, signature, and every runtime binding immediately before consumption.
 */
export function assertCurrentOwnerGrant(
  grant: OwnerAuthorizationGrant,
  input: AssertCurrentOwnerGrantInput
): OwnerAuthorizationGrant {
  const state = activeGrantState(grant);
  const now = validTimestamp(input.now ?? Date.now(), "verification clock");
  const expected = validateExpectedBindings(input.expected);
  assertExpectedBindings(state.payload, expected);

  assertPayloadTimes(state.payload, now);
  const requestedPath = input.registryPath === undefined
    ? state.registryPath
    : resolveRegistryPath(input.registryPath);
  assertRegistryStillAuthorizes(state, requestedPath, now);
  return grant;
}

/**
 * Return the minimal database input, after another live registry/revocation
 * check. Calling this twice is harmless until the durable store reserves it;
 * the store remains the cross-process replay authority.
 */
export function ownerAuthorizationConsumption(
  grant: OwnerAuthorizationGrant,
  input?: Partial<AssertCurrentOwnerGrantInput> & {
    expected?: ExpectedOwnerAuthorizationBindings;
  }
): Readonly<OwnerAuthorizationConsumption> {
  const state = activeGrantState(grant);
  assertCurrentOwnerGrant(grant, {
    expected: input?.expected ?? state.expected,
    ...(input?.registryPath === undefined ? {} : { registryPath: input.registryPath }),
    ...(input?.now === undefined ? {} : { now: input.now }),
  });
  return state.consumption;
}

/**
 * Complete the process-local transition only after the atomic replay store has
 * returned this exact receipt. A mismatched or second receipt is rejected.
 */
export function markGrantConsumed(
  grant: OwnerAuthorizationGrant,
  receipt: OwnerAuthorizationReceipt
): Readonly<OwnerAuthorizationReceipt> {
  const state = activeGrantState(grant);
  const normalized = validateReceipt(receipt);
  const expected = state.consumption;
  const staticReceipt = { ...normalized };
  delete (staticReceipt as Partial<OwnerAuthorizationReceipt>).consumedAt;
  if (canonicalJson(staticReceipt) !== canonicalJson(expected)) {
    reject("durable consumption receipt does not match the verified grant");
  }
  if (
    normalized.consumedAt < state.payload.notBefore ||
    normalized.consumedAt < state.payload.issuedAt ||
    normalized.consumedAt >= state.payload.expiresAt
  ) {
    reject("durable consumption receipt is outside the authorization window");
  }

  // The receipt proves when the durable reservation occurred, but it is not a
  // clock for the later token boundary. Re-sample trusted wall time so an
  // envelope or signing key that expires between those events fails closed.
  const postConsumptionNow = validTimestamp(Date.now(), "post-consumption clock");
  assertPayloadTimes(state.payload, postConsumptionNow);
  assertRegistryStillAuthorizes(state, state.registryPath, postConsumptionNow);

  state.status = "consumed";
  state.receipt = deepFreeze(normalized);
  return state.receipt;
}

export function assertConsumedOwnerGrant(
  grant: OwnerAuthorizationGrant
): Readonly<OwnerAuthorizationReceipt> {
  const state = grantState(grant);
  if (state.status !== "consumed" || state.receipt === undefined) {
    reject("owner authorization grant has not been durably consumed");
  }
  return state.receipt;
}

/**
 * Revalidate an already-reserved grant at the actual write-token boundary.
 * Durable consumption prevents replay but never disables expiry or revocation.
 */
export function assertCurrentConsumedOwnerGrant(
  grant: OwnerAuthorizationGrant,
  input: AssertCurrentOwnerGrantInput
): Readonly<OwnerAuthorizationReceipt> {
  const state = grantState(grant);
  if (state.status !== "consumed" || state.receipt === undefined) {
    reject("owner authorization grant has not been durably consumed");
  }
  const now = validTimestamp(input.now ?? Date.now(), "verification clock");
  const expected = validateExpectedBindings(input.expected);
  assertExpectedBindings(state.payload, expected);
  assertPayloadTimes(state.payload, now);
  const requestedPath = input.registryPath === undefined
    ? state.registryPath
    : resolveRegistryPath(input.registryPath);
  assertRegistryStillAuthorizes(state, requestedPath, now);
  return state.receipt;
}

/** Safe audit receipt; raw payload and signature bytes are never exposed. */
export function ownerAuthorizationReceipt(
  grant: OwnerAuthorizationGrant
): Readonly<OwnerAuthorizationReceipt> {
  return assertConsumedOwnerGrant(grant);
}

function validatePayload(value: unknown): OwnerAuthorizationPayload {
  const object = asRecord(value, "payload");
  assertExactKeys(object, [
    "version",
    "audience",
    "envelopeId",
    "authorizationId",
    "pilotId",
    "signerId",
    "keyId",
    "approvalEvidenceDigest",
    "preRunAuthorizationDigest",
    "previewCompletedAt",
    "issuedAt",
    "notBefore",
    "expiresAt",
    "authorizationExpiresAt",
    "nonce",
    "repository",
    "github",
    "base",
    "engine",
    "manifest",
    "preview",
    "allowedActions",
    "pullRequestNumber",
  ], "payload");
  if (object.version !== 1) reject("unsupported payload version");
  if (object.audience !== OWNER_AUTHORIZATION_AUDIENCE) reject("invalid payload audience");

  const nonce = validBoundedString(object.nonce, "nonce", 64);
  if (decodeCanonicalBase64Url(nonce, "nonce").length !== 32) {
    reject("nonce must contain exactly 32 bytes");
  }

  return {
    version: 1,
    audience: OWNER_AUTHORIZATION_AUDIENCE,
    envelopeId: validIdentifier(object.envelopeId, "envelopeId"),
    authorizationId: validIdentifier(object.authorizationId, "authorizationId"),
    pilotId: validIdentifier(object.pilotId, "pilotId"),
    signerId: validIdentifier(object.signerId, "signerId"),
    keyId: validIdentifier(object.keyId, "keyId"),
    approvalEvidenceDigest: validDigest(object.approvalEvidenceDigest, "approvalEvidenceDigest"),
    preRunAuthorizationDigest: validDigest(object.preRunAuthorizationDigest, "preRunAuthorizationDigest"),
    previewCompletedAt: validTimestamp(object.previewCompletedAt, "previewCompletedAt"),
    issuedAt: validTimestamp(object.issuedAt, "issuedAt"),
    notBefore: validTimestamp(object.notBefore, "notBefore"),
    expiresAt: validTimestamp(object.expiresAt, "expiresAt"),
    authorizationExpiresAt: validTimestamp(object.authorizationExpiresAt, "authorizationExpiresAt"),
    nonce,
    repository: validateRepository(object.repository),
    github: validateGitHub(object.github),
    base: validateBase(object.base),
    engine: validateEngine(object.engine),
    manifest: validateManifest(object.manifest),
    preview: validatePreview(object.preview),
    allowedActions: validateAllowedActions(object.allowedActions),
    pullRequestNumber: validPullRequestNumber(object.pullRequestNumber),
  };
}

function validateExpectedBindings(value: unknown): ExpectedOwnerAuthorizationBindings {
  const object = asRecord(value, "expected bindings");
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
  ], "expected bindings");
  return {
    pilotId: validIdentifier(object.pilotId, "expected pilotId"),
    approvalEvidenceDigest: validDigest(object.approvalEvidenceDigest, "expected approvalEvidenceDigest"),
    preRunAuthorizationDigest: validDigest(object.preRunAuthorizationDigest, "expected preRunAuthorizationDigest"),
    previewCompletedAt: validTimestamp(object.previewCompletedAt, "expected previewCompletedAt"),
    authorizationExpiresAt: validTimestamp(object.authorizationExpiresAt, "expected authorizationExpiresAt"),
    repository: validateRepository(object.repository),
    github: validateGitHub(object.github),
    base: validateBase(object.base),
    engine: validateEngine(object.engine),
    manifest: validateManifest(object.manifest),
    preview: validatePreview(object.preview),
    allowedActions: validateAllowedActions(object.allowedActions),
    pullRequestNumber: validPullRequestNumber(object.pullRequestNumber),
  };
}

function expectedBindings(payload: Readonly<OwnerAuthorizationPayload>): ExpectedOwnerAuthorizationBindings {
  return {
    pilotId: payload.pilotId,
    approvalEvidenceDigest: payload.approvalEvidenceDigest,
    preRunAuthorizationDigest: payload.preRunAuthorizationDigest,
    previewCompletedAt: payload.previewCompletedAt,
    authorizationExpiresAt: payload.authorizationExpiresAt,
    repository: payload.repository,
    github: payload.github,
    base: payload.base,
    engine: payload.engine,
    manifest: payload.manifest,
    preview: payload.preview,
    allowedActions: payload.allowedActions,
    pullRequestNumber: payload.pullRequestNumber,
  };
}

function assertExpectedBindings(
  payload: Readonly<OwnerAuthorizationPayload>,
  expected: ExpectedOwnerAuthorizationBindings
): void {
  if (canonicalJson(expectedBindings(payload)) !== canonicalJson(expected)) {
    reject("signed payload does not match the exact runtime bindings");
  }
}

function validateRepository(value: unknown): OwnerAuthorizationPayload["repository"] {
  const object = asRecord(value, "repository");
  assertExactKeys(object, ["slug", "id", "ownerId"], "repository");
  const slug = validBoundedString(object.slug, "repository slug", 140);
  parseRepositorySlug(slug);
  if (slug !== slug.toLowerCase()) reject("repository slug must be lowercase canonical owner/repo");
  return {
    slug,
    id: validPositiveInteger(object.id, "repository id"),
    ownerId: validPositiveInteger(object.ownerId, "repository owner id"),
  };
}

function validateGitHub(value: unknown): OwnerAuthorizationPayload["github"] {
  const object = asRecord(value, "github");
  assertExactKeys(object, ["appId", "installationId"], "github");
  return {
    appId: validPositiveInteger(object.appId, "GitHub App id"),
    installationId: validPositiveInteger(object.installationId, "GitHub installation id"),
  };
}

function validateBase(value: unknown): OwnerAuthorizationPayload["base"] {
  const object = asRecord(value, "base");
  assertExactKeys(object, ["branch", "sha"], "base");
  const branch = validBoundedString(object.branch, "base branch", 240);
  validateBranchName(branch);
  return { branch, sha: validGitSha(object.sha, "base sha") };
}

function validateEngine(value: unknown): OwnerAuthorizationPayload["engine"] {
  const object = asRecord(value, "engine");
  assertExactKeys(object, ["tag", "commit"], "engine");
  const tag = validBoundedString(object.tag, "engine tag", 128);
  if (tag !== tag.trim() || /[\u0000-\u0020\u007f]/.test(tag)) reject("invalid engine tag");
  return { tag, commit: validGitSha(object.commit, "engine commit") };
}

function validateManifest(value: unknown): OwnerAuthorizationPayload["manifest"] {
  const object = asRecord(value, "manifest");
  assertExactKeys(object, ["byteLength", "digest"], "manifest");
  return {
    byteLength: validPositiveInteger(object.byteLength, "manifest byteLength"),
    digest: validDigest(object.digest, "manifest digest"),
  };
}

function validatePreview(value: unknown): OwnerAuthorizationPayload["preview"] {
  const object = asRecord(value, "preview");
  assertExactKeys(object, [
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
  ], "preview");
  const candidateBranch = validBoundedString(object.candidateBranch, "candidate branch", 240);
  validateBranchName(candidateBranch);
  const preflightId = validBoundedString(object.preflightId, "preflightId", 67);
  if (!PREFLIGHT_ID.test(preflightId)) reject("invalid preflightId");
  return {
    preflightId,
    artifactDigest: validDigest(object.artifactDigest, "artifact digest"),
    candidateBranch,
    candidateTreeSha: validGitSha(object.candidateTreeSha, "candidate tree sha"),
    findingsDigest: validDigest(object.findingsDigest, "findings digest"),
    resolutionsDigest: validDigest(object.resolutionsDigest, "resolutions digest"),
    commandScopeDigest: validDigest(object.commandScopeDigest, "command scope digest"),
    runnerAttestationDigest: validDigest(object.runnerAttestationDigest, "runner attestation digest"),
    rulesetDigest: validDigest(object.rulesetDigest, "ruleset digest"),
    requiredCiDigest: validDigest(object.requiredCiDigest, "required CI digest"),
  };
}

function validateAllowedActions(value: unknown): OwnerAuthorizationAction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    reject("allowedActions must contain the exact bounded publication actions");
  }
  const actions = value.map((action) => {
    if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
      reject("allowedActions contains an unsupported action");
    }
    return action as OwnerAuthorizationAction;
  });
  const permitted = [
    "create_branch\0create_pull_request",
    "create_pull_request",
    "update_pull_request",
  ];
  if (!permitted.includes(actions.join("\0"))) {
    reject("allowedActions is not an exact canonical publication state");
  }
  return actions;
}

function validPullRequestNumber(value: unknown): number | null {
  if (value === null) return null;
  return validPositiveInteger(value, "pullRequestNumber");
}

function assertPayloadTimes(payload: Readonly<OwnerAuthorizationPayload>, now: number): void {
  if (payload.previewCompletedAt > payload.issuedAt) {
    reject("previewCompletedAt must not be after issuedAt");
  }
  if (payload.issuedAt > payload.notBefore) reject("issuedAt must not be after notBefore");
  if (payload.notBefore >= payload.expiresAt) reject("authorization window is empty");
  if (
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > OWNER_AUTHORIZATION_MAX_TTL_MS
  ) {
    reject("owner envelope lifetime must be at most 30 minutes");
  }
  if (payload.expiresAt > payload.authorizationExpiresAt) {
    reject("envelope outlives the underlying owner authorization");
  }
  if (now < payload.notBefore) reject("owner authorization is not yet valid");
  if (now >= payload.expiresAt || now >= payload.authorizationExpiresAt) {
    reject("owner authorization has expired");
  }
  const creates = payload.allowedActions.includes("create_pull_request");
  if (creates && payload.pullRequestNumber !== null) {
    reject("new pull-request authorization cannot bind an existing pull request");
  }
  if (!creates && payload.pullRequestNumber === null) {
    reject("pull-request update authorization must bind its exact pull request number");
  }
}

function readAndSelectRegistryKey(
  path: string,
  payload: Readonly<OwnerAuthorizationPayload>,
  now: number
): VerifiedRegistryKey {
  const file = readOwnerOnlyFile(path);
  const registry = validateRegistry(
    parseCanonicalJson(file.contents, MAX_REGISTRY_BYTES, "owner key registry")
  );
  if (registry.revokedAuthorizationIds.includes(payload.authorizationId)) {
    reject("owner authorization has been revoked");
  }
  const entry = registry.keys.find((candidate) => candidate.keyId === payload.keyId);
  if (!entry) reject("owner signing key is not registered");
  if (entry.signerId !== payload.signerId) reject("owner signer scope does not match");
  if (canonicalJson(entry.repository) !== canonicalJson(payload.repository)) {
    reject("owner repository scope does not match");
  }
  if (entry.revokedAt !== null) reject("owner signing key is revoked");
  if (now < entry.validFrom || payload.issuedAt < entry.validFrom) {
    reject("owner signing key is not yet valid");
  }
  if (now >= entry.validUntil || payload.expiresAt > entry.validUntil) {
    reject("owner signing key has expired");
  }
  const publicKey = parseRegistryPublicKey(entry);
  return {
    entry,
    publicKey,
    canonicalPath: file.canonicalPath,
  };
}

function assertRegistryStillAuthorizes(
  state: GrantState,
  registryPath: string,
  now: number
): void {
  const registryKey = readAndSelectRegistryKey(registryPath, state.payload, now);
  if (registryKey.canonicalPath !== state.registryPath) reject("owner key registry changed");
  if (registryKey.entry.fingerprint !== state.keyFingerprint) {
    reject("owner signing key changed");
  }
  const signedBytes = Buffer.concat([
    Buffer.from(OWNER_AUTHORIZATION_SIGNATURE_DOMAIN, "utf8"),
    state.payloadBytes,
  ]);
  if (!verifySignature(null, signedBytes, registryKey.publicKey, state.signatureBytes)) {
    reject("owner signature is no longer valid");
  }
}

function validateRegistry(value: unknown): OwnerAuthorizationKeyRegistry {
  const object = asRecord(value, "owner key registry");
  assertExactKeys(object, ["version", "keys", "revokedAuthorizationIds"], "owner key registry");
  if (object.version !== 1) reject("unsupported owner key registry version");
  if (!Array.isArray(object.keys) || object.keys.length < 1 || object.keys.length > 128) {
    reject("owner key registry keys are missing or excessive");
  }
  if (!Array.isArray(object.revokedAuthorizationIds) || object.revokedAuthorizationIds.length > 10_000) {
    reject("owner key registry revocation list is invalid or excessive");
  }

  const keys = object.keys.map(validateRegistryKey);
  const keyIds = new Set<string>();
  const fingerprints = new Set<string>();
  const scopes = new Set<string>();
  for (const key of keys) {
    // The complete registry is strict. Dormant malformed keys may not become
    // active later merely by changing an id or scope.
    parseRegistryPublicKey(key);
    const scope = canonicalJson({ signerId: key.signerId, repository: key.repository });
    if (keyIds.has(key.keyId) || fingerprints.has(key.fingerprint)) {
      reject("owner key registry contains a duplicate key");
    }
    if (scopes.has(scope)) reject("owner key registry contains a duplicate signer scope");
    keyIds.add(key.keyId);
    fingerprints.add(key.fingerprint);
    scopes.add(scope);
  }

  const revokedAuthorizationIds = object.revokedAuthorizationIds.map((value) =>
    validIdentifier(value, "revoked authorization id")
  );
  if (new Set(revokedAuthorizationIds).size !== revokedAuthorizationIds.length) {
    reject("owner key registry contains duplicate revoked authorization ids");
  }
  return { version: 1, keys, revokedAuthorizationIds };
}

function validateRegistryKey(value: unknown): OwnerAuthorizationRegistryKey {
  const object = asRecord(value, "owner key registry entry");
  assertExactKeys(object, [
    "keyId",
    "signerId",
    "algorithm",
    "publicKeyPem",
    "fingerprint",
    "repository",
    "validFrom",
    "validUntil",
    "revokedAt",
  ], "owner key registry entry");
  if (object.algorithm !== "Ed25519") reject("owner key algorithm must be Ed25519");
  const validFrom = validTimestamp(object.validFrom, "key validFrom");
  const validUntil = validTimestamp(object.validUntil, "key validUntil");
  if (validUntil <= validFrom) reject("owner key validity window is empty");
  let revokedAt: number | null = null;
  if (object.revokedAt !== null) {
    revokedAt = validTimestamp(object.revokedAt, "key revokedAt");
    if (revokedAt < validFrom || revokedAt > validUntil) {
      reject("owner key revocation is outside key validity");
    }
  }
  return {
    keyId: validIdentifier(object.keyId, "registry keyId"),
    signerId: validIdentifier(object.signerId, "registry signerId"),
    algorithm: "Ed25519",
    publicKeyPem: validBoundedString(object.publicKeyPem, "registry publicKeyPem", MAX_PUBLIC_KEY_BYTES),
    fingerprint: validDigest(object.fingerprint, "registry fingerprint"),
    repository: validateRepository(object.repository),
    validFrom,
    validUntil,
    revokedAt,
  };
}

function parseRegistryPublicKey(entry: OwnerAuthorizationRegistryKey): KeyObject {
  let key: KeyObject;
  let canonicalPem: string;
  try {
    key = createPublicKey(entry.publicKeyPem);
    canonicalPem = key.export({ type: "spki", format: "pem" }).toString();
  } catch {
    reject("owner key registry publicKeyPem must be canonical SPKI PUBLIC KEY PEM");
  }
  if (entry.publicKeyPem !== canonicalPem!) {
    // createPublicKey intentionally accepts private keys, certificates, and
    // trailing PEM blocks. Exact SPKI re-encoding prevents the registry from
    // becoming an accidental private-key store or smuggling ignored material.
    reject("owner key registry publicKeyPem must be canonical SPKI PUBLIC KEY PEM");
  }
  if (key!.asymmetricKeyType !== "ed25519") {
    reject("owner key registry public key is not Ed25519");
  }
  const spki = key!.export({ type: "spki", format: "der" });
  if (sha256(spki) !== entry.fingerprint) reject("owner key fingerprint does not match SPKI DER");
  return key!;
}

function readOwnerOnlyFile(path: string): { canonicalPath: string; contents: string } {
  if (!isAbsolute(path)) reject("owner key registry path must be absolute");
  let descriptor: number | null = null;
  let result: { canonicalPath: string; contents: string } | undefined;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("unsafe registry file");
    const canonicalPath = realpathSync.native(path);
    const canonicalWorkspace = realpathSync.native(WORKSPACE_ROOT);
    const workspaceRelativePath = relative(canonicalWorkspace, canonicalPath);
    if (
      workspaceRelativePath === "" ||
      (workspaceRelativePath !== ".." &&
        !workspaceRelativePath.startsWith(`..${sep}`) &&
        !isAbsolute(workspaceRelativePath))
    ) {
      throw new Error("registry inside workspace");
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const after = fstatSync(descriptor);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("registry changed while opening");
    }
    if (after.size <= 0 || after.size > MAX_REGISTRY_BYTES) throw new Error("registry size");
    if (process.platform !== "win32" && (after.mode & 0o077) !== 0) {
      throw new Error("registry permissions");
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      after.uid !== process.getuid()
    ) {
      throw new Error("registry ownership");
    }
    result = { canonicalPath, contents: readFileSync(descriptor, "utf8") };
  } catch {
    // The single error below deliberately hides path, ownership, race, and
    // parsing distinctions from callers.
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  if (!result) {
    reject("owner key registry must be an owner-only regular non-symlink file outside the workspace");
  }
  return result;
}

function resolveRegistryPath(value: string | undefined): string {
  const path = value ?? process.env.API_MIGRATOR_OWNER_KEY_REGISTRY_PATH;
  if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path, "utf8") > 4_096) {
    reject("owner key registry path is required");
  }
  if (!isAbsolute(path)) reject("owner key registry path must be absolute");
  // Do not call realpath here: the file reader must observe and reject a
  // caller-supplied symlink before recording the canonical regular path.
  return resolve(path);
}

function validateReceipt(value: unknown): OwnerAuthorizationReceipt {
  const object = asRecord(value, "durable consumption receipt");
  assertExactKeys(object, [
    "authorizationId",
    "envelopeId",
    "envelopeDigest",
    "nonceDigest",
    "signerId",
    "keyId",
    "repositorySlug",
    "repositoryId",
    "baseSha",
    "preflightId",
    "artifactDigest",
    "manifestDigest",
    "candidateBranch",
    "candidateTreeSha",
    "expiresAt",
    "consumedAt",
  ], "durable consumption receipt");
  const repositorySlug = validBoundedString(object.repositorySlug, "receipt repositorySlug", 140);
  parseRepositorySlug(repositorySlug);
  const preflightId = validBoundedString(object.preflightId, "receipt preflightId", 67);
  if (!PREFLIGHT_ID.test(preflightId)) reject("invalid receipt preflightId");
  const candidateBranch = validBoundedString(object.candidateBranch, "receipt candidateBranch", 240);
  validateBranchName(candidateBranch);
  return {
    authorizationId: validIdentifier(object.authorizationId, "receipt authorizationId"),
    envelopeId: validIdentifier(object.envelopeId, "receipt envelopeId"),
    envelopeDigest: normalizeDigest(object.envelopeDigest, "receipt envelopeDigest"),
    nonceDigest: normalizeDigest(object.nonceDigest, "receipt nonceDigest"),
    signerId: validIdentifier(object.signerId, "receipt signerId"),
    keyId: validIdentifier(object.keyId, "receipt keyId"),
    repositorySlug: repositorySlug.toLowerCase(),
    repositoryId: validPositiveInteger(object.repositoryId, "receipt repositoryId"),
    baseSha: validGitSha(object.baseSha, "receipt baseSha"),
    preflightId,
    artifactDigest: normalizeDigest(object.artifactDigest, "receipt artifactDigest"),
    manifestDigest: normalizeDigest(object.manifestDigest, "receipt manifestDigest"),
    candidateBranch,
    candidateTreeSha: validGitSha(object.candidateTreeSha, "receipt candidateTreeSha"),
    expiresAt: validTimestamp(object.expiresAt, "receipt expiresAt"),
    consumedAt: validTimestamp(object.consumedAt, "receipt consumedAt"),
  };
}

function activeGrantState(grant: OwnerAuthorizationGrant): GrantState {
  const state = grantState(grant);
  if (state.status !== "verified") reject("owner authorization grant has already been consumed");
  return state;
}

function grantState(grant: OwnerAuthorizationGrant): GrantState {
  if (
    (typeof grant !== "object" && typeof grant !== "function") ||
    grant === null ||
    !verifiedGrants.has(grant as object)
  ) {
    reject("invalid owner authorization grant");
  }
  const state = grantStates.get(grant as object);
  if (!state) reject("invalid owner authorization grant");
  return state;
}

function parseCanonicalJson(input: unknown, maxBytes: number, label: string): unknown {
  if (typeof input !== "string" || input.length === 0 || Buffer.byteLength(input, "utf8") > maxBytes) {
    reject(`${label} is missing or exceeds the supported size`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    reject(`${label} is not valid JSON`);
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    reject(`${label} contains unsupported JSON values`);
  }
  if (canonical !== input) {
    reject(`${label} is not canonical JSON (including duplicate keys)`);
  }
  return parsed;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("unsafe JSON number");
    return String(value);
  }
  if (typeof value !== "object") throw new Error("unsupported JSON value");
  if (ancestors.has(value)) throw new Error("cyclic JSON value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("non-plain JSON object");
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    for (const key of keys) {
      assertValidUnicode(key);
      if (object[key] === undefined) throw new Error("undefined JSON member");
    }
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function decodeCanonicalBase64Url(value: string, label: string): Buffer {
  if (!BASE64URL.test(value) || value.includes("=") || value.length % 4 === 1) {
    reject(`${label} is not unpadded base64url`);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    reject(`${label} is not valid base64url`);
  }
  if (decoded.toString("base64url") !== value) reject(`${label} is not canonical base64url`);
  return decoded;
}

function decodeUtf8Exactly(value: Buffer, label: string): string {
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) reject(`${label} is not valid UTF-8`);
  assertValidUnicode(decoded);
  return decoded;
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("unpaired high surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("unpaired low surrogate");
    }
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
  keys: readonly string[],
  label: string
): void {
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    reject(`${label} has unknown or missing fields`);
  }
}

function validBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    reject(`${label} is missing or exceeds the supported size`);
  }
  try {
    assertValidUnicode(value);
  } catch {
    reject(`${label} contains invalid Unicode`);
  }
  return value;
}

function validIdentifier(value: unknown, label: string): string {
  const identifier = validBoundedString(value, label, 128);
  if (!IDENTIFIER.test(identifier)) reject(`${label} is not a canonical identifier`);
  return identifier;
}

function validDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    reject(`${label} must be lowercase sha256:<64hex>`);
  }
  return value;
}

function normalizeDigest(value: unknown, label: string): string {
  if (typeof value !== "string") reject(`${label} is invalid`);
  const canonical = value.startsWith("sha256:") ? value : `sha256:${value}`;
  return validDigest(canonical, label);
}

function validGitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) reject(`${label} is invalid`);
  return value;
}

function validPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) reject(`${label} must be a positive safe integer`);
  return value as number;
}

function validTimestamp(value: unknown, label: string): number {
  const timestamp = validPositiveInteger(value, label);
  if (timestamp > MAX_TIMESTAMP) reject(`${label} exceeds the supported timestamp range`);
  return timestamp;
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function reject(message: string): never {
  throw new Error(`Owner authorization rejected: ${message}`);
}
