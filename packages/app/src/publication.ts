import { createHash } from "node:crypto";
import type { Manifest, MigrationReport } from "@api-migrator/engine";
import type { OwnerAuthorizationReceipt } from "./owner-authorization.js";
import { stableStringify } from "./repository.js";
import { redactText } from "./security.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export type PublicationRequest =
  | { mode: "preview" }
  | {
      mode: "publish";
      /** Human/operator identity recorded for the publication decision. */
      approvedBy: string;
      /** Exact id returned by a preview of the same base SHA and report. */
      preflightId: string;
      /** Completion time returned by the exact reviewed preview. */
      previewCompletedAt: number;
      /**
       * Separately signed repository-owner authorization. The raw envelope is
       * verified and consumed only at the write-token boundary and is never
       * persisted in run records.
       */
      ownerAuthorizationEnvelope: string;
      /** Exact server-issued challenge digest bound into the signed envelope. */
      ownerChallengeDigest: string;
    };

export type PublicationBlockerCode =
  | "verification_skipped"
  | "verification_failed"
  | "manual_review_required";

export interface PublicationBlocker {
  code: PublicationBlockerCode;
  message: string;
}

export interface PublicationOutcome {
  mode: "preview" | "publish";
  status: "preview_ready" | "blocked" | "pr_opened" | "no_changes";
  preflightId: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  /** Exact candidate Git tree reviewed by the repository owner. */
  candidateTreeSha: string;
  /** Completion time of the exact preview authorized by the owner. */
  previewCompletedAt: number;
  /** Exact GitHub PR head observed after publication. */
  headSha?: string;
  artifactDigest: string;
  blockers: PublicationBlocker[];
  /** Publication blockers are absolute; outcomes are never overridden. */
  overridden: false;
  approvedBy?: string;
  /** Safe one-use proof; raw signed bytes and signatures are never returned. */
  ownerAuthorizationReceipt?: Readonly<OwnerAuthorizationReceipt>;
}

export type PublicationIdentity = Pick<
  PublicationOutcome,
  | "preflightId"
  | "baseBranch"
  | "baseSha"
  | "branch"
  | "candidateTreeSha"
  | "previewCompletedAt"
  | "artifactDigest"
  | "blockers"
>;

/**
 * Exact, already-sanitized state for a publication whose branch is known to
 * exist but whose PR reconciliation did not complete. This crosses the error
 * boundary so the campaign runner can durably record the external side effect.
 */
export interface PublicationAttemptAudit {
  publicationMode: "publish";
  preflightId: string;
  artifactDigest: string;
  baseSha: string;
  baseBranch: string;
  headSha: string;
  branch: string;
  candidateTreeSha: string;
  ownerAuthorizationReceipt: Readonly<OwnerAuthorizationReceipt>;
  /** Safe evidence when GitHub created a PR but its returned identity raced. */
  pullRequestNumber?: number;
  prUrl?: string;
  publicationBlockers: PublicationBlocker[];
  approvedBy: string;
  overrideUnsafe: false;
  report: MigrationReport;
}

/** Structured failure that deliberately carries no raw subprocess/API data. */
export class PublicationAttemptError extends Error {
  override readonly name = "PublicationAttemptError";

  constructor(
    message: string,
    readonly audit: PublicationAttemptAudit
  ) {
    super(message);
  }
}

export interface OpenPullRequestIdentity {
  number: number;
  htmlUrl: string;
  baseBranch: string;
}

export interface RemoteArtifactIdentity {
  expectedBaseSha: string;
  expectedTreeSha: string;
  remoteCommitSha: string;
  remoteParentShas: string[];
  remoteTreeSha: string;
}

export function publicationBlockers(report: MigrationReport): PublicationBlocker[] {
  const blockers: PublicationBlocker[] = [];
  if (report.verification.skipped) {
    const reason = report.verification.skipReason
      ? redactText(report.verification.skipReason).slice(0, 1_000)
      : undefined;
    blockers.push({
      code: "verification_skipped",
      message: reason
        ? `Verification was skipped: ${reason}`
        : "Verification was skipped",
    });
  } else if (!report.verification.ok || report.summary.verified !== true) {
    blockers.push({
      code: "verification_failed",
      message: `Verification failed with ${report.verification.introduced.length} introduced error(s)`,
    });
  }

  // The app boundary deliberately bounds the rendered entry list. The summary
  // retains the engine's complete count, so use it for the safety decision and
  // never let a review item beyond that display limit disappear fail-open.
  const reviewCount = Math.max(
    report.summary.review,
    report.entries.filter((entry) => entry.kind === "review").length
  );
  if (reviewCount > 0) {
    blockers.push({
      code: "manual_review_required",
      message: `${reviewCount} unresolved item(s) require manual review`,
    });
  }
  return blockers;
}

