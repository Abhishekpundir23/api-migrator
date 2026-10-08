import { Resolver } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const HOST = 'registry.npmjs.org';
const BUDGET_MS = 125000;
const QUERY_MS = 1500;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const failure = (outcome) => ({ outcome });

function normalized(records, wireFlags) {
  if (!Array.isArray(records) || records.length < 1 || records.length > 32) return failure('invalid_answer');
  if (records.some((r) => !r || isIP(r.address) !== 4 || !Number.isInteger(r.ttl) || r.ttl < 0 || r.ttl > 4294967295)) return failure('invalid_answer');
  const addresses = [...new Set(records.map((r) => r.address))].sort();
  const ttls = [...new Set(records.map((r) => r.ttl))].sort((a, b) => a - b);
  return {
    outcome: 'answered', answerCount: records.length, uniqueAddressCount: addresses.length,
    minTtlSeconds: ttls[0], maxTtlSeconds: ttls.at(-1), distinctTtlSeconds: ttls,
    addressSetSha256: sha256(addresses.join('\n')), wireFlags,
  };
}

export function normalizeNativeAnswer(records) { return normalized(records, null); }

export function parseDigAnswer(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384) return failure('invalid_answer');
  const lines = raw.split(/\r?\n/);
  const headers = lines.filter((line) => line.startsWith(';; ->>HEADER<<-'));
  const flagLines = lines.filter((line) => line.startsWith(';; flags:'));
  if (headers.length !== 1 || flagLines.length !== 1) return failure('invalid_answer');
  const header = /^;; ->>HEADER<<- opcode: QUERY, status: ([A-Z]+), id: [0-9]+$/.exec(headers[0]);
  const flags = /^;; flags: ([a-z ]+); QUERY: 1, ANSWER: ([0-9]+), AUTHORITY: [0-9]+, ADDITIONAL: [0-9]+$/.exec(flagLines[0]);
  if (!header || !flags) return failure('invalid_answer');
  if (header[1] !== 'NOERROR') return failure('query_error');
  const flagSet = new Set(flags[1].split(/ +/));
  if (flagSet.has('tc') || !flagSet.has('qr')) return failure('invalid_answer');
  const records = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith(';')) continue;
    const record = /^registry\.npmjs\.org\.\s+([0-9]+)\s+IN\s+A\s+([0-9.]+)\s*$/.exec(line);
    if (!record) return failure('invalid_answer');
    records.push({ ttl: Number(record[1]), address: record[2] });
  }
  if (Number(flags[2]) !== records.length) return failure('invalid_answer');
  return normalized(records, { aa: flagSet.has('aa'), rd: flagSet.has('rd'), ra: flagSet.has('ra'), tc: false });
}

function provenance(env) {
  const checks = [
    ['DNS_PROBE_RUN_ID', /^[1-9][0-9]{0,19}$/],
    ['DNS_PROBE_RUN_ATTEMPT', /^[1-9][0-9]{0,9}$/],
    ['DNS_PROBE_SOURCE_REVISION', /^[a-fA-F0-9]{40}$/],
    ['DNS_PROBE_SCENARIO', /^(success|install_failure|install_cancel)$/],
    ['DNS_PROBE_REPOSITORY', /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/],
  ];
  for (const [key, pattern] of checks) {
    const value = env[key];
    if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) throw new Error('invalid provenance');
  }
  return {
    runId: env.DNS_PROBE_RUN_ID, runAttempt: env.DNS_PROBE_RUN_ATTEMPT,
    sourceRevision: env.DNS_PROBE_SOURCE_REVISION, scenario: env.DNS_PROBE_SCENARIO,
    repository: env.DNS_PROBE_REPOSITORY,
  };
}

function defaults() {
  return {
    Resolver, execFile, open, realpath,
    platform: process.platform, nodeVersion: process.versions.node, versions: process.versions,
    now: () => performance.now(), wallNow: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    setTimeout, clearTimeout,
  };
}

function endpointClass(endpoint) {
  const address = endpoint.replace(/^\[([^\]]+)\](?::[0-9]+)?$/, '$1');
  if (isIP(address) === 6) {
    if (address === '::1') return 'loopback';
    if (/^(fc|fd|fe[89ab])/i.test(address)) return 'private';
    if (address === '::' || /^ff/i.test(address)) return 'other';
    return 'public';
  }
  const ipv4 = isIP(address) === 4 ? address : address.replace(/:[0-9]+$/, '');
  if (isIP(ipv4) !== 4) return 'other';
  const [a, b] = ipv4.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'private';
  if (a === 0 || a >= 224) return 'other';
  return 'public';
}

async function resolvMetadata(d) {
  let handle;
  try {
    const target = await d.realpath('/etc/resolv.conf');
    if (typeof target !== 'string' || Buffer.byteLength(target) > 4096) return { state: 'unavailable' };
    handle = await d.open('/etc/resolv.conf', 'r');
    const stat = await handle.stat();
    if (!Number.isInteger(stat.size) || stat.size < 0 || stat.size > 65536) return { state: 'unavailable' };
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - size) return { state: 'unavailable' };
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > 65536) return { state: 'unavailable' };
    return { state: 'available', canonicalTargetSha256: sha256(target), contentSha256: sha256(buffer.subarray(0, size)) };
  } catch { return { state: 'unavailable' }; }
  finally { if (handle) { try { await handle.close(); } catch { /* no raw filesystem errors */ } } }
}

