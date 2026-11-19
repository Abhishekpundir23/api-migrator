import test from "node:test";
import assert from "node:assert/strict";
import { applyInngestV3ToV4, inngestBehavioralReviewEntries } from "../src/transforms/inngest-v3-to-v4.js";
import type { ReportEntry } from "../src/types.js";

const clientModule = `import { Inngest } from "inngest";
export const inngest = new Inngest({ id: "store" });`;
const sources = new Map([["src/inngest/client.ts", clientModule]]);

function assess(source: string, ownerAssessment = true) {
  const entries: ReportEntry[] = [];
  const output = applyInngestV3ToV4(source, "src/feature.ts", { push: entry => entries.push(entry) }, new Set(["T1"]), {
    scannedSources: sources, sourcePaths: new Set(sources.keys()), ownerAssessment,
  });
  return { output, reviews: entries.filter(e => e.code === "T1" && e.kind === "review") };
}

test("owner findings omit unrelated dynamic module loads and code evaluation", () => {
  for (const source of [
    'const driver = await import(`./connectors/${type}`); Object.keys(driver);',
    'async function load(file: string) { const mod = await import(file); return mod.up(); }',
    'const table = await import(ASSET_URL); table.build();',
    'client.redis.eval("return redis.call(KEYS[1])", 1, key);',
    'function query(db: unknown, text: string) { return eval(text); }',
    'const load = new Function("specifier", "return import(specifier)"); load("parquet-wasm");',
  ]) {
    assert.deepEqual(assess(source).reviews, [], source);
    assert.ok(assess(source, false).reviews.length > 0, "publication policy: " + source);
  }
});

test("owner findings omit send-only producers, unrenamed pass-through exports and callable siblings", () => {
  for (const source of [
    'const { inngest } = await import("./inngest/client"); await inngest.send({ name: "x" });',
    'import { inngest } from "./inngest/client"; const sendSpy = inngest.send as unknown; useSpy(sendSpy);',
    'import { inngest } from "./inngest/client"; export { inngest };',
    'import { getFunctions, logStatus } from "./inngest"; getFunctions(); logStatus();',
  ]) assert.deepEqual(assess(source).reviews, [], source);
});

test("owner assessment retains unknown receivers, aliasing, mutation and concealed registration evidence", () => {
  for (const source of [
    'const sdkName = "inngest"; const state = await import(sdkName);',
    'const moduleName = "./client"; const state = await import(moduleName);',
    'const { inngest } = await import("./inngest/client"); const alias = inngest; alias.createFunction({}, { event: "x" }, fn);',
    'import { inngest } from "./inngest/client"; export { inngest as jobs };',
    'import * as state from "./inngest/client"; Object.assign(state.inngest, { createFunction: replacement });',
    'const plugin = await import(name); plugin[method](opts, trigger, handler);',
    'const jobs = resolveJobs(); jobs.createFunction(opts, trigger, handler);',
    'eval("jobs.createFunction(opts, trigger, handler)");',
    'new Function("jobs", "jobs.createFunction = replacement");',
    'import { Inngest } from "inngest"; const jobs = new Inngest({id:"x"}); eval(script);',
  ]) {
    const result = assess(source);
    assert.ok(result.reviews.length > 0, source);
    assert.equal(result.output, null, source);
  }
});

test("T1 still rewrites a proven one-hop client and preserves an ambiguous registration", () => {
  const result = assess('import { inngest } from "./inngest/client"; inngest.createFunction({id:"one"}, {event:"x"}, async () => 1); const jobs = getJobs(); jobs.createFunction({}, { event: "two" }, handler);');
  assert.match(result.output ?? "", /triggers/);
  assert.match(result.output ?? "", /jobs\.createFunction\(\{\}, \{ event: "two" \}, handler\)/);
  assert.ok(result.reviews.some(e => /unproved/i.test(e.message)));
});

test("owner hosting advice fits the local report and campaign guidance remains available", () => {
  const enabled = new Set(["F12"]);
  assert.match(inngestBehavioralReviewEntries(enabled)[0]!.message, /campaign/);
  const owner = inngestBehavioralReviewEntries(enabled, { ownerAssessment: true })[0]!.message;
  assert.match(owner, /checkpointing.*maxRuntime/);
  assert.doesNotMatch(owner, /campaign/);
});

test("owner-only emitted .js import resolves a unique .ts SDK implementation", () => {
  const code = 'import { inngest } from "./inngest/client.js"; inngest.createFunction({id:"x"},{event:"e"},async()=>1);';
  assert.match(assess(code).output ?? "", /triggers/);
  assert.equal(assess(code, false).output, null);
});

test("explicit .js proof refuses competing, missing, declaration-only or unrelated implementations", () => {
  const code = 'import { inngest } from "./client.js"; inngest.createFunction({id:"x"},{event:"e"},async()=>1);';
  for (const [name, extra, source, importer] of [
    ["src/client.ts", "src/client.js", clientModule, "src/worker.ts"],
    ["src/client.ts", "src/client.d.ts", clientModule, "src/worker.ts"],
    ["src/client.ts", "src/client.native.ts", clientModule, "src/worker.ts"],
    ["src/client.d.ts", "", clientModule, "src/worker.ts"],
    ["src/client.js", "", clientModule, "src/worker.js"],
    ["src/client.ts", "", clientModule, "src/worker.js"],
    ["src/not-the-client.ts", "", clientModule, "src/worker.ts"],
    ["src/client.ts", "", "export const inngest = makeOtherClient();", "src/worker.ts"],
    ["src/client.ts", "", clientModule + " inngest.createFunction = other;", "src/worker.ts"],
  ]) {
    const scannedSources = new Map([[name!,source!]]);
    const sourcePaths = new Set([name!,...(extra ? [extra] : [])]);
    const entries: ReportEntry[] = [];
    const output = applyInngestV3ToV4(code,importer!,{push: e=>entries.push(e)},new Set(["T1"]),{scannedSources,sourcePaths,ownerAssessment:true});
    assert.equal(output,null,[name,extra,source,importer].join(" "));
    assert.ok(entries.some(e=>e.code==="T1" && e.kind==="review"));
  }
});

