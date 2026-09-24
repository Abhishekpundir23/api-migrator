#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseImageLifecycleFixtureCli, validateFixtureEnvironment } from "./run-image-lifecycle-fixture.mjs";
import { deriveFixtureResources, validateFixtureOwnership } from "./fixture-ownership.mjs";
import { cleanupNativeFixture, readFixtureMarker } from "./fixture-native.mjs";
import * as host from "./run-hosted-smoke.mjs";

export async function cleanupImageLifecycleFixture(argv) {
  const auditOnly = argv.at(-1) === "--audit-only";
  const config = parseImageLifecycleFixtureCli(auditOnly ? argv.slice(0, -1) : argv);
  const environment = validateFixtureEnvironment(process.env);
  host.assertLinuxHostedRoot();
  const resources = deriveFixtureResources({ ...environment, ...config });
  const tools = host.buildToolInventory(environment.envoyPath).paths;
  const docker = host.findTool(["/usr/bin/docker"], "Docker");
  if (!existsSync(join(config.outputDir, "ownership.json"))) {
    // No mutation is allowed before that durable marker. Refuse any ambiguous
    // partial setup rather than inventing deletion authority.
    if (existsSync(resources.runtimeRoot) || existsSync(resources.workspacePath) ||
        host.unitSnapshot(tools.systemctl, resources.gatewayUnit).values.LoadState !== "not-found" ||
        host.pidsForUid(12001).length || host.pidsForUid(12002).length ||
        !host.proveHostedListenerAbsence(host.listenerSnapshot(tools.ss, 15443))) throw new Error("fixture resources exist without ownership authority");
    return { complete: true, mode: "never_started" };
  }
  const marker = readFixtureMarker(config.outputDir);
  const bound = deriveFixtureResources({ ...resources, jobId: marker.jobId, planDigest: marker.planDigest });
  validateFixtureOwnership(marker, bound);
  return cleanupNativeFixture(bound, { tools, docker, outputDir: config.outputDir, auditOnly });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cleanupImageLifecycleFixture(process.argv.slice(2)).then((value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    () => { process.stderr.write("fixture cleanup/audit failed; containment retained where possible\n"); process.exitCode = 1; });
}
