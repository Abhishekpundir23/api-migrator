import { readInputFile } from "./input-file.mjs";
import { readAccessToken } from "./inventory.mjs";
import { collectTrialLogs } from "./logs.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== "--read-only" || args[1] !== "--token-stdin"
    || !args[2].startsWith("--expected-account=") || args[3] !== "--input") {
    process.stderr.write("Usage: collect-logs.mjs --read-only --token-stdin --expected-account=EMAIL --input PLAN_AND_OWNERSHIP.json\n");
    process.exitCode = 2;
  } else {
    const document = readInputFile(args.slice(3));
    if (!document || typeof document !== "object" || Array.isArray(document)
      || Object.keys(document).length !== 2 || !Object.hasOwn(document, "plan") || !Object.hasOwn(document, "ownership")) throw new Error();
    const token = await readAccessToken(process.stdin);
    const observation = await collectTrialLogs(JSON.stringify(document.plan), JSON.stringify(document.ownership), token,
      { expectedAccount: args[2].slice("--expected-account=".length) });
    process.stdout.write(JSON.stringify(observation) + "\n");
  }
} catch {
  process.stderr.write("GCP log observation failed; no cloud mutation was requested.\n");
  process.exitCode = 2;
}
