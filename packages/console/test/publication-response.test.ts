import assert from "node:assert/strict";
import test from "node:test";
import type { CampaignRunSummary } from "@api-migrator/app";
import { buildPublishHttpDecision } from "../lib/publication-response";

type CampaignResult = CampaignRunSummary["results"][number];

const CAMPAIGN_ID = "2f88d980-d4ce-4fb7-b3cc-fdf3503b05d3";
const PREFLIGHT_ID = `pf_${"a".repeat(64)}`;
const OPERATOR = "operator";
const CANDIDATE_TREE = "c".repeat(40);
const ARTIFACT = "e".repeat(64);
const MANIFEST_DIGEST = `sha256:${"f".repeat(64)}`;
const ENVELOPE_DIGEST = `sha256:${"9".repeat(64)}`;
const approval = (slug = "owner/repo", preflightId = PREFLIGHT_ID) => ({
  slug,
  preflightId,
  artifactDigest: ARTIFACT,
  candidateTreeSha: CANDIDATE_TREE,
  previewCompletedAt: 1_700_000_000_000,
  manifestDigest: MANIFEST_DIGEST,
  ownerAuthorizationDigest: ENVELOPE_DIGEST,
});

function openedResult(slug = "owner/repo", pull = 17): CampaignResult {
  return {
    slug,
    status: "pr_opened",
    prUrl: `https://github.com/${slug}/pull/${pull}`,
    preflightId: PREFLIGHT_ID,
    publication: {
      mode: "publish",
      status: "pr_opened",
      preflightId: PREFLIGHT_ID,
      baseBranch: "main",
      baseSha: "b".repeat(40),
      branch: `codex/api-migrator/${"c".repeat(64)}`,
      candidateTreeSha: CANDIDATE_TREE,
      previewCompletedAt: 1_700_000_000_000,
      headSha: "d".repeat(40),
      artifactDigest: ARTIFACT,
      blockers: [],
      overridden: false,
      approvedBy: "operator",
      ownerAuthorizationReceipt: {
        authorizationId: "authorization-1",
        envelopeId: "envelope-1",
        envelopeDigest: ENVELOPE_DIGEST,
        nonceDigest: `sha256:${"8".repeat(64)}`,
        signerId: "owner-signer",
        keyId: "owner-key-1",
        repositorySlug: slug,
        repositoryId: 123,
        baseSha: "b".repeat(40),
        preflightId: PREFLIGHT_ID,
        artifactDigest: `sha256:${ARTIFACT}`,
        manifestDigest: MANIFEST_DIGEST,
        candidateBranch: `codex/api-migrator/${"c".repeat(64)}`,
        candidateTreeSha: CANDIDATE_TREE,
        expiresAt: 1_700_000_600_000,
        consumedAt: 1_700_000_001_000,
      },
    },
  } as CampaignResult;
}

function summary(results: CampaignResult[], total = results.length): CampaignRunSummary {
  return { campaignId: CAMPAIGN_ID, total, results };
}

test("publish response returns 201 only for complete PR publication proofs", () => {
  const input = summary([openedResult()]);
  const decision = buildPublishHttpDecision(input, [approval()], OPERATOR);

  assert.equal(decision.status, 201);
  assert.equal(decision.body.mode, "publish");
  assert.equal(decision.body.error, undefined);
  assert.notStrictEqual(decision.body.summary, input);
  assert.deepEqual(decision.body.summary, input);
});

test("blocked and failed publication outcomes return non-2xx with summary evidence", () => {
  for (const status of ["blocked", "failed"] as const) {
    const result: CampaignResult = {
      slug: `owner/${status}`,
      status,
      prUrl: null,
      error: `${status} evidence`,
    };
    const input = summary([result]);
    const decision = buildPublishHttpDecision(input, [approval(result.slug)], OPERATOR);

    assert.equal(decision.status, 409);
    assert.match(decision.body.error ?? "", new RegExp(`returned status ${status}`));
    assert.match(decision.body.error ?? "", /Summary evidence is included/);
    assert.notStrictEqual(decision.body.summary, input);
    assert.deepEqual(decision.body.summary, input);
    assert.equal(decision.body.summary.results[0]?.error, `${status} evidence`);
  }
});

test("a partial publication returns non-2xx and identifies the incomplete repository", () => {
  const blocked: CampaignResult = {
    slug: "owner/two",
    status: "blocked",
    prUrl: null,
    error: "verification failed",
  };
  const input = summary([openedResult("owner/one", 1), blocked]);
  const decision = buildPublishHttpDecision(input, [approval("owner/one"), approval("owner/two")], OPERATOR);

  assert.equal(decision.status, 409);
  assert.match(decision.body.error ?? "", /partially completed: 1 of 2/i);
  assert.match(decision.body.error ?? "", /owner\/two: returned status blocked/);
  assert.deepEqual(decision.body.summary.results, input.results);
});

