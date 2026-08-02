/** Deterministic Node runtime-floor migration and deployment attestation. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeRuntimePolicy } from "./manifest.js";
import {
  MAX_PACKAGE_MANIFEST_BYTES,
  readRepositoryFile,
} from "./repository-files.js";
import type { ReportSink } from "./types.js";

export const TRUSTED_NODE_RUNTIME_PROFILES = {
  "node22-bookworm-slim-2026-07": {
    image: "node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46",
    nodeVersion: "22.23.2",
    nodeMajor: 22,
    dockerfileSyntax: "# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89",
  },
} as const;

const PACKAGE_POLICY = {
  label: "runtime package manifest",
  maxBytes: MAX_PACKAGE_MANIFEST_BYTES,
} as const;
const DOCKERFILE_POLICY = {
  label: "deployment Dockerfile",
  maxBytes: 1024 * 1024,
} as const;

interface RuntimeEdit {
  path: string;
  before: string;
  after: string;
  code: "RT1" | "RT2";
  message: string;
}

interface DockerInstruction {
  keyword: string;
  args: string;
  line: number;
}

export interface RuntimeMigrationPlan {
  policy: NodeRuntimePolicy;
  edits: RuntimeEdit[];
}

export interface RuntimeMigrationResult {
  runtimeFiles: string[];
}

export interface RuntimeAttestation {
  ok: boolean;
  reason: string;
  image: string;
  nodeVersion: string;
  nodeMajor: number;
}

export class RuntimeMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeMigrationError";
  }
}

/**
 * Validate every runtime edit before any file is written. The policy paths and
 * image profile have already been restricted by the manifest schema.
 */
export function planNodeRuntimeMigration(
  repoPath: string,
  policy: NodeRuntimePolicy
): RuntimeMigrationPlan {
  const dockerfileText = readUtf8(repoPath, policy.dockerfile, DOCKERFILE_POLICY);
  const dockerfileNext = migrateDockerfile(dockerfileText, policy);
  const edits: RuntimeEdit[] = [];

  if (dockerfileNext !== dockerfileText) {
    edits.push({
      path: policy.dockerfile,
      before: dockerfileText,
      after: dockerfileNext,
      code: "RT2",
      message: `Pinned the deployment runtime to ${profile(policy).image}.`,
    });
  }

  // The post-edit bytes must satisfy the same verifier used after migration.
  attestDockerfile(dockerfileNext, policy);
  return { policy, edits };
}

export function applyNodeRuntimeMigration(
  repoPath: string,
  plan: RuntimeMigrationPlan,
  sink: ReportSink
): RuntimeMigrationResult {
  for (const edit of plan.edits) {
    const policy = edit.path === plan.policy.packageJson ? PACKAGE_POLICY : DOCKERFILE_POLICY;
    const current = readUtf8(repoPath, edit.path, policy);
    if (current !== edit.before) {
      throw new RuntimeMigrationError(`Runtime file changed after validation: ${edit.path}`);
    }
  }
  for (const edit of plan.edits) {
    writeFileSync(repositoryFilePath(repoPath, edit.path), edit.after);
    sink.push({ file: edit.path, kind: "applied", code: edit.code, message: edit.message, line: null });
  }
  return { runtimeFiles: plan.edits.map((edit) => edit.path).sort() };
}

/** Verify static post-migration package and Dockerfile declarations. */
export function attestNodeRuntime(
  repoPath: string,
  policy: NodeRuntimePolicy
): RuntimeAttestation {
  const selected = profile(policy);
  try {
    const packageText = readUtf8(repoPath, policy.packageJson, PACKAGE_POLICY);
    const dockerfileText = readUtf8(repoPath, policy.dockerfile, DOCKERFILE_POLICY);
    attestPackageEngine(packageText, policy, policy.packageJson);
    attestDockerfile(dockerfileText, policy);
    return {
      ok: true,
      reason: `Static declarations select Node ${selected.nodeVersion}, which satisfies the package engine floor, and constrain the final Docker stage to ${selected.image}; this check does not build the image`,
      image: selected.image,
      nodeVersion: selected.nodeVersion,
      nodeMajor: selected.nodeMajor,
    };
  } catch (error) {
    return {
      ok: false,
      reason: (error as Error).message,
      image: selected.image,
      nodeVersion: selected.nodeVersion,
      nodeMajor: selected.nodeMajor,
    };
  }
}

