import test from "node:test";
import assert from "node:assert/strict";
import {
  applyInngestV3ToV4,
  applyKnockV0ToV1,
  inngestBehavioralReviewEntries,
  parseManifest,
} from "../src/index.js";
import type { ReportEntry } from "../src/index.js";

function collect<T>(run: (entries: ReportEntry[]) => T): { value: T; entries: ReportEntry[] } {
  const entries: ReportEntry[] = [];
  return { value: run(entries), entries };
}

test("manifest rejects unknown transform ids and unknown fields", () => {
  const base = {
    name: "Inngest v4",
    provider: "inngest",
    transformSet: "inngest-v3-to-v4",
    runtime: { node: { minimumMajor: 20, profile: "node22-bookworm-slim-2026-07", packageJson: "package.json", dockerfile: "Dockerfile" } },
    package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
    peerFloors: [],
  };
  assert.throws(() => parseManifest({ ...base, transforms: ["NOT_REAL"] }), /Unknown transform id/);
  assert.throws(() => parseManifest({ ...base, unexpected: true }), /Unrecognized key/);
  assert.deepEqual(parseManifest({ ...base, transforms: [] }).transforms, []);
});

test("Inngest transforms only imported client and serve bindings", () => {
  const source = `
import { Inngest } from "inngest";
import { serve } from "inngest/next";
const client = new Inngest({ id: "demo" });
client.createFunction({ id: "f" }, { event: "demo/run" }, ({ event, step }) => {
  step.invoke("other/function", {});
  return event.user;
});
serve({ client, functions: [], serveHost: "https://example.test", streaming: "force" });
const unrelated = { serveHost: "leave-me", streaming: "custom" };
const event = { user: "outside-handler" };
`;
  const { value: first, entries } = collect((out) =>
    applyInngestV3ToV4(source, "src/inngest.ts", { push: (entry) => out.push(entry) })
  );
  assert.ok(first);
  assert.match(first, /triggers:/);
  assert.match(first, /serveOrigin:/);
  assert.match(first, /streaming: true/);
  assert.match(first, /serveHost: "leave-me"/);
  assert.match(first, /streaming: "custom"/);
  assert.equal(entries.filter((entry) => entry.code === "F2").length, 1);
  assert.equal(entries.filter((entry) => entry.code === "F7").length, 1);

  const secondEntries: ReportEntry[] = [];
  const second = applyInngestV3ToV4(first, "src/inngest.ts", { push: (entry) => secondEntries.push(entry) });
  assert.equal(second, null, "transform is idempotent");
  assert.equal(secondEntries.some((entry) => entry.kind === "applied"), false);
});

test("Inngest T5 adds an explicit environment-controlled development mode", () => {
  const source = `import { Inngest } from "inngest";
export const inngest = new Inngest({ id: "demo" });
`;
  const first = collect((entries) => applyInngestV3ToV4(
    source,
    "src/inngest/client.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T5", "F1"])
  ));
  assert.ok(first.value);
  assert.match(first.value, /isDev: process\.env\.INNGEST_DEV === "1"/);
  assert.equal(first.entries.filter((entry) => entry.code === "T5" && entry.kind === "applied").length, 1);
  assert.equal(first.entries.some((entry) => entry.code === "F1"), false);

  const second = collect((entries) => applyInngestV3ToV4(
    first.value!,
    "src/inngest/client.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T5", "F1"])
  ));
  assert.equal(second.value, null);
  assert.equal(second.entries.length, 0);

  for (const unsafe of [
    `import { Inngest } from "inngest";\nconst options = { id: "demo" };\nnew Inngest(options);`,
    `import { Inngest } from "inngest";\nconst defaults = {};\nnew Inngest({ id: "demo", ...defaults });`,
    `import { Inngest } from "inngest";\nconst process = fakeProcess;\nnew Inngest({ id: "demo" });`,
    `import { Inngest } from "inngest";\nnew Inngest({ id: "demo", isDev() { return false; } });`,
    `import { Inngest } from "inngest";\nnew Inngest({ id: "demo", get isDev() { return false; } });`,
    `import { Inngest } from "inngest";\nnew Inngest({ id: "demo", set signingKey(value: string) { void value; } });`,
  ]) {
    const result = collect((entries) => applyInngestV3ToV4(
      unsafe,
      "src/inngest/unsafe-client.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["T5", "F1"])
    ));
    assert.equal(result.entries.some((entry) => entry.code === "T5"), false);
    assert.equal(result.entries.some((entry) => entry.code === "F1" && entry.kind === "review"), true);
  }
});

