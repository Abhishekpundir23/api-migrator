import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const modulePath = new URL('../compare-hosted-dns.mjs', import.meta.url);
const api = await import(modulePath.href).catch(() => null);
const env = {
  DNS_PROBE_RUN_ID: '123456', DNS_PROBE_RUN_ATTEMPT: '2',
  DNS_PROBE_SOURCE_REVISION: 'a'.repeat(40), DNS_PROBE_SCENARIO: 'success',
  DNS_PROBE_REPOSITORY: 'owner/repo', SECRET: 'never-export-this',
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
function wire(records = ['registry.npmjs.org. 79 IN A 104.16.24.34', 'registry.npmjs.org. 68 IN A 104.16.25.34'], flags = 'qr rd ra', status = 'NOERROR') {
  return `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: 123\n;; flags: ${flags}; QUERY: 1, ANSWER: ${records.length}, AUTHORITY: 0, ADDITIONAL: 0\n${records.join('\n')}\n;; Query time: 1 msec\n;; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)\n;; WHEN: Thu Oct 08 01:00:00 UTC 2026\n;; MSG SIZE  rcvd: 80\n`;
}
function requireApi() { assert.ok(api, 'bounded DNS comparison helper must exist'); }

test('wire parser retains mixed TTL statistics and dig flags without raw packet data', () => {
  requireApi();
  assert.deepEqual(api.parseDigAnswer(wire()), {
    outcome: 'answered', answerCount: 2, uniqueAddressCount: 2,
    minTtlSeconds: 68, maxTtlSeconds: 79, distinctTtlSeconds: [68, 79],
    addressSetSha256: digest('104.16.24.34\n104.16.25.34'),
    wireFlags: { aa: false, rd: true, ra: true, tc: false },
  });
});
test('duplicate native and wire addresses preserve answer count but digest only unique addresses', () => {
  requireApi();
  const native = api.normalizeNativeAnswer([{ address: '104.16.24.34', ttl: 79 }, { address: '104.16.24.34', ttl: 68 }]);
  assert.equal(native.answerCount, 2); assert.equal(native.uniqueAddressCount, 1);
  assert.equal(native.addressSetSha256, digest('104.16.24.34')); assert.equal(native.wireFlags, null);
  const parsed = api.parseDigAnswer(wire(['registry.npmjs.org. 79 IN A 104.16.24.34', 'registry.npmjs.org. 68 IN A 104.16.24.34']));
  assert.equal(parsed.addressSetSha256, native.addressSetSha256);
  assert.deepEqual(parsed.distinctTtlSeconds, [68, 79]);
});
for (const [name, packet, outcome] of [
  ['invalid IP', wire(['registry.npmjs.org. 79 IN A 999.1.1.1']), 'invalid_answer'],
  ['wrong owner', wire(['evil.example. 79 IN A 104.16.24.34']), 'invalid_answer'],
  ['CNAME', wire(['registry.npmjs.org. 79 IN CNAME secret.example.']), 'invalid_answer'],
  ['malformed row', wire(['registry.npmjs.org. 79 IN A 104.16.24.34 extra']), 'invalid_answer'],
  ['truncation', wire(undefined, 'qr rd ra tc'), 'invalid_answer'],
  ['NXDOMAIN', wire([], 'qr rd ra', 'NXDOMAIN'), 'query_error'],
  ['missing header', 'registry.npmjs.org. 79 IN A 104.16.24.34\n', 'invalid_answer'],
  ['oversized packet', 'x'.repeat(16 * 1024 + 1), 'invalid_answer'],
  ['too many answers', wire(Array(33).fill('registry.npmjs.org. 79 IN A 104.16.24.34')), 'invalid_answer'],
  ['answer count mismatch', wire().replace('ANSWER: 2', 'ANSWER: 1'), 'invalid_answer'],
]) test(`wire parser rejects ${name} with sanitized outcome`, () => {
  requireApi(); assert.deepEqual(api.parseDigAnswer(packet), { outcome });
});
test('native invalid raw data never escapes the normalization boundary', () => {
  requireApi();
  for (const value of [[], [{ address: 'raw-secret', ttl: 79 }], [{ address: '104.16.24.34', ttl: -1 }], [{ address: '104.16.24.34', ttl: '79' }], Array(33).fill({ address: '104.16.24.34', ttl: 79 })]) {
    assert.deepEqual(api.normalizeNativeAnswer(value), { outcome: 'invalid_answer' });
  }
});

// Real query construction, normalization and sampling remain in production. Only
// external DNS/process/file operations and the clock are replaced here.
function harness({ nativeHang = false, digError = null, queryAdvance = 0, delayAdvance = 0 } = {}) {
  let now = 0; let resolverCount = 0; let cancelled = 0; const calls = []; const timers = new Map(); let timerId = 0;
  class Resolver {
    constructor() { resolverCount++; }
    getServers() { return ['127.0.0.53', '10.0.0.1', '8.8.8.8']; }
    resolve4(host, options) {
      calls.push({ type: 'native', host, options, now });
      now += queryAdvance;
      return nativeHang ? new Promise(() => {}) : Promise.resolve([{ address: '104.16.24.34', ttl: 79 }, { address: '104.16.25.34', ttl: 68 }]);
    }
    cancel() { cancelled++; }
  }
  const dependencies = {
    Resolver, platform: 'linux', nodeVersion: '22.23.2', versions: { node: '22.23.2', ares: '1.34.5' },
    now: () => now, wallNow: () => new Date(1791417600000 + now),
    sleep: async (ms) => { now += ms + delayAdvance; },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); if (nativeHang) queueMicrotask(() => { if (timers.has(id)) { now += ms; fn(); } }); return id; },
    clearTimeout: (id) => timers.delete(id),
    execFile: (file, args, options, callback) => {
      calls.push({ type: 'dig', file, args, options, now });
      queueMicrotask(() => callback(digError, wire(), 'raw-secret-stderr'));
    },
    realpath: async () => '/run/systemd/resolve/stub-resolv.conf',
    open: async () => ({
      stat: async () => ({ size: 21 }),
      read: async (buffer, offset, length, position) => { const body = Buffer.from('nameserver 127.0.0.53\n').subarray(position, position + length); body.copy(buffer, offset); return { bytesRead: body.length, buffer }; },
      close: async () => {},
    }),
  };
  return { dependencies, calls, get now() { return now; }, get resolverCount() { return resolverCount; }, get cancelled() { return cancelled; } };
}
test('comparison samples three real channels in parallel for 25 groups at fixed 5s cadence', async () => {
  requireApi(); const h = harness(); const result = await api.runComparison(env, h.dependencies);
  assert.equal(result.samples.length, 25); assert.equal(h.resolverCount, 26);
  assert.deepEqual(result.samples.map((s) => s.monotonicOffsetMs), Array.from({ length: 25 }, (_, i) => i * 5000));
  assert.equal(h.now, 120000);
  for (const sample of result.samples) {
    assert.deepEqual(sample.queries.map((q) => q.channel), ['reused_native', 'fresh_native', 'dig_default']);
    assert.ok(sample.queries.every((q) => q.outcome === 'answered' && q.durationMs === 0 && q.monotonicOffsetMs === sample.monotonicOffsetMs));
  }
  assert.ok(h.calls.filter((c) => c.type === 'native').every((c) => c.host === 'registry.npmjs.org' && c.options.ttl === true));
  const dig = h.calls.find((c) => c.type === 'dig');
  assert.equal(dig.file, '/usr/bin/dig');
  assert.deepEqual(dig.args, ['registry.npmjs.org', 'A', '+time=1', '+tries=1', '+notcp', '+ignore', '+noall', '+answer', '+comments', '+stats']);
  assert.equal(dig.options.shell, false); assert.equal(dig.options.timeout, 1500);
  assert.equal(dig.options.killSignal, 'SIGKILL'); assert.equal(dig.options.maxBuffer, 16384);
  assert.deepEqual(Object.keys(dig.options.env).sort(), ['LANG', 'LC_ALL', 'PATH', 'TZ']);
});
test('all three channels initiate before any pending query is released', async () => {
  requireApi(); const h = harness(); const releases = []; let released = false;
  class PendingResolver extends h.dependencies.Resolver {
    resolve4(host, options) {
      const answer = super.resolve4(host, options);
      return released ? answer : new Promise((resolve) => releases.push(() => resolve(answer)));
    }
  }
  const resultPromise = api.runComparison(env, {
    ...h.dependencies, Resolver: PendingResolver,
    execFile: (file, args, options, callback) => h.dependencies.execFile(file, args, options, (...answer) => {
      if (released) callback(...answer);
      else releases.push(() => callback(...answer));
    }),
  });
  try {
    await new Promise(setImmediate);
    assert.deepEqual(h.calls.map((call) => call.type), ['native', 'native', 'dig']);
    assert.equal(releases.length, 3);
  } finally {
    released = true;
    for (const release of releases) release();
    await resultPromise;
  }
});
test('clock delays never trigger catch-up bursts or work beyond the 125s budget', async () => {
  requireApi(); const h = harness({ delayAdvance: 10000 }); const result = await api.runComparison(env, h.dependencies);
  assert.deepEqual(result.samples.map((s) => s.monotonicOffsetMs), [0, 15000, 30000, 45000, 60000, 75000, 90000, 105000, 120000]);
  assert.ok(h.calls.every((c) => c.now < 125000));
  assert.ok(result.samples.length <= 25);
});
test('filesystem metadata time is included in the overall 125s budget', async () => {
  requireApi(); const h = harness();
  const result = await api.runComparison(env, { ...h.dependencies, realpath: async () => {
    await h.dependencies.sleep(10000); return '/run/systemd/resolve/stub-resolv.conf';
  } });
  assert.equal(result.samples.length, 23);
  assert.equal(result.samples[0].monotonicOffsetMs, 10000);
  assert.equal(result.samples.at(-1).monotonicOffsetMs, 120000);
  assert.equal(h.now, 120000);
});
test('native timeouts cancel both resolvers and expose no raw errors', async () => {
  requireApi(); const h = harness({ nativeHang: true }); const result = await api.runComparison(env, h.dependencies);
  assert.ok(result.samples.length > 0); assert.equal(h.cancelled, result.samples.length * 2);
  assert.ok(result.samples.every((s) => s.queries.slice(0, 2).every((q) => q.outcome === 'timeout')));
  assert.ok(!JSON.stringify(result).includes('raw-secret'));
});
test('dig output-buffer kill is invalid_answer rather than a query timeout', async () => {
  requireApi(); const h = harness({ digError: Object.assign(new Error('raw-secret-buffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGKILL' }) });
  const result = await api.runComparison(env, h.dependencies);
  assert.ok(result.samples.every((s) => s.queries[2].outcome === 'invalid_answer'));
});
for (const [code, outcome] of [['ENOENT', 'unavailable'], ['EACCES', 'unavailable'], ['ETIMEOUT', 'timeout'], ['SERVFAIL', 'query_error']]) {
  test(`dig ${code} becomes ${outcome} without process stderr`, async () => {
    requireApi(); const h = harness({ digError: Object.assign(new Error('raw-secret-error'), { code }) });
    const result = await api.runComparison(env, h.dependencies);
    assert.ok(result.samples.every((s) => s.queries[2].outcome === outcome));
    assert.ok(!JSON.stringify(result).includes('raw-secret'));
  });
}
test('metadata preserves provenance and non-authorizing boundaries but no server endpoints or resolv content', async () => {
  requireApi(); const h = harness(); const result = await api.runComparison(env, h.dependencies);
  assert.deepEqual(result.provenance, { runId: '123456', runAttempt: '2', sourceRevision: 'a'.repeat(40), scenario: 'success', repository: 'owner/repo' });
  assert.equal(result.kind, 'api_migrator_hosted_dns_comparison'); assert.equal(result.schemaVersion, 1);
  assert.equal(result.selfAttested, true); assert.equal(result.releaseEvidenceEligible, false);
  assert.equal(result.activationBlocked, true); assert.equal(result.externalSigningEligible, false);
  assert.equal(result.authorizationStatus, 'non_authorizing_github_hosted_diagnostic_only');
  assert.deepEqual(result.runtime, { node: '22.23.2', cAres: '1.34.5' });
  assert.equal(result.nativeResolvers.count, 3);
  assert.deepEqual(result.nativeResolvers.endpointClasses, { loopback: 1, private: 1, public: 1, other: 0 });
  assert.equal(result.resolvConf.contentSha256, digest('nameserver 127.0.0.53\n'));
  assert.equal(result.resolvConf.canonicalTargetSha256, digest('/run/systemd/resolve/stub-resolv.conf'));
  const encoded = api.encodeComparison(result);
  assert.ok(Buffer.byteLength(encoded) <= 65536);
  for (const raw of ['127.0.0.53', '104.16.24.34', 'nameserver', 'stub-resolv.conf', 'never-export-this']) assert.ok(!encoded.includes(raw));
});
test('invalid provenance and runtime fail before resolver construction or network', async () => {
  requireApi();
  for (const change of [ { DNS_PROBE_RUN_ID: '1\n' }, { DNS_PROBE_RUN_ATTEMPT: '0' }, { DNS_PROBE_SOURCE_REVISION: 'x'.repeat(40) }, { DNS_PROBE_SCENARIO: 'other' }, { DNS_PROBE_REPOSITORY: 'owner/repo/secret' }, { DNS_PROBE_RUN_ID: '1'.repeat(21) } ]) {
    const h = harness(); await assert.rejects(api.runComparison({ ...env, ...change }, h.dependencies)); assert.equal(h.resolverCount, 0); assert.equal(h.calls.length, 0);
  }
  for (const change of [{ platform: 'darwin' }, { nodeVersion: '22.23.1' }]) {
    const h = harness(); await assert.rejects(api.runComparison(env, { ...h.dependencies, ...change })); assert.equal(h.resolverCount, 0);
  }
});
test('resolv.conf reads are bounded and file deficiencies are explicit unavailable metadata', async () => {
  requireApi(); const h = harness(); let closed = 0;
  const result = await api.runComparison(env, { ...h.dependencies, open: async () => ({ stat: async () => ({ size: 65537 }), read: async () => { throw new Error('must not read oversize'); }, close: async () => { closed++; } }) });
  assert.equal(closed, 1); assert.deepEqual(result.resolvConf, { state: 'unavailable' });
});
test('missing resolv.conf and rejected native queries expose only sanitized failures', async () => {
  requireApi(); const h = harness();
  class FailingResolver extends h.dependencies.Resolver {
    resolve4() { return Promise.reject(new Error('raw-secret-resolver-address')); }
  }
  const result = await api.runComparison(env, { ...h.dependencies, Resolver: FailingResolver, realpath: async () => { throw new Error('raw-secret-file'); } });
  assert.deepEqual(result.resolvConf, { state: 'unavailable' });
  assert.ok(result.samples.every((s) => s.queries.slice(0, 2).every((q) => q.outcome === 'query_error')));
  assert.ok(!api.encodeComparison(result).includes('raw-secret'));
});
test('maximum valid answers and provenance fit inside the 64KiB output cap', async () => {
  requireApi(); const h = harness();
  const records = Array.from({ length: 32 }, (_, i) => ({ address: `104.16.24.${i + 1}`, ttl: 4294967295 - i }));
  class LargeResolver extends h.dependencies.Resolver { resolve4() { return Promise.resolve(records); } }
  const output = await api.runComparison({ ...env, DNS_PROBE_RUN_ID: '9'.repeat(20), DNS_PROBE_RUN_ATTEMPT: '9'.repeat(10), DNS_PROBE_SCENARIO: 'install_failure', DNS_PROBE_REPOSITORY: `${'a'.repeat(100)}/${'b'.repeat(100)}` }, {
    ...h.dependencies, Resolver: LargeResolver,
    execFile: (file, args, options, callback) => callback(null, wire(records.map((r) => `registry.npmjs.org. ${r.ttl} IN A ${r.address}`)), ''),
  });
  const size = Buffer.byteLength(api.encodeComparison(output));
  assert.ok(size <= 65536, `maximum-sized normalized fixture was ${size} bytes`);
});
test('CLI emits a single bounded JSON only on success and fixed stderr on failures', async () => {
  requireApi(); const h = harness(); const out = []; const errors = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => errors.push(s) } };
  assert.equal(await api.runCli(['--read-only'], env, { ...h.dependencies, ...io }), 0);
  assert.equal(out.length, 1); assert.equal(errors.length, 0); assert.equal(JSON.parse(out[0]).samples.length, 25);
  out.length = 0;
  assert.equal(await api.runCli(['--server', 'raw-secret'], env, { ...h.dependencies, ...io }), 1);
  assert.deepEqual(out, []); assert.deepEqual(errors, ['DNS comparison failed: invalid arguments.\n']);
  errors.length = 0;
  assert.equal(await api.runCli(['--read-only'], env, { ...h.dependencies, ...io, nodeVersion: '20.0.0' }), 1);
  assert.deepEqual(out, []); assert.deepEqual(errors, ['DNS comparison failed: unsupported runtime.\n']);
  assert.throws(() => api.encodeComparison({ oversized: 'x'.repeat(65536) }));
});
test('real CLI rejects bad flags without depending on a Linux runtime or network', () => {
  requireApi(); let failure;
  try { execFileSync(process.execPath, [fileURLToPath(modulePath), '--unsafe'], { encoding: 'utf8', env: {}, stdio: 'pipe' }); } catch (error) { failure = error; }
  assert.equal(failure.status, 1); assert.equal(failure.stdout, ''); assert.equal(failure.stderr, 'DNS comparison failed: invalid arguments.\n');
});
