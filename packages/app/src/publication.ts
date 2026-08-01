import { createHash } from "node:crypto";
import type { Manifest, MigrationReport } from "@api-migrator/engine";
import { stableStringify } from "./repository.js";
import { redactText } from "./security.js";

export type PublicationRequest =
  | { mode: "preview" }
  | {
      mode: "publish";
      /** Human/operator identity recorded for the publication decision. */
      approvedBy: string;
      /** Exact id returned by a preview of the same base SHA and report. */
      preflightId: string;
      /** Explicit operator acknowledgment for manual-review flags only. */
      overrideUnsafe?: boolean;
      /** Mandatory audit reason whenever overrideUnsafe is true. */
      overrideReason?: string;
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
  /** Exact GitHub PR head observed after publication. */
  headSha?: string;
  artifactDigest: string;
  blockers: PublicationBlocker[];
  overridden: boolean;
  approvedBy?: string;
  /** Sanitized audit reason, present only for an applied manual-review override. */
  overrideReason?: string;
}

export type PublicationIdentity = Pick<
  PublicationOutcome,
  "preflightId" | "baseBranch" | "baseSha" | "branch" | "artifactDigest" | "blockers"
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
  publicationBlockers: PublicationBlocker[];
  approvedBy: string;
  overrideUnsafe: boolean;
  overrideReason?: string;
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
  if (request.overrideUnsafe) {
    const reason = request.overrideReason?.trim();
    if (!reason || reason.length < 10 || reason.length > 500 || /[\r\n]/.test(reason)) {
      throw new Error("Unsafe publication override requires a 10–500 character single-line reason");
    }
    return {
      ...request,
      approvedBy,
      overrideReason: redactText(reason).slice(0, 500),
    };
  } else if (request.overrideReason !== undefined) {
    throw new Error("overrideReason is only valid with overrideUnsafe");
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
): { overridden: boolean } {
  assertCurrentPreflight(request.preflightId, currentPreflightId);
  const absolute = blockers.filter((blocker) => blocker.code !== "manual_review_required");
  if (absolute.length > 0) {
    throw new Error(`Publication blocked: ${absolute.map((blocker) => blocker.message).join("; ")}`);
  }
  if (blockers.length === 0) return { overridden: false };
  if (!request.overrideUnsafe) {
    throw new Error(`Publication blocked: ${blockers.map((blocker) => blocker.message).join("; ")}`);
  }
  // validatePublicationRequest already requires an identity and reason. This is
  // deliberately a separate flag so ordinary publish approvals cannot bypass gates.
  return { overridden: true };
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
  if (!/^[a-f0-9]{40,64}$/.test(remoteSha)) throw new Error("GitHub returned an invalid remote branch commit id");
  const shas = [
    identity.expectedBaseSha,
    identity.expectedTreeSha,
    identity.remoteCommitSha,
    identity.remoteTreeSha,
    ...identity.remoteParentShas,
  ];
  if (shas.some((sha) => !/^[a-f0-9]{40,64}$/.test(sha))) {
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
