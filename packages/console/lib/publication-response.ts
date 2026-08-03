import {
  parseRepositorySlug,
  redactText,
  sanitizeMigrationReport,
  validateBranchName,
  type CampaignRunSummary,
  type OwnerAuthorizationReceipt,
  type PublicationOutcome,
} from "@api-migrator/app";
import type { ReviewedPreview } from "./approval";

type CampaignResult = CampaignRunSummary["results"][number];

export interface ApprovedPublication extends ReviewedPreview {
  manifestDigest: string;
  ownerAuthorizationDigest: string;
}

export interface PublishHttpDecision {
  status: 201 | 409;
  body: {
    mode: "publish";
    summary: CampaignRunSummary;
    error?: string;
  };
}

/**
 * Return HTTP 201 only when every approved repository produced a complete,
 * internally consistent GitHub PR publication proof. All other outcomes keep
 * their structured evidence but fail closed at the HTTP boundary.
 */
export function buildPublishHttpDecision(
  summary: CampaignRunSummary,
  approvedPreflights: readonly ApprovedPublication[],
  approvedBy: string,
  sensitiveValues: readonly string[] = []
): PublishHttpDecision {
  const failures: string[] = [];
  const approved = new Map<string, ApprovedPublication>();
  const summaryKeys = Object.keys(summary).sort();
  if (
    summaryKeys.length !== 3 ||
    summaryKeys[0] !== "campaignId" ||
    summaryKeys[1] !== "results" ||
    summaryKeys[2] !== "total"
  ) {
    failures.push("summary contains unexpected fields");
  }

  for (const item of approvedPreflights) {
    const approvedSlug = safeRepositorySlug(item.slug);
    if (!approvedSlug) {
      failures.push("approval contains an invalid repository identity");
      continue;
    }
    const key = approvedSlug.toLowerCase();
    if (approved.has(key)) failures.push(`${approvedSlug}: duplicate approval entry`);
    else approved.set(key, { ...item, slug: approvedSlug });
  }

  if (approved.size === 0) failures.push("no approved repositories were recorded");
  if (summary.total !== summary.results.length) {
    failures.push(`summary declared ${summary.total} result(s) but included ${summary.results.length}`);
  }

  const resultsBySlug = new Map<string, CampaignResult[]>();
  for (const [index, result] of summary.results.entries()) {
    const resultSlug = safeRepositorySlug(result.slug);
    const resultLabel = resultSlug ?? `result ${index + 1}`;
    if (!hasOnlyKeys(result as unknown as Record<string, unknown>, [
      "slug",
      "status",
      "prUrl",
      "preflightId",
      "report",
      "publication",
      "error",
    ])) {
      failures.push(`${resultLabel}: result contains unexpected fields`);
    }
    const key = resultSlug?.toLowerCase() ?? `invalid-result-${index}`;
    const matches = resultsBySlug.get(key) ?? [];
    matches.push(result);
    resultsBySlug.set(key, matches);
    if (!approved.has(key)) failures.push(`${resultLabel}: result was not approved`);
  }

  let published = 0;
  for (const [key, approval] of approved) {
    const matches = resultsBySlug.get(key) ?? [];
    if (matches.length === 0) {
      failures.push(`${approval.slug}: publication result is missing`);
      continue;
    }
    if (matches.length > 1) {
      failures.push(`${approval.slug}: multiple publication results were returned`);
      continue;
    }
    const issue = publicationProofIssue(matches[0]!, approval, approvedBy);
    if (issue) failures.push(`${approval.slug}: ${issue}`);
    else published += 1;
  }

  const complete = failures.length === 0
    && published === approved.size
    && summary.results.length === approved.size;
  const safeSummary = safeCampaignSummary(summary, sensitiveValues);
  if (complete) {
    return { status: 201, body: { mode: "publish", summary: safeSummary } };
  }

  const prefix = published > 0
    ? `Publication partially completed: ${published} of ${approved.size} approved repositories returned verified PRs.`
    : `Publication did not complete: none of ${approved.size} approved repositories returned a verified PR.`;
  return {
    status: 409,
    body: {
      mode: "publish",
      error: redactText(
        `${prefix} ${failures.join("; ")}. Summary evidence is included.`,
        sensitiveValues
      ).slice(0, 10_000),
      summary: safeSummary,
    },
  };
}

