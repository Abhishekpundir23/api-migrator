/**
 * Pure, credential-free helpers used by the digest-pinned publication runner.
 * This subpath intentionally excludes GitHub clients, token brokers, queues,
 * databases, owner signing, and every remote mutation primitive.
 */

export { canonicalJson, parseCanonicalJson } from "./canonical-json.js";
export {
  PUBLICATION_RUNNER_PROFILE,
  PUBLICATION_RUNNER_COMMAND_SCOPE,
  PUBLICATION_RUNNER_COMMAND_SCOPE_DIGEST,
  createPublicationRunnerPlan,
  assertPublicationRunnerPlanCurrent,
  validatePublicationRunnerPlan,
  type PublicationRunnerPlan,
  type PublicationRunnerPlanRecord,
  type PublicationRunnerOutput,
} from "./publication-runner.js";
export {
  copyGitFreeTree,
  inspectVerifiedArtifact,
  type VerifiedArtifact,
} from "./artifact.js";
export {
  parseRepositorySlug,
  resolveMigrationBranch,
  validateBranchName,
} from "./repository.js";
export { createPreflightId, publicationBlockers } from "./publication.js";
export { sanitizeMigrationReport } from "./report.js";
export {
  SOURCE_BUNDLE_SCHEMA_VERSION,
  MAX_SOURCE_ENTRIES,
  MAX_SOURCE_TOTAL_BYTES,
  MAX_SOURCE_FILE_BYTES,
  MAX_CANONICAL_MANIFEST_BYTES,
  createSourceBundle,
  parseSourceBundle,
  extractSourceBundle,
  extractSourceBundleIntoDirectory,
  sourceBundleDigest,
  type SourceBundleRepositoryIdentity,
  type SourceBundleBaseIdentity,
  type CreateSourceBundleInput,
  type SourceBundleHeader,
  type SourceBundleEntry,
  type SourceBundleRecord,
  type ParsedSourceBundle,
} from "./runner-source-bundle.js";
export {
  MAX_GIT_PATH_BYTES,
  MAX_GIT_TREE_DEPTH,
  gitObjectFormatFromOid,
  gitBlobOid,
  gitTreeOid,
  validateGitPath,
  type GitObjectFormat,
  type GitFileMode,
  type GitTreeEntry,
} from "./runner-git-tree.js";
