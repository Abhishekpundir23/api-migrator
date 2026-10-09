// Self-contained for embedding in the trusted bootstrap emitter. No error
// object, message or arbitrary subprocess output enters this protocol.
export function encodeBatchImageFailure(input) {
  const stages = ['controller_entry', 'admission', 'public_setup', 'registry_resolution', 'fixture_plan', 'fixture_ownership',
    'root_metadata', 'container_metadata', 'prepare', 'install', 'migrate', 'verify', 'cleanup', 'summary_validation'];
  const reasons = ['invalid_input', 'admission_denied', 'deadline_exhausted', 'output_limit', 'diagnostic_limit',
    'subprocess_failed', 'cleanup_unverified', 'invalid_output', 'unexpected', 'controller_unavailable'];
  const signals = ['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE',
    'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGXCPU', 'SIGXFSZ'];
  if (!input || Object.keys(input).sort().join(',') !== 'exitCode,reason,signal,stage'
    || !stages.includes(input.stage) || !reasons.includes(input.reason)
    || !(input.exitCode === null || Number.isInteger(input.exitCode) && input.exitCode >= 0 && input.exitCode <= 255)
    || !(input.signal === null || signals.includes(input.signal))) throw Error('invalid failure record');
  const line = `API_MIGRATOR_BATCH_IMAGE_FAILURE ${JSON.stringify({ schemaVersion: 1, stage: input.stage,
    reason: input.reason, exitCode: input.exitCode, signal: input.signal })}\n`;
  if (Buffer.byteLength(line) > 1024) throw Error('failure record too large');
  return line;
}
