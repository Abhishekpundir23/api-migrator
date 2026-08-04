import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";
import {
  canonicalJson,
  type PublicationRunnerOutput,
  type PublicationRunnerPlanRecord,
} from "@api-migrator/app/runner-internal";
import type { CheckResult, MigrationReport } from "@api-migrator/engine";
import type { DependencyStateRecord } from "./dependency-state.js";
import { sha256 } from "./filesystem.js";

export const RUNNER_EVIDENCE_KIND = "api-migrator-runner-evidence-v1" as const;
export const MAX_RUNNER_EVIDENCE_BYTES = 98_304;

export interface SafeRunnerCheck {
  status: "passed";
  command: string;
  exitCode: 0;
  reason?: string;
}

export interface RunnerEvidenceV1 {
  schemaVersion: 1;
  kind: typeof RUNNER_EVIDENCE_KIND;
  profile: "disposable-egress-filtered-pilot-v1";
  planDigest: string;
  jobId: string;
  sourceArchiveDigest: string;
  manifestDigest: string;
  commandScopeDigest: string;
  dependencyStateDigest: string;
  outputTreeDigest: string;
  output: PublicationRunnerOutput;
  targetBranch: string;
  checks: {
    install: SafeRunnerCheck;
    typecheck: SafeRunnerCheck;
    test: SafeRunnerCheck;
    lint: SafeRunnerCheck;
    runtime: SafeRunnerCheck;
  };
  report: MigrationReport;
  reportDigest: string;
  blockers: Array<{ code: string; message: string }>;
}

export interface RunnerEvidenceRecord {
  evidence: Readonly<RunnerEvidenceV1>;
  canonicalJson: string;
  digest: string;
}

export function createRunnerEvidence(input: {
  plan: PublicationRunnerPlanRecord;
  dependencyState: DependencyStateRecord;
  outputTreeDigest: string;
  output: PublicationRunnerOutput;
  targetBranch: string;
  report: MigrationReport;
  blockers: Array<{ code: string; message: string }>;
}): RunnerEvidenceRecord {
  if (input.blockers.length > 0) {
    throw new Error("Runner evidence cannot be emitted for a blocked publication");
  }
  const checks = input.report.verification.checks;
  if (!checks.runtime) throw new Error("Runner runtime check is missing");
  const evidence: RunnerEvidenceV1 = {
    schemaVersion: 1,
    kind: RUNNER_EVIDENCE_KIND,
    profile: input.plan.plan.profile,
    planDigest: input.plan.digest,
    jobId: input.plan.plan.job.id,
    sourceArchiveDigest: input.plan.plan.inputs.sourceArchiveDigest,
    manifestDigest: input.plan.plan.inputs.manifestDigest,
    commandScopeDigest: input.plan.plan.inputs.commandScopeDigest,
    dependencyStateDigest: input.dependencyState.digest,
    outputTreeDigest: input.outputTreeDigest,
    output: input.output,
    targetBranch: input.targetBranch,
    checks: {
      install: passedCheck(checks.install, "install"),
      typecheck: passedCheck(checks.typecheck, "typecheck"),
      test: passedCheck(checks.test, "test"),
      lint: passedCheck(checks.lint, "lint"),
      runtime: passedCheck(checks.runtime, "runtime"),
    },
    report: input.report,
    reportDigest: sha256(canonicalJson(input.report)),
    blockers: input.blockers.map((blocker) => ({ code: blocker.code, message: blocker.message })),
  };
  const text = canonicalJson(evidence);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes === 0 || bytes > MAX_RUNNER_EVIDENCE_BYTES) {
    throw new Error("Runner evidence exceeds its byte limit");
  }
  return Object.freeze({
    evidence: deepFreeze(evidence),
    canonicalJson: text,
    digest: sha256(text),
  });
}

export function writeRunnerEvidence(path: string, record: RunnerEvidenceRecord): void {
  const bytes = Buffer.from(record.canonicalJson, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_RUNNER_EVIDENCE_BYTES) {
    throw new Error("Runner evidence exceeds its byte limit");
  }
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function passedCheck(check: CheckResult, label: string): SafeRunnerCheck {
  if (check.status !== "passed" || check.exitCode !== 0 || typeof check.command !== "string") {
    throw new Error(`Runner ${label} check did not pass`);
  }
  return {
    status: "passed",
    command: check.command,
    exitCode: 0,
    ...(check.reason === undefined ? {} : { reason: check.reason }),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
