import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";
import {
  closeDb,
  createCampaign,
  createProvider,
  getDb,
  init,
  listRunsForCampaign,
} from "@api-migrator/db";
import type { LocalPreviewExecution } from "@api-migrator/app/preview-evidence";
import { POST } from "../app/api/campaigns/[id]/runs/route";
import {
  createOwnerChallengeReceipt,
  createPreviewReceipt,
  digestManifest,
  prepareOperatorApproval,
  verifyPreviewReceipt,
} from "../lib/approval";
import { DEFAULT_INNGEST_MANIFEST_JSON } from "../lib/default-manifest";
import { RUNNER_CAPABILITY_UNAVAILABLE_MESSAGE } from "../lib/runner-capability";
import { withOperatorApprovalRunLock, withRunLock } from "../lib/run-lock";

const SECRET = "route-test-secret-0123456789abcdef0123456789abcdef";
const ENVELOPE = '{"version":1,"signed":"owner"}';
const NOW = 1_700_000_000_000;
const REVIEWED = {
  slug: "owner/repo",
  preflightId: `pf_${"a".repeat(64)}`,
  artifactDigest: "b".repeat(64),
  candidateTreeSha: "c".repeat(40),
  previewCompletedAt: NOW,
};
const EXECUTION: LocalPreviewExecution = {
  schemaVersion: 1,
  kind: "local-preview",
  source: {
    repository: { slug: REVIEWED.slug, id: 101, ownerId: 202 },
    base: { branch: "main", sha: "d".repeat(40), treeSha: "e".repeat(40) },
    manifestDigest: digestManifest(DEFAULT_INNGEST_MANIFEST_JSON),
    sourceArchiveDigest: `sha256:${"f".repeat(64)}`,
  },
};

let directory = "";
let campaignId = "";

before(() => {
  directory = mkdtempSync(join(tmpdir(), "api-migrator-console-route-"));
  process.env.API_MIGRATOR_DB_PATH = join(directory, "console.db");
  process.env.OPERATOR_APPROVAL_SECRET = SECRET;
  getDb(process.env.API_MIGRATOR_DB_PATH);
  init();
  const provider = createProvider({ name: "Route test", slug: "route-test" });
  campaignId = createCampaign({
    providerId: provider.id,
    name: "Closed route test",
    manifest: JSON.parse(DEFAULT_INNGEST_MANIFEST_JSON),
    status: "active",
  }).id;
});

after(() => {
  closeDb();
  if (directory.includes("api-migrator-console-route-")) {
    rmSync(directory, { recursive: true, force: true });
  }
  delete process.env.API_MIGRATOR_DB_PATH;
  delete process.env.OPERATOR_APPROVAL_SECRET;
});

