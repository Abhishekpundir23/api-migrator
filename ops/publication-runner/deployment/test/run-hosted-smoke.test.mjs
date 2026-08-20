import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  countMatchingAccessLogs,
  nftCounterDelta,
  parseHostedSmokeCli,
  parseHostedSmokeEnvironment,
  parseNftCounterSnapshot,
  proveHostedListenerAbsence,
  resolveHostedNpmOrigin,
  validateHostedSmokeAccounts,
} from "../run-hosted-smoke.mjs";

const OUTPUT = "/var/lib/api-migrator-hosted-smoke-evidence/success";

function environment() {
  return {
    PATH: "/usr/local/libexec/api-migrator-hosted-smoke:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    API_MIGRATOR_HOSTED_ENVOY_PATH: "/usr/local/libexec/api-migrator-hosted-smoke/envoy",
    API_MIGRATOR_SMOKE_RUN_ID: "123456789",
    API_MIGRATOR_SMOKE_RUN_ATTEMPT: "2",
    API_MIGRATOR_SMOKE_SOURCE_REVISION: "a".repeat(40),
    API_MIGRATOR_SMOKE_REPOSITORY: "example/api-migrator",
    API_MIGRATOR_SMOKE_WORKFLOW_REF: "example/api-migrator/.github/workflows/linux-l7-smoke.yml@refs/pull/1/merge",
    API_MIGRATOR_SMOKE_IMAGE_VERSION: "20260818.1",
  };
}

test("accepts only one fixed hosted scenario and a canonical absolute output path", () => {
  assert.deepEqual(parseHostedSmokeCli(["--scenario", "success", "--output-dir", OUTPUT]), {
    scenario: "success",
    outputDir: OUTPUT,
  });
  for (const argv of [
    [],
    ["--scenario", "oom", "--output-dir", OUTPUT],
    ["--scenario", "reboot", "--output-dir", OUTPUT],
    ["--scenario", "success", "--output-dir", "relative"],
    ["--scenario", "success", "--output-dir", "/"],
    ["--scenario", "success", "--output-dir", "/var/tmp"],
    ["--scenario", "success", "--output-dir", `${OUTPUT}/../forged`],
    ["--scenario", "success", "--output-dir", OUTPUT, "--publish"],
  ]) assert.throws(() => parseHostedSmokeCli(argv), /usage/);
});

test("parses the exact report coordinates without accepting credentials", () => {
  assert.deepEqual(parseHostedSmokeEnvironment(environment()), {
    runId: "123456789",
    runAttempt: 2,
    sourceRevision: "a".repeat(40),
    repository: "example/api-migrator",
    workflowRef: "example/api-migrator/.github/workflows/linux-l7-smoke.yml@refs/pull/1/merge",
    imageVersion: "20260818.1",
    envoyPath: "/usr/local/libexec/api-migrator-hosted-smoke/envoy",
  });
  assert.throws(
    () => parseHostedSmokeEnvironment({ ...environment(), API_MIGRATOR_SMOKE_SOURCE_REVISION: "main" }),
    /missing or invalid/
  );
});

test("requires every exact nftables rule counter and computes monotonic deltas", () => {
  const policy = readFileSync(new URL("../../gateway/templates/forced-gateway-egress.nft.in", import.meta.url), "utf8");
  const comments = [...policy.matchAll(/comment "([^"]+)"/g)]
    .map((match) => match[1])
    .filter((comment) => !comment.includes("downstream response"));
  assert.equal(comments.length, 7);
  const snapshot = comments.map((comment, index) =>
    `counter packets ${index + 1} bytes ${(index + 1) * 10} accept comment "${comment}"`
  ).join("\n");
  const counters = parseNftCounterSnapshot(snapshot);
  assert.deepEqual(counters, {
    redirect: 1,
    runnerV4: 2,
    runnerV6: 3,
    runnerReject: 4,
    gatewayV4: 5,
    gatewayV6: 6,
    gatewayReject: 7,
  });
  assert.equal(nftCounterDelta(counters, { ...counters, redirect: 3 }, "redirect"), 2);
  assert.throws(() => nftCounterDelta(counters, { ...counters, redirect: 0 }, "redirect"), /backwards/);
  assert.throws(() => parseNftCounterSnapshot(snapshot.split("\n").slice(1).join("\n")), /missing counter/);
});

