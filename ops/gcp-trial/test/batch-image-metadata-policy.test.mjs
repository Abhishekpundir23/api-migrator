import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { probeBatchImageMetadata } from '../run-batch-image-smoke.mjs';

const load = async () => { const m = await import('./batch-image-metadata-policy.mjs').catch(() => null); assert(m, 'owned test metadata policy must exist'); return m; };
const JOB = `previewjob_${'a'.repeat(64)}`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'batch-image-policy-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid();
  const env = { API_MIGRATOR_GITHUB_METADATA_POLICY: '1', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_TEMP: root };
  const tables = new Map([['unrelated', { nftables: [{ table: { family: 'inet', name: 'unrelated', handle: 2 } }] }]]);
  let containers = '', created, nextHandle = 10;
  const calls = [];
  const command = (file, args, opts) => {
    calls.push([file, args]); assert(opts.timeout > 0 && opts.timeout <= 5000); assert(opts.maxBuffer <= 65536);
    if (file === 'docker') {
      if (args[0] === 'context') return '"unix:///var/run/docker.sock"\n';
      if (args[0] === 'info') return JSON.stringify({ OSType: 'linux', CgroupVersion: '2', SecurityOptions: ['name=seccomp'] });
      assert.deepEqual(args, ['container', 'ls', '--all', '--no-trunc', '--filter', `label=api-migrator.fixture-job=${JOB}`, '--format', '{{.ID}}']);
      return containers;
    }
    assert.equal(file, 'sudo'); assert.deepEqual(args.slice(0, 2), ['-n', 'nft']);
    assert.equal(args.includes('-f'), false, 'nft must not reopen Node socket stdin');
    if (args.at(-1).startsWith('{')) {
      assert.equal(opts.input, undefined);
      const input = JSON.parse(args.at(-1));
      assert.equal(input.nftables.length, 4);
      const objects = input.nftables.map(x => x.add);
      created = objects[0].table.name;
      assert.match(created, /^am_batch_image_test_[a-f0-9]{32}$/);
      assert.equal(tables.has(created), false);
      const [table, chain, v4, v6] = objects;
      assert.deepEqual(table.table, { family: 'inet', name: created });
      assert.deepEqual(chain.chain, { family: 'inet', table: created, name: 'output', type: 'filter', hook: 'output', prio: -150, policy: 'accept' });
      for (const [record, protocol, address] of [[v4, 'ip', '169.254.169.254'], [v6, 'ip6', 'fd20:ce::254']]) {
        assert.deepEqual(record.rule.expr, [
          { match: { op: '==', left: { meta: { key: 'skuid' } }, right: uid } },
          { match: { op: '==', left: { payload: { protocol, field: 'daddr' } }, right: address } },
          { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: 80 } },
          { reject: { type: 'icmpx', expr: 'admin-prohibited' } },
        ]);
      }
      tables.set(created, { nftables: objects.map(x => { const [kind] = Object.keys(x); return { [kind]: { ...x[kind], handle: nextHandle++ } }; }) });
      return '';
    }
    if (args.includes('tables')) return JSON.stringify({ nftables: [...tables.values()].map(x => x.nftables[0]) });
    const name = args.at(-1);
    if (args.includes('delete')) { assert.equal(name, created); tables.delete(name); return ''; }
    assert(args.includes('list') && args.includes('table')); assert(tables.has(name)); return JSON.stringify(tables.get(name));
  };
  return { env, uid, platform: 'linux', command, tables, calls, created: () => created, containers: value => { containers = value; }, receipt: join(root, 'api-migrator-batch-image-policy.json') };
}

test('policy refuses arbitrary Linux hosts before any command or ownership receipt', async t => {
  const { installMetadataPolicy } = await load();
  const f = fixture(t);
  for (const bad of [{ API_MIGRATOR_GITHUB_METADATA_POLICY: '' }, { GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_OS: 'macOS' }])
    assert.throws(() => installMetadataPolicy(JOB, { ...f, env: { ...f.env, ...bad } }), /GitHub-hosted/);
  assert.equal(f.calls.length, 0); assert.equal(existsSync(f.receipt), false);
  assert.deepEqual(installMetadataPolicy(JOB, { ...f, platform: 'darwin' }), { installed: false, limitation: 'local_mac_not_gce_metadata_evidence' });
  assert.equal(f.calls.length, 0);
});

test('policy owns only its UID metadata HTTP rules and independently verifies exact removal', async t => {
  const { installMetadataPolicy, cleanupMetadataPolicy } = await load();
  const f = fixture(t); assert.equal(installMetadataPolicy(JOB, f).installed, true);
  assert.equal(f.tables.size, 2); assert.equal(JSON.parse(readFileSync(f.receipt)).uid, f.uid);
  assert.equal(cleanupMetadataPolicy(f).absent, true);
  assert.deepEqual([...f.tables.keys()], ['unrelated']); assert.equal(existsSync(f.receipt), false);
  assert.equal(cleanupMetadataPolicy(f).absent, true);
});

