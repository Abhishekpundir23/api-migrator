import { canonicalJson } from "./canonical-json.js";
import {
  RunnerEvidenceError, runnerEvidenceDigest, runnerEvidenceFailure,
  validateRetainedRunnerEvidenceIdentity, validateRunnerEvidenceContext,
  type RetainedRunnerEvidenceIdentity, type RunnerEvidenceClient, type RunnerEvidenceContext,
  type RunnerEvidenceFailureCode, type RunnerEvidenceResult,
} from "./runner-evidence-contract.js";
import { createRunnerEvidenceDeadline, type RunnerEvidenceClock, type RunnerEvidenceDeadline } from "./runner-evidence-deadline.js";
import type { RunnerKeySelection } from "./runner-key-registry.js";
import { verifyPublicationRunnerAttestation } from "./publication-runner.js";

export interface RunnerEvidenceDependencies {
  clock: RunnerEvidenceClock;
  readKey(context: Readonly<RunnerEvidenceContext>, deadline: RunnerEvidenceDeadline): Promise<RunnerKeySelection>;
  fetchEnvelope(jobId: string, deadline: RunnerEvidenceDeadline): Promise<string>;
}

/** Source-internal orchestration seam. The genuine verifier is never injectable. */
export function createRunnerEvidenceClientWithDependencies(dependencies: RunnerEvidenceDependencies): RunnerEvidenceClient {
  async function acquire(input: unknown, retainedInput: unknown, reacquiring: boolean): Promise<RunnerEvidenceResult> {
    let deadline: RunnerEvidenceDeadline | undefined;
    let stage: RunnerEvidenceFailureCode = "expired";
    try {
      deadline = createRunnerEvidenceDeadline(dependencies.clock, dependencies.clock.wallNow() + 10_000);
      stage = "expected_context_invalid";
      // Both caller-owned objects are validated, detached and frozen before the
      // first await. A retained identity is metadata, never runtime authority.
      const context = validateRunnerEvidenceContext(input, deadline.check());
      const contextDigest = runnerEvidenceDigest(context);
      deadline.cap(Math.min(context.previewCompletedAt + 600_000, context.plan.plan.job.expiresAt));
      const retained = reacquiring ? validateRetainedRunnerEvidenceIdentity(retainedInput) : undefined;
      if (retained) {
        deadline.cap(retained.expiresAt);
        if (retained.contextDigest !== contextDigest || retained.jobId !== context.plan.plan.job.id || retained.planDigest !== context.plan.digest) {
          return runnerEvidenceFailure("identity_changed");
        }
      }

      stage = "trust_unavailable";
      const budget = deadline;
      // Budget entire dependencies as well as their inner IO: late descriptor
      // cleanup stays owned by the reader but cannot hold this caller open.
      const firstKey = await budget.run(() => dependencies.readKey(context, budget));
      budget.cap(firstKey.trust.validUntil);
      stage = "evidence_unavailable";
      const envelope = await budget.run(() => dependencies.fetchEnvelope(context.plan.plan.job.id, budget));
      stage = "trust_unavailable";
      const freshKey = await budget.run(() => dependencies.readKey(context, budget));
      budget.cap(freshKey.trust.validUntil);
      if (freshKey.trustDigest !== firstKey.trustDigest) return runnerEvidenceFailure("trust_unavailable");

      stage = "evidence_invalid";
      const verified = verifyPublicationRunnerAttestation(
        envelope, context.plan, context.reviewedOutput, freshKey.trust, budget.check(),
      );
      // Verification is synchronous, so explicitly reject time spent there too.
      validateRunnerEvidenceContext(context, budget.check());
      const identity: RetainedRunnerEvidenceIdentity = {
        schemaVersion: 1,
        contextDigest,
        jobId: context.plan.plan.job.id,
        planDigest: context.plan.digest,
        attestationPayloadDigest: verified.payloadDigest,
        attestationEnvelopeDigest: verified.envelopeDigest,
        signerKeyId: verified.signer.keyId,
        signerFingerprint: verified.signer.fingerprint,
        signerTrustDigest: freshKey.trustDigest,
        expiresAt: Math.min(context.previewCompletedAt + 600_000, context.plan.plan.job.expiresAt, freshKey.trust.validUntil),
      };
      if (retained && canonicalJson(identity) !== canonicalJson(retained)) return runnerEvidenceFailure("identity_changed");
      const detachedIdentity = validateRetainedRunnerEvidenceIdentity(identity);
      budget.check();
      // Preserve the original branded object. Its hidden plan/key expiry is
      // unchanged; identity.expiresAt additionally limits preview reacquisition.
      return Object.freeze({ ok: true as const, verified, identity: detachedIdentity });
    } catch (error) {
      return runnerEvidenceFailure(error instanceof RunnerEvidenceError ? error.code : stage);
    } finally {
      deadline?.close();
    }
  }
  return Object.freeze({
    acquireInitial: (context: unknown) => acquire(context, undefined, false),
    reacquire: (context: unknown, identity: unknown) => acquire(context, identity, true),
  });
}
