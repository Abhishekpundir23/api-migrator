import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseImageLifecycleFixtureCli, validateFixtureEnvironment } from "../run-image-lifecycle-fixture.mjs";

const workflow = readFileSync(new URL("../../../../.github/workflows/runner-lifecycle-fixture.yml", import.meta.url), "utf8");
function script(name) {
  const block = workflow.split(/\n      - /).find((part) => part.startsWith(`name: ${name}\n`));
  assert(block, name);
  return block.slice(block.indexOf("        run: |\n") + "        run: |\n".length)
    .split("\n").filter((line) => line.startsWith("          ") || line === "").map((line) => line.slice(10)).join("\n");
}

function executeStep(t, name, scenario, failCleanup = false) {
  const root = mkdtempSync(join(tmpdir(), "fixture-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin"));
  const log = join(root, "calls.jsonl");
  const capture = join(root, "capture.cjs");
  writeFileSync(capture, `const fs=require('fs');
    // CoreFoundation adds this after env-i on macOS; it is not a Linux input.
    if(process.platform==='darwin') delete process.env.__CF_USER_TEXT_ENCODING;
    fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({env:process.env,args:process.argv.slice(2)})+'\\n');
    if (${failCleanup} && process.argv[2].endsWith('cleanup-image-lifecycle-fixture.mjs') && !process.argv.includes('--audit-only')) process.exit(1);`);
  // Only the unavailable privileged/native process boundary is doubled. The
  // actual workflow shell and /usr/bin/env sanitizer both execute unchanged.
  writeFileSync(join(root, "bin", "sudo"), `#!${process.execPath}
const cp=require('child_process'); const args=process.argv.slice(2);
if(args[0]==='sha256sum') process.exit(0);
if(args[0]!=='env'||args[1]!=='-i') throw new Error('unexpected privileged command');
let i=2; while(args[i].includes('=')) i++;
const r=cp.spawnSync('/usr/bin/env',[...args.slice(1,i),${JSON.stringify(process.execPath)},${JSON.stringify(capture)},...args.slice(i+1)],{stdio:'inherit'});
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`,
    GITHUB_TOKEN: "synthetic-secret-must-not-arrive", HTTPS_PROXY: "synthetic-proxy",
    FIXTURE_RUN_ID: "123", FIXTURE_RUN_ATTEMPT: "1", FIXTURE_REVISION: "a".repeat(40), FIXTURE_REPOSITORY: "owner/repo",
    FIXTURE_WORKFLOW: "owner/repo/.github/workflows/runner-lifecycle-fixture.yml@refs/heads/main", FIXTURE_IMAGE: `sha256:${"b".repeat(64)}`,
    FIXTURE_SCENARIO: scenario, ImageVersion: "20260924.1" };
  const result = spawnSync("/bin/bash", ["-c", script(name)], { env, encoding: "utf8", timeout: 10000 });
  let calls;
  try { calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse); }
  catch { throw new Error(`workflow shell failed before invocation: ${result.stderr}`); }
  return { result, calls };
}

test("every joined fixture matrix scenario launches through the sanitized shell boundary", (t) => {
  const matrix = /^\s+scenario: \[([^\]]+)\]$/m.exec(workflow);
  assert(matrix, "fixture scenario matrix must exist");
  const scenarios = matrix[1].split(",").map((value) => value.trim());
  assert.deepEqual(scenarios, ["success", "install_failure", "install_cancel"]);
  for (const scenario of scenarios) {
    const { result, calls } = executeStep(t, "Run joined fixture", scenario);
    assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
    assert.equal(calls.length, 1, scenario);
    assert.deepEqual(Object.keys(calls[0].env).filter((key) => !key.startsWith("API_MIGRATOR_")).sort(), ["LANG", "LC_ALL", "PATH", "TZ"]);
    assert.equal(validateFixtureEnvironment(calls[0].env).runId, "123");
    assert.equal(calls[0].env.GITHUB_TOKEN, undefined);
    assert.equal(calls[0].env.HTTPS_PROXY, undefined);
    const config = parseImageLifecycleFixtureCli(calls[0].args.slice(1));
    assert.deepEqual(config, { image: `sha256:${"b".repeat(64)}`,
      outputDir: `/tmp/api-migrator-fixture-results/123-1-${scenario}`, scenario });
  }
});

test("each scenario still audits exact residual resources after cleanup fails", (t) => {
  for (const scenario of ["success", "install_failure", "install_cancel"]) {
    const { result, calls } = executeStep(t, "Always clean and audit exact owned resources", scenario, true);
    assert.equal(calls.length, 2, `${scenario}: audit must run after failed cleanup`);
    assert.notEqual(result.status, 0, scenario);
    assert(!calls[0].args.includes("--audit-only"));
    assert.equal(calls[1].args.at(-1), "--audit-only");
    for (const call of calls) {
      assert.equal(validateFixtureEnvironment(call.env).runId, "123");
      const config = parseImageLifecycleFixtureCli(call.args.slice(1).filter((arg) => arg !== "--audit-only"));
      assert.equal(config.scenario, scenario);
    }
  }
});
