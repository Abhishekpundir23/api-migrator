import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobStoreTestAccess } from "../../../db/src/runner-job-store-sqlite.js";
import { runnerEvidenceFixture } from "./runner-evidence-fixture.js";
import { canonicalJson } from "../../src/canonical-json.js";
import { prepareRunnerJob } from "../../src/runner-job-producer.js";
import { recordRunnerJobReview } from "../../src/runner-job-service-core.js";
import { createRunnerEvidenceClientWithDependencies } from "../../src/runner-evidence-core.js";
import { selectRunnerKey } from "../../src/runner-key-registry.js";
import { publicationRunnerAttestation } from "./publication-runner-fixture.js";

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

/** Disposable transport/registry fixtures; the production verifier stays real. */
export function createJobEvidenceHarness(f: ReturnType<typeof createJobFixture>) {
  const prepared = prepareRunnerJob(f.store, f.input, f.clock);
  const key = { campaignId: prepared.campaignId, runId: prepared.runId, jobId: prepared.jobId };
  f.state.wall = f.sourceFixture.context.previewCompletedAt;
  const output = f.sourceFixture.context.reviewedOutput;
  const reviewed = recordRunnerJobReview(f.store, key, output, f.state.wall, f.clock);
  f.state.wall += 500;
  const signPayload = f.sourceFixture.signPayload;
  const payload = publicationRunnerAttestation(prepared.plan, prepared.plan.plan.job.createdAt, output);
  const state = { reads: 0, fetches: 0, envelope: signPayload(payload), registryBytes: Buffer.from(canonicalJson({
    schemaVersion: 1, keys: [{ ...f.sourceFixture.trust,
      pilotId: prepared.plan.plan.subject.pilotId, repository: prepared.source.repository }],
  })) };
  const createClient = (options: { state?: typeof state; beforeFetchReturn?: () => Promise<void> } = {}) => {
    const selected = options.state ?? state;
    return createRunnerEvidenceClientWithDependencies({
      clock: f.clock,
      readKey: async (context, deadline) => {
        selected.reads += 1;
        return selectRunnerKey(selected.registryBytes, context, deadline.check());
      },
      fetchEnvelope: async (jobId) => {
        if (jobId !== key.jobId) throw new Error("unexpected fixture job");
        selected.fetches += 1;
        const envelope = selected.envelope;
        await options.beforeFetchReturn?.();
        return envelope;
      },
    });
  };
  return { key, prepared, reviewed, client: createClient(), state, signPayload, payload, createClient };
}
