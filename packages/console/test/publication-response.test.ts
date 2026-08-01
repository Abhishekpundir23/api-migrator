import assert from "node:assert/strict";
import test from "node:test";
import type { CampaignRunSummary } from "@api-migrator/app";
import { buildPublishHttpDecision } from "../lib/publication-response";

type CampaignResult = CampaignRunSummary["results"][number];

const CAMPAIGN_ID = "2f88d980-d4ce-4fb7-b3cc-fdf3503b05d3";
const PREFLIGHT_ID = `pf_${"a".repeat(64)}`;
const OPERATOR = "operator";
const approval = (slug = "owner/repo", preflightId = PREFLIGHT_ID) => ({ slug, preflightId });

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
      headSha: "d".repeat(40),
      artifactDigest: "e".repeat(64),
      blockers: [],
      overridden: false,
      approvedBy: "operator",
    },
  };
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
  assert.strictEqual(decision.body.summary, input);
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
    assert.strictEqual(decision.body.summary, input);
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
  assert.match(proofDecision.body.error ?? "", /incomplete publication proof \(approved head SHA\)/);

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
  unsafe.publication.overridden = true;
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
