import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseGatewayLifecycleCli } from "../run-gateway-lifecycle.mjs";

const SCRIPT = resolve(new URL("../run-gateway-lifecycle.mjs", import.meta.url).pathname);
const JOB = "/var/lib/api-migrator-runner/jobs/job-001/job-descriptor.json";

test("accepts only the exact non-authorizing preflight CLI", () => {
  assert.deepEqual(parseGatewayLifecycleCli(["--preflight", "--job", JOB]), {
    mode: "preflight",
    jobPath: JOB,
  });
  for (const argv of [
    [],
    ["--preflight"],
    ["--job", JOB, "--preflight"],
    ["--preflight", "--job", "relative/job.json"],
    ["--preflight", "--job", JOB, "--live"],
    ["--activate", "--job", JOB],
    ["--publish", "--job", JOB],
  ]) {
    assert.throws(() => parseGatewayLifecycleCli(argv), /usage: run-gateway-lifecycle\.mjs --preflight --job ABSOLUTE_PATH/);
  }
});

test("invalid CLI exits before reading host or job state", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--activate", "--job", JOB], {
    encoding: "utf8",
    env: {},
    timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^usage: run-gateway-lifecycle\.mjs --preflight --job ABSOLUTE_PATH\n$/);
});

test("CLI remains a narrow preflight adapter without lifecycle, signing, or publication commands", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /runLifecyclePreflight/);
  assert.doesNotMatch(source, /spawn(?:Sync)?\s*\(/);
  assert.doesNotMatch(source, /nftables_policy_installed|gateway_started|prepare_publish|signingRequest/);
  assert.match(source, /gatewayLifecycleMutationPerformed: false/);
  assert.match(source, /releaseEvidenceEligible: false/);
  assert.match(source, /activationBlocked: true/);
  assert.match(source, /externalSigningEligible: false/);
});
