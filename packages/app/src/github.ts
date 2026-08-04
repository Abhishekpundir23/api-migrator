/** Secure preview-and-publish workflow for one GitHub repository. */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Manifest,
  runMigration,
  reportToMarkdown,
  type MigrationReport,
  type RunMigrationOptions,
} from "@api-migrator/engine";
import {
  readAuthConfig,
  resolveAuthorizedWriteAuth,
  resolveReadAuth,
  resolveOptionalReadAuth,
  type AuthMode,
  type AuthResult,
} from "./auth.js";
import {
  applyVerifiedArtifact,
  assertAppliedArtifact,
  copyGitFreeTree,
  inspectVerifiedArtifact,
  type VerifiedArtifact,
} from "./artifact.js";
import {
  assertPublicationAllowed,
  assertRemoteBranchMatchesArtifact,
  createNoChangesOutcome,
  createPreflightId,
  PublicationAttemptError,
  publicationBlockers,
  validatePublicationRequest,
  type OpenPullRequestIdentity,
  type PublicationAttemptAudit,
  type PublicationOutcome,
  type PublicationRequest,
} from "./publication.js";
import {
  githubCloneUrl,
  githubCloneArgs,
  githubDefaultCloneArgs,
  parseRepositorySlug,
  resolveMigrationBranch,
  stableStringify,
  validateBranchName,
  type GitHubRepository,
} from "./repository.js";
import { sanitizeMigrationReport } from "./report.js";
import {
  buildExpectedOwnerAuthorizationBindings,
  readOwnerPublicationPolicy,
  type RemotePublicationState,
} from "./owner-publication-policy.js";
import { verifyOwnerAuthorizationEnvelope } from "./owner-authorization.js";
import type { OwnerAuthorizationChallengeArtifact } from "./owner-challenge.js";
import {
  prepareOwnerAuthorizationChallenge,
  validateOwnerChallengePreparationRequest,
  type OwnerChallengePreparationRequest,
} from "./owner-challenge-preparation.js";
import type { VerifiedPublicationRunnerAttestation } from "./publication-runner.js";
import {
  createAskPassScript,
  gitAuthenticationEnv,
  safeErrorMessage,
  sanitizedExecutionEnv,
} from "./security.js";

export interface MigrateRepoInput {
  /** Exact `owner/repo` slug. The clone URL is always derived internally. */
  slug: string;
  manifest: Manifest;
  /** Exact manifest JSON bytes bound into owner authorization. */
  manifestJson?: string;
  /** Optional explicit base; otherwise GitHub's current default branch is used. */
  baseBranch?: string;
  /** Optional exact content-addressed branch override returned by preview. */
  branch?: string;
  /** Omitted means preview. Publication is never the default. */
  publication?: PublicationRequest;
  /**
   * Internal console-only request to rerun and bind one authenticated preview
   * into a read-only owner challenge. It is mutually exclusive with publish.
   */
  ownerChallenge?: OwnerChallengePreparationRequest;
  /**
   * Internal in-process capability returned by verifyPublicationRunnerAttestation.
   * The console does not currently provide one, so owner challenge and publish
   * remain fail-closed until the trusted control plane is wired.
   */
  runnerAttestation?: VerifiedPublicationRunnerAttestation;
}

export interface MigrateRepoResult {
  report: MigrationReport;
  prUrl: string | null;
  changed: boolean;
  preflightId: string;
  artifactDigest: string;
  publication: PublicationOutcome;
  /** Present only on the internal, read-only owner-challenge path. */
  ownerChallenge?: OwnerAuthorizationChallengeArtifact;
  error?: string;
}

class CreatedPullRequestMismatchError extends Error {
  override readonly name = "CreatedPullRequestMismatchError";

  constructor(
    message: string,
    readonly pullRequestNumber: number,
    readonly prUrl: string
  ) {
    super(message);
  }
}

export function publicationRequiresAuthentication(request: PublicationRequest): boolean {
  return request.mode === "publish";
}

/**
 * Generate an isolated preview or, after exact operator approval, reconcile a
 * migration branch and pull request. Nothing is ever automatically merged.
 */
