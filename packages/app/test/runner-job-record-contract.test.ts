import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import {
  appendJobIdentity,
  appendJobReview,
  assertJobCurrent,
  decodeJobRecord,
  encodeJobRecord,
  makePreparedRecord,
  preparationIntent,
  RunnerJobError,
} from "../src/runner-job-record-contract.js";
import {
  RunnerEvidenceError,
  runnerEvidenceDigest,
  validateRunnerEvidenceContext,
  validateRunnerEvidenceContextStructure,
} from "../src/runner-evidence-contract.js";
import { createPublicationRunnerPlan } from "../src/publication-runner.js";
import { fixtureDigest } from "./helpers/publication-runner-fixture.js";
import { runnerEvidenceFixture } from "./helpers/runner-evidence-fixture.js";

const NOW = 2_000_000_000_000;

test("prepared record survives historical decode but rejects expiry and accessors", (t) => {
  const f = runnerEvidenceFixture(NOW);
  t.after(() => f.close());
  const record = makePreparedRecord({
    storeId: randomUUID(), campaignId: f.context.campaignId, runId: f.context.runId,
    source: f.context.source, plan: f.context.plan,
  });
  const bytes = encodeJobRecord(record);
  assert.throws(() => assertJobCurrent(record, record.plan.plan.job.expiresAt));
  assert.deepEqual(decodeJobRecord(bytes), record);
  assert.doesNotThrow(() => decodeJobRecord(bytes));
  assert(Object.isFrozen(record.source.base));
  let reads = 0;
  const bad = structuredClone(record);
  Object.defineProperty(bad.plan.plan.execution.phaseOrder, "0", {
    enumerable: true, get() { reads++; return "offline_preparation"; },
  });
  assert.throws(() => encodeJobRecord(bad));
  assert.equal(reads, 0);
  const hostile = {
    storeId: randomUUID(), campaignId: f.context.campaignId, runId: f.context.runId,
    source: f.context.source, plan: f.context.plan,
  };
  Object.defineProperty(hostile, "source", {
    enumerable: true, get() { reads++; return f.context.source; },
  });
  assert.throws(() => makePreparedRecord(hostile), (error: unknown) =>
    error instanceof RunnerJobError && error.code === "input_invalid");
  assert.equal(reads, 0);
});

test("historical context structure rejects post-plan completion without changing live expiry code", (t) => {
  const f = runnerEvidenceFixture(NOW);
  t.after(() => f.close());
  const expired = structuredClone(f.context);
  expired.previewCompletedAt = expired.plan.plan.job.expiresAt + 1;
  assert.throws(() => validateRunnerEvidenceContextStructure(expired), (error: unknown) =>
    error instanceof RunnerEvidenceError && error.code === "expected_context_invalid");
  assert.throws(() => validateRunnerEvidenceContext(expired, expired.previewCompletedAt + 1), (error: unknown) =>
    error instanceof RunnerEvidenceError && error.code === "expired");
});

test("job errors reveal fixed codes only", () => {
  const error = new RunnerJobError("sensitive caller detail" as any);
  assert.equal(error.message, "input_invalid");
  assert.equal(error.code, "input_invalid");
});

test("record encoding rejects unknown fields, broken bindings, corrupt digests, and noncanonical bytes", (t) => {
  const f = runnerEvidenceFixture(NOW);
  t.after(() => f.close());
  const record = makePreparedRecord({
    storeId: randomUUID(), campaignId: f.context.campaignId, runId: f.context.runId,
    source: f.context.source, plan: f.context.plan,
  });
  for (const mutate of [
    (r: any) => { r.extra = true; },
    (r: any) => { r.revision = 4; },
    (r: any) => { r.storeId = "not-a-uuid"; },
    (r: any) => { r.source.base.treeSha = "f".repeat(40); },
    (r: any) => { r.source.repository.id++; },
    (r: any) => { r.plan.digest = fixtureDigest("other"); },
    (r: any) => { r.jobId = `previewjob_${"f".repeat(64)}`; },
  ]) {
    const changed = structuredClone(record); mutate(changed);
    assert.throws(() => encodeJobRecord(changed));
  }
  for (const bytes of ["{}\n", '{"a":1,"a":1}', "x".repeat(262145)]) {
    assert.throws(() => decodeJobRecord(bytes));
  }
  for (const mutate of [
    (r: any) => { r.source.repository.id++; },
    (r: any) => { r.source.base.treeSha = "f".repeat(40); },
    (r: any) => { r.jobId = `previewjob_${"f".repeat(64)}`; },
  ]) {
    const changed: any = structuredClone(record);
    mutate(changed);
    const { recordDigest: _old, ...body } = changed;
    changed.recordDigest = runnerEvidenceDigest(body);
    assert.throws(() => decodeJobRecord(canonicalJson(changed)), /store_corrupt/);
  }
});