async function post(body: Record<string, unknown>) {
  const response = await POST(
    new NextRequest(`http://127.0.0.1/api/campaigns/${campaignId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: campaignId }) }
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: RUNNER_CAPABILITY_UNAVAILABLE_MESSAGE });
  assert.equal(listRunsForCampaign(campaignId).length, 0);
  assert.equal(await withRunLock(async () => "available"), "available");
}

function legacyPreview(offset: number) {
  return createPreviewReceipt({
    campaignId,
    manifestJson: DEFAULT_INNGEST_MANIFEST_JSON,
    repository: { ...REVIEWED, previewCompletedAt: NOW + offset },
    now: NOW + offset,
    secret: SECRET,
  });
}

test("actual POST keeps every post-preview action closed for legacy, local, forged, future, malformed, and missing controls", async () => {
  const ownerPreview = legacyPreview(0);
  const preparePreview = legacyPreview(10_000);
  const prepareChallenge = createOwnerChallengeReceipt({
    previewReceipt: preparePreview.previewReceipt,
    campaignId,
    manifestJson: DEFAULT_INNGEST_MANIFEST_JSON,
    ownerChallengeDigest: `sha256:${"1".repeat(64)}`,
    challengeExpiresAt: NOW + 10_000 + 5 * 60 * 1_000,
    now: NOW + 10_001,
    secret: SECRET,
  });
  const publishPreview = legacyPreview(20_000);
  const publishChallenge = createOwnerChallengeReceipt({
    previewReceipt: publishPreview.previewReceipt,
    campaignId,
    manifestJson: DEFAULT_INNGEST_MANIFEST_JSON,
    ownerChallengeDigest: `sha256:${"2".repeat(64)}`,
    challengeExpiresAt: NOW + 20_000 + 5 * 60 * 1_000,
    now: NOW + 20_001,
    secret: SECRET,
  });
  const publishApproval = prepareOperatorApproval({
    previewReceipt: publishPreview.previewReceipt,
    ownerChallengeReceipt: publishChallenge.ownerChallengeReceipt,
    ownerAuthorizationEnvelope: ENVELOPE,
    campaignId,
    manifestJson: DEFAULT_INNGEST_MANIFEST_JSON,
    now: NOW + 20_002,
    secret: SECRET,
  });
  const localPreview = createPreviewReceipt({
    campaignId,
    manifestJson: DEFAULT_INNGEST_MANIFEST_JSON,
    repository: { ...REVIEWED, previewCompletedAt: NOW + 30_000 },
    execution: EXECUTION,
    now: NOW + 30_001,
    secret: SECRET,
  });
  assert.match(localPreview.previewReceipt, /^preview-v2\./);

  const legacyByAction = {
    prepare_owner_challenge: { previewReceipt: ownerPreview.previewReceipt },
    prepare_publish: {
      previewReceipt: preparePreview.previewReceipt,
      ownerChallengeReceipt: prepareChallenge.ownerChallengeReceipt,
      ownerAuthorizationEnvelope: ENVELOPE,
    },
    publish: {
      operatorApprovalToken: publishApproval.operatorApprovalToken,
      ownerAuthorizationEnvelope: ENVELOPE,
      confirmation: publishApproval.confirmationPhrase,
    },
  } as const;
  const actions = Object.keys(legacyByAction) as Array<keyof typeof legacyByAction>;
  const shapedControls = [
    (action: keyof typeof legacyByAction) => legacyByAction[action],
    () => ({
      previewReceipt: localPreview.previewReceipt,
      ownerChallengeReceipt: localPreview.previewReceipt,
      operatorApprovalToken: localPreview.previewReceipt,
      ownerAuthorizationEnvelope: ENVELOPE,
      confirmation: "PUBLISH owner/repo local-preview",
    }),
    () => ({
      previewReceipt: "preview-v2.forged.token",
      ownerChallengeReceipt: "owner-challenge-v1.forged.token",
      operatorApprovalToken: "operator-v2.forged.token",
    }),
    () => ({
      previewReceipt: "preview-v3.future-verified-runner.token",
      execution: { schemaVersion: 1, kind: "verified-runner" },
    }),
    () => ({ previewReceipt: { malformed: true }, ownerAuthorizationEnvelope: ["not", "bytes"] }),
    () => ({}),
  ];

  for (const action of actions) {
    for (const controls of shapedControls) {
      await post({ action, ...controls(action) });
    }
  }

  verifyPreviewReceipt({
    previewReceipt: ownerPreview.previewReceipt,
    campaignId,
    manifestJson: DEFAULT_INNGEST_MANIFEST_JSON,
    now: NOW + 1,
    secret: SECRET,
  });
  verifyPreviewReceipt({
    previewReceipt: localPreview.previewReceipt,
    campaignId,
    manifestJson: DEFAULT_INNGEST_MANIFEST_JSON,
    now: NOW + 30_002,
    secret: SECRET,
  });
  const preparedAfterRejection = prepareOperatorApproval({
    previewReceipt: preparePreview.previewReceipt,
    ownerChallengeReceipt: prepareChallenge.ownerChallengeReceipt,
    ownerAuthorizationEnvelope: ENVELOPE,
    campaignId,
    manifestJson: DEFAULT_INNGEST_MANIFEST_JSON,
    now: NOW + 10_002,
    secret: SECRET,
  });
  assert.match(preparedAfterRejection.operatorApprovalToken, /^operator-v2\./);
  assert.equal(
    await withOperatorApprovalRunLock(
      publishApproval.operatorApprovalToken,
      publishApproval.expiresAt,
      async () => "approval available"
    ),
    "approval available"
  );
});
