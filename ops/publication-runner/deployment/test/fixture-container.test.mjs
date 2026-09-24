import assert from "node:assert/strict";
import test from "node:test";
import { validateFixtureContainer, assertFixtureDockerDaemon, executeNativeFixturePhase } from "../fixture-native.mjs";
import { gatewaySystemdArguments } from "../run-hosted-smoke.mjs";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { runFixtureLifecycle } from "../fixture-lifecycle.mjs";
import { cleanupFixtureResources, deriveFixtureResources } from "../fixture-ownership.mjs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const image = `sha256:${"a".repeat(64)}`, jobId = `previewjob_${"b".repeat(64)}`;
const resources = { image, jobId, containers: { install: `api-migrator-fixture-${jobId}-install` } };
const observed = { Name: `/${resources.containers.install}`, Image: image,
  Config: { User: "12001:12001", Labels: { "api-migrator.fixture-job": jobId } },
  HostConfig: { NetworkMode: "host", UsernsMode: "", Privileged: false },
  State: { Running: true, Pid: 1234 } };
test("container ownership rejects substituted label/image/user/network/remapping before removal", () => {
  assert.equal(validateFixtureContainer(observed, resources, "install").State.Pid, 1234);
  for (const changed of [
    { ...observed, Image: `sha256:${"c".repeat(64)}` },
    { ...observed, Name: "/other" },
    { ...observed, Config: { ...observed.Config, Labels: {} } },
    { ...observed, Config: { ...observed.Config, User: "0:0" } },
    { ...observed, HostConfig: { ...observed.HostConfig, NetworkMode: "bridge" } },
    { ...observed, HostConfig: { ...observed.HostConfig, UsernsMode: "private" } },
  ]) assert.throws(() => validateFixtureContainer(changed, resources, "install"), /container/);
});
test("host UID attribution refuses rootless/user-remapped or remote daemon profiles", () => {
  assert.doesNotThrow(() => assertFixtureDockerDaemon({ OSType: "linux", CgroupVersion: "2", SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"] }));
  for (const option of ["name=userns", "name=rootless"]) {
    assert.throws(() => assertFixtureDockerDaemon({ OSType: "linux", CgroupVersion: "2", SecurityOptions: [option] }), /Docker/);
  }
});

test("fixture gateway enforces a systemd deadline while legacy smoke arguments stay unchanged", () => {
  const resources = { gatewayUnit: "api-migrator-fixture-gateway-a.service" };
  const rendered = { envoyConfigPath: "/run/exact/envoy.json" };
  const tools = { envoy: "/usr/local/libexec/exact/envoy" };
  const original = gatewaySystemdArguments(resources, rendered, tools);
  assert(!original.some((arg) => arg.includes("RuntimeMaxSec")));
  const bounded = gatewaySystemdArguments(resources, rendered, tools, { maximumRuntimeSeconds: 45 });
  assert(bounded.includes("--property=RuntimeMaxSec=45s"));
  assert(bounded.indexOf("--property=RuntimeMaxSec=45s") < bounded.indexOf(tools.envoy));
  for (const seconds of [0, -1, 1000, NaN]) assert.throws(() => gatewaySystemdArguments(resources, rendered, tools, { maximumRuntimeSeconds: seconds }));
});

test("native execution requires live host UID evidence, bounded output and settled container identity", async () => {
  const request = { phase: "install", dockerArgs: ["run", "--rm", "--name", resources.containers.install, image], timeoutMs: 1000 };
  async function run(fault = {}) {
    let running = true, killed = false;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let finish;
    child.kill = () => { killed = true; clearTimeout(finish); running = false; queueMicrotask(() => child.emit("close", null)); };
    const processes = {
      spawn(path, args, options) {
        if (fault.slowSpawn) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        assert.equal(path, "/usr/bin/docker");
        assert(!args.includes("--rm"));
        assert.deepEqual(Object.keys(options.env).sort(), ["LANG", "LC_ALL", "PATH", "TZ"]);
        finish = setTimeout(() => {
          running = false;
          if (fault.protocol) child.stderr.emit("data", "prepared install state does not match the host-sealed digest");
          child.stdout.emit("data", fault.excessive ? "x".repeat(1024 * 1024 + 1) : "trusted status\n");
          child.emit("close", fault.protocol ? 1 : 0);
        }, fault.fast ? 1 : 150);
        return child;
      },
      command(path, args) {
        assert.equal(path, "/usr/bin/docker");
        if (args[1] === "ls") return { stdout: resources.containers.install };
        assert.deepEqual(args, ["container", "inspect", resources.containers.install]);
        return { status: 0, stdout: JSON.stringify([{ ...observed, State: { Running: running, Pid: running ? 1234 : 0 } }]), stderr: "" };
      },
      status: () => `Uid:\t${fault.uid ? "0\t0\t0\t0" : "12001\t12001\t12001\t12001"}\n`,
    };
    const promise = executeNativeFixturePhase({ ...request, timeoutMs: fault.timeout ? 5 : 1000 }, {
      resources, docker: "/usr/bin/docker", evidence: { write() { if (fault.write) throw new Error("evidence write failed"); } }, processes });
    try { return await promise; } finally { clearTimeout(finish); if (fault.timeout || fault.uid || fault.excessive) assert(killed); }
  }
  assert.equal(await run(), "trusted status\n");
  await assert.rejects(run({ fast: true }), /UID evidence missing/);
  await assert.rejects(run({ uid: true }), /UID evidence mismatched/);
  await assert.rejects(run({ timeout: true }), /deadline/);
  await assert.rejects(run({ timeout: true, slowSpawn: true }), /deadline/);
  await assert.rejects(run({ excessive: true }), /output exceeded/);
  await assert.rejects(run({ write: true }), /evidence write failed/);
  await assert.rejects(run({ protocol: true }), (error) => error.code === "FIXTURE_INSTALL_PROTOCOL_REJECTED");
});

for (const inspection of ["active", "final"]) {
  test(`slow ${inspection} Docker observation is cancelled at the phase deadline before exact cleanup`, async () => {
    const owned = deriveFixtureResources({ runId: "123", runAttempt: 1, scenario: "success", jobId, image,
      planDigest: `sha256:${"c".repeat(64)}` });
    const request = { phase: "install", dockerArgs: ["run", "--rm", "--name", owned.containers.install, image], timeoutMs: 125 };
    let workloadRunning = true, containerPresent = true, tablePresent = true, treePresent = true, unitPresent = true;
    let calls = 0, inFlight = 0, maxInFlight = 0, cancelled = false, evidenceWrites = 0, successes = 0;
    const events = [];
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let exitTimer;
    child.kill = () => { events.push("client-killed"); clearTimeout(exitTimer); queueMicrotask(() => child.emit("close", null)); };
    const processes = {
      spawn() {
        if (inspection === "final") exitTimer = setTimeout(() => { workloadRunning = false; child.emit("close", 0); }, 10);
        return child;
      },
      command(_path, args, options) {
        // Reproduce the previous blocking process contract during RED, without
        // unhandled promises masking the actual deadline/cleanup regression.
        if (args[1] === "ls") return { stdout: owned.containers.install };
        if (!options.signal) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
          return { stdout: JSON.stringify([{ ...observed, State: { Running: workloadRunning, Pid: workloadRunning ? 1234 : 0 } }]) };
        }
        calls += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
        assert.deepEqual(args, ["container", "inspect", owned.containers.install]);
        assert(options.timeoutMs > 0 && options.timeoutMs <= 125);
        assert(options.signal instanceof AbortSignal);
        events.push(`${inspection}-inspection`);
        return (async () => { try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 1500);
            options.signal.addEventListener("abort", () => {
              clearTimeout(timer); cancelled = true; events.push("inspection-cancelled"); reject(new Error("observation aborted"));
            }, { once: true });
          });
          return { status: 0, stdout: JSON.stringify([{ ...observed,
            State: { Running: workloadRunning, Pid: workloadRunning ? 1234 : 0 } }]), stderr: "" };
        } finally { inFlight -= 1; } })();
      },
      status: () => "Uid:\t12001\t12001\t12001\t12001\n",
    };
    const operations = Object.fromEntries(["installPolicy", "prepare", "startGateway", "probeOnline", "stopGateway", "assertOffline", "migrate", "verify"]
      .map((name) => [name, async () => { events.push(name); if (["migrate", "verify"].includes(name)) successes += 1; }]));
    operations.install = () => executeNativeFixturePhase(request, { resources: owned, docker: "/usr/bin/docker", processes,
      evidence: { write() { evidenceWrites += 1; } } });
    operations.cleanup = () => cleanupFixtureResources(owned, {
      validateOwnership() {}, tableExists: () => tablePresent,
      removeContainers() { assert(cancelled, "active native observation must be cancelled before cleanup");
        events.push(`remove:${owned.containers.install}`); workloadRunning = false; containerPresent = false; },
      containersAbsent: () => !containerPresent,
      async stopGateway() { events.push(`stop:${owned.gatewayUnit}`); unitPresent = false; },
      quiescent: () => !workloadRunning && !unitPresent,
      treesAbsent: () => !treePresent,
      removeTrees() { events.push("trees"); treePresent = false; },
      deleteTable() { events.push(`table:${owned.nftTable}`); tablePresent = false; },
    });
    const startedAt = performance.now();
    await assert.rejects(runFixtureLifecycle(operations), /fixture phase deadline exceeded/);
    const elapsed = performance.now() - startedAt;
    assert(elapsed >= 100 && elapsed < 300, `125ms phase settled after ${elapsed.toFixed(1)}ms`);
    assert.equal(cancelled, true); assert.equal(calls, 1); assert.equal(maxInFlight, 1);
    assert.equal(evidenceWrites, 0); assert.equal(successes, 0);
    assert.equal(events.at(-1), `table:${owned.nftTable}`);
    assert.equal(containerPresent || workloadRunning || tablePresent || treePresent || unitPresent, false);
  });
}

