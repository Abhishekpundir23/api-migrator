import assert from "node:assert/strict";
import { linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { assessRepository, findSourceFiles, type ReportEntry } from "../src/index.js";

function fixture(t: TestContext, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "sdk-assessment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
  return root;
}

test("static assessment recognizes one-hop clients and keeps locations in the owner's report", (t) => {
  const files = {
    "private-client.ts": 'import { Inngest } from "inngest"; export const app = new Inngest({ id: "private-service" });',
    "private-worker.ts": `import { app } from "./private-client";
export const fn = app.createFunction({ id: "private-worker" }, { event: "private/event" }, async () => 1);`,
    "mutator.ts": 'import * as state from "./private-client"; Object.assign(state.app, { createFunction: substitute });',
    // Importing this module or executing its package scripts would fail.
    "unrelated.js": 'throw new Error("target executed");',
    "package.json": '{"scripts":{"preinstall":"exit 1","test":"exit 1"}}',
  };
  const root = fixture(t, files);
  const local: ReportEntry[] = [];
  const result = assessRepository(root, "inngest-v3-to-v4", (entry) => local.push(entry));
  assert.equal(result.sourceFiles, 4);
  assert.equal(result.matchedFiles, 3);
  assert.equal(result.wouldChangeFiles, 1);
  assert.deepEqual(result.findings.filter(f => f.code === "T5"), [{ code: "T5", kind: "review", count: 1 }]);
  assert.ok(result.findings.some((f) => f.code === "T1" && f.kind === "applied" && f.count === 1));
  assert.ok(result.findings.some((f) => f.code === "T1" && f.kind === "review"));
  assert.ok(result.findings.some((f) => f.code === "F12" && f.kind === "review"));
  assert.ok(local.some((e) => e.file === "private-worker.ts" && e.code === "T1" && e.line === 2));
  assert.doesNotMatch(JSON.stringify(result), /private-|private\/event|mutator|unrelated|package\.json/);
  assert.deepEqual(readdirSync(root).sort(), Object.keys(files).sort());
  for (const [name, source] of Object.entries(files)) assert.equal(readFileSync(join(root, name), "utf8"), source);
});

test("Knock assessment counts repeated proposals by rule and kind", (t) => {
  const source = `import Knock from "@knocklabs/node";
const knock = new Knock({ apiKey: "demo" });
knock.notify("first", { recipients: ["a"] });
knock.notify("second", { recipients: ["b"] });`;
  const root = fixture(t, { "service.ts": source });
  const result = assessRepository(root, "knock-v0-to-v1");
  assert.equal(result.wouldChangeFiles, 1);
  assert.deepEqual(result.findings.find((f) => f.code === "K1" && f.kind === "applied"), {
    code: "K1", kind: "applied", count: 2,
  });
});

test("assessing unrelated sources yields an empty recipe inventory", (t) => {
  const root = fixture(t, { "other.ts": "export const unrelated = 1;" });
  assert.deepEqual(assessRepository(root, "inngest-v3-to-v4"), {
    version: 1, recipe: "inngest-v3-to-v4", sourceFiles: 1, matchedFiles: 0, wouldChangeFiles: 0, findings: [],
  });
});

test("Knock schedule reviews distinguish legacy workflows and user calls from their v1 replacements", (t) => {
  const cases: Array<[string, string]> = [
    ['workflows.createSchedules("welcome", request)', "schedules.create"],
    ['workflows.listSchedules("welcome")', "schedules.list"],
    ["workflows.updateSchedules(request)", "schedules.update"],
    ["workflows.deleteSchedules(request)", "schedules.delete"],
    ['users.getSchedules("user-1")', "users.listSchedules"],
  ];
  const calls = [
    ...cases.map(([call]) => `await client.${call};`),
    'await client.users.listSchedules("user-1");',
    'await client.schedules.list({ workflow: "welcome" });',
    'await client.schedules.create(request);',
    'await client.schedules.update(request);',
    'await client.schedules.delete(request);',
    'await calendar.workflows.listSchedules("elsewhere");',
  ];
  const source = ['import Knock from "@knocklabs/node";', 'const client = new Knock({ apiKey: "demo" });', ...calls].join("\n");
  const root = fixture(t, { "schedules.ts": source });
  const local: ReportEntry[] = [];
  const result = assessRepository(root, "knock-v0-to-v1", entry => local.push(entry));
  assert.deepEqual(result.findings, [{ code: "KF4", kind: "review", count: 5 }]);
  assert.equal(result.wouldChangeFiles, 0);
  for (const [index, [call, replacement]] of cases.entries()) {
    const finding = local.find(entry => entry.line === index + 3);
    assert.ok(finding?.message.includes(call.split("(")[0]));
    assert.ok(finding.message.includes(replacement));
  }
});

test("a parse failure in an unmatched file aborts before any local findings are exported", (t) => {
  const root = fixture(t, {
    "a.ts": 'import Knock from "@knocklabs/node"; const knock = new Knock({ apiKey: "x" });',
    "z.ts": "const x = ;",
  });
  const local: ReportEntry[] = [];
  assert.throws(() => assessRepository(root, "knock-v0-to-v1", (entry) => local.push(entry)), /Unable to assess z\.ts:/);
  assert.deepEqual(local, []);
});

test("catch without a parameter preserves client resolution across both recipes", (t) => {
  const root = fixture(t, {
    "handlers.ts": `import Knock from "@knocklabs/node";
import { Inngest } from "inngest";
const client = new Knock({ apiKey: "test" });
const app = new Inngest({ id: "demo" });
try {} catch {
  client.notify("outer", { recipients: [] });
  app.createFunction({ id: "outer" }, { event: "event" }, async () => 1);
}
function local(fallback: any) {
  try {} catch { var client = fallback; }
  client.notify("shadow", { recipients: [] });
}
try {} catch (app) {
  try {} catch { app.createFunction({ id: "shadow" }, { event: "event" }, async () => 1); }
}`,
  });
  for (const [recipe, code] of [["knock-v0-to-v1", "K1"], ["inngest-v3-to-v4", "T1"]] as const) {
    const result = assessRepository(root, recipe);
    assert.equal(result.wouldChangeFiles, 1);
    assert.deepEqual(result.findings.find(f => f.code === code && f.kind === "applied"),
      { code, kind: "applied", count: 1 });
  }
});

test("ambient TypeScript declarations parse alongside application files", (t) => {
  const root = fixture(t, {
    "types.d.ts": "export const current: string;",
    "index.d.mts": "export const sdkVersion: number;",
    "common.d.cts": "export const setting: boolean;",
    "normal.ts": 'import Knock from "@knocklabs/node"; const k = new Knock({ apiKey: "demo" }); k.notify("welcome", { recipients: ["a"] });',
  });
  const result = assessRepository(root, "knock-v0-to-v1");
  assert.equal(result.sourceFiles, 4);
  assert.equal(result.wouldChangeFiles, 1);
  assert.equal(result.matchedFiles, 1);
});

test("an oversized source or inventory fails without partial results", (t) => {
  const root = fixture(t, { "bundle.js": "" });
  const bundle = join(root, "bundle.js");
  const mib = 1024 * 1024;
  truncateSync(bundle, mib + 1);
  assert.throws(() => assessRepository(root, "inngest-v3-to-v4"), /exceeds 1048576 bytes/);
  truncateSync(bundle, mib);
  for (let i = 0; i < 32; i++) linkSync(bundle, join(root, `bundle-${i}.js`));
  assert.throws(() => assessRepository(root, "inngest-v3-to-v4"), /exceeds 32 MiB/);
  assert.throws(() => findSourceFiles(root, { maxFiles: 3 }), /exceeds 3 files/);
});
