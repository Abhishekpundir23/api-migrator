import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../../../../.github/workflows/runner-lifecycle-fixture.yml", import.meta.url), "utf8");
test("workflow only schedules explicit manual diagnostics and uploads them before workload execution", () => {
  const input = /      dns_comparison:\n([\s\S]*?)(?=^  [a-z_]+:)/m.exec(workflow)?.[1];
  assert(input, "manual diagnostic input must exist");
  const inputType = /^        type: (\w+)$/m.exec(input)?.[1];
  const defaultText = /^        default: (true|false)$/m.exec(input)?.[1];
  assert.equal(inputType, "boolean");
  assert(defaultText, "input must have an explicit boolean default");
  const steps = workflow.split(/\n      - /);
  const comparison = steps.find((step) => step.startsWith("name: Compare default DNS paths (read-only opt-in)\n"));
  const expression = /^        if: (.+)$/m.exec(comparison ?? "")?.[1];
  assert(expression, "diagnostic requires a workflow gate");
  // Execute this workflow's small boolean expression against event contexts.
  // No production expression is re-created in the test.
  for (const [event, supplied, expected] of [
    ["push", undefined, false], ["pull_request", undefined, false],
    ["push", true, false], ["pull_request", true, false],
    ["workflow_dispatch", undefined, false], ["workflow_dispatch", false, false],
    ["workflow_dispatch", true, true],
  ]) {
    const actual = runInNewContext(expression, { github: { event_name: event },
      inputs: { dns_comparison: supplied ?? JSON.parse(defaultText) } }, { timeout: 1000 });
    assert.equal(actual, expected, `${event}/${supplied}`);
  }
  const order = steps.map((step) => step.split("\n")[0]).filter((name) => [
    "name: Compare default DNS paths (read-only opt-in)",
    "name: Upload read-only DNS comparison before fixture execution", "name: Run joined fixture",
  ].includes(name));
  assert.deepEqual(order, ["name: Compare default DNS paths (read-only opt-in)",
    "name: Upload read-only DNS comparison before fixture execution", "name: Run joined fixture"]);
});

function diagnosticScript() {
  const block = workflow.split(/\n      - /).find((part) => part.startsWith("name: Compare default DNS paths (read-only opt-in)\n"));
  assert(block, "explicit diagnostic step must exist");
  return block.slice(block.indexOf("        run: |\n") + "        run: |\n".length)
    .split("\n").filter((line) => line.startsWith("          ") || line === "").map((line) => line.slice(10)).join("\n");
}

function execute(t, { failure = false, oversized = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dns-comparison-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), artifacts = join(root, "artifacts");
  mkdirSync(bin); mkdirSync(artifacts);
  const calls = join(root, "calls.json"), output = join(root, "outputs");
  writeFileSync(output, "");
  // The actual shell and env sanitizer execute; only unavailable Linux commands
  // and the long-running DNS process boundary are doubled.
  writeFileSync(join(bin, "sudo"), `#!${process.execPath}\nif(process.argv[2]!=="sha256sum") process.exit(9);\n`, { mode: 0o755 });
  writeFileSync(join(bin, "timeout"), `#!${process.execPath}
const cp=require("node:child_process"), args=process.argv.slice(2);
if(args[0]!=="--kill-after=5s"||args[1]!=="130s") process.exit(9);
const result=cp.spawnSync(args[2],args.slice(3),{stdio:"inherit",timeout:10000});
process.exit(result.status ?? 1);`, { mode: 0o755 });
  writeFileSync(join(bin, "node"), `#!${process.execPath}
const fs=require("node:fs");
if(process.platform==="darwin") delete process.env.__CF_USER_TEXT_ENCODING;
fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify({args:process.argv.slice(2),env:process.env}));
process.stdout.write(${oversized ? '"x".repeat(65537)' : 'JSON.stringify({kind:"api_migrator_hosted_dns_comparison"})'});
process.exit(${failure ? 1 : 0});`, { mode: 0o755 });
  const script = diagnosticScript().replaceAll("/usr/local/libexec/api-migrator-hosted-smoke", bin);
  const result = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: artifacts, GITHUB_OUTPUT: output,
      GITHUB_TOKEN: "synthetic-secret", HTTPS_PROXY: "synthetic-proxy",
      DNS_PROBE_RUN_ID: "123", DNS_PROBE_RUN_ATTEMPT: "2", DNS_PROBE_SOURCE_REVISION: "a".repeat(40),
      DNS_PROBE_REPOSITORY: "owner/repo", DNS_PROBE_SCENARIO: "install_cancel" } });
  return { result, calls: existsSync(calls) ? JSON.parse(readFileSync(calls, "utf8")) : null,
    artifacts, output: readFileSync(output, "utf8") };
}

test("opt-in DNS comparison launches a bounded unprivileged process without ambient secrets", (t) => {
  const { result, calls, artifacts, output } = execute(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.args, [calls.env.PATH.split(":")[0] + "/fixture-runtime/ops/publication-runner/deployment/compare-hosted-dns.mjs", "--read-only"]);
  assert.deepEqual(Object.keys(calls.env).sort(), ["DNS_PROBE_REPOSITORY", "DNS_PROBE_RUN_ATTEMPT", "DNS_PROBE_RUN_ID",
    "DNS_PROBE_SCENARIO", "DNS_PROBE_SOURCE_REVISION", "LANG", "LC_ALL", "PATH", "TZ"]);
  assert.equal(calls.env.DNS_PROBE_SCENARIO, "install_cancel");
  assert.equal(calls.env.DNS_PROBE_RUN_ID, "123");
  assert.equal(calls.env.DNS_PROBE_RUN_ATTEMPT, "2");
  assert.equal(calls.env.DNS_PROBE_SOURCE_REVISION, "a".repeat(40));
  assert.equal(calls.env.DNS_PROBE_REPOSITORY, "owner/repo");
  const files = readdirSync(artifacts);
  assert.equal(files.length, 1);
  assert.equal(output, `path=${join(artifacts, files[0])}\n`);
  assert.equal(statSync(join(artifacts, files[0])).mode & 0o777, 0o440);
});

for (const options of [{ failure: true }, { oversized: true }]) {
  test(`failed or oversized DNS comparison cannot publish partial output ${JSON.stringify(options)}`, (t) => {
    const { result, artifacts, output } = execute(t, options);
    assert.notEqual(result.status, 0);
    assert.equal(output, "");
    assert.deepEqual(readdirSync(artifacts), []);
  });
}
