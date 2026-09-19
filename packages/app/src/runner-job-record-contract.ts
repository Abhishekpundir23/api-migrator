import { canonicalJson, parseCanonicalJson } from "./canonical-json.js";
import {
  normalizePublicationRunnerPlanInput,
  validatePublicationRunnerPlan,
  type PublicationRunnerPlanRecord,
  type RunnerEgressDestination,
} from "./publication-runner.js";
import { validateLocalPreviewExecution, type PreviewSourceIdentity } from "./preview-evidence.js";
import {
  detachRunnerEvidenceData,
  runnerEvidenceDigest,
  validateRetainedRunnerEvidenceIdentity,
  validateRunnerEvidenceContext,
  validateRunnerEvidenceContextStructure,
  type RetainedRunnerEvidenceIdentity,
  type RunnerEvidenceContext,
  type RunnerEvidenceFailureCode,
} from "./runner-evidence-contract.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const REVIEW_TTL_MS = 600_000;
const JOB_FAILURE_CODES = new Set<string>([
  "input_invalid", "job_missing", "job_conflict", "job_expired", "clock_rollback",
  "store_unsafe", "store_mismatch", "store_corrupt", "store_full", "store_unavailable",
]);

export type JobKey = { campaignId: string; runId: string; jobId: string };
export type JobFailureCode =
  | "input_invalid" | "job_missing" | "job_conflict" | "job_expired"
  | "clock_rollback" | "store_unsafe" | "store_mismatch"
  | "store_corrupt" | "store_full" | "store_unavailable";

export class RunnerJobError extends Error {
  readonly code: JobFailureCode;
  constructor(code: JobFailureCode) {
    const safeCode = JOB_FAILURE_CODES.has(code) ? code : "input_invalid";
    super(safeCode);
    this.name = "RunnerJobError";
    this.code = safeCode;
  }
}

export type JobResult<T> = { ok: true; value: T }
  | { ok: false; source: "job"; code: JobFailureCode }
  | { ok: false; source: "evidence"; code: RunnerEvidenceFailureCode };

export type RecordBase = JobKey & {
  schemaVersion: 1;
  storeId: string;
  intentDigest: string;
  source: PreviewSourceIdentity;
  plan: PublicationRunnerPlanRecord;
  recordDigest: string;
};

export type JobRecord = RecordBase & (
  | { revision: 1; state: "prepared" }
  | { revision: 2; state: "reviewed"; review: RunnerEvidenceContext }
  | { revision: 3; state: "evidence_retained"; review: RunnerEvidenceContext; identity: RetainedRunnerEvidenceIdentity }
);

export type PreparedFields = Pick<RecordBase, "storeId" | "campaignId" | "runId" | "source" | "plan">;

export function preparationIntent(input: PreparedFields): Readonly<{
  campaignId: string;
  runId: string;
  pilotId: string;
  source: PreviewSourceIdentity;
  imageDigest: string;
  migrationInstallEgress: readonly RunnerEgressDestination[];
  expiresAt: number;
}> {
  try {
    const detached = canonicalPreparedInput(input);
    const campaignId = identifier(detached.campaignId);
    const runId = identifier(detached.runId);
    const source = canonicalSource(detached.source);
    const plan = canonicalPlan(detached.plan);
    assertSourcePlanBinding(source, plan);
    const normalized = normalizePublicationRunnerPlanInput({
      pilotId: plan.plan.subject.pilotId,
      repository: plan.plan.subject.repository,
      base: plan.plan.subject.base,
      sourceArchiveDigest: plan.plan.inputs.sourceArchiveDigest,
      manifestDigest: plan.plan.inputs.manifestDigest,
      imageDigest: plan.plan.imageDigest,
      migrationInstallEgress: plan.plan.egress.install.destinations,
      expiresAt: plan.plan.job.expiresAt,
      now: plan.plan.job.createdAt,
    });
    return deepFreeze({
      campaignId, runId, pilotId: normalized.subject.pilotId, source,
      imageDigest: normalized.imageDigest,
      migrationInstallEgress: normalized.destinations,
      expiresAt: normalized.expiresAt,
    });
  } catch {
    throw new RunnerJobError("input_invalid");
  }
}

