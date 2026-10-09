import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../../publication-runner/deployment/lib.mjs';
import { hasBatchImageSummary } from '../batch-image-summary.mjs';
import { prepareFixtureWorkspace } from '../../publication-runner/image/fixture-phases.mjs';
import { verifyFixtureIdentity } from '../../../scripts/test-git-identity.mjs';
const load = async () => { const m = await import('../run-batch-image-smoke.mjs').catch(() => null); assert(m, 'image controller must exist'); return m; };
const D = c => `sha256:${c.repeat(64)}`;

test('bounded public preparation refuses expiry and kills a hung setup process group including descendants', async t => {
  const { prepareBatchImageWorkspace } = await load();
  assert.equal(typeof prepareBatchImageWorkspace, 'function', 'bounded setup subprocess implementation must exist');
  const root = mkdtempSync(join(tmpdir(), 'batch-image-setup-group-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(prepareBatchImageWorkspace(root, { deadline: Date.now() - 1 }), /deadline/);
  assert.deepEqual(readdirSync(root), []);
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('descendant.pid',String(child.pid));setInterval(()=>{},1000);\n`, { mode: 0o755 });
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const originalPath = process.env.PATH; process.env.PATH = bin;
  try {
    await assert.rejects(prepareBatchImageWorkspace(workspace, { deadline: Date.now() + 1000 }), /deadline|failed/);
    const pid = Number(readFileSync(join(workspace, 'checkout/descendant.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH', 'descendant must actually be gone');
    assert.equal(existsSync(join(workspace, 'plan.json')), false);
  } finally { process.env.PATH = originalPath; }
});

test('optional setup deadline refuses expired work before mutation and bounds npm and identity subprocesses', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'batch-image-deadline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => prepareFixtureWorkspace(root, { deadline: Date.now() - 1 }), /deadline/);
  assert.deepEqual(readdirSync(root), []);
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const file of ['npm', 'git']) writeFileSync(join(bin, file), '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o755 });
  const fixture = join(root, 'fixture'); mkdirSync(fixture);
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    assert.throws(() => prepareFixtureWorkspace(fixture, { deadline: Date.now() + 150 }), e => e.code === 'ETIMEDOUT');
    assert.throws(() => verifyFixtureIdentity(root, { PATH: bin }, false, { deadline: Date.now() + 150 }), e => e.code === 'ETIMEDOUT');
  } finally { process.env.PATH = originalPath; }
});

test('controller rejects non-root, foreign daemon, expired deadline and wrong identity before execution', async () => {
  const { assertBatchImageAdmission, parseBatchImageArgs } = await load();
  const input = { image: D('a'), uid: 12003, gid: 12003, deadline: 100_000 };
  const host = { platform: 'linux', uid: 0, now: 1, dockerHost: 'unix:///var/run/docker.sock',
    info: { OSType: 'linux', CgroupVersion: '2', SecurityOptions: ['name=seccomp'] } };
  assert.doesNotThrow(() => assertBatchImageAdmission(input, host));
  for (const change of [{ platform: 'darwin' }, { uid: 1000 }, { now: 100_000 }, { dockerHost: 'tcp://remote:2375' },
    { info: { ...host.info, SecurityOptions: ['name=rootless'] } }, { info: { ...host.info, CgroupVersion: '1' } }])
    assert.throws(() => assertBatchImageAdmission(input, { ...host, ...change }));
  for (const change of [{ uid: 0 }, { gid: 0 }, { image: 'runner:tag' }, { deadline: Infinity }, { deadline: 4_000_000 }])
    assert.throws(() => assertBatchImageAdmission({ ...input, ...change }, host));
  assert.deepEqual(parseBatchImageArgs(['--image', D('a'), '--uid', '12003', '--gid', '12003', '--deadline', '100000']), input);
  for (const args of [[], ['--image', D('a'), '--command', 'true'], ['--uid', '1', '--uid', '2'],
    ['--image', D('a'), '--uid', '0', '--gid', '1', '--deadline', '100000']]) assert.throws(() => parseBatchImageArgs(args));
});

// Real phase protocol and filesystem evidence; only the external container
// boundary is substituted here. A wrong digest cannot manufacture the report.
test('controller sequences exact phases, actual-image metadata probe and owned cleanup before evidence', async (t) => {
  const { runBatchImagePhases } = await load();
  for (const scenario of ['success', 'root-metadata-failure', 'metadata-access', 'phase-failure', 'bad-digest', 'timeout', 'cleanup-failure', 'missing-report']) {
    await t.test(scenario, async () => {
      const root = mkdtempSync(join(tmpdir(), 'batch-image-unit-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const paths = Object.fromEntries(['installation', 'output', 'dependencies', 'result'].map(n => [n, join(root, n)]));
      for (const path of Object.values(paths)) mkdirSync(path);
      paths.planPath = join(root, 'plan.json'); paths.sourcePath = join(root, 'source.bundle');
      const plan = { digest: D('b'), plan: { job: { id: `previewjob_${'c'.repeat(64)}` } } };
      const evidence = { planDigest: D('b'), output: { preflightId: `pf_${'d'.repeat(64)}`, artifactDigest: D('e'), candidateTreeSha: 'f'.repeat(40) },
        checks: Object.fromEntries(['install', 'typecheck', 'test', 'lint', 'runtime'].map(n => [n, { status: 'passed' }])),
        report: { verification: { ok: true, skipped: false }, summary: { review: 0 }, manifest: { deployment: { kind: 'long-running' } }, entries: [] }, blockers: [] };
      const text = canonicalJson(evidence), digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
      let clock = 1000, cleaned = false;
      const calls = [], checkpoints = [];
      const executor = { execute(request) {
        calls.push(request);
        assert(request.timeoutMs > 0 && request.timeoutMs <= 40_000);
        assert.equal(request.image, D('a'));
        assert(request.dockerArgs.includes('12003:12003'));
        if (request.dockerArgs.includes('/usr/local/bin/node')) {
          assert.equal(request.network, 'host');
          return scenario === 'metadata-access' ? 'metadata_reachable\n' : 'metadata_denied\n';
        }
        if (scenario === 'phase-failure') throw Error('phase failed');
        if (scenario === 'timeout') clock = 200_000;
        const outputs = { prepare: `runner_phase=prepare status=passed prepared_state_digest=${D('1')}\n`,
          install: `runner_phase=install status=passed prepared_state_digest=${D(scenario === 'bad-digest' ? '9' : '1')} install_state_digest=${D('2')}\n`,
          migrate: `runner_phase=migrate status=passed dependency_state_digest=${D('3')}\n`,
          verify: `runner_phase=verify status=passed evidence_digest=${digest} preflight_id=${evidence.output.preflightId}\n` };
        if (request.phase === 'verify' && scenario !== 'missing-report') writeFileSync(join(paths.result, 'runner-evidence.json'), text);
        return outputs[request.phase];
      }, assertCleanupComplete() { if (scenario === 'cleanup-failure') throw Error('cleanup unverified'); cleaned = true; } };
      const run = () => runBatchImagePhases({ root, paths, plan, image: D('a'), uid: 12003, gid: 12003,
        addresses: ['104.16.1.35'], deadline: 101_000, executor, now: () => clock, checkpoint: stage => checkpoints.push(stage),
        rootMetadataControl: () => scenario === 'root-metadata-failure' ? '503' : '200' });
      if (scenario === 'success') {
        const result = await run();
        assert.equal(hasBatchImageSummary(`API_MIGRATOR_BATCH_IMAGE_SUMMARY ${canonicalJson(result)}\n`), true);
        assert.deepEqual(calls.map(r => r.network), ['host', 'none', 'host', 'none', 'none']);
        assert.deepEqual(result.phases.map(r => r.phase), ['prepare', 'install', 'migrate', 'verify']);
        assert.equal(result.evidenceDigest, digest);
        assert.deepEqual(checkpoints, ['root_metadata', 'container_metadata', 'prepare', 'install', 'migrate', 'verify', 'cleanup', 'summary_validation']);
      } else await assert.rejects(run());
      if (scenario !== 'success') assert.equal(checkpoints.at(-1), {
        'root-metadata-failure': 'root_metadata', 'metadata-access': 'container_metadata', 'phase-failure': 'prepare',
        'bad-digest': 'install', timeout: 'install', 'cleanup-failure': 'cleanup', 'missing-report': 'verify',
      }[scenario]);
      assert.equal(existsSync(root), scenario === 'cleanup-failure');
      assert.equal(cleaned, scenario !== 'cleanup-failure');
    });
  }
});
