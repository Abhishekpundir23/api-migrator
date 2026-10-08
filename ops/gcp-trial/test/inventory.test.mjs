import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { collectTrialInventory as collect, readAccessToken } from "../inventory.mjs";

const PROJECT = "project-32bf49a2-bd30-4956-850", ZONE = "us-central1-a";
const BASE = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}`;
const ACCOUNT = "owner@example.com", TOKEN = "fixture-not-a-real-access-token";
const collectTrialInventory = (token, options = {}) => collect(token, { expectedAccount: ACCOUNT, ...options });
const NOW = 1_800_000_000_000;
const user = () => ({ email: ACCOUNT, email_verified: true, sub: "fixture-user" });
const page = (kind, items = [], extra = {}) => ({ kind: kind === "instances" ? "compute#instanceList" : "compute#diskList",
  selfLink: `${BASE}/${kind}`, items, ...extra });
const resource = (kind, name, id) => ({ id, name, zone: BASE, selfLink: `${BASE}/${kind}/${name}`,
  creationTimestamp: new Date(NOW - 1000).toISOString(), ...(kind === "disks" ? { users: [] } : { disks: [] }) });
function fixture({ identity = user(), instances = [page("instances")], disks = [page("disks")], alter } = {}) {
  const calls = [], queues = { instances: [...instances], disks: [...disks] };
  const fetchImpl = async (url, options) => {
    const u = new URL(url); calls.push({ url: u, options });
    if (alter) { const response = alter(u, options); if (response) return response; }
    if (u.href === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json(identity);
    const kind = u.pathname.split("/").at(-1);
    assert.ok(["instances", "disks"].includes(kind), "collector must not request another API");
    const next = queues[kind].shift(); assert.ok(next, "unexpected extra request");
    return Response.json(next);
  };
  return { calls, fetchImpl };
}

test("collects authenticated unfiltered inventories without granting execution authority", async () => {
  const f = fixture();
  const out = await collectTrialInventory(TOKEN, { fetchImpl: f.fetchImpl, now: () => NOW });
  assert.equal(out.account, ACCOUNT); assert.equal(out.completedAt, NOW);
  assert.equal(out.executionBlocked, true); assert.equal(out.activationBlocked, true); assert.equal(out.cloudVerified, false);
  assert.deepEqual(out.inventory, { projectId: PROJECT, zone: ZONE, observedAt: NOW, filter: "",
    instances: [{ pageToken: "", response: page("instances") }], disks: [{ pageToken: "", response: page("disks") }] });
  assert.equal(f.calls.length, 3);
  for (const { url, options } of f.calls) {
    assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.body, undefined);
    if (url.hostname === "www.googleapis.com") {
      assert.equal(options.headers["X-Goog-User-Project"], PROJECT);
      assert.ok(url.href.startsWith(BASE + "/")); assert.equal(url.searchParams.has("filter"), false);
      assert.equal(url.searchParams.get("maxResults"), "100");
      assert.ok(url.searchParams.get("fields").includes("nextPageToken"));
      assert.ok(url.searchParams.get("fields").includes("warning"), "partial response must not hide API warnings");
      assert.equal(url.searchParams.get("fields").includes("metadata"), false);
    }
  }
  assert.equal(JSON.stringify(out).includes(TOKEN), false);
});

test("authenticates UserInfo without a quota header while retaining explicit Compute quota scope", async () => {
  const f = fixture({ alter: (url, options) => {
    if (url.hostname === "openidconnect.googleapis.com" && Object.hasOwn(options.headers, "X-Goog-User-Project")) {
      return Response.json({ error: { code: 403, status: "PERMISSION_DENIED",
        details: [{ reason: "USER_PROJECT_DENIED", domain: "googleapis.com" }] } }, { status: 403 });
    }
  } });
  const out = await collectTrialInventory(TOKEN, { fetchImpl: f.fetchImpl, now: () => NOW });
  assert.equal(out.account, ACCOUNT);
  assert.equal(Object.hasOwn(f.calls[0].options.headers, "X-Goog-User-Project"), false);
  assert.equal(f.calls.length, 3);
  for (const call of f.calls.slice(1)) assert.equal(call.options.headers["X-Goog-User-Project"], PROJECT);
});

test("follows opaque page tokens and preserves uint64 IDs losslessly", async () => {
  const vm = resource("instances", "fixture-vm", "18446744073709551615");
  const f = fixture({ instances: [page("instances", [vm], { nextPageToken: "opaque+/=&?" }), page("instances")] });
  const out = await collectTrialInventory(TOKEN, { fetchImpl: f.fetchImpl, now: () => NOW });
  assert.equal(out.inventory.instances[1].pageToken, "opaque+/=&?");
  assert.equal(f.calls[2].url.searchParams.get("pageToken"), "opaque+/=&?");
  assert.equal(out.inventory.instances[0].response.items[0].id, "18446744073709551615");
});

for (const identity of [{ email: "work@example.com", email_verified: true }, { email: ACCOUNT },
  { email: ACCOUNT, email_verified: false }, { email: "service@project.iam.gserviceaccount.com", email_verified: true }]) {
  test(`refuses unapproved principal ${identity.email} verified=${identity.email_verified}`, async () => {
    const f = fixture({ identity });
    await assert.rejects(collectTrialInventory(TOKEN, { fetchImpl: f.fetchImpl, now: () => NOW }), /observation failed/);
    assert.equal(f.calls.length, 1, "wrong identity must not reach Compute API");
  });
}

const vm = () => resource("instances", "fixture-vm", "12345678901234567890");
for (const [name, pages] of [
  ["wrong project", [page("instances", [{ ...vm(), zone: BASE.replace(PROJECT, "professional-project") }])]],
  ["wrong list scope", [{ ...page("instances"), selfLink: BASE + "/disks" }]],
  ["wrong kind", [{ ...page("instances"), kind: "compute#diskList" }]],
  ["rounded numeric ID", [page("instances", [{ ...vm(), id: 12345678901234567890 }])]],
  ["duplicate generation", [page("instances", [vm(), vm()])]],
  ["error response", [page("instances", [], { error: { message: TOKEN } })]],
  ["warning response", [page("instances", [], { warning: { code: "NO_RESULTS_ON_PAGE" } })]],
  ["malformed response", [{}]],
  ["unrequested instance metadata", [page("instances", [{ ...vm(), metadata: { items: [{ key: "credential", value: TOKEN }] } }])]],
  ["unrequested top-level data", [page("instances", [], { internalData: TOKEN })]],
  ...["boot", "autoDelete", "source"].map(key => [`nested attachment ${key}`, [page("instances", [{ ...vm(),
    disks: [{ boot: true, autoDelete: true, source: `${BASE}/disks/fixture-vm`, [key]: { credential: TOKEN } }] }])]]),
  ["foreign attachment reference", [page("instances", [{ ...vm(), disks: [{ source: "https://example.com/disks/foreign" }] }])]],
  ["nested labels", [page("instances", [{ ...vm(), labels: { private: { credential: TOKEN } } }])]],
  ["page loop", [page("instances", [], { nextPageToken: "x" }), page("instances", [], { nextPageToken: "x" })]],
  ["too many pages", Array.from({ length: 20 }, (_, i) => page("instances", [], { nextPageToken: String(i) }))],
  ["oversized token", [page("instances", [], { nextPageToken: "x".repeat(2049) })]],
  ["null continuation token", [page("instances", [], { nextPageToken: null })]],
  ["oversized inventory", [page("instances", Array.from({ length: 1001 }, (_, i) => resource("instances", `vm-${i}`, String(i + 1))))]],
]) {
  test(`refuses ${name} without echoing server data`, async () => {
    const f = fixture({ instances: pages });
    await assert.rejects(collectTrialInventory(TOKEN, { fetchImpl: f.fetchImpl, now: () => NOW }), error => {
      assert.equal(error.message, "GCP inventory observation failed"); assert.equal(error.message.includes(TOKEN), false); return true;
    });
  });
}

for (const [name, alter] of [
  ["HTTP denial", () => new Response(TOKEN, { status: 403 })],
  ["redirect", () => new Response(null, { status: 302, headers: { location: "https://example.com/" } })],
  ["oversized streamed body", () => new Response("x".repeat(262145))],
  ["non-JSON body", () => new Response("not JSON " + TOKEN)],
  ["transport exception", () => { throw new Error(TOKEN); }],
]) test(`refuses ${name} and never leaks the credential`, async () => {
  const f = fixture({ alter });
  await assert.rejects(collectTrialInventory(TOKEN, { fetchImpl: f.fetchImpl, now: () => NOW }), { message: "GCP inventory observation failed" });
});

test("inventory uses the oldest observation time rather than relabeling old pages as fresh", async () => {
  let at = NOW;
  const f = fixture({ alter: () => { at += 1000; } });
  const out = await collectTrialInventory(TOKEN, { fetchImpl: f.fetchImpl, now: () => at });
  assert.equal(out.inventory.observedAt, NOW); assert.equal(out.completedAt, NOW + 3000);
});
test("accepts a valid empty Google list with the items field omitted", async () => {
  const empty = { kind: "compute#instanceList", selfLink: `${BASE}/instances` };
  const f = fixture({ instances: [empty] });
  const out = await collectTrialInventory(TOKEN, { fetchImpl: f.fetchImpl, now: () => NOW });
  assert.deepEqual(out.inventory.instances[0].response, empty);
});
for (const drift of [-1, 30_001]) test(`refuses clock drift ${drift}`, async () => {
  let at = NOW;
  const f = fixture({ alter: () => { at += drift; } });
  await assert.rejects(collectTrialInventory(TOKEN, { fetchImpl: f.fetchImpl, now: () => at }), /observation failed/);
});
test("aborts a stalled authenticated request", async () => {
  let aborted = false;
  const fetchImpl = (_, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => {
    aborted = true; reject(new Error(TOKEN));
  }, { once: true }));
  await assert.rejects(collectTrialInventory(TOKEN, { fetchImpl, timeoutMs: 20 }), /observation failed/);
  assert.equal(aborted, true);
});

test("token reader accepts one bounded stdin credential without a file", async () => {
  assert.equal(await readAccessToken(Readable.from([TOKEN.slice(0, 10), TOKEN.slice(10) + "\n"])), TOKEN);
});
for (const expectedAccount of [undefined, "", "not-an-email", "owner@example.com\nInjected: x", "x".repeat(255) + "@example.com",
  "runner@project.iam.gserviceaccount.com"]) test(`refuses missing or invalid expected account ${String(expectedAccount).length}`, async () => {
  const f = fixture();
  await assert.rejects(collect(TOKEN, { expectedAccount, fetchImpl: f.fetchImpl }), /observation failed/);
  assert.equal(f.calls.length, 0);
});
test("requires an explicitly supplied verified account without baking the operator's email into code", async () => {
  const email = "another-owner@example.com", f = fixture({ identity: { email, email_verified: true } });
  const out = await collect(TOKEN, { expectedAccount: email, fetchImpl: f.fetchImpl, now: () => NOW });
  assert.equal(out.account, email); assert.equal(out.inventory.projectId, PROJECT);
});
for (const token of ["", "x", TOKEN + "\nsecond", "x".repeat(4097), TOKEN + "\r\nInjected: yes"]) {
  test(`refuses invalid stdin token length ${token.length}`, async () => {
    await assert.rejects(readAccessToken(Readable.from([token])), /invalid credential input/);
  });
}
test("token reader bounds waiting for EOF", async () => {
  const stream = new Readable({ read() {} });
  await assert.rejects(readAccessToken(stream, { timeoutMs: 20 }), /invalid credential input/);
  assert.equal(stream.destroyed, true);
});
test("CLI rejects flags and credential arguments with sanitized diagnostics", () => {
  const result = spawnSync(process.execPath, ["ops/gcp-trial/collect-inventory.mjs", "--execute", TOKEN], { encoding: "utf8", input: TOKEN });
  assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.match(result.stderr, /read-only/);
  assert.equal(result.stderr.includes(TOKEN), false);
});
test("CLI refuses malformed stdin before any network call", () => {
  const result = spawnSync(process.execPath, ["ops/gcp-trial/collect-inventory.mjs", "--read-only", "--token-stdin", `--expected-account=${ACCOUNT}`], { encoding: "utf8", input: "", timeout: 1000 });
  assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.match(result.stderr, /observation failed/);
});
