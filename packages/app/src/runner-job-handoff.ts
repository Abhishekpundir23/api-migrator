import { MAX_JOB_SOURCE_BYTES, type JobSourceStore, type JobStore } from "@api-migrator/db/runner-job-store-internal";
import { canonicalJson } from "./canonical-json.js";
import { RunnerJobError, type JobRecord } from "./runner-job-record-contract.js";
import { prepareRunnerJobWithSource, type JobClock } from "./runner-job-producer.js";
import { checkRunnerJobCurrent, inspectRunnerJob, snapshotJobKey } from "./runner-job-service-core.js";
import { parseSourceBundle } from "./runner-source-bundle.js";

/** Input data, never execution/approval authority or an exactly-once dispatch lease. */
export type RunnerJobHandoff = { job: Readonly<JobRecord>; sourceBundle: Buffer };

function prepared(store: JobStore, record: JobRecord, clock: JobClock): void {
  checkRunnerJobCurrent(store, record, clock);
  if (record.state !== "prepared") throw new RunnerJobError("job_conflict");
}

export function readRunnerJobHandoff(store: JobStore, sources: JobSourceStore, key: unknown,
  clock: JobClock): RunnerJobHandoff {
  const selected = snapshotJobKey(key);
  const record = inspectRunnerJob(store, selected);
  prepared(store, record, clock);
  const bytes = sources.read(record.jobId);
  try {
    if (bytes.length > MAX_JOB_SOURCE_BYTES) throw new Error("source exceeds handoff limit");
    const parsed = parseSourceBundle(bytes);
    const source = { repository: parsed.header.repository,
      base: { branch: parsed.header.base.branch, sha: parsed.header.base.sha, treeSha: parsed.header.base.treeSha },
      manifestDigest: parsed.header.manifest.digest, sourceArchiveDigest: parsed.digest };
    if (canonicalJson(source) !== canonicalJson(record.source)) throw new Error("source differs from original job");
  } catch { throw new RunnerJobError("store_corrupt"); }
  const current = inspectRunnerJob(store, selected);
  prepared(store, current, clock);
  if (canonicalJson(current) !== canonicalJson(record)) throw new RunnerJobError("job_conflict");
  return { job: current, sourceBundle: Buffer.from(bytes) };
}

export function prepareRunnerJobHandoff(store: JobStore, sources: JobSourceStore, input: unknown,
  clock: JobClock): RunnerJobHandoff {
  const { job, sourceBundle } = prepareRunnerJobWithSource(store, input, clock, MAX_JOB_SOURCE_BYTES);
  // Preparation has committed and read back the winning row before any source
  // is published. A failed source write cannot change that plan or its expiry.
  prepared(store, job, clock);
  sources.put(job.jobId, sourceBundle);
  return readRunnerJobHandoff(store, sources,
    { campaignId: job.campaignId, runId: job.runId, jobId: job.jobId }, clock);
}
