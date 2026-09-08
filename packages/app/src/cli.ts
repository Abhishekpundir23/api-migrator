/** Single-repository preview/publish CLI. Preview is always the default. */

import { argv, exit } from "node:process";
import type { Manifest } from "@api-migrator/engine";
import { loadEnv } from "./env.js";
import { migrateRepo } from "./github.js";
import { safeErrorMessage } from "./security.js";
import { parsePreviewArgs, type PreviewArgs } from "./cli-args.js";

loadEnv();

function usage(): never {
  console.error(
    [
      "Preview:",
      "  tsx packages/app/src/cli.ts owner/repo [--base main] [--branch name] [--deployment-kind long-running|serverless]",
      "  Deployment is operator-declared. Omission remains unknown and F12-blocked.",
      "",
      "Direct CLI publication is intentionally disabled. Use the local operator console",
      "so the signed owner authorization and durable one-use receipt are enforced.",
    ].join("\n")
  );
  exit(1);
}

let args: PreviewArgs;
try {
  args = parsePreviewArgs(argv.slice(2));
} catch (error) {
  console.error(safeErrorMessage(error));
  usage();
}
const { slug } = args;

const manifest: Manifest = {
  name: "Inngest TypeScript SDK v3 -> v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  ...(args.deploymentKind ? { deployment: { kind: args.deploymentKind } } : {}),
  runtime: { node: { minimumMajor: 20, profile: "node22-bookworm-slim-2026-07", packageJson: "package.json", dockerfile: "Dockerfile" } },
  package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
  peerFloors: [{ name: "typescript", range: "^5.8.0" }],
};

console.log(`Previewing ${slug}...\n`);
migrateRepo({
  slug,
  manifest,
  baseBranch: args.baseBranch,
  branch: args.branch,
  publication: { mode: "preview" },
})
  .then(({ report, prUrl, publication: outcome }) => {
    console.log(`Changed files: ${report.changedFiles.length}`);
    console.log(`Operator-declared deployment: ${report.manifest.deployment?.kind ?? "unknown"} (not independently verified)`);
    console.log(`Applied: ${report.summary.applied}  |  Flagged: ${report.summary.review}`);
    console.log(`Preflight: ${outcome.preflightId}`);
    console.log(`Base: ${outcome.baseBranch}@${outcome.baseSha}`);
    console.log(`Branch: ${outcome.branch}`);
    console.log(`Candidate tree: ${outcome.candidateTreeSha}`);
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
