export const RUNNER_CAPABILITY_PROVIDER_AVAILABLE = false;

export const RUNNER_CAPABILITY_UNAVAILABLE_MESSAGE =
  "owner challenge and publication are unavailable until the verified runner-capability provider is deployed";

const RUNNER_CAPABILITY_ACTIONS = new Set([
  "prepare_owner_challenge",
  "prepare_publish",
  "publish",
]);

export function isRunnerCapabilityActionBlocked(action: unknown): boolean {
  // This server boundary is intentionally unconditional. A future provider
  // integration must replace the gate with fresh capability acquisition and
  // verification; changing the UI availability constant must never expose the
  // legacy post-preview handlers.
  return typeof action === "string" && RUNNER_CAPABILITY_ACTIONS.has(action);
}