function publicationProofIssue(
  result: CampaignResult,
  approval: ApprovedPublication,
  approvedBy: string
): string | null {
  if (result.status !== "pr_opened") {
    const status = safeRunStatus(result.status);
    return status === result.status ? `returned status ${status}` : "returned an invalid status";
  }
  if (!isMatchingGitHubPrUrl(result.prUrl, result.slug)) {
    return "pr_opened result is missing a matching GitHub PR URL";
  }

  const proof = result.publication;
  if (!proof) return "pr_opened result is missing publication proof";
  // These fields are present in the owner-authorization app contract. The
  // intersection keeps this console compatible while workspace declarations
  // are rebuilt in parallel with that package.
  const ownerProof = proof as typeof proof & {
    candidateTreeSha?: unknown;
    ownerAuthorizationReceipt?: unknown;
  };
  const missing: string[] = [];
  if (!hasExactKeys(proof as unknown as Record<string, unknown>, [
    "mode",
    "status",
    "preflightId",
    "baseBranch",
    "baseSha",
    "branch",
    "candidateTreeSha",
    "previewCompletedAt",
    "headSha",
    "artifactDigest",
    "blockers",
    "overridden",
    "approvedBy",
    "ownerAuthorizationReceipt",
  ])) {
    missing.push("no unexpected publication proof fields");
  }
  if (proof.mode !== "publish") missing.push("publish mode");
  if (proof.status !== "pr_opened") missing.push("publication status");
  if (!isPreflightId(approval.preflightId)
    || result.preflightId !== approval.preflightId
    || proof.preflightId !== approval.preflightId) {
    missing.push("approved preflight ID");
  }
  if (!isCommitId(proof.baseSha)) missing.push("base SHA");
  if (proof.previewCompletedAt !== approval.previewCompletedAt) {
    missing.push("approved preview completion time");
  }
  if (!isCommitId(ownerProof.candidateTreeSha) || ownerProof.candidateTreeSha !== approval.candidateTreeSha) {
    missing.push("approved candidate tree");
  }
  if (!isCommitId(proof.headSha)) missing.push("approved head SHA");
  if (
    !isArtifactDigest(proof.artifactDigest)
    || normalizeDigest(proof.artifactDigest) !== normalizeDigest(approval.artifactDigest)
  ) {
    missing.push("artifact digest");
  }
  if (!validBranch(proof.baseBranch)) missing.push("base branch");
  if (!validBranch(proof.branch)) missing.push("target branch");
  if (!validOperator(approvedBy) || proof.approvedBy !== approvedBy) missing.push("matching operator identity");
  if (!Array.isArray(proof.blockers) || proof.blockers.length !== 0) missing.push("zero publication blockers");
  if (proof.overridden !== false) missing.push("non-overridden publication");
  const ownerReceiptIssue = ownerAuthorizationReceiptIssue(
    ownerProof.ownerAuthorizationReceipt,
    result.slug,
    ownerProof,
    approval
  );
  if (ownerReceiptIssue) missing.push(ownerReceiptIssue);
  return missing.length > 0
    ? `pr_opened result has incomplete publication proof (${missing.join(", ")})`
    : null;
}

