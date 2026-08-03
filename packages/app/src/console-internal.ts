/**
 * Trusted integration surface for the local operator console.
 *
 * This explicit subpath keeps write-capable campaign execution out of the
 * package root and prevents accidental use by preview-only callers. It is not a
 * substitute for the console's preview receipt, owner envelope, one-use
 * operator token, typed confirmation, and run lock; callers must complete that
 * ceremony before passing a publish request here.
 */
export {
  runCampaign,
  type RunCampaignInput,
  type CampaignRunSummary,
} from "./campaign/runner.js";
