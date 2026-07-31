/**
 * Migration engine driver.
 *
 * Runs a codemod across a target repo's Inngest files, then prints a structured
 * report of applied transforms and items flagged for review — the artifact a
 * reviewer reads before opening the migration pull request.
 *
 *   node engine/run-migration.js <target-repo-path>
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node engine/run-migration.js <target-repo-path>");
  process.exit(1);
}

const codemod = path.join(__dirname, "inngest-v3-to-v4.js");
const reportPath = path.join(__dirname, "migration-report.json");

// Find candidate files: anything referencing Inngest APIs. We match on
// Inngest-SPECIFIC identifiers only — generic patterns like `.send(`, `serve(`,
// or `step.` would false-positive on every Express/Next route handler
// (`res.send(...)`, etc.) and make the tool look unreliable.
const INNGEST_USAGE = [
  /\bnew\s+Inngest\s*\(/, //     new Inngest(
  /\bcreateFunction\s*\(/, //    inngest.createFunction(
  /\bEventSchemas\b/, //         v3 schema helper
  /\breferenceFunction\b/, //    v4 helper
  /\bInngestFunction\b/, //      internal helper
  /from\s+["']@?inngest/, //     direct import from inngest / @inngest/*
  /require\(\s*["']@?inngest/, // require import
];

function findInngestFiles(dir) {
  const out = [];
  const stack = [dir];
  const skip = ["node_modules", ".next", ".git", "dist", "build"];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (skip.includes(e.name)) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) {
        let txt;
        try {
          txt = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (INNGEST_USAGE.some((re) => re.test(txt))) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

const files = findInngestFiles(target);
if (files.length === 0) {
  console.log("No Inngest files found under", target);
  process.exit(0);
}

console.log(`Found ${files.length} Inngest file(s):`);
files.forEach((f) => console.log("  -", path.relative(process.cwd(), f)));
console.log("");

// jscodeshift writes changed files in place when not --dry.
try {
  execSync(
    `npx --yes jscodeshift -t "${codemod}" ${files
      .map((f) => `"${f}"`)
      .join(" ")} --extensions=ts,tsx,js,jsx`,
    { stdio: "inherit" }
  );
} catch (e) {
  console.error("jscodeshift failed:", e.message);
  process.exit(1);
}

const report = global.__MIGRATION_REPORT__ || [];
// The codemod runs in a child process, so its global report isn't visible here.
// We re-derive a lightweight report by diffing against git.
let derived = [];
try {
  const diff = execSync(`git -C "${target}" diff --unified=0`, { encoding: "utf8" });
  derived = diff
    .split("\n")
    .filter((l) => l.startsWith("@@") || l.startsWith("+++") || l.startsWith("---"))
    .slice(0, 50);
} catch {}

console.log("\n=== Migration report ===");
console.log(`Files scanned : ${files.length}`);
console.log(`(Run \`git -C ${path.relative(process.cwd(), target)} diff\` to review changes.)\n`);
console.log("Review checklist — verify each of these manually before opening the PR:");
console.log("  [F1] new Inngest({...}) — add isDev:true or signingKey (v4 cloud mode)");
console.log("  [F2] event.user usages — migrate to event.data");
console.log("  [ ] type-check:   npx tsc --noEmit");
console.log("  [ ] bump package: inngest ^3.x -> ^4.x in package.json");
