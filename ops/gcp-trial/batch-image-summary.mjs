import { createHash } from 'node:crypto';

// Standalone function: embedded into the root-owned emitter and independently
// applied to reconstructed bytes by the operator. Canonical encoding rejects
// duplicate JSON keys, extra output, and all unrecognized fields.
export function hasBatchImageSummary(output) {
  try {
    if (typeof output !== 'string' || Buffer.byteLength(output) > 16_384) return false;
    const prefix = 'API_MIGRATOR_BATCH_IMAGE_SUMMARY ';
    if (!output.startsWith(prefix) || !output.endsWith('\n')) return false;
    const s = JSON.parse(output.slice(prefix.length));
    const canonical = (v) => v && typeof v === 'object'
      ? Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
        : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
      : JSON.stringify(v);
    if (output !== `${prefix}${canonical(s)}\n`) return false;
    const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v)
      && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
    const digest = (v) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
    if (!exact(s, ['schemaVersion', 'profile', 'image', 'planDigest', 'evidenceDigest', 'output', 'phases', 'cleanup',
      'metadataIsolation', 'dnsEvidence', 'securityDrill', 'selfAttested', 'releaseEvidenceEligible', 'activationBlocked',
      'externalSigningEligible', 'productionReady']) || s.schemaVersion !== 1 || s.profile !== 'batch-public-image-phase-smoke-v1'
      || ![s.image, s.planDigest, s.evidenceDigest].every(digest)
      || !exact(s.output, ['preflightId', 'artifactDigest', 'candidateTreeSha'])
      || !/^pf_[a-f0-9]{64}$/.test(s.output.preflightId) || !digest(s.output.artifactDigest)
      || !/^[a-f0-9]{40}$/.test(s.output.candidateTreeSha)
      || !exact(s.cleanup, ['containers', 'workspace']) || s.cleanup.containers !== 'verified_absent' || s.cleanup.workspace !== 'verified_absent'
      || s.metadataIsolation !== 'container_denied_root_reachable' || s.dnsEvidence !== 'synthetic_lifetime_scaffolding'
      || s.securityDrill !== false || s.selfAttested !== true || s.releaseEvidenceEligible !== false || s.activationBlocked !== true
      || s.externalSigningEligible !== false || s.productionReady !== false || !Array.isArray(s.phases) || s.phases.length !== 4) return false;
    const [p, i, m, v] = s.phases;
    return exact(p, ['phase', 'status', 'preparedStateDigest']) && p.phase === 'prepare' && p.status === 'passed' && digest(p.preparedStateDigest)
      && exact(i, ['phase', 'status', 'preparedStateDigest', 'installStateDigest']) && i.phase === 'install' && i.status === 'passed'
      && i.preparedStateDigest === p.preparedStateDigest && digest(i.installStateDigest)
      && exact(m, ['phase', 'status', 'preparedStateDigest', 'installStateDigest', 'dependencyStateDigest']) && m.phase === 'migrate' && m.status === 'passed'
      && m.preparedStateDigest === p.preparedStateDigest && m.installStateDigest === i.installStateDigest && digest(m.dependencyStateDigest)
      && exact(v, ['phase', 'status', 'planDigest', 'evidenceDigest', 'preflightId']) && v.phase === 'verify' && v.status === 'passed'
      && v.planDigest === s.planDigest && v.evidenceDigest === s.evidenceDigest && v.preflightId === s.output.preflightId;
  } catch { return false; }
}

export function encodeBatchImageLog(bytes, context) {
  if (bytes.length > 4_194_304) throw new Error('worker log too large');
  const chunks = [];
  for (let start = 0; start < bytes.length; start += 3072)
    chunks.push(`API_MIGRATOR_BATCH_LOG ${JSON.stringify({ runId: context.runId, index: chunks.length, data: bytes.subarray(start, start + 3072).toString('base64') })}`);
  return [...chunks, `API_MIGRATOR_BATCH_RESULT ${JSON.stringify({ schemaVersion: 1, profile: 'batch-public-image-phase-smoke-v1', ...context,
    status: context.exitCode === 0 && context.phase === 'complete' && hasBatchImageSummary(bytes.toString('utf8')) ? 'passed' : 'failed',
    logBytes: bytes.length, logChunks: chunks.length, logSha256: createHash('sha256').update(bytes).digest('hex'), activationBlocked: true })}`];
}
