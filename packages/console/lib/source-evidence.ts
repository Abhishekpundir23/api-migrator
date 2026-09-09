import {
  canonicalGitHubRepositorySlug,
  validateLocalPreviewExecution,
} from "@api-migrator/app/preview-evidence";

export interface PreviewSourceEvidenceView {
  status: "captured" | "unavailable" | "legacy" | "invalid";
  label:
    | "Local preview — not independently attested"
    | "Not recorded (legacy)"
    | "Invalid or unavailable";
  reason: string | null;
  sourceArchiveDigest: string | null;
  baseTreeSha: string | null;
  repositoryId: number | null;
  ownerId: number | null;
}

const EMPTY_FIELDS = {
  sourceArchiveDigest: null,
  baseTreeSha: null,
  repositoryId: null,
  ownerId: null,
} as const;

/** Convert strict browser-safe metadata into a non-authorizing display model. */
export function buildPreviewSourceEvidence(
  value: unknown,
  expectedRepositorySlug?: string
): PreviewSourceEvidenceView {
  if (value === undefined) {
    return {
      status: "legacy",
      label: "Not recorded (legacy)",
      reason: null,
      ...EMPTY_FIELDS,
    };
  }

  try {
    const execution = validateLocalPreviewExecution(value);
    if (execution.source === null) {
      return {
        status: "unavailable",
        label: "Local preview — not independently attested",
        reason: execution.unavailableReason === "repository_identity_unavailable"
          ? "Repository identity was unavailable during local preview."
          : "Source bundle identity was unavailable during local preview.",
        ...EMPTY_FIELDS,
      };
    }
    if (
      expectedRepositorySlug !== undefined &&
      canonicalGitHubRepositorySlug(execution.source.repository.slug) !==
        canonicalGitHubRepositorySlug(expectedRepositorySlug)
    ) {
      throw new Error("source repository does not match the displayed run");
    }
    return {
      status: "captured",
      label: "Local preview — not independently attested",
      reason: null,
      sourceArchiveDigest: execution.source.sourceArchiveDigest,
      baseTreeSha: execution.source.base.treeSha,
      repositoryId: execution.source.repository.id,
      ownerId: execution.source.repository.ownerId,
    };
  } catch {
    return {
      status: "invalid",
      label: "Invalid or unavailable",
      reason: "Source evidence is invalid or unavailable.",
      ...EMPTY_FIELDS,
    };
  }
}
