import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  canonicalDigest,
  deriveCandidateBranch,
  deriveFindingId,
  digestFindingSet,
  digestRequiredCiSet,
  digestResolutionSet,
  validatePilotResult,
  validBranchName,
  validRepositorySlug,
} from "./validate-pilot-result.mjs";

const example = JSON.parse(
  fs.readFileSync(new URL("../docs/pilot/pilot-result.example.json", import.meta.url), "utf8")
);

function copy() {
  return structuredClone(example);
}

function messages(record) {
  return validatePilotResult(record).join("\n");
}

function rewriteExecutionAttestation(record, mutate) {
  const attestation = JSON.parse(record.controls.runner.executionAttestationJson);
  mutate(attestation);
  record.controls.runner.executionAttestationJson = JSON.stringify(attestation);
  record.controls.runner.executionAttestationDigest = createHash("sha256")
    .update(record.controls.runner.executionAttestationJson)
    .digest("hex");
}

function previewCopy() {
  const record = copy();
  record.authorization.postPreviewPublication = null;
  record.run.publicationMode = "preview";
  record.run.publicationStatus = "preview_ready";
  record.run.publicationAttemptedAt = null;
  record.run.approvedHeadSha = null;
  record.run.approvedBy = null;
  record.outcome.ownerDisposition = "pending";
  record.outcome.pullRequestState = "not_opened";
  record.outcome.prUrl = null;
  record.outcome.currentHeadSha = null;
  record.outcome.mergeCommitSha = null;
  record.controls.app = null;
  record.controls.rulesets = null;
  record.controls.requiredCi = null;
  record.cleanup.locations.find((item) => item.kind === "github_access").targetReference =
    `github-access:none:repository:${record.repository.repositoryId}`;
  return record;
}

test("the documented pilot result example satisfies schema and safety invariants", () => {
  assert.deepEqual(validatePilotResult(copy()), []);
});

test("Draft 2020-12 shape rejects missing, unknown, and malformed fields", () => {
  const missing = copy();
  delete missing.effort;
  assert.match(messages(missing), /schema \/.*required property 'effort'/);

  const extra = copy();
  extra.unexpected = true;
  assert.match(messages(extra), /schema \/.*additional properties/);

  const malformed = copy();
  malformed.run.scannedFiles = -7;
  assert.match(messages(malformed), /schema \/run\/scannedFiles.*must be >= 0/);

  for (const length of [41, 63]) {
    const ambiguousSha = copy();
    ambiguousSha.repository.baseSha = "a".repeat(length);
    assert.match(messages(ambiguousSha), /schema \/repository\/baseSha/);
  }
});

test("repository and branch rules mirror the runtime boundary", () => {
  for (const slug of ["owner/repo", "Example-Org/api_repo.js"]) assert.equal(validRepositorySlug(slug), true);
  for (const slug of ["bad_owner/repo", "owner--name/repo", "owner/repo.git", "owner/.."]) {
    assert.equal(validRepositorySlug(slug), false);
    const record = copy();
    record.repository.slug = slug;
    assert.match(messages(record), /schema \/repository\/slug/);
  }
  for (const branch of ["main", "codex/api-migrator/abc"]) assert.equal(validBranchName(branch), true);
  for (const branch of ["-danger", "refs/../main", "feature.lock", "bad branch", "x@{y", ".hidden/x", "a".repeat(241)]) {
    assert.equal(validBranchName(branch), false);
    const record = copy();
    record.repository.baseBranch = branch;
    assert.match(messages(record), /schema \/repository\/baseBranch/);
  }
});

test("manifest and approved command scope are reproducible", () => {
  const record = copy();
  record.campaign.manifestJson = ` ${record.campaign.manifestJson}`;
  assert.match(messages(record), /campaign.manifestDigest does not match/);

  const commands = copy();
  commands.authorization.commandScope.test.script = "test:changed";
  assert.match(messages(commands), /authorization.commandScopeDigest does not match/);

  const destructive = copy();
  destructive.authorization.commandScope.install = "npm ci && rm -rf workspace";
  assert.match(messages(destructive), /schema \/authorization\/commandScope\/install/);
  assert.equal(canonicalDigest(example.authorization.commandScope), example.authorization.commandScopeDigest);
});

