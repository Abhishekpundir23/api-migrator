/** Deterministic package.json updates required by a migration manifest. */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Manifest } from "./manifest.js";
import {
  MAX_PACKAGE_MANIFEST_BYTES,
  MAX_ROOT_LOCKFILE_BYTES,
  readRepositoryFile,
  readRepositoryText,
  validateRepositoryFile,
} from "./repository-files.js";
import type { ReportSink } from "./types.js";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
type DependencySectionName = typeof DEPENDENCY_SECTIONS[number];

const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"]);
const ROOT_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
const PACKAGE_MANIFEST_POLICY = {
  label: "package manifest",
  maxBytes: MAX_PACKAGE_MANIFEST_BYTES,
} as const;
const ROOT_LOCKFILE_POLICY = {
  label: "root lockfile",
  maxBytes: MAX_ROOT_LOCKFILE_BYTES,
} as const;

type PackageJson = Record<string, unknown> & {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export interface DependencyUpdateResult {
  packageFiles: string[];
  packageManager: PackageManager;
  lockfiles: string[];
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export class DependencyUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyUpdateError";
  }
}

/**
 * Update the target dependency and peer floors in every relevant package.json.
 * The target must be declared and must match the manifest's source major.
 */
export function updateManifestDependencies(
  repoPath: string,
  manifest: Manifest,
  sink: ReportSink
): DependencyUpdateResult {
  const packageFiles = findPackageJsonFiles(repoPath);
  if (packageFiles.length === 0) throw new DependencyUpdateError("Repository has no package.json");

  const parsed = packageFiles.map((absolute) => ({
    absolute,
    relative: relative(repoPath, absolute),
  })).map((item) => {
    const text = readRepositoryText(repoPath, item.relative, PACKAGE_MANIFEST_POLICY);
    return { ...item, text, json: parsePackageJson(item.relative, text) };
  });

  const targetOwners: typeof parsed = [];
  for (const item of parsed) {
    const declarations = findDependencies(item.json, manifest.package.name);
    if (declarations.length === 0) continue;
    targetOwners.push(item);
    for (const found of declarations) {
      const state = dependencyState(
        found.spec,
        manifest.package.from,
        manifest.package.to,
        manifest.package.name,
        item.relative
      );
      if (state === "target") continue;
      found.section[manifest.package.name] = manifest.package.to;
      sink.push({
        file: item.relative,
        kind: "applied",
        code: "PKG1",
        message: `${manifest.package.name} (${found.sectionName}): ${found.spec} -> ${manifest.package.to}`,
        line: null,
      });
    }
  }

  if (targetOwners.length === 0) {
    throw new DependencyUpdateError(
      `${manifest.package.name} is not declared in dependencies, devDependencies, optionalDependencies, or peerDependencies`
    );
  }

  for (const floor of manifest.peerFloors) {
    const declarations = parsed.flatMap((item) => {
      return findDependencies(item.json, floor.name).map((found) => ({ item, found }));
    });
    const destinations = declarations.length > 0
      ? declarations
      : peerFloorDestinations(parsed, targetOwners, repoPath, floor.name);

    for (const { item, found } of destinations) {
      if (satisfiesFloor(found.spec, floor.range)) continue;
      if (found.spec && isNonRegistrySpec(found.spec)) {
        throw new DependencyUpdateError(
          `${floor.name} in ${item.relative} uses unsupported non-registry spec ${JSON.stringify(found.spec)}`
        );
      }
      const previous = found.spec || "(not declared)";
      found.section[floor.name] = floor.range;
      sink.push({
        file: item.relative,
        kind: "applied",
        code: "PKG2",
        message: `${floor.name} (${found.sectionName}): ${previous} -> ${floor.range} (required peer floor)`,
        line: null,
      });
    }
  }

  const changed: string[] = [];
  for (const item of parsed) {
    const next = stringifyLike(item.text, item.json);
    if (next !== item.text) {
      writeFileSync(item.absolute, next);
      changed.push(item.relative);
    }
  }

  return {
    packageFiles: changed.sort(),
    packageManager: detectPackageManager(repoPath, parsed[0]!.json),
    lockfiles: findLockfiles(repoPath),
  };
}

export function detectPackageManager(repoPath: string, root?: PackageJson): PackageManager {
  const declared = root?.packageManager?.split("@")[0];
  if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun") {
    return declared;
  }
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"))) return "bun";
  return "npm";
}

export function findLockfiles(repoPath: string): string[] {
  return ROOT_LOCKFILES.filter((name) =>
    validateRepositoryFile(repoPath, name, ROOT_LOCKFILE_POLICY, true) !== null
  );
}

