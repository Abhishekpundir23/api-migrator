import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { posix } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import {
  assertPublicationRunnerPlanCurrent,
  canonicalIpLiteral,
  isGlobalUnicastLiteral,
  validatePublicationRunnerPlan,
  validateRunnerOutput,
  type PublicationRunnerOutput,
  type PublicationRunnerPlanRecord,
  type VerifiedPublicationRunnerAttestation,
} from "./publication-runner.js";
import {
  validateLocalPreviewExecution,
  type PreviewSourceIdentity,
} from "./preview-evidence.js";

const MAX_TIMESTAMP = 8_640_000_000_000_000;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const SIGNER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const JOB_ID = /^previewjob_[a-f0-9]{64}$/;

export interface RunnerEvidenceContext {
  campaignId: string;
  runId: string;
  plan: PublicationRunnerPlanRecord;
  source: PreviewSourceIdentity;
  reviewedOutput: PublicationRunnerOutput;
  previewCompletedAt: number;
}

export interface RunnerEvidenceConfig {
  serviceOrigin: string;
  serviceAddresses: readonly string[];
  serviceTlsSpkiDigest: string;
  registryDirectory: string;
}

export interface RunnerEvidenceWorkspacePolicy {
  migrationWorkspaceRoots: readonly string[];
}

export interface RetainedRunnerEvidenceIdentity {
  schemaVersion: 1;
  contextDigest: string;
  jobId: string;
  planDigest: string;
  attestationPayloadDigest: string;
  attestationEnvelopeDigest: string;
  signerKeyId: string;
  signerFingerprint: string;
  signerTrustDigest: string;
  expiresAt: number;
}

export type RunnerEvidenceFailureCode =
  | "configuration_invalid"
  | "expected_context_invalid"
  | "trust_unavailable"
  | "evidence_unavailable"
  | "evidence_invalid"
  | "identity_changed"
  | "expired";

export type RunnerEvidenceResult =
  | {
      ok: true;
      verified: VerifiedPublicationRunnerAttestation;
      identity: Readonly<RetainedRunnerEvidenceIdentity>;
    }
  | { ok: false; code: RunnerEvidenceFailureCode };

export interface RunnerEvidenceClient {
  acquireInitial(context: unknown): Promise<RunnerEvidenceResult>;
  reacquire(context: unknown, identity: unknown): Promise<RunnerEvidenceResult>;
}

export type RunnerEvidenceClientResult =
  | { ok: true; client: RunnerEvidenceClient }
  | { ok: false; code: "configuration_invalid" };

export class RunnerEvidenceError extends Error {
  constructor(readonly code: RunnerEvidenceFailureCode) {
    super(code);
    this.name = "RunnerEvidenceError";
  }
}

export function validateRunnerEvidenceContext(
  value: unknown,
  now: number
): Readonly<RunnerEvidenceContext> {
  try {
    const root = detachedRecord(value, "runner evidence context");
    exactKeys(root, [
      "campaignId",
      "plan",
      "previewCompletedAt",
      "reviewedOutput",
      "runId",
      "source",
    ], "runner evidence context");
    const observedAt = timestamp(now, "runner evidence clock");
    const campaignId = contextIdentifier(root.campaignId, "campaign id");
    const runId = contextIdentifier(root.runId, "run id");

    const planRoot = record(root.plan, "publication runner plan record");
    exactKeys(planRoot, ["canonicalJson", "digest", "plan"], "publication runner plan record");
    const plan = validatePublicationRunnerPlan(planRoot.plan);
    if (planRoot.canonicalJson !== plan.canonicalJson || planRoot.digest !== plan.digest) {
      throw new Error("Publication runner plan record does not match its canonical identity");
    }

    if (root.source === null) throw new Error("Runner evidence source is unavailable");
    const preview = validateLocalPreviewExecution({
      schemaVersion: 1,
      kind: "local-preview",
      source: root.source,
    });
    if (preview.source === null) throw new Error("Runner evidence source is unavailable");
    const source = preview.source;
    const reviewedOutput = validateRunnerOutput(root.reviewedOutput);
    const previewCompletedAt = timestamp(root.previewCompletedAt, "preview completion");

    if (
      previewCompletedAt < plan.plan.job.createdAt ||
      previewCompletedAt > observedAt ||
      observedAt < plan.plan.job.createdAt
    ) {
      throw new Error("Runner evidence context timeline is invalid");
    }
    if (
      source.repository.slug !== plan.plan.subject.repository.slug ||
      source.repository.id !== plan.plan.subject.repository.id ||
      source.repository.ownerId !== plan.plan.subject.repository.ownerId ||
      source.base.branch !== plan.plan.subject.base.branch ||
      source.base.sha !== plan.plan.subject.base.sha ||
      source.manifestDigest !== plan.plan.inputs.manifestDigest ||
      source.sourceArchiveDigest !== plan.plan.inputs.sourceArchiveDigest
    ) {
      throw new Error("Runner evidence source does not match its plan");
    }
    if (
      observedAt >= plan.plan.job.expiresAt ||
      observedAt >= previewCompletedAt + 10 * 60 * 1_000
    ) {
      throw new RunnerEvidenceError("expired");
    }
    assertPublicationRunnerPlanCurrent(plan, observedAt);
    return deepFreeze({
      campaignId,
      runId,
      plan,
      source,
      reviewedOutput,
      previewCompletedAt,
    });
  } catch (error) {
    if (error instanceof RunnerEvidenceError) throw error;
    throw new RunnerEvidenceError("expected_context_invalid");
  }
}