export async function migrateRepo(input: MigrateRepoInput): Promise<MigrateRepoResult> {
  const repository = parseRepositorySlug(input.slug);
  const manifestJson = exactManifestJson(input.manifest, input.manifestJson);
  const publication = validatePublicationRequest(input.publication);
  const ownerChallenge = input.ownerChallenge === undefined
    ? null
    : validateOwnerChallengePreparationRequest(input.ownerChallenge);
  if (ownerChallenge !== null && publication.mode !== "preview") {
    throw new Error("Owner challenge preparation is mutually exclusive with publication");
  }
  // Challenge preparation is an App-bound owner ceremony. Reject gh-cli
  // before resolving any credential, querying GitHub, or cloning a repository;
  // an ambient user PAT must never cross this boundary.
  if (ownerChallenge !== null && readAuthConfig().mode !== "github-app") {
    throw new Error("Owner challenge preparation requires GitHub App authentication");
  }
  const requestedBase = input.baseBranch ? validateBranchName(input.baseBranch) : undefined;
  const workdir = mkdtempSync(join(tmpdir(), "api-migrator-"));
  const isolatedHome = join(workdir, "home");
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  let auth: AuthResult | null = null;
  const authTokens: string[] = [];
  const authSessions: AuthResult[] = [];

  try {
    const trustedHostEnvironment = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TZ: process.env.TZ,
    };
    // Credentialed GitHub operations do not inherit ambient proxies, custom
    // certificate authorities, Git config, or language preloads.
    const cleanEnv = sanitizedExecutionEnv(isolatedHome, trustedHostEnvironment);
    const repositoryEnv = sanitizedExecutionEnv("/tmp", trustedHostEnvironment);
    const repoPath = join(workdir, "repo");

    let baseBranch: string;
    let gitEnv: NodeJS.ProcessEnv | null = null;
    if (publicationRequiresAuthentication(publication) || ownerChallenge !== null) {
      auth = await resolveReadAuth(repository.slug);
      if (
        ownerChallenge !== null &&
        (auth.mode !== "github-app" || auth.capability !== "read" || auth.githubApp === null)
      ) {
        throw new Error("Owner challenge preparation requires GitHub App read authentication");
      }
      authTokens.push(auth.token);
      authSessions.push(auth);
      baseBranch = requestedBase ?? (await discoverDefaultBranch(auth, repository));
      validateBranchName(baseBranch);
      const askPassPath = createAskPassScript(workdir);
      gitEnv = gitAuthenticationEnv(auth.token, askPassPath, cleanEnv);
      gitExec(githubCloneArgs(repository, baseBranch), workdir, gitEnv, [auth.token]);
    } else {
      let anonymousCloneError: unknown;
      try {
        gitExec(
          requestedBase ? githubCloneArgs(repository, requestedBase) : githubDefaultCloneArgs(repository),
          workdir,
          cleanEnv
        );
      } catch (error) {
        anonymousCloneError = error;
      }

      if (anonymousCloneError) {
        // Preview remains credential-free for public repositories. A private
        // repository can fall back only to an explicitly selected auth mode.
        auth = await resolveOptionalReadAuth(repository.slug);
        if (!auth) {
          throw new Error(
            `Public preview clone failed; private repositories require explicitly configured authentication: ${safeErrorMessage(anonymousCloneError)}`
          );
        }
        authTokens.push(auth.token);
        authSessions.push(auth);
        rmSync(repoPath, { recursive: true, force: true });
        baseBranch = requestedBase ?? (await discoverDefaultBranch(auth, repository));
        validateBranchName(baseBranch);
        const askPassPath = createAskPassScript(workdir);
        gitEnv = gitAuthenticationEnv(auth.token, askPassPath, cleanEnv);
        gitExec(githubCloneArgs(repository, baseBranch), workdir, gitEnv, [auth.token]);
      } else {
        baseBranch = requestedBase ?? gitExec(["symbolic-ref", "--quiet", "--short", "HEAD"], repoPath, cleanEnv).trim();
        validateBranchName(baseBranch);
      }
    }

    const baseSha = gitExec(["rev-parse", "HEAD"], repoPath, cleanEnv).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha)) throw new Error("Git returned an invalid base commit id");

    // Repository-controlled compilers/tests/lint never see the live clone or
    // its .git directory. The resulting tree is inspected before transfer.
    const proposedPath = join(workdir, "verified-tree");
    copyGitFreeTree(repoPath, proposedPath);

    const verify = {
      install: true,
      runTests: true,
      runLint: true,
      lifecycleScripts: false,
      runner: "docker",
      env: repositoryEnv,
    } satisfies NonNullable<RunMigrationOptions["verify"]>;
    const { report: engineReport } = await runMigration(input.manifest, proposedPath, {
      writeChanges: true,
      skipVerify: false,
      verify,
    });

    const artifact = inspectVerifiedArtifact(repoPath, proposedPath, engineReport.changedFiles);
    const branch = resolveMigrationBranch(
      input.manifest,
      baseBranch,
      baseSha,
      artifact.digest,
      input.branch
    );
    const changed = artifact.files.length > 0;
    // Everything leaving the engine uses the safe boundary copy. Artifact
    // inspection intentionally retains the engine's exact existing semantics.
    const report = sanitizeMigrationReport(engineReport);
    const blockers = publicationBlockers(report);

    // Compute the exact candidate tree during preview as well as publication.
    // This mutates only the disposable clone and lets owner approval bind the
    // Git tree before any write credential exists.
    let candidateTreeSha = gitExec(["rev-parse", "HEAD^{tree}"], repoPath, cleanEnv).trim();
    if (changed) {
      applyVerifiedArtifact(repoPath, proposedPath, artifact);
      assertAppliedArtifact(repoPath, proposedPath, artifact);
      stageVerifiedArtifact(repoPath, artifact, cleanEnv);
      candidateTreeSha = gitExec(["write-tree"], repoPath, cleanEnv).trim();
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidateTreeSha)) {
      throw new Error("Git returned an invalid candidate tree id");
    }

    const preflightId = createPreflightId({
      slug: repository.slug,
      baseBranch,
      baseSha,
      targetBranch: branch,
      candidateTreeSha,
      artifactDigest: artifact.digest,
      manifest: input.manifest,
      report,
    });
    const previewCompletedAt = publication.mode === "publish"
      ? publication.previewCompletedAt
      : ownerChallenge?.previewCompletedAt ?? Date.now();

    const common = {
      preflightId,
      baseBranch,
      baseSha,
      branch,
      candidateTreeSha,
      previewCompletedAt,
      artifactDigest: artifact.digest,
      blockers,
    };

    if (!changed) {
      if (ownerChallenge !== null) {
        throw new Error("Owner challenge is unavailable because the reviewed preview has no changes");
      }
      return {
        report,
        prUrl: null,
        changed: false,
        preflightId,
        artifactDigest: artifact.digest,
        publication: createNoChangesOutcome(publication, common),
      };
    }

    if (publication.mode === "preview" && ownerChallenge === null) {
      return {
        report,
        prUrl: null,
        changed: true,
        preflightId,
        artifactDigest: artifact.digest,
        publication: {
          ...common,
          mode: "preview",
          status: blockers.length === 0 ? "preview_ready" : "blocked",
          overridden: false,
        },
      };
    }

    if (ownerChallenge !== null) {
      if (!auth || !gitEnv) throw new Error("Owner challenge preparation requires resolved GitHub authentication");
      if (auth.mode !== "github-app" || auth.githubApp === null) {
        throw new Error("Owner challenge preparation requires GitHub App authentication");
      }
      assertCanonicalRemote(repoPath, repository, cleanEnv);
      const reviewedRemote = await inspectRemotePublicationState(
        auth,
        repository,
        branch,
        baseBranch,
        baseSha,
        candidateTreeSha
      );
      const ownerPolicy = readOwnerPublicationPolicy();
      const expectedOwnerBindings = buildExpectedOwnerAuthorizationBindings({
        policy: ownerPolicy,
        runnerAttestation: input.runnerAttestation,
        previewCompletedAt: ownerChallenge.previewCompletedAt,
        repositorySlug: repository.slug,
        github: auth.githubApp,
        baseBranch,
        baseSha,
        manifestJson,
        preflightId,
        artifactDigest: artifact.digest,
        candidateBranch: branch,
        candidateTreeSha,
        report,
        remote: reviewedRemote,
      });
      const preparedChallenge = prepareOwnerAuthorizationChallenge({
        request: ownerChallenge,
        current: {
          preflightId,
          artifactDigest: artifact.digest,
          candidateTreeSha,
        },
        expected: expectedOwnerBindings,
        blockers,
      });
      return {
        report,
        prUrl: null,
        changed: true,
        preflightId,
        artifactDigest: artifact.digest,
        publication: {
          ...common,
          mode: "preview",
          status: "preview_ready",
          overridden: false,
        },
        ownerChallenge: preparedChallenge,
      };
    }

    if (publication.mode !== "publish") {
      throw new Error("Invalid owner publication state");
    }

    // A stale/mismatched preview is never overrideable.
    if (publication.preflightId !== preflightId) {
      assertPublicationAllowed(publication, preflightId, blockers);
    }
    if (blockers.length > 0) {
      return {
        report,
        prUrl: null,
        changed: true,
        preflightId,
        artifactDigest: artifact.digest,
        publication: {
          ...common,
          mode: "publish",
          status: "blocked",
          overridden: false,
          approvedBy: publication.approvedBy,
        },
      };
    }
    assertPublicationAllowed(publication, preflightId, blockers);

    if (!auth || !gitEnv) throw new Error("Publishing requires resolved GitHub authentication");
    if (auth.mode !== "github-app" || auth.githubApp === null) {
      throw new Error("Owner-authorized publication requires GitHub App authentication");
    }
    assertCanonicalRemote(repoPath, repository, cleanEnv);

    // Inspect the exact branch/PR state with the read-only token. The owner's
    // envelope authorizes only the resulting state-specific action set.
    const reviewedRemote = await inspectRemotePublicationState(
      auth,
      repository,
      branch,
      baseBranch,
      baseSha,
      candidateTreeSha
    );
    const ownerPolicy = readOwnerPublicationPolicy();
    const expectedOwnerBindings = buildExpectedOwnerAuthorizationBindings({
      policy: ownerPolicy,
      runnerAttestation: input.runnerAttestation,
      previewCompletedAt: publication.previewCompletedAt,
      repositorySlug: repository.slug,
      github: auth.githubApp,
      baseBranch,
      baseSha,
      manifestJson,
      preflightId,
      artifactDigest: artifact.digest,
      candidateBranch: branch,
      candidateTreeSha,
      report,
      remote: reviewedRemote,
    });
    const ownerGrant = verifyOwnerAuthorizationEnvelope(
      publication.ownerAuthorizationEnvelope,
      {
        expected: expectedOwnerBindings,
        expectedChallengeDigest: publication.ownerChallengeDigest,
        registryPath: ownerPolicy.registryPath,
      }
    );

    gitExec(["checkout", "-B", branch], repoPath, cleanEnv);
    if (gitExec(["write-tree"], repoPath, cleanEnv).trim() !== candidateTreeSha) {
      throw new Error("Candidate tree changed after owner-review preparation");
    }
    gitExec(
      [
        "-c",
        `user.name=${auth.actor}`,
        "-c",
        `user.email=${actorEmail(auth.actor)}`,
        "commit",
        "-m",
        commitMessage(input.manifest),
      ],
      repoPath,
      cleanEnv
    );
    const localCommitSha = gitExec(["rev-parse", "HEAD"], repoPath, cleanEnv).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(localCommitSha)) throw new Error("Git returned an invalid migration commit id");
    const expectedTreeSha = gitExec(["rev-parse", "HEAD^{tree}"], repoPath, cleanEnv).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedTreeSha)) throw new Error("Git returned an invalid migration tree id");
    if (expectedTreeSha !== candidateTreeSha) {
      throw new Error("Committed migration tree differs from the reviewed candidate tree");
    }

    // Mint write capability only after verification, blocker handling, exact
    // preflight approval, and creation of the local immutable artifact.
    const authorizedWrite = await resolveAuthorizedWriteAuth(repository.slug, {
      readAuth: auth,
      ownerGrant,
      expected: expectedOwnerBindings,
      registryPath: ownerPolicy.registryPath,
    });
    auth = authorizedWrite.auth;
    const ownerAuthorizationReceipt = authorizedWrite.ownerAuthorizationReceipt;
    authTokens.push(auth.token);
    authSessions.push(auth);
    const publishAskPassPath = createAskPassScript(workdir);
    gitEnv = gitAuthenticationEnv(auth.token, publishAskPassPath, cleanEnv);

    const remote = await inspectRemotePublicationState(
      auth,
      repository,
      branch,
      baseBranch,
      baseSha,
      expectedTreeSha
    );
    assertRemotePublicationStateUnchanged(reviewedRemote, remote);
    const expectedHeadSha = remote.pushRequired ? localCommitSha : remote.sha;
    if (!expectedHeadSha) throw new Error("Could not determine the expected migration branch head");

    const attemptAudit: PublicationAttemptAudit = {
      publicationMode: "publish",
      preflightId: publication.preflightId,
      artifactDigest: artifact.digest,
      baseSha,
      baseBranch,
      headSha: expectedHeadSha,
      branch,
      candidateTreeSha,
      ownerAuthorizationReceipt,
      publicationBlockers: blockers,
      approvedBy: publication.approvedBy,
      overrideUnsafe: false,
      report,
    };
    const body = reportToMarkdown(report) + publicationAuditFooter(
      auth.mode,
      publication.approvedBy,
      expectedHeadSha
    );
    if (remote.pushRequired) {
      const pushArgs = publicationPushArgs(repository, branch);
      gitExec(pushArgs, repoPath, gitEnv, [auth.token]);
    }
    const prUrl = await reconcilePrWithAudit(
      auth,
      repository,
      prTitle(input.manifest),
      body,
      remote.pullRequest,
      attemptAudit
    );

    return {
      report,
      prUrl,
      changed: true,
      preflightId,
      artifactDigest: artifact.digest,
      publication: {
        ...common,
        mode: "publish",
        status: "pr_opened",
        overridden: false,
        approvedBy: publication.approvedBy,
        headSha: expectedHeadSha,
        ownerAuthorizationReceipt,
      },
    };
  } catch (error) {
    const message = safeErrorMessage(error, authTokens);
    if (error instanceof PublicationAttemptError) {
      throw new PublicationAttemptError(message, error.audit);
    }
    throw new Error(message);
  } finally {
    await revokeInstallationTokens(authSessions);
    rmSync(workdir, { recursive: true, force: true });
  }
}

