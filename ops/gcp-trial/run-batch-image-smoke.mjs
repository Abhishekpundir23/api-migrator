import { execFileSync, spawn } from 'node:child_process';
import { chownSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '../publication-runner/deployment/lib.mjs';
import { assertFixtureDockerDaemon } from '../publication-runner/deployment/fixture-native.mjs';
import { createFixturePhaseOperations, createFixturePlan, fixtureContainerNames } from '../publication-runner/image/fixture-phases.mjs';
import { createDockerFixtureExecutor, withFixtureWorkspace } from '../publication-runner/image/docker-fixture-executor.mjs';
import { hasBatchImageSummary } from './batch-image-summary.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
function validateInput(input) {
  if (!input || Object.keys(input).sort().join(',') !== 'deadline,gid,image,uid' || !DIGEST.test(input.image ?? '')
    || !Number.isSafeInteger(input.uid) || input.uid < 1 || input.uid > 2_147_483_647
    || !Number.isSafeInteger(input.gid) || input.gid < 1 || input.gid > 2_147_483_647
    || !Number.isSafeInteger(input.deadline) || input.deadline < 1) throw Error('invalid image controller input');
}

export function parseBatchImageArgs(args) {
  if (!Array.isArray(args) || args.length !== 8) throw Error('expected image, uid, gid and deadline only');
  const input = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2), value = args[i + 1];
    if (!['--image', '--uid', '--gid', '--deadline'].includes(args[i]) || Object.hasOwn(input, key)) throw Error('invalid or duplicate argument');
    if (key !== 'image' && !/^[1-9][0-9]*$/.test(value)) throw Error('invalid numeric argument');
    input[key] = key === 'image' ? value : Number(value);
  }
  validateInput(input); return input;
}

export function assertBatchImageAdmission(input, host) {
  validateInput(input);
  if (host.platform !== 'linux' || host.uid !== 0 || host.dockerHost !== 'unix:///var/run/docker.sock') throw Error('requires root on local Linux Docker host');
  if (!Number.isSafeInteger(host.now) || input.deadline - host.now <= 60_000 || input.deadline - host.now > 3_600_000) throw Error('image deadline exhausted or unbounded');
  assertFixtureDockerDaemon(host.info);
}

function remaining(deadline, now, cap = 1_200_000) {
  const value = Math.min(cap, deadline - now() - 60_000);
  if (!Number.isSafeInteger(value) || value < 1) throw Error('image phase deadline exhausted');
  return value;
}

