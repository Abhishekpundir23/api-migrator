import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { renderGatewayDeployment } from "../../gateway/gateway-contract.mjs";
import { gatewaySystemdArguments, installPolicy, startGateway } from "../run-hosted-smoke.mjs";

const NOW = 2_000_000_000_000;
const resources = { gatewayUnit: "api-migrator-hosted-gateway-exact.service" };
// Node rejects the systemd arguments without changing any host services if a
// regression reaches the default command rather than the injected seam.
const tools = { node: process.execPath, envoy: "/run/exact/envoy", systemdRun: process.execPath };

function rendered(lifetimeMs = 300_000, dnsLifetimeMs = lifetimeMs) {
  const contract = JSON.parse(readFileSync(new URL("../../gateway/examples/gateway-contract.example.json", import.meta.url), "utf8"));
  contract.plan.createdAt = NOW;
  contract.plan.expiresAt = NOW + lifetimeMs;
  contract.origin.resolutionObservedAt = NOW;
  contract.origin.resolutionExpiresAt = NOW + dnsLifetimeMs;
  return { deployment: renderGatewayDeployment(contract), envoyConfigPath: "/run/exact/envoy.json" };
}

function runtime(args) {
  const values = args.filter((arg) => arg.startsWith("--property=RuntimeMaxSec="));
  assert.equal(values.length, 1, "every gateway launch needs one independent systemd deadline");
  assert(args.indexOf(values[0]) < args.indexOf(tools.envoy));
  return Number(values[0].match(/=([0-9]+)s$/)[1]);
}

test("hosted gateway always carries bounded runtime, queued-start and service-start deadlines", () => {
  const args = gatewaySystemdArguments(resources, rendered(65_000), tools, { now: () => NOW });
  assert.equal(runtime(args), 34);
  assert(!args.some((arg) => arg.startsWith("--property=JobTimeoutSec=")));
  assert(args.includes("--property=JobRunningTimeoutSec=5s"));
  assert(args.includes("--property=TimeoutStartSec=5s"));
  assert(args.includes("--property=TimeoutStopSec=10s"));
});

test("elapsed setup reduces the remaining runtime without renewing DNS or plan expiry", () => {
  const input = rendered(300_000, 600_000);
  const original = gatewaySystemdArguments(resources, input, tools, { now: () => NOW });
  const delayed = gatewaySystemdArguments(resources, input, tools, { now: () => NOW + 55_000 });
  assert.equal(runtime(original), 269);
  assert.equal(runtime(delayed), 214);
  assert.equal(input.deployment.contract.plan.expiresAt, NOW + 300_000);
  assert.equal(input.deployment.contract.origin.resolutionExpiresAt, NOW + 600_000);
});

test("fixture runtime remains an upper cap and cannot replace the canonical deadline", () => {
  assert.equal(runtime(gatewaySystemdArguments(resources, rendered(), tools,
    { now: () => NOW, maximumRuntimeSeconds: 45 })), 45);
  assert.equal(runtime(gatewaySystemdArguments(resources, rendered(65_000), tools,
    { now: () => NOW, maximumRuntimeSeconds: 840 })), 34);
});

test("runtime floors fractional seconds and refuses a window lacking a strict shutdown margin", () => {
  const input = rendered(65_000);
  assert.throws(() => gatewaySystemdArguments(resources, input, tools,
    { now: () => NOW + 34_000 }), /lifetime|window/);
  assert.equal(runtime(gatewaySystemdArguments(resources, input, tools,
    { now: () => NOW + 33_999 })), 1);
  assert.equal(runtime(gatewaySystemdArguments(resources, input, tools,
    { now: () => NOW + 33_001 })), 1);
});

test("invalid fixture caps cannot disable or extend the systemd lifetime", () => {
  for (const maximumRuntimeSeconds of [0, -1, 1.5, "45", NaN, Infinity, 841]) {
    assert.throws(() => gatewaySystemdArguments(resources, rendered(), tools,
      { now: () => NOW, maximumRuntimeSeconds }), /lifetime/);
  }
});

