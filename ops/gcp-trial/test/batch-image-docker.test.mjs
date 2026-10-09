import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createDockerFixtureExecutor } from '../../publication-runner/image/docker-fixture-executor.mjs';
import { createBatchImagePlan, prepareBatchImageWorkspace, runBatchImagePhases } from '../run-batch-image-smoke.mjs';
import { hasBatchImageSummary, encodeBatchImageLog } from '../batch-image-summary.mjs';
import { canonicalJson } from '../../publication-runner/deployment/lib.mjs';
import { prepareBatchImage } from '../batch-image.mjs';
import { classifyBatchResult } from '../batch-result.mjs';
import { installMetadataPolicy, cleanupMetadataPolicy } from './batch-image-metadata-policy.mjs';

// Real pinned public image, phase commands, reports, binding and exact cleanup.
// GCE root metadata reachability is substituted. Linux CI installs a test-owned
// UID policy; Mac denial is NOT evidence that nft enforces the GCE policy.
test('real Docker image four-phase protocol and failed/timeout cleanup remain non-authorizing', {
  skip: process.env.API_MIGRATOR_DOCKER_TEST !== '1', timeout: 1_000_000,
}, async t => {
  const buildRoot = mkdtempSync(join(tmpdir(), 'batch-image-build-'));
  t.after(() => rmSync(buildRoot, { recursive: true, force: true }));
  const iidfile = join(buildRoot, 'image.id');
  execFileSync('docker', ['build', '--file', 'ops/publication-runner/image/Dockerfile', '--iidfile', iidfile, '.'],
    { cwd: resolve(new URL('../../../', import.meta.url).pathname), encoding: 'utf8', timeout: 600_000, maxBuffer: 4_194_304, stdio: ['ignore', 'pipe', 'pipe'] });
  const image = readFileSync(iidfile, 'utf8').trim(); assert.match(image, /^sha256:[a-f0-9]{64}$/); t.diagnostic(`real image ${image}`);
  const deadline = Date.now() + 1_200_000;
  const root = mkdtempSync(join(tmpdir(), 'batch-image-real-'));
  const prepared = await prepareBatchImageWorkspace(root, { deadline: deadline - 60_000 });
  const addresses = [...new Set((await lookup('registry.npmjs.org', { all: true })).map(x => x.address))].sort();
  const now = Date.now();
  const plan = createBatchImagePlan(prepared, { image, addresses, now, deadline });
  assert(plan.plan.job.expiresAt - now <= 900_000);
  assert(plan.plan.job.expiresAt <= deadline - 60_000);
  const ids = [];
  const executor = createDockerFixtureExecutor({ command(file, args, options) {
    if (args[0] === 'start') assert(options.timeout > 0 && options.timeout <= 900_000);
    const output = execFileSync(file, args, options);
    if (args[0] === 'create') ids.push(output.trim());
    return output;
  } });
  t.after(() => { executor.assertCleanupComplete(); t.diagnostic(`metadata policy cleanup ${JSON.stringify(cleanupMetadataPolicy())}`); });
  t.diagnostic(`metadata policy ${JSON.stringify(installMetadataPolicy(plan.plan.job.id))}`);
  const result = await runBatchImagePhases({ root, paths: prepared.paths, plan, image,
    uid: process.getuid() || 1000, gid: process.getgid() || 1000, addresses, deadline, executor, rootMetadataControl: () => '200' });
  assert.equal(existsSync(root), false); executor.assertCleanupComplete(); assert.equal(ids.length, 5);
  for (const id of ids) assert.equal(execFileSync('docker', ['container', 'ls', '--all', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}'],
    { encoding: 'utf8', timeout: 10_000 }).trim(), '');
  const output = `API_MIGRATOR_BATCH_IMAGE_SUMMARY ${canonicalJson(result)}\n`;
  assert.equal(hasBatchImageSummary(output), true);
  t.diagnostic(output.trim());
  const issuedAt = Date.now();
  const artifact = prepareBatchImage({ projectId: 'project-32bf49a2-bd30-4956-850', runId: 'a'.repeat(32),
    sourceRevision: 'b'.repeat(40), sourceArchiveSha256: 'c'.repeat(64), bootImage: 'batch-debian-12-official-20261008-00',
    network: 'api-migrator-trial-net', subnetwork: 'api-migrator-trial-sub', deleteAt: issuedAt + 1_800_000 }, { nowMs: issuedAt });
  const accepted = { name: `projects/${artifact.projectId}/locations/us-central1/jobs/${artifact.jobId}`, uid: 'local-protocol-fixture', createTime: new Date(issuedAt + 1).toISOString() };
  const records = encodeBatchImageLog(Buffer.from(output), { runId: artifact.runId, sourceRevision: artifact.source.revision,
    sourceArchiveSha256: artifact.source.sha256, phase: 'complete', exitCode: 0 });
  const classified = classifyBatchResult({ prepared: artifact, accepted, job: { ...structuredClone(artifact.job), ...accepted,
    updateTime: new Date(issuedAt + 2).toISOString(), status: { state: 'SUCCEEDED' } }, logs: { jobUid: accepted.uid, complete: true, records } });
  assert.deepEqual(classified, { smoke: 'passed', cleanup: 'unverified', activationBlocked: true, productionReady: false });
  const failureRoot = mkdtempSync(join(tmpdir(), 'batch-image-real-failure-'));
  // Reuse public plan bindings but give prepare a corrupt archive: the real
  // runner refuses it and the real executor still removes both owned containers.
  const sourcePath = join(failureRoot, 'source.bundle'); writeFileSync(sourcePath, 'corrupt');
  const planPath = join(failureRoot, 'plan.json'); writeFileSync(planPath, plan.canonicalJson);
  const failedPaths = { sourcePath, planPath };
  for (const name of ['dependencies', 'installation', 'output', 'result']) {
    failedPaths[name] = join(failureRoot, name); mkdirSync(failedPaths[name]);
  }
  await assert.rejects(runBatchImagePhases({ root: failureRoot, paths: failedPaths, plan, image,
    uid: process.getuid() || 1000, gid: process.getgid() || 1000, addresses, deadline, executor, rootMetadataControl: () => '200' }));
  assert.equal(existsSync(failureRoot), false); executor.assertCleanupComplete();
  const childEnv = { ...process.env, FIXTURE_TEST_IMAGE: image };
  delete childEnv.NODE_TEST_CONTEXT;
  const failures = spawnSync(process.execPath, ['--test', new URL('../../publication-runner/image/test/docker-fixture-executor-docker.mjs', import.meta.url).pathname],
    { env: childEnv, encoding: 'utf8', timeout: 60_000, maxBuffer: 1_048_576 });
  assert.equal(failures.status, 0, failures.stdout + failures.stderr);
  assert.match(failures.stdout, /# tests 2\n[\s\S]*# pass 2\n[\s\S]*# fail 0\n/);
  t.diagnostic(failures.stdout.trim());
});
