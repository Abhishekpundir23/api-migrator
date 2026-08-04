import test from "node:test";
import assert from "node:assert/strict";
import {
  closeDb,
  createCampaign,
  createProvider,
  createRun,
  getDb,
  getRun,
  migrate,
  upsertRepo,
} from "@api-migrator/db";
import type { Manifest, MigrationReport } from "@api-migrator/engine";
import type { AuthResult } from "../src/auth.js";
import {
  assertPublicationAllowed,
  assertRemoteBranchMatchesArtifact,
  createNoChangesOutcome,
  createPreflightId,
  PublicationAttemptError,
  publicationBlockers,
  type PublicationAttemptAudit,
  validatePublicationRequest,
} from "../src/publication.js";
import {
  inspectRemotePublicationState,
  publicationPushArgs,
  publicationRequiresAuthentication,
  reconcilePr,
  reconcilePrWithAudit,
} from "../src/github.js";
import { buildFailedRunPatch, persistFailedRun } from "../src/campaign/runner.js";
import { runCampaignJobs, type MigrationJob } from "../src/queue.js";
import { parseRepositorySlug } from "../src/repository.js";

const manifest: Manifest = {
  name: "Inngest v3 to v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  runtime: { node: { minimumMajor: 20, profile: "node22-bookworm-slim-2026-07", packageJson: "package.json", dockerfile: "Dockerfile" } },
  package: { name: "inngest", from: "^3", to: "^4" },
  peerFloors: [],
};

const PREVIEW_COMPLETED_AT = 2_000_000_000_000;
const OWNER_ENVELOPE = "{}";
const OWNER_CHALLENGE_DIGEST = `sha256:${"f".repeat(64)}`;

function publishRequest(preflightId = `pf_${"a".repeat(64)}`) {
  return {
    mode: "publish" as const,
    approvedBy: "operator@example.com",
    preflightId,
    previewCompletedAt: PREVIEW_COMPLETED_AT,
    ownerAuthorizationEnvelope: OWNER_ENVELOPE,
    ownerChallengeDigest: OWNER_CHALLENGE_DIGEST,
  };
}

const ownerAuthorizationReceipt = {
  authorizationId: "authorization-test",
  envelopeId: "envelope-test",
  envelopeDigest: `sha256:${"1".repeat(64)}`,
  nonceDigest: `sha256:${"2".repeat(64)}`,
  signerId: "owner-test",
  keyId: "owner-key-test",
  repositorySlug: "owner/repo",
  repositoryId: 123,
  baseSha: "c".repeat(40),
  preflightId: `pf_${"a".repeat(64)}`,
  artifactDigest: `sha256:${"b".repeat(64)}`,
  manifestDigest: `sha256:${"3".repeat(64)}`,
  candidateBranch: "codex/api-migrator/inngest-post-push",
  candidateTreeSha: "e".repeat(40),
  expiresAt: PREVIEW_COMPLETED_AT + 60_000,
  consumedAt: PREVIEW_COMPLETED_AT + 1_000,
};

function report(options: { skipped?: boolean; ok?: boolean; review?: boolean } = {}): MigrationReport {
  const skipped = options.skipped ?? false;
  const ok = options.ok ?? true;
  const entries = options.review
    ? [{ file: "src/a.ts", kind: "review" as const, code: "F1", message: "decide", line: 1 }]
    : [];
  return {
    manifest: { name: manifest.name, provider: manifest.provider },
    scannedFiles: ["src/a.ts"],
    changedFiles: ["src/a.ts"],
    entries,
    verification: {
      ok,
      baseline: [],
      after: [],
      introduced: ok ? [] : [{ file: "src/a.ts", line: 1, col: 1, code: "TS1", message: "bad", raw: "bad" }],
      skipped,
      ...(skipped ? { skipReason: "runner unavailable" } : {}),
      runner: "test",
      checks: {
        install: { status: "passed", command: "install", exitCode: 0, output: "" },
        typecheck: { status: ok ? "passed" : "failed", command: "tsc", exitCode: ok ? 0 : 1, output: "" },
        test: { status: "passed", command: "test", exitCode: 0, output: "" },
        lint: { status: "passed", command: "lint", exitCode: 0, output: "" },
        runtime: { status: "passed", command: "runtime-attest", exitCode: 0, output: "", reason: "Node 22" },
      },
    },
    summary: {
      applied: 1,
      review: entries.length,
      changedFiles: 1,
      introducedErrors: ok ? 0 : 1,
      verified: skipped ? "skipped" : ok,
    },
  } as MigrationReport;
}