test("invalid or exhausted startup clocks refuse before command execution", async () => {
  for (const value of [NOW - 1, NOW + 65_000, NOW + 65_001, NaN, Infinity, "2000000000000", Number.MAX_SAFE_INTEGER + 1]) {
    let commands = 0;
    await assert.rejects(startGateway(resources, rendered(65_000), tools, {}, {
      now: () => value, elapsedNow: () => 0,
      command() { commands += 1; throw new Error("unexpected command"); },
    }), /lifetime|clock|window/);
    assert.equal(commands, 0);
  }
});

test("noncanonical or substituted plan and DNS windows refuse before command execution", async () => {
  const fixtures = [undefined, {}, { deployment: {} }];
  for (const [field, value] of [
    ["createdAt", NaN], ["createdAt", NOW + 1], ["expiresAt", "2000000065000"],
    ["expiresAt", Number.MAX_SAFE_INTEGER + 1], ["resolutionExpiresAt", NOW + 64_999],
    ["resolutionObservedAt", NOW + 1],
  ]) {
    const input = structuredClone(rendered(65_000));
    const target = field.startsWith("resolution") ? input.deployment.contract.origin : input.deployment.contract.plan;
    target[field] = value;
    fixtures.push(input);
  }
  for (const input of fixtures) {
    let commands = 0;
    await assert.rejects(startGateway(resources, input, tools, {}, {
      now: () => NOW, elapsedNow: () => 0,
      command() { commands += 1; throw new Error("unexpected command"); },
    }), /Gateway|gateway deployment record|plan .* invalid|resolution .* invalid/);
    assert.equal(commands, 0);
  }
});

test("actual gateway startup uses the same short command budget reserved by its systemd bounds", async () => {
  const commands = [];
  const stop = new Error("stop after observing the harmless startup command");
  await assert.rejects(startGateway(resources, rendered(65_000), tools, {}, {
    now: () => NOW, elapsedNow: () => 0,
    command(path, args, options) { commands.push({ path, args, options }); throw stop; },
  }), (error) => error === stop);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].path, tools.systemdRun);
  assert.equal(commands[0].options.timeoutMs, 5000);
  assert.equal(runtime(commands[0].args), 34);
  // Latest command submission + queued activation + runtime + final startup
  // and shutdown reserve stays before the bound, even for a floor answer.
  assert(5000 + 5000 + runtime(commands[0].args) * 1000 + 20_000 < 65_000);
});

test("actual gateway startup consumes setup age before submitting the service", async () => {
  for (const [age, expectedRuntime] of [[0, 34], [5000, 29], [10_000, 24]]) {
    const commands = [];
    const stop = new Error("startup seam observed");
    await assert.rejects(startGateway(resources, rendered(65_000), tools, {}, {
      now: () => NOW + age, elapsedNow: () => 0,
      command(path, args, options) { commands.push({ path, args, options }); throw stop; },
    }), (error) => error === stop);
    assert.equal(commands.length, 1);
    assert.equal(runtime(commands[0].args), expectedRuntime);
  }
});

test("a forward wall step before submission cannot reuse a stale runtime allowance", async () => {
  let reads = 0, commands = 0;
  await assert.rejects(startGateway(resources, rendered(65_000), tools, {}, {
    now: () => reads++ === 0 ? NOW : NOW + 40_000, elapsedNow: () => 0,
    command() { commands += 1; throw new Error("stale startup allowance was submitted"); },
  }), /lifetime|window|budget/);
  assert.equal(commands, 0);
});

test("a forward wall step during the startup command cannot reach readiness", async (t) => {
  let wall = NOW, commands = 0, writes = 0, waitReads = 0;
  // If the guard regresses, make the real readiness loop fail immediately,
  // without host inspection or a twenty-second wait.
  t.mock.method(Date, "now", () => NOW + (++waitReads) * 100_000);
  await assert.rejects(startGateway(resources, rendered(65_000), tools, {
    write() { writes += 1; throw new Error("readiness must not be reached"); },
  }, {
    now: () => wall, elapsedNow: () => 0,
    command() { commands += 1; wall += 40_000; return { status: 0, stdout: "", stderr: "" }; },
  }), /lifetime|window|budget/);
  assert.equal(commands, 1);
  assert.equal(writes, 0);
  assert.equal(waitReads, 0, "readiness must not start with a stale runtime bound");
});

