import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareTrial, renderWorker } from "../bootstrap.mjs";

const NOW = 2_000_000_000_000;
const request = (overrides = {}) => ({ projectId: "project-32bf49a2-bd30-4956-850",
  runId: "abcdef0123456789abcdef0123456789", sourceRevision: "a".repeat(40),
  sourceArchiveSha256: "b".repeat(64), bootImage: "debian-12-bookworm-v20260908",
  network: "api-migrator-trial-net", subnetwork: "api-migrator-trial-subnet",
  egress: "existing-nat", deleteAt: NOW + 3_600_000, ...overrides });
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("bootstrap bytes are deterministically bound to the final non-authorizing plan", () => {
  const result = prepareTrial(request(), { nowMs: NOW });
  assert.equal(result.plan.startup.sha256, sha(result.script));
  assert.equal(result.plan.executionBlocked, true);
  assert.equal(result.plan.billingApprovalRequired, true);
  assert.equal(result.plan.activationBlocked, true);
  assert.deepEqual(prepareTrial(request(), { nowMs: NOW }), result);
  assert.notEqual(prepareTrial(request({ sourceRevision: "d".repeat(40) }), { nowMs: NOW }).script, result.script);
  const syntax = spawnSync("bash", ["-n"], { input: result.script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

for (const extra of [{ startupScriptSha256: "c".repeat(64) }, { execute: true }, { projectId: "work-project" },
  { sourceRevision: "main" }, { sourceArchiveSha256: "bad" }, { deleteAt: NOW }]) {
  test(`bootstrap rejects unsafe input ${JSON.stringify(extra)}`, () => {
    assert.throws(() => prepareTrial(request(extra), { nowMs: NOW }), /invalid|unknown|scope|deadline/);
  });
}
test("bootstrap rejects accessors before invoking caller code", () => {
  let calls = 0;
  const value = request();
  Object.defineProperty(value, "runId", { enumerable: true, get() { calls++; return "f".repeat(32); } });
  assert.throws(() => prepareTrial(value, { nowMs: NOW }), /accessor|invalid/);
  assert.equal(calls, 0);
});
test("bootstrap snapshots the request once so script and plan cannot diverge", () => {
  let reads = 0;
  const value = new Proxy(request(), { getOwnPropertyDescriptor(target, key) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (key === "sourceRevision") descriptor.value = ++reads <= 3 ? "a".repeat(40) : "d".repeat(40);
    return descriptor;
  } });
  const artifact = prepareTrial(value, { nowMs: NOW });
  assert.equal(artifact.plan.source.revision, "a".repeat(40));
  assert.equal(artifact.plan.startup.sha256, sha(artifact.script));
});
test("render-only CLI prepares a bound artifact without cloud tools", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gcp-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "input.json");
  writeFileSync(config, JSON.stringify(request({ deleteAt: Date.now() + 3_600_000 })));
  const cli = fileURLToPath(new URL("../prepare-trial.mjs", import.meta.url));
  const invoke = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { PATH: root }, timeout: 5000 });
  const result = invoke(["--input", config]);
  assert.equal(result.status, 0, result.stderr);
  const artifact = JSON.parse(result.stdout);
  assert.equal(artifact.plan.startup.sha256, sha(artifact.script));
  for (const args of [[], ["--input", config, "--execute"], ["--input", root]]) {
    const bad = invoke(args); assert.equal(bad.status, 2); assert.equal(bad.stdout, "");
  }
});

