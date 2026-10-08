import assert from "node:assert/strict";
import test from "node:test";
import { observeTrialCleanup } from "../observe-cleanup.mjs";
import { ACCOUNT, TOKEN, BASE, page, cleanupReadFixture, transport } from "./cleanup-read-fixture.mjs";

const json = JSON.stringify;
const observe = (f, t, options = {}) => observeTrialCleanup(json(f.plan), json(f.ownership), TOKEN,
  { expectedAccount: ACCOUNT, now: () => f.nowMs, fetchImpl: t.fetchImpl, ...options });
const owned = f => transport({ instances: [page("instances", [f.vm])], disks: [page("disks", [f.disk])] });

test("joins fresh authenticated full inventory to deadline decisions without deletion or raw inventory output", async () => {
  const f = cleanupReadFixture(), t = owned(f), out = await observe(f, t);
  assert.equal(out.kind, "api_migrator_gcp_cleanup_observation");
  assert.equal(out.status, "waiting"); assert.equal(out.requiresOperatorAttention, false);
  assert.equal(out.deadlineReached, false); assert.equal(out.overdueMs, 0);
  assert.equal(out.decision.deleteAt, 2_000_003_600_000); assert.equal(out.decision.instanceId, "18446744073709551614");
  assert.equal(out.decision.diskId, "18446744073709551613"); assert.equal(out.ownershipDigest, f.ownership.ownershipDigest);
  assert.equal(out.nextCheckAt, f.nowMs + 30_000); assert.equal(out.requestedReason, "deadline");
  assert.equal(t.calls.length, 3); assert.equal(t.calls[0].url, "https://openidconnect.googleapis.com/v1/userinfo");
  for (const call of t.calls) { assert.equal(call.options.method, "GET"); assert.equal(call.options.body, undefined); }
  for (const call of t.calls.slice(1)) {
    const u = new URL(call.url); assert.ok(u.href.startsWith(BASE + "/")); assert.equal(u.searchParams.has("filter"), false);
    assert.equal(call.options.headers["X-Goog-User-Project"], "project-32bf49a2-bd30-4956-850");
  }
  for (const key of ["executionBlocked", "activationBlocked"]) assert.equal(out[key], true);
  for (const key of ["cloudVerified", "cleanupVerified", "releaseEvidenceEligible", "evidenceAuthenticityVerified", "independentControllerReady"]) assert.equal(out[key], false);
  for (const forbidden of [TOKEN, ACCOUNT, '"inventory":', '"items":', '"command":']) assert.equal(json(out).includes(forbidden), false);
});
for (const offset of [-1, 0, 1500]) test(`deadline offset ${offset} never postpones cleanup`, async () => {
  const f = cleanupReadFixture(); f.nowMs = f.plan.deleteAt + offset;
  const out = await observe(f, owned(f));
  assert.equal(out.status, offset < 0 ? "waiting" : "blocked");
  assert.equal(out.deadlineReached, offset >= 0); assert.equal(out.requiresOperatorAttention, offset >= 0);
  assert.equal(out.overdueMs, Math.max(offset, 0)); assert.equal(out.decision.deleteAt, f.plan.deleteAt);
  assert.equal(out.nextCheckAt, offset < 0 ? f.plan.deleteAt : null);
  if (offset >= 0) assert.equal(out.decision.reason, "generation_safe_delete_unverified");
});
for (const reason of ["completed", "failed", "cancelled", "controller_failure"]) test(`early ${reason} requires attention without waiting for logs`, async () => {
  const f = cleanupReadFixture(), t = owned(f), out = await observe(f, t, { reason });
  assert.equal(out.status, "blocked"); assert.equal(out.requiresOperatorAttention, true); assert.equal(out.deadlineReached, false);
  assert.equal(out.requestedReason, reason); assert.equal(out.nextCheckAt, null); assert.equal(t.calls.length, 3);
});
test("absence requires complete VM and disk inventories and is not a verified cleanup receipt", async () => {
  const f = cleanupReadFixture(), out = await observe(f, transport());
  assert.equal(out.status, "absence_observed"); assert.equal(out.requiresOperatorAttention, false); assert.equal(out.nextCheckAt, null);
  assert.equal(out.cleanupVerified, false); assert.equal(out.decision.cloudVerified, false);
});
test("an orphaned disk on a later page remains a cleanup blocker", async () => {
  const f = cleanupReadFixture(); f.nowMs = f.plan.deleteAt; f.disk.users = [];
  const t = transport({ disks: [page("disks", [], { nextPageToken: "next" }), page("disks", [f.disk])] });
  const out = await observe(f, t); assert.equal(out.status, "blocked"); assert.equal(out.decision.resource, "disk");
  assert.equal(out.requiresOperatorAttention, true); assert.equal(t.calls.length, 4);
});
for (const [name, mutate, reason] of [
  ["same-name replacement", f => { f.vm.id = "123"; }, "replacement_or_unowned_resource"],
  ["changed attachment", f => { f.vm.disks[0].autoDelete = false; }, "ownership_changed"],
  ["disk attached elsewhere", f => { f.disk.users.push(`${BASE}/instances/another`); }, "disk_attached_elsewhere"],
]) test(`does not adopt ${name}`, async () => {
  const f = cleanupReadFixture(); f.nowMs = f.plan.deleteAt; mutate(f);
  const out = await observe(f, owned(f)); assert.equal(out.status, "blocked"); assert.equal(out.decision.reason, reason);
  assert.equal(out.requiresOperatorAttention, true);
});
test("a deadline crossed while reading is evaluated at completion without refreshing the observation timestamp", async () => {
  const f = cleanupReadFixture(); let at = f.plan.deleteAt - 2;
  const t = transport({ instances: [page("instances", [f.vm])], disks: [page("disks", [f.disk])], alter: () => { at++; } });
  const out = await observe(f, t, { now: () => at });
  assert.equal(out.startedAt, f.plan.deleteAt - 2); assert.equal(out.completedAt, f.plan.deleteAt + 1);
  assert.equal(out.decision.observedAt, f.plan.deleteAt - 2); assert.equal(out.status, "blocked"); assert.equal(out.overdueMs, 1);
});
for (const vmPresent of [true, false]) test(`reports foreign disk attachment immediately with VM present=${vmPresent}`, async () => {
  const f = cleanupReadFixture(); f.disk.users = [`${BASE}/instances/other`];
  const t = transport({ instances: [page("instances", vmPresent ? [f.vm] : [])], disks: [page("disks", [f.disk])] });
  const out = await observe(f, t);
  assert.equal(out.status, "blocked"); assert.equal(out.requiresOperatorAttention, true);
  assert.equal(out.decision.reason, "disk_attached_elsewhere"); assert.equal(out.deadlineReached, false);
  assert.equal(out.nextCheckAt, null);
});
for (const [name, mutate] of [
  ["altered plan", f => { f.plan.commands.create.push("--service-account=other"); }],
  ["altered ownership", f => { f.ownership.instanceId = "1"; }],
  ["invalid clock", f => { f.nowMs = NaN; }],
]) test(`refuses ${name} before fetching`, async () => {
  const f = cleanupReadFixture(), t = transport(); mutate(f);
  await assert.rejects(observe(f, t), { message: "GCP cleanup observation failed" }); assert.equal(t.calls.length, 0);
});
for (const reason of ["delete", "", {}, "deadline\n--execute"]) test(`refuses invalid reason ${json(reason)}`, async () => {
  const f = cleanupReadFixture(), t = transport();
  await assert.rejects(observe(f, t, { reason }), /cleanup observation failed/); assert.equal(t.calls.length, 0);
});
for (const identity of [{ email: "professional@example.com", email_verified: true }, { email: ACCOUNT, email_verified: false }]) {
  test("wrong identity cannot reach resource inventory", async () => {
    const f = cleanupReadFixture(), t = transport({ identity });
    await assert.rejects(observe(f, t), /cleanup observation failed/); assert.equal(t.calls.length, 1);
  });
}
for (const [name, disks] of [
  ["null continuation token", [page("disks", [], { nextPageToken: null })]],
  ["partial inventory", [page("disks", [], { nextPageToken: "missing" })]],
  ["warning", [page("disks", [], { warning: { code: "partial", message: TOKEN } })]],
  ["API error", [{ error: TOKEN }]],
]) test(`rejects ${name} instead of observing absence`, async () => {
  const f = cleanupReadFixture(), t = transport({ disks });
  await assert.rejects(observe(f, t), { message: "GCP cleanup observation failed" });
});
for (const drift of [-1, 20_001]) test(`rejects clock drift ${drift}`, async () => {
  const f = cleanupReadFixture(); let at = f.nowMs;
  const t = transport({ alter: () => { at += drift; } });
  await assert.rejects(observe(f, t, { now: () => at }), /cleanup observation failed/);
});
test("propagates a bounded read timeout as failure rather than a cleanup success", async () => {
  const f = cleanupReadFixture(); let aborted = false;
  const fetchImpl = (_, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => {
    aborted = true; reject(new Error(TOKEN));
  }, { once: true }));
  await assert.rejects(observe(f, { fetchImpl }, { timeoutMs: 20 }), { message: "GCP cleanup observation failed" });
  assert.equal(aborted, true);
});
