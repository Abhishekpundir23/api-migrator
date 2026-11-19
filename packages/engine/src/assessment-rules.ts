import { TRANSFORM_ALLOWLIST } from "./manifest.js";

/** Environment and authoring checks belong to the owner report, outside campaign transforms. */
export const ASSESSMENT_RULES = {
  ...TRANSFORM_ALLOWLIST,
  "inngest-v3-to-v4": [...TRANSFORM_ALLOWLIST["inngest-v3-to-v4"], "F16", "F17", "F18"],
};