test("pr_opened without a matching PR URL or complete proof never returns 201", () => {
  const missingUrl = openedResult();
  missingUrl.prUrl = null;
  const urlDecision = buildPublishHttpDecision(summary([missingUrl]), [approval(missingUrl.slug)], OPERATOR);
  assert.equal(urlDecision.status, 409);
  assert.match(urlDecision.body.error ?? "", /missing a matching GitHub PR URL/);

  const wrongRepository = openedResult();
  wrongRepository.prUrl = "https://github.com/other/repo/pull/17";
  const wrongUrlDecision = buildPublishHttpDecision(summary([wrongRepository]), [approval(wrongRepository.slug)], OPERATOR);
  assert.equal(wrongUrlDecision.status, 409);
  assert.match(wrongUrlDecision.body.error ?? "", /missing a matching GitHub PR URL/);

  const missingProof = openedResult();
  delete missingProof.publication?.headSha;
  const proofDecision = buildPublishHttpDecision(summary([missingProof]), [approval(missingProof.slug)], OPERATOR);
  assert.equal(proofDecision.status, 409);
  assert.match(proofDecision.body.error ?? "", /approved head SHA/);

  const staleApproval = openedResult();
  const staleDecision = buildPublishHttpDecision(
    summary([staleApproval]),
    [approval(staleApproval.slug, `pf_${"f".repeat(64)}`)],
    OPERATOR
  );
  assert.equal(staleDecision.status, 409);
  assert.match(staleDecision.body.error ?? "", /approved preflight ID/);

  const unsafe = openedResult();
  if (!unsafe.publication) assert.fail("fixture publication proof is missing");
  unsafe.publication.blockers = [{ code: "manual_review_required", message: "review" }];
  (unsafe.publication as unknown as Record<string, unknown>).overridden = true;
  const unsafeDecision = buildPublishHttpDecision(summary([unsafe]), [approval(unsafe.slug)], OPERATOR);
  assert.equal(unsafeDecision.status, 409);
  assert.match(unsafeDecision.body.error ?? "", /zero publication blockers, non-overridden publication/);

  const wrongOperator = openedResult();
  const operatorDecision = buildPublishHttpDecision(
    summary([wrongOperator]),
    [approval(wrongOperator.slug)],
    "different-operator"
  );
  assert.equal(operatorDecision.status, 409);
  assert.match(operatorDecision.body.error ?? "", /matching operator identity/);

  const missingReceipt = openedResult();
  if (!missingReceipt.publication) assert.fail("fixture publication proof is missing");
  delete (missingReceipt.publication as typeof missingReceipt.publication & {
    ownerAuthorizationReceipt?: unknown;
  }).ownerAuthorizationReceipt;
  const missingReceiptDecision = buildPublishHttpDecision(
    summary([missingReceipt]),
    [approval(missingReceipt.slug)],
    OPERATOR
  );
  assert.equal(missingReceiptDecision.status, 409);
  assert.match(missingReceiptDecision.body.error ?? "", /owner authorization receipt/);

  const wrongEnvelope = openedResult();
  if (!wrongEnvelope.publication) assert.fail("fixture publication proof is missing");
  const receipt = (wrongEnvelope.publication as typeof wrongEnvelope.publication & {
    ownerAuthorizationReceipt: { envelopeDigest: string };
  }).ownerAuthorizationReceipt;
  receipt.envelopeDigest = `sha256:${"7".repeat(64)}`;
  const wrongEnvelopeDecision = buildPublishHttpDecision(
    summary([wrongEnvelope]),
    [approval(wrongEnvelope.slug)],
    OPERATOR
  );
  assert.equal(wrongEnvelopeDecision.status, 409);
  assert.match(wrongEnvelopeDecision.body.error ?? "", /matching owner authorization receipt digests/);
});

test("missing, duplicate, or unapproved results fail closed", () => {
  const missing = buildPublishHttpDecision(summary([]), [approval()], OPERATOR);
  assert.equal(missing.status, 409);
  assert.match(missing.body.error ?? "", /publication result is missing/);

  const duplicateInput = summary([openedResult(), openedResult()]);
  const duplicate = buildPublishHttpDecision(duplicateInput, [approval()], OPERATOR);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error ?? "", /multiple publication results/);

  const extraInput = summary([openedResult("owner/repo"), openedResult("owner/extra")]);
  const extra = buildPublishHttpDecision(extraInput, [approval()], OPERATOR);
  assert.equal(extra.status, 409);
  assert.match(extra.body.error ?? "", /owner\/extra: result was not approved/);
});