test("Knock transforms are receiver-aware and idempotent", () => {
  const source = `
import { Knock } from "@knocklabs/node";
const knock = new Knock(process.env.KNOCK_KEY!);
await knock.notify("welcome", { recipients: ["u_1"], cancellationKey: "c_1" });
await knock.users.list({ pageSize: 20 });
await knock.users.identify("u_1", { name: "Ada" });
mailer.notify("unrelated");
const unrelated = { pageSize: 50, cancellationKey: "leave-me" };
`;
  const { value: first, entries } = collect((out) =>
    applyKnockV0ToV1(source, "src/knock.ts", { push: (entry) => out.push(entry) })
  );
  assert.ok(first);
  assert.match(first, /import Knock from/);
  assert.match(first, /new Knock\(\{\s*apiKey:/);
  assert.match(first, /knock\.workflows\.trigger/);
  assert.match(first, /page_size: 20/);
  assert.match(first, /cancellation_key: "c_1"/);
  assert.match(first, /mailer\.notify\("unrelated"\)/);
  assert.match(first, /pageSize: 50/);
  assert.match(first, /cancellationKey: "leave-me"/);
  for (const code of ["K1", "K2", "K3", "K4", "K5"]) {
    assert.equal(
      entries.some((entry) => entry.code === code && entry.kind === "applied"),
      true,
      `${code} must be applied rather than review-only`
    );
  }
  assert.equal(entries.some((entry) => entry.kind === "review"), false);
  assert.equal(entries.some((entry) => /^F\d+$/.test(entry.code)), false);

  const secondEntries: ReportEntry[] = [];
  const second = applyKnockV0ToV1(first, "src/knock.ts", { push: (entry) => secondEntries.push(entry) });
  assert.equal(second, null);
  assert.equal(secondEntries.some((entry) => entry.kind === "applied"), false);
});

test("Knock mutable clients and method or prototype replacement fail closed", () => {
  const cases = [
    `import Knock from "@knocklabs/node";
let knock = new Knock({ apiKey: "key" });
knock = fakeClient as any;
knock.notify("welcome");`,
    `import Knock from "@knocklabs/node";
const knock = new Knock({ apiKey: "key" });
knock.notify = fakeNotify as any;
knock.notify("welcome");`,
    `import Knock from "@knocklabs/node";
Object.assign(Knock.prototype, { notify: fakeNotify });
const knock = new Knock({ apiKey: "key" });
knock.notify("welcome");`,
    `import Knock from "@knocklabs/node";
const knock = new Knock({ apiKey: "key" });
const alias: any = knock.valueOf();
Object.assign(alias, { notify: fakeNotify });
knock.notify("welcome");`,
  ];
  for (const source of cases) {
    const result = collect((entries) => applyKnockV0ToV1(
      source,
      "src/notify.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["K1"])
    ));
    assert.equal(result.value, null);
    assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
    assert.equal(result.entries.some((entry) => entry.kind === "review"), true);
  }
});

test("Knock type-only imports never become runtime default imports", () => {
  for (const source of [
    `import type { Knock } from "@knocklabs/node";\ntype Client = Knock;`,
    `import { type Knock } from "@knocklabs/node";\ntype Client = Knock;`,
  ]) {
    const result = collect((entries) => applyKnockV0ToV1(
      source,
      "src/types.ts",
      { push: (entry) => entries.push(entry) }
    ));
    assert.equal(result.value, null);
    assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
    assert.equal(result.entries.some((entry) => entry.code === "K4" && entry.kind === "review"), true);
  }
});

test("Knock rewrites only exact audited method chains", () => {
  for (const call of [
    `knock.custom.notify("welcome")`,
    `knock.custom.users.identify("user", { name: "Ada" })`,
  ]) {
    const result = collect((entries) => applyKnockV0ToV1(
      `import Knock from "@knocklabs/node";
const knock = new Knock({ apiKey: "key" });
${call};`,
      "src/notify.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["K1", "K2"])
    ));
    assert.equal(result.value, null);
    assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
    assert.equal(result.entries.some((entry) => entry.kind === "review"), true);
  }
});

test("Knock wrapper aliases, loaders, and computed calls require review", () => {
  const cases = [
    `import { knock } from "@/client";\nknock.notify("welcome");`,
    `const { knock } = require("./client");\nknock.notify("welcome");`,
    `import { knock } from "$lib/client";\nconst key = "notify";\nknock[key]("welcome");`,
    `const moduleName = "@knocklabs/node";\nconst { Knock } = await import(moduleName);`,
  ];
  for (const source of cases) {
    const result = collect((entries) => applyKnockV0ToV1(
      source,
      "src/notify.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["K1"])
    ));
    assert.equal(result.value, null);
    assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
    assert.equal(result.entries.some((entry) => entry.kind === "review"), true);
  }
});

test("Knock one-hop wrapper aliases and extracted methods fail closed", () => {
  const cases = [
    `import { knock } from "./client";
const alias = knock;
alias.notify("welcome");`,
    `import { knock } from "./client";
const notify = knock.notify;
notify("welcome");`,
    `import { knock } from "./client";
knock.notify.call(knock, "welcome");`,
    `import { knock } from "./client";
knock.notify.bind(knock)("welcome");`,
    `import { knock } from "./client";
declare const method: string;
const invoke = knock[method];
invoke("welcome");`,
  ];
  for (const source of cases) {
    const result = collect((entries) => applyKnockV0ToV1(
      source,
      "src/notify.ts",
      { push: (entry) => entries.push(entry) }
    ));
    assert.equal(result.value, null);
    assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
    assert.equal(result.entries.some((entry) => entry.kind === "review"), true);
  }
});

test("Knock factory-returned legacy calls require review under the full transform", () => {
  const result = collect((entries) => applyKnockV0ToV1(
    `function makeKnock(): any { return {}; }
const api = makeKnock();
api.notify("welcome", { cancellationKey: "c_1" });
api.users.identify("user_1", { name: "Ada" });
api.users.list({ pageSize: 20 });`,
    "src/factory.ts",
    { push: (entry) => entries.push(entry) }
  ));
  assert.equal(result.value, null);
  assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
  assert.equal(result.entries.some((entry) => entry.code === "K1" && entry.kind === "review"), true);
  assert.equal(result.entries.some((entry) => entry.code === "K2" && entry.kind === "review"), true);
  assert.equal(result.entries.some((entry) => entry.code === "K3" && entry.kind === "review"), true);
});

test("Knock unproven-call review ignores unrelated notify APIs and v1 parameter names", () => {
  const result = collect((entries) => applyKnockV0ToV1(
    `const mailer = makeMailer();
mailer.notify("welcome");
const knock = makeKnock();
knock.workflows.trigger("welcome", { cancellation_key: "c_1" });
knock.users.update("user_1", { name: "Ada" });`,
    "src/unrelated.ts",
    { push: (entry) => entries.push(entry) }
  ));
  assert.equal(result.value, null);
  assert.deepEqual(result.entries, []);
});

test("same-line Knock transforms retain distinct report entries", () => {
  const result = collect((entries) => applyKnockV0ToV1(
    `import Knock from "@knocklabs/node";
const knock = new Knock({ apiKey: "key" });
knock.notify("a"); knock.notify("b");`,
    "src/notify.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["K1"])
  ));
  assert.ok(result.value);
  assert.equal(result.entries.filter((entry) => entry.code === "K1" && entry.kind === "applied").length, 2);
});

test("explicit transform selection is enforced", () => {
  const source = `import { Inngest } from "inngest";
const i = new Inngest({ id: "x" });
i.createFunction({ id: "f" }, { event: "x" }, async () => {});`;
  const entries: ReportEntry[] = [];
  const output = applyInngestV3ToV4(source, "x.ts", { push: (entry) => entries.push(entry) }, new Set());
  assert.equal(output, null);
  assert.deepEqual(entries, []);
});

test("receiver bindings respect lexical shadowing", () => {
  const inngestSource = `
import { Inngest } from "inngest";
const client = new Inngest({ id: "real" });
function unrelated(client: any) {
  return client.createFunction({ id: "not-sdk" }, { event: "x" }, async () => {});
}
`;
  const inngest = collect((entries) =>
    applyInngestV3ToV4(
      inngestSource,
      "shadow.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["T1"])
    )
  );
  assert.equal(inngest.value, null);
  assert.equal(inngest.entries.some((entry) => entry.kind === "applied"), false);
  assert.equal(inngest.entries.some((entry) => entry.kind === "review"), true);

  const knockSource = `
import Knock from "@knocklabs/node";
const knock = new Knock({ apiKey: "real" });
function unrelated(knock: any) {
  return knock.notify("not-sdk");
}
`;
  const knock = collect((entries) =>
    applyKnockV0ToV1(
      knockSource,
      "shadow.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["K1"])
    )
  );
  assert.equal(knock.value, null);
  assert.deepEqual(knock.entries, []);

  const blockShadow = collect((entries) =>
    applyKnockV0ToV1(
      `import Knock from "@knocklabs/node";
const knock = new Knock({ apiKey: "real" });
{
  const knock = { notify(value: string) { return value; } };
  knock.notify("not-sdk");
}
switch (mode) {
  case "local":
    const knock = { notify(value: string) { return value; } };
    knock.notify("also-not-sdk");
    break;
}
knock.notify("sdk");`,
      "block-shadow.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["K1"])
    )
  );
  assert.ok(blockShadow.value);
  assert.match(blockShadow.value, /knock\.notify\("not-sdk"\)/);
  assert.match(blockShadow.value, /knock\.notify\("also-not-sdk"\)/);
  assert.match(blockShadow.value, /knock\.workflows\.trigger\("sdk"\)/);
  assert.equal(blockShadow.entries.filter((entry) => entry.kind === "applied").length, 1);
});

test("unproven imports are never transformed and block for review", () => {
  const unrelated = collect((entries) =>
    applyInngestV3ToV4(
      `import { inngest } from "unrelated-library";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
      "unrelated.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["T1"])
    )
  );
  assert.equal(unrelated.value, null);
  assert.deepEqual(unrelated.entries.map((entry) => entry.kind), ["review"]);

  const localInngest = collect((entries) =>
    applyInngestV3ToV4(
      `import { inngest } from "./client";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
      "wrapper.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["T1"])
    )
  );
  assert.equal(localInngest.value, null);
  assert.deepEqual(localInngest.entries.map((entry) => entry.kind), ["review"]);
  assert.match(localInngest.entries[0]!.message, /local module/);

  const localKnock = collect((entries) =>
    applyKnockV0ToV1(
      `import { knock } from "./client";
knock.notify("welcome");`,
      "wrapper.ts",
      { push: (entry) => entries.push(entry) },
      new Set()
    )
  );
  assert.equal(localKnock.value, null);
  assert.deepEqual(localKnock.entries.map((entry) => entry.kind), ["review"]);
});

test("mutable Inngest clients are never trusted after reassignment", () => {
  const result = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
let client = new Inngest({ id: "demo" });
client = fakeClient as any;
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T1"])
  ));
  assert.equal(result.value, null);
  assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
  assert.equal(result.entries.some((entry) => entry.code === "T1" && entry.kind === "review"), true);
});

