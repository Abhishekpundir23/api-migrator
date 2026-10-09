import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareBatchImage } from '../batch-image.mjs';

const image = 'node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436';

test('rendered controller wrapper permits metadata above 8 MiB but refuses files above 64 MiB', {
  skip: process.env.API_MIGRATOR_DOCKER_TEST !== '1', timeout: 90_000,
}, t => {
  const nowMs = Date.now();
  const prepared = prepareBatchImage({ projectId: 'project-32bf49a2-bd30-4956-850', runId: 'a'.repeat(32),
    sourceRevision: 'b'.repeat(40), sourceArchiveSha256: 'c'.repeat(64), bootImage: 'batch-debian-12-official-20261008-00',
    network: 'api-migrator-trial-net', subnetwork: 'api-migrator-trial-sub', deleteAt: nowMs + 1_800_000 }, { nowMs });
  const wrapper = prepared.job.taskGroups[0].taskSpec.runnables[0].script.text.split('\n').find(line => line.startsWith('(ulimit') && line.includes('run-batch-image-smoke.mjs'));
  assert(wrapper);
  // Controller body is a controlled write fixture; the generated wrapper, env,
  // inherited cap and real Linux kernel write refusal remain actual behavior.
  const script = `set -euo pipefail
ulimit -c 0
root=/tmp/controller-fixture
mkdir -p "$root/node/bin" "$root/ops/gcp-trial"
ln -s /usr/local/bin/node "$root/node/bin/node"
cd "$root"
image=synthetic fixture_uid=1000 fixture_gid=1000 controller_stop_at=1 DOCKER_CONFIG=/nonexistent DOCKER_HOST=unix:///nonexistent
run_phase() { shift; "$@"; }
trap 'cat "$root/controller.log" >&2' ERR
printf '%s' 'const fs=require("node:fs"),assert=require("node:assert/strict"),{spawnSync}=require("node:child_process");fs.writeFileSync("metadata",Buffer.alloc(9*1024*1024));assert.equal(fs.statSync("metadata").size,9437184);const child=spawnSync(process.execPath,["-e","require(\\"node:fs\\").writeFileSync(\\"over\\",Buffer.alloc(65*1024*1024))"]);assert(child.signal==="SIGXFSZ"||(child.status===1&&/EFBIG/.test(child.stderr.toString())));assert.equal(fs.statSync("over").size,67108864);console.log("controller_file_cap=passed");' > ops/gcp-trial/run-batch-image-smoke.mjs
# The synthetic .mjs fixture uses CommonJS explicitly without changing wrapper argv.
sed -i '1s/^/import {createRequire} from "node:module";const require=createRequire(import.meta.url);/' ops/gcp-trial/run-batch-image-smoke.mjs
${wrapper}
cat "$root/worker.log"
`;
  const id = execFileSync('docker', ['create', '--platform', 'linux/amd64', '--network', 'none', '--user', '1000:1000',
    '--cap-drop=all', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m', '--entrypoint', '/bin/bash', image, '-c', script], { encoding: 'utf8', timeout: 60000 }).trim();
  assert.match(id, /^[a-f0-9]{64}$/);
  t.after(() => {
    assert.equal(spawnSync('docker', ['rm', '--force', id], { timeout: 10000 }).status, 0);
    const left = spawnSync('docker', ['container', 'ls', '--all', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(left.status, 0); assert.equal(left.stdout.trim(), ''); t.diagnostic(`exact controller wrapper container ${id} verified absent`);
  });
  const result = spawnSync('docker', ['start', '--attach', id], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /controller_file_cap=passed/);
});

// Controlled download/npm boundaries only: execute the generated worker's real
// UID checks, archive checksum/extraction and inherited Linux file/process caps.
// A separate retained real-public-graph run validates actual npm installation.
test('rendered public worker permits required large tools, bounds files and selects only build workspaces', {
  skip: process.env.API_MIGRATOR_DOCKER_TEST !== '1', timeout: 90_000,
}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-image-worker-')); chmodSync(dir, 0o755);
  let id;
  t.after(() => {
    if (id) {
      const removed = spawnSync('docker', ['rm', '--force', id], { encoding: 'utf8', timeout: 10_000 });
      const left = spawnSync('docker', ['container', 'ls', '--all', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(removed.status, 0, removed.stderr); assert.equal(left.status, 0, left.stderr); assert.equal(left.stdout.trim(), '');
      t.diagnostic(`exact worker container ${id} verified absent`);
    }
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, 'source')); writeFileSync(join(dir, 'source', 'public.txt'), 'public synthetic fixture\n');
  const archive = execFileSync('tar', ['-czf', '-', '-C', dir, 'source'], { maxBuffer: 1_048_576, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  writeFileSync(join(dir, 'source.tar.gz'), archive);
  const nowMs = Date.now();
  const prepared = prepareBatchImage({ projectId: 'project-32bf49a2-bd30-4956-850', runId: 'a'.repeat(32),
    sourceRevision: 'b'.repeat(40), sourceArchiveSha256: createHash('sha256').update(archive).digest('hex'),
    bootImage: 'batch-debian-12-official-20261008-00', network: 'api-migrator-trial-net', subnetwork: 'api-migrator-trial-sub',
    deleteAt: nowMs + 1_800_000 }, { nowMs });
  const worker = prepared.job.taskGroups[0].taskSpec.runnables[0].script.text.match(/<<'BATCH_IMAGE_WORKER'\n([\s\S]*?)\nBATCH_IMAGE_WORKER\n/)?.[1];
  assert(worker, 'rendered public worker must exist');
  const script = `set -euo pipefail
ulimit -c 0
mkdir /tmp/public-worker
export HOME=/tmp/public-worker PATH=/usr/local/bin:/usr/bin:/bin
curl() { cp /fixtures/source.tar.gz source.tar.gz; }
npm() {
 /usr/local/bin/node -e 'const fs=require("node:fs");fs.appendFileSync(process.env.HOME+"/npm-argv.jsonl",JSON.stringify(process.argv.slice(1))+"\\n");fs.writeFileSync("required-build-tool",Buffer.alloc(9*1024*1024));' "$@"
}
${worker}
/usr/local/bin/node - <<'ASSERT_WORKER'
const assert=require('node:assert/strict'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
assert.equal(fs.statSync('required-build-tool').size,9*1024*1024);
const calls=fs.readFileSync(process.env.HOME+'/npm-argv.jsonl','utf8').trim().split('\\n').map(JSON.parse);
assert.deepEqual(calls,[['ci','--workspace','@api-migrator/engine','--workspace','@api-migrator/db','--workspace','@api-migrator/app','--workspace','@api-migrator/runner','--include-workspace-root','--ignore-scripts','--no-audit','--no-fund'],['run','build:packages']]);
assert.equal(spawnSync('/bin/bash',['-c','ulimit -f'],{encoding:'utf8'}).stdout.trim(),'65536');
assert.equal(spawnSync('/bin/bash',['-c','ulimit -u'],{encoding:'utf8'}).stdout.trim(),'128');
const over=spawnSync(process.execPath,['-e','require("node:fs").writeFileSync("over-cap",Buffer.alloc(65*1024*1024))']);
assert(over.signal==='SIGXFSZ'||(over.status===1&&/EFBIG/.test(over.stderr.toString())));assert.equal(fs.statSync('over-cap').size,64*1024*1024);
console.log('rendered_worker_contract=passed large_tool_bytes=9437184 max_file_bytes=67108864');
ASSERT_WORKER
`;
  id = execFileSync('docker', ['create', '--platform', 'linux/amd64', '--user', '1000:1000', '--network', 'none',
    '--cap-drop=all', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=768m', '--cpus=2',
    '--mount', `type=bind,src=${dir},dst=/fixtures,readonly`, '--entrypoint', '/bin/bash', image, '-c', script],
  { encoding: 'utf8', timeout: 60_000 }).trim();
  assert.match(id, /^[a-f0-9]{64}$/);
  const result = spawnSync('docker', ['start', '--attach', id], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1_048_576 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /rendered_worker_contract=passed large_tool_bytes=9437184 max_file_bytes=67108864/);
  t.diagnostic(result.stdout.trim());
});