test("validation delay cannot install policy after its usable gateway window is exhausted", () => {
  for (const value of [NOW + 34_000, NOW + 65_000, NOW + 65_001]) {
    let commands = 0;
    assert.throws(() => installPolicy(rendered(65_000), resources, { nft: process.execPath }, {}, {
      now: () => value,
      command() { commands += 1; throw new Error("unexpected policy mutation"); },
    }), /lifetime|window/);
    assert.equal(commands, 0);
  }
});

test("expired, rolled-back or over-budget command completion never reaches readiness", async () => {
  for (const fault of ["expired", "wall_rollback", "monotonic_rollback", "command_deadline", "invalid_clock"]) {
    let wall = NOW, elapsed = 1000, commands = 0, writes = 0;
    await assert.rejects(startGateway(resources, rendered(65_000), tools, {
      write() { writes += 1; throw new Error("readiness must not be reached"); },
    }, {
      now: () => wall, elapsedNow: () => elapsed,
      command() {
        commands += 1;
        if (fault === "expired") { wall += 65_000; elapsed += 65_000; }
        if (fault === "wall_rollback") wall -= 1;
        if (fault === "monotonic_rollback") elapsed -= 1;
        if (fault === "command_deadline") elapsed += 5000;
        if (fault === "invalid_clock") elapsed = NaN;
        return { status: 0, stdout: "", stderr: "" };
      },
    }), /lifetime|clock|budget|window/);
    assert.equal(commands, 1);
    assert.equal(writes, 0);
  }
});

test("queued gateway admission is checked by a native pre-start guard after controller exit", () => {
  const admitted = 1_000_000_000n;
  const args = gatewaySystemdArguments(resources, rendered(65_000), tools, {
    now: () => NOW, monotonicNow: () => admitted,
  });
  const guards = args.filter((arg) => arg.startsWith("--property=ExecStartPre="));
  assert.equal(guards.length, 1, "one native admission guard must precede Envoy activation");
  assert(args.indexOf(guards[0]) < args.indexOf(tools.envoy));
  assert(guards[0].includes(`${tools.node} --jitless --no-expose-wasm --eval `));
  const script = JSON.parse(guards[0].slice(guards[0].indexOf(" --eval ") + 8));
  for (const [label, wall, mono, expected] of [
    ["immediate", NOW, admitted, 0],
    ["bounded waiting", NOW + 4_000, admitted + 4_000_000_000n, 0],
    ["pre-start completion needs its own reserve", NOW + 9_000, admitted + 9_000_000_000n, 1],
    ["queue exhausted with stalled wall", NOW, admitted + 10_000_000_000n, 1],
    ["late queue", NOW + 10_000, admitted + 10_000_000_000n, 1],
    ["wall step leaves no full runtime", NOW + 11_000, admitted + 1_000_000n, 1],
    ["wall rollback", NOW - 1, admitted + 1_000_000n, 1],
    ["monotonic rollback", NOW, admitted - 1n, 1],
  ]) {
    const result = spawnSync(tools.node, ["--jitless", "--no-expose-wasm", "--eval",
      `Date.now=()=>${wall};process.hrtime.bigint=()=>${mono}n;${script}`], {
      encoding: "utf8", timeout: 5000, env: {},
    });
    assert.equal(result.error, undefined, label);
    assert.equal(result.signal, null, label);
    assert.equal(result.status, expected, `${label}: ${result.stderr}`);
  }
});

test("invalid native monotonic admission clocks refuse before service submission", async () => {
  for (const value of [-1n, 0, NaN, undefined]) {
    let commands = 0;
    await assert.rejects(startGateway(resources, rendered(65_000), tools, {}, {
      now: () => NOW, elapsedNow: () => 0, monotonicNow: () => value,
      command() { commands += 1; throw new Error("invalid native clock was submitted"); },
    }), /monotonic|clock/);
    assert.equal(commands, 0);
  }
});
