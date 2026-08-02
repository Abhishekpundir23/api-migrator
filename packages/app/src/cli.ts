/** Single-repository preview/publish CLI. Preview is always the default. */

import { argv, exit } from "node:process";
import type { Manifest } from "@api-migrator/engine";
import { loadEnv } from "./env.js";
import { migrateRepo } from "./github.js";
import type { PublicationRequest } from "./publication.js";
import { safeErrorMessage } from "./security.js";

loadEnv();

const VALUE_FLAGS = new Set([
  "--base",
  "--branch",
  "--preflight",
  "--approved-by",
  "--override-reason",
]);
const BOOLEAN_FLAGS = new Set(["--publish", "--override-unsafe"]);

function usage(): never {
  console.error(
    [
      "Preview:",
      "  tsx packages/app/src/cli.ts owner/repo [--base main] [--branch name]",
      "",
      "Publish an exact preview:",
      "  tsx packages/app/src/cli.ts owner/repo --publish --preflight pf_... --approved-by operator",
      "",
      "Manual-review acknowledgment (operator-only; verification failures cannot be overridden):",
      "  add --override-unsafe --override-reason \"reviewed and accepted because ...\"",
    ].join("\n")
  );
  exit(1);
}

function parseArgs(args: string[]): { slug: string; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) usage();
      flags.set(arg, value);
    } else if (BOOLEAN_FLAGS.has(arg)) {
      flags.set(arg, true);
    } else if (arg.startsWith("--")) {
      usage();
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) usage();
  return { slug: positional[0]!, flags };
}

const { slug, flags } = parseArgs(argv.slice(2));
const value = (name: string): string | undefined => {
  const found = flags.get(name);
  return typeof found === "string" ? found : undefined;
};

const publication: PublicationRequest = flags.has("--publish")
  ? {
      mode: "publish",
      preflightId: value("--preflight") ?? "",
      approvedBy: value("--approved-by") ?? "",
      overrideUnsafe: flags.has("--override-unsafe"),
      overrideReason: value("--override-reason"),
    }
  : { mode: "preview" };

const manifest: Manifest = {
  name: "Inngest TypeScript SDK v3 -> v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  runtime: { node: { minimumMajor: 20, profile: "node22-bookworm-slim-2026-07", packageJson: "package.json", dockerfile: "Dockerfile" } },
  package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
  peerFloors: [{ name: "typescript", range: "^5.8.0" }],
};

console.log(`${publication.mode === "preview" ? "Previewing" : "Publishing"} ${slug}...\n`);
migrateRepo({
  slug,
  manifest,
  baseBranch: value("--base"),
  branch: value("--branch"),
  publication,
})
  .then(({ report, prUrl, publication: outcome }) => {
    console.log(`Changed files: ${report.changedFiles.length}`);
    console.log(`Applied: ${report.summary.applied}  |  Flagged: ${report.summary.review}`);
    console.log(`Preflight: ${outcome.preflightId}`);
    console.log(`Base: ${outcome.baseBranch}@${outcome.baseSha}`);
    console.log(`Branch: ${outcome.branch}`);
    if (outcome.headSha) console.log(`Approved head: ${outcome.headSha}`);
    console.log(`Artifact: ${outcome.artifactDigest}`);
    if (outcome.blockers.length) {
      console.log("Safety blockers:");
      for (const blocker of outcome.blockers) console.log(`  - ${blocker.message}`);
    }
    if (prUrl) console.log(`\nPR ready: ${prUrl}`);
    else console.log(`\nResult: ${outcome.status}`);
  })
  .catch((error) => {
    console.error(`Migration failed: ${safeErrorMessage(error)}`);
    exit(1);
  });
