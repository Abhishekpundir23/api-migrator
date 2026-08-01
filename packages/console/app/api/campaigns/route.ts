import { NextRequest, NextResponse } from "next/server";
import { init, listCampaigns, createCampaign, getProviderBySlug, createProvider } from "@api-migrator/db";
import { Manifest } from "@api-migrator/engine";
import { asObject, HttpInputError, readLimitedJson } from "../../../lib/request";

export const dynamic = "force-dynamic";

/** GET /api/campaigns — list all campaigns. */
export async function GET() {
  init();
  return NextResponse.json({ campaigns: listCampaigns() });
}

/** POST /api/campaigns — create a campaign from a manifest JSON. */
export async function POST(req: NextRequest) {
  try {
    init();
    const body = asObject(await readLimitedJson(req));
    const parsed = Manifest.safeParse(body.manifest);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid manifest", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const manifest = parsed.data;

    // createProvider is an atomic upsert, so concurrent requests cannot race.
    const provider =
      getProviderBySlug(manifest.provider) ??
      createProvider({ name: manifest.provider, slug: manifest.provider });

    const campaign = createCampaign({
      providerId: provider.id,
      name: manifest.name,
      manifest,
      status: "active",
    });
    return NextResponse.json({ campaign }, { status: 201 });
  } catch (error) {
    if (error instanceof HttpInputError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("campaign creation failed", error);
    return NextResponse.json({ error: "campaign creation failed" }, { status: 500 });
  }
}