function ownerAuthorizationReceiptIssue(
  value: unknown,
  resultSlug: string,
  proof: NonNullable<CampaignResult["publication"]> & { candidateTreeSha?: unknown },
  approval: ApprovedPublication
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "owner authorization receipt";
  }
  const receipt = value as Record<string, unknown>;
  if (!hasExactKeys(receipt, [
    "authorizationId",
    "envelopeId",
    "envelopeDigest",
    "nonceDigest",
    "signerId",
    "keyId",
    "repositorySlug",
    "repositoryId",
    "baseSha",
    "preflightId",
    "artifactDigest",
    "manifestDigest",
    "candidateBranch",
    "candidateTreeSha",
    "expiresAt",
    "consumedAt",
  ])) {
    return "no unexpected owner authorization receipt fields";
  }
  const identifiers = ["authorizationId", "envelopeId", "signerId", "keyId"];
  if (identifiers.some((key) => !safeIdentifier(receipt[key]))) {
    return "valid owner authorization receipt identity";
  }
  if (
    !isDigest(receipt.envelopeDigest)
    || receipt.envelopeDigest !== approval.ownerAuthorizationDigest
    || !isDigest(receipt.nonceDigest)
    || !isDigest(receipt.manifestDigest)
    || receipt.manifestDigest !== approval.manifestDigest
  ) {
    return "matching owner authorization receipt digests";
  }
  if (
    safeRepositorySlug(receipt.repositorySlug)?.toLowerCase() !== resultSlug.toLowerCase()
    || !Number.isSafeInteger(receipt.repositoryId)
    || (receipt.repositoryId as number) <= 0
  ) {
    return "matching owner-authorized repository identity";
  }
  if (
    receipt.preflightId !== approval.preflightId
    || receipt.preflightId !== proof.preflightId
    || !isCommitId(receipt.baseSha)
    || receipt.baseSha !== proof.baseSha
    || !isDigest(receipt.artifactDigest)
    || normalizeDigest(receipt.artifactDigest) !== normalizeDigest(proof.artifactDigest)
    || !validBranch(receipt.candidateBranch)
    || receipt.candidateBranch !== proof.branch
    || !isCommitId(receipt.candidateTreeSha)
    || receipt.candidateTreeSha !== approval.candidateTreeSha
    || receipt.candidateTreeSha !== proof.candidateTreeSha
  ) {
    return "owner receipt bound to publication identity";
  }
  if (
    !Number.isSafeInteger(receipt.expiresAt)
    || !Number.isSafeInteger(receipt.consumedAt)
    || (receipt.expiresAt as number) <= 0
    || (receipt.consumedAt as number) <= 0
    || (receipt.consumedAt as number) >= (receipt.expiresAt as number)
  ) {
    return "valid owner authorization consumption time";
  }
  return null;
}

function isMatchingGitHubPrUrl(value: string | null, slug: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.hostname.toLowerCase() !== "github.com"
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return false;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const [owner, repo] = slug.split("/");
    return segments.length === 4
      && segments[0]?.toLowerCase() === owner?.toLowerCase()
      && segments[1]?.toLowerCase() === repo?.toLowerCase()
      && segments[2] === "pull"
      && /^[1-9]\d*$/.test(segments[3] ?? "");
  } catch {
    return false;
  }
}

function isPreflightId(value: unknown): value is string {
  return typeof value === "string" && /^pf_[a-f0-9]{64}$/.test(value);
}