export function validateRetainedRunnerEvidenceIdentity(
  value: unknown
): Readonly<RetainedRunnerEvidenceIdentity> {
  try {
    const root = detachedRecord(value, "retained runner evidence identity");
    exactKeys(root, [
      "attestationEnvelopeDigest",
      "attestationPayloadDigest",
      "contextDigest",
      "expiresAt",
      "jobId",
      "planDigest",
      "schemaVersion",
      "signerFingerprint",
      "signerKeyId",
      "signerTrustDigest",
    ], "retained runner evidence identity");
    if (root.schemaVersion !== 1) throw new Error("Retained runner evidence schema is unsupported");
    const jobId = string(root.jobId, "runner evidence job id");
    const signerKeyId = string(root.signerKeyId, "runner evidence signer key id");
    if (!JOB_ID.test(jobId) || !SIGNER_IDENTIFIER.test(signerKeyId)) {
      throw new Error("Retained runner evidence identifier is invalid");
    }
    return deepFreeze({
      schemaVersion: 1,
      contextDigest: digest(root.contextDigest, "context digest"),
      jobId,
      planDigest: digest(root.planDigest, "plan digest"),
      attestationPayloadDigest: digest(root.attestationPayloadDigest, "attestation payload digest"),
      attestationEnvelopeDigest: digest(root.attestationEnvelopeDigest, "attestation envelope digest"),
      signerKeyId,
      signerFingerprint: digest(root.signerFingerprint, "signer fingerprint"),
      signerTrustDigest: digest(root.signerTrustDigest, "signer trust digest"),
      expiresAt: timestamp(root.expiresAt, "retained evidence expiry"),
    });
  } catch (error) {
    if (error instanceof RunnerEvidenceError) throw error;
    throw new RunnerEvidenceError("expected_context_invalid");
  }
}

