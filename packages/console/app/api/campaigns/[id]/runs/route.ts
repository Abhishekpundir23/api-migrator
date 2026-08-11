import { NextRequest, NextResponse } from "next/server";
import { init, getCampaign } from "@api-migrator/db";
import {
  prepareCampaignOwnerChallenge,
  runCampaign,
  verifyCampaignOwnerAuthorizationEnvelope,
} from "@api-migrator/app/console-internal";
import { credentialsFromEnv } from "../../../../../lib/operator-auth";
import {
  createOwnerChallengeReceipt,
  createPreviewReceipt,
  prepareOperatorApproval,
  validateOwnerAuthorizationEnvelope,
  verifyOwnerChallengeReceipt,
  verifyPreviewReceipt,
  verifyOperatorApprovalToken,
} from "../../../../../lib/approval";
import {
  asObject,
  HttpInputError,
  normalizeConcurrency,
  normalizeRepoSlugs,
  readLimitedJson,
  requireUuid,
} from "../../../../../lib/request";
import {
  RunBusyError,
  withOperatorApprovalRunLock,
  withRunLock,
} from "../../../../../lib/run-lock";
import { buildPublishHttpDecision } from "../../../../../lib/publication-response";
import {
  isRunnerCapabilityActionBlocked,
  RUNNER_CAPABILITY_UNAVAILABLE_MESSAGE,
} from "../../../../../lib/runner-capability";

export const dynamic = "force-dynamic";
// PRs involve real git work; allow a long request.
export const maxDuration = 300;