test("preview is the default publication mode", () => {
  assert.deepEqual(validatePublicationRequest(undefined), { mode: "preview" });
  assert.equal(publicationRequiresAuthentication({ mode: "preview" }), false);
  assert.equal(publicationRequiresAuthentication({
    ...publishRequest(),
  }), true);
});

test("verification and unresolved review items block publication", () => {
  assert.deepEqual(publicationBlockers(report()), []);
  assert.deepEqual(publicationBlockers(report({ skipped: true })).map((b) => b.code), ["verification_skipped"]);
  assert.deepEqual(publicationBlockers(report({ ok: false })).map((b) => b.code), ["verification_failed"]);
  assert.deepEqual(publicationBlockers(report({ review: true })).map((b) => b.code), ["manual_review_required"]);

  const boundedView = report();
  boundedView.summary.review = 10_001;
  boundedView.entries = [];
  assert.deepEqual(publicationBlockers(boundedView), [{
    code: "manual_review_required",
    message: "10001 unresolved item(s) require manual review",
  }]);

  const f12Only = report({ review: true });
  f12Only.entries = [{
    file: "(migration)",
    kind: "review",
    code: "F12",
    message: "The runtime container is unknown; determine whether this is serverless.",
    line: null,
  }];
  assert.equal(f12Only.verification.ok, true);
  assert.equal(f12Only.summary.verified, true);
  assert.deepEqual(publicationBlockers(f12Only), [{
    code: "manual_review_required",
    message: "1 unresolved item(s) require manual review",
  }]);

  const failedWithF12 = report({ ok: false, review: true });
  failedWithF12.entries = f12Only.entries;
  assert.deepEqual(
    publicationBlockers(failedWithF12).map((blocker) => blocker.code),
    ["verification_failed", "manual_review_required"]
  );
});

test("preflight ids bind repository, base commit, manifest, and report", () => {
  const input = {
    slug: "owner/repo",
    baseBranch: "main",
    baseSha: "a".repeat(40),
    targetBranch: "codex/api-migrator/inngest-abc",
    candidateTreeSha: "b".repeat(40),
    artifactDigest: "c".repeat(64),
    manifest,
    report: report(),
  };
  const first = createPreflightId(input);
  assert.match(first, /^pf_[a-f0-9]{64}$/);
  assert.equal(first, createPreflightId(input));
  const noisy = report();
  noisy.verification.checks.install.output = "different non-deterministic timing output";
  assert.equal(first, createPreflightId({ ...input, report: noisy }));
  assert.notEqual(first, createPreflightId({ ...input, baseSha: "b".repeat(40) }));
  assert.notEqual(first, createPreflightId({ ...input, targetBranch: "codex/api-migrator/inngest-def" }));
  assert.notEqual(first, createPreflightId({ ...input, candidateTreeSha: "d".repeat(40) }));
  assert.notEqual(first, createPreflightId({ ...input, artifactDigest: "d".repeat(64) }));
  const changedRuntime = report();
  changedRuntime.verification.checks.runtime = {
    status: "failed",
    command: "runtime-attest",
    exitCode: 1,
    output: "",
    reason: "Node 18",
  };
  assert.notEqual(first, createPreflightId({ ...input, report: changedRuntime }));
});

