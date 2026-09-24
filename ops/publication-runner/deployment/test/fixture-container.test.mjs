import assert from "node:assert/strict";
import test from "node:test";
import { validateFixtureContainer, assertFixtureDockerDaemon, executeNativeFixturePhase } from "../fixture-native.mjs";
import { gatewaySystemdArguments } from "../run-hosted-smoke.mjs";
import { EventEmitter } from "node:events";
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
        return { stdout: JSON.stringify([{ ...observed, State: { Running: running, Pid: running ? 1234 : 0 } }]) };
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
  await assert.rejects(run({ excessive: true }), /output exceeded/);
  await assert.rejects(run({ write: true }), /evidence write failed/);
  await assert.rejects(run({ protocol: true }), (error) => error.code === "FIXTURE_INSTALL_PROTOCOL_REJECTED");
});
