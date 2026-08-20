import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOSTED_SMOKE_AUTHORIZATION_STATUS,
  HOSTED_SMOKE_SCENARIO_MATRIX,
  buildHostedSmokeAggregateReport,
  parseCanonicalHostedSmokeAggregateReport,
  parseCanonicalHostedSmokeScenarioReport,
} from "./hosted-lifecycle-smoke.mjs";
import { canonicalJson } from "./lib.mjs";

const SCENARIO_REPORT_BASENAME = "scenario-report.json";
const MAX_SCENARIO_REPORT_BYTES = 256 * 1024;
const MAX_TOTAL_SCENARIO_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_DIRECTORY_DEPTH = 8;

/** Parse the only supported CLI shape. Both paths must already be absolute and normalized. */
export function parseAggregateHostedSmokeArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "--input-dir" || argv[2] !== "--output") {
    throw new Error("usage: --input-dir ABSOLUTE_PATH --output ABSOLUTE_PATH");
  }
  const inputDir = absoluteNormalizedPath(argv[1], "hosted smoke input directory");
  const output = absoluteNormalizedPath(argv[3], "hosted smoke aggregate output");
  if (inputDir === output || isWithin(inputDir, output)) {
    throw new Error("hosted smoke aggregate output must be outside the input directory");
  }
  return Object.freeze({ inputDir, output });
}

/**
 * Recursively load the exact 15 canonical reports from distinct artifact
 * directories. The input tree is an exact closure: unrelated files, links,
 * device nodes, and direct-at-root reports are rejected.
 */
export function discoverHostedSmokeScenarioReports(inputDir) {
  const canonicalInputDir = absoluteNormalizedPath(inputDir, "hosted smoke input directory");
  assertNonSymlinkDirectory(canonicalInputDir, "hosted smoke input directory");

  const reportPaths = [];
  let visitedEntries = 0;
  walk(canonicalInputDir, 0);

  if (reportPaths.length !== HOSTED_SMOKE_SCENARIO_MATRIX.length) {
    throw new Error("hosted smoke input must contain exactly 15 scenario-report.json files");
  }

  const artifactDirectories = new Set();
  const loaded = [];
  let totalBytes = 0;
  for (const reportPath of reportPaths.sort()) {
    const artifactDirectory = dirname(reportPath);
    const artifactRelativePath = relative(canonicalInputDir, artifactDirectory);
    if (!artifactRelativePath || artifactRelativePath === "." || isAbsolute(artifactRelativePath) || artifactRelativePath.startsWith("..")) {
      throw new Error("each hosted smoke report must be inside an artifact subdirectory");
    }
    if (artifactDirectories.has(artifactDirectory)) {
      throw new Error("hosted smoke reports must come from distinct artifact subdirectories");
    }
    artifactDirectories.add(artifactDirectory);

    const stable = readStableScenarioReport(reportPath);
    totalBytes += stable.byteLength;
    if (totalBytes > MAX_TOTAL_SCENARIO_BYTES) {
      throw new Error("hosted smoke scenario reports exceed the bounded total size");
    }
    loaded.push(Object.freeze({
      path: reportPath,
      artifactDirectory,
      byteLength: stable.byteLength,
      digest: stable.parsed.digest,
      report: stable.parsed.report,
    }));
  }

  return Object.freeze(loaded);

  function walk(directory, depth) {
    if (depth > MAX_DIRECTORY_DEPTH) {
      throw new Error("hosted smoke artifact tree exceeds the bounded directory depth");
    }
    assertNonSymlinkDirectory(directory, "hosted smoke artifact directory");
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"));
    visitedEntries += entries.length;
    if (visitedEntries > MAX_DIRECTORY_ENTRIES) {
      throw new Error("hosted smoke artifact tree exceeds the bounded entry count");
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("hosted smoke artifact tree cannot contain symbolic links");
      if (info.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new Error("hosted smoke artifact tree contains a non-regular entry");
      if (entry.name !== SCENARIO_REPORT_BASENAME) {
        throw new Error("hosted smoke artifact tree contains an extra regular file");
      }
      if (directory === canonicalInputDir) {
        throw new Error("each hosted smoke report must be inside an artifact subdirectory");
      }
      reportPaths.push(path);
    }
  }
}

/** Build the permanently non-authorizing canonical aggregate from one artifact tree. */
export function buildHostedSmokeAggregateFromDirectory(inputDir) {
  const loaded = discoverHostedSmokeScenarioReports(inputDir);
  return buildHostedSmokeAggregateReport({ scenarioReports: loaded.map(({ report }) => report) });
}

/** Write exact aggregate bytes once, with mode 0600 and no symlink traversal. */
export function writeExclusiveHostedSmokeAggregate(outputPath, aggregateCanonicalJson) {
  const canonicalOutputPath = absoluteNormalizedPath(outputPath, "hosted smoke aggregate output");
  if (typeof aggregateCanonicalJson !== "string") {
    throw new Error("hosted smoke aggregate output must be exact canonical JSON text");
  }
  const parsed = parseCanonicalHostedSmokeAggregateReport(aggregateCanonicalJson);
  const outputParent = dirname(canonicalOutputPath);
  assertNonSymlinkDirectory(outputParent, "hosted smoke aggregate output parent");

  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  const fd = openSync(canonicalOutputPath, flags, 0o600);
  let descriptorInfo;
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, parsed.canonicalJson, { encoding: "utf8" });
    fsyncSync(fd);
    descriptorInfo = fstatSync(fd);
    if (!descriptorInfo.isFile() || descriptorInfo.nlink !== 1 ||
        (descriptorInfo.mode & 0o777) !== 0o600 || descriptorInfo.size !== Buffer.byteLength(parsed.canonicalJson, "utf8")) {
      throw new Error("hosted smoke aggregate output is not an exact mode-0600 regular file");
    }
  } finally {
    closeSync(fd);
  }

  const pathInfo = lstatSync(canonicalOutputPath);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1 ||
      pathInfo.dev !== descriptorInfo.dev || pathInfo.ino !== descriptorInfo.ino ||
      (pathInfo.mode & 0o777) !== 0o600) {
    throw new Error("hosted smoke aggregate output path binding changed");
  }
  return Object.freeze({ path: canonicalOutputPath, digest: parsed.digest, byteLength: pathInfo.size });
}

