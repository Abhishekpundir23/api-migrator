import { NextRequest, NextResponse } from "next/server";
import { init, listCampaigns, createCampaign, getProviderBySlug, createProvider } from "@api-migrator/db";
import { Manifest } from "@api-migrator/engine";

export const dynamic = "force-dynamic";

/** GET /api/campaigns — list all campaigns. */
export async function GET() {
  init();
  return NextResponse.json({ campaigns: listCampaigns() });
}

/** POST /api/campaigns — create a campaign from a manifest JSON. */
export async function POST(req: NextRequest) {
  init();
  const body = await req.json();
  const parsed = Manifest.safeParse(body.manifest);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid manifest", details: parsed.error.flatten() }, { status: 400 });
  }
  const manifest = parsed.data;

  // Ensure a provider row exists.
  let provider = getProviderBySlug(manifest.provider);
  if (!provider) {
    provider = createProvider({ name: manifest.provider, slug: manifest.provider });
  }

  const campaign = createCampaign({
    providerId: provider.id,
    name: manifest.name,
    manifest,
    status: "active",
  });
  return NextResponse.json({ campaign }, { status: 201 });
}
