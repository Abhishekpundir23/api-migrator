#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemaUrl = new URL("../docs/pilot/pilot-result.schema.json", import.meta.url);
const schema = JSON.parse(fs.readFileSync(schemaUrl, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateShape = ajv.compile(schema);

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PREFLIGHT = /^pf_[a-f0-9]{64}$/;
const OPERATOR = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,99}$/;
const REQUIRED_CHECKS = ["install", "typecheck", "test", "lint", "runtime"];
const CLEANUP_KINDS = [
  "github_access",
  "runner_storage",
  "pilot_database",
  "logs_exports_backups",
  "authorization_feedback",
];
const POST_PUBLICATION_ACTIONS = [
  "use_private_app_for_publication",
  "push_candidate_branch",
  "open_pull_request",
];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function populated(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp(value) {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function orderedByFindingId(items) {
  return [...items].sort((left, right) => {
    if (left.findingId < right.findingId) return -1;
    if (left.findingId > right.findingId) return 1;
    return 0;
  });
}

export function digestFindingSet(findings) {
  return canonicalDigest(orderedByFindingId(findings));
}

export function digestResolutionSet(resolutions) {
  return canonicalDigest(orderedByFindingId(resolutions));
}

function orderedCiIdentities(items) {
  return [...items].sort((left, right) => {
    const leftKey = `${left.workflow}\u0000${left.name}\u0000${left.integrationId}`;
    const rightKey = `${right.workflow}\u0000${right.name}\u0000${right.integrationId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

export function digestRequiredCiSet(items) {
  return canonicalDigest(orderedCiIdentities(items));
}

export function deriveFindingId(finding) {
  return `finding_${canonicalDigest({
    code: finding.code,
    file: finding.file,
    locationDigest: finding.locationDigest,
    messageDigest: finding.messageDigest,
  })}`;
}

export function deriveCandidateBranch(manifest, baseBranch, baseSha, artifactDigest) {
  const label = `${manifest.provider}-${manifest.transformSet}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "migration";
  const digest = canonicalDigest({ manifest, baseBranch, baseSha, artifactDigest });
  return `codex/api-migrator/${label}-${digest}`;
}

/** Keep these rules equivalent to packages/app/src/repository.ts. */
export function validRepositorySlug(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return false;
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
  const repoPattern = /^[A-Za-z0-9_.-]{1,100}$/;
  return ownerPattern.test(owner)
    && !owner.includes("--")
    && repoPattern.test(repo)
    && repo !== "."
    && repo !== ".."
    && !repo.endsWith(".git");
}

/** Keep these rules equivalent to packages/app/src/repository.ts. */
export function validBranchName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 240
    && value === value.trim()
    && value !== "@"
    && !value.startsWith("-")
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.endsWith(".lock")
    && !value.includes("..")
    && !value.includes("@{")
    && !/[\x00-\x20\x7f~^:?*[\\]/.test(value)
    && value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith("."));
}

function exactGithubUrl(value, slug, suffix) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return parsed.protocol === "https:"
      && parsed.hostname === "github.com"
      && new RegExp(`^/${escaped}/${suffix}$`).test(parsed.pathname)
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}

function exactPrUrl(value, slug) {
  return exactGithubUrl(value, slug, "pull/[1-9][0-9]*");
}

function exactCiUrl(value, slug) {
  return exactGithubUrl(value, slug, "actions/runs/[1-9][0-9]*(?:/job/[1-9][0-9]*)?");
}

function safeTargetReference(value) {
  return populated(value)
    && value !== "/"
    && value !== "."
    && value !== ".."
    && value !== "~"
    && !/[?*\[\]$`\\]/.test(value);
}

function hasExactKeys(value, expected) {
  return object(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function same(actual, expected, label, fail) {
  if (actual !== expected) fail(`${label} does not match the run`);
}

function schemaErrors() {
  return (validateShape.errors ?? []).map((error) => {
    const location = error.instancePath || "/";
    return `schema ${location} ${error.message ?? "is invalid"}`;
  });
}

export function validatePilotResult(record) {
  if (!validateShape(record)) return schemaErrors();

  const errors = [];
  const fail = (message) => errors.push(message);
  const { audit, authorization, campaign, repository, run, review, outcome, controls, cleanup } = record;

  if (!validRepositorySlug(repository.slug)) fail("repository.slug is invalid");
  if (!validBranchName(repository.baseBranch)) fail("repository.baseBranch is invalid");
  if (!validBranchName(run.candidateBranch)) fail("run.candidateBranch is invalid");
  if (!SHA.test(repository.baseSha)) fail("repository.baseSha is invalid");
  if (!PREFLIGHT.test(run.preflightId)) fail("run.preflightId is invalid");
  if (!DIGEST.test(run.artifactDigest)) fail("run.artifactDigest is invalid");

  let manifest;
  try {
    manifest = JSON.parse(campaign.manifestJson);
  } catch {
    fail("campaign.manifestJson must contain valid JSON");
  }
  const computedManifestDigest = createHash("sha256").update(campaign.manifestJson).digest("hex");
  same(campaign.manifestDigest, computedManifestDigest, "campaign.manifestDigest", fail);
  if (object(manifest)) {
    same(manifest.provider, campaign.provider, "manifest provider", fail);
    same(manifest.transformSet, campaign.transformSet, "manifest transformSet", fail);
    same(
      run.candidateBranch,
      deriveCandidateBranch(manifest, repository.baseBranch, repository.baseSha, run.artifactDigest),
      "run.candidateBranch",
      fail
    );
    same(
      authorization.commandScope.runtime.profile,
      manifest.runtime?.node?.profile,
      "commandScope runtime profile",
      fail
    );
  } else if (manifest !== undefined) {
    fail("campaign.manifestJson must encode an object");
  }

  const authorizationBindings = [
    ["pilotId", record.pilotId],
    ["repository", repository.slug],
    ["repositoryId", repository.repositoryId],
    ["baseBranch", repository.baseBranch],
    ["baseSha", repository.baseSha],
    ["provider", campaign.provider],
    ["transformSet", campaign.transformSet],
    ["engineTag", campaign.engineTag],
    ["engineCommit", campaign.engineCommit],
    ["manifestDigest", campaign.manifestDigest],
  ];
  for (const [field, expected] of authorizationBindings) {
    same(authorization[field], expected, `preview authorization ${field}`, fail);
  }
  for (const action of ["clone", "dependency_install", "preview"]) {
    if (!authorization.allowedActions.includes(action)) fail(`${action} action is not authorized`);
  }
  const commandScopeDigest = canonicalDigest(authorization.commandScope);
  same(authorization.commandScopeDigest, commandScopeDigest, "authorization.commandScopeDigest", fail);
  same(authorization.commandScope.test.script, "test", "commandScope test script", fail);
  same(authorization.commandScope.lint.script, "lint", "commandScope lint script", fail);
  const authorizedCiKeys = authorization.requiredCi.map(
    (check) => `${check.workflow}\u0000${check.name}\u0000${check.integrationId}`
  );
  if (new Set(authorizedCiKeys).size !== authorizedCiKeys.length) {
    fail("authorized required-CI identities must be unique");
  }
  same(
    authorization.requiredCiDigest,
    digestRequiredCiSet(authorization.requiredCi),
    "authorization.requiredCiDigest",
    fail
  );

  const authApprovedAt = timestamp(authorization.approvedAt);
  const authExpiresAt = timestamp(authorization.expiresAt);
  const previewStartedAt = timestamp(run.previewStartedAt);
  const previewCompletedAt = timestamp(run.previewCompletedAt);
  if (!(authApprovedAt <= previewStartedAt
      && previewStartedAt <= previewCompletedAt
      && previewCompletedAt <= authExpiresAt)) {
    fail("preview timestamps must fall within the initial authorization window");
  }

  const runner = controls.runner;
  same(runner.pilotId, record.pilotId, "runner pilotId", fail);
  same(runner.repository, repository.slug, "runner repository", fail);
  same(runner.repositoryId, repository.repositoryId, "runner repositoryId", fail);
  same(runner.commandScopeDigest, authorization.commandScopeDigest, "runner commandScopeDigest", fail);
  same(
    runner.executionAttestationDigest,
    createHash("sha256").update(runner.executionAttestationJson).digest("hex"),
    "runner executionAttestationDigest",
    fail
  );
  let executionAttestation;
  try {
    executionAttestation = JSON.parse(runner.executionAttestationJson);
  } catch {
    fail("runner execution attestation must contain valid JSON");
  }
  if (object(executionAttestation)) {
    if (!hasExactKeys(executionAttestation, [
      "schemaVersion",
      "pilotId",
      "repository",
      "repositoryId",
      "runnerProfile",
      "imageOrTemplateDigest",
      "commandScopeDigest",
      "observedAt",
      "checks",
    ])) {
      fail("runner execution attestation must use the exact audited shape");
    }
    same(executionAttestation.schemaVersion, 1, "runner attestation schemaVersion", fail);
    same(executionAttestation.pilotId, record.pilotId, "runner attestation pilotId", fail);
    same(executionAttestation.repository, repository.slug, "runner attestation repository", fail);
    same(executionAttestation.repositoryId, repository.repositoryId, "runner attestation repositoryId", fail);
    same(executionAttestation.runnerProfile, runner.profile, "runner attestation profile", fail);
    same(
      executionAttestation.imageOrTemplateDigest,
      runner.imageOrTemplateDigest,
      "runner attestation imageOrTemplateDigest",
      fail
    );
    same(
      executionAttestation.commandScopeDigest,
      authorization.commandScopeDigest,
      "runner attestation commandScopeDigest",
      fail
    );
    if (!hasExactKeys(executionAttestation.checks, REQUIRED_CHECKS)) {
      fail("runner execution attestation must contain exactly the required checks");
    }
  } else if (executionAttestation !== undefined) {
    fail("runner execution attestation must encode an object");
  }
  if (runner.disposable !== true) fail("runner must be disposable");
  if (runner.egressFiltered !== true) fail("runner egress must be filtered");
  if (!populated(runner.teardownEvidenceReference)) fail("runner teardown evidence is required");
  if (controls.productionSecretsUsed !== false) fail("production secrets must not be used");

  const app = controls.app;
  let readAccess;
  let writeAccess;
  if (object(app)) {
    if (app.selectedRepositoryOnly !== true) fail("App installation must be selected-repository-only");
    const validateAccess = (access, capability, label) => {
      same(access.appId, app.appId, `${label} App ID`, fail);
      same(access.installationId, app.installationId, `${label} installation ID`, fail);
      same(access.repository, repository.slug, `${label} repository`, fail);
      same(access.repositoryId, repository.repositoryId, `${label} repositoryId`, fail);
      same(access.installationRepositoryIds[0], repository.repositoryId, `${label} installation repository ID`, fail);
      same(access.tokenRepositoryId, repository.repositoryId, `${label} tokenRepositoryId`, fail);
      same(access.tokenCapability, capability, `${label} tokenCapability`, fail);
      let permissionSnapshot;
      let eventsSnapshot;
      let tokenPermissions;
      try {
        permissionSnapshot = JSON.parse(access.permissionSnapshotJson);
        eventsSnapshot = JSON.parse(access.eventsSnapshotJson);
        tokenPermissions = JSON.parse(access.tokenPermissionsJson);
      } catch {
        fail(`${label} permission, event, and token snapshots must contain valid JSON`);
      }
      same(
        access.permissionSnapshotDigest,
        createHash("sha256").update(access.permissionSnapshotJson).digest("hex"),
        `${label} permissionSnapshotDigest`,
        fail
      );
      same(
        access.eventsSnapshotDigest,
        createHash("sha256").update(access.eventsSnapshotJson).digest("hex"),
        `${label} eventsSnapshotDigest`,
        fail
      );
      same(
        access.tokenPermissionsDigest,
        createHash("sha256").update(access.tokenPermissionsJson).digest("hex"),
        `${label} tokenPermissionsDigest`,
        fail
      );
      if (canonicalJson(permissionSnapshot)
          !== canonicalJson({ metadata: "read", contents: "write", pull_requests: "write" })) {
        fail(`${label} permission snapshot must equal the audited registration policy`);
      }
      if (!Array.isArray(eventsSnapshot) || eventsSnapshot.length !== 0) {
        fail(`${label} event snapshot must be empty`);
      }
      const expectedTokenPermissions = capability === "write"
        ? { metadata: "read", contents: "write", pull_requests: "write" }
        : { metadata: "read", contents: "read" };
      if (canonicalJson(tokenPermissions) !== canonicalJson(expectedTokenPermissions)) {
        fail(`${label} token permissions must equal the audited capability policy`);
      }
      const observedAt = timestamp(access.policyObservedAt);
      const issuedAt = timestamp(access.tokenIssuedAt);
      const expiresAt = timestamp(access.tokenExpiresAt);
      const revokedAt = timestamp(access.tokenRevokedAt);
      if (!(observedAt <= issuedAt
          && issuedAt < expiresAt
          && expiresAt - issuedAt <= 65 * 60 * 1000)) {
        fail(`${label} policy observation and token lifetime violate the audited policy`);
      }
      if ((access.tokenRevokedAt === null) !== (access.revocationEvidenceReference === null)) {
        fail(`${label} token revocation timestamp and evidence must be recorded together`);
      }
      if (access.tokenRevokedAt !== null && !(issuedAt <= revokedAt && revokedAt <= expiresAt)) {
        fail(`${label} token revocation must fall within the token lifetime`);
      }
      return { observedAt, issuedAt, expiresAt, revokedAt };
    };

    readAccess = validateAccess(app.readAccess, "read", "App read access");
    writeAccess = object(app.writeAccess)
      ? validateAccess(app.writeAccess, "write", "App write access")
      : null;
    if (run.publicationMode === "preview"
        && !authorization.allowedActions.includes("private_preview_app_install")) {
      fail("preview App installation was not authorized before the run");
    }
    if (run.publicationMode === "preview") {
      if (app.writeAccess !== null) fail("preview mode must not record App write access");
      if (!(authApprovedAt <= readAccess.observedAt
          && readAccess.issuedAt <= previewCompletedAt
          && previewCompletedAt <= readAccess.expiresAt
          && (Number.isNaN(readAccess.revokedAt) || previewCompletedAt <= readAccess.revokedAt))) {
        fail("preview App read-access evidence does not cover the authorized preview");
      }
    }
    if (run.publicationMode === "publish") {
      const attemptedAt = timestamp(run.publicationAttemptedAt);
      if (!(readAccess.issuedAt <= attemptedAt
          && attemptedAt <= readAccess.expiresAt
          && (Number.isNaN(readAccess.revokedAt) || attemptedAt <= readAccess.revokedAt))) {
        fail("publication App read-access evidence does not cover the publication attempt");
      }
      if (run.publicationStatus === "pr_opened" && !object(app.writeAccess)) {
        fail("pr_opened requires audited App write access");
      }
      if (run.publicationStatus !== "pr_opened" && object(app.writeAccess)) {
        fail(`${run.publicationStatus} must not record App write access`);
      }
      if (writeAccess
          && !(readAccess.issuedAt <= writeAccess.issuedAt
            && writeAccess.issuedAt <= attemptedAt
            && attemptedAt <= writeAccess.expiresAt
            && (Number.isNaN(writeAccess.revokedAt) || attemptedAt <= writeAccess.revokedAt))) {
        fail("publication App write-access evidence does not cover the publication attempt");
      }
    }
  }

  const rulesets = controls.rulesets;
  let rulesetSnapshot;
  if (object(rulesets)) {
    same(rulesets.repository, repository.slug, "rulesets repository", fail);
    same(rulesets.repositoryId, repository.repositoryId, "rulesets repositoryId", fail);
    if (rulesets.migrationRefRulesetId === rulesets.defaultBranchRulesetId) {
      fail("migration and default-branch ruleset IDs must be distinct");
    }
    try {
      rulesetSnapshot = JSON.parse(rulesets.configurationJson);
    } catch {
      fail("ruleset configuration snapshot must contain valid JSON");
    }
    same(
      rulesets.configurationDigest,
      createHash("sha256").update(rulesets.configurationJson).digest("hex"),
      "rulesets configurationDigest",
      fail
    );
    if (object(rulesetSnapshot)) {
      const migrationRef = rulesetSnapshot.migrationRef;
      const defaultBranch = rulesetSnapshot.defaultBranch;
      const exactTop = hasExactKeys(rulesetSnapshot, ["migrationRef", "defaultBranch"]);
      const exactMigration = hasExactKeys(migrationRef, [
        "enforcement",
        "target",
        "restrictCreation",
        "restrictUpdates",
        "restrictDeletion",
        "blockForcePush",
        "bypassActors",
      ]);
      const exactDefault = hasExactKeys(defaultBranch, [
        "enforcement",
        "target",
        "requirePullRequest",
        "blockDeletion",
        "blockForcePush",
        "bypassActors",
        "requiredChecks",
      ]);
      const bypass = Array.isArray(migrationRef?.bypassActors) ? migrationRef.bypassActors : [];
      const onlyExpectedBypass = bypass.length === 1
        && hasExactKeys(bypass[0], ["actorType", "actorId", "bypassMode"])
        && bypass[0].actorType === "Integration"
        && bypass[0].actorId === app?.appId
        && bypass[0].bypassMode === "always";
      if (!exactTop
          || !exactMigration
          || !exactDefault
          || migrationRef.enforcement !== "active"
          || migrationRef.target !== "refs/heads/codex/api-migrator/*"
          || migrationRef.restrictCreation !== true
          || migrationRef.restrictUpdates !== true
          || migrationRef.restrictDeletion !== true
          || migrationRef.blockForcePush !== true
          || !onlyExpectedBypass
          || defaultBranch.enforcement !== "active"
          || defaultBranch.target !== `refs/heads/${repository.baseBranch}`
          || defaultBranch.requirePullRequest !== true
          || defaultBranch.blockDeletion !== true
          || defaultBranch.blockForcePush !== true
          || !Array.isArray(defaultBranch.bypassActors)
          || defaultBranch.bypassActors.length !== 0) {
        fail("ruleset configuration snapshot does not enforce the pilot policy");
      }
      const observedAt = timestamp(rulesets.observedAt);
      if (run.publicationMode === "publish"
          && !(previewCompletedAt <= observedAt
            && observedAt <= timestamp(run.publicationAttemptedAt))) {
        fail("ruleset evidence must be observed after preview and before publication");
      }
      if (writeAccess
          && !(observedAt <= writeAccess.observedAt
            && writeAccess.observedAt <= writeAccess.issuedAt)) {
        fail("ruleset evidence must precede and bind App write-token issuance");
      }
      if (writeAccess
          && object(executionAttestation)
          && timestamp(executionAttestation.observedAt) > writeAccess.observedAt) {
        fail("trusted verification attestation must precede App write-access observation");
      }
    } else if (rulesetSnapshot !== undefined) {
      fail("ruleset configuration snapshot must encode an object");
    }
  }

  const requiredCi = controls.requiredCi;
  if (object(requiredCi)) {
    same(requiredCi.repository, repository.slug, "required CI repository", fail);
    same(requiredCi.repositoryId, repository.repositoryId, "required CI repositoryId", fail);
    const checkKeys = requiredCi.checks.map(
      (check) => `${check.workflow}\u0000${check.name}\u0000${check.integrationId}`
    );
    if (new Set(checkKeys).size !== checkKeys.length) fail("required CI identities must be unique");
    for (const check of requiredCi.checks) {
      if (check.conclusion !== "success") fail(`required CI check ${check.name} did not succeed`);
      if (!exactCiUrl(check.evidenceUrl, repository.slug)) {
        fail(`required CI check ${check.name} evidence URL must match the exact repository`);
      }
      if (Number.isFinite(timestamp(run.publicationAttemptedAt))
          && timestamp(check.observedAt) < timestamp(run.publicationAttemptedAt)) {
        fail(`required CI check ${check.name} was observed before publication`);
      }
    }
    const evidencedIdentities = requiredCi.checks.map(
      ({ name, workflow, integrationId }) => ({ name, workflow, integrationId })
    );
    if (canonicalJson(orderedCiIdentities(evidencedIdentities))
        !== canonicalJson(orderedCiIdentities(authorization.requiredCi))) {
      fail("required-CI evidence does not match the authorized workflow/check identities");
    }
    if (object(rulesetSnapshot)) {
      const configured = Array.isArray(rulesetSnapshot.defaultBranch?.requiredChecks)
        ? orderedCiIdentities(rulesetSnapshot.defaultBranch.requiredChecks)
        : [];
      if (canonicalJson(configured) !== canonicalJson(orderedCiIdentities(evidencedIdentities))) {
        fail("ruleset required checks do not match the required-CI evidence");
      }
    }
  }

  const verification = run.verification;
  same(verification.runner, runner.profile, "verification runner", fail);
  const verificationStatuses = REQUIRED_CHECKS.map((name) => verification.checks[name].status);
  const expectedVerificationOverall = verificationStatuses.includes("failed")
    ? "failed"
    : verificationStatuses.some((status) => status !== "passed")
      ? "skipped"
      : "passed";
  same(verification.overall, expectedVerificationOverall, "verification overall", fail);
  for (const name of REQUIRED_CHECKS) {
    if (!populated(verification.checks[name].evidenceReference)) fail(`${name} evidence is required`);
  }
  if (object(executionAttestation)) {
    for (const name of REQUIRED_CHECKS) {
      const attested = executionAttestation.checks?.[name];
      if (!hasExactKeys(attested, ["status", "evidenceReference"])) {
        fail(`runner attestation ${name} check must use the exact audited shape`);
        continue;
      }
      same(attested.status, verification.checks[name].status, `runner attestation ${name} status`, fail);
      same(
        attested.evidenceReference,
        verification.checks[name].evidenceReference,
        `runner attestation ${name} evidenceReference`,
        fail
      );
    }
    const attestedAt = timestamp(executionAttestation.observedAt);
    if (!(previewCompletedAt <= attestedAt
        && (!Number.isFinite(timestamp(run.publicationAttemptedAt))
          || attestedAt <= timestamp(run.publicationAttemptedAt)))) {
      fail("runner execution attestation must be observed after all attested checks");
    }
  }

  if (review.candidateSites !== review.truePositives + review.falsePositives) {
    fail("candidateSites must equal truePositives plus falsePositives");
  }

  const findings = run.manualReviewFindings;
  const resolutions = run.manualReviewResolutions;
  if (run.reviewItems !== findings.length) fail("reviewItems must equal the number of manual-review findings");
  const findingIds = findings.map((finding) => finding.findingId);
  if (new Set(findingIds).size !== findingIds.length) fail("manual-review finding IDs must be unique");
  for (const finding of findings) {
    if (finding.findingId !== deriveFindingId(finding)) fail(`manual-review finding ${finding.findingId} has an invalid stable identity`);
  }
  const findingsById = new Map(findings.map((finding) => [finding.findingId, finding]));
  const resolutionIds = resolutions.map((resolution) => resolution.findingId);
  if (new Set(resolutionIds).size !== resolutionIds.length) fail("each manual-review finding may have only one resolution");
  for (const resolution of resolutions) {
    const finding = findingsById.get(resolution.findingId);
    if (!finding || finding.code !== resolution.code) {
      fail(`manual-review resolution ${resolution.findingId} does not match a finding`);
    }
  }
  if (review.unresolvedReviewItems !== findings.length - new Set(resolutionIds).size) {
    fail("unresolvedReviewItems must equal findings without a resolution");
  }

  const blockers = run.blockers;
  const blockerCodes = blockers.map((item) => item.code);
  if (run.publicationStatus === "blocked" && blockers.length === 0) fail("blocked status requires a blocker");
  if (run.publicationStatus === "preview_ready" && blockers.length > 0) {
    fail("preview_ready cannot retain publication blockers");
  }
  if (expectedVerificationOverall !== "passed" && run.publicationStatus !== "blocked") {
    fail("failed or skipped verification requires blocked publication status");
  }
  const expectedVerificationBlocker = expectedVerificationOverall === "failed"
    ? "verification_failed"
    : expectedVerificationOverall === "skipped"
      ? "verification_skipped"
      : null;
  if (expectedVerificationBlocker && !blockerCodes.includes(expectedVerificationBlocker)) {
    fail(`${expectedVerificationOverall} verification requires a ${expectedVerificationBlocker} blocker`);
  }
  if (expectedVerificationOverall === "passed"
      && blockerCodes.some((code) => code === "verification_failed" || code === "verification_skipped")) {
    fail("passed verification cannot retain a verification blocker");
  }
  if (findings.length > 0 && !blockerCodes.includes("manual_review_required")) {
    fail("manual-review findings require a manual_review_required blocker");
  }
  if (run.overrideUnsafe !== false || run.overrideReason !== null) {
    fail("publication overrides are disabled");
  }
  if (run.publicationStatus === "pr_opened" && blockers.length > 0) {
    fail("pr_opened cannot retain publication blockers");
  }

  const publicationApproval = authorization.postPreviewPublication;
  if (run.publicationMode === "publish") {
    if (run.publicationStatus === "preview_ready") fail("publish mode cannot use preview_ready status");
    if (!OPERATOR.test(run.approvedBy ?? "")) fail("publish mode requires a valid operator identity");
    if (!object(publicationApproval)) {
      fail("publish mode requires exact post-preview owner approval");
    } else {
      const publicationBindings = [
        ["authorizationReference", authorization.reference],
        ["pilotId", record.pilotId],
        ["repository", repository.slug],
        ["repositoryId", repository.repositoryId],
        ["baseBranch", repository.baseBranch],
        ["baseSha", repository.baseSha],
        ["provider", campaign.provider],
        ["transformSet", campaign.transformSet],
        ["engineTag", campaign.engineTag],
        ["engineCommit", campaign.engineCommit],
        ["manifestDigest", campaign.manifestDigest],
        ["preflightId", run.preflightId],
        ["artifactDigest", run.artifactDigest],
        ["candidateBranch", run.candidateBranch],
        ["findingsDigest", digestFindingSet(findings)],
        ["resolutionsDigest", digestResolutionSet(resolutions)],
        ["requiredCiDigest", authorization.requiredCiDigest],
      ];
      for (const [field, expected] of publicationBindings) {
        same(publicationApproval[field], expected, `owner publication approval ${field}`, fail);
      }
      for (const action of POST_PUBLICATION_ACTIONS) {
        if (!publicationApproval.allowedActions.includes(action)) fail(`owner publication approval is missing ${action}`);
      }
      const approvedAt = timestamp(publicationApproval.approvedAt);
      const expiresAt = timestamp(publicationApproval.expiresAt);
      const attemptedAt = timestamp(run.publicationAttemptedAt);
      if (!(previewCompletedAt <= approvedAt
          && approvedAt <= attemptedAt
          && attemptedAt <= expiresAt
          && attemptedAt <= authExpiresAt)) {
        fail("publication attempt must follow preview and fall within both authorization windows");
      }
      if (object(app)
          && !(approvedAt <= readAccess.observedAt
            && readAccess.observedAt <= readAccess.issuedAt)) {
        fail("publication App read access must be observed and issued only after owner approval");
      }
      if (writeAccess
          && !(approvedAt <= writeAccess.observedAt
            && writeAccess.observedAt <= writeAccess.issuedAt)) {
        fail("publication App write access must be observed and issued only after owner approval");
      }
      if (object(rulesets) && timestamp(rulesets.observedAt) < approvedAt) {
        fail("publication ruleset evidence must be observed only after owner approval");
      }
      if (object(executionAttestation)
          && timestamp(executionAttestation.observedAt) < approvedAt) {
        fail("publication execution attestation must be observed only after owner approval");
      }
    }
    if (review.unresolvedReviewItems !== 0 || resolutions.length !== findings.length) {
      fail("publish mode requires one resolution for every manual-review finding");
    }
  } else {
    if (run.approvedBy !== null) fail("preview mode must not record operator publication approval");
    if (run.publicationAttemptedAt !== null) fail("preview mode must not record a publication attempt");
    if (run.publicationStatus === "pr_opened") fail("preview mode cannot open a PR");
  }

  if (run.publicationStatus === "pr_opened") {
    if (run.publicationMode !== "publish") fail("pr_opened requires publish mode");
    if (verification.overall !== "passed") fail("pr_opened requires passed verification");
    if (!SHA.test(run.approvedHeadSha ?? "")) fail("pr_opened requires an approved head SHA");
    if (blockerCodes.includes("verification_failed") || blockerCodes.includes("verification_skipped")) {
      fail("pr_opened cannot retain a verification blocker");
    }
    if (!object(app) || !object(app.writeAccess) || !object(rulesets) || !object(requiredCi)) {
      fail("pr_opened requires App, ruleset, and required-CI evidence");
    } else if (requiredCi.headSha !== run.approvedHeadSha) {
      fail("required CI head must match the approved head");
    }
  }

  if (outcome.pullRequestState === "not_opened") {
    if (outcome.prUrl !== null || outcome.currentHeadSha !== null || outcome.mergeCommitSha !== null) {
      fail("not_opened outcome cannot have PR or commit identity");
    }
  } else {
    if (!exactPrUrl(outcome.prUrl, repository.slug)) fail("PR URL must match the exact repository");
    if (!SHA.test(outcome.currentHeadSha ?? "")) fail("PR outcome requires a current head SHA");
    if (outcome.currentHeadSha !== run.approvedHeadSha) fail("current PR head must match the approved head");
    if (run.publicationStatus !== "pr_opened") fail("a PR outcome requires pr_opened publication evidence");
  }
  if (outcome.pullRequestState === "merged") {
    if (outcome.ownerDisposition !== "accepted") fail("merged outcome requires owner acceptance");
    if (!SHA.test(outcome.mergeCommitSha ?? "")) fail("merged outcome requires a merge commit SHA");
  } else if (outcome.mergeCommitSha !== null) {
    fail("only a merged outcome may record a merge commit SHA");
  }

  const outcomeObservedAt = timestamp(outcome.observedAt);
  const actionTimes = [previewCompletedAt];
  if (Number.isFinite(timestamp(run.publicationAttemptedAt))) {
    actionTimes.push(timestamp(run.publicationAttemptedAt));
  }
  if (object(requiredCi)) {
    actionTimes.push(...requiredCi.checks.map((check) => timestamp(check.observedAt)));
  }
  if (object(executionAttestation)) {
    actionTimes.push(timestamp(executionAttestation.observedAt));
  }
  if (outcomeObservedAt < Math.max(...actionTimes)) {
    fail("outcome must be observed after every recorded run and CI action");
  }
  const auditObservedAt = timestamp(audit.observedAt);
  if (auditObservedAt < outcomeObservedAt) {
    fail("trusted audit observation cannot precede the recorded outcome");
  }

  const kinds = cleanup.locations.map((item) => item.kind);
  for (const kind of CLEANUP_KINDS) {
    if (!kinds.includes(kind)) fail(`cleanup location ${kind} is required`);
  }
  if (new Set(kinds).size !== kinds.length) fail("cleanup location kinds must be unique");
  const cleanupDeadlineByKind = {
    github_access: "githubAccess",
    runner_storage: "runnerStorage",
    pilot_database: "pilotDatabase",
    logs_exports_backups: "logsExportsBackups",
    authorization_feedback: "authorizationFeedback",
  };
  const cleanupTargetByKind = {
    github_access: object(app)
      ? `github-installation:${app.installationId}:repository:${repository.repositoryId}`
      : `github-access:none:repository:${repository.repositoryId}`,
    runner_storage: `runner:${record.pilotId}`,
    pilot_database: `database:${record.pilotId}`,
    logs_exports_backups: `records:${record.pilotId}`,
    authorization_feedback: `authorization:${record.pilotId}`,
  };
  const publicationAttemptedAt = timestamp(run.publicationAttemptedAt);
  const appLastUseTimes = [previewCompletedAt];
  if (object(app) && run.publicationMode === "publish") appLastUseTimes.push(publicationAttemptedAt);
  if (readAccess && Number.isFinite(readAccess.revokedAt)) appLastUseTimes.push(readAccess.revokedAt);
  if (writeAccess && Number.isFinite(writeAccess.revokedAt)) appLastUseTimes.push(writeAccess.revokedAt);
  const runnerLastUseTimes = [
    object(executionAttestation) ? timestamp(executionAttestation.observedAt) : previewCompletedAt,
  ];
  if (Number.isFinite(publicationAttemptedAt)) runnerLastUseTimes.push(publicationAttemptedAt);
  const cleanupLowerBoundByKind = {
    github_access: Math.max(...appLastUseTimes),
    runner_storage: Math.max(...runnerLastUseTimes),
    pilot_database: outcomeObservedAt,
    logs_exports_backups: outcomeObservedAt,
    authorization_feedback: outcomeObservedAt,
  };
  for (const item of cleanup.locations) {
    if (!safeTargetReference(item.targetReference)) fail("cleanup target references must be exact, non-shell identifiers");
    same(item.targetReference, cleanupTargetByKind[item.kind], `cleanup ${item.kind} targetReference`, fail);
    const authorizedDeleteBy = timestamp(authorization.cleanupDeadlines[cleanupDeadlineByKind[item.kind]]);
    same(
      item.authorizedDeleteBy,
      authorization.cleanupDeadlines[cleanupDeadlineByKind[item.kind]],
      `cleanup ${item.kind} authorizedDeleteBy`,
      fail
    );
    const lowerBound = cleanupLowerBoundByKind[item.kind];
    if (authorizedDeleteBy < lowerBound) {
      fail(`cleanup ${item.kind} deadline cannot precede that target's last use`);
    }
    if (item.status === "pending") {
      if (item.completedAt !== null || item.evidenceReference !== null || item.exception !== null) {
        fail("pending cleanup must not claim completion or exception evidence");
      }
      if (!(auditObservedAt < authorizedDeleteBy)) {
        fail(`pending cleanup ${item.kind} is overdue at the trusted audit observation`);
      }
    } else {
      const completedAt = timestamp(item.completedAt);
      if (!Number.isFinite(completedAt) || !populated(item.evidenceReference)) {
        fail("deleted, retained, or unverifiable cleanup requires timestamp and evidence");
      }
      if (!(lowerBound <= completedAt
          && completedAt <= authorizedDeleteBy
          && completedAt <= auditObservedAt)) {
        fail(`cleanup ${item.kind} completion must follow last use, meet its deadline, and precede the audit`);
      }
      if (item.status === "deleted" && item.exception !== null) {
        fail("deleted cleanup must not record an exception");
      }
      if (["retained_by_owner", "unverifiable"].includes(item.status) && !object(item.exception)) {
        fail("retained or unverifiable cleanup requires exception authority, reason, and evidence");
      }
    }
    if (item.kind === "github_access" && item.status === "deleted" && object(app)) {
      const accessPhases = [readAccess, ...(writeAccess ? [writeAccess] : [])];
      if (accessPhases.some((access) => !Number.isFinite(access.revokedAt))) {
        fail("deleted GitHub access requires revocation evidence for every issued App token");
      }
    }
  }
  if (cleanup.status === "complete") {
    if (cleanup.locations.some((item) => item.status !== "deleted")) fail("complete cleanup requires every location to be deleted");
    if (!populated(cleanup.confirmationReference)) fail("complete cleanup requires confirmation evidence");
  } else if (cleanup.status === "complete_with_exceptions") {
    if (cleanup.locations.some((item) => item.status === "pending")) fail("complete_with_exceptions cannot contain pending locations");
    if (!cleanup.locations.some((item) => ["retained_by_owner", "unverifiable"].includes(item.status))) {
      fail("complete_with_exceptions requires a retained or unverifiable location");
    }
    if (!populated(cleanup.confirmationReference)) fail("complete_with_exceptions requires confirmation evidence");
  } else if (cleanup.confirmationReference !== null) {
    fail("pending cleanup must not claim final confirmation");
  }

  return errors;
}

async function main(paths) {
  if (paths.length === 0) throw new Error("Usage: npm run pilot:validate -- path/to/pilot-result.json [...]");
  let failed = false;
  for (const path of paths) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path, "utf8"));
    } catch (error) {
      console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
      continue;
    }
    const errors = validatePilotResult(record);
    if (errors.length > 0) {
      console.error(`${path}: invalid pilot result`);
      for (const error of errors) console.error(`- ${error}`);
      failed = true;
    } else {
      console.log(`${path}: valid pilot result`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
