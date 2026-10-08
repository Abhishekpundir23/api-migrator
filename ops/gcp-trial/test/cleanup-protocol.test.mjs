import assert from "node:assert/strict";
import test from "node:test";
import { cleanupReadFixture, BASE, page } from "./cleanup-read-fixture.mjs";
import { rehearseTrialCleanup } from "../cleanup-protocol.mjs";
const VM = "18446744073709551614", DISK = "18446744073709551613";
function fixture() {
  const f = cleanupReadFixture(); f.nowMs = f.plan.deleteAt;
  f.calls = []; f.reads = 0; f.operations = [];
  const inventory = (instances, disks) => JSON.stringify({ projectId: f.plan.projectId, zone: f.plan.zone,
    observedAt: f.nowMs, filter: "", instances: [{ pageToken: "", response: page("instances", instances) }],
    disks: [{ pageToken: "", response: page("disks", disks) }] });
  f.snapshots = [() => inventory([f.vm], [f.disk]), () => inventory([], [{ ...f.disk, users: [] }]), () => inventory([], [])];
  f.inventory = inventory;
  f.readInventory = async () => { f.reads++; return f.snapshots.shift()(); };
  f.operation = (kind, status = "DONE") => ({ kind: "compute#operation", id: kind === "instances" ? "345" : "346",
    name: `delete-${kind}`, selfLink: `${BASE}/operations/delete-${kind}`, zone: BASE,
    operationType: "delete", targetId: kind === "instances" ? VM : DISK,
    targetLink: `${BASE}/${kind}/${f.plan.instanceName}`, status });
  f.transport = async request => {
    f.calls.push(request); const kind = request.url.includes(`/instances/${VM}`) ? "instances" : "disks";
    return { status: 200, body: JSON.stringify(f.operations.shift() ?? f.operation(kind)) };
  };
  f.run = (options = {}) => {
    return rehearseTrialCleanup(JSON.stringify(f.plan), JSON.stringify(f.ownership), {
      transport: f.transport, readInventory: f.readInventory, now: () => f.nowMs,
      wait: async () => { f.nowMs += 1000; }, ...options });
  };
  return f;
}