export function makePreparedRecord(input: PreparedFields): Readonly<JobRecord> {
  try {
    const detached = canonicalPreparedInput(input);
    const intent = preparationIntent(detached);
    const plan = canonicalPlan(detached.plan);
    const body = {
      schemaVersion: 1 as const,
      storeId: detached.storeId,
      campaignId: detached.campaignId,
      runId: detached.runId,
      jobId: plan.plan.job.id,
      revision: 1 as const,
      state: "prepared" as const,
      intentDigest: runnerEvidenceDigest(intent),
      source: detached.source,
      plan: detached.plan,
    };
    const candidate = { ...body, recordDigest: runnerEvidenceDigest(body) };
    return decodeJobRecord(canonicalJson(candidate));
  } catch {
    throw new RunnerJobError("input_invalid");
  }
}

function canonicalPreparedInput(input: PreparedFields): PreparedFields {
  const detached = object(detachRunnerEvidenceData(input));
  exactKeys(detached, ["storeId", "campaignId", "runId", "source", "plan"]);
  return detached as PreparedFields;
}

export function encodeJobRecord(record: unknown): string {
  try {
    const detached = detachRunnerEvidenceData(record);
    const bytes = canonicalJson(detached);
    decodeJobRecord(bytes);
    return bytes;
  } catch {
    throw new RunnerJobError("input_invalid");
  }
}

export function decodeJobRecord(bytes: unknown): Readonly<JobRecord> {
  try {
    const root = object(parseCanonicalJson(bytes, MAX_RECORD_BYTES, "job record"));
    const baseKeys = [
      "campaignId", "intentDigest", "jobId", "plan", "recordDigest", "revision",
      "runId", "schemaVersion", "source", "state", "storeId",
    ];
    if (root.revision === 1 && root.state === "prepared") exactKeys(root, baseKeys);
    else if (root.revision === 2 && root.state === "reviewed") exactKeys(root, [...baseKeys, "review"]);
    else if (root.revision === 3 && root.state === "evidence_retained") {
      exactKeys(root, [...baseKeys, "identity", "review"]);
    } else throw new Error("unsupported job record revision");
    if (root.schemaVersion !== 1 || typeof root.storeId !== "string" || !UUID.test(root.storeId)) {
      throw new Error("invalid job record header");
    }
    const campaignId = identifier(root.campaignId);
    const runId = identifier(root.runId);
    const source = canonicalSource(root.source);
    const plan = canonicalPlan(root.plan);
    if (root.jobId !== plan.plan.job.id) throw new Error("job id does not match plan");
    assertSourcePlanBinding(source, plan);
    const intentDigest = runnerEvidenceDigest(preparationIntent({
      storeId: root.storeId, campaignId, runId, source, plan,
    }));
    if (root.intentDigest !== intentDigest || typeof root.recordDigest !== "string" || !DIGEST.test(root.recordDigest)) {
      throw new Error("job record intent or digest is invalid");
    }
    const { recordDigest, ...body } = root;
    if (recordDigest !== runnerEvidenceDigest(body)) throw new Error("job record digest mismatch");
    let review: RunnerEvidenceContext | undefined;
    if (root.revision >= 2) {
      review = validateRunnerEvidenceContextStructure(root.review);
      if (
        review.campaignId !== campaignId || review.runId !== runId ||
        canonicalJson(review.source) !== canonicalJson(source) ||
        canonicalJson(review.plan) !== canonicalJson(plan) ||
        review.previewCompletedAt >= plan.plan.job.expiresAt
      ) throw new Error("job review is not bound to the record");
    }
    let identity: RetainedRunnerEvidenceIdentity | undefined;
    if (root.revision === 3) {
      identity = validateRetainedRunnerEvidenceIdentity(root.identity);
      if (
        identity.jobId !== plan.plan.job.id || identity.planDigest !== plan.digest ||
        identity.contextDigest !== runnerEvidenceDigest(review) ||
        identity.expiresAt > plan.plan.job.expiresAt ||
        identity.expiresAt > review!.previewCompletedAt + REVIEW_TTL_MS
      ) throw new Error("retained identity is not bound to the review");
    }
    const normalized = {
      schemaVersion: 1 as const, storeId: root.storeId, campaignId, runId,
      jobId: plan.plan.job.id, revision: root.revision, state: root.state,
      intentDigest, source, plan,
      ...(review ? { review } : {}), ...(identity ? { identity } : {}), recordDigest,
    };
    if (canonicalJson(normalized) !== canonicalJson(root)) throw new Error("job record is noncanonical");
    return deepFreeze(normalized as JobRecord);
  } catch {
    throw new RunnerJobError("store_corrupt");
  }
}

