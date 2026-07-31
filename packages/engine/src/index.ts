/**
 * Public entry point for the @api-migrator/engine package.
 *
 * The engine takes a Manifest + a repo path and returns a structured
 * MigrationReport. Phase 1 ships the Inngest v3->v4 transform set; the
 * transformSet field on the manifest selects which set runs.
 */

export { applyInngestV3ToV4, default as inngestTransform } from "./transforms/inngest-v3-to-v4.js";
export { findInngestFiles, isDirectory, type ScannedFile, type ScanOptions } from "./scanner.js";
export { Manifest, PeerFloor, TransformId, type LoadedManifest } from "./manifest.js";
export { runMigration, type RunMigrationOptions, type RunMigrationResult } from "./pipeline.js";
export { captureBaseline, runTsc, verify, hasTestScript, type TypeError, type VerifyResult } from "./verifier.js";
export { buildReport, reportToMarkdown, type MigrationReport } from "./reporter.js";
export type { ReportEntry, ReportSink, API, FileInfo } from "./types.js";
