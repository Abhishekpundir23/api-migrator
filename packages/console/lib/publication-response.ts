import type { CampaignRunSummary } from "@api-migrator/app";

type CampaignResult = CampaignRunSummary["results"][number];

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
  approvedPreflights: readonly { slug: string; preflightId: string }[],
  approvedBy: string
): PublishHttpDecision {
  const failures: string[] = [];
  const approved = new Map<string, { slug: string; preflightId: string }>();

  for (const item of approvedPreflights) {
    const key = item.slug.toLowerCase();
    if (approved.has(key)) failures.push(`${item.slug}: duplicate approval entry`);
    else approved.set(key, item);
  }

  if (approved.size === 0) failures.push("no approved repositories were recorded");
  if (summary.total !== summary.results.length) {
    failures.push(`summary declared ${summary.total} result(s) but included ${summary.results.length}`);
  }

  const resultsBySlug = new Map<string, CampaignResult[]>();
  for (const result of summary.results) {
    const key = result.slug.toLowerCase();
    const matches = resultsBySlug.get(key) ?? [];
    matches.push(result);
    resultsBySlug.set(key, matches);
    if (!approved.has(key)) failures.push(`${result.slug}: result was not approved`);
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
    const issue = publicationProofIssue(matches[0]!, approval.preflightId, approvedBy);
    if (issue) failures.push(`${approval.slug}: ${issue}`);
    else published += 1;
  }

  const complete = failures.length === 0
    && published === approved.size
    && summary.results.length === approved.size;
  if (complete) {
    return { status: 201, body: { mode: "publish", summary } };
  }

  const prefix = published > 0
    ? `Publication partially completed: ${published} of ${approved.size} approved repositories returned verified PRs.`
    : `Publication did not complete: none of ${approved.size} approved repositories returned a verified PR.`;
  return {
    status: 409,
    body: {
      mode: "publish",
      error: `${prefix} ${failures.join("; ")}. Summary evidence is included.`,
      summary,
    },
  };
}

function publicationProofIssue(
  result: CampaignResult,
  approvedPreflightId: string,
  approvedBy: string
): string | null {
  if (result.status !== "pr_opened") return `returned status ${result.status}`;
  if (!isMatchingGitHubPrUrl(result.prUrl, result.slug)) {
    return "pr_opened result is missing a matching GitHub PR URL";
  }

  const proof = result.publication;
  if (!proof) return "pr_opened result is missing publication proof";
  const missing: string[] = [];
  if (proof.mode !== "publish") missing.push("publish mode");
  if (proof.status !== "pr_opened") missing.push("publication status");
  if (!isPreflightId(approvedPreflightId)
    || result.preflightId !== approvedPreflightId
    || proof.preflightId !== approvedPreflightId) {
    missing.push("approved preflight ID");
  }
  if (!isCommitId(proof.baseSha)) missing.push("base SHA");
  if (!isCommitId(proof.headSha)) missing.push("approved head SHA");
  if (!isArtifactDigest(proof.artifactDigest)) missing.push("artifact digest");
  if (!nonEmpty(proof.baseBranch)) missing.push("base branch");
  if (!nonEmpty(proof.branch)) missing.push("target branch");
  if (!nonEmpty(approvedBy) || proof.approvedBy !== approvedBy) missing.push("matching operator identity");
  if (!Array.isArray(proof.blockers) || proof.blockers.length !== 0) missing.push("zero publication blockers");
  if (proof.overridden !== false) missing.push("non-overridden publication");
  return missing.length > 0
    ? `pr_opened result has incomplete publication proof (${missing.join(", ")})`
    : null;
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
  return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
}

function isArtifactDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