test("publish approval must match the exact preview and no blocker is overrideable", () => {
  const preflightId = `pf_${"a".repeat(64)}`;
  const blocker = [{ code: "manual_review_required" as const, message: "1 item requires review" }];
  const normal = validatePublicationRequest(publishRequest(preflightId));
  assert.deepEqual(
    assertPublicationAllowed(normal as Extract<typeof normal, { mode: "publish" }>, preflightId, []),
    { overridden: false }
  );
  assert.throws(() => assertPublicationAllowed(normal as Extract<typeof normal, { mode: "publish" }>, preflightId, blocker), /blocked/);
  assert.throws(
    () => assertPublicationAllowed(normal as Extract<typeof normal, { mode: "publish" }>, `pf_${"b".repeat(64)}`, blocker),
    /stale/
  );
  assert.throws(
    () => validatePublicationRequest({ ...publishRequest(preflightId), overrideUnsafe: true } as never),
    /unknown or unsupported/
  );
});

test("a stale publish preflight cannot become a successful no-change result", () => {
  const currentPreflightId = `pf_${"b".repeat(64)}`;
  const identity = {
    preflightId: currentPreflightId,
    baseBranch: "main",
    baseSha: "c".repeat(40),
    branch: "codex/api-migrator/inngest-current",
    candidateTreeSha: "e".repeat(40),
    previewCompletedAt: PREVIEW_COMPLETED_AT,
    artifactDigest: "d".repeat(64),
    blockers: [],
  };

  const preview = createNoChangesOutcome({ mode: "preview" }, identity);
  assert.equal(preview.status, "no_changes");
  assert.equal(preview.mode, "preview");
  assert.equal("approvedBy" in preview, false);

  assert.throws(
    () => createNoChangesOutcome({
      ...publishRequest(`pf_${"a".repeat(64)}`),
    }, identity),
    /stale/
  );

  const valid = createNoChangesOutcome({
    ...publishRequest(currentPreflightId),
  }, identity);
  assert.equal(valid.status, "no_changes");
  assert.equal(valid.approvedBy, "operator@example.com");
});

test("the non-durable job queue rejects publishing before starting the batch", async () => {
  const publishJob = {
    id: "unsafe-publish",
    slug: "owner/repo",
    manifest,
    publication: {
      mode: "publish",
      approvedBy: "operator",
      preflightId: `pf_${"a".repeat(64)}`,
    },
  } as unknown as MigrationJob;

  await assert.rejects(
    () => runCampaignJobs([publishJob]),
    /DB-backed console workflow/
  );

  const challengeJob = {
    id: "unsafe-challenge",
    slug: "owner/repo",
    manifest,
    ownerChallenge: {
      preflightId: `pf_${"a".repeat(64)}`,
      artifactDigest: "b".repeat(64),
      candidateTreeSha: "c".repeat(40),
      previewCompletedAt: Date.now(),
      previewReceiptExpiresAt: Date.now() + 60_000,
    },
  } as unknown as MigrationJob;
  await assert.rejects(
    () => runCampaignJobs([challengeJob]),
    /DB-backed console workflow/
  );

  const attestationJob = {
    id: "unsafe-runner-attestation",
    slug: "owner/repo",
    manifest,
    runnerAttestation: { payloadDigest: `sha256:${"d".repeat(64)}` },
  } as unknown as MigrationJob;
  await assert.rejects(
    () => runCampaignJobs([attestationJob]),
    /runner-attestation capabilities require the DB-backed console workflow/
  );
});

