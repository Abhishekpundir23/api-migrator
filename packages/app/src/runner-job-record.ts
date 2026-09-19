import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openJobStore, type JobStore, type StorePolicy } from "@api-migrator/db/runner-job-store-internal";
import { createRunnerEvidenceClient } from "./runner-evidence.js";
import { detachRunnerEvidenceData, type RunnerEvidenceClient, type RunnerEvidenceConfig,
  type RunnerEvidenceWorkspacePolicy } from "./runner-evidence-contract.js";
import { acquireRunnerJobEvidence, runnerJobFailure } from "./runner-job-evidence.js";
import { assertJobCurrent, RunnerJobError, type JobRecord, type JobResult } from "./runner-job-record-contract.js";
import { prepareRunnerJob, type JobClock } from "./runner-job-producer.js";
import { inspectRunnerJob, recordRunnerJobReview, snapshotJobKey, validateStoredJob } from "./runner-job-service-core.js";

const APPLICATION_CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type RunnerJobConfig = { directory: string; expectedStoreId: string; evidence: RunnerEvidenceConfig | null };
export interface RunnerJobSession {
  inspect(key: unknown): JobResult<Readonly<JobRecord>>;
  prepare(input: unknown): JobResult<Readonly<JobRecord>>;
  recordReviewedOutput(key: unknown, output: unknown, completedAt: unknown): JobResult<Readonly<JobRecord>>;
  acquireEvidence(key: unknown): Promise<JobResult<Readonly<JobRecord>>>;
  close(): void;
}
export type RunnerJobService = { open(): JobResult<RunnerJobSession> };

type TestDependencies = {
  clock: JobClock;
  client: RunnerEvidenceClient | null;
  openStore(directory: string, expectedStoreId: string, policy: StorePolicy): JobStore;
};

/** No IO until open. Clocks, checkout exclusion, transport and trust are server-owned. */
export function createRunnerJobService(config: unknown,
  policy: RunnerEvidenceWorkspacePolicy): JobResult<RunnerJobService> {
  if (arguments.length !== 2) return { ok: false, source: "job", code: "input_invalid" };
  return construct(config, policy);
}

/** Source-only fixture seam; never exported by a package subpath. */
export function createRunnerJobServiceForTest(config: unknown, policy: RunnerEvidenceWorkspacePolicy,
  dependencies: TestDependencies): JobResult<RunnerJobService> {
  return construct(config, policy, dependencies);
}

function path(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4096 ||
    /[\x00-\x1f\x7f]/.test(value) || !posix.isAbsolute(value) || posix.normalize(value) !== value ||
    value.endsWith("/") || value.split("/").some((part) => part === "." || part === "..")) {
    throw new RunnerJobError("input_invalid");
  }
  return value;
}

function configuration(config: unknown, policy: unknown) {
  try {
    const input = detachRunnerEvidenceData(config) as Record<string, unknown>;
    const workspace = detachRunnerEvidenceData(policy) as Record<string, unknown>;
    if (!input || Array.isArray(input) || Object.keys(input).sort().join(",") !== "directory,evidence,expectedStoreId" ||
      typeof input.expectedStoreId !== "string" || !UUID.test(input.expectedStoreId) ||
      !workspace || Array.isArray(workspace) || Object.keys(workspace).join(",") !== "migrationWorkspaceRoots" ||
      !Array.isArray(workspace.migrationWorkspaceRoots) || workspace.migrationWorkspaceRoots.length < 1 ||
      workspace.migrationWorkspaceRoots.length > 128) throw new RunnerJobError("input_invalid");
    const roots = workspace.migrationWorkspaceRoots.map(path);
    if (new Set(roots).size !== roots.length) throw new RunnerJobError("input_invalid");
    return { directory: path(input.directory), expectedStoreId: input.expectedStoreId,
      evidence: input.evidence, policy: Object.freeze({ migrationWorkspaceRoots: Object.freeze(roots) }) };
  } catch { throw new RunnerJobError("input_invalid"); }
}

function construct(config: unknown, policy: unknown, testDependencies?: TestDependencies): JobResult<RunnerJobService> {
  try {
    const validated = configuration(config, policy);
    let client: RunnerEvidenceClient | null = null;
    if (validated.evidence !== null) {
      const result = createRunnerEvidenceClient(validated.evidence, validated.policy);
      if (!result.ok) return { ok: false, source: "evidence", code: result.code };
      client = result.client;
    }
    const clock = testDependencies?.clock ?? { wallNow: () => Date.now(), monotonicNow: () => performance.now() };
    const openStore = testDependencies?.openStore ?? openJobStore;
    if (testDependencies) client = testDependencies.client;
    const storePolicy: StorePolicy = Object.freeze({ applicationCheckout: APPLICATION_CHECKOUT,
      migrationWorkspaceRoots: validated.policy.migrationWorkspaceRoots });
    return { ok: true, value: Object.freeze({ open: (): JobResult<RunnerJobSession> => {
      let store: JobStore | undefined;
      try {
        store = openStore(validated.directory, validated.expectedStoreId, storePolicy);
        for (const row of store.list()) validateStoredJob(row, store.storeId);
        store.observeTime(clock.wallNow());
        return { ok: true, value: session(store, clock, client) };
      } catch (error) {
        try { store?.close(); } catch { /* Preserve only the original sanitized failure. */ }
        return runnerJobFailure(error);
      }
    } }) };
  } catch (error) { return runnerJobFailure(error); }
}

function session(store: JobStore, clock: JobClock, client: RunnerEvidenceClient | null): RunnerJobSession {
  let closed = false;
  const guard = () => { if (closed) throw new RunnerJobError("store_unavailable"); };
  const run = (operation: () => Readonly<JobRecord>): JobResult<Readonly<JobRecord>> => {
    try { guard(); return { ok: true, value: operation() }; }
    catch (error) { return runnerJobFailure(error); }
  };
  return Object.freeze({
    inspect: (key: unknown) => run(() => inspectRunnerJob(store, key)),
    prepare: (input: unknown) => run(() => prepareRunnerJob(store, input, clock)),
    recordReviewedOutput: (key: unknown, output: unknown, completedAt: unknown) =>
      run(() => recordRunnerJobReview(store, key, output, completedAt, clock)),
    acquireEvidence: async (key: unknown): Promise<JobResult<Readonly<JobRecord>>> => {
      try {
        guard();
        if (client) return await acquireRunnerJobEvidence(store, key, clock, client);
        const selected = snapshotJobKey(key);
        const now = clock.wallNow();
        store.observeTime(now);
        const record = inspectRunnerJob(store, selected);
        assertJobCurrent(record, now);
        if (record.revision === 1) throw new RunnerJobError("job_conflict");
        return { ok: false, source: "evidence", code: "configuration_invalid" };
      } catch (error) { return runnerJobFailure(error); }
    },
    close: () => {
      if (closed) return;
      closed = true;
      try { store.close(); } catch (error) {
        const failure = runnerJobFailure(error);
        throw new RunnerJobError(!failure.ok && failure.source === "job" ? failure.code : "store_unavailable");
      }
    },
  });
}
