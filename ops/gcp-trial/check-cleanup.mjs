import { readInputFile } from "./input-file.mjs";
import { readAccessToken } from "./inventory.mjs";
import { observeTrialCleanup } from "./observe-cleanup.mjs";

try {
  const args = process.argv.slice(2), reasons = ["deadline", "completed", "failed", "cancelled", "controller_failure"];
  if (args.length !== 6 || args[0] !== "--read-only" || args[1] !== "--token-stdin"
    || !args[2].startsWith("--expected-account=") || !args[3].startsWith("--reason=")
    || !reasons.includes(args[3].slice("--reason=".length)) || args[4] !== "--input") {
    process.stderr.write("Usage: check-cleanup.mjs --read-only --token-stdin --expected-account=EMAIL --reason=deadline|completed|failed|cancelled|controller_failure --input PLAN_AND_OWNERSHIP.json\n");
    process.exitCode = 2;
  } else {
    const document = readInputFile(args.slice(4));
    if (!document || typeof document !== "object" || Array.isArray(document)
      || Object.keys(document).length !== 2 || !Object.hasOwn(document, "plan") || !Object.hasOwn(document, "ownership")) throw new Error();
    const token = await readAccessToken(process.stdin);
    const observation = await observeTrialCleanup(JSON.stringify(document.plan), JSON.stringify(document.ownership), token,
      { expectedAccount: args[2].slice("--expected-account=".length), reason: args[3].slice("--reason=".length) });
    const exitCode = { absence_observed: 0, waiting: 3, blocked: 4 }[observation?.status];
    if (!Number.isInteger(exitCode)) throw new Error();
    process.stdout.write(JSON.stringify(observation) + "\n");
    process.exitCode = exitCode;
  }
} catch {
  process.stderr.write("GCP cleanup observation failed; no cloud mutation was requested.\n");
  process.exitCode = 2;
}
