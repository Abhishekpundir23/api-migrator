/**
 * Public entry point for the @api-migrator/engine package.
 *
 * The engine takes a Manifest + a repo path and returns a structured
 * MigrationReport. Phase 1 ships the Inngest v3->v4 transform set; the
 * transformSet field on the manifest selects which set runs.
 */

export {
  applyInngestV3ToV4,
  inngestBehavioralReviewEntries,
  default as inngestTransform,
  type InngestBehavioralReviewContext,
  type InngestRuntimeContainer,
} from "./transforms/inngest-v3-to-v4.js";
export { applyKnockV0ToV1, default as knockTransform } from "./transforms/knock-v0-to-v1.js";
export { findInngestFiles, findSdkFiles, findSourceFiles, selectSdkFiles, isDirectory, SourceScanError, type ScannedFile, type ScanOptions } from "./scanner.js";
export {
  Manifest, PeerFloor, NodeRuntimePolicy, RuntimePolicy, TransformId,
  TRANSFORM_ALLOWLIST, parseManifest, enabledTransforms,
  type LoadedManifest, type TransformSet,
} from "./manifest.js";
export { runMigration, type RunMigrationOptions, type RunMigrationResult } from "./pipeline.js";
export { updateManifestDependencies, detectPackageManager, findLockfiles, DependencyUpdateError, type DependencyUpdateResult, type PackageManager } from "./dependencies.js";
export {
  captureBaseline, runTsc, verify, verifyNodeRuntime, installDeps, hasTestScript, parseTscErrors,
  LocalVerificationRunner, DockerVerificationRunner,
  type TypeError, type VerifyResult, type VerifyOptions, type CheckResult,
  type VerificationChecks, type VerificationRunner, type RunnerCommand, type RunnerResult,
  type RunnerTemporaryFile,
} from "./verifier.js";
export {
  TRUSTED_NODE_RUNTIME_PROFILES,
  planNodeRuntimeMigration,
  applyNodeRuntimeMigration,
  attestNodeRuntime,
  RuntimeMigrationError,
  type RuntimeMigrationPlan,
  type RuntimeMigrationResult,
  type RuntimeAttestation,
} from "./runtime.js";
export { buildReport, reportToMarkdown, type MigrationReport } from "./reporter.js";
export type { ReportEntry, ReportSink, API, FileInfo } from "./types.js";
