import assert from "node:assert/strict";
import test from "node:test";
import { validateTrialOwnership } from "../cleanup.mjs";
import { collectTrialOwnership } from "../ownership.mjs";
import { ownershipReadFixture, ACCOUNT, TOKEN, USERINFO, BASE, OPERATION } from "./ownership-read-fixture.mjs";

const collect = (f, options = {}, input = { plan: f.plan, operationName: f.operationName }) =>
  collectTrialOwnership(JSON.stringify(input), TOKEN, { expectedAccount: ACCOUNT, fetchImpl: f.fetchImpl,
    now: () => f.nowMs, ...options });

// Catches loss of exact endpoint scope, identity-first sequencing, ownership
// generation binding, or accidental promotion into executable evidence.
test("authenticates then captures exact creation generations through four GETs and a reusable non-authorizing handoff", async () => {
  const f = ownershipReadFixture(), out = await collect(f);
  assert.deepEqual(f.calls.map(c => new URL(c.url).pathname), [new URL(USERINFO).pathname,
    new URL(`${BASE}/operations/${OPERATION}`).pathname,
    new URL(`${BASE}/instances/${f.plan.instanceName}`).pathname, new URL(`${BASE}/disks/${f.plan.instanceName}`).pathname]);
  assert.equal(f.calls[0].url, USERINFO);
  assert.equal(Object.hasOwn(f.calls[0].options.headers, "X-Goog-User-Project"), false);
  const projections = ["kind,id,name,selfLink,zone,operationType,status,targetId,targetLink,error,warnings,httpErrorStatusCode,httpErrorMessage",
    "kind,id,name,selfLink,zone,creationTimestamp,labels,disks(boot,autoDelete,source)",
    "kind,id,name,selfLink,zone,creationTimestamp,users"];
  for (const [i, call] of f.calls.entries()) {
    assert.equal(call.options.method, "GET"); assert.equal(Object.hasOwn(call.options, "body"), false);
    assert.equal(call.options.redirect, "error"); assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.cache, "no-store"); assert.equal(call.options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(call.options.signal instanceof AbortSignal);
    if (i) {
      assert.equal(call.options.headers["X-Goog-User-Project"], "project-32bf49a2-bd30-4956-850");
      assert.deepEqual([...new URL(call.url).searchParams.keys()], ["fields"]);
      assert.equal(new URL(call.url).searchParams.get("fields"), projections[i - 1]);
    }
  }
  assert.equal(out.kind, "api_migrator_gcp_ownership_observation");
  assert.equal(out.account, ACCOUNT); assert.equal(out.observedAt, f.nowMs); assert.equal(out.completedAt, f.nowMs);
  assert.deepEqual(Object.keys(out.handoff).sort(), ["ownership", "plan"]);
  assert.deepEqual(out.handoff.plan, f.plan);
  const bound = validateTrialOwnership(JSON.stringify(out.handoff.plan), JSON.stringify(out.handoff.ownership), { nowMs: f.nowMs });
  assert.equal(bound.ownership.instanceId, "18446744073709551614");
  assert.equal(bound.ownership.diskId, "18446744073709551613"); assert.equal(bound.ownership.operationId, "123");
  assert.equal(bound.ownership.capturedAt, f.nowMs); assert.equal(bound.ownership.planDigest, f.plan.planDigest);
  for (const key of ["executionBlocked", "activationBlocked"]) assert.equal(out[key], true);
  for (const key of ["cloudVerified", "releaseEvidenceEligible", "evidenceAuthenticityVerified"]) assert.equal(out[key], false);
  assert.equal(JSON.stringify(out).includes(TOKEN), false);
  assert.equal(Object.hasOwn(out, "operation"), false); assert.equal(Object.hasOwn(out, "instance"), false);
});

for (const operationName of [undefined, null, "", "../operation", "a/b", "a?fields=x", "a#fragment", "a%2Fb", "a\\b", ".", "..", "a b", "é", "x".repeat(257)]) {
  test(`rejects unsafe operation segment before any request (${String(operationName).length})`, async () => {
    const f = ownershipReadFixture(); f.operationName = operationName;
    await assert.rejects(collect(f), { message: "GCP ownership observation failed" }); assert.equal(f.calls.length, 0);
  });
}
for (const [name, mutate] of [
  ["altered plan command", f => { f.plan.commands.create.push("--service-account=other"); }],
  ["changed plan deadline", f => { f.plan.deleteAt++; }],
  ["foreign project", f => { f.plan.projectId = "professional"; }],
  ["future plan", f => { f.nowMs = f.plan.issuedAt - 1; }],
  ["expired plan", f => { f.nowMs = f.plan.deleteAt; }],
  ["invalid clock", f => { f.nowMs = NaN; }],
]) test(`rejects ${name} before identity or Compute`, async () => {
  const f = ownershipReadFixture(); mutate(f);
  await assert.rejects(collect(f), { message: "GCP ownership observation failed" }); assert.equal(f.calls.length, 0);
});
for (const input of ["not JSON", " ".repeat(32769), "null", "[]", "{}"])
  test(`rejects malformed or bounded input (${input.length}) without requests`, async () => {
    const f = ownershipReadFixture();
    await assert.rejects(collectTrialOwnership(input, TOKEN, { expectedAccount: ACCOUNT, fetchImpl: f.fetchImpl }),
      { message: "GCP ownership observation failed" }); assert.equal(f.calls.length, 0);
  });
