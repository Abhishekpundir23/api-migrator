import assert from "node:assert/strict";
import test from "node:test";
import { fixtureDigest, publicationRunnerReviewedOutput } from "./helpers/publication-runner-fixture.js";
import { appendJobIdentity, appendJobReview } from "../src/runner-job-record-contract.js";
import { runnerEvidenceDigest } from "../src/runner-evidence-contract.js";
import { createJobFixture } from "./helpers/runner-job-fixture.js";
import { prepareRunnerJob } from "../src/runner-job-producer.js";
import { inspectRunnerJob, recordRunnerJobReview, recordToStoredRow, validateStoredJob } from "../src/runner-job-service-core.js";

test("review appends once and exact repeats retain the stored revision", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  const prepared = prepareRunnerJob(f.store, f.input, f.clock);
  f.state.wall += 105000;
  const completedAt = f.state.wall - 500;
  const output = publicationRunnerReviewedOutput();
  const key = { campaignId: prepared.campaignId, runId: prepared.runId, jobId: prepared.jobId };
  const reviewed = recordRunnerJobReview(f.store, key, output, completedAt, f.clock);
  assert.equal(reviewed.revision, 2);
  assert.deepEqual(recordRunnerJobReview(f.store, key, output, completedAt, f.clock), reviewed);
  assert.equal(f.store.list().length, 1);
  assert.throws(() => recordRunnerJobReview(f.store, key,
    { ...output, candidateTreeSha: "4".repeat(40) }, completedAt, f.clock), { code: "job_conflict" });
  assert.throws(() => recordRunnerJobReview(f.store, key, output,
    completedAt + 1, f.clock), { code: "job_conflict" });
});

test("historical inspection remains available at expiry; review does not", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  const prepared = prepareRunnerJob(f.store, f.input, f.clock);
  const key = { campaignId: prepared.campaignId, runId: prepared.runId, jobId: prepared.jobId };
  const output = publicationRunnerReviewedOutput();
  f.state.wall += 105000;
  const completedAt = f.state.wall - 500;
  const reviewed = recordRunnerJobReview(f.store, key, output, completedAt, f.clock);
  f.store.close();
  const reopened = f.access.open(f.directory, f.storeId, f.policy);
  t.after(() => reopened.close());
  for (const row of reopened.list()) assert.deepEqual(validateStoredJob(row, f.storeId), reviewed);
  f.state.wall = completedAt + 600000;
  assert.deepEqual(inspectRunnerJob(reopened, key), reviewed);
  assert.throws(() => recordRunnerJobReview(reopened, key, output, completedAt, f.clock),
    { code: "job_expired" });
});

test("review rejects invalid keys and timeline before any storage mutation", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  const prepared = prepareRunnerJob(f.store, f.input, f.clock);
  const key = { campaignId: prepared.campaignId, runId: prepared.runId, jobId: prepared.jobId };
  const output = publicationRunnerReviewedOutput();
  for (const invalid of [prepared, { ...key, now: f.state.wall },
    { ...key, jobId: "previewjob_" + "f".repeat(64) }]) {
    assert.throws(() => recordRunnerJobReview(f.store, invalid, output, f.state.wall, f.clock),
      { code: invalid === prepared || "now" in invalid ? "input_invalid" : "job_conflict" });
  }
  assert.throws(() => inspectRunnerJob(f.store, { ...key, extra: 1 }), { code: "input_invalid" });
  assert.throws(() => inspectRunnerJob(f.store, { ...key, runId: "unknown" }), { code: "job_missing" });
  assert.throws(() => recordRunnerJobReview(f.store, key, output,
    prepared.plan.plan.job.createdAt - 1, f.clock), { code: "input_invalid" });
  assert.throws(() => recordRunnerJobReview(f.store, key, output,
    f.state.wall + 1, f.clock), { code: "input_invalid" });
  assert.equal(f.store.read(key.campaignId, key.runId)?.revision, 1);
});