const dockerEnabled = process.env.API_MIGRATOR_DOCKER_TEST === "1";
function inContainer(t, script, user = "65534:65534", fixture = null) {
  const name = `api-migrator-gcp-test-${randomUUID()}`;
  t.after(() => {
    spawnSync("docker", ["rm", "-f", name], { timeout: 15_000, encoding: "utf8" });
    const check = spawnSync("docker", ["ps", "-aq", "--filter", `name=^/${name}$`], { timeout: 15_000, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr); assert.equal(check.stdout.trim(), "");
  });
  return spawnSync("docker", ["run", "--rm", "--name", name, "--platform", "linux/amd64", "--network", "none",
    ...(fixture ? ["--mount", `type=bind,source=${fixture},target=/fixtures,readonly`,
      "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER"] : ["--read-only"]),
    "--tmpfs", "/tmp:rw,nosuid,exec,size=128m", "--tmpfs", "/var/lib:rw,nosuid,exec,size=256m",
    "--memory", "512m", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", user, "-i",
    "node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436", "bash", "-se"],
  { input: script, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
}

test("guest bootstrap refuses an expired deadline before touching the system", { skip: !dockerEnabled }, (t) => {
  const script = prepareTrial(request({ deleteAt: 1_003_600_000 }), { nowMs: 1_000_000_000 }).script;
  const result = inContainer(t, script, "0:0");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deadline/);
  assert(!result.stdout.includes('"status":"passed"'));
});

function sourceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gcp-worker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "repo/packages/engine"), { recursive: true });
  mkdirSync(join(root, "repo/packages/console"), { recursive: true });
  mkdirSync(join(root, "repo/packages/engine/test"), { recursive: true });
  mkdirSync(join(root, "repo/fixtures/tsx"), { recursive: true });
  const pkg = { name: "trial-fixture", version: "1.0.0", private: true, workspaces: ["packages/*"], devDependencies: { tsx: "file:fixtures/tsx" } };
  const engine = { name: "@api-migrator/engine", version: "1.0.0", scripts: {
    build: "node -e 'if(process.getuid()===0 || process.env.GITHUB_TOKEN) process.exit(80); require(\"fs\").writeFileSync(\"built\",\"yes\"); require(\"fs\").writeFileSync(\"oversize-lockfile\",\"\"); require(\"fs\").truncateSync(\"oversize-lockfile\",32*1024*1024+1)'",
    test: "node -e 'console.error(\"profile must select its own bounded test runner\"); process.exit(89)'" } };
  writeFileSync(join(root, "repo/package.json"), JSON.stringify(pkg));
  writeFileSync(join(root, "repo/packages/engine/package.json"), JSON.stringify(engine));
  writeFileSync(join(root, "repo/packages/engine/test/smoke.test.ts"), `const test = require("node:test"); const assert = require("node:assert/strict"); const fs = require("node:fs");
test("engine fixture built without unrelated workspace", () => { assert.equal(fs.readFileSync("built", "utf8"), "yes"); assert.equal(fs.existsSync("../../node_modules/@api-migrator/console"), false, "unrelated workspace installed"); });`);
  // The fixture contains plain JS only. Its local loader needs no registry access;
  // the separate real-repository Linux check exercises the real tsx dependency.
  writeFileSync(join(root, "repo/fixtures/tsx/package.json"), JSON.stringify({ name: "tsx", version: "1.0.0", type: "module", exports: "./index.mjs" }));
  writeFileSync(join(root, "repo/fixtures/tsx/index.mjs"), "export {};\n");
  writeFileSync(join(root, "repo/packages/console/package.json"), JSON.stringify({ name: "@api-migrator/console", version: "1.0.0" }));
  writeFileSync(join(root, "repo/package-lock.json"), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3,
    requires: true, packages: { "": pkg, "packages/engine": { name: engine.name, version: engine.version },
      "packages/console": { name: "@api-migrator/console", version: "1.0.0" },
      "fixtures/tsx": { name: "tsx", version: "1.0.0" }, "node_modules/tsx": { resolved: "fixtures/tsx", link: true },
      "node_modules/@api-migrator/console": { resolved: "packages/console", link: true },
      "node_modules/@api-migrator/engine": { resolved: "packages/engine", link: true } } }));
  const tar = spawnSync("tar", ["-czf", "-", "-C", root, "repo"], { maxBuffer: 1024 * 1024 });
  assert.equal(tar.status, 0);
  return tar.stdout;
}

