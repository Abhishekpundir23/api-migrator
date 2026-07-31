/**
 * GitHub integration — turns an engine MigrationReport into a real pull request.
 *
 * Workflow per repo:
 *   1. Shallow-clone the repo to a temp working copy.
 *   2. Create a migration branch.
 *   3. Run the engine pipeline (writes changes to the working copy).
 *   4. Commit + push the branch.
 *   5. Open a PR with the engine's markdown body.
 *
 * AUTH: Today this authenticates via `gh` (the local CLI) for the pilot. The
 * exact same workflow authenticates as a GitHub App installation via Octokit's
 * `auth-app` — only the auth wrapper changes. See AppAuth (stubbed) for the
 * production path.
 */

import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigration, reportToMarkdown, type Manifest, type MigrationReport } from "@api-migrator/engine";

export interface MigrateRepoInput {
  /** Full clone URL, e.g. https://github.com/owner/repo.git */
  cloneUrl: string;
  /** "owner/repo" slug, used for the PR API. */
  slug: string;
  /** Default branch to branch from, e.g. "main". */
  baseBranch: string;
  /** The migration manifest to run. */
  manifest: Manifest;
  /** Branch name to push, e.g. "api-migrator/inngest-v4". */
  branch: string;
}

export interface MigrateRepoResult {
  report: MigrationReport;
  /** PR url if a PR was opened, else null (e.g. no changes). */
  prUrl: string | null;
  /** Did the engine change any files? */
  changed: boolean;
}

/**
 * Run a migration and open a PR for a single repo. Uses `gh` for auth in the
 * pilot; the Octokit calls below are the App-equivalent.
 */
export async function migrateRepo(input: MigrateRepoInput): Promise<MigrateRepoResult> {
  const { cloneUrl, slug, baseBranch, manifest, branch } = input;

  const workdir = mkdtempSync(join(tmpdir(), "api-migrator-"));
  try {
    // 1. Shallow clone (depth 1 keeps it fast; we only need HEAD).
    gitExec(["clone", "--depth", "1", "--branch", baseBranch, cloneUrl, "repo"], workdir);
    const repoPath = join(workdir, "repo");

    // 2. Run the engine pipeline, writing changes.
    const { report } = await runMigration(manifest, repoPath, { writeChanges: true });

    if (report.changedFiles.length === 0) {
      return { report, prUrl: null, changed: false };
    }

    // 3. Branch + commit + push. Commit as the migrator bot identity.
    gitExec(["checkout", "-b", branch], repoPath);
    gitExec(["add", "-A"], repoPath);
    gitExec(
      ["-c", "user.name=api-migrator[bot]", "-c", "user.email=bot@api-migrator.dev", "commit", "-m", commitMessage(manifest)],
      repoPath
    );
    gitExec(["push", "origin", branch], repoPath);

    // 4. Open the PR via gh (pilot auth). Production: octokit.pulls.create.
    const body = reportToMarkdown(report);
    const prUrl = openPr(slug, branch, baseBranch, prTitle(manifest), body);

    return { report, prUrl, changed: true };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

// --- git helpers (shell out to the system git) -------------------------------
// Always pass args as an array — never a space-split string, because values
// like the bot identity contain spaces and would be mangled by naive splitting.

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// --- PR via gh (pilot auth) --------------------------------------------------

function openPr(slug: string, head: string, base: string, title: string, body: string): string {
  // Write body to a temp file to avoid shell-escaping a large markdown blob.
  const bodyFile = join(tmpdir(), `pr-body-${Date.now()}.md`);
  writeFileSync(bodyFile, body);
  try {
    const out = execSync(
      `gh pr create --repo ${slug} --head ${head} --base ${base} --title "${title.replace(/"/g, '\\"')}" --body-file "${bodyFile}"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
    return out; // the PR url
  } finally {
    try {
      rmSync(bodyFile, { force: true });
    } catch {}
  }
}

function commitMessage(manifest: Manifest): string {
  return `chore: ${manifest.name} [api-migrator]`;
}
function prTitle(manifest: Manifest): string {
  return `${manifest.name} — automated migration`;
}

// --- AppAuth (production path, stubbed) -------------------------------------
//
// When wired, a GitHub App installation yields a token per-repo via Octokit:
//
//   import { createAppAuth } from "@octokit/auth-app";
//   import { Octokit } from "@octokit/rest";
//   const app = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey, installationId } });
//   const { data: { token } } = await app.auth({ type: "installation" });
//
// Then clone with that token embedded in the URL, and use octokit.pulls.create
// instead of `gh pr create`. The migrateRepo() body above is identical.
