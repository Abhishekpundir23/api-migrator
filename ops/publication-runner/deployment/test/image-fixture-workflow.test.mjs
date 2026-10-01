import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, linkSync, symlinkSync, realpathSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseImageLifecycleFixtureCli, validateFixtureEnvironment, resolveImageFixtureOrigin } from "../run-image-lifecycle-fixture.mjs";

const workflow = readFileSync(new URL("../../../../.github/workflows/runner-lifecycle-fixture.yml", import.meta.url), "utf8");
const pinnedProducerNodeVersion = /^  NODE_VERSION: ([0-9]+\.[0-9]+\.[0-9]+)$/m.exec(workflow)?.[1];
assert(pinnedProducerNodeVersion, "joined fixture must pin its sealed Node producer");
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

async function dnsDiagnostic(outcome = "accepted") {
  let elapsed = 0, bytes;
  const options = { now: () => 2_000_000_000_000 + elapsed, elapsedNow: () => elapsed,
    sleep: async (ms) => { elapsed += ms; }, writeDiagnostics: (value) => { bytes = value; },
    resolver: async () => {
      if (outcome === "resolver_error") throw new Error("synthetic resolver secret");
      if (outcome === "internal_error") elapsed = NaN;
      if (outcome === "invalid_answer") return [{ address: "synthetic invalid address", ttl: 120 }];
      if (outcome === "missing_or_excessive_answer") return Array(33).fill({ address: "104.16.0.34", ttl: 120 });
      return [{ address: "104.16.0.34", ttl: outcome === "ttl_floor_exhausted" ? 119 : 120 },
        { address: "104.16.1.34", ttl: 300 }];
    } };
  if (outcome === "resolver_timeout") Object.assign(options, {
    resolver: () => new Promise(() => {}),
    setTimer: (callback, ms) => { queueMicrotask(() => { elapsed += ms; callback(); }); return 1; },
    clearTimer: () => {}, cancelResolver: () => {},
  });
  try { await resolveImageFixtureOrigin(options); }
  catch (error) { assert.notEqual(outcome, "accepted", error.message); }
  assert(bytes, "the actual DNS producer must persist diagnostics before returning or throwing");
  assert.equal(JSON.parse(bytes).outcome, outcome);
  const diagnostic = JSON.parse(bytes);
  assert.equal(diagnostic.requiredMinimumTtlSeconds, 120);
  assert.equal(diagnostic.budgetMs, 125000);
  assert.equal(diagnostic.retryIntervalMs, 5000);
  assert.equal(diagnostic.runtime.node, process.versions.node);
  // Exercise real acquisition diagnostics, then model the sealed workflow's
  // runtime provenance. The unit-test process can use another Node 22 patch.
  diagnostic.runtime.node = pinnedProducerNodeVersion;
  return JSON.stringify(diagnostic);
}

