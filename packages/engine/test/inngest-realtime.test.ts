import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { assessRepository, type ReportEntry } from "../src/index.js";

function assess(t: TestContext, files: Record<string, string>): ReportEntry[] {
  const root = mkdtempSync(join(tmpdir(), "inngest-realtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  const entries: ReportEntry[] = [];
  assessRepository(root, "inngest-v3-to-v4", e => entries.push(e));
  return entries.filter(e => e.code === "F15");
}

const aliases = JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } });
const channel = `import { channel as make, topic } from "@inngest/realtime";
export const updates = make("updates").addTopic(topic("status").type<string>());`;
const client = `import { Inngest as App } from "inngest";
import { realtimeMiddleware as rt } from "@inngest/realtime/middleware";
export const jobs = new App({ id: "jobs", middleware: [rt()] });`;

test("F15 connects legacy realtime imports, handler publishers and local channel payloads", t => {
  const entries = assess(t, {
    "tsconfig.json": aliases, "src/channels.ts": channel, "src/client.ts": client,
    "src/route.ts": 'import { getSubscriptionToken as mint } from "@inngest/realtime"; export const token = mint;',
    "src/ui.tsx": 'import { useInngestSubscription } from "@inngest/realtime/hooks"; export { useInngestSubscription };',
    "src/workflow.ts": `import { jobs as app } from "@/client";
app.createFunction({ id: "example" }, { event: "run" }, async ({ publish: send }) => forward(send));`,
    "src/executor.ts": `import { updates as progress } from "@/channels";
export function run(input: any) {
  const { publish } = input;
  return publish(progress().status("running"));
}`,
    "src/relative.ts": `import { updates } from "./channels";
export const announce = (context: any) => context.publish(updates().status("done"));`,
  });
  assert.ok(entries.every(e => e.kind === "review"));
  for (const [file, line, term] of [
    ["src/channels.ts", 1, /realtime\.channel/], ["src/client.ts", 2, /middleware/i],
    ["src/route.ts", 1, /inngest\/realtime/], ["src/ui.tsx", 1, /subscription|subscriber/i],
    ["src/workflow.ts", 2, /publish/], ["src/executor.ts", 4, /realtime\.publish/],
    ["src/relative.ts", 2, /realtime\.publish/],
  ] as const) {
    assert.ok(entries.some(e => e.file === file && e.line === line && term.test(e.message)), `${file}:${line}`);
  }
  assert.equal(entries.length, 7);
});

test("F15 keeps unrelated publishers, shadowed or remapped channels, and v4 APIs out of findings", t => {
  const entries = assess(t, {
    "tsconfig.json": aliases, "src/channels.ts": channel,
    "src/other.ts": 'export const updates = () => ({ status: (x: string) => x });',
    "src/app.ts": `import { updates } from "./channels";
import { updates as ordinary } from "./other";
import { realtime } from "inngest";
import { getSubscriptionToken } from "inngest/realtime";
function shadow(updates: any, publish: any) { return publish(updates().status("x")); }
function block(publish: any) { { const updates = ordinary; publish(updates().status("x")); } }
function other(publish: any) { return publish(ordinary().status("x")); }
const v4 = realtime.channel({ name: "test", topics: {} });
const unrelated = { createFunction(_config: any, handler: any) { return handler; } };
unrelated.createFunction({}, ({publish}: any) => publish("x"));`,
    "src/nested/tsconfig.json": JSON.stringify({compilerOptions:{paths:{"@/*":["../other/*"]}}}),
    "src/nested/worker.ts": 'import { updates } from "@/channels"; export const run = (publish: any) => publish(updates().status("x"));',
  });
  assert.deepEqual(entries.map(e => e.file), ["src/channels.ts"]);
});

test("F15 reports a publisher using a channel defined in the same module", t => {
  const entries = assess(t, { "local.ts": `${channel}\nexport function tell(publish: any) { publish(updates().status("ready")); }` });
  assert.ok(entries.some(e => e.line === 3 && e.message.includes("realtime.publish")));
});

test("F15 inventories literal legacy module loaders and ignores a shadowed require", t => {
  const entries = assess(t, {
    "legacy.cjs": 'const { getSubscriptionToken } = require("@inngest/realtime");',
    "legacy.ts": 'const subscription = import("@inngest/realtime/hooks");',
    "other.cjs": 'function fromRegistry(require) { return require("@inngest/realtime"); }',
    "v4.ts": 'const subscription = import("inngest/realtime");',
  });
  assert.deepEqual(entries.map(e => e.file).sort(), ["legacy.cjs", "legacy.ts"]);
});

test("F15 locates native EventSource subscribers on the exact Inngest token URL", t => {
  const entries = assess(t, {
    "browser.ts": [
      'new EventSource(`https://inn.gs/e/${token}`);',
      'new window.EventSource("https://inn.gs/e/" + token);',
      'new EventSource("https://inn.gs/e/example.token");',
      'new EventSource(`https://inn.gs.example/e/${token}`);',
      'new EventSource(`https://example.test/?url=https://inn.gs/e/${token}`);',
      'new EventSource(`https://inn.gs/other/${token}`);',
      'new EventSource(`https://${host}/e/${token}`);',
      'new EventSource(`https://inn.gs/e/${token}/elsewhere`);',
      'new EventSource("https://inn.gs/e/");',
      'function open(EventSource: any) { return new EventSource(`https://inn.gs/e/${token}`); }',
      '{ const EventSource = FakeStream; new EventSource(`https://inn.gs/e/${token}`); }',
      'function other(window: any) { return new window.EventSource(`https://inn.gs/e/${token}`); }',
      'fetch(`/api/realtime-token/${channel}`);',
    ].join("\n"),
  });
  assert.deepEqual(entries.map(e => e.line), [1, 2, 3]);
  for (const entry of entries) assert.match(entry.message, /subscription|subscribe/i);
});
