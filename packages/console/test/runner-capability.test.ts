import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isRunnerCapabilityActionBlocked,
  RUNNER_CAPABILITY_PROVIDER_AVAILABLE,
  RUNNER_CAPABILITY_UNAVAILABLE_MESSAGE,
} from "../lib/runner-capability.js";

test("post-preview actions remain unavailable from one shared fail-closed gate", () => {
  assert.equal(RUNNER_CAPABILITY_PROVIDER_AVAILABLE, false);
  assert.doesNotMatch(isRunnerCapabilityActionBlocked.toString(), /PROVIDER_AVAILABLE/);
  for (const action of ["prepare_owner_challenge", "prepare_publish", "publish"]) {
    assert.equal(isRunnerCapabilityActionBlocked(action), true, action);
  }
  for (const action of ["preview", "unknown", null, {}, 1]) {
    assert.equal(isRunnerCapabilityActionBlocked(action), false, String(action));
  }
  assert.match(RUNNER_CAPABILITY_UNAVAILABLE_MESSAGE, /verified runner-capability provider/);
});

test("the API hard stop precedes every post-preview ceremony and mutation boundary", () => {
  const source = readFileSync(
    new URL("../app/api/campaigns/[id]/runs/route.ts", import.meta.url),
    "utf8"
  );
  const gate = source.indexOf("if (isRunnerCapabilityActionBlocked(action))");
  assert.notEqual(gate, -1);
  for (const marker of [
    'if (action === "prepare_owner_challenge")',
    "verifyPreviewReceipt({",
    "prepareCampaignOwnerChallenge({",
    'if (action === "prepare_publish")',
    "prepareOperatorApproval({",
    'if (action === "publish")',
    "verifyOperatorApprovalToken({",
    "withOperatorApprovalRunLock(",
  ]) {
    const boundary = source.indexOf(marker);
    assert.notEqual(boundary, -1, marker);
    assert(gate < boundary, `${marker} must remain after the unconditional server gate`);
  }
});