test("malformed operator approvals and unsupported fields fail closed", () => {
  const preflightId = `pf_${"a".repeat(64)}`;
  assert.throws(
    () => validatePublicationRequest({ ...publishRequest(preflightId), approvedBy: "" }),
    /operator identity/
  );
  assert.throws(
    () => validatePublicationRequest({ ...publishRequest(preflightId), previewCompletedAt: 0 }),
    /preview completion/
  );
  assert.throws(
    () => validatePublicationRequest({ ...publishRequest(preflightId), ownerAuthorizationEnvelope: "" }),
    /bounded signed owner authorization/
  );
  assert.throws(
    () => validatePublicationRequest({ ...publishRequest(preflightId), ownerChallengeDigest: "" }),
    /issued owner challenge digest/
  );
  const exact = "{\"version\":1}\n";
  const request = validatePublicationRequest({
    ...publishRequest(preflightId),
    ownerAuthorizationEnvelope: exact,
  });
  assert.equal(request.mode === "publish" && request.ownerAuthorizationEnvelope, exact);
});

test("verification failures are absolute", () => {
  const preflightId = `pf_${"a".repeat(64)}`;
  const approval = validatePublicationRequest(publishRequest(preflightId));
  assert.throws(
    () => assertPublicationAllowed(
      approval as Extract<typeof approval, { mode: "publish" }>,
      preflightId,
      [{ code: "verification_failed", message: "tests failed" }]
    ),
    /Publication blocked/
  );
});

test("an existing migration branch is reusable only for the exact tree and base parent", () => {
  const remoteSha = "a".repeat(40);
  const exact = {
    expectedBaseSha: "b".repeat(40),
    expectedTreeSha: "c".repeat(40),
    remoteCommitSha: remoteSha,
    remoteParentShas: ["b".repeat(40)],
    remoteTreeSha: "c".repeat(40),
  };
  assert.doesNotThrow(() => assertRemoteBranchMatchesArtifact(remoteSha, exact));
  assert.throws(
    () => assertRemoteBranchMatchesArtifact(remoteSha, { ...exact, remoteTreeSha: "d".repeat(40) }),
    /does not match the approved artifact and base/
  );
  assert.throws(
    () => assertRemoteBranchMatchesArtifact(remoteSha, {
      ...exact,
      remoteParentShas: ["b".repeat(40), "e".repeat(40)],
    }),
    /does not match the approved artifact and base/
  );
  const exactSha256 = {
    expectedBaseSha: "b".repeat(64),
    expectedTreeSha: "c".repeat(64),
    remoteCommitSha: "a".repeat(64),
    remoteParentShas: ["b".repeat(64)],
    remoteTreeSha: "c".repeat(64),
  };
  assert.doesNotThrow(() => assertRemoteBranchMatchesArtifact("a".repeat(64), exactSha256));
  for (const length of [39, 41, 63, 65]) {
    assert.throws(
      () => assertRemoteBranchMatchesArtifact("a".repeat(length), exact),
      /invalid remote branch commit id/
    );
    assert.throws(
      () => assertRemoteBranchMatchesArtifact(remoteSha, {
        ...exact,
        remoteTreeSha: "c".repeat(length),
      }),
      /invalid commit recovery metadata/
    );
  }
});

test("PR reconciliation rejects intermediate-length Git object ids before an API write", async () => {
  const repository = parseRepositorySlug("owner/repo");
  let writes = 0;
  const auth = {
    token: "secret-token",
    actor: "api-migrator[bot]",
    mode: "github-app",
    octokit: {
      pulls: {
        create: async () => {
          writes += 1;
          throw new Error("must not be reached");
        },
        update: async () => {
          writes += 1;
          throw new Error("must not be reached");
        },
      },
    },
  } as unknown as AuthResult;

  for (const length of [41, 63]) {
    await assert.rejects(
      reconcilePr(
        auth,
        repository,
        "codex/api-migrator/inngest-abc",
        "main",
        "Migration",
        "Evidence",
        null,
        "a".repeat(length),
        "b".repeat(40)
      ),
      /Invalid expected migration commit id/
    );
    await assert.rejects(
      reconcilePr(
        auth,
        repository,
        "codex/api-migrator/inngest-abc",
        "main",
        "Migration",
        "Evidence",
        null,
        "a".repeat(40),
        "b".repeat(length)
      ),
      /Invalid expected base commit id/
    );
  }
  assert.equal(writes, 0);
});

