import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { fixtureDigest, publicationRunnerAttestation, publicationRunnerReviewedOutput } from "./helpers/publication-runner-fixture.js";
import { appendJobIdentity, appendJobReview, makePreparedRecord, type JobRecord } from "../src/runner-job-record-contract.js";
import { canonicalJson } from "../src/canonical-json.js";
import { createPublicationRunnerPlan } from "../src/publication-runner.js";
import { setJobStoreTransactionTestHook } from "../../db/src/runner-job-store-sqlite.js";
import { DATABASE_BASENAME } from "../../db/src/runner-job-store-path.js";
import { runnerEvidenceDigest } from "../src/runner-evidence-contract.js";
import { createJobFixture } from "./helpers/runner-job-fixture.js";
import { prepareRunnerJob } from "../src/runner-job-producer.js";
import { inspectRunnerJob, recordRunnerJobReview, recordToStoredRow, validateStoredJob } from "../src/runner-job-service-core.js";

for (const scenario of ["identical", "expired", "changed preparation", "changed review"] as const) {
  test(`successful review CAS readback of ${scenario} retained descendant`, { timeout: 15_000 }, (t) => {
    const f = createJobFixture();
    t.after(() => { setJobStoreTransactionTestHook(undefined); f.close(); });
    const prepared = prepareRunnerJob(f.store, f.input, f.clock);
    const key = { campaignId: prepared.campaignId, runId: prepared.runId, jobId: prepared.jobId };
    const completedAt = f.sourceFixture.context.previewCompletedAt;
    f.state.wall = completedAt + 500;
    const output = f.sourceFixture.context.reviewedOutput;
    let retained: Extract<JobRecord, { state: "evidence_retained" }> | undefined;
    let committedRow: ReturnType<typeof recordToStoredRow> | undefined;
    setJobStoreTransactionTestHook((event) => {
      if (event.operation !== "compare_and_swap" || event.point !== "after_commit") return;
      setJobStoreTransactionTestHook(undefined);
      const committed = inspectRunnerJob(f.store, key);
      assert.equal(committed.revision, 2);
      let selected = committed;
      if (scenario === "changed preparation" || scenario === "changed review") {
        const plan = prepared.plan.plan;
        const alternate = scenario === "changed preparation" ? makePreparedRecord({
          storeId: prepared.storeId, campaignId: prepared.campaignId, runId: prepared.runId, source: prepared.source,
          plan: createPublicationRunnerPlan({
            pilotId: plan.subject.pilotId, repository: plan.subject.repository, base: plan.subject.base,
            sourceArchiveDigest: plan.inputs.sourceArchiveDigest, manifestDigest: plan.inputs.manifestDigest,
            imageDigest: fixtureDigest("changed preparation"), migrationInstallEgress: plan.egress.install.destinations,
            now: plan.job.createdAt, expiresAt: plan.job.expiresAt,
          }),
        }) : prepared;
        selected = appendJobReview(alternate, scenario === "changed review"
          ? { ...output, artifactDigest: fixtureDigest("changed review") } : output, completedAt, f.state.wall);
        // Deliberate coherent fixture substitution, not a supported transition or
        // a claim to prevent same-UID attacks. Its identity is still genuinely verified.
        const replacement = recordToStoredRow(selected);
        const db = new Database(join(f.directory, DATABASE_BASENAME));
        try {
          db.prepare(`UPDATE runner_jobs SET job_id = @jobId, intent_digest = @intentDigest,
            record_digest = @recordDigest, canonical_record = @canonicalRecord
            WHERE campaign_id = @campaignId AND run_id = @runId`).run(replacement);
        } finally { db.close(); }
      }
      assert.equal(selected.state, "reviewed");
      if (selected.state !== "reviewed") throw new Error("expected reviewed record");
      const child = JSON.parse(execFileSync(process.execPath, ["--import", "tsx",
        fileURLToPath(new URL("./helpers/runner-job-review-retain-process.ts", import.meta.url))], {
        encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
        input: JSON.stringify({ root: dirname(f.directory), directory: f.directory, storeId: f.storeId,
          policy: f.policy, wall: f.state.wall,
          key: { campaignId: selected.campaignId, runId: selected.runId, jobId: selected.jobId },
          envelope: f.sourceFixture.signPayload(publicationRunnerAttestation(selected.plan,
            selected.plan.plan.job.createdAt, selected.review.reviewedOutput)),
          registryJson: canonicalJson({ schemaVersion: 1, keys: [{ ...f.sourceFixture.trust,
            pilotId: selected.plan.plan.subject.pilotId, repository: selected.source.repository }] }),
        }),
      }));
      assert.equal(child.result.ok, true, JSON.stringify(child.result));
      assert.equal(child.reads, 2);
      assert.equal(child.fetches, 1);
      retained = child.result.value;
      assert.equal(retained!.revision, 3);
      committedRow = f.store.read(key.campaignId, key.runId)!;
      assert.deepEqual(validateStoredJob(committedRow, f.storeId), retained);
      if (scenario === "expired") f.state.wall = retained!.identity.expiresAt;
    });
    if (scenario === "identical") {
      const result = recordRunnerJobReview(f.store, key, output, completedAt, f.clock);
      assert.deepEqual(result, retained);
      assert.deepEqual(result.plan, prepared.plan);
      assert.deepEqual(result.source, prepared.source);
      assert.equal(result.state, "evidence_retained");
      if (result.state !== "evidence_retained") throw new Error("expected retained record");
      assert.deepEqual(result.review.reviewedOutput, output);
      assert.equal(result.review.previewCompletedAt, completedAt);
      assert.equal(result.identity.expiresAt, retained!.identity.expiresAt);
    } else {
      assert.throws(() => recordRunnerJobReview(f.store, key, output, completedAt, f.clock),
        { code: scenario === "expired" ? "job_expired" : "store_corrupt" });
    }
    assert.ok(retained, "child completed real retention before parent readback");
    assert.deepEqual(f.store.list(), [committedRow]);
  });
}

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
