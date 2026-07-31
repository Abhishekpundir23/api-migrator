/**
 * CLI entry point.
 *
 *   tsx packages/engine/src/cli.ts <target-repo-path> [--write] [--check]
 *
 *   --write    apply transforms to files in place (default: dry-run, print only)
 *   --check    exit non-zero if any file would change (for CI)
 *
 * Phase 0 scope: scan a repo, run the Inngest v3→v4 transform, and report
 * what changed — reproducing the prototype's behavior but via a programmatic,
 * in-process engine (no npx, no child process, no broken report).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit } from "node:process";
import { applyInngestV3ToV4, findInngestFiles } from "./index.js";
import type { ReportEntry } from "./types.js";

function usage(): never {
  console.error("Usage: tsx packages/engine/src/cli.ts <repo-path> [--write] [--check]");
  exit(1);
}

const args = argv.slice(2);
const positional = args.filter((a: string) => !a.startsWith("--"));
const flags = new Set(args.filter((a: string) => a.startsWith("--")));
if (positional.length !== 1) usage();

const target = positional[0]!;
const write = flags.has("--write");
const check = flags.has("--check");

const files = findInngestFiles(target);
if (files.length === 0) {
  console.log(`No Inngest files found under ${target}`);
  exit(0);
}

console.log(`Found ${files.length} Inngest file(s):\n`);
for (const f of files) console.log(`  - ${f.relative}`);
console.log("");

const report: ReportEntry[] = [];
const sink = { push: (e: ReportEntry) => report.push(e) };

let changedFiles = 0;
for (const f of files) {
  const original = readFileSync(f.absolute, "utf8");
  const next = applyInngestV3ToV4(original, f.relative, sink);
  if (next != null && next !== original) {
    changedFiles++;
    if (write) writeFileSync(f.absolute, next);
  }
}

console.log(`Files changed : ${changedFiles} ${write ? "(written)" : "(dry-run — pass --write to apply)"}`);
console.log("");

const applied = report.filter((r) => r.kind === "applied");
const review = report.filter((r) => r.kind === "review");
console.log(`=== Applied (${applied.length}) ===`);
for (const r of applied)
  console.log(`  [${r.code}] ${f(r.file)}${r.line ? `:${r.line}` : ""} — ${r.message}`);
console.log(`\n=== Flagged for review (${review.length}) ===`);
for (const r of review)
  console.log(`  [${r.code}] ${f(r.file)}${r.line ? `:${r.line}` : ""} — ${r.message}`);

if (changedFiles > 0 && check) {
  console.log("\n--check: changes detected, exiting non-zero.");
  exit(1);
}

function f(s: string): string {
  return s.replace(/^.*?\//, "");
}
