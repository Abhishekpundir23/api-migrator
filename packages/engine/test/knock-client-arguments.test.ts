import assert from "node:assert/strict";
import test from "node:test";
import { applyKnockV0ToV1 } from "../src/transforms/knock-v0-to-v1.js";
import type { ReportEntry } from "../src/types.js";

const sdkImport = 'import Knock from "@knocklabs/node";\n';
const client = sdkImport + 'const client = new Knock({ apiKey: "test" });\n';

function migrate(source: string, enabled?: string[]) {
  const entries: ReportEntry[] = [];
  const output = applyKnockV0ToV1(source, "service.ts", { push: entry => entries.push(entry) },
    enabled && new Set(enabled));
  return { output, entries };
}

test("constructor moves a positional key and host once, in order, retaining host shorthand and comments", () => {
  for (const [options, expected] of [
    ["{ host: readHost() }", /baseURL:\s*readHost\(\)/],
    ["{ host }", /baseURL:\s*host\b/],
    ["{ /* endpoint */ 'host': endpoint }", /\/\* endpoint \*\/\s*baseURL:\s*endpoint/],
    ["{}", /apiKey:\s*readKey\(\)/],
  ] as const) {
    const source = sdkImport + `new Knock(readKey(), ${options});`;
    const { output, entries } = migrate(source);
    assert.ok(output);
    assert.match(output, expected);
    assert.match(output, /new Knock\(\{\s*apiKey:\s*readKey\(\)/);
    assert.equal(output.match(/readKey\(\)/g)?.length, 1);
    assert.deepEqual(entries.map(entry => [entry.code, entry.kind]), [["K5", "applied"]]);
    assert.deepEqual(migrate(output), { output: null, entries: [] });
  }
});

test("constructor options with extra evaluations, unknown fields or spreads require review", () => {
  for (const args of [
    "key, getOptions()", "key, { ...options }", "key, { [name]: endpoint }",
    "key, { get host() { return endpoint; } }", "key, { host, host: nextHost() }",
    "key, { host, timeout }", "key, { host }, log()", "...args", "...keys, { host }",
    "{ apiKey: key }, { host }",
  ]) {
    const { output, entries } = migrate(sdkImport + `new Knock(${args});`);
    assert.equal(output, null, args);
    assert.deepEqual(entries.map(entry => [entry.code, entry.kind]), [["K5", "review"]], args);
  }
});

test("one-argument constructor distinguishes existing options, positional keys and ambiguous values", () => {
  const options = sdkImport + `const options = { apiKey: lookup() }; const alias = options;
    new Knock(options); new Knock(alias); new Knock(); new Knock(undefined);`;
  assert.deepEqual(migrate(options), { output: null, entries: [] });
  const key = sdkImport + `const key = process.env.KNOCK_KEY;
    new Knock(key); new Knock((key ?? "fallback")!); new Knock("literal");`;
  const known = migrate(key);
  assert.equal(known.entries.filter(entry => entry.kind === "applied").length, 3);
  assert.match(known.output!, /apiKey:\s*key\b/);
  assert.deepEqual(migrate(known.output!), { output: null, entries: [] });
  for (const source of [
    "new Knock(input);", "new Knock(makeOptions());",
    "function start(process: any) { new Knock(process.env.KNOCK_KEY); }",
    "new Knock(process.env.KEY || { apiKey: backup });",
  ]) {
    const result = migrate(sdkImport + source);
    assert.equal(result.output, null, source);
    assert.deepEqual(result.entries.map(e => [e.code, e.kind]), [["K5", "review"]], source);
  }
});

test("a direct token helper and a constructor can share a binding with users.identify", () => {
  const source = sdkImport + `const client = new Knock(process.env.KEY, { host: process.env.HOST });
    client.users.identify(id, lookup());
    Knock.signUserToken(id, opts);`;
  const { output, entries } = migrate(source, ["K2", "K5"]);
  assert.ok(output);
  assert.match(output, /users\.update\(id, lookup\(\)\)/);
  assert.match(output, /Knock\.signUserToken\(id, opts\)/);
  assert.match(output, /baseURL:\s*process.env.HOST/);
  assert.deepEqual(entries.filter(e => e.kind === "applied").map(e => e.code).sort(), ["K2", "K5"]);
});

test("users.identify supplies the default body required by users.update", () => {
  const { output, entries } = migrate(client + "client.users.identify(id); client.users.identify(id, undefined);");
  assert.equal(output?.match(/users\.update\(id, \{\}\)/g)?.length, 2);
  assert.equal(entries.length, 2);
  for (const call of ["client.users.identify(...args)", "client.users.identify(id, props, extra())"]) {
    const result = migrate(client + call);
    assert.equal(result.output, null);
    assert.deepEqual(result.entries.map(e => [e.code, e.kind]), [["K2", "review"]]);
  }
});

test("users.setChannelData wraps visible raw payloads once and accepts the v1 request body", () => {
  const source = client + `client.objects.getChannelData(collection, id, channel);
    client.tenants.get(tenant); client.objects.get(collection, id); client.users.getChannelData(id, channel);
    client.users.setChannelData(id, channel, { connections: [getConnection()], token });
    client.users.setChannelData(id, channel, { tokens });
    client.users.setChannelData(id, channel, { player_ids: players });
    client.users.setChannelData(id, channel, { data: payload }, requestOptions);`;
  const { output, entries } = migrate(source);
  assert.ok(output);
  assert.equal(output.match(/getConnection\(\)/g)?.length, 1);
  for (const key of ["connections", "tokens", "player_ids"]) {
    assert.match(output, new RegExp("data:\\s*\\{\\s*" + key));
  }
  assert.deepEqual(entries.map(e => [e.code, e.kind]), Array(3).fill(["K3", "applied"]));
  assert.deepEqual(migrate(output), { output: null, entries: [] });
});

test("ambiguous channel requests and wrappers get a specific manual migration", () => {
  for (const args of [
    "id, channel, payload", "id, channel, { ...data }", "id, channel, { [field]: data }",
    "id, channel, { data, connections }", "id, channel, { unsupported }",
    "id, channel, { tokens }, extra()", "...args",
  ]) {
    const { output, entries } = migrate(client + `client.users.setChannelData(${args});`);
    assert.equal(output, null, args);
    assert.deepEqual(entries.map(e => [e.code, e.kind]), [["KF1", "review"]], args);
    assert.match(entries[0]!.message, /\{ data: payload \}/);
  }
  for (const source of [
    'import { client } from "./knock"; client.users.setChannelData(id, channel, { connections });',
    'const client = createKnockClient(); client.users.setChannelData(id, channel, payload);',
  ]) {
    const result = migrate(source);
    assert.equal(result.output, null);
    assert.match(result.entries[0]?.message ?? "", /\{ data: payload \}/);
  }
  const ambiguous = client + "client.users.setChannelData(id, channel, payload);";
  assert.deepEqual(migrate(ambiguous, ["K3"]).entries.map(e => [e.code, e.kind]), [["K3", "review"]]);
  assert.deepEqual(migrate(ambiguous, []), { output: null, entries: [] });
});