function attestPackageEngine(text: string, policy: NodeRuntimePolicy, path: string): void {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new RuntimeMigrationError(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
  const engines = isRecord(json) && isRecord(json.engines) ? json.engines : null;
  const node = engines?.node;
  const minimum = typeof node === "string" ? parseCanonicalNodeMinimum(node) : null;
  if (minimum === null) {
    throw new RuntimeMigrationError(
      `${path} engines.node must use canonical >=N, >=N.N, or >=N.N.N syntax`
    );
  }
  const required: NodeVersion = [policy.minimumMajor, 0, 0];
  if (compareNodeVersions(minimum, required) < 0) {
    throw new RuntimeMigrationError(`${path} does not prove engines.node >=${policy.minimumMajor}`);
  }
  const selected = parseExactNodeVersion(profile(policy).nodeVersion);
  if (compareNodeVersions(selected, minimum) < 0) {
    throw new RuntimeMigrationError(
      `${path} requires Node ${node}, but runtime profile ${policy.profile} provides Node ${formatNodeVersion(selected)}`
    );
  }
}

function migrateDockerfile(text: string, policy: NodeRuntimePolicy): string {
  const selected = profile(policy);
  let next = migrateDockerfileSyntax(text, selected.dockerfileSyntax);
  const trustedFrom = `FROM ${selected.image} AS base`;
  if (next.split(/\r?\n/).some((line) => line.trim().toLowerCase() === trustedFrom.toLowerCase())) {
    if (/^\s*ARG\s+NODE_VERSION\b/im.test(next)) {
      throw new RuntimeMigrationError("Dockerfile retains an overridable NODE_VERSION argument");
    }
    return next;
  }

  const argMatches = [...next.matchAll(/^([ \t]*)ARG[ \t]+NODE_VERSION[ \t]*=[ \t]*([^\s#]+)[ \t]*(?:#.*)?$/gim)];
  if (argMatches.length !== 1) {
    throw new RuntimeMigrationError("Dockerfile must contain exactly one static ARG NODE_VERSION declaration");
  }
  const fromMatches = [...next.matchAll(/^([ \t]*)FROM[ \t]+node:\$\{NODE_VERSION\}-slim[ \t]+AS[ \t]+base[ \t]*(?:#.*)?$/gim)];
  if (fromMatches.length !== 1) {
    throw new RuntimeMigrationError(
      "Dockerfile must contain exactly one audited FROM node:${NODE_VERSION}-slim AS base declaration"
    );
  }
  const argLine = argMatches[0]![0];
  const beforeArgRemoval = next;
  const obsoleteVersionComment = /^([ \t]*)#[ \t]*Adjust NODE_VERSION as desired[ \t]*\r?\n/im;
  next = next.replace(obsoleteVersionComment, "");
  next = next.replace(`${argLine}\r\n`, "").replace(`${argLine}\n`, "");
  if (next === beforeArgRemoval) next = next.replace(argLine, "");
  next = next.replace(fromMatches[0]![0], `${fromMatches[0]![1] ?? ""}${trustedFrom}`);
  return next;
}

function migrateDockerfileSyntax(text: string, expected: string): string {
  const firstNewline = text.indexOf("\n");
  const rawFirstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
  const firstLine = rawFirstLine.endsWith("\r") ? rawFirstLine.slice(0, -1) : rawFirstLine;
  if (firstLine === expected) return text;
  if (!["# syntax = docker/dockerfile:1", "# syntax=docker/dockerfile:1"].includes(firstLine)) {
    throw new RuntimeMigrationError("Dockerfile must begin with the approved Dockerfile frontend directive");
  }
  if (firstNewline === -1) return expected;
  const newline = rawFirstLine.endsWith("\r") ? "\r\n" : "\n";
  return `${expected}${newline}${text.slice(firstNewline + 1)}`;
}

function attestDockerfile(text: string, policy: NodeRuntimePolicy): void {
  const selected = profile(policy);
  const lines = text.split(/\r?\n/);
  if (lines[0] !== selected.dockerfileSyntax) {
    throw new RuntimeMigrationError(
      `Dockerfile must use the approved syntax directive ${JSON.stringify(selected.dockerfileSyntax)}`
    );
  }
  for (let index = 1; index < lines.length; index++) {
    if (/^\s*#\s*(?:syntax|escape|check)\s*=/i.test(lines[index]!)) {
      throw new RuntimeMigrationError(`Unsupported Dockerfile parser directive at line ${index + 1}`);
    }
  }

  const instructions = logicalDockerInstructions(lines);
  const actual = instructions.map(canonicalDockerInstruction);
  const expected = [
    `FROM ${selected.image} AS base`,
    `LABEL fly_launch_runtime="Next.js"`,
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "FROM base AS build",
    "RUN apt-get update -qq && apt-get install -y python-is-python3 pkg-config build-essential",
    "COPY --link package-lock.json package.json ./",
    "RUN npm ci --include=dev",
    "COPY --link . .",
    "RUN npm run build",
    "RUN npm prune --omit=dev",
    "FROM base",
    "COPY --from=build /app /app",
    "EXPOSE 3000",
    `CMD [ "npm", "run", "start" ]`,
  ];
  if (actual.length !== expected.length) {
    throw new RuntimeMigrationError(
      `Dockerfile must match the audited three-stage deployment recipe; expected ${expected.length} instructions, found ${actual.length}`
    );
  }
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) {
      const line = instructions[index]?.line ?? 1;
      throw new RuntimeMigrationError(
        `Dockerfile instruction at line ${line} is outside the audited three-stage deployment recipe`
      );
    }
  }
}

function profile(policy: NodeRuntimePolicy) {
  const selected = TRUSTED_NODE_RUNTIME_PROFILES[policy.profile];
  const exact = parseExactNodeVersion(selected.nodeVersion);
  if (exact[0] !== selected.nodeMajor) {
    throw new RuntimeMigrationError(`Runtime profile ${policy.profile} has inconsistent Node version metadata`);
  }
  if (exact[0] < policy.minimumMajor) {
    throw new RuntimeMigrationError(
      `Runtime profile Node ${selected.nodeVersion} is below required Node ${policy.minimumMajor}`
    );
  }
  return selected;
}

function logicalDockerInstructions(lines: readonly string[]): DockerInstruction[] {
  const instructions: DockerInstruction[] = [];
  let logical = "";
  let startLine = 0;
  for (let index = 1; index < lines.length; index++) {
    const trimmed = lines[index]!.trim();
    if (!logical && (!trimmed || trimmed.startsWith("#"))) continue;
    if (logical && (!trimmed || trimmed.startsWith("#"))) {
      throw new RuntimeMigrationError(`Dockerfile comments or blank lines may not split an instruction at line ${index + 1}`);
    }
    if (!logical) startLine = index + 1;
    const continued = trimmed.endsWith("\\");
    const fragment = continued ? trimmed.slice(0, -1).trimEnd() : trimmed;
    logical = logical ? `${logical} ${fragment}` : fragment;
    if (continued) continue;

    const match = /^([A-Za-z]+)(?:[ \t]+(.+))?$/.exec(logical);
    if (!match) throw new RuntimeMigrationError(`Unsupported Dockerfile instruction at line ${startLine}`);
    const args = (match[2] ?? "").replace(/[ \t]+/g, " ").trim();
    if (/\$(?:\{|[A-Za-z_])/.test(args)) {
      throw new RuntimeMigrationError(`Dockerfile dynamic variables are not allowed at line ${startLine}`);
    }
    instructions.push({ keyword: match[1]!.toUpperCase(), args, line: startLine });
    logical = "";
  }
  if (logical) throw new RuntimeMigrationError(`Dockerfile has an unterminated instruction at line ${startLine}`);
  return instructions;
}

function canonicalDockerInstruction(instruction: DockerInstruction): string {
  const value = instruction.args ? `${instruction.keyword} ${instruction.args}` : instruction.keyword;
  if (instruction.keyword === "FROM") {
    return value.replace(/\s+as\s+/i, " AS ");
  }
  return value;
}

function readUtf8(
  repoPath: string,
  path: string,
  policy: { label: string; maxBytes: number }
): string {
  const bytes = readRepositoryFile(repoPath, path, policy);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RuntimeMigrationError(`${policy.label} is not valid UTF-8: ${path}`);
  }
}

function repositoryFilePath(repoPath: string, path: string): string {
  return join(repoPath, path);
}

export type NodeVersion = readonly [major: number, minor: number, patch: number];

export function parseCanonicalNodeMinimum(range: string): NodeVersion | null {
  const match = /^>=(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/.exec(range);
  if (!match) return null;
  const version: NodeVersion = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  return version.every(Number.isSafeInteger) ? version : null;
}

export function parseExactNodeVersion(version: string): NodeVersion {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new RuntimeMigrationError(`Runtime profile has invalid Node version ${JSON.stringify(version)}`);
  const parsed: NodeVersion = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parsed.every(Number.isSafeInteger)) {
    throw new RuntimeMigrationError(`Runtime profile has invalid Node version ${JSON.stringify(version)}`);
  }
  return parsed;
}

export function compareNodeVersions(a: NodeVersion, b: NodeVersion): number {
  for (let index = 0; index < 3; index++) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function formatNodeVersion(version: NodeVersion): string {
  return version.join(".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
