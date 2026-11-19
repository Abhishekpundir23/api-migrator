import assert from "node:assert/strict";
import test from "node:test";
import { applyKnockV0ToV1 } from "../src/transforms/knock-v0-to-v1.js";
import type { ReportEntry } from "../src/types.js";

const wrapper = `import Knock from "@knocklabs/node";
const client = new Knock({ apiKey: "example" });
export async function loadChannel() {
  const result = await client.objects.getChannelData("collection", "object", "channel");
  return result;
}`;

const imports = 'import { loadChannel as load } from "../lib/service";';
function trace(body: string, target = wrapper, extraPaths: string[] = []): ReportEntry[] {
  const entries: ReportEntry[] = [];
  const output = applyKnockV0ToV1(`${imports}\n${body}`, "app/page.tsx",
    { push: entry => entries.push(entry) }, undefined, {
      scannedSources: new Map([["lib/service.ts", target]]),
      sourcePaths: new Set(["app/page.tsx", "lib/service.ts", ...extraPaths]),
    });
  assert.equal(output, null);
  return entries;
}

test("review the legacy SDK recipient imports once, including aliases and type-only imports", () => {
  const entries: ReportEntry[] = [];
  const source = `import type { Recipient as User, RecipientWithUpsert } from "@knocklabs/node";
import type { Recipient } from "./local";
type RecipientInput = User | RecipientWithUpsert;`;
  assert.equal(applyKnockV0ToV1(source, "input.ts", { push: e => entries.push(e) }), null);
  assert.deepEqual(entries.map(e => [e.code, e.kind, e.line]), [["KF1", "review", 1]]);
  assert.match(entries[0]!.message, /Knock\.Recipients\.RecipientRequest/);
});

test("a default type-only import supplies the v1 recipient namespace", () => {
  const entries: ReportEntry[] = [];
  const source = `import type SDK from "@knocklabs/node";
type Recipient = SDK.Recipients.RecipientRequest;`;
  assert.equal(applyKnockV0ToV1(source, "input.ts", { push: e => entries.push(e) }), null);
  assert.deepEqual(entries, []);
});

test("report each inferred channel result at its call only when it reads a provider-specific field", () => {
  const entries = trace(`async function Page() {
  const tenant = await load();
  const object = await load();
  return <>{tenant.data.token.access_token} {object.data.connections.map(render)} {tenant.data.token}</>;
}`);
  assert.deepEqual(entries.map(e => [e.code, e.kind, e.line]), [
    ["KF6", "review", 3], ["KF6", "review", 4],
  ]);
  assert.match(entries[0]!.message, /Narrow its \.data union/);
});

test("accept asserted, annotated and guarded channel data and shared response fields", () => {
  const cases = [
    'const value = (await load()) as Channel; return value.data.connections;',
    'const value: Channel = await load(); return value.data.connections;',
    'const value = await load(); return value.channel_id;',
    'const value = await load(); return "connections" in value.data && value.data.connections;',
    'const value = await load(); if (!("connections" in value.data)) return; return value.data.connections;',
    'const value = await load(); assertSlack(value.data); return value.data.connections;',
  ];
  for (const body of cases) assert.deepEqual(trace(`async function read() { ${body} }`), []);
});

test("require a uniquely resolved runtime import and an SDK-backed wrapper with an inferred return", () => {
  const body = "async function read() { const value = await load(); return value.data.connections; }";
  for (const target of [
    wrapper.replace('from "@knocklabs/node"', 'from "./another-sdk"'),
    wrapper.replace("function loadChannel()", "function loadChannel(): Promise<Channel>"),
    wrapper.replace("const result =", "const result: Channel ="),
    wrapper.replace("return result;", "return result as Channel;"),
    wrapper.replace("function loadChannel()", "function loadChannel(client: AnotherClient)"),
    wrapper.replace("const client =", "const client: any ="),
    wrapper + "\nloadChannel = anotherLoader;",
  ]) assert.deepEqual(trace(body, target), []);
  assert.deepEqual(trace(body, wrapper, ["lib/service.js"]), []);
  assert.deepEqual(trace(body.replace("read()", "read(load: LocalFunction)")), []);
  assert.deepEqual(trace(body.replace("return value.data.connections;", "{ const value = local(); return value.data.connections; }")), []);
});

test("retain the v1 ChannelData.data field and ignore same-named variables in other scopes", () => {
  const entries: ReportEntry[] = [];
  const source = `${wrapper}
const response = await client.users.list({});
function render(response: LocalRecord) { return response.data; }
const saved = await client.users.setChannelData("user", "channel", { data: {} });
const fetched = await client.objects.getChannelData("items", "item", "channel");
console.log(saved.data, fetched.data, response.data);
type Recipient = Knock.Recipients.RecipientRequest;`;
  assert.equal(applyKnockV0ToV1(source, "usage.ts", { push: e => entries.push(e) }), null);
  assert.deepEqual(entries.map(e => [e.code, e.line]), [["KF6", 11]]);
});
