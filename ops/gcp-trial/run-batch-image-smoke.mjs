import { execFileSync, spawn } from 'node:child_process';
import { chownSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PUBLICATION_RUNNER_PLAN_MAX_TTL_MS } from '../../packages/app/dist/publication-runner.js';
import { canonicalJson } from '../publication-runner/deployment/lib.mjs';
import { assertFixtureDockerDaemon } from '../publication-runner/deployment/fixture-native.mjs';
import { createFixturePhaseOperations, createFixturePlan, fixtureContainerNames } from '../publication-runner/image/fixture-phases.mjs';
import { createDockerFixtureExecutor, withFixtureWorkspace } from '../publication-runner/image/docker-fixture-executor.mjs';
import { hasBatchImageSummary } from './batch-image-summary.mjs';
import { encodeBatchImageFailure } from './batch-image-failure.mjs';

// Provenance is private: an arbitrary thrown object's code/reason/status cannot
// masquerade as an observed subprocess outcome.
const failures = new WeakMap();
function fail(reason, message, close = { exitCode: null, signal: null }) {
  const error = Error(message);
  failures.set(error, { reason, ...close });
  return error;
}
function observedClose(code, signal) {
  const exitCode = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
  try { encodeBatchImageFailure({ stage: 'public_setup', reason: 'subprocess_failed', exitCode, signal: signal ?? null }); }
  catch { signal = null; }
  return { exitCode, signal: signal ?? null };
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
function validateInput(input) {
  if (!input || Object.keys(input).sort().join(',') !== 'deadline,gid,image,uid' || !DIGEST.test(input.image ?? '')
    || !Number.isSafeInteger(input.uid) || input.uid < 1 || input.uid > 2_147_483_647
    || !Number.isSafeInteger(input.gid) || input.gid < 1 || input.gid > 2_147_483_647
    || !Number.isSafeInteger(input.deadline) || input.deadline < 1) throw fail('invalid_input', 'invalid image controller input');
}

export function parseBatchImageArgs(args) {
  if (!Array.isArray(args) || args.length !== 8 || args.some(arg => typeof arg !== 'string')) throw fail('invalid_input', 'expected image, uid, gid and deadline only');
  const input = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2), value = args[i + 1];
    if (!['--image', '--uid', '--gid', '--deadline'].includes(args[i]) || Object.hasOwn(input, key)) throw fail('invalid_input', 'invalid or duplicate argument');
    if (key !== 'image' && !/^[1-9][0-9]*$/.test(value)) throw fail('invalid_input', 'invalid numeric argument');
    input[key] = key === 'image' ? value : Number(value);
  }
  validateInput(input); return input;
}

export function assertBatchImageAdmission(input, host) {
  validateInput(input);
  if (host.platform !== 'linux' || host.uid !== 0 || host.dockerHost !== 'unix:///var/run/docker.sock') throw fail('admission_denied', 'requires root on local Linux Docker host');
  if (!Number.isSafeInteger(host.now) || input.deadline - host.now <= 60_000 || input.deadline - host.now > 3_600_000) throw fail('deadline_exhausted', 'image deadline exhausted or unbounded');
  try { assertFixtureDockerDaemon(host.info); } catch { throw fail('admission_denied', 'Docker admission denied'); }
}

function remaining(deadline, now, cap = 1_200_000) {
  const value = Math.min(cap, deadline - now() - 60_000);
  if (!Number.isSafeInteger(value) || value < 1) throw fail('deadline_exhausted', 'image phase deadline exhausted');
  return value;
}