export function assertJobCurrent(record: JobRecord, now: number): void {
  if (!Number.isSafeInteger(now) || now <= 0 || now > MAX_TIMESTAMP) {
    throw new RunnerJobError("input_invalid");
  }
  const createdAt = record.plan.plan.job.createdAt;
  if (now < createdAt || (record.state !== "prepared" && now < record.review.previewCompletedAt)) {
    throw new RunnerJobError("clock_rollback");
  }
  const expiresAt = Math.min(
    record.plan.plan.job.expiresAt,
    record.state === "prepared" ? Number.MAX_SAFE_INTEGER : record.review.previewCompletedAt + REVIEW_TTL_MS,
    record.state === "evidence_retained" ? record.identity.expiresAt : Number.MAX_SAFE_INTEGER,
  );
  if (now >= expiresAt) throw new RunnerJobError("job_expired");
}

export function appendJobReview(
  record: JobRecord, output: unknown, completedAt: unknown, now: number
): Readonly<JobRecord> {
  try {
    const current = decodeJobRecord(encodeJobRecord(record));
    assertJobCurrent(current, now);
    if (current.state === "evidence_retained") throw new RunnerJobError("job_conflict");
    const review = validateRunnerEvidenceContext({
      campaignId: current.campaignId, runId: current.runId, plan: current.plan,
      source: current.source, reviewedOutput: output, previewCompletedAt: completedAt,
    }, now);
    if (current.state === "reviewed") {
      if (canonicalJson(current.review) !== canonicalJson(review)) throw new RunnerJobError("job_conflict");
      return current;
    }
    return withNextRevision(current, 2, "reviewed", { review });
  } catch (error) {
    if (error instanceof RunnerJobError) throw error;
    throw new RunnerJobError("input_invalid");
  }
}

/** Pure transition; callers must acquire and verify evidence before invoking it. */
export function appendJobIdentity(
  record: JobRecord, identity: RetainedRunnerEvidenceIdentity, now: number
): Readonly<JobRecord> {
  try {
    const current = decodeJobRecord(encodeJobRecord(record));
    assertJobCurrent(current, now);
    if (current.state === "prepared") throw new RunnerJobError("job_conflict");
    const validated = validateRetainedRunnerEvidenceIdentity(identity);
    if (
      validated.jobId !== current.jobId || validated.planDigest !== current.plan.digest ||
      validated.contextDigest !== runnerEvidenceDigest(current.review) ||
      validated.expiresAt > current.plan.plan.job.expiresAt ||
      validated.expiresAt > current.review.previewCompletedAt + REVIEW_TTL_MS ||
      validated.expiresAt <= now
    ) throw new RunnerJobError("job_conflict");
    if (current.state === "evidence_retained") {
      if (canonicalJson(current.identity) !== canonicalJson(validated)) throw new RunnerJobError("job_conflict");
      return current;
    }
    return withNextRevision(current, 3, "evidence_retained", { review: current.review, identity: validated });
  } catch (error) {
    if (error instanceof RunnerJobError) throw error;
    throw new RunnerJobError("input_invalid");
  }
}

function withNextRevision(
  current: JobRecord, revision: 2 | 3, state: "reviewed" | "evidence_retained", fields: object
): Readonly<JobRecord> {
  const { recordDigest: _priorDigest, revision: _priorRevision, state: _priorState, ...base } = current;
  const body = { ...base, revision, state, ...fields };
  return decodeJobRecord(canonicalJson({ ...body, recordDigest: runnerEvidenceDigest(body) }));
}

function canonicalPlan(value: unknown): PublicationRunnerPlanRecord {
  const root = object(value);
  exactKeys(root, ["canonicalJson", "digest", "plan"]);
  const plan = validatePublicationRunnerPlan(root.plan);
  if (root.canonicalJson !== plan.canonicalJson || root.digest !== plan.digest) {
    throw new Error("plan record identity mismatch");
  }
  return plan;
}

function canonicalSource(value: unknown): PreviewSourceIdentity {
  const preview = validateLocalPreviewExecution({ schemaVersion: 1, kind: "local-preview", source: value });
  if (!preview.source) throw new Error("source is missing");
  return preview.source;
}

function assertSourcePlanBinding(source: PreviewSourceIdentity, plan: PublicationRunnerPlanRecord): void {
  const subject = plan.plan.subject;
  const inputs = plan.plan.inputs;
  if (
    source.repository.slug !== subject.repository.slug ||
    source.repository.id !== subject.repository.id ||
    source.repository.ownerId !== subject.repository.ownerId ||
    source.base.branch !== subject.base.branch || source.base.sha !== subject.base.sha ||
    source.manifestDigest !== inputs.manifestDigest ||
    source.sourceArchiveDigest !== inputs.sourceArchiveDigest
  ) throw new Error("source does not match plan");
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error("invalid job identifier");
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid job record object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid job record object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("job record contains missing or unexpected fields");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
