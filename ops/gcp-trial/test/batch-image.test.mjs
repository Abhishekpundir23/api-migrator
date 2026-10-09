import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareBatch } from '../batch.mjs';
import { classifyBatchResult } from '../batch-result.mjs';
import { canonicalJson } from '../../publication-runner/deployment/lib.mjs';

const nowMs = 2_000_000_000_000;
const request = (extra = {}) => ({ projectId: 'project-32bf49a2-bd30-4956-850', runId: 'a'.repeat(32),
  sourceRevision: 'b'.repeat(40), sourceArchiveSha256: 'c'.repeat(64),
  bootImage: 'batch-debian-12-official-20261008-00', network: 'api-migrator-trial-net',
  subnetwork: 'api-migrator-trial-sub', deleteAt: nowMs + 1_800_000, ...extra });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const load = async (name) => { const module = await import(`../${name}.mjs`).catch(() => null); assert(module, `${name} implementation must exist`); return module; };
const D = (c) => `sha256:${c.repeat(64)}`;
export const summary = () => ({ schemaVersion: 1, profile: 'batch-public-image-phase-smoke-v1', image: D('a'),
  planDigest: D('b'), evidenceDigest: D('c'),
  output: { preflightId: `pf_${'d'.repeat(64)}`, artifactDigest: D('e'), candidateTreeSha: 'f'.repeat(40) },
  phases: [{ phase: 'prepare', status: 'passed', preparedStateDigest: D('1') },
    { phase: 'install', status: 'passed', preparedStateDigest: D('1'), installStateDigest: D('2') },
    { phase: 'migrate', status: 'passed', preparedStateDigest: D('1'), installStateDigest: D('2'), dependencyStateDigest: D('3') },
    { phase: 'verify', status: 'passed', planDigest: D('b'), evidenceDigest: D('c'), preflightId: `pf_${'d'.repeat(64)}` }],
  cleanup: { containers: 'verified_absent', workspace: 'verified_absent' }, metadataIsolation: 'container_denied_root_reachable',
  dnsEvidence: 'synthetic_lifetime_scaffolding', securityDrill: false, selfAttested: true,
  releaseEvidenceEligible: false, activationBlocked: true, externalSigningEligible: false, productionReady: false });
export const summaryLine = (value) => `API_MIGRATOR_BATCH_IMAGE_SUMMARY ${canonicalJson(value)}\n`;

test('image preparation preserves resource bounds while binding a distinct script and rejecting expanded authority', async () => {
  const { prepareBatchImage } = await load('batch-image');
  const engine = prepareBatch(request(), { nowMs }), image = prepareBatchImage(request(), { nowMs });
  assert.equal(image.profile, 'batch-public-image-phase-smoke-v1');
  assert.equal(engine.profile, undefined);
  assert.notEqual(image.scriptSha256, engine.scriptSha256);
  const script = image.job.taskGroups[0].taskSpec.runnables[0].script.text;
  assert.equal(image.scriptSha256, sha(script));
  assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0);
  const parity = structuredClone(image); delete parity.profile;
  parity.scriptSha256 = engine.scriptSha256;
  parity.job.taskGroups[0].taskSpec.runnables = engine.job.taskGroups[0].taskSpec.runnables;
  parity.limitations = engine.limitations;
  assert.deepEqual(parity, engine);
  for (const extra of [{ command: 'true' }, { registry: 'example.org' }, { image: D('a') }, { uid: 0 }, { profile: 'evil' }])
    assert.throws(() => prepareBatchImage(request(extra), { nowMs }));
  const expired = prepareBatchImage(request({ deleteAt: 1_800_000 }), { nowMs: 0 });
  assert.equal(spawnSync('bash', ['-se'], { input: expired.job.taskGroups[0].taskSpec.runnables[0].script.text }).status, 70);
});

test('image CLI only renders the bounded request and refuses execution flags without gcloud', t => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-image-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'request.json'); writeFileSync(input, JSON.stringify(request({ deleteAt: Date.now() + 1_800_000 })));
  const cli = new URL('../prepare-batch-image.mjs', import.meta.url).pathname;
  const run = args => spawnSync(process.execPath, [cli, ...args], { env: { PATH: dir }, encoding: 'utf8' });
  const rendered = run(['--input', input]); assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(JSON.parse(rendered.stdout).profile, 'batch-public-image-phase-smoke-v1');
  const refused = run(['--input', input, '--execute']); assert.equal(refused.status, 2); assert.equal(refused.stdout, '');
});

test('image summary requires one canonical complete digest-bound non-authorizing record', async () => {
  const { hasBatchImageSummary } = await load('batch-image-summary');
  assert.equal(hasBatchImageSummary(summaryLine(summary())), true);
  for (const mutation of [s => s.phases.reverse(), s => s.phases.pop(), s => s.phases[1].preparedStateDigest = D('9'),
    s => s.phases[2].installStateDigest = D('9'), s => s.phases[3].evidenceDigest = D('9'),
    s => s.phases[3].preflightId = `pf_${'9'.repeat(64)}`, s => s.output = {}, s => s.cleanup.containers = 'unknown',
    s => s.cleanup.workspace = 'unknown', s => s.image = 'runner:latest', s => s.securityDrill = true,
    s => s.selfAttested = false, s => s.releaseEvidenceEligible = true, s => s.activationBlocked = false,
    s => s.externalSigningEligible = true, s => s.productionReady = true, s => s.unknown = true]) {
    const value = summary(); mutation(value); assert.equal(hasBatchImageSummary(summaryLine(value)), false);
  }
  const good = summaryLine(summary());
  for (const bad of ['', '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
    good + good, 'ordinary\n' + good, good.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    good.replace('"schemaVersion":1', '"schemaVersion": 1'), ' '.repeat(65537), null])
    assert.equal(hasBatchImageSummary(bad), false);
});

test('classifier dispatch separates engine TAP and image evidence including emitted guest records', async () => {
  const { prepareBatchImage } = await load('batch-image');
  const { encodeBatchImageLog } = await load('batch-image-summary');
  const prepared = prepareBatchImage(request(), { nowMs });
  const accepted = { name: `projects/${prepared.projectId}/locations/us-central1/jobs/${prepared.jobId}`, uid: 'job-123', createTime: new Date(nowMs + 1000).toISOString() };
  const job = { ...structuredClone(prepared.job), ...accepted, updateTime: new Date(nowMs + 2000).toISOString(), status: { state: 'SUCCEEDED' } };
  const context = { runId: prepared.runId, sourceRevision: prepared.source.revision, sourceArchiveSha256: prepared.source.sha256, phase: 'complete', exitCode: 0 };
  const f = { prepared, accepted, job, logs: { jobUid: accepted.uid, complete: true, records: encodeBatchImageLog(Buffer.from(summaryLine(summary())), context) } };
  assert.equal(classifyBatchResult(f).smoke, 'passed');
  f.logs.records = encodeBatchImageLog(Buffer.from('# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'), context);
  assert.equal(classifyBatchResult(f).smoke, 'unverified');
  f.prepared.profile = 'unknown'; assert.throws(() => classifyBatchResult(f), /profile/);
  f.prepared.profile = null; assert.throws(() => classifyBatchResult({ prepared: f.prepared }), /profile/);
  f.prepared.profile = 'batch-engine-smoke-v1'; assert.throws(() => classifyBatchResult(f), /identity/);
});
