/**
 * GitHub integration — turns an engine MigrationReport into a real pull request.
 *
 * Workflow per repo:
 *   1. Resolve auth (GitHub App in production; gh CLI in pilot — see auth.ts).
 *   2. Shallow-clone the repo to a temp working copy (token embedded in URL).
 *   3. Create a migration branch.
 *   4. Run the engine pipeline (writes changes to the working copy).
 *   5. Commit + push the branch (author = the auth actor).
 *   6. Open a PR via Octokit with the engine's markdown body.
 *
 * AUTH: All auth decisions live in auth.ts. This module is auth-mode-agnostic —
 * it just asks resolveAuth(slug) and uses the token + actor + octokit it gets.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigration, reportToMarkdown, type Manifest, type MigrationReport } from "@api-migrator/engine";
import { resolveAuth } from "./auth.js";

export interface MigrateRepoInput {
  /** Full clone URL WITHOUT credentials, e.g. https://github.com/owner/repo.git */
  cloneUrl: string;
  /** "owner/repo" slug, used for auth + the PR API. */
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
  /** Error message if the migration failed before producing a report. */
  error?: string;
}

/**
 * Run a migration and open a PR for a single repo.
 */
export async function migrateRepo(input: MigrateRepoInput): Promise<MigrateRepoResult> {
  const { cloneUrl, slug, baseBranch, manifest, branch } = input;

  // 1. Resolve auth for this repo (App or gh).
  const auth = await resolveAuth(slug);

  const workdir = mkdtempSync(join(tmpdir(), "api-migrator-"));
  try {
    // 2. Shallow clone with credentials embedded in the URL (works for both
    //    App tokens and gh tokens).
    const authedUrl = withCredentials(cloneUrl, auth.token, auth.mode);
    gitExec(["clone", "--depth", "1", "--branch", baseBranch, authedUrl, "repo"], workdir);
    const repoPath = join(workdir, "repo");

    // 3. Run the engine pipeline, writing changes.
    const { report } = await runMigration(manifest, repoPath, { writeChanges: true });

    if (report.changedFiles.length === 0) {
      return { report, prUrl: null, changed: false };
    }

    // 4. Branch + commit + push. Commit as the resolved actor (App bot or user).
    gitExec(["checkout", "-b", branch], repoPath);
    gitExec(["add", "-A"], repoPath);
    gitExec(
      ["-c", `user.name=${auth.actor}`, "-c", `user.email=${actorEmail(auth.actor)}`, "commit", "-m", commitMessage(manifest)],
      repoPath
    );
    gitExec(["push", "origin", branch], repoPath);

    // 5. Open the PR via Octokit (works in both App and gh modes).
    const body = reportToMarkdown(report) + authFooter(auth.mode);
    const prUrl = await openPr(auth.octokit, slug, branch, baseBranch, prTitle(manifest), body);

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

/** Embed the token into a clone URL. x-access-token is the conventional user. */
function withCredentials(url: string, token: string, mode: "github-app" | "gh-cli"): string {
  // https://github.com/owner/repo.git -> https://x-access-token:TOKEN@github.com/owner/repo.git
  return url.replace("https://", `https://x-access-token:${encodeURIComponent(token)}@`);
}

/** Map an actor to a noreply email for the commit author. */
function actorEmail(actor: string): string {
  if (actor.endsWith("[bot]")) return `${actor}@users.noreply.github.com`;
  return `${actor}@users.noreply.github.com`;
}

// --- PR via Octokit (both modes) --------------------------------------------

async function openPr(
  octokit: import("@octokit/rest").Octokit,
  slug: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<string> {
  const [owner, repo] = slug.split("/");
  const { data } = await octokit.pulls.create({
    owner: owner!,
    repo: repo!,
    head,
    base,
    title,
    body,
  });
  return data.html_url;
}

function commitMessage(manifest: Manifest): string {
  return `chore: ${manifest.name} [api-migrator]`;
}
function prTitle(manifest: Manifest): string {
  return `${manifest.name} — automated migration`;
}

/** A footer noting how the PR was generated — useful for transparency. */
function authFooter(mode: "github-app" | "gh-cli"): string {
  return mode === "github-app"
    ? "\n\n---\n_Generated by the api-migrator GitHub App._"
    : "\n\n---\n_Generated by api-migrator (pilot auth)._";
}
