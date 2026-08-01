import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpInputError, normalizeRepoSlugs, normalizeConcurrency } from "./request";

const TOKEN_VERSION = 1;
const TOKEN_TTL_MS = 10 * 60 * 1000;

export interface PreviewApproval {
  version: 1;
  campaignId: string;
  manifestDigest: string;
  preflights: Array<{ slug: string; preflightId: string }>;
  concurrency: number;
  confirmationPhrase: string;
  expiresAt: number;
  nonce: string;
}

const consumedTokens = new Map<string, number>();

export function digestManifest(manifestJson: string): string {
  return createHash("sha256").update(manifestJson).digest("hex");
}

export function createApprovalToken(input: {
  campaignId: string;
  manifestJson: string;
  preflights: Array<{ slug: string; preflightId: string }>;
  concurrency: number;
  now?: number;
  secret?: string;
}): { token: string; confirmationPhrase: string; expiresAt: number } {
  if (input.preflights.length === 0) {
    throw new HttpInputError("preview produced no publishable repositories", 409);
  }
  const repoSlugs = normalizeRepoSlugs(input.preflights.map((item) => item.slug));
  if (repoSlugs.length !== input.preflights.length) {
    throw new HttpInputError("preview contains duplicate repository slugs", 409);
  }
  const preflights = input.preflights.map((item, index) => {
    if (typeof item.preflightId !== "string" || item.preflightId.length < 16) {
      throw new HttpInputError(`missing preflight id for ${item.slug}`, 409);
    }
    return { slug: repoSlugs[index]!, preflightId: item.preflightId };
  });
  const confirmationPhrase = `PUBLISH ${preflights.length} ${preflights.length === 1 ? "PR" : "PRS"}`;
  const expiresAt = (input.now ?? Date.now()) + TOKEN_TTL_MS;
  const payload: PreviewApproval = {
    version: TOKEN_VERSION,
    campaignId: input.campaignId,
    manifestDigest: digestManifest(input.manifestJson),
    preflights,
    concurrency: normalizeConcurrency(input.concurrency),
    confirmationPhrase,
    expiresAt,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    token: `${encoded}.${signature(encoded, input.secret)}`,
    confirmationPhrase,
    expiresAt,
  };
}

export function verifyApprovalToken(input: {
  token: unknown;
  confirmation: unknown;
  campaignId: string;
  manifestJson: string;
  now?: number;
  secret?: string;
}): PreviewApproval {
  if (typeof input.token !== "string") throw new HttpInputError("approvalToken required");
  const parts = input.token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new HttpInputError("invalid approval token");
  const expected = signature(parts[0], input.secret);
  const actual = parts[1];
  if (!safeEqual(actual, expected)) throw new HttpInputError("invalid approval token");

  let payload: PreviewApproval;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as PreviewApproval;
  } catch {
    throw new HttpInputError("invalid approval token");
  }
  if (
    payload.version !== TOKEN_VERSION ||
    payload.campaignId !== input.campaignId ||
    payload.manifestDigest !== digestManifest(input.manifestJson) ||
    !Array.isArray(payload.preflights) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length < 16
  ) {
    throw new HttpInputError("approval token does not match this campaign");
  }
  if (payload.expiresAt < (input.now ?? Date.now())) {
    throw new HttpInputError("approval token expired; run a new preview", 409);
  }
  if (input.confirmation !== payload.confirmationPhrase) {
    throw new HttpInputError(`type ${payload.confirmationPhrase} to publish`, 409);
  }
  normalizeRepoSlugs(payload.preflights.map((item) => item.slug));
  normalizeConcurrency(payload.concurrency);
  for (const item of payload.preflights) {
    if (typeof item.preflightId !== "string" || item.preflightId.length < 16) {
      throw new HttpInputError("approval token contains an invalid preflight", 409);
    }
  }
  return payload;
}

/** Mark an approval token used. Local pilot protection against accidental replay. */
export function consumeApprovalToken(token: string, expiresAt: number, now = Date.now()): void {
  for (const [key, expiry] of consumedTokens) {
    if (expiry < now) consumedTokens.delete(key);
  }
  const key = createHash("sha256").update(token).digest("hex");
  if (consumedTokens.has(key)) {
    throw new HttpInputError("approval token was already used; run a new preview", 409);
  }
  consumedTokens.set(key, expiresAt);
}

function signature(encoded: string, override?: string): string {
  const secret = override ?? process.env.OPERATOR_APPROVAL_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("OPERATOR_APPROVAL_SECRET must be at least 32 bytes");
  }
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
