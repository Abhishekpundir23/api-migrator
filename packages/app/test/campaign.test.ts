import test from "node:test";
import assert from "node:assert/strict";
import { assertCampaignActive, parseStoredManifest } from "../src/campaign/runner.js";
import { closeDb, createCampaign, createProvider, getCampaign, getDb, migrate } from "@api-migrator/db";

test("campaign storage round-trips the declaration without assigning one to legacy data", () => {
  try {
    migrate(getDb(":memory:"));
    const provider = createProvider({ name: "Inngest", slug: "inngest" });
    for (const kind of [undefined, "long-running", "serverless"] as const) {
      const manifest = parseStoredManifest(JSON.stringify({ name: "Legacy-compatible", provider: "inngest",
        transformSet: "inngest-v3-to-v4", package: { name: "inngest", from: "^3", to: "^4" },
        ...(kind ? { deployment: { kind } } : {}) }));
      const campaign = createCampaign({ providerId: provider.id, name: manifest.name, manifest, status: "active" });
      const stored = parseStoredManifest(getCampaign(campaign.id)!.manifest);
      assert.deepEqual(stored.deployment, kind ? { kind } : undefined);
    }
  } finally { closeDb(); }
});

test("only active campaigns can execute", () => {
  assert.doesNotThrow(() => assertCampaignActive("active", "c1"));
  for (const status of ["draft", "completed", "archived"]) {
    assert.throws(() => assertCampaignActive(status, "c1"), /only active campaigns/);
  }
});

test("stored campaign manifests are runtime validated at the boundary", () => {
  const valid = JSON.stringify({
    name: "Inngest v4",
    provider: "inngest",
    transformSet: "inngest-v3-to-v4",
    runtime: { node: { minimumMajor: 20, profile: "node22-bookworm-slim-2026-07", packageJson: "package.json", dockerfile: "Dockerfile" } },
    package: { name: "inngest", from: "^3", to: "^4" },
    peerFloors: [],
  });
  assert.equal(parseStoredManifest(valid).transformSet, "inngest-v3-to-v4");
  assert.equal(parseStoredManifest(valid).deployment, undefined);
  for (const kind of ["long-running", "serverless"] as const) {
    assert.deepEqual(parseStoredManifest(JSON.stringify({ ...JSON.parse(valid), deployment: { kind } })).deployment, { kind });
  }
  const legacy = JSON.stringify({
    name: "Legacy Inngest v4",
    provider: "inngest",
    transformSet: "inngest-v3-to-v4",
    package: { name: "inngest", from: "^3", to: "^4" },
    peerFloors: [],
  });
  assert.deepEqual(parseStoredManifest(legacy).runtime, {
    node: {
      minimumMajor: 20,
      profile: "node22-bookworm-slim-2026-07",
      packageJson: "package.json",
      dockerfile: "Dockerfile",
    },
  });
  const legacyManifest = JSON.parse(legacy);
  for (const mismatchedIdentity of [
    { ...legacyManifest, provider: "not-inngest" },
    { ...legacyManifest, package: { ...legacyManifest.package, name: "not-inngest" } },
  ]) {
    assert.throws(
      () => parseStoredManifest(JSON.stringify(mismatchedIdentity)),
      /manifest is invalid/
    );
  }
  assert.throws(
    () => parseStoredManifest(JSON.stringify({ ...legacyManifest, runtime: null })),
    /manifest is invalid/
  );
  assert.throws(() => parseStoredManifest("{not json"), /manifest is invalid/);
  assert.throws(() => parseStoredManifest(JSON.stringify({ name: "missing fields" })), /manifest is invalid/);
});