test("stored row indexes and store identity are independently validated", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  const prepared = prepareRunnerJob(f.store, f.input, f.clock);
  const row = recordToStoredRow(prepared);
  for (const change of [
    { campaignId: "wrong" }, { runId: "wrong" },
    { jobId: "previewjob_" + "f".repeat(64) }, { revision: 2 as const },
    { intentDigest: fixtureDigest("wrong intent") },
    { recordDigest: fixtureDigest("wrong record") },
    { canonicalRecord: "{}" },
  ]) assert.throws(() => validateStoredJob({ ...row, ...change }, f.storeId), { code: "store_corrupt" });
  assert.throws(() => validateStoredJob(row, "00000000-0000-4000-8000-000000000000"),
    { code: "store_mismatch" });
});

test("revision 3 accepts only its exact original review", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  const prepared = prepareRunnerJob(f.store, f.input, f.clock);
  const key = { campaignId: prepared.campaignId, runId: prepared.runId, jobId: prepared.jobId };
  f.state.wall += 105000;
  const completedAt = f.state.wall - 500;
  const output = publicationRunnerReviewedOutput();
  const reviewed = recordRunnerJobReview(f.store, key, output, completedAt, f.clock);
  if (reviewed.state !== "reviewed") throw new Error("expected reviewed state");
  const identity = {
    schemaVersion: 1 as const, contextDigest: runnerEvidenceDigest(reviewed.review),
    jobId: reviewed.jobId, planDigest: reviewed.plan.digest,
    attestationPayloadDigest: fixtureDigest("payload"),
    attestationEnvelopeDigest: fixtureDigest("envelope"),
    signerKeyId: "fixture-key", signerFingerprint: fixtureDigest("fingerprint"),
    signerTrustDigest: fixtureDigest("trust"), expiresAt: f.state.wall + 1_000,
  };
  const retained = appendJobIdentity(reviewed, identity, f.state.wall);
  const previous = f.store.read(key.campaignId, key.runId)!;
  assert.equal(f.store.compareAndSwap(previous, recordToStoredRow(retained)).committed, true);
  assert.deepEqual(recordRunnerJobReview(f.store, key, output, completedAt, f.clock), retained);
  assert.throws(() => recordRunnerJobReview(f.store, key,
    { ...output, artifactDigest: fixtureDigest("changed") }, completedAt, f.clock),
    { code: "job_conflict" });
});

for (const competing of [false, true]) test(`CAS loss ${competing ? "rejects changed" : "accepts identical"} winning review`, (t) => {
    const f = createJobFixture();
    t.after(() => f.close());
    const prepared = prepareRunnerJob(f.store, f.input, f.clock);
    const key = { campaignId: prepared.campaignId, runId: prepared.runId, jobId: prepared.jobId };
    f.state.wall += 105000;
    const completedAt = f.state.wall - 500;
    const output = publicationRunnerReviewedOutput();
    const winnerOutput = competing ? { ...output, artifactDigest: fixtureDigest("competitor") } : output;
    const first = f.store.read(key.campaignId, key.runId)!;
    const winnerRecord = appendJobReview(prepared, winnerOutput, completedAt, f.state.wall);
    const racingStore = { ...f.store,
      compareAndSwap(previous: typeof first, _next: typeof first) {
        const actual = f.store.compareAndSwap(previous, recordToStoredRow(winnerRecord));
        return { committed: false, row: actual.row };
      },
    };
    if (!competing) {
      assert.deepEqual(recordRunnerJobReview(racingStore, key, output, completedAt, f.clock), winnerRecord);
    } else assert.throws(() => recordRunnerJobReview(racingStore, key, output, completedAt, f.clock),
      { code: "job_conflict" });
});

test("CAS loss rereads the winner rather than trusting a stale returned row", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  const prepared = prepareRunnerJob(f.store, f.input, f.clock);
  const key = { campaignId: prepared.campaignId, runId: prepared.runId, jobId: prepared.jobId };
  f.state.wall += 105000;
  const completedAt = f.state.wall - 500;
  const output = publicationRunnerReviewedOutput();
  const winner = appendJobReview(prepared, output, completedAt, f.state.wall);
  const racingStore = { ...f.store,
    compareAndSwap(previous: ReturnType<typeof recordToStoredRow>, _next: ReturnType<typeof recordToStoredRow>) {
      f.store.compareAndSwap(previous, recordToStoredRow(winner));
      return { committed: false, row: previous };
    },
  };
  assert.deepEqual(recordRunnerJobReview(racingStore, key, output, completedAt, f.clock), winner);
});