for (const validHash of [true, false]) {
  test(`unprivileged worker ${validHash ? "builds and tests" : "refuses corrupt source"} in networkless Docker`, { skip: !dockerEnabled }, (t) => {
    const bytes = sourceFixture(t);
    const value = request({ sourceArchiveSha256: validHash ? sha(bytes) : "0".repeat(64) });
    const worker = renderWorker(value, { nowMs: NOW });
    // Only the external download is replaced; tar, sha256sum, npm, Node and uid are real.
    const setup = `mkdir -p /tmp/home /tmp/bin\nexport HOME=/tmp/home\nprintf '%s' '${bytes.toString("base64")}' | base64 -d > /tmp/archive\n` +
      `printf '%s\\n' '#!/bin/bash' 'while [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then cp /tmp/archive "$2"; exit; fi; shift; done; exit 90' > /tmp/bin/curl\nchmod 755 /tmp/bin/curl\nexport PATH=/tmp/bin:/usr/local/bin:/usr/bin:/bin\n`;
    const result = inContainer(t, setup + worker);
    if (validHash) assert.equal(result.status, 0, result.stderr + result.stdout);
    else { assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /checksum|FAILED/); }
  });
}

test("root bootstrap hands real verified runtime to an unprivileged worker and refuses a second run", { skip: !dockerEnabled }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "gcp-root-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, "node.tar.xz");
  const download = spawnSync("curl", ["--fail", "--silent", "--show-error", "--proto", "=https", "--max-time", "90",
    "--max-filesize", "67108864", "--output", archive, "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz"], { timeout: 95_000, encoding: "utf8" });
  assert.equal(download.status, 0, download.stderr);
  assert.equal(sha(readFileSync(archive)), "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307");
  const unpacked = spawnSync("xz", ["-dc", archive], { maxBuffer: 256 * 1024 * 1024, timeout: 30_000 });
  assert.equal(unpacked.status, 0);
  writeFileSync(join(root, "node.tar"), unpacked.stdout);
  const source = sourceFixture(t);
  writeFileSync(join(root, "source.tar.gz"), source);
  chmodSync(root, 0o755);
  chmodSync(join(root, "source.tar.gz"), 0o644);
  const value = request({ sourceArchiveSha256: sha(source), deleteAt: Date.now() + 3_600_000 });
  writeFileSync(join(root, "startup.sh"), prepareTrial(value).script);
  // OS packages/downloads are substituted; the archive, hash check, tar permissions,
  // account creation, privilege drop, pinned Node, npm and repository phases are real.
  const setup = `printf '%s\\n' '#!/bin/bash' 'exit 0' > /usr/bin/apt-get\n` +
    `printf '%s\\n' '#!/bin/bash' 'cat /fixtures/node.tar' > /usr/bin/xz\nchmod 755 /usr/bin/xz\n` +
    `printf '%s\\n' '#!/bin/bash' 'while [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then dest=$2; shift 2; else url=$1; shift; fi; done' 'case "$url" in https://nodejs.org/*) cp /fixtures/node.tar.xz "$dest";; https://codeload.github.com/*) cp /fixtures/source.tar.gz "$dest";; *) exit 90;; esac' > /usr/bin/curl\n` +
    `chmod 755 /usr/bin/apt-get /usr/bin/curl\nexport GITHUB_TOKEN=fixture-must-not-reach-worker\n` +
    `bash /fixtures/startup.sh || { code=$?; cat /var/lib/api-migrator-trial-${value.runId}/worker.log 2>/dev/null; exit "$code"; }\n` +
    `set +e\nbash /fixtures/startup.sh > /tmp/retry.log 2>&1\ncode=$?\nset -e\n[ "$code" -eq 73 ]\nprintf 'REPEAT_REFUSED\\n'\n`;
  const result = inContainer(t, setup, "0:0", root);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const lines = result.stdout.split("\n").filter((s) => s.startsWith("API_MIGRATOR_TRIAL_RESULT "));
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0].slice("API_MIGRATOR_TRIAL_RESULT ".length));
  assert.equal(record.status, "passed"); assert.equal(record.phase, "complete");
  assert.equal(record.runId, value.runId); assert.equal(record.sourceArchiveSha256, sha(source));
  assert.match(result.stdout, /REPEAT_REFUSED/);
});