test("intent ignores nonce, creation time, and store ID but binds egress and expiry", (t) => {
  const f = runnerEvidenceFixture(NOW);
  t.after(() => f.close());
  const original = f.context.plan.plan;
  const input = {
    pilotId: original.subject.pilotId,
    repository: original.subject.repository,
    base: original.subject.base,
    sourceArchiveDigest: original.inputs.sourceArchiveDigest,
    manifestDigest: original.inputs.manifestDigest,
    imageDigest: original.imageDigest,
    migrationInstallEgress: structuredClone(original.egress.install.destinations),
    now: original.job.createdAt + 1_000,
    expiresAt: original.job.expiresAt,
  };
  const second = createPublicationRunnerPlan(input);
  assert.notEqual(second.plan.job.id, f.context.plan.plan.job.id);
  const firstIntent = preparationIntent({
    storeId: randomUUID(), campaignId: f.context.campaignId, runId: f.context.runId,
    source: f.context.source, plan: f.context.plan,
  });
  const secondIntent = preparationIntent({
    storeId: randomUUID(), campaignId: f.context.campaignId, runId: f.context.runId,
    source: f.context.source, plan: second,
  });
  assert.deepEqual(secondIntent, firstIntent);
  const changed = createPublicationRunnerPlan({ ...input, imageDigest: fixtureDigest("different-image") });
  assert.notDeepEqual(preparationIntent({
    storeId: randomUUID(), campaignId: f.context.campaignId, runId: f.context.runId,
    source: f.context.source, plan: changed,
  }), firstIntent);
});

test("review and retained identity append once with exact idempotence and expiry", (t) => {
  const f = runnerEvidenceFixture(NOW);
  t.after(() => f.close());
  const prepared = makePreparedRecord({
    storeId: randomUUID(), campaignId: f.context.campaignId, runId: f.context.runId,
    source: f.context.source, plan: f.context.plan,
  });
  const reviewed = appendJobReview(prepared, f.context.reviewedOutput, f.context.previewCompletedAt, NOW);
  assert.equal(reviewed.state, "reviewed");
  assert.deepEqual(decodeJobRecord(encodeJobRecord(reviewed)), reviewed);
  assert.throws(() => assertJobCurrent(reviewed, f.context.previewCompletedAt - 1), (error: unknown) =>
    error instanceof RunnerJobError && error.code === "clock_rollback");
  assert.throws(() => assertJobCurrent(reviewed, f.context.previewCompletedAt + 600_000));
  assert.equal(encodeJobRecord(appendJobReview(reviewed, f.context.reviewedOutput, f.context.previewCompletedAt, NOW)), encodeJobRecord(reviewed));
  assert.throws(() => appendJobReview(reviewed, { ...f.context.reviewedOutput, artifactDigest: fixtureDigest("changed") }, f.context.previewCompletedAt, NOW));
  assert.throws(() => appendJobReview(reviewed, f.context.reviewedOutput, f.context.previewCompletedAt + 1, NOW));
  assert.throws(() => appendJobReview(prepared, {}, f.context.previewCompletedAt, NOW));
  assert.throws(() => appendJobReview(prepared, f.context.reviewedOutput, f.context.plan.plan.job.createdAt - 1, NOW));
  assert.throws(() => appendJobReview(prepared, f.context.reviewedOutput, NOW + 1, NOW));
  const identity = {
    schemaVersion: 1 as const,
    contextDigest: runnerEvidenceDigest((reviewed as Extract<typeof reviewed, { state: "reviewed" }>).review),
    jobId: reviewed.jobId,
    planDigest: reviewed.plan.digest,
    attestationPayloadDigest: fixtureDigest("payload"),
    attestationEnvelopeDigest: fixtureDigest("envelope"),
    signerKeyId: f.trust.keyId,
    signerFingerprint: f.trust.fingerprint,
    signerTrustDigest: fixtureDigest("trust"),
    expiresAt: NOW + 1_000,
  };
  assert.throws(() => appendJobIdentity(prepared, identity, NOW));
  const retained = appendJobIdentity(reviewed, identity, NOW);
  assert.equal(retained.state, "evidence_retained");
  assert.deepEqual(decodeJobRecord(encodeJobRecord(retained)), retained);
  assert.equal(encodeJobRecord(appendJobIdentity(retained, identity, NOW)), encodeJobRecord(retained));
  assert.throws(() => assertJobCurrent(retained, identity.expiresAt));
  assert.throws(() => assertJobCurrent(prepared, prepared.plan.plan.job.createdAt - 1), (error: unknown) =>
    error instanceof RunnerJobError && error.code === "clock_rollback");
  assert.throws(() => appendJobReview(prepared, f.context.reviewedOutput, f.context.previewCompletedAt, prepared.plan.plan.job.expiresAt));
  assert.throws(() => appendJobIdentity(reviewed, { ...identity, expiresAt: reviewed.plan.plan.job.expiresAt + 1 }, NOW));
  for (const field of [
    "contextDigest", "jobId", "planDigest", "attestationPayloadDigest", "attestationEnvelopeDigest",
    "signerKeyId", "signerFingerprint", "signerTrustDigest", "expiresAt",
  ] as const) {
    const conflict: any = { ...identity };
    conflict[field] = field === "jobId" ? `previewjob_${"f".repeat(64)}` :
      field === "signerKeyId" ? "different-key" : field === "expiresAt" ? identity.expiresAt + 1 : fixtureDigest(`other-${field}`);
    assert.throws(() => appendJobIdentity(retained, conflict, NOW), undefined, field);
  }
  assert.throws(() => appendJobReview(retained, f.context.reviewedOutput, f.context.previewCompletedAt, NOW));
});
