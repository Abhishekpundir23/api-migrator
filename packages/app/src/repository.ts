import { createHash } from "node:crypto";
import type { Manifest } from "@api-migrator/engine";
import {
  validateRepositoryBranch,
  validateRepositorySlug,
} from "./repository-validation.js";

export interface GitHubRepository {
  owner: string;
  repo: string;
  slug: string;
}

/** Parse only a canonical `owner/repo` slug. URLs, `.git` suffixes and refs are rejected. */
export function parseRepositorySlug(value: string): GitHubRepository {
  return validateRepositorySlug(value);
}

export function githubCloneUrl(repository: GitHubRepository): string {
  return `https://github.com/${repository.owner}/${repository.repo}.git`;
}

export function githubCloneArgs(repository: GitHubRepository, baseBranch: string): string[] {
  return [
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--branch",
    validateBranchName(baseBranch),
    githubCloneUrl(repository),
    "repo",
  ];
}

/** Credential-free default-branch clone used by anonymous public previews. */
export function githubDefaultCloneArgs(repository: GitHubRepository): string[] {
  return ["clone", "--depth", "1", "--single-branch", githubCloneUrl(repository), "repo"];
}

/** Validate a full branch name before it is ever passed to git or GitHub. */
export function validateBranchName(value: string): string {
  return validateRepositoryBranch(value);
}

/**
 * An immutable, content-addressed branch for one exact approved artifact.
 * Any manifest, base branch, base commit, or artifact change produces a new
 * branch rather than authorizing an overwrite of an existing ref.
 */
export function defaultMigrationBranch(
  manifest: Manifest,
  baseBranch: string,
  baseSha: string,
  artifactDigest: string
): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha)) throw new Error("Invalid base commit id for migration branch");
  if (!/^[a-f0-9]{64}$/.test(artifactDigest)) throw new Error("Invalid artifact digest for migration branch");
  const label = slugify(`${manifest.provider}-${manifest.transformSet}`);
  const digest = createHash("sha256")
    .update(stableStringify({
      manifest,
      baseBranch: validateBranchName(baseBranch),
      baseSha,
      artifactDigest,
    }))
    .digest("hex");
  return validateBranchName(`codex/api-migrator/${label}-${digest}`);
}

/** Only the exact content-addressed branch returned by preview is accepted. */
export function resolveMigrationBranch(
  manifest: Manifest,
  baseBranch: string,
  baseSha: string,
  artifactDigest: string,
  override?: string
): string {
  const base = validateBranchName(baseBranch);
  const expected = defaultMigrationBranch(manifest, base, baseSha, artifactDigest);
  if (override !== undefined && validateBranchName(override) !== expected) {
    throw new Error(`Migration branch override must equal the owned branch ${expected}`);
  }
  if (expected === base) throw new Error("Migration branch must not equal the base branch");
  return expected;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "migration";
}
