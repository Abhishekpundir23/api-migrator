import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as controller from '../run-batch-image-smoke.mjs';
import { hasBatchImageSummary } from '../batch-image-summary.mjs';

const args = ['--image', `sha256:${'a'.repeat(64)}`, '--uid', '12003', '--gid', '12003', '--deadline', String(Date.now() + 120000)];
async function invoke(run, argv = args) {
  assert.equal(typeof controller.runBatchImageCli, 'function');
  let stdout = '', stderr = '';
  const exit = await controller.runBatchImageCli(argv, { run, stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } });
  assert.equal(exit, 1); assert.equal(stderr, 'Batch image smoke failed.\n');
  assert(Buffer.byteLength(stdout) <= 1024); assert.equal(hasBatchImageSummary(stdout), false);
  assert.equal(stdout.split('\n').length, 2);
  assert(stdout.startsWith('API_MIGRATOR_BATCH_IMAGE_FAILURE '));
  const record = JSON.parse(stdout.slice('API_MIGRATOR_BATCH_IMAGE_FAILURE '.length));
  assert.deepEqual(Object.keys(record).sort(), ['exitCode', 'reason', 'schemaVersion', 'signal', 'stage']);
  return record;
}

test('CLI records last checkpoint without retaining unknown errors, aggregates or spoofed provenance', async () => {
  const secret = 'SECRET https://metadata/token\nAuthorization: Bearer ya29.synthetic-token\nHTTP/1.1 200 OK\n{"access_token":"synthetic-secret"}';
  for (const stage of ['controller_entry', 'admission', 'public_setup', 'registry_resolution', 'fixture_plan', 'fixture_ownership', 'root_metadata', 'container_metadata', 'prepare', 'install', 'migrate', 'verify', 'cleanup', 'summary_validation']) {
    for (const error of [Object.assign(Error(secret, { cause: Error(secret) }), { reason: 'output_limit', code: 'ETIMEDOUT', status: 153, signal: 'SIGXFSZ' }), new AggregateError([Error(secret)], secret)]) {
      const result = await invoke(async (_input, { checkpoint }) => { checkpoint(stage); throw error; });
      assert.deepEqual(result, { schemaVersion: 1, stage, reason: 'unexpected', exitCode: null, signal: null });
    }
  }
  assert.deepEqual(await invoke(() => assert.fail('invalid args cannot run'), ['SECRET']),
    { schemaVersion: 1, stage: 'controller_entry', reason: 'invalid_input', exitCode: null, signal: null });
  const invalid = await invoke(async (_input, { checkpoint }) => { checkpoint('SECRET'); });
  assert.equal(invalid.stage, 'controller_entry'); assert.equal(invalid.reason, 'unexpected');
});

// Substitute only the fixed preparation child's module body, not its lifecycle:
// real detached processes, pipes, close events, limits and group cleanup run.
test('preparation retains actual close code/signal and bounded failure precedence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'batch-image-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = cp.spawn;
  for (const [code, duration, reason, exitCode, signal] of [
    ['process.exit(23)', 5000, 'subprocess_failed', 23, null],
    ['process.exit(153)', 5000, 'subprocess_failed', 153, null],
    ["process.kill(process.pid,'SIGTERM')", 5000, 'subprocess_failed', null, 'SIGTERM'],
    ["setInterval(()=>{},1000)", 100, 'deadline_exhausted', null, 'SIGKILL'],
    ["process.stdout.write('S'.repeat(1100000));setInterval(()=>{},1000)", 5000, 'output_limit', null, 'SIGKILL'],
    ["process.stderr.write('SECRET'.repeat(12000));setInterval(()=>{},1000)", 5000, 'diagnostic_limit', null, 'SIGKILL'],
    ["process.stdout.write('SECRET')", 5000, 'invalid_output', 0, null],
  ]) {
    let pid;
    cp.spawn = (_file, _args, options) => { const child = original(process.execPath, ['-e', code], options); pid = child.pid; return child; };
    syncBuiltinESMExports();
    try {
      const record = await invoke(async (_input, { checkpoint }) => { checkpoint('public_setup'); await controller.prepareBatchImageWorkspace(root, { deadline: Date.now() + duration }); });
      assert.deepEqual(record, { schemaVersion: 1, stage: 'public_setup', reason, exitCode, signal });
      assert.throws(() => process.kill(-pid, 0), e => e.code === 'ESRCH');
    } finally { cp.spawn = original; syncBuiltinESMExports(); }
  }
});

test('unverified preparation cleanup overrides timeout without inventing a signal or deleting sources', async t => {
  const root = mkdtempSync(join(tmpdir(), 'batch-image-cleanup-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const originalSpawn = cp.spawn, originalKill = process.kill;
  let pid;
  cp.spawn = (_file, _args, options) => { const child = originalSpawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options); pid = child.pid; return child; };
  syncBuiltinESMExports();
  // Simulate only an inconclusive absence observation for this exact group;
  // actual termination still goes to the real child, never another process.
  process.kill = (target, signal) => target === -pid && signal === 0 ? true : originalKill(target, signal);
  try {
    const result = await invoke(async (_input, { checkpoint }) => {
      checkpoint('public_setup');
      await controller.prepareBatchImageWorkspace(root, { deadline: Date.now() + 100 });
    });
    assert.deepEqual(result, { schemaVersion: 1, stage: 'public_setup', reason: 'cleanup_unverified', exitCode: null, signal: 'SIGKILL' });
  } finally { cp.spawn = originalSpawn; process.kill = originalKill; syncBuiltinESMExports(); }
  assert.throws(() => process.kill(-pid, 0), e => e.code === 'ESRCH');
});

test('known validation and admission failures use typed reasons and CLI success keeps canonical bytes', async () => {
  const host = { platform: 'darwin', uid: 1000, dockerHost: 'unix:///var/run/docker.sock' };
  const record = await invoke(async (input, { checkpoint }) => { checkpoint('admission'); controller.assertBatchImageAdmission(input, host); });
  assert.deepEqual(record, { schemaVersion: 1, stage: 'admission', reason: 'admission_denied', exitCode: null, signal: null });
  let stdout = '', stderr = '';
  assert.equal(await controller.runBatchImageCli(args, { run: async () => ({ z: 1, a: 2 }), stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } }), 0);
  assert.equal(stdout, 'API_MIGRATOR_BATCH_IMAGE_SUMMARY {"a":2,"z":1}\n'); assert.equal(stderr, '');
});

test('failure encoder refuses arbitrary fields and enums before serialization', async () => {
  const module = await import('../batch-image-failure.mjs').catch(() => null);
  assert(module, 'bounded failure encoder must exist');
  const valid = { stage: 'controller_entry', reason: 'controller_unavailable', exitCode: 153, signal: null };
  const line = module.encodeBatchImageFailure(valid);
  assert.deepEqual(JSON.parse(line.slice('API_MIGRATOR_BATCH_IMAGE_FAILURE '.length)), { schemaVersion: 1, ...valid });
  for (const change of [{ stage: 'SECRET' }, { reason: 'SECRET' }, { signal: 'SECRET' }, { exitCode: -1 }, { exitCode: 256 }, { exitCode: '1' }, { message: 'SECRET' }]) {
    assert.throws(() => module.encodeBatchImageFailure({ ...valid, ...change }));
  }
});
