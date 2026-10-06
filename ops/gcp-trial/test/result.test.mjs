import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseTrialResult } from "../result.mjs";
import { resultFixture } from "./result-fixture.mjs";

const json = JSON.stringify, PREFIX = "API_MIGRATOR_TRIAL_RESULT ";
function parse(f = resultFixture(), entries = [f.entry], options = {}) {
  return parseTrialResult(json(f.plan), json(f.ownership), json(entries), { nowMs: f.nowMs, ...options });
}
test("reports the exact engine result without granting cloud, cleanup or release authority", () => {
  const f = resultFixture(), out = parse(f);
  assert.equal(out.status, "reported_passed"); assert.equal(out.phase, "complete"); assert.equal(out.exitCode, 0);
  assert.equal(out.instanceId, "18446744073709551614"); assert.equal(out.runId, "abcdef0123456789abcdef0123456789");
  assert.equal(out.planDigest, f.plan.planDigest); assert.equal(out.ownershipDigest, f.ownership.ownershipDigest);
  assert.equal(out.evidenceDigest, `sha256:${createHash("sha256").update(json([f.entry])).digest("hex")}`);
  for (const key of ["executionBlocked", "activationBlocked"]) assert.equal(out[key], true);
  for (const key of ["cloudVerified", "evidenceAuthenticityVerified", "cleanupVerified", "releaseEvidenceEligible"]) assert.equal(out[key], false);
  assert.equal(Object.hasOwn(out, "entries"), false); assert.equal(Object.hasOwn(out, "textPayload"), false);
});
test("recognizes the startup-script prefix and CRLF without treating other console text as a result", () => {
  const f = resultFixture();
  f.entry.textPayload = `unrelated boot message\r\nOct 06 12:00:00 vm google_metadata_script_runner[123]: startup-script: ${PREFIX}${json(f.marker)}\r\n`;
  assert.equal(parse(f).status, "reported_passed");
});
test("preserves a coherent reported failure including its bounded exit code", () => {
  const f = resultFixture(); f.marker.phase = "engine_smoke"; f.marker.status = "failed"; f.marker.exitCode = 124;
  f.entry.textPayload = PREFIX + json(f.marker) + "\n";
  const out = parse(f); assert.equal(out.status, "reported_failed"); assert.equal(out.exitCode, 124); assert.equal(out.phase, "engine_smoke");
});
test("permits post-deletion retrieval without pretending to prove deletion", () => {
  const f = resultFixture();
  assert.equal(parse(f, [f.entry], { nowMs: f.plan.deleteAt + 60_000 }).status, "reported_passed");
});
for (const [name, entries, reason] of [
  ["empty logs", f => [], "terminal_missing"],
  ["boot logs only", f => [{ ...f.entry, textPayload: "booting\n" }], "terminal_missing"],
  ["two identical terminal records", f => [f.entry, { ...f.entry, insertId: "second" }], "terminal_ambiguous"],
  ["two markers in one record", f => [{ ...f.entry, textPayload: f.entry.textPayload.repeat(2) }], "terminal_ambiguous"],
  ["entry limit reached", f => Array.from({ length: 1000 }, (_, i) => ({ ...f.entry, insertId: String(i), textPayload: i ? "boot\n" : f.entry.textPayload })), "entry_limit_reached"],
  ["split log entry", f => [{ ...f.entry, split: { uid: "split", index: 0, totalSplits: 2 } }], "split_entries"],
  ["partial marker", f => [{ ...f.entry, textPayload: PREFIX + '{"schemaVersion":1' }], "terminal_invalid"],
  ["partial marker plus complete marker", f => [{ ...f.entry, textPayload: PREFIX + '{"schemaVersion":1\n' + f.entry.textPayload }], "terminal_ambiguous"],
  ["truncated token plus complete marker", f => [{ ...f.entry, textPayload: "API_MIGRATOR_TRIAL_RES\n" + f.entry.textPayload }], "terminal_fragment"],
  ["truncated token after complete marker", f => [{ ...f.entry, textPayload: f.entry.textPayload + "API_MIGRATOR_TRIAL_" }], "terminal_fragment"],
  ["truncated token in another record", f => [f.entry, { ...f.entry, textPayload: "startup-script: API_MIGRATOR" }], "terminal_fragment"],
  ["truncated token only", f => [{ ...f.entry, textPayload: "API_MIGRATOR_TRIAL_RES" }], "terminal_fragment"],
  ["unrecognized prefix", f => [{ ...f.entry, textPayload: "quoted: " + f.entry.textPayload }], "terminal_invalid"],
]) test(`incomplete evidence cannot pass: ${name}`, () => {
  const f = resultFixture(), out = parse(f, entries(f));
  assert.equal(out.status, "incomplete"); assert.equal(out.reason, reason); assert.equal(out.cloudVerified, false);
});
for (const [name, mutate] of [
  ["wrong run", m => { m.runId = "f".repeat(32); }],
  ["wrong revision", m => { m.sourceRevision = "c".repeat(40); }],
  ["wrong archive", m => { m.sourceArchiveSha256 = "d".repeat(64); }],
  ["wrong profile", m => { m.profile = "production"; }],
  ["wrong schema", m => { m.schemaVersion = 2; }],
  ["unknown field", m => { m.credential = "private-value"; }],
  ["activation enabled", m => { m.activationBlocked = false; }],
  ["false pass exit", m => { m.exitCode = 1; }],
  ["false pass phase", m => { m.phase = "engine_smoke"; }],
  ["false failure exit", m => { m.status = "failed"; }],
  ["failure in completed phase", m => { m.status = "failed"; m.exitCode = 1; }],
  ["unknown phase", m => { m.phase = "made-up"; m.status = "failed"; m.exitCode = 1; }],
  ["string exit", m => { m.exitCode = "0"; }],
  ["oversized exit", m => { m.exitCode = 256; m.status = "failed"; }],
]) test(`rejects incoherent marker: ${name}`, () => {
  const f = resultFixture(); mutate(f.marker); f.entry.textPayload = PREFIX + json(f.marker) + "\n";
  assert.equal(parse(f).status, "incomplete"); assert.equal(parse(f).reason, "terminal_invalid");
  assert.equal(json(parse(f)).includes("private-value"), false);
});
test("duplicate JSON marker keys cannot be silently last-wins", () => {
  const f = resultFixture(); f.entry.textPayload = PREFIX + json(f.marker).replace('"exitCode":0', '"exitCode":19,"exitCode":0') + "\n";
  assert.equal(parse(f).reason, "terminal_invalid");
});
for (const [name, mutate] of [
  ["foreign log", e => { e.logName = "projects/professional/logs/serialconsole.googleapis.com%2Fserial_port_1_output"; }],
  ["wrong port", e => { e.logName = e.logName.replace("port_1", "port_2"); }],
  ["wrong resource", e => { e.resource.type = "global"; }],
  ["foreign project", e => { e.resource.labels.project_id = "professional"; }],
  ["wrong zone", e => { e.resource.labels.zone = "us-central1-b"; }],
  ["different instance", e => { e.resource.labels.instance_id = "123"; }],
  ["rounded instance", e => { e.resource.labels.instance_id = 18446744073709551614; }],
  ["missing timestamp", e => { delete e.timestamp; }],
  ["invalid date", e => { e.timestamp = "2033-02-30T00:00:00Z"; }],
  ["untyped payload", e => { e.textPayload = { status: "passed" }; }],
  ["two payloads", e => { e.jsonPayload = { status: "passed" }; }],
]) test(`refuses unbound log evidence: ${name}`, () => {
  const f = resultFixture(); mutate(f.entry);
  assert.throws(() => parse(f), { message: "invalid trial result evidence" });
});
test("all entries are scoped, not merely the selected terminal entry", () => {
  const f = resultFixture();
  assert.throws(() => parse(f, [f.entry, { ...f.entry, resource: { type: "global" }, textPayload: "irrelevant" }]), /invalid trial/);
});
for (const [name, time] of [
  ["before trial", f => f.plan.issuedAt - 1],
  ["after deadline", f => f.plan.deleteAt + 1],
  ["future", f => f.nowMs + 1],
]) test(`rejects event time ${name}`, () => {
  const f = resultFixture(); f.entry.timestamp = new Date(time(f)).toISOString();
  assert.throws(() => parse(f), /invalid trial/);
});
test("does not round a future nanosecond down into the accepted window", () => {
  const f = resultFixture(); f.entry.timestamp = new Date(f.nowMs).toISOString().replace("Z", "000001Z");
  assert.throws(() => parse(f), /invalid trial/);
});
test("accepts Google's nanosecond timestamps inside the window", () => {
  const f = resultFixture(); f.entry.timestamp = f.entry.timestamp.replace("Z", "123456Z");
  assert.equal(parse(f).status, "reported_passed");
});
test("a fixed event cutoff rejects even one later nanosecond while retrieval time advances", () => {
  const f = resultFixture(); f.entry.timestamp = new Date(f.nowMs).toISOString().replace("Z", "000001Z");
  f.entry.receiveTimestamp = new Date(f.nowMs + 500).toISOString();
  assert.throws(() => parse(f, [f.entry], { nowMs: f.nowMs + 1000, eventUntilMs: f.nowMs }), /invalid trial/);
});
test("fixed event cutoff still permits ingestion between cutoff and retrieval completion", () => {
  const f = resultFixture(); f.entry.receiveTimestamp = new Date(f.nowMs + 500).toISOString();
  assert.equal(parse(f, [f.entry], { nowMs: f.nowMs + 1000, eventUntilMs: f.nowMs }).status, "reported_passed");
});
for (const until of [NaN, -1, 2_000_000_000_000 - 1, 2_000_000_004_001]) test(`rejects invalid explicit event cutoff ${until}`, () => {
  const f = resultFixture(); assert.throws(() => parse(f, [f.entry], { eventUntilMs: until }), /invalid trial/);
});
for (const [name, mutate] of [
  ["altered plan command", f => { f.plan.commands.create.push("--service-account=other"); }],
  ["changed record ID", f => { f.ownership.instanceId = "123"; }],
  ["changed record deadline", f => { f.ownership.deleteAt++; }],
  ["invalid clock", f => { f.nowMs = NaN; }],
]) test(`refuses ${name}`, () => {
  const f = resultFixture(); mutate(f); assert.throws(() => parse(f), /invalid trial/);
});
for (const logs of ["{}", "null", "[", "private".repeat(160_000)]) test(`refuses malformed or oversized input (${logs.length})`, () => {
  const f = resultFixture();
  assert.throws(() => parseTrialResult(json(f.plan), json(f.ownership), logs, { nowMs: f.nowMs }), { message: "invalid trial result evidence" });
});