test("rejects extra input fields rather than accepting a URL override", async () => {
  const f = ownershipReadFixture();
  await assert.rejects(collect(f, {}, { plan: f.plan, operationName: OPERATION, url: "https://example.com/" }), /ownership observation failed/);
  assert.equal(f.calls.length, 0);
});
for (const expectedAccount of [undefined, "", "not-email", "owner@example.com\nInjected", "x".repeat(255) + "@example.com", "service@p.iam.gserviceaccount.com"])
  test(`rejects invalid account without requests (${String(expectedAccount).length})`, async () => {
    const f = ownershipReadFixture(); await assert.rejects(collect(f, { expectedAccount }), /ownership observation failed/); assert.equal(f.calls.length, 0);
  });
for (const token of ["", "x", TOKEN + "\nsecond", "x".repeat(4097)]) test(`rejects credential format before requests (${token.length})`, async () => {
  const f = ownershipReadFixture();
  await assert.rejects(collectTrialOwnership(JSON.stringify({ plan: f.plan, operationName: OPERATION }), token,
    { expectedAccount: ACCOUNT, fetchImpl: f.fetchImpl, now: () => f.nowMs }), /ownership observation failed/);
  assert.equal(f.calls.length, 0);
});
for (const identity of [{ email: "professional@example.com", email_verified: true }, { email: ACCOUNT },
  { email: ACCOUNT, email_verified: false }, { email: ACCOUNT.toUpperCase(), email_verified: true },
  { email: ACCOUNT, email_verified: true, error: TOKEN }, { email: ACCOUNT, email_verified: true, access_token: TOKEN }])
  test(`rejects identity mismatch or unexpected claims before Compute (${JSON.stringify(identity)})`, async () => {
    const f = ownershipReadFixture(); f.identity = identity;
    await assert.rejects(collect(f), { message: "GCP ownership observation failed" }); assert.equal(f.calls.length, 1);
  });