test("overwritten createFunction methods are never transformed", () => {
  const direct = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
client.createFunction = fakeCreateFunction as any;
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T1"])
  ));
  assert.equal(direct.value, null);
  assert.equal(direct.entries.some((entry) => entry.kind === "applied"), false);
  assert.equal(direct.entries.filter((entry) => entry.code === "T1" && entry.kind === "review").length >= 1, true);

  const imported = localInngestTransform(
    `import { client } from "./client";
client.createFunction = fakeCreateFunction as any;
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    {
      "src/client.ts": `import { Inngest } from "inngest";
export const client = new Inngest({ id: "demo" });`,
    }
  );
  assert.equal(imported.value, null);
  assert.equal(imported.entries.some((entry) => entry.kind === "applied"), false);
  assert.equal(imported.entries.some((entry) => entry.code === "T1" && entry.kind === "review"), true);
});

test("mutated one-hop wrapper clients never establish provenance", () => {
  const result = localInngestTransform(
    `import { client } from "./client";
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    {
      "src/client.ts": `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
client.createFunction = fakeCreateFunction as any;
export { client };`,
    }
  );
  assert.equal(result.value, null);
  assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
  assert.match(result.entries[0]?.message ?? "", /local module/);
});

test("unsafe references to proven imported clients block without a createFunction call", () => {
  const result = localInngestTransform(
    `import { client } from "./client";
Object.defineProperty(client, "createFunction", { value: fakeCreateFunction });`,
    "src/mutator.ts",
    {
      "src/client.ts": `import { Inngest } from "inngest";
export const client = new Inngest({ id: "demo" });`,
    }
  );
  assert.equal(result.value, null);
  assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
  assert.equal(result.entries.some((entry) => entry.code === "T1" && entry.kind === "review"), true);
});