// These tests catch protocol ordering/targeting regressions. Only cloud I/O and
// waiting are replaced; ownership, inventory and operation validation stay real.
test("rehearses exact-ID VM then orphan-disk deletion and independently reads final absence", async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.status, "absence_observed"); assert.equal(f.reads, 3);
  assert.deepEqual(f.calls.map(r => [r.method, new URL(r.url).pathname]), [
    ["DELETE", new URL(`${BASE}/instances/${VM}`).pathname], ["DELETE", new URL(`${BASE}/disks/${DISK}`).pathname],
  ]);
  for (const call of f.calls) {
    assert.deepEqual([...new URL(call.url).searchParams.keys()], ["requestId"]);
    assert.match(new URL(call.url).searchParams.get("requestId"), /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(Object.hasOwn(call, "headers"), false); assert.equal(Object.hasOwn(call, "body"), false);
  }
  assert.notEqual(f.calls[0].url.split("requestId=")[1], f.calls[1].url.split("requestId=")[1]);
  assert.equal(result.mode, "rehearsal"); assert.equal(result.activationBlocked, true);
  assert.equal(result.executionBlocked, true); assert.equal(result.cleanupVerified, false);
  assert.equal(result.cloudVerified, false); assert.equal(result.independentControllerReady, false);
});
test("waiting never dispatches deletion and retains the original deadline", async () => {
  const f = fixture(); f.nowMs--;
  const out = await f.run(); assert.equal(out.status, "waiting"); assert.equal(out.deleteAt, f.plan.deleteAt);
  assert.equal(f.calls.length, 0);
});
for (const reason of ["completed", "failed", "cancelled", "controller_failure"]) test(`early ${reason} does not wait for logs or extend the deadline`, async () => {
  const f = fixture(); f.nowMs--;
  assert.equal((await f.run({ reason })).status, "absence_observed"); assert.equal(f.calls.length, 2);
});
test("automatic boot-disk deletion still requires a complete follow-up inventory", async () => {
  const f = fixture(); f.snapshots.splice(1, 1);
  assert.equal((await f.run()).status, "absence_observed"); assert.equal(f.calls.length, 1); assert.equal(f.reads, 2);
});
test("an already absent VM and disk require no DELETE", async () => {
  const f = fixture(); f.snapshots.splice(0, 2);
  assert.equal((await f.run()).status, "absence_observed"); assert.equal(f.calls.length, 0);
});
test("orphan-disk-only cleanup never deletes an instance", async () => {
  const f = fixture(); f.snapshots.shift();
  assert.equal((await f.run()).status, "absence_observed"); assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, new RegExp(`/disks/${DISK}\\?`));
});
test("polling uses only the bound operation name and validates DONE before disk deletion", async () => {
  const f = fixture(); f.operations = [f.operation("instances", "PENDING"), f.operation("instances", "RUNNING"), f.operation("instances")];
  assert.equal((await f.run()).status, "absence_observed");
  assert.deepEqual(f.calls.map(r => r.method), ["DELETE", "GET", "GET", "DELETE"]);
  assert.equal(f.calls[1].url, `${BASE}/operations/delete-instances`);
});
for (const [name, mutate] of [
  ["wrong target generation", o => { o.targetId = "987"; }],
  ["lossy numeric ID", o => { o.targetId = Number(VM); }],
  ["foreign target link", o => { o.targetLink = o.targetLink.replace("project-32bf49a2-bd30-4956-850", "work"); }],
  ["insert operation", o => { o.operationType = "insert"; }],
  ["operation error", o => { o.error = {}; }],
  ["warning", o => { o.warnings = []; }],
  ["HTTP error field", o => { o.httpErrorStatusCode = 0; }],
  ["redirecting selfLink", o => { o.selfLink = "https://example.com/secret"; }],
  ["unsafe operation name", o => { o.name = "../elsewhere"; }],
  ["overflow operation ID", o => { o.id = "18446744073709551616"; }],
  ["unknown status", o => { o.status = "SUCCESS"; }],
]) test(`never advances after ${name}`, async () => {
  const f = fixture(), op = f.operation("instances"); mutate(op); f.operations = [op];
  const out = await f.run(); assert.equal(out.status, "indeterminate");
  assert.equal(f.calls.length, 1); assert.equal(f.reads, 1);
});
test("same operation name with changed operation ID on polling is rejected", async () => {
  const f = fixture(); f.operations = [f.operation("instances", "PENDING"), { ...f.operation("instances"), id: "999" }];
  assert.equal((await f.run()).status, "indeterminate"); assert.equal(f.calls.length, 2); assert.equal(f.reads, 1);
});
for (const status of [202, 302, 401, 403, 409, 429, 500]) test(`HTTP ${status} never retries or falls back to a resource name`, async () => {
  const f = fixture(); f.transport = async r => { f.calls.push(r); return { status, body: "private response" }; };
  const out = await f.run(); assert.equal(out.status, "indeterminate"); assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(out).includes("private response"), false);
});
test("DELETE transport ambiguity stops without another request", async () => {
  const f = fixture(); f.transport = async r => { f.calls.push(r); throw new Error("sensitive-token"); };
  const out = await f.run(); assert.equal(out.status, "indeterminate"); assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(out).includes("sensitive-token"), false);
});
test("404 is not completion until both exact IDs are absent from fresh inventory", async () => {
  const f = fixture(); f.transport = async r => { f.calls.push(r); return { status: 404, body: "" }; };
  f.snapshots.splice(1, 1);
  assert.equal((await f.run()).status, "absence_observed"); assert.equal(f.reads, 2); assert.equal(f.calls.length, 1);
});
test("404 with the original VM still present never falls back or retries", async () => {
  const f = fixture(); f.snapshots[1] = f.snapshots[0];
  f.transport = async r => { f.calls.push(r); return { status: 404, body: "" }; };
  assert.equal((await f.run()).status, "indeterminate"); assert.equal(f.calls.length, 1);
});
for (const [name, snapshot] of [
  ["same-name replacement", f => f.inventory([{ ...f.vm, id: "987" }], [])],
  ["additional VM attachment", f => f.inventory([{ ...f.vm, disks: [...f.vm.disks, { source: `${BASE}/disks/other` }] }], [f.disk])],
  ["disk now attached elsewhere", f => f.inventory([], [{ ...f.disk, users: [`${BASE}/instances/other`] }])],
  ["another VM claims the disk despite empty users", f => f.inventory([{ ...f.vm, id: "987", name: "other", selfLink: `${BASE}/instances/other`, labels: {} }], [{ ...f.disk, users: [] }])],
  ["incomplete pagination", f => { const v = JSON.parse(f.inventory([], [])); v.disks[0].response.nextPageToken = "next"; return JSON.stringify(v); }],
]) test(`no deletion after ${name}`, async () => {
  const f = fixture(); f.snapshots[0] = () => snapshot(f);
  const out = await f.run(); assert.ok(["blocked", "indeterminate"].includes(out.status)); assert.equal(f.calls.length, 0);
});
test("post-VM replacement halts before disk deletion", async () => {
  const f = fixture(); f.snapshots[1] = () => f.inventory([{ ...f.vm, id: "987" }], [f.disk]);
  assert.equal((await f.run()).status, "blocked"); assert.equal(f.calls.length, 1);
});
test("an inventory predating operation completion cannot prove absence", async () => {
  const f = fixture(), transport = f.transport; const old = f.inventory([], []);
  f.transport = async r => { const out = await transport(r); f.nowMs += 10; return out; };
  f.snapshots[1] = () => old;
  assert.equal((await f.run()).status, "indeterminate"); assert.equal(f.calls.length, 1);
});
test("polling is bounded even with a frozen injected clock", async () => {
  const f = fixture(); f.operations = Array.from({ length: 8 }, () => f.operation("instances", "RUNNING"));
  assert.equal((await f.run({ wait: async () => {} })).status, "indeterminate");
  assert.equal(f.calls.length, 6); assert.equal(f.reads, 1);
});
test("transport ignoring abort is bounded and cannot dispatch follow-up work when it later resolves", async () => {
  const f = fixture(); let resolve, signal;
  f.transport = r => { f.calls.push(r); signal = r.signal; return new Promise(r => { resolve = r; }); };
  const out = await f.run({ timeoutMs: 10 }); assert.equal(out.status, "indeterminate"); assert.equal(signal.aborted, true);
  resolve({ status: 200, body: JSON.stringify(f.operation("instances")) });
  await new Promise(r => setImmediate(r)); assert.equal(f.calls.length, 1); assert.equal(f.reads, 1);
});
for (const options of [{ transport: undefined }, { readInventory: undefined }, { reason: "extend" }, { timeoutMs: 0 }, { timeoutMs: 20001 }])
  test(`invalid protocol configuration fails before callbacks (${Object.keys(options)})`, async () => {
    const f = fixture(); await assert.rejects(f.run(options), /cleanup rehearsal failed/);
    assert.equal(f.calls.length, 0); assert.equal(f.reads, 0);
  });
