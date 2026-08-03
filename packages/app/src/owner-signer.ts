import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OWNER_AUTHORIZATION_AUDIENCE,
  OWNER_AUTHORIZATION_MAX_TTL_MS,
  OWNER_AUTHORIZATION_SIGNATURE_DOMAIN,
  verifyOwnerAuthorizationEnvelope,
  type OwnerAuthorizationPayload,
} from "./owner-authorization.js";
import {
  parseOwnerAuthorizationChallenge,
} from "./owner-challenge.js";
import { canonicalJson, parseCanonicalJson } from "./canonical-json.js";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_CHALLENGE_BYTES = 64 * 1024;
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const MAX_REGISTRY_BYTES = 256 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface SignOwnerAuthorizationChallengeFileInput {
  challengePath: string;
  registryPath: string;
  privateKeyPath: string;
  outputPath: string;
  /** Exact digest displayed with, and approved after reviewing, the challenge. */
  approveChallengeDigest: string;
  authorizationId: string;
  signerId: string;
  keyId: string;
  /** Defaults to the remaining challenge window and may never exceed 30 minutes. */
  ttlMs?: number;
  /** Testable trusted wall clock, expressed as Unix epoch milliseconds. */
  now?: number;
}

/** Safe projection returned by the signer. It deliberately excludes envelope bytes. */
export interface OwnerAuthorizationSigningReceipt {
  version: 1;
  challengeDigest: string;
  envelopeDigest: string;
  envelopeId: string;
  authorizationId: string;
  signerId: string;
  keyId: string;
  repositorySlug: string;
  repositoryId: number;
  githubAppId: number;
  installationId: number;
  baseBranch: string;
  baseSha: string;
  preflightId: string;
  candidateBranch: string;
  candidateTreeSha: string;
  allowedActions: Readonly<OwnerAuthorizationPayload["allowedActions"]>;
  pullRequestNumber: number | null;
  manifestDigest: string;
  runnerAttestationDigest: string;
  rulesetDigest: string;
  requiredCiDigest: string;
  expiresAt: number;
  outputPath: string;
}

/**
 * Sign one canonical challenge using an owner-controlled Ed25519 key and write
 * the envelope to a newly created 0600 file. No raw key, payload, signature, or
 * envelope is returned or printed.
 */
