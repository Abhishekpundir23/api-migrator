import { Octokit } from "@octokit/rest";
import type { AuthResult } from "./auth.js";
import {
  type LocalPreviewExecution,
  validateLocalPreviewExecution,
} from "./preview-evidence.js";
import {
  canonicalGitHubRepositorySlug,
  validateRepositorySlug,
} from "./repository-validation.js";
import { createSourceBundle } from "./runner-source-bundle.js";

interface RepositoryMetadataClient {
  repos: {
    get(input: {
      owner: string;
      repo: string;
      request: { timeout: number };
    }): Promise<{
      data: {
        full_name?: unknown;
        id?: unknown;
        owner?: { id?: unknown } | null;
      };
    }>;
  };
}

interface CaptureDependencies {
  repositoryClient: RepositoryMetadataClient;
}

export interface CaptureLocalPreviewExecutionInput {
  checkoutPath: string;
  repositorySlug: string;
  baseBranch: string;
  baseSha: string;
  treeSha: string;
  manifestJson: string;
  auth: AuthResult | null;
}

const REPOSITORY_IDENTITY_UNAVAILABLE = Object.freeze({
  schemaVersion: 1,
  kind: "local-preview",
  source: null,
  unavailableReason: "repository_identity_unavailable",
} as const satisfies LocalPreviewExecution);

const SOURCE_BUNDLE_UNAVAILABLE = Object.freeze({
  schemaVersion: 1,
  kind: "local-preview",
  source: null,
  unavailableReason: "source_bundle_unavailable",
} as const satisfies LocalPreviewExecution);

/** Capture descriptive local-preview provenance without authorizing execution. */
export async function captureLocalPreviewExecution(
  input: CaptureLocalPreviewExecutionInput,
  dependencies?: CaptureDependencies
): Promise<LocalPreviewExecution> {
  const repository = validateRepositorySlug(input.repositorySlug);
  const canonicalRepositorySlug = canonicalGitHubRepositorySlug(repository.slug);
  const repositoryClient = dependencies?.repositoryClient ?? input.auth?.octokit ?? new Octokit();

  let repositoryIdentity: { slug: string; id: number; ownerId: number };
  try {
    const response = await repositoryClient.repos.get({
      owner: repository.owner,
      repo: repository.repo,
      request: { timeout: 10_000 },
    });
    const fullName = response.data.full_name;
    const id = response.data.id;
    const ownerId = response.data.owner?.id;
    if (
      typeof fullName !== "string" ||
      canonicalGitHubRepositorySlug(fullName) !== canonicalRepositorySlug ||
      !isPositiveSafeInteger(id) ||
      !isPositiveSafeInteger(ownerId) ||
      !matchesPinnedAppIdentity(input.auth, canonicalRepositorySlug, id, ownerId)
    ) {
      return detached(REPOSITORY_IDENTITY_UNAVAILABLE);
    }
    repositoryIdentity = { slug: canonicalRepositorySlug, id, ownerId };
  } catch {
    return detached(REPOSITORY_IDENTITY_UNAVAILABLE);
  }

  try {
    const bundle = createSourceBundle({
      checkoutPath: input.checkoutPath,
      repository: repositoryIdentity,
      base: {
        branch: input.baseBranch,
        sha: input.baseSha,
        treeSha: input.treeSha,
      },
      manifestJson: input.manifestJson,
    });
    return validateLocalPreviewExecution({
      schemaVersion: 1,
      kind: "local-preview",
      source: {
        repository: repositoryIdentity,
        base: {
          branch: input.baseBranch,
          sha: input.baseSha,
          treeSha: input.treeSha,
        },
        manifestDigest: bundle.header.manifest.digest,
        sourceArchiveDigest: bundle.digest,
      },
    });
  } catch {
    return detached(SOURCE_BUNDLE_UNAVAILABLE);
  }
}

function matchesPinnedAppIdentity(
  auth: AuthResult | null,
  repositorySlug: string,
  repositoryId: number,
  repositoryOwnerId: number
): boolean {
  const pinned = auth?.githubApp;
  if (pinned === null || pinned === undefined) return true;
  return (
    pinned.repositorySlug.toLowerCase() === repositorySlug.toLowerCase() &&
    pinned.repositoryId === repositoryId &&
    pinned.repositoryOwnerId === repositoryOwnerId
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function detached(value: LocalPreviewExecution): LocalPreviewExecution {
  return validateLocalPreviewExecution(value);
}
