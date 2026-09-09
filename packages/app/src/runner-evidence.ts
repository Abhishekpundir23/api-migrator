import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerEvidenceFailure, validateRunnerEvidenceConfiguration, type RunnerEvidenceClientResult } from "./runner-evidence-contract.js";
import { createRunnerEvidenceClientWithDependencies } from "./runner-evidence-core.js";
import { readRunnerKeyRegistry, type RunnerRegistryPolicy } from "./runner-key-registry.js";
import { fetchRunnerEvidenceEnvelope } from "./runner-evidence-transport.js";

const APPLICATION_CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Construct an unconfigured-to-any-route, read-only server client without IO. */
export function createRunnerEvidenceClient(config: unknown, policy: unknown): RunnerEvidenceClientResult {
  if (arguments.length !== 2) return runnerEvidenceFailure("configuration_invalid");
  try {
    const validated = validateRunnerEvidenceConfiguration(config, policy);
    const registryPolicy: RunnerRegistryPolicy = Object.freeze({
      applicationCheckout: APPLICATION_CHECKOUT,
      excludedRoots: validated.policy.migrationWorkspaceRoots,
      platformExcludedRoots: Object.freeze([...new Set([tmpdir(), "/tmp", "/var/tmp", "/run"])]),
    });
    const client = createRunnerEvidenceClientWithDependencies({
      clock: { wallNow: () => Date.now(), monotonicNow: () => performance.now() },
      readKey: (context, deadline) => readRunnerKeyRegistry(validated.config.registryDirectory, registryPolicy, context, deadline),
      fetchEnvelope: (jobId, deadline) => fetchRunnerEvidenceEnvelope(validated.config, jobId, deadline),
    });
    return Object.freeze({ ok: true as const, client });
  } catch {
    return runnerEvidenceFailure("configuration_invalid");
  }
}
