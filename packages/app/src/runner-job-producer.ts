import type { JobStore } from "@api-migrator/db/runner-job-store-internal";
import { canonicalJson } from "./canonical-json.js";
import { validateLocalPreviewExecution, type PreviewSourceIdentity } from "./preview-evidence.js";
import {
  createPublicationRunnerPlan, normalizePublicationRunnerPlanInput,
  type CreatePublicationRunnerPlanInput, type RunnerEgressDestination,
} from "./publication-runner.js";
import {
  assertJobCurrent, makePreparedRecord, preparationIntent, RunnerJobError,
  type JobRecord,
} from "./runner-job-record-contract.js";
import { detachRunnerEvidenceData } from "./runner-evidence-contract.js";
import { createSourceBundle, parseSourceBundle } from "./runner-source-bundle.js";
import { recordToStoredRow, validateStoredJob } from "./runner-job-service-core.js";

export type JobClock = { wallNow(): number; monotonicNow(): number };
export type PrepareJobInput = {
  campaignId: string; runId: string; pilotId: string;
  checkoutPath: string;
  repository: PreviewSourceIdentity["repository"];
  base: PreviewSourceIdentity["base"];
  manifestJson: string; imageDigest: string;
  migrationInstallEgress: RunnerEgressDestination[];
  expiresAt: number;
};

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

function snapshotInput(value: unknown): PrepareJobInput {
  try {
    const input = detachRunnerEvidenceData(value) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== [
        "base", "campaignId", "checkoutPath", "expiresAt", "imageDigest",
        "manifestJson", "migrationInstallEgress", "pilotId", "repository", "runId",
      ].join(",") ||
      typeof input.campaignId !== "string" || !IDENTIFIER.test(input.campaignId) ||
      typeof input.runId !== "string" || !IDENTIFIER.test(input.runId) ||
      typeof input.checkoutPath !== "string" || typeof input.manifestJson !== "string") {
      throw new Error("invalid preparation input");
    }
    // This validates exact nested source identity keys and Git OID forms without
    // accepting any source digest supplied by the caller.
    validateLocalPreviewExecution({ schemaVersion: 1, kind: "local-preview", source: {
      repository: input.repository, base: input.base,
      manifestDigest: `sha256:${"0".repeat(64)}`,
      sourceArchiveDigest: `sha256:${"0".repeat(64)}`,
    } });
    return input as PrepareJobInput;
  } catch {
    throw new RunnerJobError("input_invalid");
  }
}

function now(clock: JobClock): number {
  try {
    const value = clock.wallNow();
    if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) {
      throw new Error("invalid clock");
    }
    return value;
  } catch {
    throw new RunnerJobError("input_invalid");
  }
}

function checkCurrent(store: JobStore, record: JobRecord, clock: JobClock): void {
  const checkedAt = now(clock);
  store.observeTime(checkedAt);
  assertJobCurrent(record, checkedAt);
}

export function prepareRunnerJob(store: JobStore, value: unknown, clock: JobClock): Readonly<JobRecord> {
  const input = snapshotInput(value);
  store.observeTime(now(clock));
  let source: PreviewSourceIdentity;
  try {
    const bundle = createSourceBundle({ checkoutPath: input.checkoutPath, repository: input.repository,
      base: input.base, manifestJson: input.manifestJson });
    const parsed = parseSourceBundle(bundle.bytes);
    source = {
      repository: parsed.header.repository,
      base: { branch: parsed.header.base.branch, sha: parsed.header.base.sha, treeSha: parsed.header.base.treeSha },
      manifestDigest: parsed.header.manifest.digest,
      sourceArchiveDigest: parsed.digest,
    };
  } catch {
    throw new RunnerJobError("input_invalid");
  }
  const previousRow = store.read(input.campaignId, input.runId);
  const existing = previousRow ? validateStoredJob(previousRow, store.storeId) : null;
  const planInput: CreatePublicationRunnerPlanInput = {
    pilotId: input.pilotId,
    repository: source.repository,
    base: { branch: source.base.branch, sha: source.base.sha },
    sourceArchiveDigest: source.sourceArchiveDigest,
    manifestDigest: source.manifestDigest,
    imageDigest: input.imageDigest,
    migrationInstallEgress: input.migrationInstallEgress,
    expiresAt: input.expiresAt,
    now: existing ? existing.plan.plan.job.createdAt : now(clock),
  };
  let normalized: ReturnType<typeof normalizePublicationRunnerPlanInput>;
  try { normalized = normalizePublicationRunnerPlanInput(planInput); }
  catch { throw new RunnerJobError("input_invalid"); }
  const intent = {
    campaignId: input.campaignId, runId: input.runId, pilotId: normalized.subject.pilotId,
    source, imageDigest: normalized.imageDigest,
    migrationInstallEgress: normalized.destinations, expiresAt: normalized.expiresAt,
  };
  if (existing) {
    const existingIntent = preparationIntent({ storeId: existing.storeId,
      campaignId: existing.campaignId, runId: existing.runId,
      source: existing.source, plan: existing.plan });
    if (canonicalJson(intent) !== canonicalJson(existingIntent)) throw new RunnerJobError("job_conflict");
    checkCurrent(store, existing, clock);
    return existing;
  }
  let plan: ReturnType<typeof createPublicationRunnerPlan>;
  try { plan = createPublicationRunnerPlan(planInput); }
  catch { throw new RunnerJobError("input_invalid"); }
  const candidate = makePreparedRecord({ storeId: store.storeId,
    campaignId: input.campaignId, runId: input.runId, source, plan });
  checkCurrent(store, candidate, clock);
  const result = store.insert(recordToStoredRow(candidate));
  const winner = validateStoredJob(result.row, store.storeId);
  const winnerIntent = preparationIntent({ storeId: winner.storeId,
    campaignId: winner.campaignId, runId: winner.runId,
    source: winner.source, plan: winner.plan });
  if (!result.inserted && canonicalJson(intent) !== canonicalJson(winnerIntent)) {
    throw new RunnerJobError("job_conflict");
  }
  checkCurrent(store, winner, clock);
  return winner;
}
