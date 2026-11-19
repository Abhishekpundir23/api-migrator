import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const demo = fileURLToPath(new URL("../../examples/service/inngest/inventory.ts", import.meta.url));
function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: join(tmpdir(), "unused-config-" + process.pid), OPENAI_API_KEY: "" } });
}
function success(...args) {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
}

test("owner and operator exchange only the aggregate artifact; existing files survive a failed handoff", t => {
  const dir = mkdtempSync(join(tmpdir(), "sdk-service-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "owner");
  const intake = join(dir, "intake");
  mkdirSync(repo);
  mkdirSync(intake);
  const privateName = "private-ledger-name.ts";
  const source = readFileSync(demo, "utf8");
  writeFileSync(join(repo, privateName), source);
  const summary = join(intake, "account-one.json");
  const local = join(dir, "local.json");
  const assess = ["assess", "--recipe", "inngest-v3-to-v4", "--repo", repo, "--out", summary, "--local-report", local];
  writeFileSync(local, "existing file");
  assert.notEqual(run(...assess).status, 0);
  assert.equal(readFileSync(local, "utf8"), "existing file");
  assert.deepEqual(readdirSync(intake), []);
  rmSync(local);
  success(...assess);
  assert.equal(readFileSync(join(repo, privateName), "utf8"), source);
  assert.deepEqual(readdirSync(repo), [privateName]);
  assert.ok(readFileSync(local, "utf8").includes(privateName));
  const exported = readFileSync(summary, "utf8");
  assert.ok(!exported.includes(privateName) && !exported.includes("stock/recount"));
  const out = join(dir, "brief.md");
  assert.notEqual(run("brief", "--summary", local, "--out", out).status, 0);
  const missingKey = run("brief", "--summary", summary, "--out", out, "--ai");
  assert.notEqual(missingKey.status, 0);
  assert.match(missingKey.stderr, /OPENAI_API_KEY/);
  assert.match(readFileSync(out, "utf8"), /OpenAI review plan was unavailable/);
  rmSync(out);
  success("brief", "--summary", summary, "--out", out);
  assert.match(readFileSync(out, "utf8"), /F12/);
  success("campaign", "--summaries", intake, "--out", join(dir, "campaign.md"));
  const rosterPath = join(dir, "roster.json");
  writeFileSync(rosterPath, JSON.stringify({ recipe: "inngest-v3-to-v4", repositories: [
    { alias: "First team", summary: "account-one.json" }, { alias: "Second team", summary: "second.json" },
  ] }));
  const tracked = join(dir, "tracked.md");
  success("campaign", "--summaries", intake, "--roster", rosterPath, "--out", tracked);
  assert.match(readFileSync(tracked, "utf8"), /1 of 2 invited repositories submitted/);
  assert.doesNotMatch(readFileSync(join(dir, "campaign.md"), "utf8"), /First team|Second team/);
});