test("new immutable branch pushes require the remote ref to remain absent", () => {
  const repository = parseRepositorySlug("owner/repo");
  const branch = "codex/api-migrator/inngest-abc";
  assert.deepEqual(publicationPushArgs(repository, branch), [
    "push",
    `--force-with-lease=refs/heads/${branch}:`,
    "https://github.com/owner/repo.git",
    `HEAD:refs/heads/${branch}`,
  ]);
});

test("an identical immutable remote branch skips push and reuses the matching PR", async () => {
  const repository = parseRepositorySlug("owner/repo");
  const calls: string[] = [];
  const auth = {
    token: "secret-token",
    actor: "api-migrator[bot]",
    mode: "github-app",
    octokit: {
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          calls.push(`getRef:${ref}`);
          return { data: { object: { sha: ref === "heads/main" ? "d".repeat(40) : "c".repeat(40) } } };
        },
        getCommit: async () => {
          calls.push("getCommit");
          return {
            data: {
              sha: "c".repeat(40),
              tree: { sha: "e".repeat(40) },
              parents: [{ sha: "d".repeat(40) }],
            },
          };
        },
      },
      pulls: {
        list: async () => {
          calls.push("list");
          return {
            data: [{ number: 27, html_url: "https://github.com/owner/repo/pull/27", base: { ref: "main" } }],
          };
        },
        update: async ({ pull_number }: { pull_number: number }) => {
          calls.push(`update:${pull_number}`);
          return {
            data: {
              html_url: "https://github.com/owner/repo/pull/27",
              head: { sha: "c".repeat(40) },
              base: { ref: "main", sha: "d".repeat(40) },
            },
          };
        },
        create: async () => {
          throw new Error("matching PR must be reused");
        },
      },
    },
  } as unknown as AuthResult;

  const remote = await inspectRemotePublicationState(
    auth,
    repository,
    "codex/api-migrator/inngest-abc",
    "main",
    "d".repeat(40),
    "e".repeat(40)
  );
  assert.equal(remote.sha, "c".repeat(40));
  assert.equal(remote.pullRequest?.number, 27);
  assert.equal(remote.pushRequired, false);
  const url = await reconcilePr(
    auth,
    repository,
    "codex/api-migrator/inngest-abc",
    "main",
    "Migration",
    "Evidence",
    remote.pullRequest,
    remote.sha!,
    "d".repeat(40)
  );
  assert.equal(url, "https://github.com/owner/repo/pull/27");
  assert.deepEqual(calls, [
    "getRef:heads/main",
    "getRef:heads/codex/api-migrator/inngest-abc",
    "getCommit",
    "list",
    "update:27",
  ]);
});

