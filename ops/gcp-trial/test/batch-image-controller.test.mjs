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

test('bounded public preparation enforces actual elapsed expiry without plan output', async t => {
  const { prepareBatchImageWorkspace } = await load();
  assert.equal(typeof prepareBatchImageWorkspace, 'function', 'bounded setup subprocess implementation must exist');
  const root = mkdtempSync(join(tmpdir(), 'batch-image-setup-group-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(prepareBatchImageWorkspace(root, { deadline: Date.now() - 1 }), /deadline/);
  assert.deepEqual(readdirSync(root), []);
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o755 });
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const originalPath = process.env.PATH; process.env.PATH = bin;
  try {
    const start = Date.now();
    await assert.rejects(prepareBatchImageWorkspace(workspace, { deadline: start + 150 }), /deadline|failed/);
    assert(Date.now() - start >= 100, 'the real elapsed deadline must run');
    assert(Date.now() - start < 6500, 'expiry and group cleanup remain bounded');
    assert.equal(existsSync(join(workspace, 'plan.json')), false);
    assert.equal(existsSync(join(workspace, 'source.bundle')), false);
  } finally { process.env.PATH = originalPath; }
});

test('preparation deadline kills a self-acknowledged descendant and refuses missing readiness', { timeout: 45_000 }, async t => {
  const { prepareBatchImageWorkspace } = await load();
  const realSetTimeout = globalThis.setTimeout;
  const sleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));
  for (const behavior of ['delayed', 'early-exit', 'never-ready']) await t.test(behavior, async st => {
    const root = mkdtempSync(join(tmpdir(), 'batch-image-ready-group-'));
    const bin = join(root, 'bin'); mkdirSync(bin);
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const childCode = 'require("node:fs").writeFileSync("descendant.pid",String(process.pid));setInterval(()=>{},1000)';
    const body = behavior === 'early-exit' ? 'process.exit(17);' : behavior === 'never-ready' ? 'setInterval(()=>{},1000);'
      : `setTimeout(()=>{require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000)},1500);`;
    writeFileSync(join(bin, 'npm'), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    let deadlineCallback, deadlineTimer, settled = false, outcome, watchdog;
    const originalPath = process.env.PATH;
    // Only the parent's deadline event is controlled. Child startup, its self-PID
    // receipt, negative-PGID SIGKILL, close and ESRCH remain actual OS behavior.
    const timer = st.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      if (!deadlineCallback && delay > 10_000) {
        deadlineCallback = callback;
        deadlineTimer = realSetTimeout(callback, delay, ...args);
        return deadlineTimer;
      }
      return realSetTimeout(callback, delay, ...args);
    });
    const pidFile = join(workspace, 'checkout/descendant.pid');
    try {
      process.env.PATH = bin;
      outcome = prepareBatchImageWorkspace(workspace, { deadline: Date.now() + 30_000 })
        .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
      assert.equal(typeof deadlineCallback, 'function');
      const readiness = async () => {
        const until = Date.now() + 5000;
        while (!existsSync(pidFile)) {
          if (settled) throw Error('fixture exited before descendant readiness');
          if (Date.now() >= until) throw Error('descendant readiness deadline exceeded');
          await sleep(25);
        }
      };
      if (behavior === 'delayed') {
        await readiness();
        const pid = Number(readFileSync(pidFile, 'utf8'));
        assert(Number.isSafeInteger(pid) && pid > 1);
        assert.doesNotThrow(() => process.kill(pid, 0));
        timer.mock.restore(); clearTimeout(deadlineTimer); deadlineCallback();
        const result = await Promise.race([outcome, new Promise((_, reject) => {
          watchdog = realSetTimeout(() => reject(Error('group cleanup watchdog exceeded')), 6500);
        })]);
        assert.match(result.error?.message ?? '', /deadline/);
        assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH', 'self-acknowledged descendant must be gone');
      } else {
        await assert.rejects(readiness(), behavior === 'early-exit' ? /exited before descendant readiness/ : /readiness deadline exceeded/);
      }
      assert.equal(existsSync(join(workspace, 'plan.json')), false);
      assert.equal(existsSync(join(workspace, 'source.bundle')), false);
    } finally {
      timer.mock.restore(); clearTimeout(deadlineTimer); clearTimeout(watchdog);
      if (!settled && deadlineCallback) deadlineCallback();
      try {
        if (outcome) {
          const result = await Promise.race([outcome, new Promise((_, reject) => {
            watchdog = realSetTimeout(() => reject(Error('fixture cleanup watchdog exceeded')), 6500);
          })]);
          assert.notEqual(result.error?.code, 'BATCH_SETUP_CLEANUP_UNVERIFIED', 'preserve workspace if group absence is unverified');
        }
        rmSync(root, { recursive: true, force: true });
      } finally { clearTimeout(watchdog); process.env.PATH = originalPath; }
    }
  });
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
  for (const scenario of ['success', 'earlier-outer-deadline', 'plan-expired', 'root-metadata-failure', 'metadata-access', 'phase-failure', 'bad-digest', 'timeout', 'verify-expired', 'cleanup-failure', 'missing-report']) {
    await t.test(scenario, async () => {
      const root = mkdtempSync(join(tmpdir(), 'batch-image-unit-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const paths = Object.fromEntries(['installation', 'output', 'dependencies', 'result'].map(n => [n, join(root, n)]));
      for (const path of Object.values(paths)) mkdirSync(path);
      paths.planPath = join(root, 'plan.json'); paths.sourcePath = join(root, 'source.bundle');
      const plan = { digest: D('b'), plan: { job: { id: `previewjob_${'c'.repeat(64)}`, expiresAt: 91_000 } } };
      const evidence = { planDigest: D('b'), output: { preflightId: `pf_${'d'.repeat(64)}`, artifactDigest: D('e'), candidateTreeSha: 'f'.repeat(40) },
        checks: Object.fromEntries(['install', 'typecheck', 'test', 'lint', 'runtime'].map(n => [n, { status: 'passed' }])),
        report: { verification: { ok: true, skipped: false }, summary: { review: 0 }, manifest: { deployment: { kind: 'long-running' } }, entries: [] }, blockers: [] };
      const text = canonicalJson(evidence), digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
      let clock = scenario === 'plan-expired' ? 91_000 : 1000, cleaned = false;
      const calls = [], checkpoints = [];
      const executor = { execute(request) {
        calls.push(request);
        assert.equal(request.timeoutMs, request.dockerArgs.includes('/usr/local/bin/node') ? 15_000 : (scenario === 'earlier-outer-deadline' ? 41_000 : 91_000) - clock);
        assert.equal(request.image, D('a'));
        assert(request.dockerArgs.includes('12003:12003'));
        if (request.dockerArgs.includes('/usr/local/bin/node')) {
          assert.equal(request.network, 'host');
          return scenario === 'metadata-access' ? 'metadata_reachable\n' : 'metadata_denied\n';
        }
        if (scenario === 'phase-failure') throw Error('phase failed');
        if (scenario === 'timeout') clock = 91_000;
        const outputs = { prepare: `runner_phase=prepare status=passed prepared_state_digest=${D('1')}\n`,
          install: `runner_phase=install status=passed prepared_state_digest=${D(scenario === 'bad-digest' ? '9' : '1')} install_state_digest=${D('2')}\n`,
          migrate: `runner_phase=migrate status=passed dependency_state_digest=${D('3')}\n`,
          verify: `runner_phase=verify status=passed evidence_digest=${digest} preflight_id=${evidence.output.preflightId}\n` };
        if (request.phase === 'verify' && scenario !== 'missing-report') writeFileSync(join(paths.result, 'runner-evidence.json'), text);
        if (scenario === 'success' || scenario === 'earlier-outer-deadline') clock += 1000;
        if (scenario === 'verify-expired' && request.phase === 'verify') clock = 91_000;
        return outputs[request.phase];
      }, assertCleanupComplete() { if (scenario === 'cleanup-failure') throw Error('cleanup unverified'); cleaned = true; } };
      const run = () => runBatchImagePhases({ root, paths, plan, image: D('a'), uid: 12003, gid: 12003,
        addresses: ['104.16.1.35'], deadline: scenario === 'earlier-outer-deadline' ? 101_000 : 1_201_000,
        executor, now: () => clock, checkpoint: stage => checkpoints.push(stage),
        rootMetadataControl: () => scenario === 'root-metadata-failure' ? '503' : '200' });
      if (scenario === 'success' || scenario === 'earlier-outer-deadline') {
        const result = await run();
        assert.equal(hasBatchImageSummary(`API_MIGRATOR_BATCH_IMAGE_SUMMARY ${canonicalJson(result)}\n`), true);
        assert.deepEqual(calls.map(r => r.network), ['host', 'none', 'host', 'none', 'none']);
        assert.deepEqual(result.phases.map(r => r.phase), ['prepare', 'install', 'migrate', 'verify']);
        assert.equal(result.evidenceDigest, digest);
        assert.deepEqual(checkpoints, ['root_metadata', 'container_metadata', 'prepare', 'install', 'migrate', 'verify', 'cleanup', 'summary_validation']);
        assert.deepEqual(calls.map(r => r.timeoutMs), scenario === 'earlier-outer-deadline'
          ? [15000, 40000, 39000, 38000, 37000] : [15000, 90000, 89000, 88000, 87000]);
      } else await assert.rejects(run());
      if (scenario !== 'success' && scenario !== 'earlier-outer-deadline') assert.equal(checkpoints.at(-1), {
        'plan-expired': 'container_metadata', 'root-metadata-failure': 'root_metadata', 'metadata-access': 'container_metadata', 'phase-failure': 'prepare',
        'bad-digest': 'install', timeout: 'install', 'verify-expired': 'verify', 'cleanup-failure': 'cleanup', 'missing-report': 'verify',
      }[scenario]);
      if (scenario === 'plan-expired') assert.equal(calls.length, 0);
      assert.equal(existsSync(root), scenario === 'cleanup-failure');
      assert.equal(cleaned, scenario !== 'cleanup-failure');
    });
  }
});
