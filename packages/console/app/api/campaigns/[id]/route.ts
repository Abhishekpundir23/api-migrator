import { NextRequest, NextResponse } from "next/server";
import { init, getCampaign, listRunsForCampaign, campaignRollup } from "@api-migrator/db";

export const dynamic = "force-dynamic";

/** GET /api/campaigns/[id] — campaign detail + its runs + rollup. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  init();
  const { id } = await params;
  const campaign = getCampaign(id);
  if (!campaign) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    campaign,
    runs: listRunsForCampaign(id),
    rollup: campaignRollup(id),
  });
}
