import assert from "node:assert/strict";
import test from "node:test";
import {
  createOwnerChallengeReceipt,
  createPreviewReceipt,
  prepareOperatorApproval,
} from "../lib/approval";
import {
  credentialsFromEnv,
  isAuthorizedHeader,
  isLoopbackHostname,
} from "../lib/operator-auth";
import {
  HttpInputError,
  normalizeConcurrency,
  normalizeRepoSlugs,
  readLimitedJson,
} from "../lib/request";
import { formatRunSummary, parseRunSummary } from "../lib/summary";
import { buildPreviewEvidence } from "../lib/preview";
import { buildHistoricalRunEvidence, shortAuditValue } from "../lib/run-history";
import { RunBusyError, withOperatorApprovalRunLock, withRunLock } from "../lib/run-lock";
import { DEFAULT_INNGEST_MANIFEST_JSON } from "../lib/default-manifest";

test("operator credentials stay server-side and Basic headers are checked", () => {
  const credentials = credentialsFromEnv({
    OPERATOR_USERNAME: "pilot",
    OPERATOR_PASSWORD: "correct horse battery staple",
  });
  assert.ok(credentials);
  const valid = `Basic ${Buffer.from("pilot:correct horse battery staple").toString("base64")}`;
  const invalid = `Basic ${Buffer.from("pilot:wrong").toString("base64")}`;
  assert.equal(isAuthorizedHeader(valid, credentials), true);
  assert.equal(isAuthorizedHeader(invalid, credentials), false);
  assert.equal(isAuthorizedHeader(null, credentials), false);
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("example.com"), false);
});

test("repository and concurrency validation is bounded", () => {
  assert.deepEqual(
    normalizeRepoSlugs(["octo-org/example", "OCTO-ORG/EXAMPLE", "owner/repo.js"]),
    ["OCTO-ORG/EXAMPLE", "owner/repo.js"]
  );
  assert.throws(() => normalizeRepoSlugs(["owner/repo/extra"]), HttpInputError);
  assert.throws(() => normalizeRepoSlugs(["-owner/repo"]), HttpInputError);
  assert.equal(normalizeConcurrency(undefined), 1);
  assert.equal(normalizeConcurrency(2), 2);
  assert.throws(() => normalizeConcurrency(3), HttpInputError);
});

test("limited JSON reader rejects oversized and malformed requests", async () => {
  const request = new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.deepEqual(await readLimitedJson(request), { ok: true });

  await assert.rejects(
    () =>
      readLimitedJson(
        new Request("http://localhost/api", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        })
      ),
    (error: unknown) => error instanceof HttpInputError && error.status === 415
  );
});

test("a busy publication does not consume approval, but an acquired replay fails", async () => {
  const secret = "fedcba9876543210fedcba9876543210";
  const now = Date.now();
  const preview = createPreviewReceipt({
    campaignId: "3f88d980-d4ce-4fb7-b3cc-fdf3503b05d3",
    manifestJson: DEFAULT_INNGEST_MANIFEST_JSON,
    repository: {
      slug: "owner/locked-repo",
      preflightId: `pf_${"a".repeat(64)}`,
      artifactDigest: "b".repeat(64),
      candidateTreeSha: "c".repeat(40),
      previewCompletedAt: now - 1_000,
    },
    now,
    secret,
  });
  const challenge = createOwnerChallengeReceipt({
    previewReceipt: preview.previewReceipt,
    campaignId: "3f88d980-d4ce-4fb7-b3cc-fdf3503b05d3",
    manifestJson: DEFAULT_INNGEST_MANIFEST_JSON,
    ownerChallengeDigest: `sha256:${"d".repeat(64)}`,
    challengeExpiresAt: now + 5 * 60 * 1_000,
    now: now + 1,
    secret,
  });
  const approval = prepareOperatorApproval({
    previewReceipt: preview.previewReceipt,
    ownerChallengeReceipt: challenge.ownerChallengeReceipt,
    ownerAuthorizationEnvelope: '{"signed":"owner"}',
    campaignId: "3f88d980-d4ce-4fb7-b3cc-fdf3503b05d3",
    manifestJson: DEFAULT_INNGEST_MANIFEST_JSON,
    now: now + 1,
    secret,
  });

  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const held = withRunLock(async () => blocker);

  await assert.rejects(
    () => withOperatorApprovalRunLock(approval.operatorApprovalToken, approval.expiresAt, async () => "must not run"),
    RunBusyError
  );
  release();
  await held;

  let publications = 0;
  await withOperatorApprovalRunLock(approval.operatorApprovalToken, approval.expiresAt, async () => {
    publications += 1;
  });
  assert.equal(publications, 1);

  await assert.rejects(
    () => withOperatorApprovalRunLock(approval.operatorApprovalToken, approval.expiresAt, async () => {
      publications += 1;
    }),
    /already used/
  );
  assert.equal(publications, 1);
});

