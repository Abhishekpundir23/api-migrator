import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, linkSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateTrialOwnership } from "../cleanup.mjs";
import { ownershipReadFixture, ACCOUNT, TOKEN, USERINFO, BASE, OPERATION } from "./ownership-read-fixture.mjs";

const CLI = "ops/gcp-trial/capture-ownership.mjs";
const args = path => ["--read-only", "--token-stdin", `--expected-account=${ACCOUNT}`, "--input", path];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "trial-ownership-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = ownershipReadFixture(Date.now() - 4000), path = join(root, "input.json");
  writeFileSync(path, JSON.stringify({ plan: f.plan, operationName: OPERATION }), { mode: 0o600 });
  return { ...f, root, path };
}
// The real CLI/file/token/plan/ownership boundaries all run. Substitute only
// external transport, fail on any endpoint beyond the four authorized GETs.
function run(f, argv = args(f.path), input = TOKEN + "\n", { forbidNetwork = false, identity = f.identity, status = 200 } = {}) {
  const setup = `let step=0;globalThis.fetch=async(url,options)=>{
    if(${forbidNetwork})process.stderr.write("NETWORK_CALLED");
    if(options.method!=="GET"||options.headers.Authorization!==${JSON.stringify("Bearer " + TOKEN)})throw Error("bad request");
    const urls=${JSON.stringify([USERINFO, `${BASE}/operations/${OPERATION}`, `${BASE}/instances/${f.plan.instanceName}`, `${BASE}/disks/${f.plan.instanceName}`])};
    if((step===0?url:url.split("?")[0])!==urls[step])throw Error("unexpected endpoint");
    const bodies=${JSON.stringify([identity, f.operation, f.instance, f.disk])};
    return ${status}===200?Response.json(bodies[step++]):new Response(${JSON.stringify(TOKEN)},{status:${status}});};`;
  return spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(setup), CLI, ...argv],
    { encoding: "utf8", input, timeout: 3000 });
}
test("CLI reads one safe file and stdin credential and emits a consumable private ownership handoff", t => {
  const f = fixture(t), out = run(f);
  assert.equal(out.status, 0); assert.equal(out.stderr, "");
  const envelope = JSON.parse(out.stdout);
  assert.equal(envelope.account, ACCOUNT); assert.equal(envelope.cloudVerified, false);
  const bound = validateTrialOwnership(JSON.stringify(envelope.handoff.plan), JSON.stringify(envelope.handoff.ownership));
  assert.equal(bound.ownership.instanceId, "18446744073709551614"); assert.equal(bound.ownership.diskId, "18446744073709551613");
  assert.equal(out.stdout.includes(TOKEN), false); assert.equal(out.stdout.includes(f.path), false);
});
for (const extra of ["--execute", "--token=" + TOKEN, "--project=professional", "--url=https://example.com/", "--method=POST", "--impersonate-service-account=x"])
  test(`CLI refuses ${extra.split("=")[0]} with exit 2 before network`, t => {
    const f = fixture(t), out = run(f, [...args(f.path), extra], TOKEN, { forbidNetwork: true });
    assert.equal(out.status, 2); assert.equal(out.stdout, ""); assert.match(out.stderr, /read-only/);
    assert.equal(out.stderr.includes(TOKEN), false); assert.equal(out.stderr.includes("NETWORK_CALLED"), false);
  });
for (const [name, change] of [
  ["symlink", f => { const path = join(f.root, "linked.json"); symlinkSync(f.path, path); return path; }],
  ["hard link", f => { const path = join(f.root, "linked.json"); linkSync(f.path, path); return path; }],
  ["directory", f => { const path = join(f.root, "dir"); mkdirSync(path); return path; }],
  ["oversize", f => { writeFileSync(f.path, " ".repeat(32769)); }],
  ["empty", f => { writeFileSync(f.path, ""); }],
  ["extra fields", f => { writeFileSync(f.path, JSON.stringify({ plan: f.plan, operationName: OPERATION, execute: true })); }],
  ["malformed", f => { writeFileSync(f.path, TOKEN); }],
  ["unsafe operation name", f => { writeFileSync(f.path, JSON.stringify({ plan: f.plan, operationName: "../other" })); }],
  ["altered plan", f => { f.plan.commands.create.push("--service-account=other"); writeFileSync(f.path, JSON.stringify({ plan: f.plan, operationName: OPERATION })); }],
  ["expired plan", f => { const expired = ownershipReadFixture(Date.now() - 3_600_001); writeFileSync(f.path, JSON.stringify({ plan: expired.plan, operationName: OPERATION })); }],
]) test(`CLI refuses ${name} input with no request or payload/path disclosure`, t => {
  const f = fixture(t), path = change(f) ?? f.path, out = run(f, args(path), TOKEN, { forbidNetwork: true });
  assert.equal(out.status, 2); assert.equal(out.stdout, ""); assert.match(out.stderr, /observation failed/);
  for (const privateText of [path, TOKEN, "NETWORK_CALLED"]) assert.equal(out.stderr.includes(privateText), false);
});
for (const [name, options, input] of [
  ["wrong identity", { identity: { email: "professional@example.com", email_verified: true } }, TOKEN],
  ["API denial", { status: 403 }, TOKEN],
  ["empty credential", { forbidNetwork: true }, ""],
  ["oversized credential", { forbidNetwork: true }, "x".repeat(4098)],
]) test(`CLI rejects ${name} with sanitized exit 2 and no success output`, t => {
  const f = fixture(t), out = run(f, args(f.path), input, options);
  assert.equal(out.status, 2); assert.equal(out.stdout, ""); assert.match(out.stderr, /observation failed/);
  for (const privateText of [f.path, TOKEN, "professional", "NETWORK_CALLED"]) assert.equal(out.stderr.includes(privateText), false);
});
