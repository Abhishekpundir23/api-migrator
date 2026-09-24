import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import * as host from "./run-hosted-smoke.mjs";
import { cleanupFixtureResources, validateFixtureOwnership } from "./fixture-ownership.mjs";

export function assertFixtureDockerDaemon(info) {
  if (info?.OSType !== "linux" || info.CgroupVersion !== "2" || !Array.isArray(info.SecurityOptions) ||
      info.SecurityOptions.some((item) => /userns|rootless/i.test(item))) throw new Error("fixture Docker must use local rootful host UID mapping and cgroup v2");
}

export function validateFixtureContainer(value, resources, phase) {
  if (!resources.containers[phase] || value?.Name !== `/${resources.containers[phase]}` || value.Image !== resources.image ||
      value.Config?.User !== "12001:12001" || value.Config?.Labels?.["api-migrator.fixture-job"] !== resources.jobId ||
      value.HostConfig?.NetworkMode !== (phase === "install" ? "host" : "none") ||
      value.HostConfig.UsernsMode !== "" || value.HostConfig.Privileged !== false ||
      typeof value.State?.Running !== "boolean" || !Number.isSafeInteger(value.State.Pid) || value.State.Pid < 0) {
    throw new Error("fixture container ownership, image or host UID mapping substituted");
  }
  return value;
}

export function fixtureContainerInventory(resources, docker, command = host.runCommand) {
  const names = command(docker, ["container", "ls", "--all", "--format", "{{.Names}}"], { timeoutMs: 5000 }).stdout.trim().split("\n");
  return Object.entries(resources.containers).flatMap(([phase, name]) => {
    if (!names.includes(name)) return [];
    const raw = command(docker, ["container", "inspect", name], { timeoutMs: 5000 });
    const values = JSON.parse(raw.stdout);
    if (!Array.isArray(values) || values.length !== 1) throw new Error("fixture container inspection malformed");
    return [{ phase, name, value: validateFixtureContainer(values[0], resources, phase) }];
  });
}

export function createFixtureNative({ resources, rendered, tools, docker, evidence, outputDir }) {
  const idle = () => host.pidsForUid(12001).length === 0 && host.pidsForUid(12002).length === 0 &&
    host.cgroupIsAbsent(`/system.slice/${resources.gatewayUnit}`) &&
    host.unitSnapshot(tools.systemctl, resources.gatewayUnit).values.LoadState === "not-found";
  return {
    installPolicy() { host.nativeValidate(rendered, tools, evidence); host.installPolicy(rendered, resources, tools, evidence); },
    async startGateway() {
      // systemd closes the route independently if this JS process disappears.
      // Reserve stop/kill time before the actual DNS/plan deadline.
      const maximumRuntimeSeconds = Math.floor((rendered.deployment.contract.plan.expiresAt - Date.now() - 20000) / 1000);
      const identity = await host.startGateway(resources, rendered, tools, evidence, { maximumRuntimeSeconds });
      await host.waitForListener(identity, resources, tools, evidence);
      return { uid: 12002, listeners: ["127.0.0.1", "::1"] };
    },
    probe(scenario) { const value = host.runProbe(scenario, rendered, tools); evidence.write(`probe-${scenario}`, value.raw); },
    counters() { return host.captureTableCounters(resources, tools, evidence, "fixture-counters").counters; },
    stopGateway: () => host.stopExactUnit(resources.gatewayUnit, tools),
    idle,
    listenerAbsent: () => Boolean(host.proveHostedListenerAbsence(host.listenerSnapshot(tools.ss, 15443))),
    cleanup: () => cleanupNativeFixture(resources, { tools, docker, outputDir }),
  };
}

export function readFixtureMarker(outputDir) {
  const path = join(outputDir, "ownership.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 || stat.size > 16384 || realpathSync(path) !== path) throw new Error("fixture ownership file is not root sealed");
  return JSON.parse(readFileSync(path, "utf8"));
}

function removeFixtureTree(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!/^\/run\/api-migrator-image-fixture(?:-workspace)?\/[a-f0-9]{16}$/.test(path) ||
      !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 ||
      (stat.mode & 0o022) !== 0 || realpathSync(path) !== path) throw new Error("fixture cleanup tree ownership substituted");
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n").map((line) => line.split(" ")[4]);
  if (mounts.some((mount) => mount === path || mount?.startsWith(`${path}/`))) throw new Error("fixture cleanup refuses mounted tree");
  rmSync(path, { recursive: true });
}

