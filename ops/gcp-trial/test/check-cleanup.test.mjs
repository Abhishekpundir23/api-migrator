import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ACCOUNT, TOKEN, BASE, page, cleanupReadFixture } from "./cleanup-read-fixture.mjs";

const CLI = "ops/gcp-trial/check-cleanup.mjs";
const args = (path, reason = "deadline") => ["--read-only", "--token-stdin", `--expected-account=${ACCOUNT}`, `--reason=${reason}`, "--input", path];
function fixture(t, age = 4000) {
  const root = mkdtempSync(join(tmpdir(), "trial-cleanup-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = cleanupReadFixture(Date.now() - age), path = join(root, "input.json");
  writeFileSync(path, JSON.stringify({ plan: f.plan, ownership: f.ownership }), { mode: 0o600 });
  return { ...f, root, path };
}
// Substitute only the external transport. The subprocess executes the real CLI,
// file and token readers, authenticated inventory collector and cleanup decision.
function run(argv, f, { input = TOKEN + "\n", identity = { email: ACCOUNT, email_verified: true },
  present = true, failReads = false, forbidFetch = false, forbidInventory = false } = {}) {
  const setup = `globalThis.fetch=async (url, options)=>{
    if(${forbidFetch}) { process.stderr.write("UNEXPECTED_FETCH"); throw Error("no reads expected"); }
    if(options.method!=="GET"||options.body!==undefined||options.headers.Authorization!==${JSON.stringify("Bearer " + TOKEN)}) throw Error("unexpected request");
    if(url==="https://openidconnect.googleapis.com/v1/userinfo") return Response.json(${JSON.stringify(identity)});
    if(${forbidInventory}) { process.stderr.write("UNEXPECTED_INVENTORY"); throw Error("wrong identity reached compute"); }
    if(${failReads}) return Response.json({error:${JSON.stringify(TOKEN)}},{status:500});
    const u=new URL(url);
    if(u.searchParams.has("filter")||options.headers["X-Goog-User-Project"]!=="project-32bf49a2-bd30-4956-850") throw Error("unexpected scope");
    if(u.origin+u.pathname===${JSON.stringify(BASE + "/instances")}) return Response.json(${JSON.stringify(page("instances", present ? [f.vm] : []))});
    if(u.origin+u.pathname===${JSON.stringify(BASE + "/disks")}) return Response.json(${JSON.stringify(page("disks", present ? [f.disk] : []))});
    throw Error("unexpected network request");};`;
  return spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(setup), CLI, ...argv],
    { encoding: "utf8", input, timeout: 3000 });
}
function safeFailure(out, f) {
  assert.equal(out.status, 2); assert.equal(out.stdout, "");
  assert.match(out.stderr, /read-only|observation failed/);
  for (const secret of [TOKEN, ACCOUNT, f.path, "UNEXPECTED_FETCH", "UNEXPECTED_INVENTORY"]) assert.equal(out.stderr.includes(secret), false);
}