test("optional and alias-returning Inngest calls never establish automatic proof", () => {
  const cases = [
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
client.createFunction?.({ id: "x" }, { event: "x" }, async () => {});`,
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
const alias: any = client.valueOf();
Object.assign(alias, { createFunction: fakeCreateFunction });
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
  ];
  for (const source of cases) {
    const result = collect((entries) => applyInngestV3ToV4(
      source,
      "src/functions.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["T1"])
    ));
    assert.equal(result.value, null);
    assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
    assert.equal(result.entries.some((entry) => entry.code === "T1" && entry.kind === "review"), true);
  }
});

test("constructor prototype replacement blocks Inngest transformation", () => {
  const mutations = [
    `Object.assign(Inngest.prototype, { createFunction: fakeCreateFunction });`,
    `Object.defineProperty(Inngest.prototype, "createFunction", { value: fakeCreateFunction });`,
    `Reflect.set(Inngest.prototype, "createFunction", fakeCreateFunction);`,
  ];
  for (const mutation of mutations) {
    const result = collect((entries) => applyInngestV3ToV4(
      `import { Inngest } from "inngest";
${mutation}
const client = new Inngest({ id: "demo" });
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
      "src/functions.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["T1"])
    ));
    assert.equal(result.value, null);
    assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
    assert.equal(result.entries.some((entry) => entry.kind === "review"), true);
  }
});

test("wrapper constructors and namespace consumers are closed over provenance", () => {
  const wrapperMutation = localInngestTransform(
    `import { client } from "./client";
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    {
      "src/client.ts": `import { Inngest as Constructor } from "inngest";
Object.assign(Constructor.prototype, { createFunction: fakeCreateFunction });
const internal = new Constructor({ id: "demo" });
export { internal as client };`,
    }
  );
  assert.equal(wrapperMutation.value, null);
  assert.equal(wrapperMutation.entries.some((entry) => entry.kind === "applied"), false);
  assert.equal(wrapperMutation.entries.some((entry) => entry.kind === "review"), true);

  const namespaceMutation = localInngestTransform(
    `import * as state from "./client";
Object.assign(state.client, { createFunction: fakeCreateFunction });`,
    "src/mutator.ts",
    {
      "src/client.ts": `import { Inngest } from "inngest";
export const client = new Inngest({ id: "demo" });`,
    }
  );
  assert.equal(namespaceMutation.value, null);
  assert.equal(namespaceMutation.entries.some((entry) => entry.kind === "applied"), false);
  assert.equal(namespaceMutation.entries.some((entry) => entry.kind === "review"), true);
});

test("alternate wrapper exports and loader aliases cannot bypass one-hop review", () => {
  const defaultAlias = localInngestTransform(
    `import { client } from "./client";
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    {
      "src/client.ts": `import { Inngest } from "inngest";
const internal = new Inngest({ id: "demo" });
export { internal as client, internal as default };`,
    }
  );
  assert.equal(defaultAlias.value, null);
  assert.equal(defaultAlias.entries.some((entry) => entry.kind === "applied"), false);
  assert.equal(defaultAlias.entries.some((entry) => entry.kind === "review"), true);

  const shared = {
    "src/client.ts": `import { Inngest } from "inngest";
export const client = new Inngest({ id: "demo" });`,
  };
  for (const mutation of [
    `const patch = { createFunction: fakeCreateFunction };
Object.assign(require("./client").client, patch);`,
    `const patch = { createFunction: fakeCreateFunction };
Object.assign((await import("./client")).client, patch);`,
    `import * as state from "@/client";
const key = "createFunction";
state.client[key] = fakeCreateFunction;`,
  ]) {
    const result = localInngestTransform(
      `import { client } from "./client";
${mutation}
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
      "src/functions.ts",
      shared
    );
    assert.equal(result.entries.some((entry) => entry.code === "T1" && entry.kind === "review"), true);
  }
});

test("non-literal loaders and dynamic evaluation always require review", () => {
  for (const source of [
    `const moduleName = "./client";\nconst state = await import(moduleName);`,
    `const sdkName = "inngest";\nconst sdk = await import(sdkName);`,
    `eval("client.createFunction = fakeCreateFunction");`,
    `new Function("client", "client.createFunction = fakeCreateFunction");`,
  ]) {
    const result = collect((entries) => applyInngestV3ToV4(
      source,
      "src/dynamic.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["T1"])
    ));
    assert.equal(result.entries.some((entry) => entry.code === "T1" && entry.kind === "review"), true);
  }
});

test("unrelated reflective createFunction properties do not create false blockers", () => {
  const result = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
const unrelated = {};
Object.assign(unrelated, { createFunction() { return "not inngest"; } });
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T1"])
  ));
  assert.ok(result.value);
  assert.equal(result.entries.filter((entry) => entry.kind === "applied").length, 1);
  assert.equal(result.entries.some((entry) => entry.kind === "review"), false);
});

test("unrelated path aliases, loaders, and relative re-exports do not block Inngest", () => {
  const result = collect((entries) => applyInngestV3ToV4(
    `import { Button } from "@/components/ui/button";
import { getState } from "@/app/utils/state";
import { inngestFunctions } from "@/inngest/functions";
import { createClient } from "@supabase/supabase-js";
import dbClient from "@/database";
import prisma from "@/prisma/client";
import http from "@/http/client";
import database from "@/db/client";
const helper = require("./helper");
export { Card } from "./card";
export { prismaClient } from "./database";
export { httpClient as transport } from "./http";
void Button;
getState();
void inngestFunctions;
void createClient;
dbClient.query("select 1");
prisma.user.findMany();
http.get("/");
database.query("select 1");
helper.run();`,
    "src/unrelated.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T1"])
  ));
  assert.equal(result.value, null);
  assert.equal(result.entries.some((entry) => entry.kind === "review"), false);
});

test("a direct send through an imported Inngest client does not create a provenance blocker", () => {
  const direct = collect((entries) => applyInngestV3ToV4(
    `import { inngest } from "@/inngest/client";
await inngest.send({ name: "demo/run", data: { id: "1" } });`,
    "src/send.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T1"])
  ));
  assert.equal(direct.value, null);
  assert.equal(direct.entries.some((entry) => entry.kind === "review"), false);

  const computed = collect((entries) => applyInngestV3ToV4(
    `import { inngest } from "@/inngest/client";
const method = "send";
await inngest[method]({ name: "demo/run", data: { id: "1" } });`,
    "src/send.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T1"])
  ));
  assert.equal(computed.entries.some((entry) => entry.kind === "review"), true);
});

test("Inngest F11 is limited to unshadowed Promise.race calls in proven handlers", () => {
  const positive = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
client.createFunction({ id: "x" }, { event: "x" }, async ({ step }) => {
  return Promise.race([
    step.run("one", async () => 1),
    step.run("two", async () => 2),
  ]);
});`,
    "src/functions.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["F11"])
  ));
  assert.equal(positive.entries.filter((entry) => entry.code === "F11").length, 1);
  assert.match(positive.entries[0]?.message ?? "", /Promise\.race/);

  const computedPositive = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
client.createFunction({ id: "x" }, { event: "x" }, async ({ step }) => {
  return Promise["race"]([
    step.run("one", async () => 1),
    step.run("two", async () => 2),
  ]);
});`,
    "src/functions.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["F11"])
  ));
  assert.equal(computedPositive.entries.filter((entry) => entry.code === "F11").length, 1);

  for (const source of [
    `Promise.race([one(), two()]);`,
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
client.createFunction({ id: "x" }, { event: "x" }, async () => Promise.all([one(), two()]));`,
    `import { Inngest } from "inngest";
const Promise = scheduler;
const client = new Inngest({ id: "demo" });
client.createFunction({ id: "x" }, { event: "x" }, async () => Promise["race"]([one(), two()]));`,
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
const method = "race";
client.createFunction({ id: "x" }, { event: "x" }, async () => Promise[method]([one(), two()]));`,
    `const unrelated = { createFunction(_options, _trigger, handler) { return handler(); } };
unrelated.createFunction({}, {}, async () => Promise.race([one(), two()]));`,
  ]) {
    const negative = collect((entries) => applyInngestV3ToV4(
      source,
      "src/not-an-inngest-race.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["F11"])
    ));
    assert.equal(negative.entries.some((entry) => entry.code === "F11"), false);
  }
});

test("Inngest handler reviews resolve immutable named functions conservatively", () => {
  for (const declaration of [
    `const run = async ({ step }) => {
  await client.send({ name: "demo/one", data: {} });
  return Promise.race([step.run("one", async () => 1), step.run("two", async () => 2)]);
};`,
    `async function run({ step }) {
  client.send({ name: "demo/one", data: {} }).catch(() => undefined);
  return Promise.race([step.run("one", async () => 1), step.run("two", async () => 2)]);
}`,
  ]) {
    const result = collect((entries) => applyInngestV3ToV4(
      `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
${declaration}
client.createFunction({ id: "x" }, { event: "x" }, run);`,
      "src/named-functions.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["F11", "F14"])
    ));
    assert.equal(result.entries.filter((entry) => entry.code === "F11").length, 1);
    assert.equal(result.entries.filter((entry) => entry.code === "F14").length, 1);
  }

  const reusedAndExported = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
const run = async ({ step }) => {
  await client.send({ name: "demo/one", data: {} });
  return Promise["race"]([
    step.run("one", async () => 1),
    step.run("two", async () => 2),
  ]);
};
consume(run);
export { run };
client.createFunction({ id: "x", triggers: { event: "x" } }, run);`,
    "src/reused-named-function.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["F11", "F14"])
  ));
  assert.equal(reusedAndExported.entries.filter((entry) => entry.code === "F11").length, 1);
  assert.equal(reusedAndExported.entries.filter((entry) => entry.code === "F14").length, 1);

  const aliased = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
