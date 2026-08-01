/** Secure preview-and-publish workflow for one GitHub repository. */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runMigration,
  reportToMarkdown,
  type Manifest,
  type MigrationReport,
  type RunMigrationOptions,
} from "@api-migrator/engine";
import { resolveAuth, resolveOptionalAuth, type AuthMode, type AuthResult } from "./auth.js";
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
  validateBranchName,
  type GitHubRepository,
} from "./repository.js";
import { sanitizeMigrationReport } from "./report.js";
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
  /** Optional explicit base; otherwise GitHub's current default branch is used. */
  baseBranch?: string;
  /** Optional exact content-addressed branch override returned by preview. */
  branch?: string;
  /** Omitted means preview. Publication is never the default. */
  publication?: PublicationRequest;
}

export interface MigrateRepoResult {
  report: MigrationReport;
  prUrl: string | null;
  changed: boolean;
  preflightId: string;
  artifactDigest: string;
  publication: PublicationOutcome;
  error?: string;
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
  const publication = validatePublicationRequest(input.publication);
  const requestedBase = input.baseBranch ? validateBranchName(input.baseBranch) : undefined;
  const workdir = mkdtempSync(join(tmpdir(), "api-migrator-"));
  const isolatedHome = join(workdir, "home");
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  let auth: AuthResult | null = null;

  try {
    const cleanEnv = sanitizedExecutionEnv(isolatedHome);
    const repositoryEnv = sanitizedExecutionEnv("/tmp", {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TZ: process.env.TZ,
    });
    const repoPath = join(workdir, "repo");

    let baseBranch: string;
    let gitEnv: NodeJS.ProcessEnv | null = null;
    if (publicationRequiresAuthentication(publication)) {
      auth = await resolveAuth(repository.slug);
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
        auth = await resolveOptionalAuth(repository.slug);
        if (!auth) {
          throw new Error(
            `Public preview clone failed; private repositories require explicitly configured authentication: ${safeErrorMessage(anonymousCloneError)}`
          );
        }
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
    if (!/^[a-f0-9]{40,64}$/.test(baseSha)) throw new Error("Git returned an invalid base commit id");

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
    const preflightId = createPreflightId({
      slug: repository.slug,
      baseBranch,
      baseSha,
      targetBranch: branch,
      artifactDigest: artifact.digest,
      manifest: input.manifest,
      report: engineReport,
    });
    // Everything leaving this function uses the safe boundary copy. Artifact
    // inspection and preflight hashing above intentionally retain their exact
    // existing engine semantics.
    const report = sanitizeMigrationReport(engineReport);
    const blockers = publicationBlockers(report);

    const common = {
      preflightId,
      baseBranch,
      baseSha,
      branch,
      artifactDigest: artifact.digest,
      blockers,
    };

    if (!changed) {
      return {
        report,
        prUrl: null,
        changed: false,
        preflightId,
        artifactDigest: artifact.digest,
        publication: createNoChangesOutcome(publication, common),
      };
    }

    if (publication.mode === "preview") {
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

    // A stale/mismatched preview is never overrideable.
    if (publication.preflightId !== preflightId) {
      assertPublicationAllowed(publication, preflightId, blockers);
    }
    const absoluteBlocker = blockers.some((blocker) => blocker.code !== "manual_review_required");
    if (absoluteBlocker || (blockers.length > 0 && !publication.overrideUnsafe)) {
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
    const { overridden } = assertPublicationAllowed(publication, preflightId, blockers);

    if (!auth || !gitEnv) throw new Error("Publishing requires resolved GitHub authentication");
    assertCanonicalRemote(repoPath, repository, cleanEnv);
    applyVerifiedArtifact(repoPath, proposedPath, artifact);
    assertAppliedArtifact(repoPath, proposedPath, artifact);
    gitExec(["checkout", "-B", branch], repoPath, cleanEnv);
    stageVerifiedArtifact(repoPath, artifact, cleanEnv);
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
    if (!/^[a-f0-9]{40,64}$/.test(localCommitSha)) throw new Error("Git returned an invalid migration commit id");
    const expectedTreeSha = gitExec(["rev-parse", "HEAD^{tree}"], repoPath, cleanEnv).trim();
    if (!/^[a-f0-9]{40,64}$/.test(expectedTreeSha)) throw new Error("Git returned an invalid migration tree id");

    const remote = await inspectRemotePublicationState(
      auth,
      repository,
      branch,
      baseBranch,
      baseSha,
      expectedTreeSha
    );
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
      publicationBlockers: blockers,
      approvedBy: publication.approvedBy,
      overrideUnsafe: overridden,
      ...(overridden && publication.overrideReason
        ? { overrideReason: publication.overrideReason }
        : {}),
      report,
    };
    const body = reportToMarkdown(report) + publicationAuditFooter(
      auth.mode,
      publication.approvedBy,
      overridden,
      expectedHeadSha,
      publication.overrideReason
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
        overridden,
        approvedBy: publication.approvedBy,
        headSha: expectedHeadSha,
        ...(overridden && publication.overrideReason
          ? { overrideReason: publication.overrideReason }
          : {}),
      },
    };
  } catch (error) {
    const message = safeErrorMessage(error, auth ? [auth.token] : []);
    if (error instanceof PublicationAttemptError) {
      throw new PublicationAttemptError(message, error.audit);
    }
    throw new Error(message);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
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
    if (!/^[a-f0-9]{40,64}$/.test(blob)) throw new Error(`Git returned an invalid blob id for ${path}`);
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
  expectedHeadSha: string
): Promise<string> {
  if (!/^[a-f0-9]{40,64}$/.test(expectedHeadSha)) {
    throw new Error("Invalid expected migration commit id");
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
      if (data.head?.sha !== expectedHeadSha || data.base?.ref !== base) {
        throw new Error("Existing pull request head or base changed during reconciliation");
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
    if (data.head?.sha !== expectedHeadSha || data.base?.ref !== base) {
      await closeNewPullRequestBestEffort(auth, repository, data.number);
      throw new Error("New pull request head or base changed during reconciliation");
    }
    return data.html_url;
  } catch (error) {
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
      audit.headSha
    );
  } catch (error) {
    const message = safeErrorMessage(error, [auth.token]);
    throw new PublicationAttemptError(
      `Migration branch ${audit.branch} is present but pull request reconciliation failed: ${message}`,
      audit
    );
  }
}

async function closeNewPullRequestBestEffort(
  auth: AuthResult,
  repository: GitHubRepository,
  pullNumber: number
): Promise<void> {
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) return;
  try {
    await auth.octokit.pulls.update({
      owner: repository.owner,
      repo: repository.repo,
      pull_number: pullNumber,
      state: "closed",
    });
  } catch {
    // The original head-mismatch failure remains authoritative.
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
  overridden: boolean,
  expectedHeadSha: string,
  overrideReason?: string
): string {
  const generator = mode === "github-app" ? "api-migrator GitHub App" : "api-migrator pilot auth";
  const lines = [
    "",
    "",
    "---",
    `_Generated by the ${generator} after approval by \`${approvedBy}\`._`,
    `_Approved migration head: \`${expectedHeadSha}\`._`,
  ];
  if (overridden) lines.push(`_Safety gate override: ${overrideReason ?? "operator override"}_`);
  return lines.join("\n");
}
