/** Safe application-boundary representation of an engine migration report. */

import type {
  CheckResult,
  MigrationReport,
  ReportEntry,
  TypeError,
  VerificationChecks,
} from "@api-migrator/engine";
import { redactText } from "./security.js";

const MAX_PATH = 4_096;
const MAX_LABEL = 500;
const MAX_MESSAGE = 2_000;
const MAX_NOTES = 8_000;
const MAX_COMMAND = 1_000;
const MAX_SCANNED_FILES = 10_000;
const MAX_ENTRIES = 10_000;
const MAX_ERRORS = 2_000;

/**
 * Remove raw subprocess output and raw compiler lines before a report can be
 * returned, persisted, rendered into a PR, or passed to an API response.
 * Structured status and diagnostic fields remain available to operators.
 */
export function sanitizeMigrationReport(report: MigrationReport): MigrationReport {
  return {
    manifest: {
      name: bounded(report.manifest.name, MAX_LABEL),
      provider: bounded(report.manifest.provider, MAX_LABEL),
      ...(report.manifest.notes === undefined
        ? {}
        : { notes: safeMessage(report.manifest.notes, MAX_NOTES) }),
    },
    scannedFiles: report.scannedFiles.slice(0, MAX_SCANNED_FILES).map(safePath),
    // This is the publication artifact inventory and intentionally remains
    // complete; filesystem path length supplies the per-item bound.
    changedFiles: report.changedFiles.map(safePath),
    entries: report.entries.slice(0, MAX_ENTRIES).map(sanitizeEntry),
    verification: {
      ok: report.verification.ok,
      baseline: report.verification.baseline.slice(0, MAX_ERRORS).map(sanitizeTypeError),
      after: report.verification.after.slice(0, MAX_ERRORS).map(sanitizeTypeError),
      introduced: report.verification.introduced.slice(0, MAX_ERRORS).map(sanitizeTypeError),
      skipped: report.verification.skipped,
      ...(report.verification.skipReason === undefined
        ? {}
        : { skipReason: safeMessage(report.verification.skipReason, MAX_MESSAGE) }),
      runner: bounded(report.verification.runner, MAX_LABEL),
      checks: sanitizeChecks(report.verification.checks),
    },
    summary: { ...report.summary },
  };
}

function sanitizeChecks(checks: VerificationChecks): VerificationChecks {
  return {
    install: sanitizeCheck(checks.install),
    typecheck: sanitizeCheck(checks.typecheck),
    ...(checks.repoTypecheck ? { repoTypecheck: sanitizeCheck(checks.repoTypecheck) } : {}),
    test: sanitizeCheck(checks.test),
    lint: sanitizeCheck(checks.lint),
  };
}

function sanitizeCheck(check: CheckResult): CheckResult {
  return {
    status: check.status,
    command: check.command === null ? null : safeMessage(check.command, MAX_COMMAND),
    exitCode: check.exitCode,
    // Raw repository-controlled stdout/stderr is deliberately discarded.
    output: "",
    ...(check.reason === undefined ? {} : { reason: safeMessage(check.reason, MAX_MESSAGE) }),
  };
}

function sanitizeTypeError(error: TypeError): TypeError {
  return {
    file: safePath(error.file),
    line: error.line,
    col: error.col,
    code: bounded(error.code, MAX_LABEL),
    message: safeMessage(error.message, MAX_MESSAGE),
    // Keep the engine type stable while ensuring the original compiler line
    // never crosses the app boundary.
    raw: "",
  };
}

function sanitizeEntry(entry: ReportEntry): ReportEntry {
  return {
    file: safePath(entry.file),
    kind: entry.kind,
    code: bounded(entry.code, MAX_LABEL),
    message: safeMessage(entry.message, MAX_MESSAGE),
    line: entry.line,
  };
}

function safePath(value: string): string {
  return bounded(value, MAX_PATH);
}

function safeMessage(value: string, maxLength: number): string {
  return bounded(redactText(value), maxLength);
}

function bounded(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}
