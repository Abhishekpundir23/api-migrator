import { decideCleanup, validateTrialOwnership } from "./cleanup.mjs";
import { collectTrialInventory } from "./inventory.mjs";

// One read, not a watchdog: advisory nextCheckAt does not schedule anything.
export async function observeTrialCleanup(planJson, ownershipJson, token, {
  expectedAccount, reason = "deadline", fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 20_000,
} = {}) {
  try {
    if (!["deadline", "completed", "failed", "cancelled", "controller_failure"].includes(reason)) throw new Error();
    const startedAt = now();
    const { plan, ownership } = validateTrialOwnership(planJson, ownershipJson, { nowMs: startedAt });
    let lastTime = startedAt;
    const checkClock = () => {
      const value = now();
      if (!Number.isSafeInteger(value) || value < lastTime || value > 8_640_000_000_000_000
        || value - startedAt > 20_000) throw new Error();
      lastTime = value;
      return value;
    };
    const { inventory } = await collectTrialInventory(token, { expectedAccount, fetchImpl, now: checkClock, timeoutMs });
    const completedAt = checkClock();
    const decision = decideCleanup(planJson, ownershipJson, JSON.stringify(inventory), { nowMs: completedAt, reason });
    return {
      schemaVersion: 1, kind: "api_migrator_gcp_cleanup_observation", startedAt, completedAt,
      requestedReason: reason, ownershipDigest: ownership.ownershipDigest, status: decision.status,
      deadlineReached: completedAt >= plan.deleteAt, overdueMs: Math.max(0, completedAt - plan.deleteAt),
      requiresOperatorAttention: decision.status === "blocked",
      nextCheckAt: decision.status === "waiting" ? Math.min(completedAt + 30_000, plan.deleteAt) : null,
      decision, executionBlocked: true, activationBlocked: true, cloudVerified: false,
      cleanupVerified: false, releaseEvidenceEligible: false, evidenceAuthenticityVerified: false,
      independentControllerReady: false,
    };
  } catch { throw new Error("GCP cleanup observation failed"); }
}
