import { JobStoreError, type JobStore } from "@api-migrator/db/runner-job-store-internal";
import type { RunnerEvidenceClient } from "./runner-evidence-contract.js";
import { appendJobIdentity, assertJobCurrent, encodeJobRecord, RunnerJobError,
  type JobRecord, type JobResult } from "./runner-job-record-contract.js";
import type { JobClock } from "./runner-job-producer.js";
import { inspectRunnerJob, recordToStoredRow, snapshotJobKey, validateStoredJob } from "./runner-job-service-core.js";

const STORE_CODES = new Set(["input_invalid", "job_conflict", "clock_rollback", "store_unsafe",
  "store_mismatch", "store_corrupt", "store_full", "store_unavailable"]);

/** Normalize failures only; source fixtures and the built DB have distinct classes. */
export function runnerJobFailure(error: unknown): JobResult<never> {
  if (error instanceof RunnerJobError) return { ok: false, source: "job", code: error.code };
  if (error instanceof Error && (error instanceof JobStoreError || error.name === "JobStoreError") &&
    "code" in error && typeof error.code === "string" && STORE_CODES.has(error.code)) {
    return { ok: false, source: "job", code: error.code as JobStoreError["code"] };
  }
  return { ok: false, source: "job", code: "store_unavailable" };
}

/** Source-internal: normal callers can reach this only with the genuine client. */
export async function acquireRunnerJobEvidence(store: JobStore, key: unknown,
  clock: JobClock, client: RunnerEvidenceClient): Promise<JobResult<Readonly<JobRecord>>> {
  try {
    const selected = snapshotJobKey(key);
    const startedAt = clock.wallNow();
    store.observeTime(startedAt);
    const snapshot = inspectRunnerJob(store, selected);
    assertJobCurrent(snapshot, startedAt);
    if (snapshot.revision === 1) throw new RunnerJobError("job_conflict");

    // All transactions above have completed. Never retain a transaction across IO.
    const result = snapshot.revision === 3
      ? await client.reacquire(snapshot.review, snapshot.identity)
      : await client.acquireInitial(snapshot.review);
    store.observeTime(clock.wallNow());
    if (!result.ok) return { ok: false, source: "evidence", code: result.code };
    assertJobCurrent(snapshot, clock.wallNow());
    // Deliberately discard result.verified: only fixed-schema metadata is durable.
    const candidate = appendJobIdentity(snapshot, result.identity, clock.wallNow());
    let actual: Readonly<JobRecord>;
    if (snapshot.revision === 3) {
      actual = inspectRunnerJob(store, selected);
    } else {
      const candidateRow = recordToStoredRow(candidate);
      const outcome = store.compareAndSwap(recordToStoredRow(snapshot), candidateRow);
      actual = validateStoredJob(outcome.row, store.storeId);
      if (outcome.committed && outcome.row.canonicalRecord !== candidateRow.canonicalRecord) {
        throw new RunnerJobError("store_corrupt");
      }
    }
    // Equality covers the complete identity AND every original context field.
    if (encodeJobRecord(actual) !== encodeJobRecord(candidate)) throw new RunnerJobError("job_conflict");
    const observedAt = clock.wallNow();
    store.observeTime(observedAt);
    const finishedAt = clock.wallNow();
    if (finishedAt < observedAt) throw new RunnerJobError("clock_rollback");
    assertJobCurrent(snapshot, finishedAt);
    assertJobCurrent(actual, finishedAt);
    return { ok: true, value: actual };
  } catch (error) { return runnerJobFailure(error); }
}
