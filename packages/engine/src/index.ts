/**
 * Public entry point for the @api-migrator/engine package.
 *
 * Today (Phase 0/1) this exposes the Inngest v3→v4 transform plus the scanner.
 * Phase 1's pipeline will add a manifest-driven `runMigration` that the GitHub
 * App calls per-repo.
 */

export { applyInngestV3ToV4, default as inngestTransform } from "./transforms/inngest-v3-to-v4.js";
export { findInngestFiles, isDirectory, type ScannedFile, type ScanOptions } from "./scanner.js";
export type { ReportEntry, ReportSink } from "./types.js";