test("trusted runner attestation binds the approved scope and every check", () => {
  const rawTamper = copy();
  const raw = JSON.parse(rawTamper.controls.runner.executionAttestationJson);
  raw.commandScopeDigest = "9".repeat(64);
  rawTamper.controls.runner.executionAttestationJson = JSON.stringify(raw);
  assert.match(messages(rawTamper), /executionAttestationDigest does not match/);

  const consistentTamper = copy();
  rewriteExecutionAttestation(consistentTamper, (attestation) => {
    attestation.checks.test.status = "failed";
  });
  assert.match(messages(consistentTamper), /runner attestation test status does not match/);
});

test("candidate branch equals the runtime content-addressed derivation", () => {
  const manifest = JSON.parse(example.campaign.manifestJson);
  assert.equal(
    deriveCandidateBranch(manifest, example.repository.baseBranch, example.repository.baseSha, example.run.artifactDigest),
    example.run.candidateBranch
  );
  const record = copy();
  record.run.candidateBranch = "main";
  record.authorization.postPreviewPublication.candidateBranch = "main";
  assert.match(messages(record), /run.candidateBranch does not match/);
});

test("preview authorization is bound to the exact target and execution controls", () => {
  const record = copy();
  record.authorization.pilotId = "pilot_another_001";
  record.authorization.repository = "other-org/other-repo";
  record.controls.runner.repositoryId = 999;
  const errors = messages(record);
  assert.match(errors, /preview authorization pilotId does not match/);
  assert.match(errors, /preview authorization repository does not match/);
  assert.match(errors, /runner repositoryId does not match/);
});

test("preview authorization covers every executed pre-run action", () => {
  const record = copy();
  record.authorization.allowedActions = ["preview"];
  const errors = messages(record);
  assert.match(errors, /clone action is not authorized/);
  assert.match(errors, /dependency_install action is not authorized/);
});

test("a public preview needs no App and a private-preview App needs pre-run approval", () => {
  assert.deepEqual(validatePilotResult(previewCopy()), []);
  const record = previewCopy();
  record.controls.app = copy().controls.app;
  record.controls.app.writeAccess = null;
  record.controls.app.readAccess.policyObservedAt = "2030-01-02T10:14:00Z";
  record.controls.app.readAccess.tokenIssuedAt = "2030-01-02T10:16:00Z";
  record.controls.app.readAccess.tokenExpiresAt = "2030-01-02T11:16:00Z";
  record.controls.app.readAccess.tokenRevokedAt = "2030-01-02T10:46:00Z";
  record.cleanup.locations.find((item) => item.kind === "github_access").targetReference =
    `github-installation:${record.controls.app.installationId}:repository:${record.repository.repositoryId}`;
  assert.match(messages(record), /preview App installation was not authorized/);
  record.authorization.allowedActions.push("private_preview_app_install");
  assert.deepEqual(validatePilotResult(record), []);
});

test("App, ruleset, and required-CI evidence is target and head bound", () => {
  const record = copy();
  record.controls.app.readAccess.installationRepositoryIds[0] = 998;
  record.controls.app.writeAccess.tokenRepositoryId = 999;
  record.controls.app.readAccess.permissionSnapshotJson = "{}";
  record.controls.app.writeAccess.tokenPermissionsJson = "{}";
  record.controls.rulesets.repository = "other-org/other-repo";
  record.controls.rulesets.configurationJson = "{}";
  record.controls.requiredCi.headSha = "9".repeat(40);
  record.controls.requiredCi.checks[0].observedAt = "2030-01-02T10:00:00Z";
  record.controls.requiredCi.checks[0].evidenceUrl = "https://github.com/other-org/other-repo/actions/runs/1";
  const errors = messages(record);
  assert.match(errors, /App read access installation repository ID does not match/);
  assert.match(errors, /App write access tokenRepositoryId does not match/);
  assert.match(errors, /App read access permissionSnapshotDigest does not match/);
  assert.match(errors, /App write access tokenPermissionsDigest does not match/);
  assert.match(errors, /rulesets repository does not match/);
  assert.match(errors, /rulesets configurationDigest does not match/);
  assert.match(errors, /required CI head must match/);
  assert.match(errors, /observed before publication/);
  assert.match(errors, /evidence URL must match the exact repository/);
});