async function nativeQuery(resolver, timeoutMs, d) {
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      d.clearTimeout(timer);
      resolve(value);
    };
    timer = d.setTimeout(() => {
      try { resolver.cancel(); } catch { /* cancel must not disclose runtime details */ }
      finish(failure('timeout'));
    }, timeoutMs);
    try {
      Promise.resolve(resolver.resolve4(HOST, { ttl: true })).then(
        (answer) => finish(normalizeNativeAnswer(answer)),
        () => finish(failure('query_error')),
      );
    } catch { finish(failure('query_error')); }
  });
}

async function digQuery(timeoutMs, d) {
  return new Promise((resolve) => {
    try {
      d.execFile('/usr/bin/dig', [HOST, 'A', '+time=1', '+tries=1', '+notcp', '+ignore', '+noall', '+answer', '+comments', '+stats'], {
        shell: false, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16384,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      }, (error, stdout) => {
        if (!error) { resolve(parseDigAnswer(stdout)); return; }
        if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)) resolve(failure('unavailable'));
        else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') resolve(failure('invalid_answer'));
        else if (error.code === 'ETIMEOUT' || error.killed || error.signal === 'SIGKILL') resolve(failure('timeout'));
        else resolve(failure('query_error'));
      });
    } catch { resolve(failure('unavailable')); }
  });
}

export async function runComparison(env, dependencies = {}) {
  const runProvenance = provenance(env);
  const d = { ...defaults(), ...dependencies };
  if (d.platform !== 'linux' || d.nodeVersion !== '22.23.2') throw new Error('unsupported runtime');
  const start = d.now();
  const deadline = start + BUDGET_MS;
  const reused = new d.Resolver();
  const servers = reused.getServers();
  if (!Array.isArray(servers) || servers.length > 32 || servers.some((s) => typeof s !== 'string' || s.length > 256)) throw new Error('runtime metadata unavailable');
  const endpointClasses = { loopback: 0, private: 0, public: 0, other: 0 };
  for (const server of servers) endpointClasses[endpointClass(server)]++;
  const resolvConf = await resolvMetadata(d);
  const samples = [];
  let nextStart = d.now();
  while (samples.length < 25) {
    const waitMs = nextStart - d.now();
    if (nextStart >= deadline) break;
    if (waitMs > 0) await d.sleep(waitMs);
    const groupStart = d.now();
    if (groupStart >= deadline) break;
    const wallTime = d.wallNow().toISOString();
    const fresh = new d.Resolver();
    const query = async (channel, operation) => {
      const queryStart = d.now();
      const queryWallTime = d.wallNow().toISOString();
      const timeoutMs = Math.min(QUERY_MS, Math.max(0, deadline - queryStart));
      const answer = timeoutMs > 0 ? await operation(timeoutMs) : failure('timeout');
      return { channel, wallTime: queryWallTime, monotonicOffsetMs: queryStart - start, durationMs: Math.max(0, d.now() - queryStart), ...answer };
    };
    const queries = await Promise.all([
      query('reused_native', (ms) => nativeQuery(reused, ms, d)),
      query('fresh_native', (ms) => nativeQuery(fresh, ms, d)),
      query('dig_default', (ms) => digQuery(ms, d)),
    ]);
    samples.push({ wallTime, monotonicOffsetMs: groupStart - start, queries });
    nextStart = groupStart + 5000;
    if (nextStart < d.now()) nextStart = d.now() + 5000;
  }
  return {
    kind: 'api_migrator_hosted_dns_comparison', schemaVersion: 1,
    selfAttested: true, releaseEvidenceEligible: false, activationBlocked: true,
    externalSigningEligible: false, authorizationStatus: 'non_authorizing_github_hosted_diagnostic_only',
    provenance: runProvenance,
    runtime: { node: d.nodeVersion, cAres: d.versions.ares },
    nativeResolvers: { count: servers.length, setSha256: sha256([...new Set(servers)].sort().join('\n')), endpointClasses },
    resolvConf, samples,
  };
}

export function encodeComparison(result) {
  const encoded = `${JSON.stringify(result)}\n`;
  if (Buffer.byteLength(encoded) > 65536) throw new Error('output limit');
  return encoded;
}

export async function runCli(args, env, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  if (args.length !== 1 || args[0] !== '--read-only') {
    stderr.write('DNS comparison failed: invalid arguments.\n'); return 1;
  }
  try {
    const encoded = encodeComparison(await runComparison(env, dependencies));
    stdout.write(encoded);
    return 0;
  } catch (error) {
    stderr.write(error?.message === 'unsupported runtime'
      ? 'DNS comparison failed: unsupported runtime.\n'
      : 'DNS comparison failed: diagnostic unavailable.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2), process.env);
}
