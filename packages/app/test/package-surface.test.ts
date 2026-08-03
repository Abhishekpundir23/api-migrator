import assert from "node:assert/strict";
import test from "node:test";
import * as rootApi from "../src/index.js";
import * as consoleInternal from "../src/console-internal.js";

test("the package root exposes no write-capable repository or campaign executor", () => {
  assert.equal("migrateRepo" in rootApi, false);
  assert.equal("runCampaign" in rootApi, false);
  assert.equal(typeof rootApi.runCampaignJobs, "function");
  assert.equal(typeof consoleInternal.runCampaign, "function");
});
