import assert from "node:assert/strict";
import test from "node:test";
import { TRANSFORM_ALLOWLIST } from "@api-migrator/engine";
import { renderBrief, ruleGuidance, validateSummary } from "./brief.mjs";

const summary = {
  version: 1,
  recipe: "knock-v0-to-v1",
  sourceFiles: 6,
  matchedFiles: 3,
  wouldChangeFiles: 2,
  findings: [
    { kind: "review", code: "K1", count: 1 },
    { kind: "review", code: "KF6", count: 3 },
    { kind: "applied", code: "K1", count: 2 },
    { kind: "review", code: "KF1", count: 2 },
  ],
};

test("shared summary rejects private text, unknown fields and cross-recipe rule IDs", () => {
  for (const input of [
    { ...summary, path: "sensitive-customer.ts" },
    { ...summary, recipe: "constructor" },
    { ...summary, sourceFiles: 10_001 },
    { ...summary, findings: [{ kind: "review", code: "F2", count: 1 }] },
    { ...summary, findings: [{ kind: "review", code: "KF1", count: 1, message: "sensitive-customer.ts" }] },
    { ...summary, findings: [{ kind: "sensitive-customer.ts", code: "KF1", count: 1 }] },
  ]) assert.throws(() => validateSummary(input), err => !err.message.includes("sensitive-customer.ts"));

  for (const [recipe, codes] of Object.entries(TRANSFORM_ALLOWLIST)) {
    for (const code of codes) assert.ok(ruleGuidance(recipe, code).length > 10);
  }
  assert.throws(() => ruleGuidance("knock-v0-to-v1", "toString"));
});

test("rejects impossible counts, kinds, and duplicate groups", () => {
  const edit = summary.findings[2];
  for (const overrides of [
    { matchedFiles: 7 },
    { matchedFiles: 0, wouldChangeFiles: 0 },
    { wouldChangeFiles: 0 },
    { wouldChangeFiles: 3 },
    { sourceFiles: Infinity },
    { sourceFiles: 1_000_000_000 },
    { findings: [{ ...edit, count: -1 }] },
    { findings: [{ ...edit, count: 1.5 }] },
    { findings: [{ ...edit, code: "KF6" }] },
    { findings: [edit, edit] },
  ]) assert.throws(() => validateSummary({ ...summary, ...overrides }));
});

test("brief retains preview and manual findings for the same rule while prioritizing reviews", () => {
  const report = renderBrief(summary, ["KF6"]);
  const [manual, edits] = report.split("## Proposed edits");
  assert.ok(manual.indexOf("| KF6 |") < manual.indexOf("| K1 |"));
  assert.match(manual, /\| K1 \| 1 \|/);
  assert.match(manual, /\| KF1 \| 2 \|/);
  assert.match(edits, /\| K1 \| 2 \|/);
  assert.match(manual, /Files with proposed edits \| 2/);
  assert.match(report, /runtime behavior require separate verification/);
  assert.deepEqual(validateSummary(summary), validateSummary({ ...summary, findings: [...summary.findings].reverse() }));
  for (const invalidOrder of [["T1"], ["KF1", "KF1"], ["untrusted text"]]) {
    assert.throws(() => renderBrief(summary, invalidOrder));
  }
});

test("empty scans produce an explicit assessment and keep the verification boundary", () => {
  const report = renderBrief({ ...summary, sourceFiles: 0, matchedFiles: 0, wouldChangeFiles: 0, findings: [] });
  assert.match(report, /zero manual-review findings/);
  assert.match(report, /zero source edits/);
  assert.match(report, /simulated/);
});

test("Inngest summaries with matches include one deployment review for the repository", () => {
  const base = { ...summary, recipe: "inngest-v3-to-v4", wouldChangeFiles: 0, findings: [] };
  const review = { code: "F12", kind: "review", count: 1 };
  assert.throws(() => validateSummary(base), /deployment review/);
  assert.throws(() => validateSummary({ ...base, findings: [{ ...review, count: 2 }] }), /deployment review/);
  assert.deepEqual(validateSummary({ ...base, findings: [review] }).findings, [review]);
  assert.deepEqual(validateSummary({ ...base, matchedFiles: 0 }).findings, []);
});
