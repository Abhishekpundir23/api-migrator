const EXECUTION_STEPS = Object.freeze([
  "installPolicy", "prepare", "startGateway", "probeOnline", "install",
  "stopGateway", "assertOffline", "migrate", "verify",
]);
const OPERATION_NAMES = Object.freeze([...EXECUTION_STEPS, "cleanup"]);

export async function runFixtureLifecycle(operations) {
  const descriptors = operations && typeof operations === "object" && !Array.isArray(operations)
    ? Object.getOwnPropertyDescriptors(operations) : null;
  if (!operations || typeof operations !== "object" || Array.isArray(operations)
    || Reflect.ownKeys(operations).length !== OPERATION_NAMES.length
    || OPERATION_NAMES.some((name) => !descriptors[name]
      || !Object.hasOwn(descriptors[name], "value")
      || typeof descriptors[name].value !== "function")) {
    throw new TypeError("fixture operations must provide exactly the ten named functions");
  }
  const functions = Object.fromEntries(OPERATION_NAMES.map((name) => [name, descriptors[name].value]));

  let result;
  let failure;
  let failed = false;
  try {
    for (const step of EXECUTION_STEPS) result = await functions[step]();
  } catch (error) {
    failure = error;
    failed = true;
  }
  try {
    const cleanup = await functions.cleanup();
    if (cleanup?.complete !== true) throw new Error("fixture cleanup incomplete");
  } catch (error) {
    const cleanupFailure = annotateFixtureFailure(error, { stage: "cleanup", category: "cleanup" });
    failure = failed
      ? new AggregateError([failure, cleanupFailure], "fixture execution and cleanup failed")
      : cleanupFailure;
    markFixtureCleanupFailure(failure);
    failed = true;
  }
  if (failed) throw failure;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("fixture verify did not return a verified result");
  }
  return {
    ...result,
    securityDrill: false,
    selfAttested: true,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
  };
}
import { annotateFixtureFailure, markFixtureCleanupFailure } from "./fixture-diagnostics.mjs";