export async function cleanupNativeFixture(resources, { tools, docker, outputDir, auditOnly = false }) {
  const containers = () => fixtureContainerInventory(resources, docker);
  const tableExists = () => resources.nftTable !== null && host.tableSnapshot(tools.nft, resources.nftTable, true).exists;
  const quiescent = () => host.pidsForUid(12001).length === 0 && host.pidsForUid(12002).length === 0 &&
    host.unitSnapshot(tools.systemctl, resources.gatewayUnit).values.LoadState === "not-found" &&
    host.cgroupIsAbsent(`/system.slice/${resources.gatewayUnit}`) &&
    Boolean(host.proveHostedListenerAbsence(host.listenerSnapshot(tools.ss, 15443)));
  const treesAbsent = () => !existsSync(resources.workspacePath) && !existsSync(resources.runtimeRoot);
  validateFixtureOwnership(readFixtureMarker(outputDir), resources);
  if (auditOnly) {
    if (containers().length || tableExists() || !quiescent() || !treesAbsent()) throw new Error("fixture residual audit failed");
    return { complete: true };
  }
  return cleanupFixtureResources(resources, {
    validateOwnership: () => validateFixtureOwnership(readFixtureMarker(outputDir), resources),
    containersAbsent: () => containers().length === 0,
    removeContainers() {
      for (const { name } of containers()) host.runCommand(docker, ["container", "rm", "--force", name], { timeoutMs: 15000 });
    },
    stopGateway: () => host.stopExactUnit(resources.gatewayUnit, tools),
    quiescent, tableExists, treesAbsent,
    removeTrees() { removeFixtureTree(resources.workspacePath); removeFixtureTree(resources.runtimeRoot); },
    deleteTable() { host.runCommand(tools.nft, ["delete", "table", "inet", resources.nftTable]); },
  });
}

// Runs only the generated phase argv. Docker's client timeout is not container
// termination: the coordinator and external cleanup both remove exact labels.
export function executeNativeFixturePhase(request, { resources, docker, evidence, processes = {} }) {
  const spawnProcess = processes.spawn ?? spawn;
  const command = processes.command ?? host.runCommand;
  const processStatus = processes.status ?? ((pid) => readFileSync(`/proc/${pid}/status`, "utf8"));
  const { phase, dockerArgs, timeoutMs } = request;
  if (dockerArgs[dockerArgs.indexOf("--name") + 1] !== resources.containers[phase] || !dockerArgs.includes(resources.image)) {
    throw new Error("fixture phase command identity substituted");
  }
  // Retain exited named containers until exact cleanup; this also lets a fast
  // protocol rejection be inspected without racing --rm.
  const args = dockerArgs.filter((arg) => arg !== "--rm");
  return new Promise((accept, reject) => {
    let stdout = "", stderr = "", failure, uidObserved = false;
    const child = spawnProcess(docker, args, { cwd: "/", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "pipe"] });
    const fail = (error) => { failure ??= error; child.kill("SIGKILL"); };
    const receive = (stream) => (data) => {
      if (stream === "stdout") stdout += data; else stderr += data;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) fail(new Error("fixture phase output exceeded bound"));
    };
    child.stdout.on("data", receive("stdout")); child.stderr.on("data", receive("stderr"));
    const deadline = setTimeout(() => fail(new Error("fixture phase deadline exceeded")), timeoutMs);
    const observer = setInterval(() => {
      try {
        const entry = fixtureContainerInventory(resources, docker, command).find((item) => item.phase === phase);
        if (entry?.value.State.Running && entry.value.State.Pid > 1) {
          const pid = entry.value.State.Pid;
          let status;
          try { status = processStatus(pid); } catch (error) { if (error.code === "ENOENT") return; throw error; }
          const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
          if (!ids || ids.slice(1).some((id) => id !== "12001")) throw new Error("fixture workload host UID evidence mismatched");
          uidObserved = true;
        }
      } catch (error) { fail(error); }
    }, 100);
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code) => {
      clearTimeout(deadline); clearInterval(observer);
      try {
        if (failure) throw failure;
        const entry = fixtureContainerInventory(resources, docker, command).find((item) => item.phase === phase);
        if (!entry || entry.value.State.Running) throw new Error("fixture phase container not settled");
        if (code !== 0) {
          const error = new Error(`fixture ${phase} subprocess failed`);
          if (phase === "install" && stderr.includes("prepared install state does not match the host-sealed digest")) error.code = "FIXTURE_INSTALL_PROTOCOL_REJECTED";
          throw error;
        }
        if (phase === "install" && !uidObserved) throw new Error("fixture install host UID evidence missing");
        evidence.write(`${phase}-execution`, JSON.stringify({ phase, image: resources.image, jobId: resources.jobId, uid: 12001, uidObserved, code }));
        accept(stdout);
      } catch (error) { reject(error); }
    });
  });
}