// New-profile-only setup boundary. The entire process group is bounded, including
// downstream Git subprocesses in the existing source-bundle API. No arbitrary
// command or module path comes from the CLI or request.
export async function prepareBatchImageWorkspace(root, { deadline }) {
  const duration = deadline - Date.now();
  if (!Number.isSafeInteger(deadline) || duration < 1 || duration > 1_200_000) throw fail('deadline_exhausted', 'public setup deadline exhausted or unbounded');
  if (typeof root !== 'string' || !isAbsolute(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw fail('invalid_input', 'invalid public setup root');
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
  const timer = setTimeout(() => { failure ??= fail('deadline_exhausted', 'public setup deadline exhausted'); killGroup(); }, duration);
  const stop = (reason, message) => { failure ??= fail(reason, message); killGroup(); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', bytes => { if (failure) return; stdout += bytes; if (Buffer.byteLength(stdout) > 1_048_576) { stdout = ''; stop('output_limit', 'public setup output too large'); } });
  child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 65_536) stop('diagnostic_limit', 'public setup diagnostics too large'); });
  const close = await new Promise(resolve => {
    child.once('error', () => { failure ??= fail('subprocess_failed', 'public setup subprocess failed'); });
    child.once('close', (code, signal) => resolve(observedClose(code, signal)));
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
  if (!absent()) throw Object.assign(fail('cleanup_unverified', 'public setup process group cleanup unverified', close), { code: 'BATCH_SETUP_CLEANUP_UNVERIFIED' });
  if (failure) { if (failures.has(failure)) failures.set(failure, { ...failures.get(failure), ...close }); throw failure; }
  if (Date.now() >= deadline) throw fail('deadline_exhausted', 'public setup deadline exhausted', close);
  if (close.exitCode !== 0) throw fail('subprocess_failed', 'public fixture preparation failed', close);
  let prepared;
  try { prepared = JSON.parse(stdout); } catch { throw fail('invalid_output', 'public preparation output invalid', close); }
  if (typeof prepared?.bundle?.bytes !== 'string') throw fail('invalid_output', 'public preparation output invalid', close);
  prepared.bundle.bytes = Buffer.from(prepared.bundle.bytes, 'base64');
  return prepared;
}

// Uses the same retained-container executor as phases: a timed-out Docker client
// is never treated as proof of probe death. Only the exact owned ID is removed.
export function probeBatchImageMetadata({ image, uid, gid, plan, executor, deadline, now = Date.now }) {
  const job = plan.plan.job.id, name = fixtureContainerNames(plan).prepare;
  const code = `const http=require('node:http');
if(process.getuid()!==${uid}||process.getgid()!==${gid}){console.error('metadata_probe_failed family=none reason=identity_mismatch');process.exit(90);}
async function denied(host,family){return new Promise((resolve,reject)=>{
 const fail=reason=>reject({family,reason});
 const req=http.get({hostname:host,path:'/computeMetadata/v1/instance/id',headers:{'Metadata-Flavor':'Google'},timeout:4000},res=>{res.destroy();fail('http_response');});
 req.on('socket',s=>s.on('connect',()=>{req.destroy();fail('connected');}));
 req.on('timeout',()=>req.destroy(Error('timeout')));req.on('error',()=>resolve());
});}
(async()=>{await denied('169.254.169.254','ipv4');await denied('fd20:ce::254','ipv6');console.log('metadata_denied');})().catch(e=>{console.error('metadata_probe_failed family='+(['ipv4','ipv6'].includes(e.family)?e.family:'none')+' reason='+(['connected','http_response'].includes(e.reason)?e.reason:'unexpected'));process.exitCode=91;});`;
  let result;
  try { result = executor.execute({ phase: 'prepare', network: 'host', image, timeoutMs: remaining(deadline, now, 15_000), maxBuffer: 16_384,
    dockerArgs: ['run', '--rm', '--pull=never', '--read-only', '--cap-drop=all', '--security-opt=no-new-privileges',
      '--pids-limit=32', '--memory=128m', '--cpus=1', '--name', name, '--label', `api-migrator.fixture-job=${job}`,
      '--network', 'host', '--user', `${uid}:${gid}`, '--entrypoint', '/usr/local/bin/node', image, '-e', code] });
  } catch (error) {
    if (failures.has(error)) throw error;
    const failure = error instanceof AggregateError ? error.errors[0] : error;
    const exit = Number.isInteger(failure?.status) && failure.status >= 0 && failure.status <= 255 ? failure.status : 'unavailable';
    const signal = ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(failure?.signal) ? failure.signal : 'none';
    const reason = String(failure?.stderr ?? '').slice(0, 1024).match(/^metadata_probe_failed (family=(?:ipv4|ipv6|none) reason=(?:connected|http_response|identity_mismatch|unexpected))$/m)?.[1] ?? 'family=none reason=unavailable';
    // Never retain raw HTTP/process output or its cause in TAP/cloud diagnostics.
    throw Error(`actual container metadata probe failed exit=${exit} signal=${signal} ${reason}`);
  }
  if (result !== 'metadata_denied\n') throw fail('invalid_output', 'actual container metadata denial unverified');
}

export function createBatchImagePlan(prepared, { image, addresses, deadline, now }) {
  return createFixturePlan(prepared, { imageDigest: image, addresses, now, resolutionObservedAt: now,
    resolutionExpiresAt: deadline, expiresAt: Math.min(deadline - 60_000, now + PUBLICATION_RUNNER_PLAN_MAX_TTL_MS) });
}

export async function runBatchImagePhases({ root, paths, plan, image, uid, gid, addresses, deadline, executor, rootMetadataControl, now = Date.now, checkpoint = () => {} }) {
  // remaining() reserves 60 seconds for cleanup. Never let that execution
  // budget exceed the validated plan, even when the outer guard is longer.
  deadline = Math.min(deadline, plan.plan.job.expiresAt + 60_000);
  const result = await withFixtureWorkspace(root, executor, async () => {
    checkpoint('root_metadata');
    if (typeof rootMetadataControl !== 'function' || await rootMetadataControl() !== '200') throw fail('admission_denied', 'root metadata positive control failed');
    checkpoint('container_metadata');
    probeBatchImageMetadata({ image, uid, gid, plan, executor, deadline, now });
    const execute = request => executor.execute({ ...request, timeoutMs: remaining(deadline, now), maxBuffer: 1_048_576 });
    const operations = createFixturePhaseOperations({ image, paths, plan, addresses, execute, installNetwork: 'host', uid, gid });
    checkpoint('prepare'); const prepared = await operations.prepare();
    checkpoint('install'); const installed = await operations.install(prepared);
    checkpoint('migrate'); const migrated = await operations.migrate(installed);
    checkpoint('verify'); const verified = await operations.verify(migrated);
    remaining(deadline, now);
    checkpoint('cleanup');
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
  if (existsSync(root)) throw fail('cleanup_unverified', 'fixture workspace absence unverified');
  checkpoint('summary_validation');
  remaining(deadline, now);
  if (!hasBatchImageSummary(`API_MIGRATOR_BATCH_IMAGE_SUMMARY ${canonicalJson(result)}\n`)) throw fail('invalid_output', 'invalid image phase summary');
  return result;
}

export async function runBatchImageSmoke(input, { checkpoint = () => {} } = {}) {
  validateInput(input);
  checkpoint('admission');
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw fail('admission_denied', 'requires root Linux host');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_HOST: 'unix:///var/run/docker.sock' };
  const command = (file, args, options = {}) => {
    const timeout = options.timeout ?? remaining(input.deadline, Date.now, 10_000);
    try { return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout, maxBuffer: 1_048_576, killSignal: 'SIGKILL', ...options, env }); }
    catch (error) {
      // These properties come directly from this subprocess boundary, never an
      // arbitrary phase exception or an AggregateError assembled elsewhere.
      throw fail(error.code === 'ETIMEDOUT' ? 'deadline_exhausted' : error.code === 'ENOBUFS' ? 'output_limit' : 'subprocess_failed',
        'controller subprocess failed', observedClose(error.status, error.signal));
    }
  };
  const socket = lstatSync('/var/run/docker.sock');
  if (!socket.isSocket() || socket.uid !== 0 || (socket.mode & 0o007) !== 0) throw fail('admission_denied', 'Docker socket custody invalid');
  const info = JSON.parse(command('docker', ['info', '--format', '{{json .}}']));
  assertBatchImageAdmission(input, { platform: process.platform, uid: process.getuid(), now: Date.now(), dockerHost: env.DOCKER_HOST, info });
  const passwd = command('getent', ['passwd', String(input.uid)]).trim().split(':');
  if (passwd.length !== 7 || !/^amf[a-f0-9]{16}$/.test(passwd[0]) || passwd[2] !== String(input.uid)
    || passwd[3] !== String(input.gid) || passwd[5] !== '/nonexistent' || passwd[6] !== '/usr/sbin/nologin'
    || command('id', ['-G', passwd[0]]).trim() !== String(input.gid)) throw fail('admission_denied', 'fixture UID is not the dedicated non-login account');
  if (command('docker', ['image', 'inspect', '--format', '{{.Id}}', input.image]).trim() !== input.image) throw fail('admission_denied', 'image identity mismatch');
  const rootMetadataControl = () => command('curl', ['--noproxy', '*', '--silent', '--show-error', '--connect-timeout', '2', '--max-time', '5',
    '--output', '/dev/null', '--write-out', '%{http_code}', '-H', 'Metadata-Flavor: Google', 'http://169.254.169.254/computeMetadata/v1/instance/id']);
  const root = mkdtempSync(join(tmpdir(), 'api-migrator-batch-image-'));
  const executor = createDockerFixtureExecutor({ command });
  let handedToPhases = false, preserveSetup = false;
  try {
    // Public setup only. Synthetic lifetime is deliberately not live TTL evidence.
    checkpoint('public_setup');
    const prepared = await prepareBatchImageWorkspace(root, { deadline: input.deadline - 60_000 });
    checkpoint('registry_resolution');
    const resolved = command(process.execPath, ['--input-type=module', '-e',
      "import {lookup} from 'node:dns/promises'; console.log(JSON.stringify((await lookup('registry.npmjs.org',{all:true})).map(x=>x.address)))"],
    { timeout: remaining(input.deadline, Date.now, 15_000) });
    const addresses = [...new Set(JSON.parse(resolved))].sort();
    const now = Date.now();
    checkpoint('fixture_plan');
    const plan = createBatchImagePlan(prepared, { image: input.image, addresses, now, deadline: input.deadline });
    function own(path) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw Error('unexpected fixture setup symlink');
      if (stat.isDirectory()) for (const name of readdirSync(path)) own(join(path, name));
      chownSync(path, input.uid, input.gid);
    }
    checkpoint('fixture_ownership'); own(root);
    handedToPhases = true;
    return await runBatchImagePhases({ ...input, root, paths: prepared.paths, plan, addresses, executor, rootMetadataControl, checkpoint });
  } catch (error) {
    preserveSetup = error.code === 'BATCH_SETUP_CLEANUP_UNVERIFIED';
    throw error;
  } finally {
    // No containers exist before phase handoff. Afterwards the owned executor
    // decides whether bind sources are safe to remove; never override it here.
    if (!handedToPhases && !preserveSetup) rmSync(root, { recursive: true, force: true });
  }
}

export async function runBatchImageCli(args, { run = runBatchImageSmoke, stdout = process.stdout, stderr = process.stderr } = {}) {
  let stage = 'controller_entry';
  const checkpoint = next => {
    encodeBatchImageFailure({ stage: next, reason: 'unexpected', exitCode: null, signal: null });
    stage = next;
  };
  try {
    const result = await run(parseBatchImageArgs(args), { checkpoint });
    stdout.write(`API_MIGRATOR_BATCH_IMAGE_SUMMARY ${canonicalJson(result)}\n`);
    return 0;
  } catch (error) {
    const details = failures.get(error) ?? { reason: 'unexpected', exitCode: null, signal: null };
    stdout.write(encodeBatchImageFailure({ stage, ...details }));
    stderr.write('Batch image smoke failed.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runBatchImageCli(process.argv.slice(2));
}
