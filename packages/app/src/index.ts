export {
  migrateRepo,
  publicationRequiresAuthentication,
  publicationPushArgs,
  type MigrateRepoInput,
  type MigrateRepoResult,
} from "./github.js";
export {
  runCampaignJobs,
  type MigrationJob,
  type MigrationJobResult,
  type QueueOptions,
} from "./queue.js";
export {
  runCampaign,
  assertCampaignActive,
  parseStoredManifest,
  type RunCampaignInput,
  type CampaignRunSummary,
} from "./campaign/runner.js";
export {
  resolveAuth,
  resolveOptionalAuth,
  readAuthConfig,
  readOptionalAuthConfig,
  readAppCredentials,
  isAppMode,
  type AuthConfig,
  type AuthMode,
  type AppCredentials,
  type AuthResult,
} from "./auth.js";
export {
  publicationBlockers,
  createPreflightId,
  assertRemoteBranchMatchesArtifact,
  validatePublicationRequest,
  PublicationAttemptError,
  type PublicationRequest,
  type PublicationOutcome,
  type PublicationBlocker,
  type PublicationAttemptAudit,
  type OpenPullRequestIdentity,
  type RemoteArtifactIdentity,
} from "./publication.js";
export {
  parseRepositorySlug,
  githubCloneUrl,
  githubCloneArgs,
  githubDefaultCloneArgs,
  validateBranchName,
  defaultMigrationBranch,
  resolveMigrationBranch,
  type GitHubRepository,
} from "./repository.js";
export {
  copyGitFreeTree,
  inspectVerifiedArtifact,
  applyVerifiedArtifact,
  assertAppliedArtifact,
  normalizeArtifactPath,
  type VerifiedArtifact,
} from "./artifact.js";
export { sanitizeMigrationReport } from "./report.js";
export { redactText, safeErrorMessage, sanitizedExecutionEnv } from "./security.js";