async function revokeInstallationTokens(authSessions: readonly AuthResult[]): Promise<void> {
  await Promise.allSettled(
    authSessions
      .filter((session) => session.mode === "github-app")
      .map((session) => session.octokit.request("DELETE /installation/token"))
  );
}

function gitExec(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  secrets: readonly string[] = []
): string {
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch (error) {
    const operation = args[0]?.replace(/[^a-z-]/gi, "") || "operation";
    throw new Error(`git ${operation} failed: ${safeErrorMessage(error, secrets)}`);
  }
}

function assertCanonicalRemote(
  repoPath: string,
  repository: GitHubRepository,
  env: NodeJS.ProcessEnv
): void {
  const expected = githubCloneUrl(repository);
  const actual = gitExec(["remote", "get-url", "origin"], repoPath, env).trim();
  if (actual !== expected) throw new Error("Repository origin changed after clone; refusing credentialed push");
}

function stageVerifiedArtifact(repoPath: string, artifact: VerifiedArtifact, env: NodeJS.ProcessEnv): void {
  for (const path of artifact.files) {
    const absolute = join(repoPath, path);
    if (!existsSync(absolute)) {
      gitExec(["update-index", "--remove", "--", path], repoPath, env);
      continue;
    }
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to stage non-regular path: ${path}`);
    const blob = gitExec(["hash-object", "-w", "--no-filters", "--", path], repoPath, env).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blob)) throw new Error(`Git returned an invalid blob id for ${path}`);
    const mode = stat.mode & 0o111 ? "100755" : "100644";
    gitExec(["update-index", "--add", "--cacheinfo", mode, blob, path], repoPath, env);
  }
  const staged = gitExec(["diff", "--cached", "--name-only", "-z", "--"], repoPath, env)
    .split("\0")
    .filter(Boolean)
    .sort();
  if (staged.join("\0") !== [...artifact.files].sort().join("\0")) {
    throw new Error("Git index does not match the verified artifact file set");
  }
}

async function discoverDefaultBranch(auth: AuthResult, repository: GitHubRepository): Promise<string> {
  try {
    const { data } = await auth.octokit.repos.get({ owner: repository.owner, repo: repository.repo });
    if (!data.default_branch) throw new Error("GitHub did not return a default branch");
    return data.default_branch;
  } catch (error) {
    throw new Error(`Could not discover repository default branch: ${safeErrorMessage(error, [auth.token])}`);
  }
}

export async function inspectRemotePublicationState(
  auth: AuthResult,
  repository: GitHubRepository,
  branch: string,
  baseBranch: string,
  expectedBaseSha: string,
  expectedTreeSha: string
): Promise<{ sha: string | null; pullRequest: OpenPullRequestIdentity | null; pushRequired: boolean }> {
  await assertRemoteBaseMatchesApproval(auth, repository, baseBranch, expectedBaseSha);
  let sha: string | null;
  try {
    const { data } = await auth.octokit.git.getRef({
      owner: repository.owner,
      repo: repository.repo,
      ref: `heads/${branch}`,
    });
    sha = data.object.sha;
  } catch (error) {
    if (httpStatus(error) === 404) return { sha: null, pullRequest: null, pushRequired: true };
    throw new Error(`Could not inspect migration branch: ${safeErrorMessage(error, [auth.token])}`);
  }

  try {
    const { data: commit } = await auth.octokit.git.getCommit({
      owner: repository.owner,
      repo: repository.repo,
      commit_sha: sha,
    });
    assertRemoteBranchMatchesArtifact(sha, {
      expectedBaseSha,
      expectedTreeSha,
      remoteCommitSha: commit.sha,
      remoteParentShas: commit.parents.map((parent) => parent.sha),
      remoteTreeSha: commit.tree.sha,
    });

    const { data: pulls } = await auth.octokit.pulls.list({
      owner: repository.owner,
      repo: repository.repo,
      state: "open",
      head: `${repository.owner}:${branch}`,
      per_page: 100,
    });
    const pullRequests = pulls.map((pull) => ({
      number: pull.number,
      htmlUrl: pull.html_url,
      baseBranch: pull.base.ref,
    }));
    const pullRequest = pullRequests.find((pull) => pull.baseBranch === baseBranch) ?? null;
    return { sha, pullRequest, pushRequired: false };
  } catch (error) {
    throw new Error(`Could not verify immutable migration branch: ${safeErrorMessage(error, [auth.token])}`);
  }
}

export async function reconcilePr(
  auth: AuthResult,
  repository: GitHubRepository,
  head: string,
  base: string,
  title: string,
  body: string,
  current: OpenPullRequestIdentity | null,
  expectedHeadSha: string,
  expectedBaseSha: string
): Promise<string> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedHeadSha)) {
    throw new Error("Invalid expected migration commit id");
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedBaseSha)) {
    throw new Error("Invalid expected base commit id");
  }
  try {
    if (current) {
      const { data } = await auth.octokit.pulls.update({
        owner: repository.owner,
        repo: repository.repo,
        pull_number: current.number,
        title,
        body,
        base,
      });
      if (data.head?.sha !== expectedHeadSha || data.base?.ref !== base || data.base?.sha !== expectedBaseSha) {
        throw new Error("Existing pull request head or approved base changed during reconciliation");
      }
      return data.html_url;
    }

    const { data } = await auth.octokit.pulls.create({
      owner: repository.owner,
      repo: repository.repo,
      head,
      base,
      title,
      body,
    });
    const created = createdPullRequestEvidence(repository, data.number, data.html_url);
    if (data.head?.sha !== expectedHeadSha || data.base?.ref !== base || data.base?.sha !== expectedBaseSha) {
      throw new CreatedPullRequestMismatchError(
        "New pull request head or approved base changed during reconciliation; the created pull request remains open for manual review",
        created.number,
        created.prUrl
      );
    }
    return created.prUrl;
  } catch (error) {
    if (error instanceof CreatedPullRequestMismatchError) throw error;
    throw new Error(`Could not reconcile pull request: ${safeErrorMessage(error, [auth.token])}`);
  }
}

/**
 * Reconcile a PR only after the exact branch head is known to exist. Any
 * failure retains the safe publication identity for durable campaign audit.
 */
export async function reconcilePrWithAudit(
  auth: AuthResult,
  repository: GitHubRepository,
  title: string,
  body: string,
  current: OpenPullRequestIdentity | null,
  audit: PublicationAttemptAudit
): Promise<string> {
  try {
    return await reconcilePr(
      auth,
      repository,
      audit.branch,
      audit.baseBranch,
      title,
      body,
      current,
      audit.headSha,
      audit.baseSha
    );
  } catch (error) {
    const message = safeErrorMessage(error, [auth.token]);
    const failedAudit = error instanceof CreatedPullRequestMismatchError
      ? {
          ...audit,
          pullRequestNumber: error.pullRequestNumber,
          prUrl: error.prUrl,
        }
      : audit;
    throw new PublicationAttemptError(
      `Migration branch ${audit.branch} is present but pull request reconciliation failed: ${message}`,
      failedAudit
    );
  }
}

function createdPullRequestEvidence(
  repository: GitHubRepository,
  number: number,
  htmlUrl: string
): { number: number; prUrl: string } {
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("GitHub returned an invalid created pull request number");
  }
  const prUrl = `https://github.com/${repository.owner}/${repository.repo}/pull/${number}`;
  let parsed: URL;
  try {
    parsed = new URL(htmlUrl);
  } catch {
    throw new CreatedPullRequestMismatchError(
      "GitHub returned an invalid created pull request URL; the repository-derived pull request remains open for manual review",
      number,
      prUrl
    );
  }
  const segments = parsed.pathname.split("/");
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    segments.length !== 5 ||
    segments[0] !== "" ||
    segments[1]?.toLowerCase() !== repository.owner.toLowerCase() ||
    segments[2]?.toLowerCase() !== repository.repo.toLowerCase() ||
    segments[3] !== "pull" ||
    segments[4] !== String(number)
  ) {
    throw new CreatedPullRequestMismatchError(
      "GitHub returned a mismatched created pull request URL; the repository-derived pull request remains open for manual review",
      number,
      prUrl
    );
  }
  return { number, prUrl };
}

