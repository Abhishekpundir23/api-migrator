import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { suggestReviewPlan } from "./openai.mjs";

const summary = {
  version: 1, recipe: "inngest-v3-to-v4", sourceFiles: 4, matchedFiles: 3, wouldChangeFiles: 1,
  findings: [{ code: "T2", kind: "applied", count: 1 },
    { code: "F2", kind: "review", count: 2 }, { code: "F12", kind: "review", count: 1 }],
};
const questions = [
  { code: "F12", question: "Which deployment runtime sets the timeout?" },
  { code: "F2", question: "Do event producers and handlers agree on the location of user data?" },
];
const message = content => ({
  status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content }],
});
const success = list => message([{ type: "output_text", text: JSON.stringify({ questions: list }) }]);

async function isolated(t, cap = "100") {
  const ledgerRoot = await mkdtemp(join(tmpdir(), "migrator-api-test-"));
  const keys = ["OPENAI_API_KEY", "API_MIGRATOR_AI_MAX_CALLS", "API_MIGRATOR_AI_MODEL", "XDG_CONFIG_HOME"];
  const saved = keys.map(key => process.env[key]);
  process.env.XDG_CONFIG_HOME = ledgerRoot;
  delete process.env.API_MIGRATOR_AI_MODEL;
  process.env.OPENAI_API_KEY = "fixture-key-do-not-log";
  process.env.API_MIGRATOR_AI_MAX_CALLS = cap;
  t.after(async () => {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    await rm(ledgerRoot, { force: true, recursive: true });
  });
  return ledgerRoot;
}

test("sends only project aggregates for observed review rules and returns a complete advisory order", async t => {
  const ledgerRoot = await isolated(t);
  const transport = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer fixture-key-do-not-log");
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.model, "gpt-6.2-sol");
    assert.equal(body.reasoning.effort, "low");
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.type, "json_schema");
    const { recipe, review } = JSON.parse(body.input);
    assert.equal(recipe, summary.recipe);
    assert.deepEqual(review.map(({ code, count }) => [code,count]), [["F2",2],["F12",1]]);
    assert.ok(review.every(r => typeof r.guidance === "string"));
    assert.doesNotMatch(body.input, /sourceFiles|T2|fixture-key/);
    return Response.json(success(questions));
  };
  const result = await suggestReviewPlan(summary, { ledgerRoot, fetchImpl: transport });
  assert.deepEqual(result, { order: ["F12", "F2"], questions });
});

test("private fields and unknown rule IDs fail before transport; zero reviews require no key or reservation", async t => {
  const ledgerRoot = await isolated(t);
  delete process.env.OPENAI_API_KEY;
  let requests = 0;
  const opts = { ledgerRoot, fetchImpl: () => { requests++; } };
  for (const invalid of [
    { ...summary, privateText: "CUSTOMER-SOURCE" },
    { ...summary, findings: [{ code: "CUSTOMER-SOURCE", kind: "review", count: 1 }] },
    { ...summary, findings: [{ ...summary.findings[1], file: "CUSTOMER-SOURCE" }] },
  ]) {
    await assert.rejects(suggestReviewPlan(invalid, opts), err => !err.message.includes("CUSTOMER-SOURCE"));
  }
  await assert.rejects(suggestReviewPlan(summary, opts), /OPENAI_API_KEY/);
  assert.deepEqual(await suggestReviewPlan({ ...summary, recipe: "knock-v0-to-v1", findings: [{ code: "K1", kind: "applied", count: 1 }] }, opts), {
    order: [], questions: [],
  });
  assert.deepEqual(await readdir(ledgerRoot), []);
  assert.equal(requests, 0);
});

test("a failed call still consumes its slot and parallel operators cannot both reserve the last slot", async t => {
  const ledgerRoot = await isolated(t, "1");
  let calls = 0;
  const opts = { ledgerRoot, fetchImpl: async () => {
    calls++;
    throw new Error("fixture-key-do-not-log");
  } };
  const outcomes = await Promise.allSettled([suggestReviewPlan(summary, opts), suggestReviewPlan(summary, opts)]);
  assert.equal(calls, 1);
  assert.ok(outcomes.every(result => result.status === "rejected" && !result.reason.message.includes("fixture-key")));
  assert.ok(outcomes.some(result => /limit reached/.test(result.reason.message)));
  await assert.rejects(suggestReviewPlan(summary, opts), /limit reached/);
  assert.equal(calls, 1);
});

test("rejects incomplete, refused, duplicate, unexpected, and unsafe suggestions without reflecting model text", async t => {
  const ledgerRoot = await isolated(t);
  for (const data of [
    { ...success(questions), status: "incomplete" },
    message([{ type: "refusal", refusal: "UNTRUSTED" }]),
    success([questions[0]]),
    success([questions[0], questions[0]]),
    success([questions[0], { ...questions[1], code: "T2" }]),
    success([questions[0], { ...questions[1], question: "Review https://UNTRUSTED.com?" }]),
    success([questions[0], { ...questions[1], question: "Use this?\n" }]),
  ]) {
    await assert.rejects(suggestReviewPlan(summary, {
      ledgerRoot, fetchImpl: async () => Response.json(data),
    }), /did not return a complete review plan/);
  }
  await assert.rejects(suggestReviewPlan(summary, {
    ledgerRoot, fetchImpl: async () => new Response("UNTRUSTED", { status: 429 }),
  }), /HTTP 429/);
});