const run = async ({ step }) => {
  await client.send({ name: "demo/one", data: {} });
  return Promise.race([step.run("one", async () => 1), step.run("two", async () => 2)]);
};
const handler = run;
client.createFunction({ id: "x", triggers: { event: "x" } }, handler);`,
    "src/aliased-named-function.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["F11", "F14"])
  ));
  assert.equal(aliased.entries.filter((entry) => entry.code === "F11").length, 1);
  assert.match(aliased.entries.find((entry) => entry.code === "F11")?.message ?? "", /Promise\.race inside/);
  assert.equal(aliased.entries.filter((entry) => entry.code === "F14").length, 1);
  assert.match(aliased.entries.find((entry) => entry.code === "F14")?.message ?? "", /step\.sendEvent/);

  for (const declaration of [
    `let run = async () => Promise.race([one(), two()]);`,
    `async function run() { return Promise["race"]([one(), two()]); }\nrun = replacement;`,
  ]) {
    const result = collect((entries) => applyInngestV3ToV4(
      `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
${declaration}
client.createFunction({ id: "x" }, { event: "x" }, run);`,
      "src/unsafe-named-functions.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["F11"])
    ));
    assert.equal(result.entries.filter((entry) => entry.code === "F11").length, 1);
    assert.match(result.entries[0]?.message ?? "", /could not be resolved statically/);
  }
});

test("Inngest handler aliases stop after one immutable hop and fail closed otherwise", () => {
  const unresolvedSources = [
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
const run = async () => 1;
let handler = run;
client.createFunction({ id: "x", triggers: { event: "x" } }, handler);`,
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
const run = async () => 1;
const handler = run;
handler = replacement;
client.createFunction({ id: "x", triggers: { event: "x" } }, handler);`,
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
const run = async () => 1;
const first = run;
const handler = first;
client.createFunction({ id: "x", triggers: { event: "x" } }, handler);`,
    `import { Inngest } from "inngest";
import { run } from "./run";
const client = new Inngest({ id: "demo" });
client.createFunction({ id: "x", triggers: { event: "x" } }, run);`,
  ];

  for (const source of unresolvedSources) {
    const result = collect((entries) => applyInngestV3ToV4(
      source,
      "src/unresolved-handler.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["F11", "F14"])
    ));
    for (const code of ["F11", "F14"]) {
      const reviews = result.entries.filter((entry) => entry.code === code);
      assert.equal(reviews.length, 1, `${code} must fail closed for an unresolved handler`);
      assert.match(reviews[0]?.message ?? "", /could not be resolved statically/);
    }
  }

  const inline = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
