export interface PreviewCheckInput {
  status?: unknown;
  command?: unknown;
  reason?: unknown;
  // Command output is intentionally not part of the view model.
  output?: unknown;
}

export interface PreviewEntryInput {
  file?: unknown;
  line?: unknown;
  kind?: unknown;
  code?: unknown;
  message?: unknown;
}

export interface PreviewVerificationInput {
  ok?: unknown;
  skipped?: unknown;
  skipReason?: unknown;
  runner?: unknown;
  checks?: unknown;
}

export interface PreviewResultInput {
  slug: string;
  status: string;
  prUrl?: string | null;
  error?: string;
  report?: {
    changedFiles?: unknown;
    entries?: unknown;
    summary?: {
      applied?: number;
      review?: number;
      changedFiles?: number;
      verified?: boolean | "skipped";
    };
    verification?: PreviewVerificationInput;
  };
  publication?: {
    artifactDigest?: unknown;
    baseBranch?: unknown;
    baseSha?: unknown;
    headSha?: unknown;
    branch?: unknown;
    blockers?: unknown;
  };
}

export interface PreviewEvidenceView {
  slug: string;
  status: string;
  publishable: boolean;
  prUrl: string | null;
  error: string | null;
  identity: {
    artifactDigest: string | null;
    baseBranch: string | null;
    baseSha: string | null;
    headSha: string | null;
    targetBranch: string | null;
  };
  changedFiles: string[];
  verification: {
    runner: string | null;
    outcome: "passed" | "failed" | "incomplete" | "unknown";
    reason: string | null;
    checks: Array<{
      key: string;
      label: string;
      status: "passed" | "failed" | "skipped" | "unknown";
      command: string | null;
      reason: string | null;
    }>;
  };
  reviewItems: Array<{
    file: string;
    line: number | null;
    code: string;
    message: string;
  }>;
  blockers: Array<{ code: string; message: string }>;
}

const CHECK_LABELS: Record<string, string> = {
  install: "Dependencies",
  typecheck: "TypeScript compiler",
  repoTypecheck: "Project type-check",
  test: "Tests",
  lint: "Lint",
};

/** Convert an API result into the exact, safe evidence the operator reviews. */
export function buildPreviewEvidence(result: PreviewResultInput): PreviewEvidenceView {
  const verification = result.report?.verification;
  const checks = asRecord(verification?.checks);
  const entries = Array.isArray(result.report?.entries) ? result.report.entries : [];
  const blockers = Array.isArray(result.publication?.blockers) ? result.publication.blockers : [];

  return {
    slug: safeText(result.slug, 220) ?? "Unknown repository",
    status: safeText(result.status, 80) ?? "unknown",
    publishable: result.status === "preview_ready",
    prUrl: safeHttpUrl(result.prUrl),
    error: safeText(result.error, 500),
    identity: {
      artifactDigest: safeText(result.publication?.artifactDigest, 240),
      baseBranch: safeText(result.publication?.baseBranch, 240),
      baseSha: safeText(result.publication?.baseSha, 240),
      headSha: safeText(result.publication?.headSha, 240),
      targetBranch: safeText(result.publication?.branch, 240),
    },
    changedFiles: stringList(result.report?.changedFiles, 1_000),
    verification: {
      runner: safeText(verification?.runner, 120),
      outcome: verificationOutcome(verification),
      reason: safeText(verification?.skipReason, 500),
      checks: Object.entries(checks).map(([key, raw]) => {
        const check = asRecord(raw) as PreviewCheckInput;
        return {
          key,
          label: CHECK_LABELS[key] ?? humanize(key),
          status: checkStatus(check.status),
          command: safeText(check.command, 300),
          reason: safeText(check.reason, 500),
        };
      }),
    },
    reviewItems: entries.flatMap((raw) => {
      const entry = asRecord(raw) as PreviewEntryInput;
      if (entry.kind !== "review") return [];
      return [{
        file: safeText(entry.file, 1_000) ?? "Unknown file",
        line: Number.isSafeInteger(entry.line) && (entry.line as number) > 0 ? entry.line as number : null,
        code: safeText(entry.code, 80) ?? "review",
        message: safeText(entry.message, 1_000) ?? "Manual review required",
      }];
    }),
    blockers: blockers.map((raw) => {
      const blocker = asRecord(raw);
      return {
        code: safeText(blocker.code, 100) ?? "blocked",
        message: safeText(blocker.message, 1_000) ?? "Publication is blocked",
      };
    }),
  };
}

function verificationOutcome(
  verification: PreviewVerificationInput | undefined
): PreviewEvidenceView["verification"]["outcome"] {
  if (!verification || typeof verification !== "object") return "unknown";
  if (verification.skipped === true) return "incomplete";
  if (verification.ok === true) return "passed";
  if (verification.ok === false) return "failed";
  return "unknown";
}

function checkStatus(value: unknown): "passed" | "failed" | "skipped" | "unknown" {
  return value === "passed" || value === "failed" || value === "skipped" ? value : "unknown";
}

function stringList(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const clean = safeText(item, maxLength);
    return clean ? [clean] : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /(\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /(\s--?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|client[-_]?secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]"
    )
    .replace(/([?&](?:token|password|secret|api[-_]?key|access[-_]?key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(https:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .trim();
  return clean ? clean.slice(0, maxLength) : null;
}

function humanize(value: string): string {
  const clean = value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "Check";
}
