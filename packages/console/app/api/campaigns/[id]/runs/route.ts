import { NextRequest, NextResponse } from "next/server";
import { init, getCampaign } from "@api-migrator/db";
import { runCampaign } from "@api-migrator/app";
import { credentialsFromEnv } from "../../../../../lib/operator-auth";
import {
  createApprovalToken,
  verifyApprovalToken,
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
  withApprovalRunLock,
  withRunLock,
} from "../../../../../lib/run-lock";
import { buildPublishHttpDecision } from "../../../../../lib/publication-response";

export const dynamic = "force-dynamic";
// PRs involve real git work; allow a long request.
export const maxDuration = 300;

/**
 * POST /api/campaigns/[id]/runs — run the campaign against a list of repos.
 * Preview body: { action: "preview", repoSlugs: ["owner/repo", ...], concurrency?: number }
 * Publish body: { action: "publish", approvalToken: "...", confirmation: "PUBLISH N PRS" }
 *
 * Preview is the default and cannot push. Publishing requires a fresh signed
 * preview token plus an exact typed confirmation. For pilot use only.
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
      const concurrency = normalizeConcurrency(body.concurrency);
      const summary = await withRunLock(() =>
        runCampaign({
          campaignId: id,
          repoSlugs,
          concurrency,
          publication: { mode: "preview" },
        })
      );
      const preflights = summary.results.flatMap((result) => {
        const preflightId = result.preflightId;
        return result.status === "preview_ready" && preflightId
          ? [{ slug: result.slug, preflightId }]
          : [];
      });
      const approval =
        preflights.length > 0
          ? createApprovalToken({
              campaignId: id,
              manifestJson: campaign.manifest,
              preflights,
              concurrency,
            })
          : null;
      return NextResponse.json(
        {
          mode: "preview",
          summary,
          approvalToken: approval?.token ?? null,
          confirmationPhrase: approval?.confirmationPhrase ?? null,
          approvalExpiresAt: approval?.expiresAt ?? null,
        },
        { status: 200 }
      );
    }

    if (action === "publish") {
      const approval = verifyApprovalToken({
        token: body.approvalToken,
        confirmation: body.confirmation,
        campaignId: id,
        manifestJson: campaign.manifest,
      });
      const approvedBy = credentialsFromEnv()?.username;
      if (!approvedBy) throw new Error("operator credentials are not configured");

      const results = await withApprovalRunLock(
        body.approvalToken as string,
        approval.expiresAt,
        async () => {
          const published = [];
          // Deliberately publish serially. This console is an operator surface,
          // and a second batch is rejected by the process-wide run lock.
          for (const item of approval.preflights) {
            const summary = await runCampaign({
              campaignId: id,
              repoSlugs: [item.slug],
              concurrency: 1,
              publication: {
                mode: "publish",
                approvedBy,
                preflightId: item.preflightId,
              },
            });
            published.push(...summary.results);
          }
          return published;
        }
      );
      const response = buildPublishHttpDecision(
        { campaignId: id, total: results.length, results },
        approval.preflights,
        approvedBy
      );
      return NextResponse.json(response.body, { status: response.status });
    }

    throw new HttpInputError("action must be preview or publish");
  } catch (error) {
    if (error instanceof HttpInputError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof RunBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("migration request failed", error);
    return NextResponse.json({ error: "migration request failed; see server logs" }, { status: 500 });
  }
}