test("PR reconciliation rejects head races without unsigned compensating writes", async () => {
  const repository = parseRepositorySlug("owner/repo");
  const expectedHead = "a".repeat(40);
  const expectedBase = "c".repeat(40);
  const existingUpdates: Array<Record<string, unknown>> = [];
  const existingAuth = {
    token: "secret-token",
    actor: "api-migrator[bot]",
    mode: "github-app",
    octokit: {
      pulls: {
        update: async (input: Record<string, unknown>) => {
          existingUpdates.push(input);
          return {
            data: {
              html_url: "https://github.com/owner/repo/pull/27",
              head: { sha: "b".repeat(40) },
              base: { ref: "main", sha: expectedBase },
            },
          };
        },
      },
    },
  } as unknown as AuthResult;

  await assert.rejects(
    reconcilePr(
      existingAuth,
      repository,
      "codex/api-migrator/inngest-abc",
      "main",
      "Migration",
      "Evidence",
      { number: 27, htmlUrl: "https://github.com/owner/repo/pull/27", baseBranch: "main" },
      expectedHead,
      expectedBase
    ),
    /Existing pull request head or approved base changed/
  );
  assert.equal(existingUpdates.length, 1);
  assert.equal(existingUpdates[0]?.state, undefined, "a pre-existing PR must never be auto-closed");

  const createCalls: Array<Record<string, unknown>> = [];
  const unauthorizedUpdates: Array<Record<string, unknown>> = [];
  const createAuth = {
    token: "secret-token",
    actor: "api-migrator[bot]",
    mode: "github-app",
    octokit: {
      pulls: {
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input);
          return {
            data: {
              number: 41,
              html_url: "https://github.com/owner/repo/pull/41",
              head: { sha: expectedHead },
              base: { ref: "main", sha: "d".repeat(40) },
            },
          };
        },
        update: async (input: Record<string, unknown>) => {
          unauthorizedUpdates.push(input);
          return { data: {} };
        },
      },
    },
  } as unknown as AuthResult;

  const audit: PublicationAttemptAudit = {
    publicationMode: "publish",
    preflightId: `pf_${"a".repeat(64)}`,
    artifactDigest: "b".repeat(64),
    baseSha: expectedBase,
    baseBranch: "main",
    headSha: expectedHead,
    branch: "codex/api-migrator/inngest-abc",
    candidateTreeSha: "e".repeat(40),
    ownerAuthorizationReceipt,
    publicationBlockers: [],
    approvedBy: "operator",
    overrideUnsafe: false,
    report: report(),
  };
  let racedCreateFailure: unknown;
  try {
    await reconcilePrWithAudit(
      createAuth,
      repository,
      "Migration",
      "Evidence",
      null,
      audit
    );
    assert.fail("raced PR creation should fail");
  } catch (error) {
    racedCreateFailure = error;
  }
  assert.ok(racedCreateFailure instanceof PublicationAttemptError);
  assert.match(racedCreateFailure.message, /created pull request remains open/);
  assert.equal(racedCreateFailure.audit.pullRequestNumber, 41);
  assert.equal(racedCreateFailure.audit.prUrl, "https://github.com/owner/repo/pull/41");
  assert.equal(buildFailedRunPatch(racedCreateFailure).prUrl, racedCreateFailure.audit.prUrl);
  assert.equal(createCalls.length, 1);
  assert.deepEqual(
    unauthorizedUpdates,
    [],
    "a create-only owner envelope must not be expanded into a PR update or close"
  );

  try {
    const db = getDb(":memory:");
    migrate(db);
    const provider = createProvider({ name: "Inngest", slug: "inngest" });
    const campaign = createCampaign({
      providerId: provider.id,
      name: "Inngest v3 to v4",
      manifest,
      status: "active",
    });
    const repo = upsertRepo({ slug: repository.slug });
    const run = createRun({
      campaignId: campaign.id,
      repoId: repo.id,
      branch: "codex/api-migrator/pending",
    });
    persistFailedRun(run.id, racedCreateFailure);
    assert.equal(getRun(run.id)?.prUrl, "https://github.com/owner/repo/pull/41");
  } finally {
    closeDb();
  }

  const foreignUrlAuth = {
    ...createAuth,
    octokit: {
      pulls: {
        ...createAuth.octokit.pulls,
        create: async () => ({
          data: {
            number: 42,
            html_url: "https://github.com/another-owner/another-repo/pull/42",
            head: { sha: expectedHead },
            base: { ref: "main", sha: expectedBase },
          },
        }),
      },
    },
  } as unknown as AuthResult;
  let foreignUrlFailure: unknown;
  try {
    await reconcilePrWithAudit(
      foreignUrlAuth,
      repository,
      "Migration",
      "Evidence",
      null,
      audit
    );
    assert.fail("a foreign created-PR URL should fail closed");
  } catch (error) {
    foreignUrlFailure = error;
  }
  assert.ok(foreignUrlFailure instanceof PublicationAttemptError);
  assert.match(foreignUrlFailure.message, /mismatched created pull request URL/);
  assert.equal(foreignUrlFailure.audit.pullRequestNumber, 42);
  assert.equal(foreignUrlFailure.audit.prUrl, "https://github.com/owner/repo/pull/42");
});

