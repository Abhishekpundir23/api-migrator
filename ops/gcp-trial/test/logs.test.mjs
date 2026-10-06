import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { collectTrialLogs } from "../logs.mjs";
import { resultFixture } from "./result-fixture.mjs";

const ACCOUNT = "owner@example.com", TOKEN = "fixture-not-a-real-access-token";
const ENDPOINT = "https://logging.googleapis.com/v2/entries:list";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const json = JSON.stringify, hash = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function fixture({ pages, identity = { email: ACCOUNT, email_verified: true }, alter } = {}) {
  const f = resultFixture(), calls = [], queue = pages ?? [{ entries: [f.entry] }];
  return { ...f, calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const replaced = alter?.(url, options); if (replaced) return replaced;
    if (url === USERINFO) return Response.json(identity);
    assert.equal(url, ENDPOINT, "no other API is allowed");
    assert.ok(queue.length, "unexpected extra request");
    return Response.json(queue.shift());
  } };
}
const collect = (f, options = {}) => collectTrialLogs(json(f.plan), json(f.ownership), TOKEN,
  { expectedAccount: ACCOUNT, fetchImpl: f.fetchImpl, now: () => f.nowMs, ...options });

test("authenticates before the exact bounded Logging read and returns only a non-authoritative summary", async () => {
  const f = fixture(), out = await collect(f);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, USERINFO); assert.equal(f.calls[0].options.method, "GET");
  assert.equal(Object.hasOwn(f.calls[0].options.headers, "X-Goog-User-Project"), false);
  const request = f.calls[1].options, body = JSON.parse(request.body);
  assert.equal(request.method, "POST"); assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers["X-Goog-User-Project"], "project-32bf49a2-bd30-4956-850");
  assert.deepEqual(body, { resourceNames: ["projects/project-32bf49a2-bd30-4956-850"],
    filter: 'resource.type="gce_instance" AND resource.labels.project_id="project-32bf49a2-bd30-4956-850" AND resource.labels.zone="us-central1-a" AND resource.labels.instance_id="18446744073709551614" AND logName="projects/project-32bf49a2-bd30-4956-850/logs/serialconsole.googleapis.com%2Fserial_port_1_output" AND timestamp>="2033-05-18T03:33:20.000Z" AND timestamp<="2033-05-18T03:33:24.000Z"',
    orderBy: "timestamp desc", pageSize: 100 });
  for (const call of f.calls) {
    assert.equal(call.options.redirect, "error"); assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.cache, "no-store"); assert.equal(call.options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.equal(out.result.status, "reported_passed"); assert.equal(out.completedAt, f.nowMs);
  assert.equal(out.entryCount, 1); assert.deepEqual(out.pageDigests, [hash(json({ entries: [f.entry] }))]);
  assert.equal(out.queryDigest, hash(request.body));
  for (const key of ["executionBlocked", "activationBlocked"]) assert.equal(out[key], true);
  for (const key of ["cloudVerified", "evidenceAuthenticityVerified", "cleanupVerified", "releaseEvidenceEligible"]) {
    assert.equal(out[key], false); assert.equal(out.result[key], false);
  }
  for (const secret of [TOKEN, f.entry.textPayload, ACCOUNT, "pageToken"]) assert.equal(json(out).includes(secret), false);
});

