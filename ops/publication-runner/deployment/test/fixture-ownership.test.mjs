import assert from "node:assert/strict";
import test from "node:test";
import { deriveFixtureResources, fixtureOwnership, validateFixtureOwnership, cleanupFixtureResources } from "../fixture-ownership.mjs";

const jobId = `previewjob_${"b".repeat(64)}`;
const input = { runId: "123", runAttempt: 1, scenario: "success", jobId, image: `sha256:${"a".repeat(64)}`, planDigest: `sha256:${"c".repeat(64)}` };
test("fixture namespace binds coordinates separately from actual nonce-bearing job and table", () => {
  const resources = deriveFixtureResources(input);
  assert.equal(resources.nftTable, "api_migrator_gw_bbbbbbbbbbbbbbbb");
  assert.notEqual(resources.suffix, "bbbbbbbbbbbbbbbb");
  assert.equal(resources.containers.install, `api-migrator-fixture-${jobId}-install`);
  assert.equal(validateFixtureOwnership(fixtureOwnership(resources), resources).jobId, jobId);
  for (const key of ["jobId", "image", "planDigest", "workspacePath", "gatewayUnit", "nftTable"]) {
    assert.throws(() => validateFixtureOwnership({ ...fixtureOwnership(resources), [key]: "substituted" }, resources));
  }
});

function machine(fault = {}) {
  const resources = deriveFixtureResources(input);
  let table = true, tree = true, unit = true, containers = true;
  const actions = [];
  const host = {
    validateOwnership: () => validateFixtureOwnership(fixtureOwnership(resources), resources),
    containersAbsent: () => !containers,
    removeContainers: () => { actions.push("containers"); if (!fault.container) containers = false; },
    stopGateway: async () => { actions.push("unit"); unit = false; },
    quiescent: () => !unit && !fault.uid,
    tableExists: () => table,
    treesAbsent: () => !tree,
    removeTrees: () => { actions.push("trees"); if (!fault.tree) tree = false; },
    deleteTable: () => { actions.push("table"); if (!fault.table) table = false; },
  };
  return { resources, host, actions };
}
test("owned cleanup removes containers and exact unit before trees and table last", async () => {
  const { resources, host, actions } = machine();
  assert.deepEqual(await cleanupFixtureResources(resources, host), { complete: true });
  assert.deepEqual(actions, ["containers", "unit", "trees", "table"]);
});
test("live UID, surviving container or tree preserves containment and fails cleanup", async () => {
  for (const fault of [{ uid: true }, { container: true }, { tree: true }]) {
    const { resources, host, actions } = machine(fault);
    await assert.rejects(cleanupFixtureResources(resources, host), /containment|cleanup/);
    assert(!actions.includes("table"));
  }
  const { resources, host } = machine({ table: true });
  await assert.rejects(cleanupFixtureResources(resources, host), /cleanup/);
});

const teardownFailures = [
  { label: "initial containment inventory", method: "tableExists", actions: ["unit"] },
  { label: "container inventory or removal", method: "removeContainers", actions: ["containers", "unit"] },
  { label: "asynchronous container teardown", method: "removeContainers", asynchronous: true, actions: ["containers", "unit"] },
];
for (const fault of teardownFailures) {
  test(`owned cleanup still stops the gateway when ${fault.label} fails`, async () => {
    const { resources, host, actions } = machine();
    const tableExists = host.tableExists;
    const failure = new Error(`${fault.label} unavailable`);
    host[fault.method] = () => {
      if (fault.method === "removeContainers") actions.push("containers");
      if (fault.asynchronous) return Promise.reject(failure);
      throw failure;
    };
    await assert.rejects(cleanupFixtureResources(resources, host), (error) => error === failure);
    assert.deepEqual(actions, fault.actions);
    assert.equal(tableExists(), true, "containment must remain installed after a failed observation or teardown");
    assert.equal(host.treesAbsent(), false);
  });
}

for (const method of ["tableExists", "removeContainers"]) {
  test(`owned cleanup preserves ${method} and gateway stop failures together`, async () => {
    const { resources, host, actions } = machine();
    const primaryFailure = new Error(`${method} unavailable`);
    const stopFailure = new Error("gateway stop unavailable");
    host[method] = () => {
      if (method === "removeContainers") actions.push("containers");
      throw primaryFailure;
    };
    host.stopGateway = async () => { actions.push("unit"); throw stopFailure; };
    await assert.rejects(cleanupFixtureResources(resources, host), (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primaryFailure, stopFailure]);
      assert.equal(error.errors[0], primaryFailure);
      assert.equal(error.errors[1], stopFailure);
      return true;
    });
    assert.deepEqual(actions, method === "tableExists" ? ["unit"] : ["containers", "unit"]);
    assert.equal(host.treesAbsent(), false);
  });
}

test("owned cleanup preserves a sole gateway stop failure and retains containment", async () => {
  const { resources, host, actions } = machine();
  const failure = new Error("gateway stop unavailable");
  host.stopGateway = () => { actions.push("unit"); throw failure; };
  await assert.rejects(cleanupFixtureResources(resources, host), (error) => error === failure);
  assert.deepEqual(actions, ["containers", "unit"]);
  assert.equal(host.tableExists(), true);
  assert.equal(host.treesAbsent(), false);
});

test("falsy teardown and stop rejections cannot permit later cleanup mutations", async () => {
  for (const primaryFailure of [undefined, null, false, 0, ""]) {
    for (const paired of [false, true]) {
      const { resources, host, actions } = machine();
      host.removeContainers = async () => { actions.push("containers"); throw primaryFailure; };
      if (paired) host.stopGateway = async () => { actions.push("unit"); throw null; };
      await assert.rejects(cleanupFixtureResources(resources, host), (error) => {
        if (paired) {
          assert(error instanceof AggregateError);
          assert.deepEqual(error.errors, [primaryFailure, null]);
        } else assert.equal(error, primaryFailure);
        return true;
      });
      assert.deepEqual(actions, ["containers", "unit"]);
      assert.equal(host.tableExists(), true);
      assert.equal(host.treesAbsent(), false);
    }
  }
});

test("invalid exact resources or ownership marker prevent every native cleanup action", async () => {
  for (const invalidResources of [false, true]) {
    const { resources, host } = machine();
    const observations = [];
    for (const method of Object.keys(host)) {
      host[method] = () => {
        observations.push(method);
        if (method === "validateOwnership") {
          validateFixtureOwnership({ ...fixtureOwnership(resources), gatewayUnit: "substituted" }, resources);
        }
        throw new Error("unexpected native cleanup action");
      };
    }
    await assert.rejects(cleanupFixtureResources(invalidResources ? { ...resources, nftTable: "substituted" } : resources, host), /substituted/);
    assert.deepEqual(observations, invalidResources ? [] : ["validateOwnership"]);
  }
});

test("throwing container, quiescence, containment or tree proof retains the table after the stop attempt", async () => {
  for (const method of ["containersAbsent", "quiescent", "tableExists", "removeTrees", "treesAbsent"]) {
    const { resources, host, actions } = machine();
    const tableExists = host.tableExists;
    const failure = new Error(`${method} observation unavailable`);
    let reads = 0;
    host[method] = () => {
      if (method === "tableExists" && reads++ === 0) return tableExists();
      if (method === "removeTrees") actions.push("trees");
      throw failure;
    };
    await assert.rejects(cleanupFixtureResources(resources, host), (error) => error === failure);
    assert.equal(actions.filter((action) => action === "unit").length, 1);
    assert(!actions.includes("table"));
    assert.equal(tableExists(), true);
  }
});
