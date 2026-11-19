import assert from "node:assert/strict";
import test from "node:test";
import { applyKnockV0ToV1, type ReportEntry } from "../src/index.js";

function migrate(source: string, rules?: string[]) {
  const entries: ReportEntry[] = [];
  const result = applyKnockV0ToV1(source, "tokens.tsx", entries, rules && new Set(rules));
  return { source: result ?? source, changed: result !== null, entries };
}

test("K4 replaces a helper-only Knock class and relocates the Grants import", () => {
  const result = migrate(`"use server";
import { Knock as SDK } from "@knocklabs/node";
import { Grants as Access } from "@knocklabs/node/dist/src/common/userTokens";
export async function token(id: string) {
  return await SDK.signUserToken(id, { grants: [SDK.buildUserTokenGrant(entity, [Access.ChannelDataRead])] });
}`);
  assert.match(result.source, /import \{ buildUserTokenGrant, signUserToken \} from "@knocklabs\/node\/lib\/tokenSigner"/);
  assert.match(result.source, /import \{ Grants as Access \} from "@knocklabs\/node\/lib\/userTokens"/);
  assert.match(result.source, /return await signUserToken\(id, \{ grants: \[buildUserTokenGrant\(entity, \[Access.ChannelDataRead\]\)\] \}\)/);
  assert.doesNotMatch(result.source, /\bSDK\b|"@knocklabs\/node"/);
  assert.deepEqual(result.entries.map(e => e.code), ["K4", "K4", "K4"]);
  assert.deepEqual(migrate(result.source).entries, []);
});

test("K4 preserves constructor, unrelated imports and shadowed static calls", () => {
  const result = migrate(`import { Knock as SDK, type Other } from "@knocklabs/node";
const api = new SDK("demo");
export function local(SDK: any) { return SDK.signUserToken("local"); }
export const issue = () => SDK.signUserToken("real");
api.users.identify("id", {});`);
  assert.match(result.source, /import SDK, \{ type Other \} from "@knocklabs\/node"/);
  assert.match(result.source, /return SDK\.signUserToken\("local"\)/);
  assert.match(result.source, /=> signUserToken\("real"\)/);
  assert.match(result.source, /new SDK\(\{\s*apiKey: "demo"/);
  assert.match(result.source, /api\.users\.update/);
  assert.deepEqual(result.entries.filter(e => e.kind === "review"), []);
  assert.deepEqual(migrate(result.source).entries, []);
});

test("K4 reuses compatible named imports and allocates aliases for shadowed or occupied names", () => {
  const reused = migrate(`import Knock from "@knocklabs/node";
import { signUserToken as sign } from "@knocklabs/node/lib/tokenSigner";
sign("first");
Knock.signUserToken("second");`);
  assert.equal(reused.source.match(/from "@knocklabs\/node\/lib\/tokenSigner"/g)?.length, 1);
  assert.match(reused.source, /sign\("second"\)/);
  assert.doesNotMatch(reused.source, /import Knock/);
  const shadowed = migrate(`import { Knock } from "@knocklabs/node";
import { signUserToken } from "@knocklabs/node/lib/tokenSigner";
const knockSignUserToken = 1;
export function token(signUserToken: any) { return [Knock.signUserToken("mine"), signUserToken("local")]; }`);
  assert.match(shadowed.source, /signUserToken as knockSignUserToken1/);
  assert.match(shadowed.source, /\[knockSignUserToken1\("mine"\), signUserToken\("local"\)\]/);
  assert.deepEqual(migrate(shadowed.source).entries, []);
});

test("K4 keeps a required class type and does not capture a free helper name", () => {
  const result = migrate(`import { Knock } from "@knocklabs/node";
type R = Knock.Recipients.RecipientRequest;
const free = signUserToken;
const token = Knock.signUserToken("mine");`);
  assert.match(result.source, /import Knock from "@knocklabs\/node"/);
  assert.match(result.source, /signUserToken as knockSignUserToken/);
  assert.match(result.source, /const free = signUserToken/);
  assert.match(result.source, /const token = knockSignUserToken\("mine"\)/);
});

test("KF3 leaves indirect, mutable and competing references for review", () => {
  for (const body of [
    "Knock.signUserToken = replacement; Knock.signUserToken(id);",
    "Knock['signUserToken'](id);",
    "Knock.signUserToken?.(id);",
    "const sign = Knock.signUserToken;",
    "Object.assign(Knock, patch); Knock.signUserToken(id);",
    "import * as SDK from '@knocklabs/node'; SDK.Knock.signUserToken = replacement; Knock.signUserToken(id);",
    "import * as SDK from '@knocklabs/node'; Object.assign(SDK.Knock.prototype, patch); const c = new Knock('key'); c.users.identify(id, {}); Knock.signUserToken(id);",
    "const element = <Knock/>; Knock.signUserToken(id);",
  ]) {
    const result = migrate(`import { Knock } from "@knocklabs/node";\n${body}`);
    assert.equal(result.changed, false, body);
    assert.ok(result.entries.some(e => e.kind === "review" && e.code === "KF3"), body);
  }
  const unknown = migrate(`import { Grants, Custom } from "@knocklabs/node/dist/src/common/userTokens";`);
  assert.equal(unknown.changed, false);
  assert.deepEqual(unknown.entries.map(e => [e.kind, e.code]), [["review", "KF3"]]);
});

test("token rules run selectively and skip unrelated or current SDK bindings", () => {
  const source = `import { Knock } from "@knocklabs/node";
import type { Grants } from "@knocklabs/node/dist/src/common/userTokens";
Knock.signUserToken(id);`;
  assert.deepEqual(migrate(source, ["K2"]).entries, []);
  const review = migrate(source, ["KF3"]);
  assert.equal(review.changed, false);
  assert.deepEqual(review.entries.map(e => [e.code, e.kind, e.line]), [["KF3", "review", 3], ["KF3", "review", 2]]);
  const applied = migrate(source, ["K4"]);
  assert.ok(applied.entries.every(e => e.code === "K4" && e.kind === "applied"));
  assert.match(applied.source, /import type \{ Grants \} from "@knocklabs\/node\/lib\/userTokens"/);
  for (const unrelated of [
    `import { Knock } from "other"; Knock.signUserToken(id);`,
    `import { signUserToken } from "@knocklabs/node/lib/tokenSigner"; signUserToken(id);`,
  ]) {
    assert.deepEqual(migrate(unrelated).entries, []);
  }
});