test("required CI binds authorized workflow, check, and integration identities", () => {
  assert.equal(
    digestRequiredCiSet(example.authorization.requiredCi),
    example.authorization.requiredCiDigest
  );
  const record = copy();
  for (const check of record.controls.requiredCi.checks) check.workflow = "untrusted-spoof-workflow";
  assert.match(messages(record), /required-CI evidence does not match the authorized workflow\/check identities/);

  const duplicateRuleset = copy();
  duplicateRuleset.controls.rulesets.defaultBranchRulesetId =
    duplicateRuleset.controls.rulesets.migrationRefRulesetId;
  assert.match(messages(duplicateRuleset), /ruleset IDs must be distinct/);

  const lateRuleset = copy();
  lateRuleset.controls.rulesets.observedAt = "2030-01-02T11:13:30Z";
  assert.match(messages(lateRuleset), /ruleset evidence must precede and bind App write-token issuance/);
});

test("ruleset and trusted verification evidence precede write capability", () => {
  const record = copy();
  rewriteExecutionAttestation(record, (attestation) => {
    attestation.observedAt = "2030-01-02T11:13:30Z";
  });
  assert.match(messages(record), /trusted verification attestation must precede App write-access observation/);
});

test("ruleset policy is checked after its raw digest is recomputed", () => {
  const record = copy();
  const rules = JSON.parse(record.controls.rulesets.configurationJson);
  rules.migrationRef.enforcement = "disabled";
  rules.migrationRef.restrictUpdates = false;
  rules.migrationRef.bypassActors.push({ actorType: "Team", actorId: 999, bypassMode: "always" });
  record.controls.rulesets.configurationJson = JSON.stringify(rules);
  record.controls.rulesets.configurationDigest = createHash("sha256")
    .update(record.controls.rulesets.configurationJson)
    .digest("hex");
  assert.match(messages(record), /ruleset configuration snapshot does not enforce the pilot policy/);
});

test("unsafe execution controls fail", () => {
  const record = copy();
  record.controls.runner.egressFiltered = false;
  record.controls.productionSecretsUsed = true;
  const errors = messages(record);
  assert.match(errors, /schema \/controls\/runner\/egressFiltered/);
  assert.match(errors, /schema \/controls\/productionSecretsUsed/);
});

test("passed verification cannot hide a failed check", () => {
  const record = copy();
  record.run.verification.checks.test.status = "failed";
  assert.match(messages(record), /requires test to pass|schema .*must be equal to constant/);
});

test("verification shape and publication status fail closed", () => {
  const extra = copy();
  extra.run.verification.checks.security = {
    status: "failed",
    reason: "extra failed check",
    evidenceReference: "run-example-001#security",
  };
  assert.match(messages(extra), /schema \/run\/verification\/checks.*additional properties/);

  const failedPreview = previewCopy();
  failedPreview.run.verification.checks.test.status = "failed";
  failedPreview.run.verification.overall = "failed";
  failedPreview.run.blockers.push({ code: "verification_failed", message: "Test failed." });
  failedPreview.run.publicationStatus = "preview_ready";
  rewriteExecutionAttestation(failedPreview, (attestation) => {
    attestation.checks.test.status = "failed";
  });
  const errors = messages(failedPreview);
  assert.match(errors, /preview_ready cannot retain publication blockers/);
  assert.match(errors, /failed or skipped verification requires blocked publication status/);
});

test("publication approval binds the exact preview and remains valid at the attempt", () => {
  const record = copy();
  record.authorization.postPreviewPublication.artifactDigest = "9".repeat(64);
  assert.match(messages(record), /artifactDigest does not match/);

  const expired = copy();
  expired.run.publicationAttemptedAt = "2031-01-02T11:15:00Z";
  assert.match(messages(expired), /within both authorization windows/);

  const prematureToken = copy();
  prematureToken.controls.app.writeAccess.policyObservedAt = "2030-01-02T10:49:00Z";
  prematureToken.controls.app.writeAccess.tokenIssuedAt = "2030-01-02T10:50:00Z";
  prematureToken.controls.app.writeAccess.tokenExpiresAt = "2030-01-02T11:50:00Z";
  assert.match(messages(prematureToken), /write access must be observed and issued only after owner approval/);

  const prematureObservation = copy();
  prematureObservation.controls.app.writeAccess.policyObservedAt = "2030-01-02T10:50:00Z";
  assert.match(messages(prematureObservation), /write access must be observed and issued only after owner approval/);
});

