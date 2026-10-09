// Test-only host prerequisite. Never enabled on arbitrary developer Linux hosts.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const NAME = /^am_batch_image_test_[a-f0-9]{32}$/;
const JOB = /^previewjob_[a-f0-9]{64}$/;
const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const fingerprint = x => createHash('sha256').update(canonical(x)).digest('hex');

function context(options) {
  const { env = process.env, platform = process.platform, uid = process.getuid?.(), command = execFileSync } = options;
  if (platform === 'darwin') return null;
  if (platform !== 'linux' || env.API_MIGRATOR_GITHUB_METADATA_POLICY !== '1' || env.GITHUB_ACTIONS !== 'true'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Linux') throw Error('metadata fixture requires explicit GitHub-hosted Linux opt-in');
  if (!Number.isSafeInteger(uid) || uid < 1 || uid > 2_147_483_647) throw Error('metadata fixture requires nonzero test UID');
  if (!isAbsolute(env.RUNNER_TEMP ?? '')) throw Error('invalid policy receipt directory');
  const directory = lstatSync(env.RUNNER_TEMP);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid) throw Error('invalid policy receipt custody');
  const run = (file, args) => command(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  if ((env.DOCKER_HOST && env.DOCKER_HOST !== 'unix:///var/run/docker.sock') || env.DOCKER_CONTEXT) throw Error('metadata fixture requires local Docker context');
  if (JSON.parse(run('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])) !== 'unix:///var/run/docker.sock') throw Error('metadata fixture requires local Docker socket');
  const info = JSON.parse(run('docker', ['info', '--format', '{{json .}}']));
  if (info.OSType !== 'linux' || String(info.CgroupVersion) !== '2' || !Array.isArray(info.SecurityOptions)
    || info.SecurityOptions.some(x => /rootless|userns/i.test(x))) throw Error('metadata fixture requires rootful local cgroup-v2 Docker');
  return { uid, run, receipt: join(env.RUNNER_TEMP, 'api-migrator-batch-image-policy.json'),
    nft: args => run('sudo', ['-n', 'nft', '-j', ...args]) };
}

function snapshot(ctx, name) {
  const objects = JSON.parse(ctx.nft(['list', 'table', 'inet', name])).nftables.filter(x => !x.metainfo);
  const tables = objects.filter(x => x.table);
  if (tables.length !== 1 || tables[0].table.name !== name || tables[0].table.family !== 'inet'
    || !Number.isSafeInteger(tables[0].table.handle)) throw Error('policy table ownership unverified');
  return { handle: tables[0].table.handle, fingerprint: fingerprint(objects) };
}

export function installMetadataPolicy(jobId, options = {}) {
  const ctx = context(options);
  if (!ctx) return { installed: false, limitation: 'local_mac_not_gce_metadata_evidence' };
  if (!JOB.test(jobId)) throw Error('invalid policy fixture job');
  const name = `am_batch_image_test_${randomBytes(16).toString('hex')}`;
  const receipt = { schemaVersion: 1, name, uid: ctx.uid, jobId, handle: null, fingerprint: null };
  // Pending receipt is deliberately retained on ambiguous mutation failure.
  writeFileSync(ctx.receipt, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  const rule = (protocol, address) => ({ add: { rule: { family: 'inet', table: name, chain: 'output', expr: [
    { match: { op: '==', left: { meta: { key: 'skuid' } }, right: ctx.uid } },
    { match: { op: '==', left: { payload: { protocol, field: 'daddr' } }, right: address } },
    { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: 80 } },
    { reject: { type: 'icmpx', expr: 'admin-prohibited' } },
  ] } } });
  // A small fixed-shape JSON argv avoids nft reopening Node's socket stdin.
  ctx.nft([JSON.stringify({ nftables: [
    { add: { table: { family: 'inet', name } } },
    { add: { chain: { family: 'inet', table: name, name: 'output', type: 'filter', hook: 'output', prio: -150, policy: 'accept' } } },
    rule('ip', '169.254.169.254'), rule('ip6', 'fd20:ce::254'),
  ] })]);
  Object.assign(receipt, snapshot(ctx, name));
  writeFileSync(ctx.receipt, JSON.stringify(receipt), { mode: 0o600 });
  return { installed: true, table: name };
}

export function cleanupMetadataPolicy(options = {}) {
  const ctx = context(options);
  if (!ctx) return { absent: true, limitation: 'local_mac_not_gce_metadata_evidence' };
  if (!existsSync(ctx.receipt)) {
    // Independent always-step audit must not equate a missing receipt with
    // absence. Unknown residual tables are reported, never broadly deleted.
    if (JSON.parse(ctx.nft(['list', 'tables'])).nftables.some(x => x.table?.family === 'inet' && NAME.test(x.table.name))) throw Error('residual fixture policy without ownership receipt');
    return { absent: true };
  }
  const stat = lstatSync(ctx.receipt);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== ctx.uid || stat.nlink !== 1 || stat.size > 16384
    || (stat.mode & 0o077) !== 0) throw Error('policy receipt ownership invalid');
  const receipt = JSON.parse(readFileSync(ctx.receipt, 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.uid !== ctx.uid || !NAME.test(receipt.name) || !JOB.test(receipt.jobId)) throw Error('policy receipt ownership invalid');
  if (ctx.run('docker', ['container', 'ls', '--all', '--no-trunc', '--filter', `label=api-migrator.fixture-job=${receipt.jobId}`, '--format', '{{.ID}}']).trim()) throw Error('policy retained: owned container absence unverified');
  const present = () => JSON.parse(ctx.nft(['list', 'tables'])).nftables.some(x => x.table?.family === 'inet' && x.table.name === receipt.name);
  if (present()) {
    const current = snapshot(ctx, receipt.name);
    if (current.handle !== receipt.handle || current.fingerprint !== receipt.fingerprint) throw Error('policy table ownership changed or unverified');
    ctx.nft(['delete', 'table', 'inet', receipt.name]);
  }
  if (present()) throw Error('policy table absence unverified');
  unlinkSync(ctx.receipt);
  return { absent: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.slice(2).join(' ') !== '--cleanup') throw Error('expected --cleanup only');
  console.log(JSON.stringify(cleanupMetadataPolicy()));
}