client.createFunction({ id: "x", triggers: { event: "x" } }, async () => 1);`,
    "src/inline-handler.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["F11", "F14"])
  ));
  assert.equal(inline.entries.some((entry) => ["F11", "F14"].includes(entry.code)), false);
});

test("Inngest F13 is limited to proven serving routes that export an edge runtime", () => {
  for (const runtime of ["edge", "experimental-edge"]) {
    const positive = collect((entries) => applyInngestV3ToV4(
      `import { serve } from "inngest/next";
export const runtime = ${JSON.stringify(runtime)};
export const handler = serve({ client: {}, functions: [] });`,
      "src/app/api/inngest/route.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["F13"])
    ));
    assert.equal(positive.entries.filter((entry) => entry.code === "F13").length, 1);
  }

  const aliased = collect((entries) => applyInngestV3ToV4(
    `import { serve as inngestServe } from "inngest/next";
const serveRoute = inngestServe;
export const runtime = "edge";
export const handler = serveRoute({ client: {}, functions: [] });`,
    "src/app/api/inngest/route.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["F13"])
  ));
  assert.equal(aliased.entries.filter((entry) => entry.code === "F13").length, 1);

  for (const source of [
    `import { serve } from "inngest/next";
export const runtime = "nodejs";
export const handler = serve({ client: {}, functions: [] });`,
    `import { serve } from "./http";
export const runtime = "edge";
export const handler = serve();`,
    `import { serve } from "inngest/next";
const runtime = "edge";
export const handler = serve({ client: {}, functions: [] });`,
    `import { serve } from "inngest/next";
let serveRoute = serve;
export const runtime = "edge";
export const handler = serveRoute({ client: {}, functions: [] });`,
    `import { serve } from "inngest/next";
const first = serve;
const second = first;
export const runtime = "edge";
export const handler = second({ client: {}, functions: [] });`,
    `export const runtime = "edge";
export async function GET() { return new Response("ok"); }`,
  ]) {
    const negative = collect((entries) => applyInngestV3ToV4(
      source,
      "src/app/api/route.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["F13"])
    ));
    assert.equal(negative.entries.some((entry) => entry.code === "F13"), false);
  }
});

test("Inngest F12 uses the optional runtime-container hint", () => {
  const enabled = new Set(["F12"]);
  const unknown = inngestBehavioralReviewEntries(enabled);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]?.code, "F12");
  assert.match(unknown[0]?.message ?? "", /runtime container is unknown/i);

  assert.deepEqual(
    inngestBehavioralReviewEntries(new Set(["F11", "F12", "F13"])).map((entry) => entry.code),
    ["F12"]
  );

  const serverless = inngestBehavioralReviewEntries(enabled, { runtimeContainer: "serverless" });
  assert.equal(serverless.length, 1);
  assert.match(serverless[0]?.message ?? "", /serverless.*maxRuntime/i);

  assert.deepEqual(
    inngestBehavioralReviewEntries(enabled, { runtimeContainer: "long-running" }),
    []
  );
  assert.deepEqual(
    inngestBehavioralReviewEntries(new Set(), { runtimeContainer: "serverless" }),
    []
  );
});

test("Inngest F14 flags every direct handler send and floating outside sends", () => {
  const inHandler = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
const mailer = { send() { return Promise.resolve(); } };
client.createFunction({ id: "x" }, { event: "x" }, async ({ step }) => {
  client.send({ name: "demo/one", data: {} });
  await client.send({ name: "demo/two", data: {} });
  client.send({ name: "demo/three", data: {} }).catch(() => undefined);
  mailer.send();
  return client.send({ name: "demo/four", data: {} });
});`,
    "src/functions.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["F14"])
  ));
  const handlerEntries = inHandler.entries.filter((entry) => entry.code === "F14");
  assert.equal(handlerEntries.length, 4);
  assert.equal(handlerEntries.every((entry) => /step\.sendEvent/.test(entry.message)), true);

  const outsideHandler = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
async function emit() {
  client.send({ name: "demo/one", data: {} });
  client.send({ name: "demo/two", data: {} }).catch(() => undefined);
  client.send({ name: "demo/three", data: {} }).then(() => undefined);
  await client.send({ name: "demo/four", data: {} });
  await client.send({ name: "demo/five", data: {} }).catch(() => undefined);
  return client.send({ name: "demo/six", data: {} }).finally(() => undefined);
}`,
    "src/send.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["F14"])
  ));
  const outsideEntries = outsideHandler.entries.filter((entry) => entry.code === "F14");
  assert.equal(outsideEntries.length, 3);
  assert.equal(outsideEntries.every((entry) => /await or return/.test(entry.message)), true);

  const importedClient = collect((entries) => applyInngestV3ToV4(
    `import { client } from "./client";
void client.send({ name: "demo/one", data: {} });`,
    "src/send.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["F14"]),
    {
      scannedSources: new Map([[
        "src/client.ts",
        `import { Inngest } from "inngest";
export const client = new Inngest({ id: "demo" });`,
      ]]),
      sourcePaths: new Set(["src/send.ts", "src/client.ts"]),
    }
  ));
  assert.equal(importedClient.entries.filter((entry) => entry.code === "F14").length, 1);

  const unrelated = collect((entries) => applyInngestV3ToV4(
    `import { inngest } from "@/inngest/client";
const transport = { send() { return Promise.resolve(); } };
transport.send();
inngest.send({ name: "not-proven", data: {} });`,
    "src/unrelated.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["F14"])
  ));
  assert.equal(unrelated.entries.some((entry) => entry.code === "F14"), false);
});

test("client-named path aliases and re-exports remain blocking review items", () => {
  const pathAlias = collect((entries) => applyInngestV3ToV4(
    `import * as state from "$lib/client";
const key = "createFunction";
state.client[key] = fakeCreateFunction;`,
    "src/mutator.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T1"])
  ));
  assert.equal(pathAlias.entries.some((entry) => entry.kind === "review" && /Path-alias/.test(entry.message)), true);

  const reexports = collect((entries) => applyInngestV3ToV4(
    `export { client as service } from "./state";