test("stored summaries are parsed rather than rendered as raw JSON", () => {
  const parsed = parseRunSummary(
    JSON.stringify({ applied: 3, review: 1, changedFiles: 2, introducedErrors: 0, verified: true })
  );
  assert.equal(formatRunSummary(parsed), "3 applied · 1 review · 2 files · verified");
  assert.equal(formatRunSummary(parseRunSummary("not-json")), "No structured summary");
});

test("preview evidence exposes reviewable identity and checks without command output or secrets", () => {
  const view = buildPreviewEvidence({
    slug: "owner/repo",
    status: "preview_ready",
    preflightId: `pf_${"f".repeat(64)}`,
    report: {
      changedFiles: ["package.json", "src/client.ts"],
      entries: [
        { kind: "applied", file: "src/client.ts", line: 4, code: "T1", message: "renamed method" },
        { kind: "review", file: "src/client.ts", line: 12, code: "F1", message: "confirm behavior" },
      ],
      verification: {
        ok: true,
        skipped: false,
        runner: "docker",
        checks: {
          install: {
            status: "passed",
            command: "npm install --token plain-secret-value API_TOKEN=another-secret",
            output: "must-not-reach-the-browser-view-model",
          },
          typecheck: { status: "passed", command: "tsc --noEmit" },
        },
      },
    },
    publication: {
      artifactDigest: `sha256:${"a".repeat(64)}`,
      baseBranch: "main",
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      branch: "api-migrator/inngest-v4",
      candidateTreeSha: "d".repeat(40),
      previewCompletedAt: 1_700_000_000_000,
      blockers: [{ code: "manual_review_required", message: "one item needs review" }],
    },
  });

  assert.equal(view.publishable, true);
  assert.equal(view.identity.preflightId, `pf_${"f".repeat(64)}`);
  assert.equal(view.identity.artifactDigest, `sha256:${"a".repeat(64)}`);
  assert.equal(view.identity.baseBranch, "main");
  assert.equal(view.identity.baseSha, "b".repeat(40));
  assert.equal(view.identity.headSha, "c".repeat(40));
  assert.equal(view.identity.candidateTreeSha, "d".repeat(40));
  assert.equal(view.identity.previewCompletedAt, 1_700_000_000_000);
  assert.deepEqual(view.changedFiles, ["package.json", "src/client.ts"]);
  assert.equal(view.verification.runner, "docker");
  assert.equal(view.verification.outcome, "passed");
  assert.equal(
    view.verification.checks[0]?.command,
    "npm install --token [REDACTED] API_TOKEN=[REDACTED]"
  );
  assert.equal(view.reviewItems[0]?.code, "F1");
  assert.equal(view.reviewItems[0]?.line, 12);
  assert.equal(view.blockers[0]?.code, "manual_review_required");
  assert.doesNotMatch(JSON.stringify(view), /must-not-reach|plain-secret-value|another-secret/);
});

test("preview evidence treats a missing artifact digest as unavailable and never publishable by inference", () => {
  const blocked = buildPreviewEvidence({
    slug: "owner/repo",
    status: "blocked",
    report: { verification: { ok: false, skipped: true, skipReason: "Docker unavailable" } },
  });
  assert.equal(blocked.publishable, false);
  assert.equal(blocked.identity.artifactDigest, null);
  assert.equal(blocked.verification.outcome, "incomplete");
  assert.equal(blocked.verification.reason, "Docker unavailable");
});

test("historical run evidence preserves exact identity and structured blockers safely", () => {
  const evidence = buildHistoricalRunEvidence({
    artifactDigest: "a".repeat(64),
    baseSha: "b".repeat(40),
    baseBranch: "main",
    headSha: "c".repeat(40),
    branch: "codex/api-migrator/inngest-v4",
    publicationBlockers: JSON.stringify([
      {
        code: "verification_failed",
        message: "Authorization: Bearer ghp_1234567890secret failed",
      },
    ]),
  });
  assert.equal(evidence.hasIdentity, true);
  assert.equal(evidence.artifactDigest, "a".repeat(64));
  assert.equal(evidence.baseSha, "b".repeat(40));
  assert.equal(evidence.headSha, "c".repeat(40));
  assert.equal(evidence.targetBranch, "codex/api-migrator/inngest-v4");
  assert.equal(evidence.blockerEvidence, "recorded");
  assert.equal(evidence.blockers[0]?.message, "Authorization: Bearer [REDACTED] failed");
  assert.equal(shortAuditValue(evidence.artifactDigest), `${"a".repeat(12)}…`);
});

test("historical run evidence distinguishes legacy and malformed blocker records", () => {
  const legacy = buildHistoricalRunEvidence({ branch: "legacy/branch", publicationBlockers: null });
  assert.equal(legacy.hasIdentity, false);
  assert.equal(legacy.blockerEvidence, "legacy");
  assert.deepEqual(legacy.blockers, []);

  const malformed = buildHistoricalRunEvidence({ publicationBlockers: "not-json" });
  assert.equal(malformed.blockerEvidence, "invalid");
  assert.deepEqual(malformed.blockers, []);
});
