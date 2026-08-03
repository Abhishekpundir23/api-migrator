import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeOperatorApprovalToken,
  createPreviewReceipt,
  digestManifest,
  digestOwnerAuthorizationEnvelope,
  prepareOperatorApproval,
  validateOwnerAuthorizationEnvelope,
  verifyOperatorApprovalToken,
  verifyPreviewReceipt,
  type ReviewedPreview,
} from "../lib/approval";
import { HttpInputError } from "../lib/request";
import { DEFAULT_INNGEST_MANIFEST_JSON } from "../lib/default-manifest";

const SECRET = "0123456789abcdef0123456789abcdef";
const CAMPAIGN_ID = "2f88d980-d4ce-4fb7-b3cc-fdf3503b05d3";
const MANIFEST = DEFAULT_INNGEST_MANIFEST_JSON;
const ENVELOPE = '{"version":1,"payload":"exact-owner-bytes","signature":"signed"}';
const REVIEWED: ReviewedPreview = {
  slug: "owner/repo",
  preflightId: `pf_${"a".repeat(64)}`,
  artifactDigest: "b".repeat(64),
  candidateTreeSha: "c".repeat(40),
  previewCompletedAt: 1_700_000_000_000,
};

function preview(now = REVIEWED.previewCompletedAt) {
  return createPreviewReceipt({
    campaignId: CAMPAIGN_ID,
    manifestJson: MANIFEST,
    repository: REVIEWED,
    now,
    secret: SECRET,
  });
}

function prepared(now = REVIEWED.previewCompletedAt + 1_000) {
  const receipt = preview(REVIEWED.previewCompletedAt);
  return prepareOperatorApproval({
    previewReceipt: receipt.previewReceipt,
    ownerAuthorizationEnvelope: ENVELOPE,
    campaignId: CAMPAIGN_ID,
    manifestJson: MANIFEST,
    now,
    secret: SECRET,
  });
}

test("manifest digests use canonical stored JSON while owner digests preserve exact bytes", () => {
  const legacyManifest = JSON.parse(MANIFEST) as Record<string, unknown>;
  delete legacyManifest.runtime;
  assert.equal(
    digestManifest(JSON.stringify(JSON.parse(MANIFEST), null, 2)),
    digestManifest(MANIFEST)
  );
  assert.equal(digestManifest(JSON.stringify(legacyManifest)), digestManifest(MANIFEST));
  assert.notEqual(digestOwnerAuthorizationEnvelope(ENVELOPE), digestOwnerAuthorizationEnvelope(`${ENVELOPE}\n`));
  assert.match(digestOwnerAuthorizationEnvelope(ENVELOPE), /^sha256:[a-f0-9]{64}$/);
});

test("preview receipt is HMAC-bound to one exact preview but cannot authorize publication", () => {
  const receipt = preview();
  const verified = verifyPreviewReceipt({
    previewReceipt: receipt.previewReceipt,
    campaignId: CAMPAIGN_ID,
    manifestJson: MANIFEST,
    now: REVIEWED.previewCompletedAt + 1,
    secret: SECRET,
  });
  assert.deepEqual(verified.repository, REVIEWED);
  assert.equal(verified.manifestDigest, digestManifest(MANIFEST));
  assert.throws(
    () => verifyOperatorApprovalToken({
      operatorApprovalToken: receipt.previewReceipt,
      confirmation: "anything",
      ownerAuthorizationEnvelope: ENVELOPE,
      campaignId: CAMPAIGN_ID,
      manifestJson: MANIFEST,
      now: REVIEWED.previewCompletedAt + 1,
      secret: SECRET,
    }),
    /invalid operator approval token/
  );
  assert.throws(
    () => verifyOperatorApprovalToken({
      operatorApprovalToken: "eyJ2ZXJzaW9uIjoxfQ.invalid-v1-signature",
      confirmation: "anything",
      ownerAuthorizationEnvelope: ENVELOPE,
      campaignId: CAMPAIGN_ID,
      manifestJson: MANIFEST,
      now: REVIEWED.previewCompletedAt + 1,
      secret: SECRET,
    }),
    /invalid operator approval token/
  );
});

test("prepare_publish issues a domain-separated v2 token with no raw envelope", () => {
  const approval = prepared();
  assert.match(approval.operatorApprovalToken, /^operator-v2\./);
  assert.equal(
    approval.confirmationPhrase,
    `PUBLISH owner/repo ${approval.ownerAuthorizationDigest.slice(7, 19)}`
  );
  assert.equal(approval.repository.previewCompletedAt, REVIEWED.previewCompletedAt);
  const [, encoded] = approval.operatorApprovalToken.split(".");
  const decoded = Buffer.from(encoded!, "base64url").toString("utf8");
  assert.doesNotMatch(decoded, /exact-owner-bytes|signature.*signed/);
  assert.doesNotMatch(approval.operatorApprovalToken, /exact-owner-bytes/);
  assert.equal(JSON.parse(decoded).ownerAuthorizationDigest, digestOwnerAuthorizationEnvelope(ENVELOPE));
});