export * from "./inngest-client";`,
    "src/barrel.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T1"])
  ));
  assert.equal(reexports.entries.filter((entry) => entry.kind === "review").length, 2);
});

test("type-only Inngest constructors never establish runtime client proof", () => {
  for (const declaration of [
    `import type { Inngest } from "inngest";`,
    `import { type Inngest } from "inngest";`,
  ]) {
    const result = collect((entries) => applyInngestV3ToV4(
      `${declaration}
const client = new Inngest({ id: "demo" });
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
      "src/functions.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["T1"])
    ));
    assert.equal(result.value, null);
    assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
    assert.equal(result.entries.some((entry) => entry.kind === "review"), true);
  }
});

test("aliases, computed loaders, and optional or computed calls fail closed", () => {
  const cases = [
    `import { inngest } from "@/client";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    `const path = "./client";
const { inngest } = await import(path);
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    `client?.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    `client["createFunction"]({ id: "x" }, { event: "x" }, async () => {});`,
  ];
  for (const source of cases) {
    const result = collect((entries) => applyInngestV3ToV4(
      source,
      "src/functions.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["T1"])
    ));
    assert.equal(result.value, null);
    assert.equal(result.entries.some((entry) => entry.code === "T1" && entry.kind === "review"), true);
  }
});

test("static-computed and indirect createFunction invocations require review", () => {
  const result = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
client[\`createFunction\`]({ id: "a" }, { event: "a" }, async () => {});
client["create" + "Function"]({ id: "b" }, { event: "b" }, async () => {});
client.createFunction.call(client, { id: "c" }, { event: "c" }, async () => {});
const create = client.createFunction.bind(client);
create({ id: "d" }, { event: "d" }, async () => {});`,
    "src/functions.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T1"])
  ));
  assert.equal(result.value, null);
  assert.equal(result.entries.some((entry) => entry.kind === "applied"), false);
  assert.equal(result.entries.filter((entry) => entry.code === "T1" && entry.kind === "review").length >= 4, true);
});

test("same-line createFunction transforms retain distinct report entries", () => {
  const result = collect((entries) => applyInngestV3ToV4(
    `import { Inngest } from "inngest";
const client = new Inngest({ id: "demo" });
client.createFunction({ id: "a" }, { event: "a" }, async () => {}); client.createFunction({ id: "b" }, { event: "b" }, async () => {});`,
    "src/functions.ts",
    { push: (entry) => entries.push(entry) },
    new Set(["T1"])
  ));
  assert.ok(result.value);
  assert.equal(result.entries.filter((entry) => entry.code === "T1" && entry.kind === "applied").length, 2);
});

test("one-hop provenance accepts a directly exported local Inngest client", () => {
  const result = localInngestTransform(
    `import { inngest } from "./client";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/inngest/functions.ts",
    {
      "src/inngest/client.ts": `import { Inngest } from "inngest";
export const inngest = new Inngest({ id: "demo" });`,
    }
  );
  assert.ok(result.value);
  assert.match(result.value, /triggers:/);
  assert.equal(result.entries.some((entry) => entry.kind === "review" && /local module/.test(entry.message)), false);
});

test("one-hop provenance supports named constructor, export, and consumer aliases", () => {
  const result = localInngestTransform(
    `import { configured as client } from "./sdk-client";
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    {
      "src/sdk-client.ts": `import { Inngest as Constructor } from "inngest";
const internal = new Constructor({ id: "demo" });
export { internal as configured };`,
    }
  );
  assert.ok(result.value);
  assert.match(result.value, /triggers:/);
  assert.equal(result.entries.filter((entry) => entry.code === "T1" && entry.kind === "applied").length, 1);
});

