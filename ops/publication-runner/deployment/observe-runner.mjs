#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildObservation,
  buildUnsignedSigningRequest,
  canonicalJson,
  parseJson,
  readBoundedFile,
  readDeploymentInputs,
  sha256File,
  writeExclusiveEvidence,
} from "./lib.mjs";

export function observeFromInputs(input) {
  const observation = buildObservation(input);
  const request = buildUnsignedSigningRequest(observation);
  return { observation, ...request };
}

function parseArguments(argv) {
  let jobPath;
  let mode;
  let snapshotPath;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--job" && jobPath === undefined) {
      jobPath = argv[++index];
    } else if (token === "--live") {
      throw new Error("live runner observation is disabled until the forced gateway lifecycle is integrated and drilled");
    } else if (token === "--snapshot" && mode === undefined) {
      mode = "contract_fixture";
      snapshotPath = argv[++index];
    } else {
      throw new Error("usage: observe-runner.mjs --job PATH --snapshot PATH");
    }
  }
  if (!jobPath || mode !== "contract_fixture" || !snapshotPath) {
    throw new Error("usage: observe-runner.mjs --job PATH --snapshot PATH");
  }
  return { jobPath: resolve(jobPath), mode, snapshotPath: snapshotPath ? resolve(snapshotPath) : undefined };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const { job, profile, planText, l7IntegrationStatus } = readDeploymentInputs(args.jobPath);
  const eventsText = readBoundedFile(job.rawEventsPath, 64 * 1024, "wrapper events");
  const resultText = readBoundedFile(job.runnerResultPath, 98_304, "runner result");
  const sourceArchiveDigest = await sha256File(job.sourceArchivePath);
  const snapshot = parseJson(
    readBoundedFile(args.snapshotPath, 64 * 1024, "contract fixture snapshot"),
    "contract fixture snapshot",
    64 * 1024
  );
  const built = observeFromInputs({
    job,
    profile,
    planText,
    eventsText,
    resultText,
    sourceArchiveDigest,
    l7IntegrationStatus,
    snapshot,
    renderedAt: job.unitRenderedAt,
    observationMode: args.mode,
    treeOptions: {},
  });
  writeExclusiveEvidence(job.observationPath, built.observationCanonicalJson);
  writeExclusiveEvidence(job.signingRequestPath, built.canonicalJson);
  process.stdout.write(`${canonicalJson({
    status: "unsigned_observation_complete",
    observationMode: built.observation.observationMode,
    eligibleForExternalSigning: built.request.eligibleForExternalSigning,
    jobId: job.jobId,
    observationDigest: built.request.observationDigest,
    signingRequestPath: job.signingRequestPath,
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`runner observation refused: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