test("continues an empty search page and freezes scope and cutoff across opaque pagination", async () => {
  const entry = resultFixture().entry;
  let at = resultFixture().nowMs;
  const f = fixture({ pages: [{ nextPageToken: "opaque+/=&?" }, { entries: [entry] }], alter: () => { at += 100; } });
  const out = await collect(f, { now: () => at });
  assert.equal(out.result.status, "reported_passed"); assert.equal(out.pageDigests.length, 2);
  assert.equal(out.startedAt, f.nowMs); assert.equal(out.completedAt, f.nowMs + 300);
  const first = JSON.parse(f.calls[1].options.body), second = JSON.parse(f.calls[2].options.body);
  assert.deepEqual(second, { ...first, pageToken: "opaque+/=&?" });
  assert.ok(first.filter.endsWith('timestamp<="2033-05-18T03:33:24.000Z"'));
});
test("empty complete collection is incomplete evidence rather than a pass", async () => {
  const out = await collect(fixture({ pages: [{}] }));
  assert.equal(out.result.status, "incomplete"); assert.equal(out.result.reason, "terminal_missing");
});
test("post-deletion collection never extends the event cutoff or proves retention", async () => {
  const f = fixture(); f.nowMs = f.plan.deleteAt + 1000;
  const out = await collect(f);
  assert.equal(out.result.status, "reported_passed"); assert.equal(out.cleanupVerified, false);
  assert.ok(JSON.parse(f.calls[1].options.body).filter.endsWith('timestamp<="2033-05-18T04:33:20.000Z"'));
});
test("does not accept an event beyond the frozen query cutoff even when retrieval finishes later", async () => {
  const entry = resultFixture().entry;
  entry.timestamp = "2033-05-18T03:33:24.000000001Z"; entry.receiveTimestamp = "2033-05-18T03:33:24.100Z";
  let at = resultFixture().nowMs;
  const f = fixture({ pages: [{ entries: [entry] }], alter: () => { at += 100; } });
  await assert.rejects(collect(f, { now: () => at }), /log observation failed/);
});
test("does not report pass at exactly the conservative 1000-entry bound", async () => {
  const f = resultFixture(), entries = Array.from({ length: 1000 }, (_, i) => ({ ...f.entry, textPayload: i ? "boot" : f.entry.textPayload }));
  const out = await collect(fixture({ pages: [{ entries }] }));
  assert.equal(out.result.status, "incomplete"); assert.equal(out.result.reason, "entry_limit_reached");
});
test("rejects continuation at the entry bound rather than dropping unseen entries", async () => {
  const entries = Array(1000).fill({ ...resultFixture().entry, textPayload: "boot" });
  await assert.rejects(collect(fixture({ pages: [{ entries, nextPageToken: "more" }] })), /log observation failed/);
});
for (const [name, text, reason] of [
  ["duplicate", f => f.entry.textPayload, "terminal_ambiguous"],
  ["fragment", () => "API_MIGRATOR_TRIAL_RES", "terminal_fragment"],
]) test(`does not hide ${name} evidence on a later page`, async () => {
  const data = resultFixture();
  const f = fixture({ pages: [{ entries: [data.entry], nextPageToken: "next" },
    { entries: [{ ...data.entry, textPayload: text(data) }] }] });
  const out = await collect(f); assert.equal(out.result.status, "incomplete"); assert.equal(out.result.reason, reason);
});
for (const identity of [{ email: "professional@example.com", email_verified: true }, { email: ACCOUNT },
  { email: ACCOUNT, email_verified: false }, { email: "service@p.iam.gserviceaccount.com", email_verified: true },
  { email: ACCOUNT, email_verified: true, error: TOKEN }]) {
  test(`rejects unapproved identity ${json(identity)}`, async () => {
    const f = fixture({ identity });
    await assert.rejects(collect(f), { message: "GCP log observation failed" });
    assert.equal(f.calls.length, 1);
  });
}
for (const expectedAccount of [undefined, "", "not-email", "owner@example.com\nInjected", "x".repeat(255) + "@example.com",
  "service@p.iam.gserviceaccount.com"]) test(`rejects invalid account before network (${String(expectedAccount).length})`, async () => {
  const f = fixture(); await assert.rejects(collect(f, { expectedAccount }), /log observation failed/); assert.equal(f.calls.length, 0);
});
for (const token of ["", "x", TOKEN + "\nsecond", "x".repeat(4097)]) test(`rejects invalid token (${token.length})`, async () => {
  const f = fixture();
  await assert.rejects(collectTrialLogs(json(f.plan), json(f.ownership), token, { expectedAccount: ACCOUNT, fetchImpl: f.fetchImpl }), /log observation failed/);
  assert.equal(f.calls.length, 0);
});
for (const [name, mutate] of [
  ["changed plan", f => { f.plan.commands.create.push("--service-account=other"); }],
  ["changed VM", f => { f.ownership.instanceId = "1"; }],
  ["future ownership", f => { f.nowMs = f.plan.issuedAt; }],
]) test(`rejects ${name} before network`, async () => {
  const f = fixture(); mutate(f); await assert.rejects(collect(f), /log observation failed/); assert.equal(f.calls.length, 0);
});
for (const [name, pages] of [
  ["API warning", [{ warning: TOKEN }]], ["API error", [{ error: TOKEN }]],
  ["unknown response fields", [{ private: TOKEN }]], ["non-array entries", [{ entries: {} }]],
  ["token loop", [{ nextPageToken: "same" }, { nextPageToken: "same" }]],
  ["token not a string", [{ nextPageToken: 1 }]], ["oversized token", [{ nextPageToken: "x".repeat(2049) }]],
  ["null token", [{ nextPageToken: null }]],
  ["page cap", Array.from({ length: 20 }, (_, i) => ({ nextPageToken: String(i) }))],
  ["entry cap", [{ entries: Array(1001).fill(resultFixture().entry) }]],
  ["foreign VM on later page", [{ entries: [resultFixture().entry], nextPageToken: "x" }, { entries: [{ ...resultFixture().entry,
    resource: { type: "gce_instance", labels: { project_id: "professional" } } }] }]],
]) test(`rejects ${name} without returning partial success or server data`, async () => {
  await assert.rejects(collect(fixture({ pages })), { message: "GCP log observation failed" });
});
test("does not stop at a terminal marker before fetching a denied later page", async () => {
  let reads = 0;
  const f = fixture({ pages: [{ entries: [resultFixture().entry], nextPageToken: "next" }], alter: url => {
    if (url === ENDPOINT && ++reads === 2) return new Response(TOKEN, { status: 403 });
  } });
  await assert.rejects(collect(f), { message: "GCP log observation failed" }); assert.equal(reads, 2);
});
for (const [name, alter] of [
  ["HTTP error", () => new Response(TOKEN, { status: 403 })],
  ["redirect", () => new Response(null, { status: 302, headers: { location: "https://example.com/" } })],
  ["oversized stream", () => new Response("x".repeat(1_048_577))],
  ["invalid UTF-8", () => new Response(new Uint8Array([0xff, 0xfe]))],
  ["malformed JSON", () => new Response("not JSON " + TOKEN)],
  ["transport error", () => { throw new Error(TOKEN); }],
]) test(`sanitizes ${name}`, async () => {
  await assert.rejects(collect(fixture({ alter })), { message: "GCP log observation failed" });
});
test("enforces cumulative bytes across individually small responses", async () => {
  const boot = { ...resultFixture().entry, textPayload: "boot".repeat(100_000) };
  const f = fixture({ pages: [{ entries: [boot], nextPageToken: "a" }, { entries: [boot], nextPageToken: "b" }, { entries: [boot] }] });
  await assert.rejects(collect(f), /log observation failed/);
});
for (const drift of [-1, 20_001]) test(`rejects clock drift ${drift}`, async () => {
  let at = resultFixture().nowMs;
  const f = fixture({ alter: () => { at += drift; } });
  await assert.rejects(collect(f, { now: () => at }), /log observation failed/);
});
test("times out stalled requests even when a transport ignores abort", async () => {
  const f = fixture(); let signal;
  await assert.rejects(collect(f, { timeoutMs: 20, fetchImpl: (_, opts) => { signal = opts.signal; return new Promise(() => {}); } }), /log observation failed/);
  assert.equal(signal.aborted, true);
});
test("times out a response body that never finishes", async () => {
  let cancelled = false;
  const f = fixture({ alter: () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  await assert.rejects(collect(f, { timeoutMs: 20 }), /log observation failed/);
  assert.equal(cancelled, true);
});
