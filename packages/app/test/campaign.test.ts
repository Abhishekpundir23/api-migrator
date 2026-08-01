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
    package: { name: "inngest", from: "^3", to: "^4" },
    peerFloors: [],
  });
  assert.equal(parseStoredManifest(valid).transformSet, "inngest-v3-to-v4");
  assert.throws(() => parseStoredManifest("{not json"), /manifest is invalid/);
  assert.throws(() => parseStoredManifest(JSON.stringify({ name: "missing fields" })), /manifest is invalid/);
});
