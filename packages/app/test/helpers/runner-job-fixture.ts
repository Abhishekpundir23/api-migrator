import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobStoreTestAccess } from "../../../db/src/runner-job-store-sqlite.js";
import { runnerEvidenceFixture } from "./runner-evidence-fixture.js";

export function createJobFixture() {
  const sourceFixture = runnerEvidenceFixture(2_000_000_000_000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-job-service-test-")));
  const directory = join(root, "store");
  mkdirSync(directory, { mode: 0o700 });
  const policy = { applicationCheckout: process.cwd(), migrationWorkspaceRoots: [join(root, "workspace")] };
  const access = createJobStoreTestAccess(root);
  const storeId = access.initialize(directory, policy).storeId;
  const store = access.open(directory, storeId, policy);
  const state = { wall: sourceFixture.context.plan.plan.job.createdAt, monotonic: 0 };
  const clock = { wallNow: () => state.wall, monotonicNow: () => state.monotonic };
  const context = sourceFixture.context;
  const input = {
    campaignId: context.campaignId,
    runId: context.runId,
    pilotId: context.plan.plan.subject.pilotId,
    checkoutPath: sourceFixture.checkoutPath,
    repository: structuredClone(sourceFixture.bundle.header.repository),
    base: { branch: sourceFixture.bundle.header.base.branch,
      sha: sourceFixture.bundle.header.base.sha, treeSha: sourceFixture.bundle.header.base.treeSha },
    manifestJson: sourceFixture.bundle.header.manifest.canonicalJson,
    imageDigest: context.plan.plan.imageDigest,
    migrationInstallEgress: structuredClone(context.plan.plan.egress.install.destinations),
    expiresAt: context.plan.plan.job.expiresAt,
  };
  let closed = false;
  return { sourceFixture, input, clock, state, store, storeId, directory, policy, access,
    close() {
      if (closed) return;
      closed = true;
      try { store.close(); } finally {
        try { sourceFixture.close(); } finally { rmSync(root, { recursive: true, force: true }); }
      }
    },
  };
}
