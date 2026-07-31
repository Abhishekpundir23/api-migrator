import { NextRequest, NextResponse } from "next/server";
import { init, getCampaign } from "@api-migrator/db";
import { runCampaign } from "@api-migrator/app";

export const dynamic = "force-dynamic";
// PRs involve real git work; allow a long request.
export const maxDuration = 300;

/**
 * POST /api/campaigns/[id]/runs — run the campaign against a list of repos.
 * Body: { repoSlugs: ["owner/repo", ...], concurrency?: number }
 *
 * Opens a migration PR per repo (Phase 2 workflow) and persists the result.
 * For pilot use only — production moves this to a background job.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  init();
  const { id } = await params;
  const campaign = getCampaign(id);
  if (!campaign) return NextResponse.json({ error: "campaign not found" }, { status: 404 });

  const body = await req.json();
  const repoSlugs: string[] = body.repoSlugs;
  if (!Array.isArray(repoSlugs) || repoSlugs.length === 0) {
    return NextResponse.json({ error: "repoSlugs required" }, { status: 400 });
  }

  const summary = await runCampaign({
    campaignId: id,
    repoSlugs,
    concurrency: body.concurrency ?? 2,
  });
  return NextResponse.json({ summary }, { status: 201 });
}