export function signOwnerAuthorizationChallengeFile(
  input: SignOwnerAuthorizationChallengeFileInput
): Readonly<OwnerAuthorizationSigningReceipt> {
  const now = positiveSafeInteger(input.now ?? Date.now(), "signing clock");
  const challengeFile = readOwnerOnlyExternalFile(
    input.challengePath,
    MAX_CHALLENGE_BYTES,
    "owner challenge"
  );
  const challenge = parseOwnerAuthorizationChallenge(challengeFile.contents, now);
  if (input.approveChallengeDigest !== challenge.challengeDigest) {
    reject("explicit approved challenge digest does not match the parsed challenge");
  }
  const authorizationId = identifier(input.authorizationId, "authorizationId");
  const signerId = identifier(input.signerId, "signerId");
  const keyId = identifier(input.keyId, "keyId");
  const ttlMs = boundedTtl(input.ttlMs ?? OWNER_AUTHORIZATION_MAX_TTL_MS);
  const expiresAt = Math.min(
    now + ttlMs,
    challenge.expiresAt,
    challenge.bindings.authorizationExpiresAt
  );
  if (expiresAt <= now) reject("owner envelope authorization window is empty");

  const registryFile = readOwnerOnlyExternalFile(
    input.registryPath,
    MAX_REGISTRY_BYTES,
    "owner key registry"
  );
  const privateKeyFile = readOwnerOnlyExternalFile(
    input.privateKeyPath,
    MAX_PRIVATE_KEY_BYTES,
    "owner private key"
  );
  const privateKey = parseCanonicalEd25519PrivateKey(privateKeyFile.contents);
  assertRegistryKeyCorrespondence({
    registryJson: registryFile.contents,
    keyId,
    signerId,
    authorizationId,
    repository: challenge.bindings.repository,
    privateKey,
  });

  const payload: OwnerAuthorizationPayload = {
    version: 1,
    audience: OWNER_AUTHORIZATION_AUDIENCE,
    envelopeId: `envelope-${randomUUID()}`,
    authorizationId,
    pilotId: challenge.bindings.pilotId,
    signerId,
    keyId,
    approvalEvidenceDigest: challenge.bindings.approvalEvidenceDigest,
    preRunAuthorizationDigest: challenge.bindings.preRunAuthorizationDigest,
    challengeDigest: challenge.challengeDigest,
    previewCompletedAt: challenge.bindings.previewCompletedAt,
    issuedAt: now,
    notBefore: now,
    expiresAt,
    authorizationExpiresAt: challenge.bindings.authorizationExpiresAt,
    nonce: randomBytes(32).toString("base64url"),
    repository: challenge.bindings.repository,
    github: challenge.bindings.github,
    base: challenge.bindings.base,
    engine: challenge.bindings.engine,
    manifest: challenge.bindings.manifest,
    preview: challenge.bindings.preview,
    allowedActions: challenge.bindings.allowedActions,
    pullRequestNumber: challenge.bindings.pullRequestNumber,
  };
  const payloadJson = canonicalJson(payload);
  const payloadBytes = Buffer.from(payloadJson, "utf8");
  const signature = sign(
    null,
    Buffer.concat([
      Buffer.from(OWNER_AUTHORIZATION_SIGNATURE_DOMAIN, "utf8"),
      payloadBytes,
    ]),
    privateKey
  );
  if (signature.length !== 64) reject("Ed25519 signer returned an invalid signature");

  const envelopeJson = canonicalJson({
    version: 1,
    keyId,
    payload: payloadBytes.toString("base64url"),
    signature: signature.toString("base64url"),
  });

  // Reuse the runtime verifier as the final pre-write oracle. This validates
  // the complete registry, signature domain, payload, repository scope,
  // revocations, timestamps, and every challenge binding.
  verifyOwnerAuthorizationEnvelope(envelopeJson, {
    expected: challenge.bindings,
    expectedChallengeDigest: challenge.challengeDigest,
    registryPath: registryFile.canonicalPath,
    now,
  });

  const outputPath = writeNewOwnerOnlyExternalFile(input.outputPath, envelopeJson);
  return Object.freeze({
    version: 1,
    challengeDigest: challenge.challengeDigest,
    envelopeDigest: sha256(Buffer.from(envelopeJson, "utf8")),
    envelopeId: payload.envelopeId,
    authorizationId,
    signerId,
    keyId,
    repositorySlug: payload.repository.slug,
    repositoryId: payload.repository.id,
    githubAppId: payload.github.appId,
    installationId: payload.github.installationId,
    baseBranch: payload.base.branch,
    baseSha: payload.base.sha,
    preflightId: payload.preview.preflightId,
    candidateBranch: payload.preview.candidateBranch,
    candidateTreeSha: payload.preview.candidateTreeSha,
    allowedActions: Object.freeze([...payload.allowedActions]),
    pullRequestNumber: payload.pullRequestNumber,
    manifestDigest: payload.manifest.digest,
    runnerAttestationDigest: payload.preview.runnerAttestationDigest,
    rulesetDigest: payload.preview.rulesetDigest,
    requiredCiDigest: payload.preview.requiredCiDigest,
    expiresAt,
    outputPath,
  });
}

function parseCanonicalEd25519PrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  let canonical: string;
  try {
    key = createPrivateKey(pem);
    canonical = key.export({ type: "pkcs8", format: "pem" }).toString();
  } catch {
    reject("owner private key must be canonical unencrypted PKCS8 PRIVATE KEY PEM");
  }
  if (key!.asymmetricKeyType !== "ed25519" || pem !== canonical!) {
    reject("owner private key must be canonical unencrypted Ed25519 PKCS8 PRIVATE KEY PEM");
  }
  return key!;
}

