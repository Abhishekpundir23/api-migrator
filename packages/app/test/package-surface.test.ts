import assert from "node:assert/strict";
import test from "node:test";
import * as rootApi from "../src/index.js";
import * as consoleInternal from "../src/console-internal.js";

test("the package root exposes no write-capable repository or campaign executor", () => {
  assert.equal("migrateRepo" in rootApi, false);
  assert.equal("runCampaign" in rootApi, false);
  assert.equal("prepareCampaignOwnerChallenge" in rootApi, false);
  assert.equal("verifyCampaignOwnerAuthorizationEnvelope" in rootApi, false);
  assert.equal("signOwnerAuthorizationChallengeFile" in rootApi, false);
  assert.equal("runPublicationRunner" in rootApi, false);
  assert.equal("executePublicationRunner" in rootApi, false);
  assert.equal("signPublicationRunnerAttestation" in rootApi, false);
  assert.equal(typeof rootApi.runCampaignJobs, "function");
  assert.equal(typeof rootApi.parseOwnerAuthorizationChallenge, "function");
  assert.equal(typeof rootApi.createPublicationRunnerPlan, "function");
  assert.equal(typeof rootApi.validatePublicationRunnerPlan, "function");
  assert.equal(typeof rootApi.assertPublicationRunnerPlanCurrent, "function");
  assert.equal(typeof rootApi.verifyPublicationRunnerAttestation, "function");
  assert.equal(typeof consoleInternal.runCampaign, "function");
  assert.equal(typeof consoleInternal.prepareCampaignOwnerChallenge, "function");
  assert.equal(typeof consoleInternal.verifyCampaignOwnerAuthorizationEnvelope, "function");
});
