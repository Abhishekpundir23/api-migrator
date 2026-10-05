import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDockerFixtureExecutor, withFixtureWorkspace } from "../docker-fixture-executor.mjs";

const ID = "a".repeat(64);
const OTHER = "b".repeat(64);
const IMAGE = `sha256:${"c".repeat(64)}`;
const JOB = `previewjob_${"d".repeat(64)}`;
const NAME = `api-migrator-fixture-${JOB}-prepare`;
const request = () => ({ phase: "prepare", image: IMAGE, timeoutMs: 100, maxBuffer: 1024,
  dockerArgs: ["run", "--rm", "--pull=never", "--read-only", "--name", NAME,
    "--label", `api-migrator.fixture-job=${JOB}`, "--user", "1000:1000", IMAGE, "prepare"] });

// The Docker daemon is the external boundary. Model retained container state,
// immutable IDs, and CLI failures; exercise real executor and filesystem code.
function daemon(options = {}) {
  const containers = new Map();
  const calls = [];
  let nonce;
  const record = () => ({ Id: ID, Name: `/${NAME}`, Image: IMAGE,
    Config: { User: "1000:1000", Labels: {
      "api-migrator.fixture-job": JOB, "api-migrator.fixture-attempt": nonce,
    } }, HostConfig: { AutoRemove: false } });
  const command = (file, args, bounds) => {
    assert.equal(file, "docker");
    calls.push(args);
    // Characterize the original run-only bug as a real leaked daemon resource.
    if (args[0] === "run") {
      containers.set(ID, record());
      if (options.startError) throw options.startError;
      return "trusted status\n";
    }
    assert.equal(bounds.killSignal, "SIGKILL");
    assert(bounds.timeout > 0 && bounds.timeout <= 30_000);
    assert(bounds.maxBuffer > 0 && bounds.maxBuffer <= 16 * 1024 * 1024);
    if (args[0] === "create") {
      assert(!args.includes("--rm"));
      nonce = args.find((v) => v.startsWith("api-migrator.fixture-attempt="))?.split("=")[1];
      assert.match(nonce, /^[a-f0-9]{32}$/);
      if (!options.noCreate) containers.set(ID, { ...record(), ...options.substitute });
      if (options.createError) throw options.createError;
      return options.badCreateOutput ?? `${ID}\n`;
    }
    if (args[0] === "start") {
      assert.deepEqual(args, ["start", "--attach", ID]);
      if (options.startError) throw options.startError;
      return "trusted status\n";
    }
    if (args[0] === "container" && args[1] === "ls") {
      if (options.inventoryError) throw options.inventoryError;
      const filter = args[args.indexOf("--filter") + 1];
      if (filter === `id=${ID}`) return containers.has(ID) ? `${ID}\n` : "";
      assert.equal(filter, `name=^/${NAME}$`);
      return [...containers.values()].filter((v) => v.Name === `/${NAME}`).map((v) => v.Id).join("\n");
    }
    if (args[0] === "container" && args[1] === "inspect") {
      assert.deepEqual(args, ["container", "inspect", ID]);
      if (options.inspectError) throw options.inspectError;
      const inspected = options.badInspect ?? JSON.stringify([containers.get(ID)]);
      if (options.rebindName) containers.set(OTHER, { ...record(), Id: OTHER });
      return inspected;
    }
    if (args[0] === "container" && args[1] === "rm") {
      assert.deepEqual(args, ["container", "rm", "--force", ID]);
      if (!options.keepOnRemove) containers.delete(ID);
      if (options.removeError) throw options.removeError;
      return `${ID}\n`;
    }
    throw new Error(`unexpected Docker command: ${args.join(" ")}`);
  };
  return { command, calls, containers };
}

test("successful phase removes its retained container before returning output", () => {
  const docker = daemon();
  const executor = createDockerFixtureExecutor({ command: docker.command });
  assert.equal(executor.execute(request()), "trusted status\n");
  assert.equal(docker.containers.size, 0);
  executor.assertCleanupComplete();
});

for (const code of ["ETIMEDOUT", "ENOBUFS", "EXIT_1"]) {
  test(`${code} after creation preserves the failure and removes the owned container`, () => {
    const failure = Object.assign(new Error(code), { code });
    const docker = daemon({ startError: failure });
    const executor = createDockerFixtureExecutor({ command: docker.command });
    assert.throws(() => executor.execute(request()), (error) => error === failure);
    assert.equal(docker.containers.size, 0);
    executor.assertCleanupComplete();
  });
}