// New-profile-only setup boundary. The entire process group is bounded, including
// downstream Git subprocesses in the existing source-bundle API. No arbitrary
// command or module path comes from the CLI or request.
export async function prepareBatchImageWorkspace(root, { deadline }) {
  const duration = deadline - Date.now();
  if (!Number.isSafeInteger(deadline) || duration < 1 || duration > 1_200_000) throw Error('public setup deadline exhausted or unbounded');
  if (typeof root !== 'string' || !isAbsolute(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw Error('invalid public setup root');
  const moduleUrl = new URL('../publication-runner/image/fixture-phases.mjs', import.meta.url).href;
  const code = `import {prepareFixtureWorkspace} from ${JSON.stringify(moduleUrl)};
const p=prepareFixtureWorkspace(process.argv[1],{deadline:Number(process.argv[2])});
process.stdout.write(JSON.stringify({...p,bundle:{...p.bundle,bytes:p.bundle.bytes.toString('base64')}}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, root, String(deadline)], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: '/nonexistent', CI: '1' },
  });
  let failure, stdout = '', stderrBytes = 0;
  const killGroup = () => {
    if (!Number.isSafeInteger(child.pid)) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
  };
  const timer = setTimeout(() => { failure ??= Error('public setup deadline exhausted'); killGroup(); }, duration);
  const stop = message => { failure ??= Error(message); killGroup(); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', bytes => { stdout += bytes; if (Buffer.byteLength(stdout) > 1_048_576) stop('public setup output too large'); });
  child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 65_536) stop('public setup diagnostics too large'); });
  const exit = await new Promise(resolve => {
    child.once('error', error => { failure ??= error; resolve(null); });
    child.once('close', code => resolve(code));
  });
  clearTimeout(timer);
  // Even a completed leader can have a surviving npm/Git child. Kill and observe
  // this private group before trusting success or allowing workspace removal.
  killGroup();
  const absent = () => {
    if (!Number.isSafeInteger(child.pid)) return true;
    try { process.kill(-child.pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  };
  const cleanupDeadline = Date.now() + 5000;
  while (!absent() && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!absent()) throw Object.assign(Error('public setup process group cleanup unverified'), { code: 'BATCH_SETUP_CLEANUP_UNVERIFIED' });
  if (failure) throw failure;
  if (exit !== 0 || Date.now() >= deadline) throw Error('public fixture preparation failed or deadline exhausted');
  const prepared = JSON.parse(stdout);
  if (typeof prepared.bundle?.bytes !== 'string') throw Error('public preparation output invalid');
  prepared.bundle.bytes = Buffer.from(prepared.bundle.bytes, 'base64');
  return prepared;
}

// Uses the same retained-container executor as phases: a timed-out Docker client
// is never treated as proof of probe death. Only the exact owned ID is removed.
export function probeBatchImageMetadata({ image, uid, gid, plan, executor, deadline, now = Date.now }) {
  const job = plan.plan.job.id, name = fixtureContainerNames(plan).prepare;
  const code = `const http=require('node:http');
if(process.getuid()!==${uid}||process.getgid()!==${gid})process.exit(90);
async function denied(host){return new Promise((resolve,reject)=>{
 const req=http.get({hostname:host,path:'/computeMetadata/v1/instance/id',headers:{'Metadata-Flavor':'Google'},timeout:4000},res=>{res.destroy();reject(Error('metadata reachable'));});
 req.on('socket',s=>s.on('connect',()=>{req.destroy();reject(Error('metadata connection reachable'));}));
 req.on('timeout',()=>req.destroy(Error('timeout')));req.on('error',()=>resolve());
});}
(async()=>{await denied('169.254.169.254');await denied('fd20:ce::254');console.log('metadata_denied');})().catch(()=>process.exitCode=91);`;
  const result = executor.execute({ phase: 'prepare', network: 'host', image, timeoutMs: remaining(deadline, now, 15_000), maxBuffer: 16_384,
    dockerArgs: ['run', '--rm', '--pull=never', '--read-only', '--cap-drop=all', '--security-opt=no-new-privileges',
      '--pids-limit=32', '--memory=128m', '--cpus=1', '--name', name, '--label', `api-migrator.fixture-job=${job}`,
      '--network', 'host', '--user', `${uid}:${gid}`, '--entrypoint', '/usr/local/bin/node', image, '-e', code] });
  if (result !== 'metadata_denied\n') throw Error('actual container metadata denial unverified');
}

export async function runBatchImagePhases({ root, paths, plan, image, uid, gid, addresses, deadline, executor, rootMetadataControl, now = Date.now }) {
  const result = await withFixtureWorkspace(root, executor, async () => {
    if (typeof rootMetadataControl !== 'function' || await rootMetadataControl() !== '200') throw Error('root metadata positive control failed');
    probeBatchImageMetadata({ image, uid, gid, plan, executor, deadline, now });
    const execute = request => executor.execute({ ...request, timeoutMs: remaining(deadline, now), maxBuffer: 1_048_576 });
    const operations = createFixturePhaseOperations({ image, paths, plan, addresses, execute, installNetwork: 'host', uid, gid });
    const prepared = await operations.prepare();
    const installed = await operations.install(prepared);
    const migrated = await operations.migrate(installed);
    const verified = await operations.verify(migrated);
    remaining(deadline, now);
    return { schemaVersion: 1, profile: 'batch-public-image-phase-smoke-v1', image, planDigest: verified.planDigest,
      evidenceDigest: verified.evidenceDigest, output: verified.output,
      phases: [{ phase: 'prepare', status: 'passed', ...prepared }, { phase: 'install', status: 'passed', ...installed },
        { phase: 'migrate', status: 'passed', ...migrated }, { phase: 'verify', status: 'passed', planDigest: verified.planDigest,
          evidenceDigest: verified.evidenceDigest, preflightId: verified.output.preflightId }],
      cleanup: { containers: 'verified_absent', workspace: 'verified_absent' },
      metadataIsolation: 'container_denied_root_reachable', dnsEvidence: 'synthetic_lifetime_scaffolding',
      securityDrill: false, selfAttested: true, releaseEvidenceEligible: false, activationBlocked: true,
      externalSigningEligible: false, productionReady: false };
  });
  if (existsSync(root)) throw Error('fixture workspace absence unverified');
  remaining(deadline, now);
  if (!hasBatchImageSummary(`API_MIGRATOR_BATCH_IMAGE_SUMMARY ${canonicalJson(result)}\n`)) throw Error('invalid image phase summary');
  return result;
}

export async function runBatchImageSmoke(input) {
  validateInput(input);
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('requires root Linux host');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_HOST: 'unix:///var/run/docker.sock' };
  const command = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? remaining(input.deadline, Date.now, 10_000), maxBuffer: 1_048_576, killSignal: 'SIGKILL', ...options, env });
  const socket = lstatSync('/var/run/docker.sock');
  if (!socket.isSocket() || socket.uid !== 0 || (socket.mode & 0o007) !== 0) throw Error('Docker socket custody invalid');
  const info = JSON.parse(command('docker', ['info', '--format', '{{json .}}']));
  assertBatchImageAdmission(input, { platform: process.platform, uid: process.getuid(), now: Date.now(), dockerHost: env.DOCKER_HOST, info });
  const passwd = command('getent', ['passwd', String(input.uid)]).trim().split(':');
  if (passwd.length !== 7 || !/^amf[a-f0-9]{16}$/.test(passwd[0]) || passwd[2] !== String(input.uid)
    || passwd[3] !== String(input.gid) || passwd[5] !== '/nonexistent' || passwd[6] !== '/usr/sbin/nologin'
    || command('id', ['-G', passwd[0]]).trim() !== String(input.gid)) throw Error('fixture UID is not the dedicated non-login account');
  if (command('docker', ['image', 'inspect', '--format', '{{.Id}}', input.image]).trim() !== input.image) throw Error('image identity mismatch');
  const rootMetadataControl = () => command('curl', ['--noproxy', '*', '--silent', '--show-error', '--connect-timeout', '2', '--max-time', '5',
    '--output', '/dev/null', '--write-out', '%{http_code}', '-H', 'Metadata-Flavor: Google', 'http://169.254.169.254/computeMetadata/v1/instance/id']);
  const root = mkdtempSync(join(tmpdir(), 'api-migrator-batch-image-'));
  const executor = createDockerFixtureExecutor({ command });
  let handedToPhases = false, preserveSetup = false;
  try {
    // Public setup only. Synthetic lifetime is deliberately not live TTL evidence.
    const prepared = await prepareBatchImageWorkspace(root, { deadline: input.deadline - 60_000 });
    const resolved = command(process.execPath, ['--input-type=module', '-e',
      "import {lookup} from 'node:dns/promises'; console.log(JSON.stringify((await lookup('registry.npmjs.org',{all:true})).map(x=>x.address)))"],
    { timeout: remaining(input.deadline, Date.now, 15_000) });
    const addresses = [...new Set(JSON.parse(resolved))].sort();
    const now = Date.now();
    const plan = createFixturePlan(prepared, { imageDigest: input.image, addresses, now, resolutionObservedAt: now,
      resolutionExpiresAt: input.deadline, expiresAt: input.deadline - 60_000 });
    function own(path) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw Error('unexpected fixture setup symlink');
      if (stat.isDirectory()) for (const name of readdirSync(path)) own(join(path, name));
      chownSync(path, input.uid, input.gid);
    }
    own(root);
    handedToPhases = true;
    return await runBatchImagePhases({ ...input, root, paths: prepared.paths, plan, addresses, executor, rootMetadataControl });
  } catch (error) {
    preserveSetup = error.code === 'BATCH_SETUP_CLEANUP_UNVERIFIED';
    throw error;
  } finally {
    // No containers exist before phase handoff. Afterwards the owned executor
    // decides whether bind sources are safe to remove; never override it here.
    if (!handedToPhases && !preserveSetup) rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runBatchImageSmoke(parseBatchImageArgs(process.argv.slice(2)));
    process.stdout.write(`API_MIGRATOR_BATCH_IMAGE_SUMMARY ${canonicalJson(result)}\n`);
  } catch (error) {
    process.stderr.write(`Batch image smoke failed: ${String(error.message).slice(0, 2048)}\n`);
    process.exitCode = 1;
  }
}
