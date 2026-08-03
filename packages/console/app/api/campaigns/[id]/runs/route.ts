import { NextRequest, NextResponse } from "next/server";
import { init, getCampaign } from "@api-migrator/db";
import { runCampaign } from "@api-migrator/app/console-internal";
import { credentialsFromEnv } from "../../../../../lib/operator-auth";
import {
  createPreviewReceipt,
  prepareOperatorApproval,
  validateOwnerAuthorizationEnvelope,
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

export const dynamic = "force-dynamic";
// PRs involve real git work; allow a long request.
export const maxDuration = 300;

/**
 * POST /api/campaigns/[id]/runs — run the campaign against a list of repos.
 * Preview body: { action: "preview", repoSlugs: ["owner/repo"] }
 * Prepare body: { action: "prepare_publish", previewReceipt: "...", ownerAuthorizationEnvelope: "..." }
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

    if (action === "prepare_publish") {
      const prepared = prepareOperatorApproval({
        previewReceipt: body.previewReceipt,
        ownerAuthorizationEnvelope: body.ownerAuthorizationEnvelope,
        campaignId: id,
        manifestJson: campaign.manifest,
      });
      return NextResponse.json({
        mode: "prepare_publish",
        operatorApprovalToken: prepared.operatorApprovalToken,
        confirmationPhrase: prepared.confirmationPhrase,
        approvalExpiresAt: prepared.expiresAt,
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

    throw new HttpInputError("action must be preview, prepare_publish, or publish");
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