async function assertRemoteBaseMatchesApproval(
  auth: AuthResult,
  repository: GitHubRepository,
  baseBranch: string,
  expectedBaseSha: string
): Promise<void> {
  try {
    const { data } = await auth.octokit.git.getRef({
      owner: repository.owner,
      repo: repository.repo,
      ref: `heads/${baseBranch}`,
    });
    if (data.object.sha !== expectedBaseSha) {
      throw new Error("base branch advanced after the approved preview");
    }
  } catch (error) {
    throw new Error(`Could not verify approved base branch: ${safeErrorMessage(error, [auth.token])}`);
  }
}

/** Create an immutable branch only while the remote ref is still absent. */
export function publicationPushArgs(
  repository: GitHubRepository,
  branch: string
): string[] {
  const target = validateBranchName(branch);
  return [
    "push",
    `--force-with-lease=refs/heads/${target}:`,
    githubCloneUrl(repository),
    `HEAD:refs/heads/${target}`,
  ];
}

function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

function actorEmail(actor: string): string {
  return `${actor}@users.noreply.github.com`;
}

function commitMessage(manifest: Manifest): string {
  return `chore: ${manifest.name} [api-migrator]`;
}

function prTitle(manifest: Manifest): string {
  return `${manifest.name} — automated migration`;
}

