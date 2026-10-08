import { readInputFile } from "./input-file.mjs";
import { readAccessToken } from "./inventory.mjs";
import { collectTrialOwnership } from "./ownership.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== "--read-only" || args[1] !== "--token-stdin"
    || !args[2].startsWith("--expected-account=") || args[3] !== "--input") {
    process.stderr.write("Usage: capture-ownership.mjs --read-only --token-stdin --expected-account=EMAIL --input PLAN_AND_OPERATION.json\n");
    process.exitCode = 2;
  } else {
    const input = readInputFile(args.slice(3));
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2
      || !Object.hasOwn(input, "plan") || !Object.hasOwn(input, "operationName")) throw new Error();
    const token = await readAccessToken(process.stdin);
    const observation = await collectTrialOwnership(JSON.stringify(input), token,
      { expectedAccount: args[2].slice("--expected-account=".length) });
    process.stdout.write(JSON.stringify(observation) + "\n");
  }
} catch {
  process.stderr.write("GCP ownership observation failed; no cloud mutation was requested.\n");
  process.exitCode = 2;
}