test("operator approval binds campaign, canonical manifest, exact envelope, phrase, and preview time", () => {
  const approval = prepared();
  const verified = verifyOperatorApprovalToken({
    operatorApprovalToken: approval.operatorApprovalToken,
    confirmation: approval.confirmationPhrase,
    ownerAuthorizationEnvelope: ENVELOPE,
    campaignId: CAMPAIGN_ID,
    manifestJson: JSON.stringify(JSON.parse(MANIFEST), null, 2),
    now: REVIEWED.previewCompletedAt + 2_000,
    secret: SECRET,
  });
  assert.equal(verified.ownerAuthorizationDigest, digestOwnerAuthorizationEnvelope(ENVELOPE));
  assert.equal(verified.repository.preflightId, REVIEWED.preflightId);
  assert.equal(verified.repository.candidateTreeSha, REVIEWED.candidateTreeSha);
  assert.equal(verified.repository.previewCompletedAt, REVIEWED.previewCompletedAt);

  for (const invalid of [
    { ownerAuthorizationEnvelope: `${ENVELOPE}\n`, confirmation: approval.confirmationPhrase },
    { ownerAuthorizationEnvelope: ENVELOPE, confirmation: `${approval.confirmationPhrase} ` },
  ]) {
    assert.throws(
      () => verifyOperatorApprovalToken({
        operatorApprovalToken: approval.operatorApprovalToken,
        ...invalid,
        campaignId: CAMPAIGN_ID,
        manifestJson: MANIFEST,
        now: REVIEWED.previewCompletedAt + 2_000,
        secret: SECRET,
      }),
      HttpInputError
    );
  }
  assert.throws(
    () => verifyOperatorApprovalToken({
      operatorApprovalToken: approval.operatorApprovalToken,
      confirmation: approval.confirmationPhrase,
      ownerAuthorizationEnvelope: ENVELOPE,
      campaignId: "different-campaign",
      manifestJson: MANIFEST,
      now: REVIEWED.previewCompletedAt + 2_000,
      secret: SECRET,
    }),
    /does not match/
  );
  assert.throws(
    () => verifyOperatorApprovalToken({
      operatorApprovalToken: approval.operatorApprovalToken,
      confirmation: approval.confirmationPhrase,
      ownerAuthorizationEnvelope: ENVELOPE,
      campaignId: CAMPAIGN_ID,
      manifestJson: JSON.stringify({
        ...JSON.parse(MANIFEST),
        name: "Different but valid campaign",
      }),
      now: REVIEWED.previewCompletedAt + 2_000,
      secret: SECRET,
    }),
    /does not match/
  );
});

test("missing, oversized, expired, replayed, and byte-changed controls fail closed", () => {
  assert.throws(() => validateOwnerAuthorizationEnvelope(undefined), /ownerAuthorizationEnvelope/);
  assert.throws(() => validateOwnerAuthorizationEnvelope(""), /ownerAuthorizationEnvelope/);
  const max = "x".repeat(64 * 1024);
  assert.strictEqual(validateOwnerAuthorizationEnvelope(max), max);
  assert.throws(() => validateOwnerAuthorizationEnvelope(`${max}x`), /at most 65536 bytes/);
  assert.throws(() => validateOwnerAuthorizationEnvelope("😀".repeat(16_385)), /at most 65536 bytes/);

  const staleReceipt = preview(1_000);
  assert.throws(
    () => prepareOperatorApproval({
      previewReceipt: staleReceipt.previewReceipt,
      ownerAuthorizationEnvelope: ENVELOPE,
      campaignId: CAMPAIGN_ID,
      manifestJson: MANIFEST,
      now: 1_000 + 10 * 60 * 1_000,
      secret: SECRET,
    }),
    /expired/
  );

  const oneShot = preview(REVIEWED.previewCompletedAt + 10_000);
  const prepareInput = {
    previewReceipt: oneShot.previewReceipt,
    ownerAuthorizationEnvelope: ENVELOPE,
    campaignId: CAMPAIGN_ID,
    manifestJson: MANIFEST,
    now: REVIEWED.previewCompletedAt + 11_000,
    secret: SECRET,
  };
  const approval = prepareOperatorApproval(prepareInput);
  assert.throws(() => prepareOperatorApproval(prepareInput), /already used/);
  consumeOperatorApprovalToken(approval.operatorApprovalToken, approval.expiresAt, prepareInput.now);
  assert.throws(
    () => consumeOperatorApprovalToken(approval.operatorApprovalToken, approval.expiresAt, prepareInput.now),
    /already used/
  );
  assert.throws(
    () => verifyOperatorApprovalToken({
      operatorApprovalToken: approval.operatorApprovalToken,
      confirmation: approval.confirmationPhrase,
      ownerAuthorizationEnvelope: ENVELOPE,
      campaignId: CAMPAIGN_ID,
      manifestJson: MANIFEST,
      now: approval.expiresAt,
      secret: SECRET,
    }),
    /expired/
  );
});
