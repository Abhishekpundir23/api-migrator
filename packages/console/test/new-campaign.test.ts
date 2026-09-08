import test from "node:test";
import assert from "node:assert/strict";
import { NewCampaignManifest } from "../lib/new-campaign";
import { DEFAULT_INNGEST_MANIFEST } from "../lib/default-manifest";
import { buildPreviewEvidence } from "../lib/preview";

test("new Inngest campaigns require an explicit valid hosting declaration", () => {
  assert.equal(NewCampaignManifest.safeParse(DEFAULT_INNGEST_MANIFEST).success, false);
  for (const kind of ["long-running", "serverless"] as const) {
    const manifest = { ...DEFAULT_INNGEST_MANIFEST, deployment: { kind } };
    assert.deepEqual(NewCampaignManifest.parse(manifest).deployment, { kind });
  }
  for (const deployment of [{}, { kind: "unknown" }, { kind: "docker" }, { kind: "long-running", verified: true }]) {
    assert.equal(NewCampaignManifest.safeParse({ ...DEFAULT_INNGEST_MANIFEST, deployment }).success, false);
  }
  assert.equal(NewCampaignManifest.safeParse({
    name: "Knock", provider: "knock", transformSet: "knock-v0-to-v1",
    package: { name: "@knocklabs/node", from: "^0", to: "^1" },
  }).success, true);
});

test("preview evidence preserves only recognized deployment kinds", () => {
  for (const kind of ["long-running", "serverless", "docker", null, undefined]) {
    const view = buildPreviewEvidence({ slug: "owner/repo", status: "blocked",
      report: { manifest: { deployment: { kind } } } });
    assert.equal(view.deploymentKind, kind === "long-running" || kind === "serverless" ? kind : "unknown");
  }
  assert.equal(buildPreviewEvidence({ slug: "owner/repo", status: "blocked" }).deploymentKind, "unknown");
});