test("active observations never overlap each other or final settlement inspection", async () => {
  let running = true, active = 0, maximum = 0, count = 0;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => {};
  const processes = {
    spawn() { return child; },
    async command(_path, args, options) {
      assert.deepEqual(args, ["container", "inspect", resources.containers.install]);
      assert(options.signal instanceof AbortSignal);
      active += 1; count += 1; maximum = Math.max(maximum, active);
      if (count === 2) setTimeout(() => { running = false; child.stdout.emit("data", "trusted status\n"); child.emit("close", 0); }, 10);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { status: 0, stdout: JSON.stringify([{ ...observed, State: { Running: running, Pid: running ? 1234 : 0 } }]), stderr: "" };
      } finally { active -= 1; }
    },
    status: () => "Uid:\t12001\t12001\t12001\t12001\n",
  };
  const result = await executeNativeFixturePhase({ phase: "install", dockerArgs: ["run", "--name", resources.containers.install, image], timeoutMs: 1000 },
    { resources, docker: "/usr/bin/docker", processes, evidence: { write() {} } });
  assert.equal(result, "trusted status\n"); assert.equal(maximum, 1); assert.equal(active, 0);
  assert.equal(count, 3, "two serial active observations and one final inspection");
});

test("default native observation subprocess is killed without blocking the wall deadline", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fixture-inspection-deadline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const docker = join(root, "docker"), pidPath = join(root, "inspection.pid");
  // The 125ms cases above isolate scheduling. This case gives cold executable
  // startup a larger budget and verifies OS-level termination of the same PID.
  writeFileSync(docker, `#!/bin/sh
printf '%s' "$$" > ${JSON.stringify(pidPath)}
exec /bin/sleep 3
`, { mode: 0o755 });
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let killed = false, evidenceWrites = 0;
  child.kill = () => { killed = true; queueMicrotask(() => child.emit("close", null)); };
  const startedAt = performance.now();
  await assert.rejects(executeNativeFixturePhase({ phase: "install", dockerArgs: ["run", "--name", resources.containers.install, image], timeoutMs: 1000 },
    { resources, docker, processes: { spawn: () => child }, evidence: { write() { evidenceWrites += 1; } } }), /deadline|killed|SIGKILL|abort/i);
  const elapsed = performance.now() - startedAt;
  assert(elapsed < 1500, `1000ms phase remained blocked for ${elapsed.toFixed(1)}ms`);
  assert(killed); assert.equal(evidenceWrites, 0);
  const pid = Number(readFileSync(pidPath, "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
  for (let attempt = 0; attempt < 40 && alive(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(alive(), false, "cancelled Docker observation subprocess must be reaped");
});
