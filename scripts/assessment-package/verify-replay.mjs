// Run the extracted owner CLI on two local snapshots and check stable migration signals.
// Pinned revisions, source scopes and the one-line Kira control edit are in docs/service/public-replays.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const checks = {
  kira(before, after) {
    const workflow = "api/_lib/studio-workflow.js";
    assert.deepEqual(before.details.filter(f => f.file === workflow && f.code === "T1").map(f => f.line), [65]);
    assert.ok(!after.details.some(f => f.file === workflow && f.code === "T1"), "Repaired trigger still flagged");
    for (const report of [before, after]) {
      assert.equal(report.summary.sourceFiles, 337);
      assert.equal(report.summary.wouldChangeFiles, 0, "Client mode must remain application-owned");
      assert.ok(report.details.some(f => f.file === "api/_lib/inngest-client.js" && f.kind === "review"));
    }
  },
  mako(before, after) {
    const edits = before.details.filter(f => f.kind === "applied" && f.code === "T1");
    assert.equal(before.summary.sourceFiles, 1172);
    assert.equal(after.summary.sourceFiles, 1172);
    assert.equal(edits.length, 29);
    assert.equal(new Set(edits.map(f => f.file + "#" + f.line)).size, 29);
    assert.ok(edits.every(f => f.file.startsWith("api/src/inngest/functions/")));
    assert.equal(new Set(edits.map(f => f.file)).size, 13);
    assert.equal(after.summary.wouldChangeFiles, 0);
  },
  plinth(before, after) {
    assert.equal(before.summary.sourceFiles, 301);
    assert.equal(after.summary.sourceFiles, 301);
    const edits = before.details.filter(f => f.code === "T1" && f.kind === "applied");
    assert.equal(edits.length, 7);
    assert.equal(new Set(edits.map(f => f.file)).size, 7);
    assert.ok(edits.every(f => f.file.startsWith("apps/api/src/inngest/functions/")));
    assert.ok(before.details.some(f => f.code === "F4" && f.file === "apps/api/src/inngest/client.ts"));
    assert.ok(!after.details.some(f => f.code === "F4"));
    assert.equal(after.summary.wouldChangeFiles, 0);
  },
  rxj(before, after) {
    // This dependency-only PR preserves every source line. Its TypeScript job identified these calls.
    assert.deepEqual(after, before);
    assert.equal(before.summary.sourceFiles, 616);
    const calls = {
      "__test__/testCodeNodeWorkflow.ts": [4],
      "evaluations.ts": [25],
      "execution-cleanup.ts": [116],
      "files-cleanup.ts": [7],
      "functions.ts": [123, 886],
      "gmail-trigger.ts": [200],
      "rss-trigger.ts": [106],
    };
    for (const [name, lines] of Object.entries(calls)) {
      for (const line of lines) {
        assert.ok(before.details.some(f => f.code === "T1" && f.file === "src/inngest/" + name && f.line === line),
          `Missed ${name}:${line}`);
      }
    }
    assert.ok(before.details.some(f => f.file === "src/inngest/client.ts" && f.code === "F3" && f.line === 7));
  },
};

const [name, cliArg, beforeArg, afterArg, outputArg, ...extra] = process.argv.slice(2);
if (!Object.hasOwn(checks, name) || !cliArg || !beforeArg || !afterArg || !outputArg || extra.length) {
  console.error("Usage: node verify-replay.mjs <kira|mako|plinth|rxj> <extracted-cli> <before-tree> <after-tree> <new-report-dir>");
  process.exit(2);
}
const cli = realpathSync(cliArg);
const trees = [realpathSync(beforeArg), realpathSync(afterArg)];
const output = join(realpathSync(dirname(resolve(outputArg))), basename(resolve(outputArg)));
for (const tree of trees) {
  const pathFromTree = relative(tree, output);
  assert.ok(pathFromTree === ".." || pathFromTree.startsWith(".." + sep), "Choose a report directory outside both source trees");
}
mkdirSync(output, { mode: 0o700 });
const reports = trees.map((repo, index) => {
  const label = index === 0 ? "before" : "after";
  const details = join(output, label + "-findings.json");
  execFileSync(process.execPath, [cli, "assess", "--recipe", "inngest-v3-to-v4", "--repo", repo,
    "--out", join(output, label + "-summary.json"), "--local-report", details], { stdio: "inherit" });
  return JSON.parse(readFileSync(details, "utf8"));
});
checks[name](...reports);
console.log(`Verified ${name} replay. Reports in ${output}`);
