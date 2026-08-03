/** Offline owner-envelope signer. This command performs no GitHub operation. */

import { pathToFileURL } from "node:url";
import {
  signOwnerAuthorizationChallengeFile,
  type OwnerAuthorizationSigningReceipt,
} from "./owner-signer.js";
import { canonicalJson } from "./canonical-json.js";

const REQUIRED_FLAGS = [
  "--challenge",
  "--registry",
  "--key",
  "--out",
  "--approve-challenge-digest",
  "--authorization-id",
  "--signer-id",
  "--key-id",
] as const;
const OPTIONAL_FLAGS = ["--ttl-seconds"] as const;

export function runOwnerSignCli(
  args: readonly string[],
  now = Date.now()
): Readonly<OwnerAuthorizationSigningReceipt> {
  const values = parseArgs(args);
  const ttlSeconds = values.get("--ttl-seconds");
  let ttlMs: number | undefined;
  if (ttlSeconds !== undefined) {
    if (!/^[1-9]\d{0,3}$/.test(ttlSeconds)) usage();
    const seconds = Number(ttlSeconds);
    if (!Number.isSafeInteger(seconds) || seconds > 1_800) usage();
    ttlMs = seconds * 1_000;
  }
  return signOwnerAuthorizationChallengeFile({
    challengePath: values.get("--challenge")!,
    registryPath: values.get("--registry")!,
    privateKeyPath: values.get("--key")!,
    outputPath: values.get("--out")!,
    approveChallengeDigest: values.get("--approve-challenge-digest")!,
    authorizationId: values.get("--authorization-id")!,
    signerId: values.get("--signer-id")!,
    keyId: values.get("--key-id")!,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    now,
  });
}

function parseArgs(args: readonly string[]): Map<string, string> {
  const allowed = new Set<string>([...REQUIRED_FLAGS, ...OPTIONAL_FLAGS]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !flag ||
      !allowed.has(flag) ||
      values.has(flag) ||
      !value ||
      value.startsWith("--") ||
      /[\r\n\0]/.test(value)
    ) {
      usage();
    }
    values.set(flag, value);
  }
  if (args.length % 2 !== 0 || REQUIRED_FLAGS.some((flag) => !values.has(flag))) usage();
  return values;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  tsx packages/app/src/owner-sign-cli.ts",
    "    --challenge /absolute/owner-only/challenge.json",
    "    --registry /absolute/owner-only/owner-keys.json",
    "    --key /absolute/owner-only/owner-key.pem",
    "    --authorization-id authorization-id",
    "    --approve-challenge-digest sha256:REVIEWED_CHALLENGE_DIGEST",
    "    --signer-id owner-signer-id",
    "    --key-id owner-key-id",
    "    --out /absolute/new/envelope.json",
    "    [--ttl-seconds 300]",
  ].join("\n"));
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    const receipt = runOwnerSignCli(process.argv.slice(2));
    // This is intentionally a safe receipt. Envelope bytes never reach stdout.
    console.log(canonicalJson(receipt));
  } catch (error) {
    const message = error instanceof Error ? error.message : "owner signing failed";
    console.error(message.slice(0, 1_000));
    process.exitCode = 1;
  }
}
