import test from "node:test";
import assert from "node:assert/strict";
import type { MigrationReport, TypeError } from "@api-migrator/engine";
import { publicationBlockers } from "../src/publication.js";
import { sanitizeMigrationReport } from "../src/report.js";

const previewExecution = {
  schemaVersion: 1,
  kind: "local-preview",
  source: {
    repository: { slug: "owner/repo", id: 123, ownerId: 456 },
    base: {
      branch: "main",
      sha: "a".repeat(40),
      treeSha: "b".repeat(40),
    },
    manifestDigest: `sha256:${"c".repeat(64)}`,
    sourceArchiveDigest: `sha256:${"d".repeat(64)}`,
  },
} as const;

test("app-boundary reports discard raw process text and redact structured messages", () => {
  const token = "ghp_repositorySecret123456";
  const diagnostic: TypeError = {
    file: "src/index.ts",
    line: 4,
    col: 2,
    code: "TS2322",
    message: "compiler detail password=hunter2",
    raw: `RAW TYPESCRIPT LOG ${token}`,
  };
  const report: MigrationReport = {
    manifest: {
      name: "Migration",
      provider: "provider",
      notes: "operator note api_key=provider-secret",
    },
    scannedFiles: ["src/index.ts"],
    changedFiles: ["src/index.ts"],
    entries: [{
      file: "src/index.ts",
      line: 4,
      kind: "review",
      code: "F1",
      message: "review token=entry-secret",
    }],
    verification: {
      ok: false,
      baseline: [diagnostic],
      after: [diagnostic],
      introduced: [diagnostic],
      skipped: true,
      skipReason: "runner unavailable token=skip-secret",
      runner: "docker",
      checks: {
        install: { status: "passed", command: "npm install", exitCode: 0, output: `INSTALL LOG ${token}` },
        typecheck: {
          status: "failed",
          command: `tsc --token=${token}`,
          exitCode: 1,
          output: `TYPECHECK LOG ${token}`,
          reason: "command failed client_secret=compiler-secret",
        },
        test: { status: "passed", command: "npm test", exitCode: 0, output: "RAW TEST LOG" },
        lint: { status: "passed", command: "npm lint", exitCode: 0, output: "RAW LINT LOG" },
        runtime: {
          status: "failed",
          command: "runtime-attest node22-bookworm-slim-2026-07",
          exitCode: 1,
          output: `RAW RUNTIME LOG ${token}`,
          reason: "runtime mismatch token=runtime-secret",
        },
      },
    },
    summary: { applied: 0, review: 1, changedFiles: 1, introducedErrors: 1, verified: "skipped" },
  };

  const safe = sanitizeMigrationReport(report);
  for (const kind of ["long-running", "serverless"] as const) {
    const declared = { ...report, manifest: { ...report.manifest, deployment: { kind, extra: "discard" } } };
    assert.deepEqual(sanitizeMigrationReport(declared).manifest.deployment, { kind });
  }
  assert.equal(safe.manifest.deployment, undefined);
  assert.equal(sanitizeMigrationReport({ ...report, manifest: {
    ...report.manifest, deployment: { kind: "docker" },
  } } as unknown as MigrationReport).manifest.deployment, undefined);
  const serializedResult = JSON.stringify({
    report: safe,
    changed: true,
    preflightId: `pf_${"a".repeat(64)}`,
    artifactDigest: "b".repeat(64),
    publication: { blockers: publicationBlockers(safe) },
  });

  for (const secretOrLog of [
    token,
    "hunter2",
    "provider-secret",
    "entry-secret",
    "compiler-secret",
    "skip-secret",
    "INSTALL LOG",
    "TYPECHECK LOG",
    "RAW TEST LOG",
    "RAW LINT LOG",
    "RAW RUNTIME LOG",
    "runtime-secret",
    "RAW TYPESCRIPT LOG",
  ]) {
    assert.equal(serializedResult.includes(secretOrLog), false, `${secretOrLog} escaped the report boundary`);
  }
  assert.equal(safe.verification.checks.typecheck.status, "failed");
  assert.equal(safe.verification.checks.typecheck.exitCode, 1);
  assert.match(safe.verification.checks.typecheck.command ?? "", /\[REDACTED\]/);
  assert.match(safe.verification.checks.typecheck.reason ?? "", /\[REDACTED\]/);
  assert.equal(safe.verification.checks.typecheck.output, "");
  assert.equal(safe.verification.checks.runtime?.status, "failed");
  assert.equal(safe.verification.checks.runtime?.output, "");
  assert.match(safe.verification.checks.runtime?.reason ?? "", /\[REDACTED\]/);
  assert.equal(safe.verification.introduced[0]?.raw, "");
  assert.match(safe.verification.introduced[0]?.message ?? "", /\[REDACTED\]/);
  assert.equal(report.verification.checks.typecheck.output.includes("TYPECHECK LOG"), true);
});

test("app-boundary reports preserve only detached valid local preview evidence", () => {
  const report: MigrationReport = {
    manifest: { name: "Migration", provider: "provider" },
    scannedFiles: [],
    changedFiles: [],
    entries: [],
    verification: {
      ok: true,
      baseline: [],
      after: [],
      introduced: [],
      skipped: false,
      runner: "test",
      checks: {
        install: { status: "passed", command: null, exitCode: 0, output: "" },
        typecheck: { status: "passed", command: null, exitCode: 0, output: "" },
        test: { status: "passed", command: null, exitCode: 0, output: "" },
        lint: { status: "passed", command: null, exitCode: 0, output: "" },
      },
    },
    summary: { applied: 0, review: 0, changedFiles: 0, introducedErrors: 0, verified: true },
  };

  const supplied = structuredClone(previewExecution);
  const safe = sanitizeMigrationReport({ ...report, previewExecution: supplied });
  assert.deepEqual(safe.previewExecution, previewExecution);
  assert.notEqual(safe.previewExecution, supplied);
  assert.notEqual(safe.previewExecution?.source, supplied.source);
  assert.equal("previewExecution" in sanitizeMigrationReport(report), false);
  assert.throws(
    () => sanitizeMigrationReport({
      ...report,
      previewExecution: { ...previewExecution, extra: "discarding this would hide invalid history" },
    }),
    /local preview/i
  );
});