/**
 * POST /api/campaigns/[id]/runs — run the campaign against a list of repos.
 * Preview body: { action: "preview", repoSlugs: ["owner/repo"] }
 * Challenge body: { action: "prepare_owner_challenge", previewReceipt: "..." }
 * Prepare body: { action: "prepare_publish", previewReceipt: "...", ownerChallengeReceipt: "...", ownerAuthorizationEnvelope: "..." }
 * Publish body: { action: "publish", operatorApprovalToken: "...", ownerAuthorizationEnvelope: "...", confirmation: "..." }
 *
 * Preview receipts cannot publish. The first pilot milestone supports exactly
 * one reviewed repository and one exact owner envelope. Publishing requires a
 * domain-separated v2 operator token plus an exact typed confirmation.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    init();
    const id = requireUuid((await params).id, "campaign id");
    const campaign = getCampaign(id);
    if (!campaign) return NextResponse.json({ error: "campaign not found" }, { status: 404 });
    const body = asObject(await readLimitedJson(req));
    const action = body.action ?? "preview";

    if (action === "preview") {
      const repoSlugs = normalizeRepoSlugs(body.repoSlugs);
      if (repoSlugs.length !== 1) {
        throw new HttpInputError("the first owner-authorized pilot milestone supports exactly one repository", 409);
      }
      const concurrency = normalizeConcurrency(body.concurrency);
      const summary = await withRunLock(() =>
        runCampaign({
          campaignId: id,
          repoSlugs,
          concurrency,
          publication: { mode: "preview" },
        })
      );
      const ready = summary.results.length === 1 && summary.results[0]?.status === "preview_ready"
        ? summary.results[0]
        : null;
      const receipt = ready?.preflightId && ready.publication
        ? createPreviewReceipt({
            campaignId: id,
            manifestJson: campaign.manifest,
            repository: {
              slug: ready.slug,
              preflightId: ready.preflightId,
              artifactDigest: ready.publication.artifactDigest,
              candidateTreeSha: ready.publication.candidateTreeSha,
              previewCompletedAt: ready.publication.previewCompletedAt,
            },
          })
        : null;
      return NextResponse.json(
        {
          mode: "preview",
          summary,
          previewReceipt: receipt?.previewReceipt ?? null,
          previewReceiptExpiresAt: receipt?.expiresAt ?? null,
        },
        { status: 200 }
      );
    }

    if (isRunnerCapabilityActionBlocked(action)) {
      return NextResponse.json(
        { error: RUNNER_CAPABILITY_UNAVAILABLE_MESSAGE },
        { status: 503 }
      );
    }

    if (action === "prepare_owner_challenge") {
      const prepared = await withRunLock(async () => {
        const preview = verifyPreviewReceipt({
          previewReceipt: body.previewReceipt,
          campaignId: id,
          manifestJson: campaign.manifest,
        });
        // The repository rerun is read-only. Recheck the receipt after the
        // potentially long operation so an expired/consumed receipt can never
        // leave the UI with an unusable challenge.
        const challenge = await prepareCampaignOwnerChallenge({
          campaignId: id,
          repository: preview.repository,
          previewReceiptExpiresAt: preview.expiresAt,
        });
        verifyPreviewReceipt({
          previewReceipt: body.previewReceipt,
          campaignId: id,
          manifestJson: campaign.manifest,
        });
        const receipt = createOwnerChallengeReceipt({
          previewReceipt: body.previewReceipt,
          campaignId: id,
          manifestJson: campaign.manifest,
          ownerChallengeDigest: challenge.challengeDigest,
          challengeExpiresAt: challenge.expiresAt,
        });
        return { challenge, receipt };
      });
      const bindings = prepared.challenge.challenge.bindings;
      return NextResponse.json({
        mode: "prepare_owner_challenge",
        challengeJson: prepared.challenge.challengeJson,
        challengeDigest: prepared.challenge.challengeDigest,
        challengeExpiresAt: prepared.challenge.expiresAt,
        // Returned only so this browser session can complete prepare_publish;
        // the UI never renders or logs the raw receipt.
        ownerChallengeReceipt: prepared.receipt.ownerChallengeReceipt,
        review: {
          pilotId: bindings.pilotId,
          approvalEvidenceDigest: bindings.approvalEvidenceDigest,
          preRunAuthorizationDigest: bindings.preRunAuthorizationDigest,
          previewCompletedAt: bindings.previewCompletedAt,
          authorizationExpiresAt: bindings.authorizationExpiresAt,
          repository: bindings.repository,
          github: bindings.github,
          base: bindings.base,
          engine: bindings.engine,
          manifest: bindings.manifest,
          preview: bindings.preview,
          allowedActions: bindings.allowedActions,
          pullRequestNumber: bindings.pullRequestNumber,
        },
      });
    }

    if (action === "prepare_publish") {
      const ownerAuthorizationEnvelope = validateOwnerAuthorizationEnvelope(
        body.ownerAuthorizationEnvelope
      );
      const prepared = await withRunLock(async () => {
        const challengeReceipt = verifyOwnerChallengeReceipt({
          ownerChallengeReceipt: body.ownerChallengeReceipt,
          previewReceipt: body.previewReceipt,
          campaignId: id,
          manifestJson: campaign.manifest,
        });
        const preview = verifyPreviewReceipt({
          previewReceipt: body.previewReceipt,
          campaignId: id,
          manifestJson: campaign.manifest,
        });
        const verification = await verifyCampaignOwnerAuthorizationEnvelope({
          campaignId: id,
          repository: preview.repository,
          previewReceiptExpiresAt: preview.expiresAt,
          ownerAuthorizationEnvelope,
          ownerChallengeDigest: challengeReceipt.ownerChallengeDigest,
        });
        if (!verification.verified) {
          throw new HttpInputError(
            "owner authorization envelope is invalid, expired, revoked, or does not match this preview",
            409
          );
        }
        // Check freshness and one-shot state again immediately before the
        // synchronous exchange consumes this receipt.
        const reverifiedChallengeReceipt = verifyOwnerChallengeReceipt({
          ownerChallengeReceipt: body.ownerChallengeReceipt,
          previewReceipt: body.previewReceipt,
          campaignId: id,
          manifestJson: campaign.manifest,
        });
        if (reverifiedChallengeReceipt.ownerChallengeDigest !== challengeReceipt.ownerChallengeDigest) {
          throw new HttpInputError("owner challenge receipt changed during verification", 409);
        }
        return prepareOperatorApproval({
          previewReceipt: body.previewReceipt,
          ownerChallengeReceipt: body.ownerChallengeReceipt,
          ownerAuthorizationEnvelope,
          campaignId: id,
          manifestJson: campaign.manifest,
        });
      });
      return NextResponse.json({
        mode: "prepare_publish",
        operatorApprovalToken: prepared.operatorApprovalToken,
        confirmationPhrase: prepared.confirmationPhrase,
        approvalExpiresAt: prepared.expiresAt,
        ownerChallengeDigest: prepared.ownerChallengeDigest,
        ownerAuthorizationDigest: prepared.ownerAuthorizationDigest,
        manifestDigest: prepared.manifestDigest,
        repository: prepared.repository,
      });
    }

    if (action === "publish") {
      const ownerAuthorizationEnvelope = validateOwnerAuthorizationEnvelope(body.ownerAuthorizationEnvelope);
      const approval = verifyOperatorApprovalToken({
        operatorApprovalToken: body.operatorApprovalToken,
        confirmation: body.confirmation,
        ownerAuthorizationEnvelope,
        campaignId: id,
        manifestJson: campaign.manifest,
      });
      const approvedBy = credentialsFromEnv()?.username;
      if (!approvedBy) throw new Error("operator credentials are not configured");

      const results = await withOperatorApprovalRunLock(
        body.operatorApprovalToken as string,
        approval.expiresAt,
        async () => {
          const summary = await runCampaign({
            campaignId: id,
            repoSlugs: [approval.repository.slug],
            concurrency: 1,
            publication: {
              mode: "publish",
              approvedBy,
              preflightId: approval.repository.preflightId,
              previewCompletedAt: approval.repository.previewCompletedAt,
              ownerAuthorizationEnvelope,
              ownerChallengeDigest: approval.ownerChallengeDigest,
            },
          });
          return summary.results;
        }
      );
      const response = buildPublishHttpDecision(
        { campaignId: id, total: results.length, results },
        [{
          ...approval.repository,
          manifestDigest: approval.manifestDigest,
          ownerAuthorizationDigest: approval.ownerAuthorizationDigest,
        }],
        approvedBy,
        [ownerAuthorizationEnvelope]
      );
      return NextResponse.json(response.body, { status: response.status });
    }

    throw new HttpInputError(
      "action must be preview, prepare_owner_challenge, prepare_publish, or publish"
    );
  } catch (error) {
    if (error instanceof HttpInputError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof RunBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Never log request-derived owner authorization envelope bytes.
    console.error("migration request failed");
    return NextResponse.json({ error: "migration request failed; see server logs" }, { status: 500 });
  }
}
