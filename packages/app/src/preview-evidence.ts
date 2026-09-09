import {
  canonicalGitHubRepositorySlug,
  validateRepositoryBranch,
} from "./repository-validation.js";

export { canonicalGitHubRepositorySlug } from "./repository-validation.js";

export interface PreviewSourceIdentity {
  repository: { slug: string; id: number; ownerId: number };
  base: { branch: string; sha: string; treeSha: string };
  manifestDigest: string;
  sourceArchiveDigest: string;
}

export type LocalPreviewExecution = {
  schemaVersion: 1;
  kind: "local-preview";
} & (
  | { source: PreviewSourceIdentity; unavailableReason?: never }
  | {
      source: null;
      unavailableReason: "repository_identity_unavailable" | "source_bundle_unavailable";
    }
);

const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

/** Validate strict JSON-shaped local evidence and return a detached copy. */
export function validateLocalPreviewExecution(value: unknown): LocalPreviewExecution {
  const execution = record(value, "local preview execution");
  if (execution.schemaVersion !== 1) throw new Error("Local preview schema version is unsupported");
  if (execution.kind !== "local-preview") throw new Error("Local preview kind is unsupported");

  if (execution.source === null) {
    exactKeys(execution, ["kind", "schemaVersion", "source", "unavailableReason"], "local preview execution");
    if (
      execution.unavailableReason !== "repository_identity_unavailable" &&
      execution.unavailableReason !== "source_bundle_unavailable"
    ) {
      throw new Error("Local preview unavailable reason is unsupported");
    }
    return {
      schemaVersion: 1,
      kind: "local-preview",
      source: null,
      unavailableReason: execution.unavailableReason,
    };
  }

  exactKeys(execution, ["kind", "schemaVersion", "source"], "local preview execution");
  const source = record(execution.source, "local preview source");
  exactKeys(
    source,
    ["base", "manifestDigest", "repository", "sourceArchiveDigest"],
    "local preview source"
  );

  const repository = record(source.repository, "local preview repository");
  exactKeys(repository, ["id", "ownerId", "slug"], "local preview repository");
  const slug = canonicalGitHubRepositorySlug(repository.slug);
  const id = positiveSafeInteger(repository.id, "repository id");
  const ownerId = positiveSafeInteger(repository.ownerId, "repository owner id");

  const base = record(source.base, "local preview base");
  exactKeys(base, ["branch", "sha", "treeSha"], "local preview base");
  const branch = validateRepositoryBranch(base.branch);
  const sha = gitOid(base.sha, "base commit object id");
  const treeSha = gitOid(base.treeSha, "base tree object id");
  if (sha.length !== treeSha.length) {
    throw new Error("Local preview base object ids use different formats");
  }

  return {
    schemaVersion: 1,
    kind: "local-preview",
    source: {
      repository: { slug, id, ownerId },
      base: { branch, sha, treeSha },
      manifestDigest: digest(source.manifestDigest, "manifest digest"),
      sourceArchiveDigest: digest(source.sourceArchiveDigest, "source archive digest"),
    },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Local preview ${label} must be a positive safe integer`);
  }
  return value;
}

function gitOid(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_OID.test(value)) {
    throw new Error(`Local preview ${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`Local preview ${label} is invalid`);
  }
  return value;
}
