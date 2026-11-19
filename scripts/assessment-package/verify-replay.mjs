// Run the extracted owner CLI on two local snapshots and check stable migration signals.
// Pinned revisions, source scopes and the one-line Kira control edit are in docs/service/public-replays.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

function assertMako(before, after, blind) {
  const edits = before.details.filter(f => f.kind === "applied" && f.code === "T1");
  assert.equal(before.summary.sourceFiles, 1172);
  assert.equal(after.summary.sourceFiles, blind ? 1173 : 1172);
  assert.equal(edits.length, 29);
  assert.equal(new Set(edits.map(f => f.file + "#" + f.line)).size, 29);
  assert.ok(edits.every(f => f.file.startsWith("api/src/inngest/functions/")));
  assert.equal(new Set(edits.map(f => f.file)).size, 13);
  for (const report of [before, after]) {
    assert.ok(!report.details.some(f => f.code === "T1" && f.kind === "review"));
    assert.deepEqual(report.details.filter(f => f.code === "F17").map(f => f.file + "#" + f.line).sort(), [
      ".cursor/rules/45-inngest.mdc#24", ".cursor/skills/add-inngest-function/SKILL.md#34", "docs/connector-builder-prd.md#314",
    ]);
  }
  for (const [report, expected] of [[before, [676]], [after, blind ? [] : [676]]]) {
    assert.deepEqual(report.details.filter(f => f.code === "F16" && f.file === ".github/workflows/deploy-app.yml").map(f => f.line), expected);
  }
  assert.equal(after.summary.wouldChangeFiles, 0);
}

const checks = {
  knock(before, after) {
    assert.equal(before.summary.sourceFiles, 294);
    assert.equal(after.summary.sourceFiles, 294);
    const touchedFiles = [
      "examples/nextjs-example/pages/api/auth.ts",
      "examples/nextjs-example/pages/api/identify.ts",
      "examples/nextjs-example/pages/api/notify.ts",
      "examples/slack-kit-example/app/actions/fetch-user-id.ts",
      "examples/slack-kit-example/app/examine-channel-data/page.tsx",
      "examples/slack-kit-example/app/layout.tsx",
      "examples/slack-kit-example/app/lib/knock.ts",
    ];
    assert.deepEqual([...new Set(before.details.map(f => f.file))].sort(), touchedFiles);
    assert.equal(before.details.filter(f => f.kind === "applied").length, 16);
    assert.equal(before.details.filter(f => f.kind === "review").length, 3);
    assert.equal(before.summary.wouldChangeFiles, 6);
    assert.equal(after.summary.wouldChangeFiles, 0);
    assert.deepEqual(after.details, []);
  },
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
  mako(before, after) { assertMako(before, after, false); },
  "mako-pilot"(before, after) { assertMako(before, after, true); },
  colophony(before, after) {
    assert.equal(before.summary.sourceFiles, 981);
    assert.equal(after.summary.sourceFiles, 981);
    const functions = "apps/api/src/inngest/functions/";
    const registrations = before.details.filter(f => f.file.startsWith(functions) && f.code === "T1");
    assert.equal(new Set(registrations.map(f => f.file + "#" + f.line)).size, 15);
    assert.equal(new Set(registrations.map(f => f.file)).size, 10);
    assert.ok(registrations.every(f => f.kind === "applied"));
    assert.ok(!after.details.some(f => f.code === "T1"));
    const mockSites = before.details.filter(f => f.code === "F18" && f.kind === "review").map(f => f.file + "#" + f.line).sort();
    assert.deepEqual(mockSites, [
      "__tests__/embed-submission-confirmation.spec.ts#48", "__tests__/submission-notifications.spec.ts#71",
      "__tests__/submission-response-reminder.spec.ts#63", "__tests__/webhook-delivery.spec.ts#42",
      "cms-publish.spec.ts#59", "contract-workflow.spec.ts#49",
    ].map(site => functions + site));
    assert.ok(!after.details.some(f => f.code === "F18"));
    const declarationReviews = before.details.filter(f => f.code === "F19");
    assert.equal(declarationReviews.length, 1);
    assert.deepEqual([declarationReviews[0].file, declarationReviews[0].line, declarationReviews[0].kind],
      [functions + "cms-publish.ts", 22, "review"]);
    assert.ok(!after.details.some(f => f.code === "F19"));
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
    const unresolvedRegistrations = before.details.filter(f => f.code === "T1" && f.kind === "review");
    assert.deepEqual(unresolvedRegistrations.map(f => [f.file, f.line]), [["src/inngest/__test__/testCodeNodeWorkflow.ts", 4]]);
    assert.equal(before.details.filter(f => f.code === "T1" && f.kind === "applied").length, 7);
    assert.ok(before.details.some(f => f.file === "src/inngest/client.ts" && f.code === "F3" && f.line === 7));
    const realtime = before.details.filter(f => f.code === "F15");
    assert.equal(realtime.length, 40);
    assert.ok(realtime.every(f => f.kind === "review"));
    assert.equal(new Set(realtime.filter(f => f.file.startsWith("src/inngest/channels/")).map(f => f.file)).size, 26);
    const expected = {
      "src/features/executions/components/code/executor.ts": [34, 55, 98, 99, 117, 126],
      "src/features/editor/components/memory/executor.ts": [18, 29, 44, 59],
      "src/features/executions/hooks/use-execution-subscription.ts": [21],
      "src/app/api/realtime-token/[channel]/route.ts": [2],
      "src/inngest/client.ts": [2],
      "src/inngest/__test__/testCodeNodeWorkflow.ts": [7],
    };
    for (const [file, lines] of Object.entries(expected)) {
      assert.deepEqual(realtime.filter(f => f.file === file).map(f => f.line).sort((a, b) => a - b), lines);
    }
  },
};

const [name, cliArg, beforeArg, afterArg, outputArg, ...extra] = process.argv.slice(2);
if (!Object.hasOwn(checks, name) || !cliArg || !beforeArg || !afterArg || !outputArg || extra.length) {
  console.error("Usage: node verify-replay.mjs <colophony|kira|knock|mako|mako-pilot|plinth|rxj> <extracted-cli> <before-tree> <after-tree> <new-report-dir>");
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
const recipe = name === "knock" ? "knock-v0-to-v1" : "inngest-v3-to-v4";
const reports = trees.map((repo, index) => {
  const label = index === 0 ? "before" : "after";
  const details = join(output, label + "-findings.json");
  execFileSync(process.execPath, [cli, "assess", "--recipe", recipe, "--repo", repo,
    "--out", join(output, label + "-summary.json"), "--local-report", details], { stdio: "inherit" });
  return JSON.parse(readFileSync(details, "utf8"));
});
checks[name](...reports);
console.log(`Verified ${name} replay. Reports in ${output}`);
