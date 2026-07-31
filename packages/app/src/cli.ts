/**
 * CLI for the app package — drive a single-repo migration end-to-end.
 *
 *   tsx packages/app/src/cli.ts <owner/repo> [--base main] [--branch name]
 *
 * Phase 2 gate: opens a real migration PR in <owner/repo> using `gh` for auth.
 */

import { argv, exit } from "node:process";
import { migrateRepo } from "./github.js";
import { Manifest } from "@api-migrator/engine";

function usage(): never {
  console.error("Usage: tsx packages/app/src/cli.ts <owner/repo> [--base main] [--branch api-migrator/inngest-v4]");
  exit(1);
}

const args = argv.slice(2);
const positional = args.filter((a: string) => !a.startsWith("--"));
if (positional.length !== 1) usage();
const slug = positional[0]!;

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const base = flag("--base") ?? "main";
const branch = flag("--branch") ?? "api-migrator/inngest-v4";

const manifest: Manifest = {
  name: "Inngest TypeScript SDK v3 -> v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
  peerFloors: [{ name: "typescript", range: ">=5.8.0" }],
};

const cloneUrl = `https://github.com/${slug}.git`;

console.log(`Migrating ${slug} (${base} -> ${branch})...\n`);
migrateRepo({ cloneUrl, slug, baseBranch: base, manifest, branch })
  .then(({ report, prUrl, changed }) => {
    console.log(`Changed files: ${report.changedFiles.length}`);
    console.log(`Applied: ${report.summary.applied}  |  Flagged: ${report.summary.review}`);
    if (prUrl) {
      console.log(`\n✅ PR opened: ${prUrl}`);
    } else if (changed) {
      console.log("\nChanges made but no PR opened.");
    } else {
      console.log("\nNo changes needed — nothing to migrate.");
    }
  })
  .catch((e) => {
    console.error("Migration failed:", e);
    exit(1);
  });