function isCommitId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function isArtifactDigest(value: unknown): value is string {
  return typeof value === "string" && /^(?:sha256:)?[a-f0-9]{64}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function normalizeDigest(value: unknown): string | null {
  if (!isArtifactDigest(value)) return null;
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/.test(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const permitted = new Set(allowed);
  return Object.keys(record).every((key) => permitted.has(key));
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function safeCampaignSummary(
  summary: CampaignRunSummary,
  sensitiveValues: readonly string[]
): CampaignRunSummary {
  const safeCampaignId = safeIdentifier(summary.campaignId) ? summary.campaignId : "invalid-campaign";
  return {
    campaignId: safeCampaignId,
    total: Number.isSafeInteger(summary.total) && summary.total >= 0
      ? summary.total
      : summary.results.length,
    results: summary.results.map((result) => {
      const slug = safeRepositorySlug(result.slug) ?? "invalid/invalid";
      const status = safeRunStatus(result.status);
      const safe: CampaignResult = {
        slug,
        status,
        prUrl: isMatchingGitHubPrUrl(result.prUrl, slug) ? result.prUrl : null,
      };
      if (isPreflightId(result.preflightId)) safe.preflightId = result.preflightId;
      if (result.report !== undefined) {
        try {
          safe.report = redactJsonStrings(
            sanitizeMigrationReport(result.report),
            sensitiveValues
          );
        } catch {
          // A malformed upstream report is evidence of failure, but none of its
          // unvalidated values may cross this response boundary.
        }
      }
      if (result.error !== undefined) {
        safe.error = redactText(result.error, sensitiveValues).slice(0, 2_000);
      }
      if (result.publication !== undefined) {
        const publication = safePublicationOutcome(result.publication, sensitiveValues);
        if (publication) safe.publication = publication;
      }
      return safe;
    }),
  };
}

function safePublicationOutcome(
  proof: PublicationOutcome,
  sensitiveValues: readonly string[]
): PublicationOutcome | undefined {
  const record = proof as unknown as Record<string, unknown>;
  if (!hasOnlyKeys(record, [
    "mode",
    "status",
    "preflightId",
    "baseBranch",
    "baseSha",
    "branch",
    "candidateTreeSha",
    "previewCompletedAt",
    "headSha",
    "artifactDigest",
    "blockers",
    "overridden",
    "approvedBy",
    "ownerAuthorizationReceipt",
  ])) return undefined;
  if (
    (proof.mode !== "preview" && proof.mode !== "publish")
    || !safePublicationStatus(proof.status)
    || !isPreflightId(proof.preflightId)
    || !validBranch(proof.baseBranch)
    || !isCommitId(proof.baseSha)
    || !validBranch(proof.branch)
    || !isCommitId(proof.candidateTreeSha)
    || !Number.isSafeInteger(proof.previewCompletedAt)
    || proof.previewCompletedAt <= 0
    || !isArtifactDigest(proof.artifactDigest)
    || proof.overridden !== false
  ) return undefined;
  const blockers = safeBlockers(proof.blockers, sensitiveValues);
  if (!blockers) return undefined;
  if (proof.headSha !== undefined && !isCommitId(proof.headSha)) return undefined;
  if (proof.approvedBy !== undefined && !validOperator(proof.approvedBy)) return undefined;

  const safe: PublicationOutcome = {
    mode: proof.mode,
    status: proof.status,
    preflightId: proof.preflightId,
    baseBranch: proof.baseBranch,
    baseSha: proof.baseSha,
    branch: proof.branch,
    candidateTreeSha: proof.candidateTreeSha,
    previewCompletedAt: proof.previewCompletedAt,
    artifactDigest: proof.artifactDigest,
    blockers,
    overridden: proof.overridden,
  };
  if (proof.headSha !== undefined) safe.headSha = proof.headSha;
  if (proof.approvedBy !== undefined) safe.approvedBy = proof.approvedBy;
  if (proof.ownerAuthorizationReceipt !== undefined) {
    const receipt = safeOwnerAuthorizationReceipt(proof.ownerAuthorizationReceipt);
    if (receipt) safe.ownerAuthorizationReceipt = receipt;
  }
  return safe;
}

function safeOwnerAuthorizationReceipt(value: unknown): OwnerAuthorizationReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (!hasExactKeys(receipt, [
    "authorizationId",
    "envelopeId",
    "envelopeDigest",
    "nonceDigest",
    "signerId",
    "keyId",
    "repositorySlug",
    "repositoryId",
    "baseSha",
    "preflightId",
    "artifactDigest",
    "manifestDigest",
    "candidateBranch",
    "candidateTreeSha",
    "expiresAt",
    "consumedAt",
  ])) return undefined;
  const repositorySlug = safeRepositorySlug(receipt.repositorySlug);
  if (
    !safeIdentifier(receipt.authorizationId)
    || !safeIdentifier(receipt.envelopeId)
    || !isDigest(receipt.envelopeDigest)
    || !isDigest(receipt.nonceDigest)
    || !safeIdentifier(receipt.signerId)
    || !safeIdentifier(receipt.keyId)
    || !repositorySlug
    || !Number.isSafeInteger(receipt.repositoryId)
    || (receipt.repositoryId as number) <= 0
    || !isCommitId(receipt.baseSha)
    || !isPreflightId(receipt.preflightId)
    || !isDigest(receipt.artifactDigest)
    || !isDigest(receipt.manifestDigest)
    || !validBranch(receipt.candidateBranch)
    || !isCommitId(receipt.candidateTreeSha)
    || !Number.isSafeInteger(receipt.expiresAt)
    || !Number.isSafeInteger(receipt.consumedAt)
    || (receipt.consumedAt as number) <= 0
    || (receipt.consumedAt as number) >= (receipt.expiresAt as number)
  ) return undefined;
  return {
    authorizationId: receipt.authorizationId as string,
    envelopeId: receipt.envelopeId as string,
    envelopeDigest: receipt.envelopeDigest as string,
    nonceDigest: receipt.nonceDigest as string,
    signerId: receipt.signerId as string,
    keyId: receipt.keyId as string,
    repositorySlug,
    repositoryId: receipt.repositoryId as number,
    baseSha: receipt.baseSha as string,
    preflightId: receipt.preflightId as string,
    artifactDigest: receipt.artifactDigest as string,
    manifestDigest: receipt.manifestDigest as string,
    candidateBranch: receipt.candidateBranch as string,
    candidateTreeSha: receipt.candidateTreeSha as string,
    expiresAt: receipt.expiresAt as number,
    consumedAt: receipt.consumedAt as number,
  };
}

function safeBlockers(
  value: unknown,
  sensitiveValues: readonly string[]
): PublicationOutcome["blockers"] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const allowedCodes = new Set([
    "verification_skipped",
    "verification_failed",
    "manual_review_required",
  ]);
  const blockers: PublicationOutcome["blockers"] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const blocker = item as Record<string, unknown>;
    if (
      !hasExactKeys(blocker, ["code", "message"])
      || typeof blocker.code !== "string"
      || !allowedCodes.has(blocker.code)
      || typeof blocker.message !== "string"
    ) return undefined;
    blockers.push({
      code: blocker.code as PublicationOutcome["blockers"][number]["code"],
      message: redactText(blocker.message, sensitiveValues).slice(0, 2_000),
    });
  }
  return blockers;
}

function safeRepositorySlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return parseRepositorySlug(value).slug;
  } catch {
    return undefined;
  }
}

function validBranch(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return validateBranchName(value) === value;
  } catch {
    return false;
  }
}

function validOperator(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 100
    && /^[A-Za-z0-9][A-Za-z0-9_.@+-]*$/.test(value);
}

function safePublicationStatus(value: unknown): value is PublicationOutcome["status"] {
  return value === "preview_ready"
    || value === "blocked"
    || value === "pr_opened"
    || value === "no_changes";
}

function safeRunStatus(value: unknown): CampaignResult["status"] {
  const statuses = new Set([
    "queued",
    "scanning",
    "transforming",
    "verifying",
    "preview_ready",
    "blocked",
    "pr_opened",
    "merged",
    "failed",
    "no_changes",
  ]);
  return typeof value === "string" && statuses.has(value)
    ? value as CampaignResult["status"]
    : "failed";
}

function redactJsonStrings<T>(value: T, sensitiveValues: readonly string[]): T {
  if (typeof value === "string") {
    return redactText(value, sensitiveValues) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonStrings(item, sensitiveValues)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, redactJsonStrings(item, sensitiveValues)])
    ) as T;
  }
  return value;
}