function publicationAuditFooter(
  mode: AuthMode,
  approvedBy: string,
  expectedHeadSha: string
): string {
  const generator = mode === "github-app" ? "api-migrator GitHub App" : "api-migrator pilot auth";
  const lines = [
    "",
    "",
    "---",
    `_Generated by the ${generator} after approval by \`${approvedBy}\`._`,
    `_Approved migration head: \`${expectedHeadSha}\`._`,
  ];
  return lines.join("\n");
}

function assertRemotePublicationStateUnchanged(
  reviewed: RemotePublicationState,
  current: RemotePublicationState
): void {
  const reviewedPr = reviewed.pullRequest;
  const currentPr = current.pullRequest;
  if (
    reviewed.pushRequired !== current.pushRequired ||
    reviewed.sha !== current.sha ||
    (reviewedPr?.number ?? null) !== (currentPr?.number ?? null) ||
    (reviewedPr?.baseBranch ?? null) !== (currentPr?.baseBranch ?? null)
  ) {
    throw new Error("Remote branch or pull request state changed after owner authorization");
  }
}

/**
 * Convert a manifest into the one canonical UTF-8 representation used by the
 * preflight and owner-authorization boundary. A supplied stored value must
 * describe exactly the same validated manifest; duplicate-key or alternate
 * byte encodings never become authorization input.
 */
function exactManifestJson(manifest: Manifest, stored?: string): string {
  let parsed: Manifest;
  try {
    if (stored !== undefined && Buffer.byteLength(stored, "utf8") > 256 * 1024) {
      throw new Error("manifest JSON is too large");
    }
    parsed = Manifest.parse(stored === undefined ? manifest : JSON.parse(stored));
  } catch {
    throw new Error("Manifest JSON is invalid at the publication boundary");
  }
  if (stableStringify(parsed) !== stableStringify(Manifest.parse(manifest))) {
    throw new Error("Stored manifest JSON does not match the migration manifest");
  }
  return stableStringify(parsed);
}
