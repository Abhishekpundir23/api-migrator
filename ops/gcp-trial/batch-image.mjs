import { createHash } from 'node:crypto';
import { prepareBatch } from './batch.mjs';
import { renderBatchImageScript } from './batch-image-bootstrap.mjs';

export function prepareBatchImage(request, options) {
  const prepared = prepareBatch(request, options);
  // Reuse the strict eight-field validator and all fixed resource policy.
  const script = renderBatchImageScript({ runId: prepared.runId, deleteAt: prepared.deleteAt }, prepared.source);
  prepared.profile = 'batch-public-image-phase-smoke-v1';
  prepared.job.taskGroups[0].taskSpec.runnables[0].script.text = script;
  prepared.scriptSha256 = createHash('sha256').update(script).digest('hex');
  prepared.limitations.push('synthetic_dns_lifetime_is_not_gateway_enforcement', 'rootful_public_image_protocol_only');
  return prepared;
}
