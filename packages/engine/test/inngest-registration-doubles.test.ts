import test from "node:test";
import assert from "node:assert/strict";
import { applyInngestV3ToV4 } from "../src/transforms/inngest-v3-to-v4.js";
import type { ReportEntry } from "../src/types.js";

const client = `import { Inngest } from "inngest"; export const jobs = new Inngest({id:"x"});`;
const mock = `import { vi as v } from "vitest";
v.mock("../client.js", () => ({
  jobs: { createFunction: v.fn((options, trigger, handler) => handler) }
}));`;

function check(source: string, target = client, file = "src/functions/task.spec.ts", path = "src/client.ts") {
  const scannedSources = new Map([[path, target]]);
  const entries: ReportEntry[] = [];
  const result = applyInngestV3ToV4(source, file, { push: entry => entries.push(entry) }, new Set(["F18"]), {
    scannedSources, sourcePaths: new Set(scannedSources.keys()), ownerAssessment: true,
  });
  assert.equal(result, null);
  return entries.filter(e => e.code === "F18");
}

test("reports three-argument registration doubles on a real configured SDK export", () => {
  for (const expr of [
    "v.fn((options, trigger, handler) => handler)",
    "(options, trigger, handler) => ({options, trigger, handler})",
    "function(options, triggers, handler) { return handler; }",
  ]) {
    const entries = check(mock.replace("v.fn((options, trigger, handler) => handler)", expr));
    assert.equal(entries.length, 1, expr);
    assert.equal(entries[0]!.line, 3);
    assert.match(entries[0]!.message, /options\.triggers/);
  }
});

test("handles direct SDK mock constructors and returns from a factory block", () => {
  const entries = check(`import {vi} from "vitest";
vi.mock("inngest", () => { return { Inngest: vi.fn(() => ({createFunction(config, trigger, handler){ return handler; }})) }; });`);
  assert.equal(entries.length, 1);
  assert.equal(check('vi.mock("inngest",()=>({Inngest: class { createFunction(config,t,h) { return h; } }}))').length, 1);
});

test("does not flag v4, non-test files, wrong SDKs and obscured mock factory identity", () => {
  assert.deepEqual(check(mock.replace("options, trigger, handler", "options, handler")), []);
  assert.deepEqual(check(mock, client, "src/factory.ts"), []);
  assert.deepEqual(check(mock, 'import {Client} from "other"; export const jobs = new Client();'), []);
  assert.deepEqual(check(mock.replace("jobs: {", "otherExport: {")), []);
  assert.deepEqual(check(mock.replace('"vitest"', '"different-mocks"')), []);
  assert.deepEqual(check(mock.replace("v.mock(", "function example(v) { v.mock(") + " }"), []);
  assert.deepEqual(check(mock.replace("() => ({","(v) => ({")), []);
  assert.deepEqual(check(mock.replace('"../client.js"', '"../outside.js"')), []);
});

test("mock targets require an exact scanned extension or the unambiguous TypeScript .js mapping", () => {
  for (const [specifier, actual] of [
    ["../client.mjs", "src/client.ts"], ["../client.ts", "src/client.js"], ["../client.jsx", "src/client.ts"],
    ["../client.js", "src/client.tsx"], ["../client.mjs", "src/client.mts"], ["../client.ts", "src/client.d.ts"],
  ] as const) {
    assert.deepEqual(check(mock.replace("../client.js", specifier), client, "src/functions/test.spec.ts", actual), [], specifier);
  }
  for (const [specifier, actual] of [
    ["../client.ts", "src/client.ts"], ["../client.js", "src/client.js"], ["../client.js", "src/client.ts"],
  ] as const) {
    assert.equal(check(mock.replace("../client.js", specifier), client, "src/functions/test.spec.ts", actual).length, 1);
  }
});