/** Aggregate one complete GitHub artifact download and emit no authorizing result. */
export function runHostedSmokeAggregation(argv) {
  const args = parseAggregateHostedSmokeArguments(argv);
  const built = buildHostedSmokeAggregateFromDirectory(args.inputDir);
  const written = writeExclusiveHostedSmokeAggregate(args.output, built.canonicalJson);
  return Object.freeze({
    kind: "api_migrator_github_hosted_l7_smoke_aggregate_cli_result",
    status: "passed",
    scenarioCount: HOSTED_SMOKE_SCENARIO_MATRIX.length,
    aggregateDigest: built.digest,
    outputPath: written.path,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: HOSTED_SMOKE_AUTHORIZATION_STATUS,
  });
}

function readStableScenarioReport(path) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_SCENARIO_REPORT_BYTES)) {
      throw new Error("hosted smoke scenario report is not a bounded single-link regular file");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (
      bytes.length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("hosted smoke scenario report changed while it was read");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("hosted smoke scenario report is not valid UTF-8");
    }
    return Object.freeze({ byteLength: bytes.length, parsed: parseCanonicalHostedSmokeScenarioReport(text) });
  } finally {
    closeSync(fd);
  }
}

function assertNonSymlinkDirectory(path, label) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} is not a non-symlink directory`);
  }
}

function absoluteNormalizedPath(value, label) {
  if (typeof value !== "string" || value.length < 1 || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return value;
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runHostedSmokeAggregation(process.argv.slice(2));
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch (error) {
    process.stderr.write(`hosted smoke aggregation refused: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
