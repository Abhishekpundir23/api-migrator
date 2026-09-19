import type { JobStore, StoredJobRow } from "@api-migrator/db/runner-job-store-internal";
import { canonicalJson } from "./canonical-json.js";
import {
  appendJobReview, assertJobCurrent, decodeJobRecord, encodeJobRecord, RunnerJobError,
  type JobKey, type JobRecord,
} from "./runner-job-record-contract.js";
import { detachRunnerEvidenceData, validateRunnerEvidenceContext } from "./runner-evidence-contract.js";
import { validateRunnerOutput, type PublicationRunnerOutput } from "./publication-runner.js";
import type { JobClock } from "./runner-job-producer.js";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

export function recordToStoredRow(record: JobRecord): StoredJobRow {
  const canonicalRecord = encodeJobRecord(record);
  const validated = decodeJobRecord(canonicalRecord);
  return {
    campaignId: validated.campaignId, runId: validated.runId, jobId: validated.jobId,
    revision: validated.revision, intentDigest: validated.intentDigest,
    recordDigest: validated.recordDigest, canonicalRecord,
  };
}

export function validateStoredJob(row: StoredJobRow, storeId: string): Readonly<JobRecord> {
  let record: Readonly<JobRecord>;
  try {
    record = decodeJobRecord(row.canonicalRecord);
    if (row.campaignId !== record.campaignId || row.runId !== record.runId ||
      row.jobId !== record.jobId || row.revision !== record.revision ||
      row.intentDigest !== record.intentDigest || row.recordDigest !== record.recordDigest ||
      canonicalJson(record) !== row.canonicalRecord) throw new Error("row indexes differ from record");
  } catch {
    throw new RunnerJobError("store_corrupt");
  }
  if (record.storeId !== storeId) throw new RunnerJobError("store_mismatch");
  return record;
}

export function snapshotJobKey(value: unknown): JobKey {
  try {
    const key = detachRunnerEvidenceData(value) as Record<string, unknown>;
    if (!key || typeof key !== "object" || Array.isArray(key) ||
      Object.keys(key).sort().join(",") !== "campaignId,jobId,runId" ||
      typeof key.campaignId !== "string" || !IDENTIFIER.test(key.campaignId) ||
      typeof key.runId !== "string" || !IDENTIFIER.test(key.runId) ||
      typeof key.jobId !== "string" || !/^previewjob_[a-f0-9]{64}$/.test(key.jobId)) {
      throw new Error("invalid job key");
    }
    return key as JobKey;
  } catch {
    throw new RunnerJobError("input_invalid");
  }
}

export function inspectRunnerJob(store: JobStore, key: unknown): Readonly<JobRecord> {
  const selected = snapshotJobKey(key);
  const row = store.read(selected.campaignId, selected.runId);
  if (!row) throw new RunnerJobError("job_missing");
  const record = validateStoredJob(row, store.storeId);
  if (record.jobId !== selected.jobId) throw new RunnerJobError("job_conflict");
  return record;
}

function snapshotReviewOutput(value: unknown): PublicationRunnerOutput {
  try { return validateRunnerOutput(detachRunnerEvidenceData(value)); }
  catch { throw new RunnerJobError("input_invalid"); }
}

function snapshotCompletedAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 ||
    value > 8_640_000_000_000_000) throw new RunnerJobError("input_invalid");
  return value;
}

function currentTime(clock: JobClock): number {
  try {
    const value = clock.wallNow();
    if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) {
      throw new Error("invalid clock");
    }
    return value;
  } catch { throw new RunnerJobError("input_invalid"); }
}

function expectedReview(record: JobRecord, output: PublicationRunnerOutput, completedAt: number, now: number) {
  try {
    return validateRunnerEvidenceContext({ campaignId: record.campaignId, runId: record.runId,
      source: record.source, plan: record.plan, reviewedOutput: output,
      previewCompletedAt: completedAt }, now);
  } catch { throw new RunnerJobError("input_invalid"); }
}

function samePrepared(a: JobRecord, b: JobRecord): boolean {
  return canonicalJson({ storeId: a.storeId, campaignId: a.campaignId, runId: a.runId,
    jobId: a.jobId, intentDigest: a.intentDigest, source: a.source, plan: a.plan }) ===
    canonicalJson({ storeId: b.storeId, campaignId: b.campaignId, runId: b.runId,
      jobId: b.jobId, intentDigest: b.intentDigest, source: b.source, plan: b.plan });
}

export function checkRunnerJobCurrent(store: JobStore, record: JobRecord, clock: JobClock): void {
  const observedAt = currentTime(clock);
  store.observeTime(observedAt);
  // Durable observation can itself take time. Validate a fresh sample against
  // both the persisted high-water mark and the record's original lifetime.
  const checkedAt = currentTime(clock);
  if (checkedAt < observedAt) throw new RunnerJobError("clock_rollback");
  assertJobCurrent(record, checkedAt);
}

export function recordRunnerJobReview(store: JobStore, key: unknown, output: unknown,
  completedAt: unknown, clock: JobClock): Readonly<JobRecord> {
  const selected = snapshotJobKey(key);
  const selectedOutput = snapshotReviewOutput(output);
  const selectedTime = snapshotCompletedAt(completedAt);
  const startedAt = currentTime(clock);
  store.observeTime(startedAt);
  const previousRow = store.read(selected.campaignId, selected.runId);
  if (!previousRow) throw new RunnerJobError("job_missing");
  const previous = validateStoredJob(previousRow, store.storeId);
  if (previous.jobId !== selected.jobId) throw new RunnerJobError("job_conflict");
  assertJobCurrent(previous, startedAt);
  if (selectedTime < previous.plan.plan.job.createdAt || selectedTime > startedAt) {
    throw new RunnerJobError("input_invalid");
  }
  const review = expectedReview(previous, selectedOutput, selectedTime, startedAt);
  if (previous.state !== "prepared") {
    if (canonicalJson(previous.review) !== canonicalJson(review)) throw new RunnerJobError("job_conflict");
    checkRunnerJobCurrent(store, previous, clock);
    return previous;
  }
  const next = appendJobReview(previous, selectedOutput, selectedTime, startedAt);
  checkRunnerJobCurrent(store, next, clock);
  const nextRow = recordToStoredRow(next);
  const result = store.compareAndSwap(previousRow, nextRow);
  const row = result.committed ? result.row : store.read(selected.campaignId, selected.runId);
  if (!row) throw new RunnerJobError("store_corrupt");
  const actual = validateStoredJob(row, store.storeId);
  // Readback is outside the CAS transaction. A concurrent genuine acquisition
  // may already have retained evidence, but must preserve this exact review.
  if (result.committed && row.canonicalRecord !== nextRow.canonicalRecord &&
    !(actual.state === "evidence_retained" && samePrepared(next, actual) &&
      canonicalJson(actual.review) === canonicalJson(review))) {
    throw new RunnerJobError("store_corrupt");
  }
  if (!result.committed && (!samePrepared(previous, actual) || actual.state === "prepared" ||
    canonicalJson(actual.review) !== canonicalJson(review))) throw new RunnerJobError("job_conflict");
  checkRunnerJobCurrent(store, actual, clock);
  return actual;
}