test('policy never removes denial while a container remains or table ownership was substituted', async t => {
  const { installMetadataPolicy, cleanupMetadataPolicy } = await load();
  for (const kind of ['container', 'substitution']) {
    const f = fixture(t); installMetadataPolicy(JOB, f);
    if (kind === 'container') f.containers(`${'c'.repeat(64)}\n`);
    else f.tables.get(f.created()).nftables[0].table.handle += 1;
    assert.throws(() => cleanupMetadataPolicy(f), /container|ownership/);
    assert.equal(f.tables.has(f.created()), true); assert.equal(existsSync(f.receipt), true);
  }
});

test('policy rejects remote or UID-remapped daemons before nft mutation', async t => {
  const { installMetadataPolicy } = await load();
  for (const kind of ['remote', 'rootless', 'userns']) {
    const f = fixture(t);
    const command = (file, args, options) => {
      if (file === 'docker' && args[0] === 'context' && kind === 'remote') return '"tcp://remote:2376"';
      if (file === 'docker' && args[0] === 'info') return JSON.stringify({ OSType: 'linux', CgroupVersion: '2', SecurityOptions: [`name=${kind}`] });
      return f.command(file, args, options);
    };
    assert.throws(() => installMetadataPolicy(JOB, { ...f, command }), /local|rootful/);
    assert.equal(existsSync(f.receipt), false); assert.equal(f.tables.size, 1);
  }
});

test('ambiguous installation and failed deletion retain ownership receipt fail closed', async t => {
  const { installMetadataPolicy, cleanupMetadataPolicy } = await load();
  for (const kind of ['install', 'delete']) {
    const f = fixture(t);
    const command = (file, args, options) => {
      if (file === 'sudo' && (kind === 'install' ? args.at(-1).startsWith('{') : args.includes('delete'))) {
        if (kind === 'install') f.command(file, args, options);
        throw Error('controlled nft timeout');
      }
      return f.command(file, args, options);
    };
    if (kind === 'install') assert.throws(() => installMetadataPolicy(JOB, { ...f, command }), /timeout/);
    else installMetadataPolicy(JOB, f);
    assert.throws(() => cleanupMetadataPolicy({ ...f, command }), /ownership|timeout/);
    assert.equal(f.tables.has(f.created()), true); assert.equal(existsSync(f.receipt), true);
  }
});

test('independent audit refuses a residual fixture table even after its receipt disappeared', async t => {
  const { installMetadataPolicy, cleanupMetadataPolicy } = await load();
  const f = fixture(t); installMetadataPolicy(JOB, f); rmSync(f.receipt);
  assert.throws(() => cleanupMetadataPolicy(f), /residual/);
  assert.equal(f.tables.has(f.created()), true);
});

test('failed actual metadata probe reports bounded exit and enum reason without leaking subprocess output', () => {
  assert.throws(() => probeBatchImageMetadata({ image: `sha256:${'b'.repeat(64)}`, uid: 12003, gid: 12003,
    plan: { plan: { job: { id: JOB } } }, deadline: Date.now() + 120_000,
    executor: { execute() { throw Object.assign(Error('SECRET BODY'), { status: 91, signal: null,
      stderr: 'metadata_probe_failed family=ipv4 reason=connected\nSECRET BODY\n' + 'x'.repeat(100_000) }); } } }), error => {
    assert.match(error.message, /exit=91.*family=ipv4 reason=connected/);
    assert.doesNotMatch(error.message, /SECRET/); assert(error.message.length < 256); return true;
  });
});

test('actual probe script rejects a TCP connection and emits only fixed diagnostics', async () => {
  let code;
  probeBatchImageMetadata({ image: `sha256:${'b'.repeat(64)}`, uid: 12003, gid: 12003,
    plan: { plan: { job: { id: JOB } } }, deadline: Date.now() + 120_000,
    executor: { execute(request) { code = request.dockerArgs.at(-1); return 'metadata_denied\n'; } } });
  for (const connected of [false, true]) {
    const output = [], state = { getuid: () => 12003, getgid: () => 12003, exitCode: undefined };
    const http = { get() {
      const req = new EventEmitter(); req.destroy = () => queueMicrotask(() => req.emit('error', Error('SECRET')));
      queueMicrotask(() => {
        if (connected) { const socket = new EventEmitter(); req.emit('socket', socket); socket.emit('connect'); }
        else req.emit('error', Error('denied'));
      });
      return req;
    } };
    runInNewContext(code, { require: name => { assert.equal(name, 'node:http'); return http; }, process: state,
      console: { log: x => output.push(x), error: x => output.push(x) } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.exitCode, connected ? 91 : undefined);
    assert.deepEqual(output, [connected ? 'metadata_probe_failed family=ipv4 reason=connected' : 'metadata_denied']);
  }
});