test("a push-success then PR-failure persists the exact publication attempt", async () => {
  const repository = parseRepositorySlug("owner/repo");
  const secret = "ghp_postPushSecret123456";
  let createCalls = 0;
  const auth = {
    token: secret,
    actor: "api-migrator[bot]",
    mode: "github-app",
    octokit: {
      pulls: {
        create: async () => {
          createCalls += 1;
          throw new Error(`GitHub PR API failed with Authorization: Bearer ${secret}`);
        },
      },
    },
  } as unknown as AuthResult;
  const migrationReport = report({ review: true });
  const audit: PublicationAttemptAudit = {
    publicationMode: "publish",
    preflightId: `pf_${"a".repeat(64)}`,
    artifactDigest: "b".repeat(64),
    baseSha: "c".repeat(40),
    baseBranch: "main",
    headSha: "d".repeat(40),
    branch: "codex/api-migrator/inngest-post-push",
    candidateTreeSha: "e".repeat(40),
    ownerAuthorizationReceipt,
    publicationBlockers: [{
      code: "manual_review_required",
      message: "1 unresolved item requires manual review",
    }],
    approvedBy: "operator",
    overrideUnsafe: false,
    report: migrationReport,
  };

  // reconcilePrWithAudit is entered only after the exact branch head is known
  // to exist (a successful push in the new-branch path).
  let failure: unknown;
  try {
    await reconcilePrWithAudit(auth, repository, "Migration", "Evidence", null, audit);
    assert.fail("PR reconciliation should fail");
  } catch (error) {
    failure = error;
  }
  assert.equal(createCalls, 1);
  assert.ok(failure instanceof PublicationAttemptError);
  assert.equal(failure.audit, audit);
  assert.equal(failure.message.includes(secret), false);

  try {
    const db = getDb(":memory:");
    migrate(db);
    const provider = createProvider({ name: "Inngest", slug: "inngest" });
    const campaign = createCampaign({
      providerId: provider.id,
      name: "Inngest v3 to v4",
      manifest,
      status: "active",
    });
    const repo = upsertRepo({ slug: repository.slug });
    const run = createRun({
      campaignId: campaign.id,
      repoId: repo.id,
      branch: "codex/api-migrator/pending",
    });

    const message = persistFailedRun(run.id, failure);
    const stored = getRun(run.id);
    assert.ok(stored);
    assert.equal(message.includes(secret), false);
    assert.equal(stored.status, "failed");
    assert.equal(stored.publicationMode, "publish");
    assert.equal(stored.preflightId, audit.preflightId);
    assert.equal(stored.artifactDigest, audit.artifactDigest);
    assert.equal(stored.baseSha, audit.baseSha);
    assert.equal(stored.baseBranch, audit.baseBranch);
    assert.equal(stored.headSha, audit.headSha);
    assert.equal(stored.branch, audit.branch);
    assert.equal(stored.approvedBy, audit.approvedBy);
    assert.equal(stored.overrideUnsafe, false);
    assert.equal(stored.overrideReason, null);
    assert.deepEqual(JSON.parse(stored.publicationBlockers ?? "null"), audit.publicationBlockers);
    assert.deepEqual(JSON.parse(stored.report ?? "null"), migrationReport);
    assert.equal((stored.error ?? "").includes(secret), false);
  } finally {
    closeDb();
  }
});