test("publish App evidence records separate read and write phases with revocation", () => {
  const missingRead = copy();
  delete missingRead.controls.app.readAccess;
  assert.match(messages(missingRead), /schema \/controls\/app.*required property 'readAccess'/);

  const unpairedRevocation = copy();
  unpairedRevocation.controls.app.writeAccess.revocationEvidenceReference = null;
  assert.match(messages(unpairedRevocation), /revocation timestamp and evidence must be recorded together/);

  const falseDeletion = copy();
  for (const access of [falseDeletion.controls.app.readAccess, falseDeletion.controls.app.writeAccess]) {
    access.tokenRevokedAt = null;
    access.revocationEvidenceReference = null;
  }
  assert.match(messages(falseDeletion), /deleted GitHub access requires revocation evidence/);

  const blockedWrite = copy();
  blockedWrite.run.publicationStatus = "blocked";
  blockedWrite.run.blockers = [{
    code: "manual_review_required",
    message: "Publication remains blocked before write-token issuance.",
  }];
  blockedWrite.run.approvedHeadSha = null;
  blockedWrite.outcome.ownerDisposition = "pending";
  blockedWrite.outcome.pullRequestState = "not_opened";
  blockedWrite.outcome.prUrl = null;
  blockedWrite.outcome.currentHeadSha = null;
  blockedWrite.outcome.mergeCommitSha = null;
  assert.match(messages(blockedWrite), /blocked must not record App write access/);

  const lateWrite = copy();
  lateWrite.run.publicationStatus = "blocked";
  lateWrite.run.blockers = [{ code: "manual_review_required", message: "Publication failed after approval." }];
  lateWrite.controls.app.writeAccess.policyObservedAt = "2030-01-02T11:59:00Z";
  lateWrite.controls.app.writeAccess.tokenIssuedAt = "2030-01-02T12:00:00Z";
  lateWrite.controls.app.writeAccess.tokenExpiresAt = "2030-01-02T13:00:00Z";
  lateWrite.controls.app.writeAccess.tokenRevokedAt = "2030-01-02T12:01:00Z";
  assert.match(messages(lateWrite), /write-access evidence does not cover the publication attempt/);
});

test("publication mode and status follow the runtime state machine", () => {
  const record = copy();
  record.run.publicationStatus = "preview_ready";
  assert.match(messages(record), /schema \/run\/publicationStatus|publish mode cannot use preview_ready/);
});

test("every manual finding has stable identity and its own resolution", () => {
  const finding = {
    findingId: "",
    code: "F12",
    file: "src/inngest/functions.ts",
    locationDigest: "a".repeat(64),
    messageDigest: "b".repeat(64),
    evidenceReference: "preview-example-001#finding-1",
    evidenceDigest: "c".repeat(64),
  };
  finding.findingId = deriveFindingId(finding);

  const record = previewCopy();
  record.run.manualReviewFindings = [finding];
  record.run.reviewItems = 2;
  assert.match(messages(record), /reviewItems must equal/);

  const identity = previewCopy();
  identity.run.manualReviewFindings = [structuredClone(finding)];
  identity.run.reviewItems = 1;
  identity.run.blockers = [{
    code: "manual_review_required",
    message: "One exact finding remains unresolved.",
  }];
  identity.run.publicationStatus = "blocked";
  identity.review.unresolvedReviewItems = 1;
  identity.run.manualReviewFindings[0].file = "src/changed.ts";
  assert.match(messages(identity), /invalid stable identity/);
  assert.equal(deriveFindingId(finding), finding.findingId);
});

test("owner approval binds empty finding and resolution sets after blockers are cleared", () => {
  const record = copy();
  record.authorization.postPreviewPublication.resolutionsDigest = "9".repeat(64);
  assert.match(messages(record), /resolutionsDigest does not match/);
  assert.equal(digestFindingSet([]), example.authorization.postPreviewPublication.findingsDigest);
  assert.equal(digestResolutionSet([]), example.authorization.postPreviewPublication.resolutionsDigest);
});