function executeDnsExport(t, bytes, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fixture-dns-export-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceBase = join(root, "source"), output = join(sourceBase, "123-1-success"), evidence = join(output, "evidence");
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  chmodSync(sourceBase, 0o755);
  chmodSync(output, 0o700);
  mkdirSync(join(root, "bin"));
  const source = join(evidence, "01-dns-diagnostics.txt"), log = join(root, "calls.jsonl"), githubOutput = join(root, "github-output");
  writeFileSync(githubOutput, "");
  if (bytes !== null) {
    writeFileSync(source, bytes, { mode: 0o644 });
    if (options.fileMode !== undefined) chmodSync(source, options.fileMode);
    if (options.hardlink) linkSync(source, join(evidence, "hardlink.txt"));
    if (options.symlink) { rmSync(source); symlinkSync("02-dns-window.txt", source); }
  }
  if (options.directoryMode !== undefined) chmodSync(evidence, options.directoryMode);
  // Adjacent evidence is intentionally unsafe to publish; no directory or glob
  // export may accidentally include it, even when the fixture report is absent.
  writeFileSync(join(evidence, "02-dns-window.txt"), '{"addresses":["104.16.0.34"],"secret":"synthetic-never-export"}');
  writeFileSync(join(root, "bin", "sudo"), `#!${process.execPath}
const fs=require('fs'),cp=require('child_process'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='test') { const r=cp.spawnSync('/bin/test',args.slice(1)); process.exit(r.status ?? 1); }
if(args[0]==='realpath') { try { process.stdout.write(fs.realpathSync(args.at(-1))+'\\n'); if(${options.realpathFailure === true}) process.exit(2); } catch { process.exit(1); } }
else if(args[0]==='stat' && args[1]==='-c') {
  const path=args.at(-1),s=fs.lstatSync(path); const file=path.endsWith('/01-dns-diagnostics.txt');
  const values={u:file?${options.fileUid ?? 0}:0,g:file?${options.fileGid ?? 0}:0,a:file?${JSON.stringify(options.fileStatMode ?? null)}??(s.mode&0o7777).toString(8):(s.mode&0o7777).toString(8),h:s.nlink,s:s.size};
  process.stdout.write(args[2].replace(/%([ugahs])/g,(_,k)=>String(values[k]))+'\\n');
  if(${JSON.stringify(options.statFailure ?? null)} === (file?'file':path.endsWith('/evidence')?'evidence':'other')) process.exit(2);
} else if(args[0]==='cat') process.stdout.write(fs.readFileSync(args.at(-1)));
else throw new Error('unexpected privileged command');
`, { mode: 0o755 });
  // Only the unavailable Linux privilege/stat boundary is doubled. The actual
  // workflow Bash, filesystem objects, jq parser/schema, and output bytes run.
  const body = script("Export bounded sanitized DNS diagnostics only")
    .replaceAll("/tmp/api-migrator-fixture-results", sourceBase)
    .replaceAll("${{ github.run_id }}", "123").replaceAll("${{ github.run_attempt }}", "1")
    .replaceAll("${{ matrix.scenario }}", "success");
  const result = spawnSync("/bin/bash", ["-c", body], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, RUNNER_TEMP: root,
      GITHUB_OUTPUT: githubOutput, GITHUB_TOKEN: "synthetic-env-secret-never-export" } });
  const paths = readFileSync(githubOutput, "utf8").split("\n").filter((line) => line.startsWith("path=")).map((line) => line.slice(5));
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  return { result, paths, calls, root };
}

test("exports sanitized DNS outcomes from the sealed producer model without a fixture report", async (t) => {
  for (const outcome of ["accepted", "ttl_floor_exhausted", "resolver_timeout", "resolver_error", "missing_or_excessive_answer", "invalid_answer", "internal_error"]) {
    await t.test(outcome, async (t) => {
      const bytes = await dnsDiagnostic(outcome), { result, paths, root } = executeDnsExport(t, bytes);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(paths.length, 1);
      const exported = readFileSync(paths[0], "utf8");
      assert.deepEqual(JSON.parse(exported), JSON.parse(bytes));
      assert.doesNotMatch(exported, /104\.16\.|synthetic|addresses|resolvers|GITHUB_TOKEN/);
      assert.equal(statSync(paths[0]).mode & 0o777, 0o440);
      assert.equal(statSync(paths[0]).uid, process.getuid());
      assert.equal(readdirSync(root).filter((name) => name.startsWith("fixture-dns-")).length, 1);
      if (outcome === "accepted") {
        const entry = JSON.parse(exported).entries[0];
        assert.equal(entry.minimumTtlSeconds, 120);
        assert.equal(entry.maximumTtlSeconds, 300);
        assert.equal(entry.distinctTtlCount, 2);
      }
    });
  }
});

test("valid DNS artifacts model the sealed producer independently of the ambient Node 22 patch", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
  try {
    Object.defineProperty(process.versions, "node", { ...descriptor, value: "22.23.3" });
    const bytes = await dnsDiagnostic();
    assert.equal(JSON.parse(bytes).runtime.node, "22.23.2", "valid fixture must describe the sealed producer, not the test process");
    const { result, paths } = executeDnsExport(t, bytes);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(paths.length, 1);
    assert.equal(JSON.parse(readFileSync(paths[0], "utf8")).runtime.node, "22.23.2");
  } finally {
    Object.defineProperty(process.versions, "node", descriptor);
  }
});