// Catches accepting a completed operation for another resource or generation,
// bypassing narrow ownership projections, or adopting extra attachments.
for (const [name, mutate] of [
  ["pending insert", f => { f.operation.status = "RUNNING"; }],
  ["non-insert operation", f => { f.operation.operationType = "delete"; }],
  ["operation error", f => { f.operation.error = {}; }],
  ["operation warning", f => { f.operation.warnings = []; }],
  ["operation HTTP error", f => { f.operation.httpErrorStatusCode = 0; }],
  ["operation HTTP message", f => { f.operation.httpErrorMessage = ""; }],
  ["wrong operation kind", f => { f.operation.kind = "compute#instance"; }],
  ["wrong operation name", f => { f.operation.name = "other"; }],
  ["wrong operation link", f => { f.operation.selfLink = `${BASE}/operations/other`; }],
  ["operation in other zone", f => { f.operation.zone = BASE.replace("us-central1-a", "us-central1-b"); }],
  ["wrong target link", f => { f.operation.targetLink = `${BASE}/instances/other`; }],
  ["same name replacement generation", f => { f.instance.id = "987"; }],
  ["numeric VM id", f => { f.instance.id = 123; f.operation.targetId = 123; }],
  ["overflow disk id", f => { f.disk.id = "18446744073709551616"; }],
  ["wrong VM kind", f => { f.instance.kind = "compute#disk"; }],
  ["wrong disk kind", f => { f.disk.kind = "compute#instance"; }],
  ["foreign VM selfLink", f => { f.instance.selfLink = f.instance.selfLink.replace("project-32bf49a2-bd30-4956-850", "other"); }],
  ["foreign disk zone", f => { f.disk.zone = BASE.replace("us-central1-a", "us-central1-b"); }],
  ["wrong nonce", f => { f.instance.labels["api-migrator-trial"] = "f".repeat(32); }],
  ["non-string label", f => { f.instance.labels.extra = 1; }],
  ["missing boot disk", f => { f.instance.disks = []; }],
  ["extra attached disk", f => { f.instance.disks.push({ boot: false, autoDelete: true, source: `${BASE}/disks/other` }); }],
  ["extra attachment field", f => { f.instance.disks[0].diskEncryptionKey = TOKEN; }],
  ["not autoDelete", f => { f.instance.disks[0].autoDelete = false; }],
  ["other disk source", f => { f.instance.disks[0].source = `${BASE}/disks/other`; }],
  ["missing disk", f => { f.disk = {}; }],
  ["foreign disk user", f => { f.disk.users = [`${BASE}/instances/other`]; }],
  ["additional disk user", f => { f.disk.users.push(`${BASE}/instances/other`); }],
  ["startup metadata", f => { f.instance.metadata = { items: [{ key: "startup-script", value: TOKEN }] }; }],
  ["disk encryption field", f => { f.disk.diskEncryptionKey = { rawKey: TOKEN }; }],
  ["unexpected operation field", f => { f.operation.user = ACCOUNT; }],
  ["creation before original plan", f => { f.instance.creationTimestamp = new Date(f.plan.issuedAt - 1).toISOString(); }],
  ["creation beyond original window", f => { f.instance.creationTimestamp = new Date(f.plan.createBefore + 1).toISOString(); f.nowMs = f.plan.createBefore + 1000; }],
  ["disk creation beyond original window", f => { f.disk.creationTimestamp = new Date(f.plan.createBefore + 1).toISOString(); f.nowMs = f.plan.createBefore + 1000; }],
  ["future creation", f => { f.disk.creationTimestamp = new Date(f.nowMs + 1).toISOString(); }],
]) test(`fails closed on ${name} without a partial record or sensitive error`, async () => {
  const f = ownershipReadFixture(); mutate(f);
  await assert.rejects(collect(f), { message: "GCP ownership observation failed" });
});
test("captures a matching replacement only when operation target generation also matches", async () => {
  const f = ownershipReadFixture(); f.instance.id = "987"; f.operation.targetId = "987"; f.disk.id = "988";
  const out = await collect(f); assert.equal(out.handoff.ownership.instanceId, "987"); assert.equal(out.handoff.ownership.diskId, "988");
});
test("can capture a completed creation after the creation window but before the immutable delete deadline", async () => {
  const f = ownershipReadFixture(); f.nowMs = f.plan.createBefore + 1000;
  assert.equal((await collect(f)).handoff.ownership.capturedAt, f.nowMs);
});

for (const [name, response] of [
  ["HTTP error", () => new Response(TOKEN, { status: 403 })],
  ["redirect", () => new Response(null, { status: 302, headers: { location: "https://example.com/" } })],
  ["already redirected success", () => { const r = Response.json({ email: ACCOUNT, email_verified: true }); Object.defineProperty(r, "redirected", { value: true }); return r; }],
  ["oversized stream", () => new Response(" ".repeat(262145) + JSON.stringify({ email: ACCOUNT, email_verified: true }))],
  ["invalid UTF-8", () => new Response(Buffer.concat([Buffer.from('{"sub":"'), Buffer.from([0xff]), Buffer.from(`","email":"${ACCOUNT}","email_verified":true}`)]))],
  ["malformed JSON", () => new Response("invalid " + TOKEN)],
  ["non-object JSON", () => Response.json([])],
  ["transport error", () => { throw new Error(TOKEN); }],
]) test(`sanitizes ${name} and never returns a partial record`, async () => {
  const f = ownershipReadFixture();
  let requests = 0;
  await assert.rejects(collect(f, { fetchImpl: (...args) => ++requests === 1 ? response() : f.fetchImpl(...args) }),
    { message: "GCP ownership observation failed" });
  assert.equal(requests, 1);
});
test("enforces cumulative byte bound across individually bounded responses", async () => {
  const f = ownershipReadFixture(), transport = f.fetchImpl;
  await assert.rejects(collect(f, { fetchImpl: async (...args) => {
    const response = await transport(...args); return new Response(" ".repeat(80_000) + await response.text());
  } }), { message: "GCP ownership observation failed" });
});
test("accepts exactly the cumulative byte boundary without discarding content", async () => {
  const f = ownershipReadFixture(), transport = f.fetchImpl;
  const rawLength = [f.identity, f.operation, f.instance, f.disk].reduce((sum, v) => sum + Buffer.byteLength(JSON.stringify(v)), 0);
  const out = await collect(f, { fetchImpl: async (...args) => {
    const r = await transport(...args), text = await r.text();
    return new Response((args[0] === USERINFO ? " ".repeat(262144 - rawLength) : "") + text);
  } });
  assert.equal(out.handoff.ownership.instanceId, "18446744073709551614");
});
test("cancels an oversized streaming response before any later chunk is read", async () => {
  const f = ownershipReadFixture(); let cancelled = false;
  await boundedFailure(collect(f, { timeoutMs: 20, fetchImpl: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(262145)); }, cancel() { cancelled = true; },
  })) }));
  assert.equal(cancelled, true);
});