export function createPreflightId(input: {
  slug: string;
  baseBranch: string;
  baseSha: string;
  targetBranch: string;
  candidateTreeSha: string;
  artifactDigest: string;
  manifest: Manifest;
  report: MigrationReport;
}): string {
  // Command output is intentionally excluded: package managers can print
  // timings and other non-deterministic text even when the result is identical.
  const checks = Object.fromEntries(
    Object.entries(input.report.verification.checks).map(([name, check]) => [
      name,
      {
        status: check.status,
        command: check.command,
        exitCode: check.exitCode,
        reason: check.reason,
      },
    ])
  );
  const stableInput = {
    slug: input.slug,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    targetBranch: input.targetBranch,
    candidateTreeSha: input.candidateTreeSha,
    artifactDigest: input.artifactDigest,
    manifest: input.manifest,
    report: {
      manifest: input.report.manifest,
      scannedFiles: [...input.report.scannedFiles].sort(),
      changedFiles: [...input.report.changedFiles].sort(),
      entries: [...input.report.entries].sort((a, b) =>
        `${a.file}:${a.line ?? 0}:${a.kind}:${a.code}:${a.message}`.localeCompare(
          `${b.file}:${b.line ?? 0}:${b.kind}:${b.code}:${b.message}`
        )
      ),
      verification: {
        ok: input.report.verification.ok,
        skipped: input.report.verification.skipped,
        skipReason: input.report.verification.skipReason,
        runner: input.report.verification.runner,
        introduced: input.report.verification.introduced.map((error) => ({
          file: error.file,
          line: error.line,
          col: error.col,
          code: error.code,
          message: error.message,
        })),
        checks,
      },
      summary: input.report.summary,
    },
  };
  const digest = createHash("sha256").update(stableStringify(stableInput)).digest("hex");
  return `pf_${digest}`;
}

export function validatePublicationRequest(request: PublicationRequest | undefined): PublicationRequest {
  if (request === undefined) return { mode: "preview" };
  if (request.mode === "preview") return request;
  if (request.mode !== "publish") throw new Error("Unsupported publication mode");

  const approvedBy = request.approvedBy?.trim();
  if (!approvedBy || approvedBy.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9_.@+-]*$/.test(approvedBy)) {
    throw new Error("Publishing requires a valid operator identity");
  }
  if (!/^pf_[a-f0-9]{64}$/.test(request.preflightId ?? "")) {
    throw new Error("Publishing requires a valid preview preflight id");
  }
  if (!Number.isSafeInteger(request.previewCompletedAt) || request.previewCompletedAt <= 0) {
    throw new Error("Publishing requires the exact preview completion time");
  }
  if (
    typeof request.ownerAuthorizationEnvelope !== "string" ||
    request.ownerAuthorizationEnvelope.length === 0 ||
    Buffer.byteLength(request.ownerAuthorizationEnvelope, "utf8") > 64 * 1024
  ) {
    throw new Error("Publishing requires a bounded signed owner authorization envelope");
  }
  if (typeof request.ownerChallengeDigest !== "string" || !DIGEST.test(request.ownerChallengeDigest)) {
    throw new Error("Publishing requires the exact issued owner challenge digest");
  }
  const keys = Object.keys(request).sort();
  const expectedKeys = [
    "approvedBy",
    "mode",
    "ownerAuthorizationEnvelope",
    "ownerChallengeDigest",
    "preflightId",
    "previewCompletedAt",
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Publishing request has unknown or unsupported fields");
  }
  return { ...request, approvedBy };
}

/**
 * Produce the terminal no-change result while still enforcing exact approval
 * freshness for publish requests. Preview remains credential- and audit-free.
 */
export function createNoChangesOutcome(
  request: PublicationRequest,
  identity: PublicationIdentity
): PublicationOutcome {
  if (request.mode === "publish") {
    assertCurrentPreflight(request.preflightId, identity.preflightId);
    return {
      ...identity,
      mode: "publish",
      status: "no_changes",
      overridden: false,
      approvedBy: request.approvedBy,
    };
  }
  return {
    ...identity,
    mode: "preview",
    status: "no_changes",
    overridden: false,
  };
}

export function assertPublicationAllowed(
  request: Extract<PublicationRequest, { mode: "publish" }>,
  currentPreflightId: string,
  blockers: PublicationBlocker[]
): { overridden: false } {
  assertCurrentPreflight(request.preflightId, currentPreflightId);
  if (blockers.length === 0) return { overridden: false };
  throw new Error(`Publication blocked: ${blockers.map((blocker) => blocker.message).join("; ")}`);
}

function assertCurrentPreflight(requested: string, current: string): void {
  if (requested !== current) {
    throw new Error("Preview is stale; run a new preview and approve that exact result");
  }
}

/**
 * Existing content-addressed refs are immutable. They may be reused only when
 * the remote commit has the exact approved tree and exactly one parent: the
 * approved base commit. A pull request is deliberately not ownership proof.
 */
export function assertRemoteBranchMatchesArtifact(
  remoteSha: string,
  identity: RemoteArtifactIdentity
): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(remoteSha)) throw new Error("GitHub returned an invalid remote branch commit id");
  const shas = [
    identity.expectedBaseSha,
    identity.expectedTreeSha,
    identity.remoteCommitSha,
    identity.remoteTreeSha,
    ...identity.remoteParentShas,
  ];
  if (shas.some((sha) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))) {
    throw new Error("GitHub returned invalid commit recovery metadata");
  }
  if (
    identity.remoteParentShas.length !== 1
    || identity.remoteCommitSha !== remoteSha
    || identity.remoteParentShas[0] !== identity.expectedBaseSha
    || identity.remoteTreeSha !== identity.expectedTreeSha
  ) {
    throw new Error("Existing migration branch does not match the approved artifact and base; refusing reuse");
  }
}