test("manual-review blockers cannot publish or be overridden", () => {
  const override = copy();
  override.run.overrideUnsafe = true;
  override.run.overrideReason = "Attempted manual-review override.";
  assert.match(messages(override), /schema \/run\/overrideUnsafe|publication overrides are disabled/);

  const blockedPublication = copy();
  blockedPublication.run.blockers.push({
    code: "manual_review_required",
    message: "One exact finding remains unresolved.",
  });
  assert.match(messages(blockedPublication), /pr_opened cannot retain publication blockers/);
});

test("candidate counts retain the raw precision denominator", () => {
  const record = copy();
  record.review.falsePositives = 1;
  assert.match(messages(record), /candidateSites must equal/);
});

test("merged results require exact PR and merge identity", () => {
  const wrongRepository = copy();
  wrongRepository.outcome.prUrl = "https://github.com/another/repo/pull/1";
  assert.match(messages(wrongRepository), /PR URL must match/);

  const missingMerge = copy();
  missingMerge.outcome.mergeCommitSha = null;
  assert.match(messages(missingMerge), /schema \/outcome\/mergeCommitSha|merge commit SHA/);
});

test("outcome chronology follows all run, CI, and attestation evidence", () => {
  const record = copy();
  record.outcome.observedAt = "2030-01-02T11:20:00Z";
  assert.match(messages(record), /outcome must be observed after every recorded run and CI action/);
});

test("cleanup states distinguish deletion from retained or unverifiable data", () => {
  const complete = copy();
  complete.cleanup.status = "complete";
  complete.cleanup.confirmationReference = "cleanup-confirmation-example-001";
  assert.match(messages(complete), /requires every location to be deleted/);

  const broad = copy();
  broad.cleanup.locations[0].targetReference = "/";
  assert.match(messages(broad), /schema \/cleanup\/locations\/0\/targetReference/);

  const wrongTarget = copy();
  wrongTarget.cleanup.locations.find((item) => item.kind === "runner_storage").targetReference = "runner:another-pilot";
  assert.match(messages(wrongTarget), /cleanup runner_storage targetReference does not match/);

  const wrongDeadline = copy();
  wrongDeadline.cleanup.locations.find((item) => item.kind === "github_access").authorizedDeleteBy =
    "2030-02-04T12:00:00Z";
  assert.match(messages(wrongDeadline), /cleanup github_access authorizedDeleteBy does not match/);

  const earlyCompletion = copy();
  earlyCompletion.cleanup.locations.find((item) => item.kind === "github_access").completedAt =
    "2030-01-02T11:00:00Z";
  assert.match(messages(earlyCompletion), /cleanup github_access completion must follow last use/);

  const expiredDeadline = copy();
  expiredDeadline.authorization.cleanupDeadlines.pilotDatabase = "2030-01-03T12:00:00Z";
  expiredDeadline.cleanup.locations.find((item) => item.kind === "pilot_database").authorizedDeleteBy =
    "2030-01-03T12:00:00Z";
  assert.match(messages(expiredDeadline), /cleanup pilot_database deadline cannot precede that target's last use/);

  const overdue = copy();
  overdue.audit.observedAt = "2030-02-04T12:00:00Z";
  assert.match(messages(overdue), /pending cleanup pilot_database is overdue/);

  const missingException = copy();
  missingException.cleanup.locations.find((item) => item.kind === "authorization_feedback").exception = null;
  assert.match(messages(missingException), /retained or unverifiable cleanup requires exception authority/);

  const exceptions = copy();
  exceptions.cleanup.status = "complete_with_exceptions";
  exceptions.cleanup.confirmationReference = "cleanup-confirmation-example-001";
  for (const item of exceptions.cleanup.locations) {
    if (item.status === "pending") {
      item.status = "deleted";
      item.completedAt = "2030-01-04T12:15:00Z";
      item.evidenceReference = `deletion-evidence-${item.kind}`;
    }
  }
  assert.deepEqual(validatePilotResult(exceptions), []);
});
