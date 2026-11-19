import { posix } from "node:path";

export interface LocalModuleSources {
  /** Original contents of exactly the source files selected by the repository scan. */
  scannedSources: ReadonlyMap<string, string>;
  /** Every supported regular source path, including files that did not match the SDK scan. */
  sourcePaths: ReadonlySet<string>;
  /** Optional tsconfig path mapping for review-only realtime channel and client imports. */
  resolveRealtimeAlias?: (importer: string, source: string) => string | null;
}

export function isLocalModule(source: string): boolean {
  return source === "." || source === ".." || source.startsWith("./") || source.startsWith("../");
}

const PROVENANCE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;

export function resolveScannedLocalModule(
  provenance: LocalModuleSources,
  importerPath: string,
  source: string
): { path: string; source: string } | null {
  if (!isLocalModule(source) || source.includes("\\") || source.includes("\0") || /[?#]/.test(source)) return null;
  const importer = normalizeScannedPath(importerPath);
  if (!importer) return null;
  const targetBase = posix.normalize(posix.join(posix.dirname(importer), source)).replace(/^\.\//, "");
  if (targetBase === ".." || targetBase.startsWith("../") || posix.isAbsolute(targetBase) || targetBase === importer) {
    return null;
  }

  // Explicit extensions participate in TypeScript extension substitution and
  // are intentionally unsupported until that resolution algorithm is modeled.
  if (targetBase === "." || posix.extname(targetBase)) return null;
  const standardCandidates = new Set(PROVENANCE_EXTENSIONS.map((suffix) => `${targetBase}${suffix}`));
  const siblingPrefix = `${targetBase}.`;
  const existingCandidates = [...provenance.sourcePaths]
    .map(normalizeScannedPath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => standardCandidates.has(path) || path.startsWith(siblingPrefix));
  if (existingCandidates.length !== 1 || !standardCandidates.has(existingCandidates[0]!)) return null;

  const resolvedPath = existingCandidates[0]!;
  const scanned = [...provenance.scannedSources].find(([path]) => normalizeScannedPath(path) === resolvedPath);
  return scanned ? { path: resolvedPath, source: scanned[1] } : null;
}

function normalizeScannedPath(value: string): string | null {
  if (!value || value.includes("\0") || value.includes("\\") || posix.isAbsolute(value)) return null;
  const normalized = posix.normalize(value).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

/**
 * A relative .js import in TypeScript commonly names the output of a .ts
 * implementation. Only the source assessment follows this substitution.
 * The normal resolver rejects competing siblings, including .d.ts, .js and
 * module-suffixed sources. A declaration file alone cannot provide a client.
 */
export function resolveOwnerEmittedTypeScriptModule(
  provenance: LocalModuleSources,
  importer: string,
  source: string,
): { path: string; source: string } | null {
  if (!/\.[cm]?tsx?$/.test(importer) || /\.d\.[cm]?ts$/.test(importer)
    || !isLocalModule(source) || !/(?:^|\/)[^/.][^/]*\.js$/.test(source)) return null;
  const target = resolveScannedLocalModule(provenance, importer, source.slice(0, -3));
  return target?.path.endsWith(".ts") && !target.path.endsWith(".d.ts") ? target : null;
}
