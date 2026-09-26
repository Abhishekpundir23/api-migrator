import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import * as native from "../fixture-native.mjs";
import * as fixture from "../run-image-lifecycle-fixture.mjs";
import { cleanupFixtureResources, deriveFixtureResources } from "../fixture-ownership.mjs";

const image = `sha256:${"a".repeat(64)}`, jobId = `previewjob_${"b".repeat(64)}`;
const containerId = "c".repeat(64);
const input = { runId: "123", runAttempt: 1, scenario: "success", jobId, image, planDigest: `sha256:${"d".repeat(64)}` };

function boundary(fault = {}) {
  const resources = deriveFixtureResources(input), events = [];
  let paused = false, present = true, running = true, unit = true, trees = true, table = true, reads = 0;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = (signal) => {
    events.push(`client:${signal}`);
    if (fault.kill) return false;
    if (!fault.close) queueMicrotask(() => { events.push("client:closed"); child.emit("close", null, fault.signal ? "SIGTERM" : "SIGKILL"); });
    return true;
  };
  const processes = {
    spawn: () => child,
    async command(_path, args, options) {
      assert(options.signal instanceof AbortSignal);
      assert(options.timeoutMs > 0 && options.timeoutMs <= 800);
      if (args[1] === "pause") {
        assert.deepEqual(args, ["container", "pause", containerId]);
        events.push("pause");
        if (fault.slowPause) return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => {
          events.push("pause:aborted"); reject(new Error("SECRET late pause"));
        }, { once: true }));
        if (fault.pause) return { status: 1, stdout: "", stderr: "SECRET pause failure" };
        paused = true;
        if (fault.naturalClose) queueMicrotask(() => child.emit("close", 0, null));
        return { status: 0, stdout: containerId, stderr: "" };
      }
      assert.equal(args[1], "inspect");
      assert.equal(args[2], paused ? containerId : resources.containers.install);
      const retained = events.includes("client:closed");
      events.push(retained ? "inspect:retained" : paused ? "inspect:paused" : "inspect:live");
      return { status: 0, stderr: "", stdout: JSON.stringify([{
        Id: fault.badId && !paused ? "not-an-id" : fault.substituted && paused ? "e".repeat(64) : containerId,
        Name: `/${resources.containers.install}`, Image: image,
        Config: { User: "12001:12001", Labels: { "api-migrator.fixture-job": jobId } },
        HostConfig: { NetworkMode: "host", UsernsMode: "", Privileged: false },
        State: { Running: !(fault.stopped && paused), Paused: fault.alreadyPaused || (fault.unpaused && retained ? false : paused), Pid: fault.pid && paused ? 4321 : 1234 },
      }]) };
    },
    status() {
      reads += 1; events.push("uid");
      return `Uid:\t${fault.uid && reads > 1 ? "0\t0\t0\t0" : "12001\t12001\t12001\t12001"}\n`;
    },
  };
  const request = { phase: "install", dockerArgs: ["run", "--name", resources.containers.install, image], timeoutMs: 800 };
  const execute = () => native.executeNativeFixturePhase(request, { resources, docker: "/usr/bin/docker", processes,
    cancelInstall: true, evidence: { write(label, bytes) {
      events.push(`evidence:${label}`);
      if (fault.evidence) throw new Error("SECRET evidence failure");
      assert.deepEqual(JSON.parse(bytes), { jobId, image, containerId, uidObserved: true, containerPaused: true, clientSignal: "SIGKILL", containerRetained: true });
    } } });
  const operations = Object.fromEntries(["installPolicy", "prepare", "startGateway", "probeOnline", "stopGateway", "assertOffline", "migrate", "verify"]
    .map((name) => [name, async () => { events.push(name); return { phaseIntegration: "passed" }; }]));
  operations.install = execute;
  operations.cleanup = () => cleanupFixtureResources(resources, {
    validateOwnership() {}, tableExists: () => table, containersAbsent: () => !present,
    removeContainers() { events.push("remove"); assert(running, "client termination must not pretend to remove the container");
      if (!fault.cleanup) { present = false; running = false; } },
    stopGateway() { unit = false; }, quiescent: () => !running && !unit,
    treesAbsent: () => !trees, removeTrees() { trees = false; }, deleteTable() { events.push("table"); table = false; },
  });
  return { execute, operations, events, residual: () => present || running || unit || trees || table };
}