test("create timeout cleans an observed owned container without ever starting it", () => {
  const failure = new Error("create timed out");
  const docker = daemon({ createError: failure });
  const executor = createDockerFixtureExecutor({ command: docker.command });
  assert.throws(() => executor.execute(request()), (error) => error === failure);
  assert.equal(docker.containers.size, 0);
  assert(!docker.calls.some(([op]) => op === "start"));
  executor.assertCleanupComplete();
});

test("unknown create completion is not cleared by empty inventory or later calls", () => {
  const failure = new Error("create timed out before reply");
  const docker = daemon({ noCreate: true, createError: failure });
  const executor = createDockerFixtureExecutor({ command: docker.command });
  assert.throws(() => executor.execute(request()), (error) => error instanceof AggregateError && error.errors[0] === failure);
  assert.throws(() => executor.assertCleanupComplete(), /unverified/);
  const count = docker.calls.length;
  assert.throws(() => executor.execute(request()), /unverified/);
  assert.equal(docker.calls.length, count);
});

for (const substitute of [
  { Name: "/unrelated" }, { Image: `sha256:${"f".repeat(64)}` },
  { Config: { User: "1000:1000", Labels: { "api-migrator.fixture-job": JOB, "api-migrator.fixture-attempt": "foreign" } } },
  { Config: { User: "0:0", Labels: {} } },
]) {
  test(`ownership mismatch is never started or removed: ${JSON.stringify(substitute)}`, () => {
    const docker = daemon({ substitute });
    const executor = createDockerFixtureExecutor({ command: docker.command });
    assert.throws(() => executor.execute(request()), /cleanup|ownership/);
    assert.equal(docker.containers.size, 1);
    assert(!docker.calls.some(([op]) => op === "start"));
    assert(!docker.calls.some((args) => args[1] === "rm"));
    assert.throws(() => executor.assertCleanupComplete(), /unverified/);
  });
}

test("name rebinding does not redirect ID-based removal to another container", () => {
  const docker = daemon({ rebindName: true });
  createDockerFixtureExecutor({ command: docker.command }).execute(request());
  assert.equal(docker.containers.has(ID), false);
  assert.equal(docker.containers.has(OTHER), true);
});

test("CLI removal error is tolerated only when a fresh successful inventory proves absence", () => {
  const docker = daemon({ removeError: new Error("lost removal reply") });
  const executor = createDockerFixtureExecutor({ command: docker.command });
  executor.execute(request());
  executor.assertCleanupComplete();
  assert.equal(docker.containers.size, 0);
});

for (const options of [
  { keepOnRemove: true, removeError: new Error("cannot remove") },
  { inventoryError: new Error("daemon offline") },
  { badInspect: "not json" },
  { inspectError: new Error("permission denied") },
]) {
  test(`unverified cleanup rejects phase success: ${Object.keys(options)}`, () => {
    const docker = daemon(options);
    const executor = createDockerFixtureExecutor({ command: docker.command });
    assert.throws(() => executor.execute(request()));
    assert.throws(() => executor.assertCleanupComplete(), /unverified/);
  });
}

test("execution and cleanup failures are both retained", () => {
  const failure = new Error("phase failed");
  const docker = daemon({ startError: failure, keepOnRemove: true });
  const executor = createDockerFixtureExecutor({ command: docker.command });
  assert.throws(() => executor.execute(request()), (error) => error instanceof AggregateError && error.errors[0] === failure);
});

test("invalid or duplicate identity arguments never call Docker", () => {
  for (const mutate of [
    (r) => r.dockerArgs.splice(1, 0, "--name", NAME),
    (r) => r.dockerArgs.splice(1, 0, "--label", `api-migrator.fixture-job=${JOB}`),
    (r) => { r.image = "mutable:tag"; },
    (r) => { r.timeoutMs = 0; },
    (r) => { r.maxBuffer = 17 * 1024 * 1024; },
  ]) {
    const docker = daemon();
    const r = request(); mutate(r);
    assert.throws(() => createDockerFixtureExecutor({ command: docker.command }).execute(r));
    assert.equal(docker.calls.length, 0);
  }
});

test("workspace removed after verified cleanup; retained with path and both errors otherwise", async () => {
  for (const uncertain of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "fixture-cleanup-test-"));
    writeFileSync(join(root, "input"), "preserve");
    const failure = new Error("phase failed");
    const docker = daemon({ startError: failure, keepOnRemove: uncertain });
    const executor = createDockerFixtureExecutor({ command: docker.command });
    try {
      await assert.rejects(withFixtureWorkspace(root, executor, () => executor.execute(request())),
        (error) => uncertain ? error instanceof AggregateError && error.message.includes(root) : error === failure);
      assert.equal(existsSync(root), uncertain);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
