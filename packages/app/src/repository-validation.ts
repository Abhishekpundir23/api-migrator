/** Browser-safe validation shared by repository inputs and preview evidence. */

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;

export interface ValidatedRepositorySlug {
  owner: string;
  repo: string;
  slug: string;
}

export function validateRepositorySlug(value: unknown): ValidatedRepositorySlug {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error("Repository must be an exact owner/repo slug");
  }
  const parts = value.split("/");
  if (parts.length !== 2) throw new Error("Repository must be an exact owner/repo slug");
  const [owner, repo] = parts as [string, string];
  if (!OWNER.test(owner) || owner.includes("--")) {
    throw new Error("Repository owner contains unsupported characters");
  }
  if (!REPOSITORY.test(repo) || repo === "." || repo === ".." || repo.endsWith(".git")) {
    throw new Error("Repository name contains unsupported characters");
  }
  return { owner, repo, slug: `${owner}/${repo}` };
}

/** Canonical identity for GitHub repositories, whose owner/name are case-insensitive. */
export function canonicalGitHubRepositorySlug(value: unknown): string {
  return validateRepositorySlug(value).slug.toLowerCase();
}

export function validateRepositoryBranch(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    value !== value.trim() ||
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(value) ||
    value.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith("."))
  ) {
    throw new Error("Invalid git branch name");
  }
  return value;
}