test("cancellation pauses a live owned install, observes client death and retained container, then cleans exactly", async () => {
  const value = boundary();
  let error;
  await assert.rejects(value.execute(), (failure) => { error = failure; return true; });
  assert.equal(typeof native.getFixtureInstallCancellation, "function");
  assert.deepEqual(native.getFixtureInstallCancellation(error), {
    jobId, image, containerId, uidObserved: true, containerPaused: true, clientSignal: "SIGKILL", containerRetained: true,
  });
  assert(Object.isFrozen(native.getFixtureInstallCancellation(error)));
  assert.deepEqual(value.events, ["inspect:live", "uid", "pause", "inspect:paused", "uid", "client:SIGKILL", "client:closed", "inspect:retained", "evidence:install-cancellation"]);
  assert.equal(value.residual(), true);
  assert.deepEqual(await value.operations.cleanup(), { complete: true });
  assert.equal(value.residual(), false);
});

test("only native cancellation plus successful cleanup produces the non-authorizing expected result", async () => {
  assert.equal(typeof fixture.runImageFixtureScenario, "function");
  const value = boundary();
  const result = await fixture.runImageFixtureScenario(value.operations, "install_cancel");
  assert.equal(result.phaseIntegration, "expected_install_cancellation");
  assert.deepEqual(result.cancellationProof, { jobId, image, containerId, uidObserved: true, containerPaused: true, clientSignal: "SIGKILL", containerRetained: true });
  assert.equal(result.cleanup, "complete");
  assert.equal(result.securityDrill, false); assert.equal(result.selfAttested, true);
  assert.equal(result.releaseEvidenceEligible, false); assert.equal(result.activationBlocked, true); assert.equal(result.externalSigningEligible, false);
  assert(!value.events.includes("migrate")); assert(!value.events.includes("verify"));
  assert.equal(value.events.at(-1), "table"); assert.equal(value.residual(), false);
});

for (const fault of ["badId", "alreadyPaused", "pause", "substituted", "pid", "stopped", "uid", "naturalClose", "kill", "signal", "unpaused", "evidence", "slowPause", "close"]) {
  test(`cancellation refuses ${fault} failure without minting expected evidence`, async () => {
    const value = boundary({ [fault]: true });
    let error;
    await assert.rejects(value.execute(), (failure) => { error = failure; return true; });
    assert.equal(typeof native.getFixtureInstallCancellation, "function");
    assert.equal(native.getFixtureInstallCancellation(error), undefined);
    if (fault === "slowPause") assert(value.events.includes("pause:aborted"));
    const diagnostic = fixture.formatFixtureFailure(error);
    assert.doesNotMatch(diagnostic, /SECRET|late pause|pause failure|evidence failure/);
    await value.operations.cleanup();
    assert.equal(value.residual(), false);
  });
}

test("cleanup failure, forged error, wrong scenario and unexpected success cannot pass cancellation", async () => {
  assert.equal(typeof fixture.runImageFixtureScenario, "function");
  const failed = boundary({ cleanup: true });
  await assert.rejects(fixture.runImageFixtureScenario(failed.operations, "install_cancel"), AggregateError);
  assert(!failed.events.includes("table")); assert(failed.residual());
  const wrong = boundary();
  await assert.rejects(fixture.runImageFixtureScenario(wrong.operations, "success"));
  for (const failure of [new Error("cancelled"), Object.assign(new Error("cancelled"), {
    code: "FIXTURE_INSTALL_CANCELLED", cancellationProof: { containerPaused: true, clientSignal: "SIGKILL" },
  })]) {
    const value = boundary(); value.operations.install = () => { throw failure; };
    await assert.rejects(fixture.runImageFixtureScenario(value.operations, "install_cancel"), (error) => error === failure);
  }
  const success = boundary(); success.operations.install = async () => {};
  await assert.rejects(fixture.runImageFixtureScenario(success.operations, "install_cancel"), /unexpectedly succeeded/);
});

test("cancellation scenario owns a distinct resource namespace and round trips through the strict CLI", () => {
  const resources = deriveFixtureResources({ ...input, scenario: "install_cancel" });
  assert.notEqual(resources.suffix, deriveFixtureResources(input).suffix);
  assert.notEqual(resources.suffix, deriveFixtureResources({ ...input, scenario: "install_failure" }).suffix);
  assert.equal(fixture.parseImageLifecycleFixtureCli(["--image", image, "--output-dir", "/tmp/api-migrator-fixture-results/123-install_cancel", "--scenario", "install_cancel"]).scenario, "install_cancel");
});
