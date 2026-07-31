/**
 * Shared types for the migration engine.
 *
 * A migration runs against a single repository, applies zero or more
 * deterministic code transforms, and produces a structured Report. The Report
 * is the artifact a reviewer reads before opening a migration pull request.
 */

/** One entry in the structured report. */
export interface ReportEntry {
  /** Absolute or repo-relative file path the entry concerns. */
  file: string;
  /** "applied" = an automated transform changed code; "review" = needs a human. */
  kind: "applied" | "review";
  /** Transform/flag id, e.g. "T1", "F2". */
  code: string;
  /** Human-readable explanation, suitable for a PR body. */
  message: string;
  /** 1-based line where the change/flag is, if known. */
  line: number | null;
}

/** A sink the transform pushes report entries to. Keeps them in-process. */
export type ReportSink = {
  push(entry: ReportEntry): void;
};

export type { API, FileInfo } from "jscodeshift";
