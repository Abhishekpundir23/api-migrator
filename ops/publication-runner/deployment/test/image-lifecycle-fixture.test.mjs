import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseImageLifecycleFixtureCli, validateFixtureEnvironment,
  claimFixtureOutput, assertFixtureFresh, proveForcedFixtureRoute, createImageFixtureOperations, ExpectedInstallFailure,
} from "../run-image-lifecycle-fixture.mjs";
import { runFixtureLifecycle } from "../fixture-lifecycle.mjs";
import { createPublicationRunnerPlan, canonicalJson } from "../../../../packages/app/dist/runner-internal.js";

const image = `sha256:${"a".repeat(64)}`;
const output = "/tmp/api-migrator-fixture-results/123-success";
const args = ["--image", image, "--output-dir", output];

test("fixture parser exposes no arbitrary workload or activation input", () => {
  assert.deepEqual(parseImageLifecycleFixtureCli(args), { image, outputDir: output, scenario: "success" });
  assert.equal(parseImageLifecycleFixtureCli([...args, "--scenario", "install_failure"]).scenario, "install_failure");
  for (const flag of ["--publish", "--live", "--repo", "--source", "--command", "--cleanup"]) {
    assert.throws(() => parseImageLifecycleFixtureCli([...args, flag, "value"]));
  }
  for (const value of ["/", "/tmp", "/home", "/tmp/api-migrator-fixture-results", "/tmp/a/../b", "relative"]) {
    assert.throws(() => parseImageLifecycleFixtureCli(["--image", image, "--output-dir", value]));
  }
  for (const value of ["ubuntu", "-x", "x;y", "sha256:bad", "repo:latest", "https://repo/image"]) {
    assert.throws(() => parseImageLifecycleFixtureCli(["--image", value, "--output-dir", output]));
  }
  assert.throws(() => parseImageLifecycleFixtureCli([...args, "--scenario", "arbitrary"]));
});

test("ambient credentials, proxy, preload and Docker routing overrides are rejected", () => {
  const env = { PATH: "/usr/local/libexec/api-migrator-hosted-smoke:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C", LC_ALL: "C", TZ: "UTC", API_MIGRATOR_HOSTED_ENVOY_PATH: "/usr/local/libexec/api-migrator-hosted-smoke/envoy",
    API_MIGRATOR_SMOKE_RUN_ID: "123", API_MIGRATOR_SMOKE_RUN_ATTEMPT: "1",
    API_MIGRATOR_SMOKE_SOURCE_REVISION: "a".repeat(40), API_MIGRATOR_SMOKE_REPOSITORY: "owner/repo",
    API_MIGRATOR_SMOKE_WORKFLOW_REF: "owner/repo/.github/workflows/runner-lifecycle-fixture.yml@refs/heads/main",
    API_MIGRATOR_SMOKE_IMAGE_VERSION: "20260924.1" };
  assert.equal(validateFixtureEnvironment(env).runId, "123");
  for (const key of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "HTTPS_PROXY", "NODE_OPTIONS", "LD_PRELOAD", "DOCKER_HOST", "HOME"]) {
    assert.throws(() => validateFixtureEnvironment({ ...env, [key]: "value" }), /sanitized/);
  }
});

