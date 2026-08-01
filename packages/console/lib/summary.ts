export interface RunSummaryView {
  applied: number;
  review: number;
  changedFiles: number;
  introducedErrors: number;
  verified: boolean | "skipped";
}

export function parseRunSummary(raw: string | null | undefined): RunSummaryView | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object") return null;
    const verified = value.verified;
    if (verified !== true && verified !== false && verified !== "skipped") return null;
    return {
      applied: nonnegativeInteger(value.applied),
      review: nonnegativeInteger(value.review),
      changedFiles: nonnegativeInteger(value.changedFiles),
      introducedErrors: nonnegativeInteger(value.introducedErrors),
      verified,
    };
  } catch {
    return null;
  }
}

export function formatRunSummary(summary: RunSummaryView | null): string {
  if (!summary) return "No structured summary";
  const verification =
    summary.verified === "skipped" ? "verification skipped" : summary.verified ? "verified" : "verification failed";
  return `${summary.applied} applied · ${summary.review} review · ${summary.changedFiles} files · ${verification}`;
}

function nonnegativeInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}
