import { InngestGuides } from "./assessment-guides.js";
import { sep } from "node:path";
import { ASSESSMENT_RULES } from "./assessment-rules.js";
import { inngestWorkflowReviewEntries } from "./inngest-workflow-assessment.js";
import type { TransformSet } from "./manifest.js";
import { readRepositoryFile } from "./repository-files.js";
import { findSourceFiles, matchesSdkSource } from "./scanner.js";
import { createRealtimeAliasResolver } from "./transforms/realtime-aliases.js";
import {
  applyInngestV3ToV4,
  inngestBehavioralReviewEntries,
} from "./transforms/inngest-v3-to-v4.js";
import { applyKnockV0ToV1 } from "./transforms/knock-v0-to-v1.js";
import type { ReportEntry, ReportSink } from "./types.js";

export const ASSESSMENT_MAX_SOURCE_FILES = 10_000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface AssessmentFinding {
  code: string;
  kind: ReportEntry["kind"];
  count: number;
}

/** Source-only estimate produced locally. No file names, code, or free text. */
export interface RepositoryAssessment {
  version: 1;
  recipe: TransformSet;
  sourceFiles: number;
  matchedFiles: number;
  wouldChangeFiles: number;
  findings: AssessmentFinding[];
}

/**
 * Plan the supported source rewrites in memory. The selected recipe is an
 * owner input: this pass does not verify installed SDKs, dependencies or runtime.
 * "applied" counts an edit proposed by a transform, never a filesystem write.
 */
export function assessRepository(
  root: string,
  recipe: TransformSet,
  onLocalFinding?: (entry: ReportEntry) => void,
): RepositoryAssessment {
  if (!Object.hasOwn(ASSESSMENT_RULES, recipe)) throw new Error("Unsupported assessment recipe");
  const enabled = new Set<string>(ASSESSMENT_RULES[recipe]);
  const guides = recipe === "inngest-v3-to-v4" ? new InngestGuides() : undefined;
  const files = findSourceFiles(root, {
    maxFiles: ASSESSMENT_MAX_SOURCE_FILES, skipYarnReleases: true,
    onGuidePath: guides && (path => guides.collect(path)),
  });
  const sources = new Map<string, string>();
  const candidates = new Map<string, string>();
  let bytesRead = 0;
  for (const file of files) {
    if (sep === "/" && file.relative.includes("\\")) {
      throw new Error(`Unsupported backslash in local source path: ${file.relative}`);
    }
    const bytes = readRepositoryFile(root, file.relative, { label: "Assessment source file", maxBytes: MAX_SOURCE_BYTES });
    bytesRead += bytes.length;
    if (bytesRead > MAX_TOTAL_BYTES) throw new Error("Assessment source inventory exceeds 32 MiB");
    const source = bytes.toString("utf8");
    sources.set(file.relative, source);
    if (matchesSdkSource(source, recipe)) candidates.set(file.relative, source);
  }
  const matched = new Set(candidates.keys());
  const provenance = {
    scannedSources: candidates,
    sourcePaths: new Set(sources.keys()),
    ownerAssessment: true,
    resolveRealtimeAlias: createRealtimeAliasResolver(root),
  };

  const counts = new Map<string, AssessmentFinding>();
  const localFindings: ReportEntry[] | undefined = onLocalFinding ? [] : undefined;
  const sink: ReportSink = {
    push(entry) {
      const { code, kind } = entry;
      if (!enabled.has(code)) throw new Error("Assessment produced an unrecognized finding");
      const key = `${code}:${kind}`;
      const finding = counts.get(key);
      if (finding) finding.count++;
      else counts.set(key, { code, kind, count: 1 });
      localFindings?.push(entry);
    },
  };
  let wouldChangeFiles = 0;
  // Parse even unmatched files. A local wrapper or computed property can hide
  // the provider spelling and still require manual review.
  for (const [path, source] of sources) {
    const fileSink: ReportSink = { push(entry) { matched.add(path); sink.push(entry); } };
    let proposed: string | null;
    try {
      proposed = recipe === "inngest-v3-to-v4"
        ? applyInngestV3ToV4(source, path, fileSink, enabled, provenance)
        : applyKnockV0ToV1(source, path, fileSink, enabled, provenance);
    } catch (error) {
      throw new Error(`Unable to assess ${path}: ${error instanceof Error ? error.message : "source analysis failed"}`, { cause: error });
    }
    if (proposed !== null && proposed !== source) wouldChangeFiles++;
  }
  if (recipe === "inngest-v3-to-v4" && matched.size > 0) {
    guides?.review(root, sink);
    for (const entry of inngestBehavioralReviewEntries(enabled, { ownerAssessment: true })) sink.push(entry);
    for (const entry of inngestWorkflowReviewEntries(root)) sink.push(entry);
  }
  // A parse failure late in the scan must not leave a partial private report.
  if (localFindings && onLocalFinding) {
    for (const entry of localFindings) onLocalFinding(entry);
  }
  return {
    version: 1, recipe, sourceFiles: files.length, matchedFiles: matched.size, wouldChangeFiles,
    findings: [...counts.values()].sort((a, b) => a.code.localeCompare(b.code) || a.kind.localeCompare(b.kind)),
  };
}