for (const [name, drift] of [["clock rollback", -1], ["20-second clock overrun", 20001]]) test(`rejects ${name}`, async () => {
  const f = ownershipReadFixture(), transport = f.fetchImpl; let at = f.nowMs;
  await assert.rejects(collect(f, { now: () => at, fetchImpl: (...args) => { if (!f.calls.length) at += drift; return transport(...args); } }),
    { message: "GCP ownership observation failed" });
  assert.equal(f.calls.length, 1);
});
test("uses earliest read for capture instead of laundering freshness at completion", async () => {
  const f = ownershipReadFixture(), transport = f.fetchImpl; let at = f.nowMs;
  const out = await collect(f, { now: () => at, fetchImpl: (...args) => { at += 5000; return transport(...args); } });
  assert.equal(out.observedAt, f.nowMs); assert.equal(out.handoff.ownership.capturedAt, f.nowMs);
  assert.equal(out.completedAt, f.nowMs + 20000);
});
test("rejects creation after earliest read even if it predates completion", async () => {
  const f = ownershipReadFixture(), transport = f.fetchImpl; let at = f.nowMs;
  f.instance.creationTimestamp = new Date(f.nowMs + 1).toISOString();
  await assert.rejects(collect(f, { now: () => at, fetchImpl: (...args) => { at += 100; return transport(...args); } }), /ownership observation failed/);
});
for (const remaining of [8, 7]) test(`rejects read completion reaching or crossing immutable deadline (${remaining}ms)`, async () => {
  const f = ownershipReadFixture(), transport = f.fetchImpl; let at = f.plan.deleteAt - remaining;
  await assert.rejects(collect(f, { now: () => at, fetchImpl: (...args) => { at += 2; return transport(...args); } }), /ownership observation failed/);
});
test("accepts final completion just before immutable deadline", async () => {
  const f = ownershipReadFixture(), transport = f.fetchImpl; let at = f.plan.deleteAt - 9;
  const out = await collect(f, { now: () => at, fetchImpl: (...args) => { at += 2; return transport(...args); } });
  assert.equal(out.completedAt, f.plan.deleteAt - 1);
});
test("rejects clock deadline crossing after validation rather than emitting a success", async () => {
  const f = ownershipReadFixture(); let ticks = 0;
  // The final clock access is forced over the deadline after all four bodies.
  const transport = f.fetchImpl; let complete = false;
  await assert.rejects(collect(f, { now: () => complete && ++ticks > 2 ? f.plan.deleteAt : f.plan.deleteAt - 1,
    fetchImpl: async (...args) => { const r = await transport(...args); if (f.calls.length === 4) complete = true; return r; } }), /ownership observation failed/);
});
for (const timeoutMs of [0, -1, 20001, 1.5, NaN]) test(`rejects invalid timeout before requests (${timeoutMs})`, async () => {
  const f = ownershipReadFixture(); await assert.rejects(collect(f, { timeoutMs }), /ownership observation failed/); assert.equal(f.calls.length, 0);
});
async function boundedFailure(promise) {
  let timer;
  try {
    const result = await Promise.race([promise.then(() => "accepted", e => e.message),
      new Promise(resolve => { timer = setTimeout(() => resolve("collector never timed out"), 200); })]);
    assert.equal(result, "GCP ownership observation failed");
  } finally { clearTimeout(timer); }
}
test("times out a transport ignoring abort and aborts its signal", async () => {
  const f = ownershipReadFixture(); let signal;
  await boundedFailure(collect(f, { timeoutMs: 20, fetchImpl: (_, options) => { signal = options.signal; return new Promise(() => {}); } }));
  assert.equal(signal.aborted, true);
});
test("times out a stalled successful body and cancels its reader", async () => {
  const f = ownershipReadFixture(); let cancelled = false;
  await boundedFailure(collect(f, { timeoutMs: 20, fetchImpl: () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) }));
  assert.equal(cancelled, true);
});
test("rejects denied HTTP response without waiting for its stalled error body", async () => {
  const f = ownershipReadFixture(); let cancelled = false;
  await boundedFailure(collect(f, { fetchImpl: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 }) }));
  assert.equal(cancelled, true);
});
