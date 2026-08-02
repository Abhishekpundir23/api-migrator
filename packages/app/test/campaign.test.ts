import test from "node:test";
import assert from "node:assert/strict";
import { assertCampaignActive, parseStoredManifest } from "../src/campaign/runner.js";

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
