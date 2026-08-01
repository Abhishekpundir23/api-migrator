import { NextRequest, NextResponse } from "next/server";
import { init, getCampaign, listRunsForCampaign, campaignRollup } from "@api-migrator/db";
import { HttpInputError, requireUuid } from "../../../../lib/request";

export const dynamic = "force-dynamic";

/** GET /api/campaigns/[id] — campaign detail + its runs + rollup. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    init();
    const id = requireUuid((await params).id, "campaign id");
    const campaign = getCampaign(id);
    if (!campaign) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({
      campaign,
      runs: listRunsForCampaign(id),
      rollup: campaignRollup(id),
    });
  } catch (error) {
    if (error instanceof HttpInputError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("campaign lookup failed", error);
    return NextResponse.json({ error: "campaign lookup failed" }, { status: 500 });
  }
}