test("one-hop local provenance preserves lexical shadowing", () => {
  const result = localInngestTransform(
    `import { inngest } from "./client";
function unrelated(inngest: any) {
  return inngest.createFunction({ id: "shadow" }, { event: "shadow" }, async () => {});
}
inngest.createFunction({ id: "real" }, { event: "real" }, async () => {});`,
    "src/functions.ts",
    {
      "src/client.ts": `import { Inngest } from "inngest";
export const inngest = new Inngest({ id: "demo" });`,
    }
  );
  assert.ok(result.value);
  assert.match(result.value, /createFunction\(\{ id: "shadow" \}, \{ event: "shadow" \},/);
  assert.match(result.value, /id: "real",\s*triggers:/);
  assert.equal(result.entries.filter((entry) => entry.code === "T1" && entry.kind === "applied").length, 1);
});

test("unrelated local exports and re-exports remain blocking review items", () => {
  const unrelated = localInngestTransform(
    `import { inngest } from "./client";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    {
      "src/client.ts": `import type { Inngest } from "inngest";
export const inngest = makeClient() as Inngest;`,
    }
  );
  assert.equal(unrelated.value, null);
  assert.match(unrelated.entries[0]?.message ?? "", /local module/);

  const reexport = localInngestTransform(
    `import { inngest } from "./client";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    {
      "src/base.ts": `import { Inngest } from "inngest";
export const inngest = new Inngest({ id: "demo" });`,
      "src/client.ts": `export { inngest } from "./base";`,
    }
  );
  assert.equal(reexport.value, null);
  assert.match(reexport.entries[0]?.message ?? "", /local module/);
});

test("type-only local exports never prove a runtime Inngest client", () => {
  const consumer = `import { inngest } from "./client";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`;
  for (const exportStatement of ["export type { inngest };", "export { type inngest };"]) {
    const result = localInngestTransform(consumer, "src/functions.ts", {
      "src/client.ts": `import { Inngest } from "inngest";
const inngest = new Inngest({ id: "demo" });
${exportStatement}`,
    });
    assert.equal(result.value, null);
    assert.match(result.entries[0]?.message ?? "", /local module/);
  }
});

test("ambiguous local resolution and wrapper-of-wrapper provenance are rejected", () => {
  const consumer = `import { inngest } from "./client";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`;
  const direct = `import { Inngest } from "inngest";
export const inngest = new Inngest({ id: "demo" });`;
  const ambiguous = localInngestTransform(consumer, "src/functions.ts", {
    "src/client.ts": direct,
    "src/client.js": direct,
  });
  assert.equal(ambiguous.value, null);
  assert.match(ambiguous.entries[0]?.message ?? "", /local module/);

  const wrapped = localInngestTransform(consumer, "src/functions.ts", {
    "src/base.ts": direct,
    "src/client.ts": `import { inngest as inner } from "./base";
export { inner as inngest };`,
  });
  assert.equal(wrapped.value, null);
  assert.match(wrapped.entries[0]?.message ?? "", /local module/);
});

test("directory index modules are not proven without validating package resolution metadata", () => {
  const result = localInngestTransform(
    `import { client } from "./sdk";
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    {
      "src/sdk/index.ts": `import { Inngest } from "inngest";
export const client = new Inngest({ id: "demo" });`,
    }
  );
  assert.equal(result.value, null);
  assert.match(result.entries[0]?.message ?? "", /local module/);
});

test("unscanned sibling candidates and explicit extensions prevent local-client proof", () => {
  const direct = `import { Inngest } from "inngest";
export const client = new Inngest({ id: "demo" });`;
  const shadowed = localInngestTransform(
    `import { client } from "./client";
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    { "src/client.js": direct },
    ["src/client.ts", "src/client.js"]
  );
  assert.equal(shadowed.value, null);
  assert.match(shadowed.entries[0]?.message ?? "", /local module/);

  const explicit = localInngestTransform(
    `import { client } from "./client.js";
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    "src/functions.ts",
    { "src/client.js": direct },
    ["src/client.js"]
  );
  assert.equal(explicit.value, null);
  assert.match(explicit.entries[0]?.message ?? "", /local module/);
});

test("one-hop provenance rejects path escapes and non-named module forms", () => {
  const cases = [
    {
      consumer: `import { inngest } from "../../outside";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
      files: { "outside.ts": `import { Inngest } from "inngest"; export const inngest = new Inngest({ id: "x" });` },
    },
    {
      consumer: `import inngest from "./client";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
      files: { "src/client.ts": `import { Inngest } from "inngest"; export default new Inngest({ id: "x" });` },
    },
    {
      consumer: `import { inngest } from "./client";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
      files: { "src/client.ts": `const { Inngest } = require("inngest"); exports.inngest = new Inngest({ id: "x" });` },
    },
    {
      consumer: `import { inngest } from "./client";
inngest.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
      files: { "src/client.ts": `const { Inngest } = await import("inngest"); export const inngest = new Inngest({ id: "x" });` },
    },
  ];
  for (const item of cases) {
    const result = localInngestTransform(item.consumer, "src/functions.ts", item.files);
    assert.equal(result.value, null);
    assert.match(result.entries[0]?.message ?? "", /local module/);
  }
});

test("unsupported local consumer loaders and namespaces remain blocking review items", () => {
  const cases = [
    `const { client } = require("./client");
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    `const { client } = await import("./client");
client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    `import * as sdk from "./client";
sdk.client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    `import sdk = require("./client");
sdk.client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    `require("./client").client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
    `(await import("./client")).client.createFunction({ id: "x" }, { event: "x" }, async () => {});`,
  ];
  const scannedSources = {
    "src/client.ts": `import { Inngest } from "inngest";
export const client = new Inngest({ id: "demo" });`,
  };
  for (const source of cases) {
    const result = localInngestTransform(source, "src/functions.ts", scannedSources);
    assert.equal(result.value, null);
    assert.equal(result.entries.some((entry) => entry.code === "T1" && entry.kind === "review"), true);
    assert.match(result.entries[0]?.message ?? "", /local module/);
  }
});

test("CommonJS and dynamic SDK loading emit blockers without rewriting", () => {
  const commonJs = collect((entries) =>
    applyKnockV0ToV1(
      `const { Knock } = require("@knocklabs/node");
const knock = new Knock(process.env.KEY);
knock.notify("welcome");`,
      "worker.cjs",
      { push: (entry) => entries.push(entry) },
      new Set()
    )
  );
  assert.equal(commonJs.value, null);
  assert.equal(commonJs.entries.some((entry) => entry.kind === "applied"), false);
  assert.equal(commonJs.entries.some((entry) => entry.kind === "review"), true);

  const dynamic = collect((entries) =>
    applyInngestV3ToV4(
      `const sdk = await import("inngest");`,
      "worker.mjs",
      { push: (entry) => entries.push(entry) },
      new Set()
    )
  );
  assert.equal(dynamic.value, null);
  assert.equal(dynamic.entries.some((entry) => entry.kind === "review"), true);
});

test("Inngest config transforms only direct known options", () => {
  const source = `import { Inngest } from "inngest";
const client = new Inngest({
  metadata: { serveHost: "leave", streaming: "custom" },
  serveHost: "change",
  streaming: "force"
});`;
  const result = collect((entries) =>
    applyInngestV3ToV4(
      source,
      "config.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["T2", "T3"])
    )
  );
  assert.ok(result.value);
  assert.match(result.value, /metadata: \{ serveHost: "leave", streaming: "custom" \}/);
  assert.match(result.value, /serveOrigin: "change"/);
  assert.match(result.value, /streaming: true/);

  const unknown = collect((entries) =>
    applyInngestV3ToV4(
      `import { Inngest } from "inngest";
new Inngest({ streaming: "custom" });`,
      "config.ts",
      { push: (entry) => entries.push(entry) },
      new Set(["T3"])
    )
  );
  assert.equal(unknown.value, null);
  assert.equal(unknown.entries[0]?.kind, "review");
  assert.match(unknown.entries[0]?.message ?? "", /cannot be mapped safely/);
});

function localInngestTransform(
  source: string,
  filePath: string,
  scannedSources: Record<string, string>,
  sourcePaths: readonly string[] = Object.keys(scannedSources)
): { value: string | null; entries: ReportEntry[] } {
  return collect((entries) => applyInngestV3ToV4(
    source,
    filePath,
    { push: (entry) => entries.push(entry) },
    new Set(["T1"]),
    {
      scannedSources: new Map(Object.entries(scannedSources)),
      sourcePaths: new Set(sourcePaths),
    }
  ));
}