test("waits through a cached low TTL and binds only a fresh DNS plan window", async () => {
  const answers = [34, 12, 300];
  let now = 2_000_000_000_000;
  const sleeps = [];
  const result = await resolveHostedNpmOrigin({
    resolver: async () => [{ address: "104.16.1.35", ttl: answers.shift() }],
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  assert.deepEqual(result, {
    addresses: ["104.16.1.35"],
    minimumTtlSeconds: 300,
    observedAt: 2_000_000_010_000,
    attempts: 3,
  });
  assert.deepEqual(sleeps, [5_000, 5_000]);
});

test("requires the two exact static systemd identities", () => {
  const passwd = [
    "root:x:0:0:root:/root:/bin/bash",
    "api-migrator-smoke-runner:x:12001:12001::/nonexistent:/usr/sbin/nologin",
    "api-migrator-smoke-gateway:x:12002:12002::/nonexistent:/usr/sbin/nologin",
  ].join("\n");
  const group = [
    "root:x:0:",
    "api-migrator-smoke-runner:x:12001:",
    "api-migrator-smoke-gateway:x:12002:",
  ].join("\n");
  assert.deepEqual(validateHostedSmokeAccounts(passwd, group), {
    runner: { name: "api-migrator-smoke-runner", uid: 12001, gid: 12001 },
    gateway: { name: "api-migrator-smoke-gateway", uid: 12002, gid: 12002 },
  });
  assert.throws(
    () => validateHostedSmokeAccounts(`${passwd}\nforged:x:12001:12001::/nonexistent:/usr/sbin/nologin`, group),
    /missing, duplicated, or substituted/
  );
  assert.throws(
    () => validateHostedSmokeAccounts(passwd.replace("/usr/sbin/nologin", "/bin/bash"), group),
    /missing, duplicated, or substituted/
  );
});

test("represents an absent listener with a truthy proof while preserving exact evidence", () => {
  assert.deepEqual(proveHostedListenerAbsence(""), { snapshot: "" });
  assert.deepEqual(proveHostedListenerAbsence(" \n\t"), { snapshot: " \n\t" });
  assert.equal(proveHostedListenerAbsence("LISTEN 0 4096 127.0.0.1:15443\n"), false);
  assert.throws(() => proveHostedListenerAbsence(null), /listener snapshot is invalid/);
});

test("correlates only exact plan-bound Envoy upstream address and port records", () => {
  const deployment = {
    contract: {
      jobId: `previewjob_${"a".repeat(64)}`,
      origin: { addresses: ["104.16.1.35", "2606:4700::6810:123"] },
    },
  };
  const entry = (upstream_host, access_log_type = "TcpConnectionEnd") => JSON.stringify({
    job_id: deployment.contract.jobId,
    requested_server_name: "registry.npmjs.org",
    access_log_type,
    upstream_host,
  });
  const text = [
    entry("104.16.1.35:443"),
    entry("[2606:4700::6810:123]:443"),
    entry("104.16.1.350:443"),
    entry("104.16.1.35:444"),
    entry("[2606:4700::6810:1234]:443"),
  ].join("\n");
  assert.equal(countMatchingAccessLogs(text, deployment), 2);
  assert.equal(countMatchingAccessLogs(text, deployment, "TcpConnectionEnd"), 2);
  assert.equal(countMatchingAccessLogs(text, deployment, "TcpUpstreamConnected"), 0);
  assert.throws(() => countMatchingAccessLogs(text, deployment, "TcpPeriodic"), /unsupported/);
});

test("runner source keeps the report boundary non-authorizing and table removal after cleanup", () => {
  const source = readFileSync(new URL("../run-hosted-smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /releaseEvidenceEligible: false/);
  assert.match(source, /activationBlocked: true/);
  assert.match(source, /externalSigningEligible: false/);
  assert.doesNotMatch(source, /releaseEvidenceEligible:\s*true|externalSigningEligible:\s*true|owner:sign|runnerCapability/);
  assert(source.indexOf("removeExactRuntime(resources)") < source.indexOf("deleteExactTable(resources, tools)"));
  const emergency = source.slice(
    source.indexOf("async function emergencyCleanup"),
    source.indexOf("export async function runHostedSmoke")
  );
  assert.doesNotMatch(emergency, /removeExactRuntime|deleteExactTable/);
  assert.match(emergency, /always-run external cleanup re-authenticates the marker/);
  assert.match(emergency, /\[resources\.canaryUnit, resources\.gatewayUnit\]/);
  assert.match(source, /"--file-flush-interval-msec", "250"/);
  assert.match(source, /readinessConnectedBefore \+ 2 && ended >= readinessEndedBefore \+ 2/);
  assert.match(source, /LoadState !== "not-found"/);
  assert.match(source, /Result: "timeout", ExecMainCode: "2", ExecMainStatus: "15"/);
  assert.match(source, /Result: "signal", ExecMainCode: "2", ExecMainStatus: "9"/);
});
