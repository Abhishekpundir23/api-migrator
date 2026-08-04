import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { MigrationReport } from "@api-migrator/engine";
import {
  buildExpectedOwnerAuthorizationBindings,
  ownerAuthorizedRemoteAction,
  readOwnerPublicationPolicy,
} from "../src/owner-publication-policy.js";

const NOW = 2_000_000_000_000;
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const env = {
  API_MIGRATOR_OWNER_KEY_REGISTRY_PATH: "/outside/owner-registry.json",
  API_MIGRATOR_PILOT_ID: "pilot-sandbox-v1",
  API_MIGRATOR_APPROVAL_EVIDENCE_DIGEST: hash("approval"),
  API_MIGRATOR_PRE_RUN_AUTHORIZATION_DIGEST: hash("pre-run"),
  API_MIGRATOR_PRE_RUN_AUTHORIZATION_EXPIRES_AT: String(NOW + 60_000),
  API_MIGRATOR_ENGINE_TAG: "v0.1.0-pilot",
  API_MIGRATOR_ENGINE_COMMIT: "a".repeat(40),
  API_MIGRATOR_COMMAND_SCOPE_DIGEST: hash("commands"),
  API_MIGRATOR_RULESET_DIGEST: hash("ruleset"),
  API_MIGRATOR_REQUIRED_CI_DIGEST: hash("ci"),
};

const report = {
  entries: [],
} as unknown as MigrationReport;

test("owner publication policy requires every independently pinned safety artifact", () => {
  const policy = readOwnerPublicationPolicy(env, NOW);
  assert.equal(policy.engineCommit, "a".repeat(40));
  assert.equal("runnerAttestationDigest" in policy, false);
  for (const name of Object.keys(env)) {
    const missing = { ...env } as Record<string, string | undefined>;
    delete missing[name];
    assert.throws(() => readOwnerPublicationPolicy(missing, NOW), /requires/);
  }
  assert.throws(
    () => readOwnerPublicationPolicy({ ...env, API_MIGRATOR_PRE_RUN_AUTHORIZATION_EXPIRES_AT: String(NOW) }, NOW),
    /expired/
  );
  assert.throws(
    () => readOwnerPublicationPolicy({
      ...env,
      API_MIGRATOR_RUNNER_ATTESTATION_DIGEST: hash("unverified-runner"),
    }, NOW),
    /rejects raw API_MIGRATOR_RUNNER_ATTESTATION_DIGEST/
  );
});

test("remote actions are exact and state-specific", () => {
  assert.deepEqual(
    ownerAuthorizedRemoteAction({ sha: null, pullRequest: null, pushRequired: true }),
    { allowedActions: ["create_branch", "create_pull_request"], pullRequestNumber: null }
  );
  assert.deepEqual(
    ownerAuthorizedRemoteAction({ sha: "b".repeat(40), pullRequest: null, pushRequired: false }),
    { allowedActions: ["create_pull_request"], pullRequestNumber: null }
  );
  assert.deepEqual(
    ownerAuthorizedRemoteAction({
      sha: "b".repeat(40),
      pullRequest: { number: 42, htmlUrl: "https://github.com/o/r/pull/42", baseBranch: "main" },
      pushRequired: false,
    }),
    { allowedActions: ["update_pull_request"], pullRequestNumber: 42 }
  );
  assert.throws(
    () => ownerAuthorizedRemoteAction({ sha: "b".repeat(40), pullRequest: null, pushRequired: true }),
    /inconsistent/
  );
});

test("runtime bindings refuse an unverified runner digest or structural placeholder", () => {
  const manifestJson = '{"name":"exact"}\n';
  assert.throws(
    () => buildExpectedOwnerAuthorizationBindings({
      policy: readOwnerPublicationPolicy(env, NOW),
      runnerAttestation: undefined,
      previewCompletedAt: NOW - 1_000,
      repositorySlug: "Owner/Repo",
      github: {
        appId: 123,
        appSlug: "api-migrator",
        installationId: 456,
        repositoryId: 789,
        repositoryOwnerId: 987,
        repositorySlug: "Owner/Repo",
      },
      baseBranch: "main",
      baseSha: "c".repeat(40),
      manifestJson,
      preflightId: `pf_${"d".repeat(64)}`,
      artifactDigest: "e".repeat(64),
      candidateBranch: "codex/api-migrator/exact",
      candidateTreeSha: "f".repeat(40),
      report,
      remote: { sha: null, pullRequest: null, pushRequired: true },
    }),
    /genuinely verified runner attestation/
  );
});