test("emitted .js proof does not promote shadowed or mutated consumers", () => {
  for (const body of [
    "function dispatch(inngest) { inngest.createFunction(opts,trigger,handler); }",
    "inngest.createFunction = replacement; inngest.createFunction(opts,trigger,handler);",
    "const alias = inngest; alias.createFunction(opts,trigger,handler);",
  ]) {
    const result=assess('import { inngest } from "./inngest/client.js"; '+body);
    assert.equal(result.output,null,body);
    assert.ok(result.reviews.length);
  }
});

test("a trigger-shaped three-argument call traces computed and destructured loader aliases", () => {
  for (const source of [
    'const mod = await import(name); const register = mod[key]; register(opts, {event:"x"}, handler);',
    'const { register } = require(name); register(opts,[{cron:"0 * * * *"}],handler);',
    'const mod = await import(name); const a = mod; const register = a[key]; register(opts,{cron:expr},handler);',
  ]) {
    const result = assess(source);
    assert.equal(result.output, null);
    assert.ok(result.reviews.some(entry => /Non-literal/.test(entry.message)), source);
  }
  for (const source of [
    'const mod = await import(name); const f = mod[key]; f(opts, {type:"x"}, handler);',
    'const mod = await import(name); const f = mod[key]; f({event:"x"}, handler);',
    'const mod = await import(name); const f = mod[key]; function other(f) { f(opts,{event:"x"},handler); }',
    'const mod = await import(name); const f = getOther(mod); f(opts,{event:"x"},handler);',
  ]) assert.deepEqual(assess(source).reviews, [], source);
});

test("a functions barrel export passed to the SDK serve adapter is outside trigger migration", () => {
  const imports = 'import { serve as adapter } from "inngest/hono"; import { functions as handlers, inngest } from "./inngest";';
  const source = imports + ' adapter({ client: inngest, functions: handlers });';
  assert.deepEqual(assess(source).reviews, []);
  assert.ok(assess(source, false).reviews.length);
  for (const unsafe of [
    imports + ' unknown({client: inngest, functions:handlers});',
    imports + ' adapter({client: inngest, other:{functions:handlers}});',
    imports + ' adapter({client: inngest, functions: handlers}); handOff(handlers);',
  ]) assert.ok(assess(unsafe).reviews.length, unsafe);
});

test("owner moves a literal v3 trigger array intact and a second assessment makes no edit", () => {
  const prefix = 'import { inngest } from "./inngest/client"; ';
  for (const list of [
    '[{event: "first", if: "event.data.ok"}, /* keep order */ {event: "second"}]',
    '[{cron: "TZ=Europe/London 0 9 * * *"}, {cron: "0 10 * * *"}]',
    '[{event: "single"}]',
  ]) {
    const source = prefix + 'inngest.createFunction({id: "jobs", retries: 3}, ' + list + ', async () => "handled");';
    const { output, reviews } = assess(source);
    assert.ok(output);
    assert.deepEqual(reviews, []);
    assert.ok(output.includes("triggers: " + list));
    assert.match(output, /id: "jobs"/);
    assert.match(output, /retries: 3/);
    assert.match(output, /async \(\) => "handled"/);
    assert.deepEqual(assess(output), { output: null, reviews: [] });
    assert.equal(assess(source, false).output, null);
  }
});

test("owner leaves uncertain positional lists, receiver, handler and option collisions for review", () => {
  const register = (triggers: string, options = '{}', handler = '() => 1', receiver = 'inngest') =>
    'import { inngest } from "./inngest/client"; ' + receiver + '.createFunction(' + [options, triggers, handler].join(', ') + ');';
  for (const source of [
    ...['[]', '[{event: "x"}, {cron: "* * * * *"}]', '[{event:"x"}, unknown]', '[{event:"x"}, ,]',
      '[...more]', '[{event: "x", ...more}]', '[{["event"]: "x"}]', '[{event: dynamic}]', '[{event:"x", if: dynamic}]',
      '[{event:"x", event:"y"}]', '[{event:"x", unknown:"z"}]', '[{cron:"c", if:"z"}]', '[{event:"x", cron:"c"}]',
      '[{get event() { return "x"; }}]',
    ].map(t => register(t)),
    ...['{triggers: []}', '{...options}', '{[name]: false}', '{get triggers() { return []; }}'].map(o => register('[{event:"e"}]',o)),
    register('[{event:"e"}]', '{}', 'handler'),
    register('[{event:"e"}]', '{}', '() => 1', 'unknown'),
  ]) {
    const result = assess(source);
    assert.equal(result.output, null, source);
    assert.ok(result.reviews.length, source);
  }
});
