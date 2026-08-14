#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./lib.mjs";
import { runLifecyclePreflight } from "./lifecycle-preflight.mjs";

const USAGE = "usage: run-gateway-lifecycle.mjs --preflight --job ABSOLUTE_PATH";

export function parseGatewayLifecycleCli(argv) {
  if (
    !Array.isArray(argv) || argv.length !== 3 || argv[0] !== "--preflight" || argv[1] !== "--job" ||
    typeof argv[2] !== "string" || !isAbsolute(argv[2]) || !/^\/[A-Za-z0-9._/-]+$/.test(argv[2])
  ) {
    throw new Error(USAGE);
  }
  return Object.freeze({ mode: "preflight", jobPath: argv[2] });
}

export async function runGatewayLifecycle(argv, dependencies = {}) {
  const command = parseGatewayLifecycleCli(argv);
  const runtimeIdentity = dependencies.runtimeIdentity ?? {
    nodePath: process.execPath,
    entrypointPath: fileURLToPath(import.meta.url),
  };
  const completed = await runLifecyclePreflight(
    { jobPath: command.jobPath },
    { ...dependencies, runtimeIdentity }
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: "api_migrator_linux_l7_preflight_cli_result",
    jobId: completed.result.jobId,
    planDigest: completed.result.planDigest,
    lifecyclePreflightDigest: completed.digest,
    lifecyclePreflightPath: completed.result.paths.lifecyclePreflightPath,
    status: "passed",
    filesystemArtifactsCreated: true,
    gatewayLifecycleMutationPerformed: false,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: completed.result.authorizationStatus,
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await runGatewayLifecycle(process.argv.slice(2));
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