test("owner proof must bind the exact approved preview completion time", () => {
  const result = openedResult();
  if (!result.publication) assert.fail("fixture publication proof is missing");
  result.publication.previewCompletedAt += 1;

  const decision = buildPublishHttpDecision(summary([result]), [approval()], OPERATOR);

  assert.equal(decision.status, 409);
  assert.match(decision.body.error ?? "", /approved preview completion time/);
});

test("unexpected proof and receipt fields fail closed without being reflected", () => {
  const secret = "PRIVATE-OWNER-ENVELOPE-MATERIAL";
  const result = openedResult();
  if (!result.publication?.ownerAuthorizationReceipt) {
    assert.fail("fixture owner authorization receipt is missing");
  }
  Object.assign(result.publication, { unexpectedProof: secret });
  Object.assign(result.publication.ownerAuthorizationReceipt, { rawEnvelope: secret });

  const decision = buildPublishHttpDecision(summary([result]), [approval()], OPERATOR);
  const serialized = JSON.stringify(decision.body);

  assert.equal(decision.status, 409);
  assert.match(decision.body.error ?? "", /unexpected publication proof fields/);
  assert.match(decision.body.error ?? "", /unexpected owner authorization receipt fields/);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.equal(
    "rawEnvelope" in (decision.body.summary.results[0]?.publication?.ownerAuthorizationReceipt ?? {}),
    false
  );
});

test("non-canonical commit lengths never satisfy publication proof", () => {
  const result = openedResult();
  if (!result.publication) assert.fail("fixture publication proof is missing");
  result.publication.headSha = "d".repeat(41);

  const decision = buildPublishHttpDecision(summary([result]), [approval()], OPERATOR);

  assert.equal(decision.status, 409);
  assert.match(decision.body.error ?? "", /approved head SHA/);
});

test("malformed allowed values and exact envelope bytes never cross the response boundary", () => {
  const envelope = '{"version":1,"signature":"RAW-OWNER-AUTHORIZATION"}';

  const malformedBranch = openedResult();
  if (!malformedBranch.publication) assert.fail("fixture publication proof is missing");
  malformedBranch.publication.baseBranch = envelope;
  const branchDecision = buildPublishHttpDecision(
    summary([malformedBranch]),
    [approval()],
    OPERATOR,
    [envelope]
  );
  assert.equal(branchDecision.status, 409);
  assert.equal(branchDecision.body.summary.results[0]?.publication, undefined);
  assert.doesNotMatch(JSON.stringify(branchDecision.body), /RAW-OWNER-AUTHORIZATION/);

  const malformedReceipt = openedResult();
  if (!malformedReceipt.publication?.ownerAuthorizationReceipt) {
    assert.fail("fixture owner authorization receipt is missing");
  }
  (malformedReceipt.publication.ownerAuthorizationReceipt as { authorizationId: string })
    .authorizationId = envelope;
  const receiptDecision = buildPublishHttpDecision(
    summary([malformedReceipt]),
    [approval()],
    OPERATOR,
    [envelope]
  );
  assert.equal(receiptDecision.status, 409);
  assert.equal(
    receiptDecision.body.summary.results[0]?.publication?.ownerAuthorizationReceipt,
    undefined
  );
  assert.doesNotMatch(JSON.stringify(receiptDecision.body), /RAW-OWNER-AUTHORIZATION/);

  const blocked: CampaignResult = {
    slug: "owner/repo",
    status: "blocked",
    prUrl: null,
    error: `upstream included ${envelope}`,
  };
  const errorDecision = buildPublishHttpDecision(
    summary([blocked]),
    [approval()],
    OPERATOR,
    [envelope]
  );
  assert.equal(errorDecision.status, 409);
  assert.equal(errorDecision.body.summary.results[0]?.error, "upstream included [REDACTED]");
  assert.doesNotMatch(JSON.stringify(errorDecision.body), /RAW-OWNER-AUTHORIZATION/);

  const invalidStatus = openedResult();
  (invalidStatus as unknown as { status: string }).status = envelope;
  const diagnosticDecision = buildPublishHttpDecision(
    summary([invalidStatus]),
    [approval()],
    OPERATOR,
    [envelope]
  );
  assert.equal(diagnosticDecision.status, 409);
  assert.match(diagnosticDecision.body.error ?? "", /returned an invalid status/);
  assert.doesNotMatch(JSON.stringify(diagnosticDecision.body), /RAW-OWNER-AUTHORIZATION/);
});