/** Read a validated root lockfile without following repository symlinks. */
export function readRootLockfile(repoPath: string, name: string): Buffer {
  if (!isRootLockfileName(name)) {
    throw new DependencyUpdateError(`Unsupported root lockfile name: ${name}`);
  }
  return readRepositoryFile(repoPath, name, ROOT_LOCKFILE_POLICY);
}

export function isRootLockfileName(name: string): boolean {
  return (ROOT_LOCKFILES as readonly string[]).includes(name);
}

function findPackageJsonFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.name === "package.json") {
        if (!entry.isFile()) {
          const path = relative(root, absolute);
          throw new DependencyUpdateError(`Package manifest must be a regular non-symlink file: ${path}`);
        }
        out.push(absolute);
      } else if (entry.isDirectory()) stack.push(absolute);
    }
  }
  return out.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

function parsePackageJson(path: string, text: string): PackageJson {
  try {
    return JSON.parse(text) as PackageJson;
  } catch (error) {
    throw new DependencyUpdateError(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

function peerFloorDestinations<T extends { absolute: string; json: PackageJson }>(
  items: T[],
  targetOwners: T[],
  repoPath: string,
  name: string
): Array<{ item: T; found: ReturnType<typeof ensureDevDependency> }> {
  const root = items.find((item) => dirname(item.absolute) === repoPath);
  const destinations = root ? [root] : targetOwners;
  return destinations.map((item) => ({ item, found: ensureDevDependency(item.json, name) }));
}

function findDependencies(
  json: PackageJson,
  name: string
): Array<{ section: Record<string, string>; sectionName: DependencySectionName; spec: string }> {
  const found: Array<{ section: Record<string, string>; sectionName: DependencySectionName; spec: string }> = [];
  for (const key of DEPENDENCY_SECTIONS) {
    const section = json[key];
    if (section && typeof section[name] === "string") {
      found.push({ section, sectionName: key, spec: section[name]! });
    }
  }
  return found;
}

function ensureDevDependency(
  json: PackageJson,
  name: string
): { section: Record<string, string>; sectionName: "devDependencies"; spec: string } {
  json.devDependencies ??= {};
  return {
    section: json.devDependencies,
    sectionName: "devDependencies",
    spec: json.devDependencies[name] ?? "",
  };
}

function dependencyState(
  current: string,
  expectedSource: string,
  target: string,
  name: string,
  file: string
): "source" | "target" {
  if (current === target) return "target";
  if (isNonRegistrySpec(current)) {
    throw new DependencyUpdateError(`${name} in ${file} uses unsupported non-registry spec ${JSON.stringify(current)}`);
  }
  const currentMajor = firstVersion(current)?.[0];
  const sourceVersion = firstVersion(expectedSource);
  const targetVersion = firstVersion(target);
  if (currentMajor == null || !sourceVersion || !targetVersion) {
    if (current === expectedSource) return "source";
    throw new DependencyUpdateError(
      `${name} in ${file} is ${JSON.stringify(current)}, outside manifest source ${JSON.stringify(expectedSource)} and target ${JSON.stringify(target)}`
    );
  }

  if (sourceVersion[0] === targetVersion[0]) {
    const currentVersion = firstVersion(current)!;
    return compareVersions(currentVersion, targetVersion) >= 0 ? "target" : "source";
  }
  if (currentMajor === targetVersion[0]) return "target";
  if (currentMajor === sourceVersion[0]) return "source";
  throw new DependencyUpdateError(
    `${name} in ${file} is ${JSON.stringify(current)}, outside manifest source ${JSON.stringify(expectedSource)} and target ${JSON.stringify(target)}`
  );
}

function satisfiesFloor(current: string, floor: string): boolean {
  if (!current || isNonRegistrySpec(current)) return false;
  const have = firstVersion(current);
  const need = firstVersion(floor);
  if (!have || !need) return current === floor;
  return compareVersions(have, need) >= 0;
}

function firstVersion(spec: string): [number, number, number] | null {
  const match = spec.match(/(?:^|[^\d])(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/i);
  if (!match) return null;
  return [Number(match[1]), numericPart(match[2]), numericPart(match[3])];
}

function numericPart(value: string | undefined): number {
  return !value || value === "x" || value === "*" ? 0 : Number(value);
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const difference = a[i]! - b[i]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function isNonRegistrySpec(spec: string): boolean {
  return /^(?:workspace:|file:|link:|portal:|patch:|catalog:|npm:|git(?:\+|:)|https?:|github:)/.test(spec);
}

function stringifyLike(original: string, value: PackageJson): string {
  const indent = original.match(/\n([ \t]+)\S/)?.[1] ?? "  ";
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  return JSON.stringify(value, null, indent).replace(/\n/g, newline) + (original.endsWith(newline) ? newline : "");
}
