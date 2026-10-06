import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resultFixture } from "./result-fixture.mjs";

const CLI = "ops/gcp-trial/collect-logs.mjs", TOKEN = "fixture-not-a-real-access-token", ACCOUNT = "owner@example.com";
const args = path => ["--read-only", "--token-stdin", `--expected-account=${ACCOUNT}`, "--input", path];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "trial-logs-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = resultFixture(Date.now() - 4000), path = join(root, "input.json");
  writeFileSync(path, JSON.stringify({ plan: f.plan, ownership: f.ownership }), { mode: 0o600 });
  return { ...f, root, path };
}
// Only the external Google transport is substituted; the actual CLI, credential
// reader, file reader, identity checks, collector and parser execute together.
function run(argv, input, identity, entry) {
  const setup = `globalThis.fetch=async (url, options)=>{
    if(options.headers.Authorization!==${JSON.stringify("Bearer " + TOKEN)}) throw Error("bad credential");
    if(url==="https://openidconnect.googleapis.com/v1/userinfo"&&options.method==="GET") return Response.json(${JSON.stringify(identity)});
    if(url==="https://logging.googleapis.com/v2/entries:list"&&options.method==="POST") return Response.json({entries:[${JSON.stringify(entry)}]});
    throw Error("unexpected network request");};`;
  return spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(setup), CLI, ...argv],
    { encoding: "utf8", input, timeout: 2000 });
}
test("CLI joins real file, credential and result boundaries without echoing private input", t => {
  const f = fixture(t), out = run(args(f.path), TOKEN + "\n", { email: ACCOUNT, email_verified: true }, f.entry);
  assert.equal(out.status, 0); assert.equal(out.stderr, "");
  const observation = JSON.parse(out.stdout);
  assert.equal(observation.result.status, "reported_passed"); assert.equal(observation.cloudVerified, false);
  for (const secret of [TOKEN, ACCOUNT, f.entry.textPayload, f.path]) assert.equal(out.stdout.includes(secret), false);
});
for (const extra of ["--execute", "--token=" + TOKEN, "--project=professional"]) test(`CLI refuses ${extra.split("=")[0]}`, t => {
  const f = fixture(t), out = run([...args(f.path), extra], TOKEN, { email: ACCOUNT, email_verified: true }, f.entry);
  assert.equal(out.status, 2); assert.equal(out.stdout, ""); assert.match(out.stderr, /read-only/);
  assert.equal(out.stderr.includes(TOKEN), false);
});
test("CLI rejects wrong account without printing remote errors or a success record", t => {
  const f = fixture(t), out = run(args(f.path), TOKEN, { email: "professional@example.com", email_verified: true }, f.entry);
  assert.equal(out.status, 2); assert.equal(out.stdout, ""); assert.match(out.stderr, /observation failed/);
  assert.equal(out.stderr.includes("professional"), false);
});
test("CLI refuses invalid stdin credentials", t => {
  const f = fixture(t), out = run(args(f.path), "", { email: ACCOUNT, email_verified: true }, f.entry);
  assert.equal(out.status, 2); assert.equal(out.stdout, ""); assert.match(out.stderr, /observation failed/);
});
for (const kind of ["symlink", "oversize", "extra fields", "malformed"]) test(`CLI refuses ${kind} input without path or payload disclosure`, t => {
  const f = fixture(t); let path = f.path;
  if (kind === "symlink") { path = join(f.root, "linked.json"); symlinkSync(f.path, path); }
  if (kind === "oversize") writeFileSync(path, " ".repeat(32769));
  if (kind === "extra fields") writeFileSync(path, JSON.stringify({ plan: f.plan, ownership: f.ownership, execute: true }));
  if (kind === "malformed") writeFileSync(path, TOKEN);
  const out = run(args(path), TOKEN, { email: ACCOUNT, email_verified: true }, f.entry);
  assert.equal(out.status, 2); assert.equal(out.stdout, ""); assert.equal(out.stderr.includes(path), false); assert.equal(out.stderr.includes(TOKEN), false);
});
