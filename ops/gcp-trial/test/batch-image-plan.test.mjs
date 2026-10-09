import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as controller from '../run-batch-image-smoke.mjs';
import { createFixturePlan } from '../../publication-runner/image/fixture-phases.mjs';

const now = 2_000_000_000_000;
const image = `sha256:${'a'.repeat(64)}`;
function prepared(root) {
  // Real builder inputs; source payload is synthetic because these tests stop
  // at plan creation and never claim to execute a source bundle.
  const bytes = Buffer.from('plan-only synthetic source');
  return { paths: { planPath: join(root, 'plan.json'), sourcePath: join(root, 'source.bundle') },
    repository: { slug: 'sandbox-owner/runner-fixture', id: 910001, ownerId: 910002 },
    base: { branch: 'main', sha: 'b'.repeat(40), treeSha: 'c'.repeat(40) }, manifestJson: '{"synthetic":"plan-only"}',
    bundle: { bytes, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` } };
}

test('public controller plan construction caps the 1200-second window without extending short deadlines', () => {
  assert.equal(typeof controller.createBatchImagePlan, 'function');
  for (const [remaining, lifetime] of [[1200000, 900000], [1051874, 900000], [960001, 900000],
    [960000, 900000], [959999, 899999], [600000, 540000], [120001, 60001], [120000, 60000], [119999, null]]) {
    const root = mkdtempSync(join(tmpdir(), 'batch-plan-window-'));
    try {
      const input = prepared(root);
      const run = () => controller.createBatchImagePlan(input, { image, addresses: ['104.16.1.35'], now, deadline: now + remaining });
      if (lifetime === null) {
        assert.throws(run, /between 1 and 15 minutes/);
        assert.equal(existsSync(input.paths.planPath), false); assert.equal(existsSync(input.paths.sourcePath), false);
      } else {
        const result = run();
        assert.equal(result.plan.job.createdAt, now); assert.equal(result.plan.job.expiresAt, now + lifetime);
        assert.equal(result.plan.egress.install.destinations[0].resolutionObservedAt, now);
        assert.equal(result.plan.egress.install.destinations[0].resolutionExpiresAt, now + remaining);
        assert.equal(readFileSync(input.paths.planPath, 'utf8'), result.canonicalJson);
        assert.deepEqual(readFileSync(input.paths.sourcePath), input.bundle.bytes);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('shared production lifetime validator still rejects maximum plus one and minimum minus one', () => {
  for (const lifetime of [59999, 60000, 60001, 899999, 900000, 900001]) {
    const root = mkdtempSync(join(tmpdir(), 'batch-plan-policy-'));
    try {
      const input = prepared(root);
      const run = () => createFixturePlan(input, { imageDigest: image, addresses: ['104.16.1.35'],
        now, resolutionObservedAt: now, resolutionExpiresAt: now + 1200000, expiresAt: now + lifetime });
      if (lifetime === 59999 || lifetime === 900001) {
        assert.throws(run, /between 1 and 15 minutes/);
        assert.equal(existsSync(input.paths.planPath), false); assert.equal(existsSync(input.paths.sourcePath), false);
      } else assert.equal(run().plan.job.expiresAt, now + lifetime);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