export function validateRunnerEvidenceConfiguration(
  config: unknown,
  policy: unknown
): {
  config: Readonly<RunnerEvidenceConfig>;
  policy: Readonly<RunnerEvidenceWorkspacePolicy>;
} {
  try {
    const configRoot = detachedRecord(config, "runner evidence configuration");
    exactKeys(configRoot, [
      "registryDirectory",
      "serviceAddresses",
      "serviceOrigin",
      "serviceTlsSpkiDigest",
    ], "runner evidence configuration");
    const policyRoot = detachedRecord(policy, "runner evidence workspace policy");
    exactKeys(policyRoot, ["migrationWorkspaceRoots"], "runner evidence workspace policy");

    const serviceOrigin = canonicalServiceOrigin(configRoot.serviceOrigin);
    if (!Array.isArray(configRoot.serviceAddresses)) {
      throw new Error("Runner evidence service addresses are invalid");
    }
    if (configRoot.serviceAddresses.length < 1 || configRoot.serviceAddresses.length > 32) {
      throw new Error("Runner evidence service addresses are missing or excessive");
    }
    const serviceAddresses = configRoot.serviceAddresses.map((entry) => {
      const address = string(entry, "runner evidence service address");
      if (
        address !== address.toLowerCase() ||
        address.includes("%") ||
        isIP(address) === 0 ||
        canonicalIpLiteral(address) !== address ||
        !isGlobalUnicastLiteral(address)
      ) {
        throw new Error("Runner evidence service address is not canonical global unicast");
      }
      return address;
    });
    if (new Set(serviceAddresses).size !== serviceAddresses.length) {
      throw new Error("Runner evidence service addresses are duplicated");
    }
    const registryDirectory = absoluteCanonicalPath(
      configRoot.registryDirectory,
      "runner key registry directory"
    );
    if (!Array.isArray(policyRoot.migrationWorkspaceRoots)) {
      throw new Error("Migration workspace roots are invalid");
    }
    if (
      policyRoot.migrationWorkspaceRoots.length < 1 ||
      policyRoot.migrationWorkspaceRoots.length > 128
    ) {
      throw new Error("Migration workspace roots are missing or excessive");
    }
    const migrationWorkspaceRoots = policyRoot.migrationWorkspaceRoots.map((entry) =>
      absoluteCanonicalPath(entry, "migration workspace root")
    );
    if (new Set(migrationWorkspaceRoots).size !== migrationWorkspaceRoots.length) {
      throw new Error("Migration workspace roots are duplicated");
    }
    return deepFreeze({
      config: {
        serviceOrigin,
        serviceAddresses,
        serviceTlsSpkiDigest: digest(configRoot.serviceTlsSpkiDigest, "TLS SPKI digest"),
        registryDirectory,
      },
      policy: { migrationWorkspaceRoots },
    });
  } catch {
    throw new RunnerEvidenceError("configuration_invalid");
  }
}

export function runnerEvidenceDigest(value: unknown): string {
  assertDataDescriptors(value, new Set<object>());
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function runnerEvidenceFailure<C extends RunnerEvidenceFailureCode>(code: C) {
  return Object.freeze({ ok: false as const, code });
}

function detachedRecord(value: unknown, label: string): Record<string, unknown> {
  assertDataDescriptors(value, new Set<object>());
  return record(JSON.parse(canonicalJson(value)) as unknown, label);
}

function assertDataDescriptors(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value !== "object") {
    canonicalJson(value);
    return;
  }
  if (ancestors.has(value)) throw new Error("Runner evidence input is cyclic");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((!array && prototype !== Object.prototype && prototype !== null) || (array && prototype !== Array.prototype)) {
    throw new Error("Runner evidence input is not plain JSON data");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new Error("Runner evidence input contains symbolic data");
  }
  const keys = ownKeys as string[];
  const dataKeys = array ? keys.filter((key) => key !== "length") : keys;
  if (array) {
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || dataKeys.length !== length.value) {
      throw new Error("Runner evidence input contains a sparse or extended array");
    }
    for (let index = 0; index < length.value; index += 1) {
      if (dataKeys[index] !== String(index)) {
        throw new Error("Runner evidence input contains a sparse or extended array");
      }
    }
  }
  ancestors.add(value);
  try {
    for (const key of dataKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.value === undefined) {
        throw new Error("Runner evidence input contains an accessor or hidden member");
      }
      assertDataDescriptors(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(root: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(root).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unexpected fields`);
  }
}

function contextIdentifier(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!IDENTIFIER.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  canonicalJson(value);
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!SHA256.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_TIMESTAMP) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function canonicalServiceOrigin(value: unknown): string {
  const origin = string(value, "runner evidence service origin");
  const match = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/?$/.exec(origin);
  if (!match) throw new Error("Runner evidence service origin is invalid");
  const host = match[1]!;
  const parsedHost = new URL(origin).hostname;
  if (
    Buffer.byteLength(host, "ascii") > 253 ||
    parsedHost !== host ||
    isIP(parsedHost) !== 0 ||
    host.split(".").some((label) =>
      label.length === 0 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  ) {
    throw new Error("Runner evidence service origin host is invalid");
  }
  return `https://${host}`;
}

function absoluteCanonicalPath(value: unknown, label: string): string {
  const path = string(value, label);
  const parts = path.split("/");
  if (
    Buffer.byteLength(path, "utf8") > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    !posix.isAbsolute(path) ||
    path.endsWith("/") ||
    parts.some((part) => part === "." || part === "..") ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`${label} is invalid`);
  }
  return path;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