test("altered ownership fails before callbacks", async () => {
  const f = fixture(); f.ownership.instanceId = "987";
  await assert.rejects(f.run(), /cleanup rehearsal failed/); assert.equal(f.reads, 0);
});
for (const [name, change] of [
  ["plan command", f => { f.plan.commands.create.push("--project=work"); }],
  ["initial clock", f => { f.nowMs = NaN; }],
]) test(`invalid ${name} fails before callbacks`, async () => {
  const f = fixture(); change(f); await assert.rejects(f.run(), /cleanup rehearsal failed/);
  assert.equal(f.reads, 0); assert.equal(f.calls.length, 0);
});
test("final disk still present after DONE never triggers a second DELETE", async () => {
  const f = fixture(); f.snapshots[2] = f.snapshots[1];
  const out = await f.run(); assert.equal(out.status, "indeterminate");
  assert.equal(out.reason, "resource_still_present"); assert.equal(f.calls.length, 2); assert.equal(f.reads, 3);
});
for (const [name, change] of [
  ["operation name", o => { o.name = "new-operation"; o.selfLink = `${BASE}/operations/new-operation`; }],
  ["target ID", o => { o.targetId = "987"; }],
  ["target link", o => { o.targetLink = `${BASE}/instances/other`; }],
  ["regressed status", o => { o.status = "PENDING"; }],
]) test(`polling rejects changed ${name}`, async () => {
  const f = fixture(), op = f.operation("instances"); change(op);
  f.operations = [f.operation("instances", "RUNNING"), op];
  assert.equal((await f.run()).status, "indeterminate"); assert.equal(f.calls.length, 2); assert.equal(f.reads, 1);
});
for (const body of ["{", "[]", "null", " ".repeat(65537)]) test(`malformed or oversized operation body is indeterminate (${body.length})`, async () => {
  const f = fixture(); f.transport = async r => { f.calls.push(r); return { status: 200, body }; };
  assert.equal((await f.run()).status, "indeterminate"); assert.equal(f.calls.length, 1);
});
for (const drift of [-1, 1]) test(`inventory timestamp drift ${drift} cannot authorize requests`, async () => {
  const f = fixture(); f.snapshots[0] = () => {
    const inv = JSON.parse(f.inventory([f.vm], [f.disk])); inv.observedAt += drift; return JSON.stringify(inv);
  };
  assert.equal((await f.run()).status, "indeterminate"); assert.equal(f.calls.length, 0);
});
for (const drift of [-1, 20001]) test(`clock drift ${drift} after dispatch halts protocol`, async () => {
  const f = fixture(), transport = f.transport;
  f.transport = async r => { const out = await transport(r); f.nowMs += drift; return out; };
  assert.equal((await f.run()).status, "indeterminate"); assert.equal(f.calls.length, 1); assert.equal(f.reads, 1);
});
for (const stage of ["readInventory", "wait"]) test(`stalled ${stage} is bounded even when abort is ignored`, async () => {
  const f = fixture(); f.operations = [f.operation("instances", "RUNNING")];
  const out = await f.run({ timeoutMs: 10, [stage]: () => new Promise(() => {}) });
  assert.equal(out.status, "indeterminate"); assert.equal(f.calls.length, stage === "wait" ? 1 : 0);
});
test("request IDs are stable per ownership and different per resource", async () => {
  const first = fixture(), second = fixture(); await first.run(); await second.run();
  assert.deepEqual(first.calls.map(c => c.url), second.calls.map(c => c.url));
});
