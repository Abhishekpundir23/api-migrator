import test from "node:test";
import assert from "node:assert/strict";
import type { MigrationReport, TypeError } from "@api-migrator/engine";
import { publicationBlockers } from "../src/publication.js";
import { sanitizeMigrationReport } from "../src/report.js";

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