function assertRegistryKeyCorrespondence(input: {
  registryJson: string;
  keyId: string;
  signerId: string;
  authorizationId: string;
  repository: { slug: string; id: number; ownerId: number };
  privateKey: KeyObject;
}): void {
  let parsed: unknown;
  try {
    parsed = parseCanonicalJson(input.registryJson, MAX_REGISTRY_BYTES, "owner key registry");
  } catch {
    reject("owner key registry is invalid");
  }
  const registry = record(parsed, "owner key registry");
  exactKeys(registry, ["version", "keys", "revokedAuthorizationIds"], "owner key registry");
  if (registry.version !== 1 || !Array.isArray(registry.keys) || !Array.isArray(registry.revokedAuthorizationIds)) {
    reject("owner key registry is invalid");
  }
  if (registry.revokedAuthorizationIds.includes(input.authorizationId)) {
    reject("owner authorization has been revoked");
  }
  const matches = registry.keys.filter((candidate) => {
    const entry = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : {};
    return entry.keyId === input.keyId;
  });
  if (matches.length !== 1) reject("owner signing key is not uniquely registered");
  const entry = record(matches[0], "owner key registry entry");
  exactKeys(entry, [
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
  if (entry.algorithm !== "Ed25519" || entry.signerId !== input.signerId || entry.revokedAt !== null) {
    reject("owner signing key registry scope does not match");
  }
  if (canonicalJson(entry.repository) !== canonicalJson(input.repository)) {
    reject("owner signing key repository scope does not match");
  }

  const publicKey = createPublicKey(input.privateKey);
  if (publicKey.asymmetricKeyType !== "ed25519") reject("owner private key is not Ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fingerprint = sha256(publicKey.export({ type: "spki", format: "der" }) as Buffer);
  if (entry.publicKeyPem !== publicKeyPem || entry.fingerprint !== fingerprint) {
    reject("owner private key does not match the registered public key");
  }
  if (typeof entry.fingerprint !== "string" || !DIGEST.test(entry.fingerprint)) {
    reject("owner key registry fingerprint is invalid");
  }
}

function readOwnerOnlyExternalFile(
  path: string,
  maxBytes: number,
  label: string
): { canonicalPath: string; contents: string } {
  validateAbsolutePath(path, label);
  let descriptor: number | null = null;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("unsafe file");
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const after = fstatSync(descriptor);
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.nlink !== 1
    ) {
      throw new Error("file changed while opening");
    }
    assertOwnerOnly(after.mode, after.uid);
    if (after.size <= 0 || after.size > maxBytes) throw new Error("unsupported file size");
    const canonicalPath = realpathSync.native(path);
    assertOutsideWorkspace(canonicalPath);
    return { canonicalPath, contents: readFileSync(descriptor, "utf8") };
  } catch {
    return reject(`${label} must be an owner-only regular non-symlink file outside the workspace`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeNewOwnerOnlyExternalFile(path: string, contents: string): string {
  validateAbsolutePath(path, "owner envelope output");
  const parent = dirname(path);
  let parentCanonical: string;
  try {
    const parentBefore = lstatSync(parent);
    if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) throw new Error("unsafe parent");
    assertOwnerOnly(parentBefore.mode, parentBefore.uid);
    parentCanonical = realpathSync.native(parent);
    assertOutsideWorkspace(parentCanonical);
  } catch {
    reject("owner envelope output parent must be an owner-only regular directory outside the workspace");
  }
  const name = basename(path);
  const canonicalPath = join(parentCanonical!, name);
  if (name.length === 0 || name === "." || name === ".." || dirname(canonicalPath) !== parentCanonical) {
    reject("owner envelope output path must be a direct canonical child of its parent directory");
  }

  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = openSync(
      canonicalPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    created = true;
    fchmodSync(descriptor, 0o600);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("output is not a unique regular file");
    assertOwnerOnly(stat.mode, stat.uid);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    let parentDescriptor: number | null = null;
    try {
      parentDescriptor = openSync(parentCanonical!, constants.O_RDONLY);
      fsyncSync(parentDescriptor);
    } finally {
      if (parentDescriptor !== null) closeSync(parentDescriptor);
    }
    return realpathSync.native(canonicalPath);
  } catch {
    if (descriptor !== null) closeSync(descriptor);
    if (created) {
      try {
        unlinkSync(canonicalPath);
      } catch {
        // The caller still receives a generic failure and must inspect the
        // restricted output directory before retrying.
      }
    }
    reject("owner envelope output must be a new owner-only non-symlink file outside the workspace");
  }
}

function validateAbsolutePath(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    /[\r\n\0]/.test(value) ||
    !isAbsolute(value)
  ) {
    reject(`${label} path must be absolute and canonical`);
  }
}

function assertOutsideWorkspace(canonicalPath: string): void {
  const workspace = realpathSync.native(WORKSPACE_ROOT);
  const rel = relative(workspace, canonicalPath);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new Error("path is inside workspace");
  }
}

function assertOwnerOnly(mode: number, uid: number): void {
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new Error("permissions are not owner-only");
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    uid !== process.getuid()
  ) {
    throw new Error("path is not owned by the current user");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(object: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    reject(`${label} has unknown or missing fields`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) reject(`${label} is invalid`);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) reject(`${label} is invalid`);
  return value as number;
}

function boundedTtl(value: unknown): number {
  const ttl = positiveSafeInteger(value, "owner envelope TTL");
  if (ttl > OWNER_AUTHORIZATION_MAX_TTL_MS) {
    reject("owner envelope TTL exceeds 30 minutes");
  }
  return ttl;
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function reject(message: string): never {
  throw new Error(`Owner signing rejected: ${message}`);
}
