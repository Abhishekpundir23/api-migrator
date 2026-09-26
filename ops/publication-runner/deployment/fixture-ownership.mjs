import { createHash } from "node:crypto";
import { canonicalJson } from "./lib.mjs";

export function deriveFixtureResources({ runId, runAttempt, scenario, jobId = null, image, planDigest = null }) {
  if (!/^[1-9][0-9]{0,19}$/.test(runId) || !Number.isSafeInteger(runAttempt) || runAttempt < 1 || runAttempt > 999999 ||
      !["success", "install_failure", "install_cancel"].includes(scenario) || !/^sha256:[a-f0-9]{64}$/.test(image) ||
      (jobId !== null && !/^previewjob_[a-f0-9]{64}$/.test(jobId)) ||
      (planDigest !== null && !/^sha256:[a-f0-9]{64}$/.test(planDigest)) || ((jobId === null) !== (planDigest === null))) {
    throw new Error("fixture ownership identity invalid");
  }
  const suffix = createHash("sha256").update(`api-migrator:image-lifecycle:v1\0${runId}\0${runAttempt}\0${scenario}`).digest("hex").slice(0, 16);
  return Object.freeze({ runId, runAttempt, scenario, jobId, image, planDigest, suffix,
    runtimeRoot: `/run/api-migrator-image-fixture/${suffix}`,
    workspacePath: `/run/api-migrator-image-fixture-workspace/${suffix}`,
    gatewayUnit: `api-migrator-fixture-gateway-${suffix}.service`,
    nftTable: jobId === null ? null : `api_migrator_gw_${jobId.slice(11, 27)}`,
    containers: Object.freeze(jobId === null ? {} : Object.fromEntries(["prepare", "install", "migrate", "verify"]
      .map((phase) => [phase, `api-migrator-fixture-${jobId}-${phase}`]))),
    runnerUid: 12001, gatewayUid: 12002, listenerPort: 15443 });
}

export function fixtureOwnership(resources) {
  const expected = deriveFixtureResources(resources);
  if (canonicalJson(expected) !== canonicalJson(resources)) throw new Error("fixture resources substituted");
  return { schemaVersion: 1, kind: "api_migrator_image_fixture_ownership", ...expected,
    securityDrill: false, selfAttested: true, releaseEvidenceEligible: false,
    activationBlocked: true, externalSigningEligible: false };
}

export function validateFixtureOwnership(marker, resources) {
  if (canonicalJson(marker) !== canonicalJson(fixtureOwnership(resources))) throw new Error("fixture ownership marker substituted");
  return marker;
}

// The host boundary contains native process/filesystem observations only; the
// fail-closed ordering and exact namespace remain here and are unit-tested.
export async function cleanupFixtureResources(resources, host) {
  fixtureOwnership(resources);
  host.validateOwnership();
  const tablePresent = host.tableExists();
  await host.removeContainers();
  await host.stopGateway();
  if (!host.containersAbsent() || !host.quiescent()) throw new Error("fixture cleanup live resources; containment retained");
  if (host.tableExists() !== tablePresent) throw new Error("fixture containment changed during cleanup");
  host.removeTrees();
  if (!host.treesAbsent() || !host.containersAbsent() || !host.quiescent()) throw new Error("fixture cleanup incomplete; containment retained");
  if (host.tableExists() !== tablePresent) throw new Error("fixture containment changed before table removal");
  if (tablePresent) host.deleteTable();
  if (host.tableExists() || !host.treesAbsent() || !host.containersAbsent() || !host.quiescent()) throw new Error("fixture cleanup residual state");
  return { complete: true };
}
