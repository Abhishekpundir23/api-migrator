import assert from "node:assert/strict";
import test from "node:test";
import { renderTrialPlan } from "../plan.mjs";
import { captureOwnership, decideCleanup } from "../cleanup.mjs";

const NOW = 2_000_000_000_000;
const PROJECT = "project-32bf49a2-bd30-4956-850";
const ZONE = "us-central1-a";
const BASE = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}`;
const RUN = "abcdef0123456789abcdef0123456789";
const NAME = `api-migrator-trial-${RUN}`;
const VMID = "18446744073709551614", DISKID = "18446744073709551613";
const plan = () => renderTrialPlan({ projectId: PROJECT, runId: RUN, sourceRevision: "a".repeat(40),
  sourceArchiveSha256: "b".repeat(64), bootImage: "debian-12-bookworm-v20260908", network: "api-migrator-trial-net",
  subnetwork: "api-migrator-trial-subnet", egress: "existing-nat", startupScriptSha256: "c".repeat(64), deleteAt: NOW + 3_600_000 }, { nowMs: NOW });
function observation() {
  return { projectId: PROJECT, zone: ZONE, observedAt: NOW + 20_000,
    operation: { id: "123", status: "DONE", operationType: "insert", zone: BASE, targetId: VMID, targetLink: `${BASE}/instances/${NAME}` },
    instance: { id: VMID, name: NAME, selfLink: `${BASE}/instances/${NAME}`, zone: BASE,
      creationTimestamp: new Date(NOW + 1000).toISOString(), labels: { "api-migrator-trial": RUN },
      disks: [{ boot: true, autoDelete: true, source: `${BASE}/disks/${NAME}` }] },
    disk: { id: DISKID, name: NAME, selfLink: `${BASE}/disks/${NAME}`, zone: BASE,
      creationTimestamp: new Date(NOW + 500).toISOString(), users: [`${BASE}/instances/${NAME}`] } };
}
const json = JSON.stringify;
const capture = (value = observation(), p = plan()) => captureOwnership(json(p), json(value), { nowMs: NOW + 20_000 });
function inventory(instances = [], disks = [], at = NOW + 3_600_000) {
  return { projectId: PROJECT, zone: ZONE, observedAt: at, filter: "",
    instances: [{ pageToken: "", response: list("instances", instances) }],
    disks: [{ pageToken: "", response: list("disks", disks) }] };
}
const list = (kind, items, nextPageToken) => ({ kind: kind === "instances" ? "compute#instanceList" : "compute#diskList",
  selfLink: `${BASE}/${kind}`, items, ...(nextPageToken ? { nextPageToken } : {}) });
function decide(inv, reason = "deadline", record = capture(), at = NOW + 3_600_000) {
  return decideCleanup(json(plan()), json(record), json(inv), { nowMs: at, reason });
}

test("capture binds independent lossless IDs to the exact plan and completed create operation", () => {
  const record = capture();
  assert.equal(record.instanceId, VMID); assert.equal(record.diskId, DISKID);
  assert.equal(record.planDigest, plan().planDigest); assert.equal(record.deleteAt, NOW + 3_600_000);
  assert.equal(record.projectId, PROJECT); assert.equal(record.zone, ZONE);
  assert.equal(record.activationBlocked, true);
});

for (const [name, change] of [
  ["wrong project", (o) => { o.projectId = "professional"; }],
  ["inexact numeric ID", (o) => { o.instance.id = Number(VMID); }],
  ["overflow ID", (o) => { o.instance.id = "18446744073709551616"; }],
  ["wrong target", (o) => { o.operation.targetId = "456"; }],
  ["operation error", (o) => { o.operation.error = { errors: [{ code: "FAIL" }] }; }],
  ["operation pending", (o) => { o.operation.status = "RUNNING"; }],
  ["operation wrong link", (o) => { o.operation.targetLink = `${BASE}/instances/other`; }],
  ["resource in other zone", (o) => { o.disk.zone = BASE.replace(ZONE, "us-central1-b"); }],
  ["old resource", (o) => { o.instance.creationTimestamp = new Date(NOW - 1).toISOString(); }],
  ["unexpected extra disk", (o) => { o.instance.disks.push({ boot: false, autoDelete: true, source: `${BASE}/disks/other` }); }],
  ["disk attachment mismatch", (o) => { o.instance.disks[0].source = `${BASE}/disks/other`; }],
  ["auto delete disabled", (o) => { o.instance.disks[0].autoDelete = false; }],
  ["foreign disk user", (o) => { o.disk.users = [`${BASE}/instances/other`]; }],
  ["wrong nonce", (o) => { o.instance.labels["api-migrator-trial"] = "f".repeat(32); }],
  ["stale observation", (o) => { o.observedAt = NOW - 20_000; }],
  ["future observation", (o) => { o.observedAt = NOW + 20_001; }],
]) {
  test(`capture refuses ${name}`, () => {
    const o = observation(); change(o); assert.throws(() => capture(o), /invalid|mismatch|stale|scope|ownership/);
  });
}
test("altered commands and deadline cannot retain a valid plan or ownership binding", () => {
  const p = plan(); p.commands.create.push("--service-account=privileged");
  assert.throws(() => capture(observation(), p), /plan/);
  const record = capture(); record.deleteAt++;
  assert.throws(() => decide(inventory(), "deadline", record), /record|ownership/);
});
test("cleanup deadline is strict and does not move after controller restart", () => {
  const o = observation();
  assert.equal(decide(inventory([o.instance], [o.disk], NOW + 30_000), "deadline", capture(), NOW + 30_000).status, "waiting");
  const due = decide(inventory([o.instance], [o.disk]));
  assert.equal(due.status, "blocked"); assert.equal(due.reason, "generation_safe_delete_unverified");
  assert.equal(due.resource, "instance"); assert.equal(due.instanceId, VMID);
  assert.equal(due.executionBlocked, true); assert.equal(due.activationBlocked, true);
  assert.equal(Object.hasOwn(due, "command"), false);
});
for (const reason of ["completed", "failed", "cancelled", "controller_failure"]) {
  test(`early ${reason} requires cleanup without waiting for logs`, () => {
    const o = observation();
    const result = decide(inventory([o.instance], [o.disk], NOW + 30_000), reason, capture(), NOW + 30_000);
    assert.equal(result.reason, "generation_safe_delete_unverified"); assert.equal(result.status, "blocked");
  });
}
test("complete empty inventories observe both resources absent but do not mint live evidence", () => {
  const result = decide(inventory());
  assert.equal(result.status, "absence_observed");
  assert.equal(result.cloudVerified, false); assert.equal(result.activationBlocked, true);
  assert.match(result.inventoryDigest, /^sha256:[a-f0-9]{64}$/);
});
test("orphaned boot disk is distinguished from complete cleanup", () => {
  const o = observation(); o.disk.users = [];
  const result = decide(inventory([], [o.disk]));
  assert.equal(result.status, "blocked"); assert.equal(result.resource, "disk");
  assert.equal(result.reason, "generation_safe_delete_unverified");
  o.disk.users = [`${BASE}/instances/other`];
  assert.equal(decide(inventory([], [o.disk])).reason, "disk_attached_elsewhere");
});
test("same-name replacement is never adopted or treated as complete cleanup", () => {
  const o = observation(); o.instance.id = "987";
  assert.equal(decide(inventory([o.instance])).reason, "replacement_or_unowned_resource");
});
for (const vmPresent of [true, false]) test(`foreign disk attachment blocks before deadline with VM present=${vmPresent}`, () => {
  const o = observation(), at = NOW + 30_000; o.disk.users = [`${BASE}/instances/other`];
  const result = decide(inventory(vmPresent ? [o.instance] : [], [o.disk], at), "deadline", capture(), at);
  assert.equal(result.status, "blocked"); assert.equal(result.reason, "disk_attached_elsewhere");
  assert.equal(result.resource, "disk");
});
test("unexpected run-labelled resources are reported rather than deleted", () => {
  const o = observation(); o.instance.name = "unowned"; o.instance.selfLink = `${BASE}/instances/unowned`; o.instance.id = "987";
  assert.equal(decide(inventory([o.instance])).reason, "replacement_or_unowned_resource");
});
test("additional attachment introduced after capture blocks cleanup", () => {
  const o = observation(); o.instance.disks.push({ source: `${BASE}/disks/other`, boot: false, autoDelete: true });
  assert.equal(decide(inventory([o.instance], [o.disk])).reason, "ownership_changed");
});
test("complete pagination finds an owned disk on a later page", () => {
  const o = observation(); o.disk.users = [];
  const inv = inventory();
  inv.disks = [{ pageToken: "", response: list("disks", [], "page-2") },
    { pageToken: "page-2", response: list("disks", [o.disk]) }];
  assert.equal(decide(inv).resource, "disk");
});
for (const [name, change] of [
  ["filtered", (v) => { v.filter = `name=${NAME}`; }],
  ["missing final page", (v) => { v.instances[0].response.nextPageToken = "next"; }],
  ["null continuation token", (v) => { v.disks[0].response.nextPageToken = null; }],
  ["token mismatch", (v) => { v.instances[0].pageToken = "other"; }],
  ["error instead of empty", (v) => { v.disks[0].response = { error: { code: 403 } }; }],
  ["unknown response instead of empty", (v) => { v.disks[0].response = {}; }],
  ["wrong list resource", (v) => { v.disks[0].response.kind = "compute#instanceList"; }],
  ["wrong list scope", (v) => { v.disks[0].response.selfLink = `${BASE}/instances`; }],
  ["pagination loop", (v) => { v.disks = [{ pageToken: "", response: list("disks", [], "next") },
    { pageToken: "next", response: list("disks", [], "next") }, { pageToken: "next", response: list("disks", []) }]; }],
  ["missing resource inventory", (v) => { delete v.disks; }],
  ["stale", (v) => { v.observedAt -= 30_001; }],
  ["future", (v) => { v.observedAt++; }],
  ["cross-project", (v) => { v.projectId = "work"; }],
  ["extra page", (v) => { v.disks.push({ pageToken: "", response: { items: [] } }); }],
  ["duplicate ID", (v) => { v.instances[0].response.items = [observation().instance, observation().instance]; }],
  ["cross-project resource", (v) => { const i = observation().instance; i.selfLink = i.selfLink.replace(PROJECT, "work"); v.instances[0].response.items = [i]; }],
]) {
  test(`no absence claim for ${name} inventory`, () => {
    const inv = inventory(); change(inv); assert.throws(() => decide(inv), /invalid|inventory|scope|stale|pagination|duplicate/);
  });
}
test("controller refuses unknown reason, malformed and oversized JSON", () => {
  assert.throws(() => decide(inventory(), "ignore_deadline"), /reason/);
  assert.throws(() => captureOwnership("{}", "{}", { nowMs: NOW }), /plan/);
  assert.throws(() => decideCleanup(json(plan()), json(capture()), " ".repeat(262_145), { nowMs: NOW + 20_000 }), /size|JSON/);
});