test("result output is claimed once and never overwrites an existing directory", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fixture-output-test-")));
  try {
    const path = join(root, "new");
    claimFixtureOutput(path);
    assert.throws(() => claimFixtureOutput(path), /exist|claimed/i);
    mkdirSync(join(root, "old"));
    assert.throws(() => claimFixtureOutput(join(root, "old")), /exist|claimed/i);
    chmodSync(root, 0o777);
    assert.throws(() => claimFixtureOutput(join(root, "unsafe-parent")), /parent/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("phase launch refuses expired plan or DNS and bounds the entire command", () => {
  const plan = { plan: { job: { expiresAt: 200000, createdAt: 100000 } } };
  assert.equal(assertFixtureFresh(plan, 180000, 110000, 20000), 20000);
  assert.throws(() => assertFixtureFresh(plan, 180000, 140000, 20000), /lifetime/);
  assert.throws(() => assertFixtureFresh(plan, 180000, 180001, 1), /expired|lifetime/);
  assert.throws(() => assertFixtureFresh(plan, 180000, 179000, 20000), /lifetime/);
  assert.throws(() => assertFixtureFresh(plan, 300000, 200001, 1), /expired|lifetime/);
});

test("HTTP success needs four correlated forced-route counters and no rejected gateway traffic", () => {
  const before = { redirect: 1, runnerV4: 2, runnerV6: 0, gatewayV4: 3, gatewayV6: 0,
    gatewayDownstreamV4: 4, gatewayDownstreamV6: 0, gatewayReject: 0 };
  const after = { ...before, redirect: 2, runnerV4: 3, gatewayV4: 4, gatewayDownstreamV4: 5 };
  assert.equal(proveForcedFixtureRoute(before, after).redirect, 1);
  for (const key of ["redirect", "runnerV4", "gatewayV4", "gatewayDownstreamV4"]) {
    assert.throws(() => proveForcedFixtureRoute(before, { ...after, [key]: before[key] }), /forced/);
    const missing = { ...after }; delete missing[key];
    assert.throws(() => proveForcedFixtureRoute(before, missing));
  }
  assert.throws(() => proveForcedFixtureRoute(before, { ...after, gatewayReject: 1 }), /forced/);
});

function adapter(t, fault = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fixture-adapter-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(["planPath", "sourcePath", "installation", "dependencies", "output", "result"]
    .map((name) => [name, join(root, name)]));
  mkdirSync(paths.installation); mkdirSync(paths.result);
  const now = 1800000000000;
  const plan = createPublicationRunnerPlan({ pilotId: "pilot_fixture", repository: { slug: "owner/repo", id: 1, ownerId: 2 },
    base: { branch: "main", sha: "b".repeat(40) }, sourceArchiveDigest: image, manifestDigest: image, imageDigest: image,
    migrationInstallEgress: [{ host: "registry.npmjs.org", protocol: "tcp", port: 443, tls: true,
      addresses: ["104.16.1.35"], resolutionEvidenceDigest: image, resolutionObservedAt: now, resolutionExpiresAt: now + 300000 }],
    now, expiresAt: now + 300000 });
  const events = [], commands = [];
  let n = 0, upstream = 0, rejected = 0, online = false;
  const counters = () => ({ redirect: n, runnerV4: n, runnerV6: n,
    gatewayV4: upstream, gatewayV6: 0, gatewayDownstreamV4: upstream,
    gatewayDownstreamV6: 0, gatewayReject: rejected, runnerReject: n });
  const native = {
    installPolicy: () => events.push("policy"),
    startGateway: async () => { events.push("gateway"); if (fault.readiness) throw new Error("listener unavailable"); online = true; return { uid: fault.gatewayUid ? undefined : 12002, listeners: ["127.0.0.1", "::1"] }; },
    probe: (scenario) => { events.push(scenario); n += 1;
      if (online && ["correct_sni", "correct_sni_ipv6", "direct_bypass"].includes(scenario)) upstream += 1;
      if (scenario === "non_npm") rejected += 1;
    },
    counters,
    stopGateway: async () => { events.push("stop"); online = false; },
    idle: () => !fault.uid,
    listenerAbsent: () => true,
    cleanup: async () => { events.push("cleanup"); return { complete: !fault.cleanup }; },
  };
  const evidence = { planDigest: plan.digest,
    output: { preflightId: `pf_${"d".repeat(64)}`, artifactDigest: image, candidateTreeSha: "e".repeat(40) },
    checks: Object.fromEntries(["install", "typecheck", "test", "lint", "runtime"].map((name) => [name, { status: "passed" }])),
    report: { verification: { ok: true, skipped: false }, summary: { review: 0 }, manifest: { deployment: { kind: "long-running" } }, entries: [] }, blockers: [] };
  const evidenceText = canonicalJson(evidence);
  writeFileSync(join(paths.result, "runner-evidence.json"), evidenceText);
  const digest = `sha256:${createHash("sha256").update(evidenceText).digest("hex")}`;
  const execute = async (request) => {
    commands.push(request); events.push(request.phase);
    if (request.phase === "install") {
      if (fault.protocol) {
        assert(request.dockerArgs.includes(`sha256:${"0".repeat(64)}`));
        const error = new Error("fixture install subprocess failed"); error.code = "FIXTURE_INSTALL_PROTOCOL_REJECTED"; throw error;
      }
      if (fault.install) throw new Error("real process boundary install failed");
      if (!fault.counter) { n += 10; upstream += 10; }
    }
    return { prepare: `runner_phase=prepare status=passed prepared_state_digest=${image}\n`,
      install: `runner_phase=install status=passed prepared_state_digest=${image} install_state_digest=${image}\n`,
      migrate: `runner_phase=migrate status=passed dependency_state_digest=${image}\n`,
      verify: `runner_phase=verify status=passed evidence_digest=${digest} preflight_id=pf_${"d".repeat(64)}\n` }[request.phase];
  };
  const operations = createImageFixtureOperations({ plan, paths, image, native, execute,
    now: () => fault.expired ? now + 300001 : now,
    evidence: { write: (label) => { if (fault.write && label === "install-forced-route") throw new Error("evidence write failed"); return image; } },
    scenario: fault.scenario ?? "success" });
  return { operations, events, commands };
}

test("adapter joins exact host-mode install to ordered policy, UID/offline proof and network-none phases", async (t) => {
  const { operations, commands, events } = adapter(t);
  const result = await runFixtureLifecycle(operations);
  assert.equal(result.phaseIntegration, "passed");
  assert.equal(result.activationBlocked, true);
  assert.deepEqual(commands.map((c) => c.network), ["none", "host", "none", "none"]);
  for (const c of commands) {
    assert(c.dockerArgs.includes("12001:12001"));
    assert(c.dockerArgs.includes(image));
    assert(c.dockerArgs.includes("--pull=never"));
  }
  assert(events.indexOf("policy") < events.indexOf("prepare"));
  assert(events.indexOf("offline_network") < events.indexOf("migrate"));
  assert.equal(events.at(-1), "cleanup");
});

test("wrong order cannot run install and all native/evidence failures withhold success", async (t) => {
  const early = adapter(t);
  await assert.rejects(early.operations.install(), /order/);
  assert.deepEqual(early.commands, []);
  for (const [fault, message] of Object.entries({ readiness: /listener unavailable/, expired: /lifetime/,
    uid: /UID/, gatewayUid: /UID\/listener/, counter: /forced route/, cleanup: /cleanup incomplete/, write: /evidence write failed/, install: /install failed/ })) {
    const { operations, events, commands } = adapter(t, { [fault]: true });
    await assert.rejects(runFixtureLifecycle(operations), message);
    assert.equal(events.at(-1), "cleanup", fault);
    if (fault !== "cleanup") assert(!commands.some((c) => c.phase === "migrate"), fault);
  }
});

test("fixed failure invokes real phase argv and recognizes only protocol rejection after complete cleanup", async (t) => {
  const { operations, commands, events } = adapter(t, { scenario: "install_failure", protocol: true });
  await assert.rejects(runFixtureLifecycle(operations), ExpectedInstallFailure);
  assert.deepEqual(commands.map((c) => c.phase), ["prepare", "install"]);
  assert.equal(events.at(-1), "cleanup");
  const broken = adapter(t, { scenario: "install_failure", protocol: true, cleanup: true });
  await assert.rejects(runFixtureLifecycle(broken.operations), AggregateError);
  const unrelated = adapter(t, { scenario: "install_failure", install: true });
  await assert.rejects(runFixtureLifecycle(unrelated.operations), (error) => !(error instanceof ExpectedInstallFailure));
});
