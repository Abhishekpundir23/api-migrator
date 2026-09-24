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
