import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareBatch } from "../batch.mjs";

const enabled = process.env.API_MIGRATOR_DOCKER_TEST === "1";
const image = "node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Breaks caught: skipping the metadata controls, dropping runuser/env isolation,
// swallowing worker failure/timeout, or removing the trusted EXIT log emitter.
// Only downloads, apt and the kernel metadata boundary are substituted. In
// particular these tests do not claim that Docker proves GCE nft enforcement.
test("full generated Batch runnable executes native privilege/runtime/log contracts", { skip: !enabled, timeout: 240_000 }, async (t) => {
  const fixtures = mkdtempSync(join(tmpdir(), "batch-native-"));
  chmodSync(fixtures, 0o755);
  t.after(() => rmSync(fixtures, { recursive: true, force: true }));
  const archive = join(fixtures, "node.tar.xz");
  const download = spawnSync("curl", ["--fail", "--silent", "--show-error", "--proto", "=https", "--max-time", "90",
    "--max-filesize", "67108864", "--output", archive, "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz"], { timeout: 95_000, encoding: "utf8" });
  assert.equal(download.status, 0, download.stderr);
  assert.equal(sha(readFileSync(archive)), "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307");
  const unpack = spawnSync("xz", ["-dc", archive], { timeout: 30_000, maxBuffer: 256 * 1024 * 1024 });
  assert.equal(unpack.status, 0);
  writeFileSync(join(fixtures, "node.tar"), unpack.stdout);

  for (const scenario of ["success", "worker-failure", "worker-timeout", "root-metadata-failure", "worker-metadata-access", "nft-failure"]) {
    await t.test(scenario, { timeout: 60_000 }, (st) => {
      const dir = join(fixtures, scenario);
      mkdirSync(join(dir, "repo/packages/engine/test"), { recursive: true });
      mkdirSync(join(dir, "repo/fixtures/tsx"), { recursive: true });
      const build = `const fs=require('node:fs'); if(process.getuid()===0 || process.env.GITHUB_TOKEN || !fs.existsSync('/tmp/native-boundary/root-control') || !fs.existsSync('/tmp/native-boundary/nft-ready') || !fs.existsSync('/tmp/native-boundary/probe-v4') || !fs.existsSync('/tmp/native-boundary/probe-v6')) process.exit(91); console.log('NATIVE_WORKER_UID='+process.getuid()); console.log('WORKER_STARTED'); ${scenario === "worker-failure" ? "process.exit(37);" : scenario === "worker-timeout" ? "setTimeout(()=>{},30000);" : "fs.writeFileSync('built','yes');"}`;
      const pkg = { name: "batch-fixture", version: "1.0.0", private: true, workspaces: ["packages/*"], devDependencies: { tsx: "file:fixtures/tsx" } };
      const engine = { name: "@api-migrator/engine", version: "1.0.0", scripts: { build: "node build.cjs" } };
      writeFileSync(join(dir, "repo/package.json"), JSON.stringify(pkg));
      writeFileSync(join(dir, "repo/packages/engine/package.json"), JSON.stringify(engine));
      writeFileSync(join(dir, "repo/packages/engine/build.cjs"), build);
      writeFileSync(join(dir, "repo/packages/engine/test/smoke.test.ts"), `const test=require('node:test');const assert=require('node:assert/strict');test('native fixture build completed',()=>assert.equal(require('node:fs').readFileSync('built','utf8'),'yes'));`);
      writeFileSync(join(dir, "repo/fixtures/tsx/package.json"), JSON.stringify({ name: "tsx", version: "1.0.0", type: "module", exports: "./index.mjs" }));
      writeFileSync(join(dir, "repo/fixtures/tsx/index.mjs"), "export {};\n");
      writeFileSync(join(dir, "repo/package-lock.json"), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
        packages: { "": pkg, "packages/engine": { name: engine.name, version: engine.version }, "fixtures/tsx": { name: "tsx", version: "1.0.0" },
          "node_modules/tsx": { resolved: "fixtures/tsx", link: true }, "node_modules/@api-migrator/engine": { resolved: "packages/engine", link: true } } }));
      const tar = spawnSync("tar", ["-czf", "-", "-C", dir, "repo"], { maxBuffer: 1024 * 1024 });
      assert.equal(tar.status, 0);
      writeFileSync(join(dir, "source.tar.gz"), tar.stdout);
      chmodSync(dir, 0o755);
      chmodSync(join(dir, "source.tar.gz"), 0o644);
      const now = Date.now();
      const runId = "abcdef0123456789abcdef0123456789";
      const request = { projectId: "project-32bf49a2-bd30-4956-850", runId, sourceRevision: "a".repeat(40), sourceArchiveSha256: sha(tar.stdout),
        bootImage: "batch-debian-12-official-20260914-00-p00", network: "api-migrator-trial-batch", subnetwork: "api-migrator-trial-batch", deleteAt: now + 3_600_000 };
      const artifact = prepareBatch(request, { nowMs: now });
      writeFileSync(join(dir, "startup.sh"), artifact.job.taskGroups[0].taskSpec.runnables[0].script.text);
      const stub = (name, body) => `printf '%s' '${Buffer.from("#!/bin/bash\nset -euo pipefail\n" + body).toString("base64")}' | base64 -d > /usr/bin/${name}\nchmod 755 /usr/bin/${name}\n`;
      const setup = `mkdir -m 0777 /tmp/native-boundary\n` +
        stub("apt-get", "exit 0\n") + stub("xz", "cat /fixtures/node.tar\n") +
        stub("nft", `[[ "$*" = '-f -' ]] || exit 92\nrules=$(cat)\nuid=$(id -u ambabcdef0123456789)\n[[ "$rules" = *"meta skuid $uid ip daddr 169.254.169.254 reject"* && "$rules" = *"meta skuid $uid ip6 daddr fd20:ce::254 reject"* && "$rules" = *'udp dport 53 accept'* && "$rules" = *'tcp dport 53 accept'* ]] || exit 93\n[ -f /tmp/native-boundary/root-control ] || exit 94\n${scenario === "nft-failure" ? "exit 86" : "touch /tmp/native-boundary/nft-ready"}\n`) +
        stub("curl", `dest=; url=\nwhile [ "$#" -gt 0 ]; do case "$1" in --output) dest=$2; shift 2;; *) url=$1; shift;; esac; done\ncase "$url" in\n http://169.254.169.254/*|http://\\[fd20:ce::254\\]/*)\n  if [ "$(id -u)" -eq 0 ]; then touch /tmp/native-boundary/root-control; printf '${scenario === "root-metadata-failure" ? "503" : "200"}'; exit 0; fi\n  [ -f /tmp/native-boundary/nft-ready ] || exit 95\n  case "$url" in http://169.254.169.254/*) touch /tmp/native-boundary/probe-v4;; *) touch /tmp/native-boundary/probe-v6;; esac\n  exit ${scenario === "worker-metadata-access" ? "0" : "7"};;\n https://nodejs.org/*) cp /fixtures/node.tar.xz "$dest";;\n https://codeload.github.com/*)\n  [ "$(id -u)" -ne 0 ] && [ -f /tmp/native-boundary/probe-v4 ] && [ -f /tmp/native-boundary/probe-v6 ] || exit 96\n  touch /tmp/native-boundary/source-requested; cp /fixtures/${scenario}/source.tar.gz "$dest";;\n *) exit 90;; esac\n`) +
        (scenario === "worker-timeout" ? `mv /usr/bin/timeout /usr/bin/native-timeout\n` + stub("timeout", `if [ "\${3:-}" = 1200 ]; then set -- "$1" "$2" 2 "\${@:4}"; fi\nexec /usr/bin/native-timeout "$@"\n`) : "") +
        `export GITHUB_TOKEN=must-not-reach-worker\nset +e\nbash /fixtures/${scenario}/startup.sh\ncode=$?\nset -e\nif [ -e /tmp/native-boundary/source-requested ]; then echo SOURCE_REQUESTED; fi\nexit "$code"\n`;
      const name = `batch-native-${randomUUID()}`;
      st.after(() => {
        spawnSync("docker", ["rm", "-f", name], { encoding: "utf8", timeout: 15_000 });
        const check = spawnSync("docker", ["ps", "-aq", "--filter", `name=^/${name}$`], { encoding: "utf8", timeout: 15_000 });
        assert.equal(check.status, 0, check.stderr); assert.equal(check.stdout.trim(), "");
      });
      const result = spawnSync("docker", ["run", "--rm", "--name", name, "--platform", "linux/amd64", "--network", "none",
        "--mount", `type=bind,source=${fixtures},target=/fixtures,readonly`, "--tmpfs", "/tmp:rw,nosuid,exec,size=128m",
        "--tmpfs", "/var/lib:rw,nosuid,exec,size=256m", "--memory", "512m", "--pids-limit", "256", "--cap-drop", "ALL",
        ...["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"].flatMap((cap) => ["--cap-add", cap]),
        "--security-opt", "no-new-privileges", "--user", "0:0", "-i", image, "bash", "-se"],
      { input: setup, encoding: "utf8", timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
      const diagnostic = result.stderr + result.stdout;
      const expected = { success: 0, "worker-failure": 37, "worker-timeout": 124, "root-metadata-failure": 83, "worker-metadata-access": 84, "nft-failure": 86 }[scenario];
      assert.equal(result.status, expected, diagnostic);
      const records = result.stdout.split("\n").filter((line) => line.startsWith("API_MIGRATOR_BATCH_RESULT "));
      if (expected === 83 || expected === 84 || expected === 86) {
        assert.equal(records.length, 0, "pre-worker failures must not report worker success");
        assert.doesNotMatch(result.stdout, /SOURCE_REQUESTED/);
        return;
      }
      assert.match(result.stdout, /SOURCE_REQUESTED/);
      assert.equal(records.length, 1, diagnostic);
      const record = JSON.parse(records[0].slice("API_MIGRATOR_BATCH_RESULT ".length));
      const chunks = result.stdout.split("\n").filter((line) => line.startsWith("API_MIGRATOR_BATCH_LOG "))
        .map((line) => JSON.parse(line.slice("API_MIGRATOR_BATCH_LOG ".length)));
      chunks.forEach((chunk, index) => { assert.equal(chunk.index, index); assert.equal(chunk.runId, runId); });
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, "base64")));
      assert.equal(record.logSha256, sha(bytes)); assert.equal(record.logBytes, bytes.length); assert.equal(record.logChunks, chunks.length);
      assert.equal(record.exitCode, expected); assert.equal(record.status, expected === 0 ? "passed" : "failed");
      assert.equal(record.phase, expected === 0 ? "complete" : "engine_smoke");
      assert.equal(record.runId, runId); assert.equal(record.sourceRevision, request.sourceRevision); assert.equal(record.sourceArchiveSha256, request.sourceArchiveSha256);
      assert.match(bytes.toString(), /NATIVE_WORKER_UID=[1-9][0-9]*\nWORKER_STARTED/);
      if (expected === 0) assert.match(bytes.toString(), /# tests 1[\s\S]*# pass 1[\s\S]*# fail 0/);
    });
  }
});
