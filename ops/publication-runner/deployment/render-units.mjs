#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBSERVER_UNIT,
  RUNNER_UNIT,
  canonicalJson,
  deriveRuntimeMaxMs,
  parseCanonicalPlan,
  parseJson,
  validateHostProfile,
  validateJobDescriptor,
} from "./lib.mjs";

const DEPLOYMENT_DIR = dirname(fileURLToPath(import.meta.url));

export function renderUnits(input) {
  const job = validateJobDescriptor(input.job);
  const profile = validateHostProfile(input.profile);
  const plan = parseCanonicalPlan(input.planText, job.planDigest, job.jobId);
  const nowMs = input.nowMs ?? Date.now();
  const runtimeMaxMs = deriveRuntimeMaxMs(plan, nowMs);
  if (job.unitRenderedAt !== nowMs || job.runtimeMaxMs !== runtimeMaxMs) {
    throw new Error("job descriptor does not bind the exact unit render time and deadline");
  }
  if (profile.artifacts.imageDigest !== plan.imageDigest) {
    throw new Error("host profile runner image does not match the exact plan image");
  }
  const descriptorPath = supportedAbsolutePath(input.jobDescriptorPath, "job descriptor path");
  if (dirname(descriptorPath) !== dirname(job.planPath)) {
    throw new Error("job descriptor must reside in the exact sealed job root");
  }
  const templateDirectory = input.templateDirectory ?? `${DEPLOYMENT_DIR}/systemd`;
  const outputParent = dirname(job.outputPath);
  const evidenceParent = dirname(job.rawEventsPath);
  if (dirname(job.runnerResultPath) !== evidenceParent) {
    throw new Error("runner raw and result evidence must share one sealed parent");
  }
  const observerWritePaths = [...new Set([dirname(job.observationPath), dirname(job.signingRequestPath)])].join(" ");
  const replacements = {
    "@RUNTIME_MAX_MS@": String(runtimeMaxMs),
    "@RUNNER_IMAGE@": profile.artifacts.imageReference,
    "@RUNNER_UID@": String(profile.runner.uid),
    "@RUNNER_GID@": String(profile.runner.gid),
    "@RUNNER_STORAGE_ROOT@": profile.runner.storageRoot,
    "@RUNNER_STORAGE_DRIVER@": profile.runner.storageDriver,
    "@OCI_RUNTIME_PATH@": profile.executables.ociRuntime.path,
    "@CONMON_PATH@": profile.executables.conmon.path,
    "@JOB_ID@": job.jobId,
    "@WRAPPER_PATH@": profile.artifacts.wrapperPath,
    "@PLAN_PATH@": job.planPath,
    "@PLAN_DIGEST@": job.planDigest,
    "@SOURCE_ARCHIVE_PATH@": job.sourceArchivePath,
    "@OUTPUT_PATH@": job.outputPath,
    "@RAW_EVENTS_PATH@": job.rawEventsPath,
    "@CLEANUP_PATH@": profile.artifacts.cleanupPath,
    "@JOB_DESCRIPTOR_PATH@": descriptorPath,
    "@OUTPUT_PARENT@": outputParent,
    "@EVIDENCE_PARENT@": evidenceParent,
    "@NODE_PATH@": profile.executables.node.path,
    "@OBSERVER_PATH@": profile.artifacts.observerPath,
    "@OBSERVATION_PARENT@": observerWritePaths,
  };
  for (const [token, value] of Object.entries(replacements)) {
    if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
      throw new Error(`unsafe systemd replacement for ${token}`);
    }
  }
  const runnerTemplate = readFileSync(`${templateDirectory}/api-migrator-runner.service.in`, "utf8");
  const observerTemplate = readFileSync(`${templateDirectory}/api-migrator-runner-observer.service.in`, "utf8");
  const runnerUnit = renderTemplate(runnerTemplate, replacements);
  const observerUnit = renderTemplate(observerTemplate, replacements);
  return {
    schemaVersion: 1,
    kind: "api_migrator_systemd_unit_render",
    installPerformed: false,
    activationBlocked: true,
    authorizationStatus: "blocked_pending_linux_gateway_lifecycle_drill",
    externalSigningEligible: false,
    linuxDrillRequired: true,
    renderedAt: nowMs,
    planExpiresAt: plan.job.expiresAt,
    runtimeMaxMs,
    serializedRunnerUnit: RUNNER_UNIT,
    observerUnit: OBSERVER_UNIT,
    runnerUnit,
    observerUnitDefinition: observerUnit,
  };
}

function renderTemplate(template, replacements) {
  let output = template;
  for (const [token, value] of Object.entries(replacements)) output = output.split(token).join(value);
  const unresolved = output.match(/@[A-Z][A-Z0-9_]*@/g);
  if (unresolved) throw new Error(`systemd template has unresolved tokens: ${unresolved.join(",")}`);
  if (!output.endsWith("\n") || output.includes("%E") || output.includes("$")) {
    throw new Error("rendered systemd unit contains unsupported expansion syntax");
  }
  return output;
}

function supportedAbsolutePath(value, label) {
  if (typeof value !== "string" || !/^\/[A-Za-z0-9._/-]+$/.test(value) ||
      value.includes("//") || value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`${label} is unsupported`);
  }
  return value;
}

function cliArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--job", "--host-profile", "--now-ms"]).has(name) || value === undefined || values.has(name)) {
      throw new Error("usage: render-units.mjs --job PATH --host-profile PATH [--now-ms INTEGER]");
    }
    values.set(name, value);
  }
  if (!values.has("--job") || !values.has("--host-profile")) {
    throw new Error("usage: render-units.mjs --job PATH --host-profile PATH [--now-ms INTEGER]");
  }
  const now = values.has("--now-ms") ? Number(values.get("--now-ms")) : Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("--now-ms must be a positive safe integer");
  return { jobPath: values.get("--job"), profilePath: values.get("--host-profile"), now };
}

async function main() {
  const { jobPath, profilePath, now } = cliArguments(process.argv.slice(2));
  const absoluteJobPath = resolve(jobPath);
  const job = validateJobDescriptor(parseJson(readFileSync(absoluteJobPath, "utf8"), "job descriptor", 32 * 1024));
  const profile = validateHostProfile(parseJson(readFileSync(resolve(profilePath), "utf8"), "host profile", 128 * 1024));
  const rendered = renderUnits({
    job,
    profile,
    planText: readFileSync(job.planPath, "utf8"),
    nowMs: now,
    jobDescriptorPath: absoluteJobPath,
  });
  process.stdout.write(`${canonicalJson(rendered)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`runner unit rendering refused: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