test("CLI reports waiting with exit 3, not successful cleanup", t => {
  const f = fixture(t), out = run(args(f.path), f);
  assert.equal(out.status, 3); assert.equal(out.stderr, "");
  const observation = JSON.parse(out.stdout);
  assert.equal(observation.status, "waiting"); assert.equal(observation.requiresOperatorAttention, false);
  assert.equal(observation.deadlineReached, false); assert.equal(observation.decision.deleteAt, f.plan.deleteAt);
  assert.equal(observation.nextCheckAt <= f.plan.deleteAt, true);
  assert.equal(observation.executionBlocked, true); assert.equal(observation.cleanupVerified, false);
  assert.equal(observation.independentControllerReady, false); assert.equal(observation.cloudVerified, false);
  for (const secret of [TOKEN, ACCOUNT, f.path, '"inventory":', '"items":', '"command":']) assert.equal(out.stdout.includes(secret), false);
});
test("CLI reports absence with exit 0 without claiming independently verified cleanup", t => {
  const f = fixture(t), out = run(args(f.path), f, { present: false });
  assert.equal(out.status, 0); assert.equal(out.stderr, "");
  const observation = JSON.parse(out.stdout);
  assert.equal(observation.status, "absence_observed"); assert.equal(observation.nextCheckAt, null);
  assert.equal(observation.cleanupVerified, false); assert.equal(observation.releaseEvidenceEligible, false);
});
test("CLI reports expired cleanup blocked with exit 4 and the original deadline", t => {
  const f = fixture(t, 3_604_000), out = run(args(f.path), f);
  assert.equal(out.status, 4); assert.equal(out.stderr, "");
  const observation = JSON.parse(out.stdout);
  assert.equal(observation.status, "blocked"); assert.equal(observation.deadlineReached, true);
  assert.equal(observation.requiresOperatorAttention, true); assert.equal(observation.decision.deleteAt, f.plan.deleteAt);
  assert.equal(observation.decision.reason, "generation_safe_delete_unverified"); assert.equal(observation.nextCheckAt, null);
});
test("CLI reports disk attachment drift as exit 4 even before deadline", t => {
  const f = fixture(t); f.disk.users = [`${BASE}/instances/other`];
  const out = run(args(f.path), f);
  assert.equal(out.status, 4); assert.equal(out.stderr, "");
  const observation = JSON.parse(out.stdout);
  assert.equal(observation.decision.reason, "disk_attached_elsewhere");
  assert.equal(observation.requiresOperatorAttention, true); assert.equal(observation.deadlineReached, false);
});
for (const reason of ["completed", "failed", "cancelled", "controller_failure"]) test(`CLI makes early ${reason} visible with exit 4`, t => {
  const f = fixture(t), out = run(args(f.path, reason), f);
  assert.equal(out.status, 4); assert.equal(out.stderr, "");
  const observation = JSON.parse(out.stdout);
  assert.equal(observation.requestedReason, reason); assert.equal(observation.status, "blocked");
  assert.equal(observation.deadlineReached, false); assert.equal(observation.requiresOperatorAttention, true);
});
for (const [name, change] of [
  ["mutation flag", values => [...values, "--execute"]],
  ["token in arguments", values => [...values, `--token=${TOKEN}`]],
  ["professional project override", values => [...values, "--project=professional"]],
  ["missing read-only flag", values => values.slice(1)],
  ["missing stdin flag", values => values.filter(value => value !== "--token-stdin")],
  ["missing input path", values => values.slice(0, -1)],
  ["invalid reason", values => values.map(value => value === "--reason=deadline" ? "--reason=delete" : value)],
  ["blank reason", values => values.map(value => value === "--reason=deadline" ? "--reason=" : value)],
  ["blank account", values => values.map(value => value.startsWith("--expected-account=") ? "--expected-account=" : value)],
]) test(`CLI refuses ${name} without networking`, t => {
  const f = fixture(t); safeFailure(run(change(args(f.path)), f, { forbidFetch: true }), f);
});
for (const identity of [{ email: "professional@example.com", email_verified: true }, { email: ACCOUNT, email_verified: false }]) {
  test("CLI rejects mismatched or unverified identity before inventory and without disclosure", t => {
    const f = fixture(t), out = run(args(f.path), f, { identity, forbidInventory: true });
    safeFailure(out, f); assert.equal(out.stderr.includes("professional"), false);
  });
}
for (const input of ["", "short", TOKEN + "\n\n", "x".repeat(4098)]) test(`CLI refuses invalid stdin credentials of size ${input.length}`, t => {
  const f = fixture(t); safeFailure(run(args(f.path), f, { input, forbidFetch: true }), f);
});
for (const kind of ["symlink", "hardlink", "oversize", "extra fields", "missing ownership", "array", "null", "malformed"]) {
  test(`CLI refuses ${kind} input without network or payload disclosure`, t => {
    const f = fixture(t); let path = f.path;
    if (kind === "symlink") { path = join(f.root, "linked.json"); symlinkSync(f.path, path); }
    if (kind === "hardlink") linkSync(f.path, join(f.root, "hardlink.json"));
    if (kind === "oversize") writeFileSync(path, " ".repeat(32769));
    if (kind === "extra fields") writeFileSync(path, JSON.stringify({ plan: f.plan, ownership: f.ownership, execute: true }));
    if (kind === "missing ownership") writeFileSync(path, JSON.stringify({ plan: f.plan }));
    if (kind === "array") writeFileSync(path, "[]");
    if (kind === "null") writeFileSync(path, "null");
    if (kind === "malformed") writeFileSync(path, TOKEN);
    const out = run(args(path), f, { forbidFetch: true }); safeFailure(out, f); assert.equal(out.stderr.includes(path), false);
  });
}
test("CLI reports failed reads as exit 2 without absence or raw server data", t => {
  const f = fixture(t), out = run(args(f.path), f, { failReads: true }); safeFailure(out, f);
});
