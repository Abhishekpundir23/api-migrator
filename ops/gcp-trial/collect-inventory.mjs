import { collectTrialInventory, readAccessToken } from "./inventory.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== "--read-only" || args[1] !== "--token-stdin"
    || !args[2].startsWith("--expected-account=")) {
    process.stderr.write("Usage: collect-inventory.mjs --read-only --token-stdin --expected-account=EMAIL\n");
    process.exitCode = 2;
  } else {
    const token = await readAccessToken(process.stdin);
    process.stdout.write(JSON.stringify(await collectTrialInventory(token, { expectedAccount: args[2].slice("--expected-account=".length) })) + "\n");
  }
} catch {
  process.stderr.write("GCP inventory observation failed; no cloud mutation was requested.\n");
  process.exitCode = 2;
}