test("an open PR never authorizes reuse of a branch with different content", async () => {
  const repository = parseRepositorySlug("owner/repo");
  let listedPullRequests = false;
  const auth = {
    token: "secret-token",
    actor: "api-migrator[bot]",
    mode: "github-app",
    octokit: {
      git: {
        getRef: async ({ ref }: { ref: string }) => ({
          data: { object: { sha: ref === "heads/main" ? "b".repeat(40) : "a".repeat(40) } },
        }),
        getCommit: async () => ({
          data: {
            sha: "a".repeat(40),
            tree: { sha: "f".repeat(40) },
            parents: [{ sha: "b".repeat(40) }],
          },
        }),
      },
      pulls: {
        list: async () => {
          listedPullRequests = true;
          return {
            data: [{ number: 99, html_url: "https://github.com/owner/repo/pull/99", base: { ref: "main" } }],
          };
        },
      },
    },
  } as unknown as AuthResult;

  await assert.rejects(
    inspectRemotePublicationState(
      auth,
      repository,
      "codex/api-migrator/inngest-abc",
      "main",
      "b".repeat(40),
      "c".repeat(40)
    ),
    /does not match the approved artifact and base/
  );
  assert.equal(listedPullRequests, false);
});

test("an orphan branch is recoverable only for the exact approved tree and base parent", async () => {
  const repository = parseRepositorySlug("owner/repo");
  const branchSha = "a".repeat(40);
  const baseSha = "b".repeat(40);
  const treeSha = "c".repeat(40);
  const authFor = (remoteTreeSha: string, parentSha: string) => ({
    token: "secret-token",
    actor: "api-migrator[bot]",
    mode: "github-app",
    octokit: {
      git: {
        getRef: async ({ ref }: { ref: string }) => ({
          data: { object: { sha: ref === "heads/main" ? baseSha : branchSha } },
        }),
        getCommit: async () => ({
          data: {
            sha: branchSha,
            tree: { sha: remoteTreeSha },
            parents: [{ sha: parentSha }],
          },
        }),
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({
          data: {
            number: 31,
            html_url: "https://github.com/owner/repo/pull/31",
            head: { sha: branchSha },
            base: { ref: "main", sha: baseSha },
          },
        }),
      },
    },
  }) as unknown as AuthResult;

  const recoveryAuth = authFor(treeSha, baseSha);
  const recovered = await inspectRemotePublicationState(
    recoveryAuth,
    repository,
    "codex/api-migrator/inngest-abc",
    "main",
    baseSha,
    treeSha
  );
  assert.deepEqual(recovered, { sha: branchSha, pullRequest: null, pushRequired: false });
  assert.equal(
    await reconcilePr(
      recoveryAuth,
      repository,
      "codex/api-migrator/inngest-abc",
      "main",
      "Migration",
      "Evidence",
      recovered.pullRequest,
      recovered.sha!,
      baseSha
    ),
    "https://github.com/owner/repo/pull/31"
  );

  await assert.rejects(
    inspectRemotePublicationState(
      authFor("d".repeat(40), baseSha),
      repository,
      "codex/api-migrator/inngest-abc",
      "main",
      baseSha,
      treeSha
    ),
    /does not match the approved artifact and base/
  );
  await assert.rejects(
    inspectRemotePublicationState(
      authFor(treeSha, "e".repeat(40)),
      repository,
      "codex/api-migrator/inngest-abc",
      "main",
      baseSha,
      treeSha
    ),
    /does not match the approved artifact and base/
  );
});

test("remote publication state rejects an advanced base before inspecting or creating the migration branch", async () => {
  const repository = parseRepositorySlug("owner/repo");
  let branchInspected = false;
  const auth = {
    token: "secret-token",
    actor: "api-migrator[bot]",
    mode: "github-app",
    octokit: {
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref !== "heads/main") branchInspected = true;
          return { data: { object: { sha: "f".repeat(40) } } };
        },
      },
    },
  } as unknown as AuthResult;

  await assert.rejects(
    inspectRemotePublicationState(
      auth,
      repository,
      "codex/api-migrator/inngest-abc",
      "main",
      "b".repeat(40),
      "c".repeat(40)
    ),
    /base branch advanced after the approved preview/
  );
  assert.equal(branchInspected, false);
});
