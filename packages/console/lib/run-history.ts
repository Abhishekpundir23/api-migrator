import {
  buildPreviewSourceEvidence,
  type PreviewSourceEvidenceView,
} from "./source-evidence";

const MAX_STORED_REPORT_BYTES = 1_048_576;

export interface HistoricalRunInput {
  repoSlug?: unknown;
  artifactDigest?: unknown;
  baseSha?: unknown;
  baseBranch?: unknown;
  headSha?: unknown;
  branch?: unknown;
  publicationBlockers?: unknown;
  report?: unknown;
}

export interface HistoricalRunEvidence {
  artifactDigest: string | null;
  baseSha: string | null;
  baseBranch: string | null;
  headSha: string | null;
  targetBranch: string | null;
  blockers: Array<{ code: string; message: string }>;
  blockerEvidence: "recorded" | "legacy" | "invalid";
  source: PreviewSourceEvidenceView;
  hasIdentity: boolean;
}

/** Build a bounded, secret-safe view of the audit fields stored with a run. */
export function buildHistoricalRunEvidence(run: HistoricalRunInput): HistoricalRunEvidence {
  const artifactDigest = safeText(run.artifactDigest, 240);
  const baseSha = safeText(run.baseSha, 240);
  const baseBranch = safeText(run.baseBranch, 240);
  const headSha = safeText(run.headSha, 240);
  const targetBranch = safeText(run.branch, 240);
  const parsed = parseBlockers(run.publicationBlockers);
  const source = parseStoredSourceEvidence(run.report, run.repoSlug);
  return {
    artifactDigest,
    baseSha,
    baseBranch,
    headSha,
    targetBranch,
    blockers: parsed.blockers,
    blockerEvidence: parsed.state,
    source,
    hasIdentity: Boolean(artifactDigest || baseSha || baseBranch || headSha),
  };
}

function parseStoredSourceEvidence(report: unknown, repoSlug: unknown): PreviewSourceEvidenceView {
  if (report === null || report === undefined) return buildPreviewSourceEvidence(undefined);
  if (typeof report !== "string" || report.length > MAX_STORED_REPORT_BYTES) {
    return buildPreviewSourceEvidence(null);
  }
  if (new TextEncoder().encode(report).byteLength > MAX_STORED_REPORT_BYTES) {
    return buildPreviewSourceEvidence(null);
  }
  try {
    const decoded: unknown = JSON.parse(report);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return buildPreviewSourceEvidence(null);
    }
    const record = decoded as Record<string, unknown>;
    return buildPreviewSourceEvidence(
      Object.hasOwn(record, "previewExecution") ? record.previewExecution : undefined,
      typeof repoSlug === "string" ? repoSlug : undefined
    );
  } catch {
    return buildPreviewSourceEvidence(null);
  }
}

export function shortAuditValue(value: string | null, visible = 12): string {
  if (!value) return "not recorded";
  if (value.length <= visible) return value;
  return `${value.slice(0, visible)}…`;
}

function parseBlockers(value: unknown): {
  blockers: HistoricalRunEvidence["blockers"];
  state: HistoricalRunEvidence["blockerEvidence"];
} {
  if (value === null || value === undefined) return { blockers: [], state: "legacy" };
  if (typeof value !== "string") return { blockers: [], state: "invalid" };
  try {
    const decoded: unknown = JSON.parse(value);
    if (!Array.isArray(decoded) || decoded.length > 100) return { blockers: [], state: "invalid" };
    const blockers = decoded.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const code = safeText(record.code, 100);
      const message = safeText(record.message, 1_000);
      return code && message ? [{ code, message }] : [];
    });
    if (blockers.length !== decoded.length) return { blockers: [], state: "invalid" };
    return { blockers, state: "recorded" };
  } catch {
    return { blockers: [], state: "invalid" };
  }
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /(\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]"
    )
    .replace(/([?&](?:token|password|secret|api[-_]?key|access[-_]?key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .trim();
  return clean ? clean.slice(0, maxLength) : null;
}