test("missing pre-DNS evidence emits no artifact path", (t) => {
  const { result, paths } = executeDnsExport(t, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(paths, []);
});

test("DNS export refuses substituted or unbounded evidence without publishing a path", async (t) => {
  const bytes = await dnsDiagnostic();
  const cases = [
    ["symlink", { symlink: true }], ["hardlink", { hardlink: true }],
    ["wrong owner", { fileUid: 12001 }], ["wrong group", { fileGid: 12001 }],
    ["group writable", { fileMode: 0o664 }], ["world writable", { fileMode: 0o646 }],
    // macOS removes these special bits on ordinary temporary files, so inject
    // only the Linux metadata observation without changing local special modes.
    ["executable", { fileMode: 0o744 }], ["special mode", { fileStatMode: "4644" }],
    ["unreadable owner", { fileMode: 0o044 }], ["writable evidence directory", { directoryMode: 0o722 }],
    ["empty", { bytes: "" }], ["oversized", { bytes: "x".repeat(65537) }],
  ];
  for (const [name, options] of cases) await t.test(name, (t) => {
    const { result, paths, calls } = executeDnsExport(t, options.bytes ?? bytes, options);
    assert.notEqual(result.status, 0, name);
    assert.deepEqual(paths, []);
    assert(!calls.some((args) => args[0] === "cat"), `${name}: unsafe source must be refused before reading diagnostic bytes`);
  });
});

test("failed DNS path or metadata probes refuse even apparently valid partial output", async (t) => {
  const bytes = await dnsDiagnostic();
  for (const [name, options] of [["canonical path", { realpathFailure: true }],
    ["directory metadata", { statFailure: "evidence" }], ["file metadata", { statFailure: "file" }]]) {
    await t.test(name, (t) => {
      const { result, paths, calls } = executeDnsExport(t, bytes, options);
      assert.notEqual(result.status, 0, name);
      assert.deepEqual(paths, []);
      assert(!calls.some((args) => args[0] === "cat"), `${name}: failed observation must refuse before reading diagnostic bytes`);
    });
  }
});

test("DNS export strictly validates allowlisted JSON and strips duplicate-key shadow text", async (t) => {
  const bytes = await dnsDiagnostic(), valid = JSON.parse(bytes);
  const cases = [
    ["invalid JSON", "synthetic parser secret"], ["multiple documents", `${bytes}\n${bytes}`],
    ["raw address field", JSON.stringify({ ...valid, addresses: ["104.16.0.34"] })],
    ["raw resolver field", JSON.stringify({ ...valid, runtime: { ...valid.runtime, servers: ["synthetic resolver secret"] } })],
    ["raw entry field", JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], address: "104.16.0.34" }] })],
    ["unsafe version", JSON.stringify({ ...valid, runtime: { ...valid.runtime, cares: "synthetic version secret" } })],
    ["wrong producer Node patch", JSON.stringify({ ...valid, runtime: { ...valid.runtime, node: "22.23.3" } })],
    ["weakened floor", JSON.stringify({ ...valid, requiredMinimumTtlSeconds: 119 })],
    ["changed cadence", JSON.stringify({ ...valid, retryIntervalMs: 1 })],
    ["changed budget", JSON.stringify({ ...valid, budgetMs: 125001 })],
    ["hosted smoke budget", JSON.stringify({ ...valid, budgetMs: 90000 })],
    ["authorization", JSON.stringify({ ...valid, activationBlocked: false })],
    ["wrong attempts type", JSON.stringify({ ...valid, attempts: "1" })],
    ["nonsequential attempt", JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], attempt: 2 }] })],
    ["unsafe digest", JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], addressSetDigest: "synthetic digest secret" }] })],
  ];
  for (const [name, candidate] of cases) await t.test(name, (t) => {
    const { result, paths } = executeDnsExport(t, candidate);
    assert.notEqual(result.status, 0, name);
    assert.deepEqual(paths, []);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic|104\.16\./, "parser must not log raw evidence");
  });
  const shadowed = bytes.replace('"kind":', '"kind":"synthetic shadow secret","kind":');
  const { result, paths } = executeDnsExport(t, shadowed);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(paths.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(paths[0], "utf8")), valid);
  assert.doesNotMatch(readFileSync(paths[0], "utf8"), /synthetic shadow secret/);
});

test("DNS upload runs independently of report completion and cannot mask lifecycle or cleanup failure", () => {
  const exportBlock = workflow.split(/\n      - /).find((part) => part.startsWith("name: Export bounded sanitized DNS diagnostics only\n"));
  assert(exportBlock);
  assert.match(exportBlock, /if: always\(\) && steps\.runtime\.outputs\.sealed == 'true'/);
  const uploadBlock = workflow.split(/\n      - /).find((part) => part.startsWith("name: Upload bounded sanitized DNS diagnostics\n"));
  assert(uploadBlock);
  assert.match(uploadBlock, /if: always\(\) && steps\.dns_diagnostics\.outcome == 'success' && steps\.dns_diagnostics\.outputs\.path != ''/);
  assert.match(uploadBlock, /path: \$\{\{ steps\.dns_diagnostics\.outputs\.path \}\}/);
  assert.doesNotMatch(uploadBlock, /steps\.result|evidence\/|\*/);
  assert.doesNotMatch(workflow, /continue-on-error:/);
  assert.match(workflow, /if: always\(\) && steps\.result\.outcome == 'success'/);
});
