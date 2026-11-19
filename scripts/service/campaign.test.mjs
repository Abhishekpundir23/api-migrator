import assert from "node:assert/strict";
import test from "node:test";
import { renderCampaign } from "./campaign.mjs";

const first = {
  version: 1, recipe: "knock-v0-to-v1", sourceFiles: 8, matchedFiles: 4, wouldChangeFiles: 3,
  findings: [
    { code: "K1", kind: "applied", count: 5 },
    { code: "KF2", kind: "review", count: 12 },
    { code: "K1", kind: "review", count: 2 },
  ],
};
const second = {
  ...first, sourceFiles: 2, matchedFiles: 1, wouldChangeFiles: 0,
  findings: [{ code: "K1", kind: "review", count: 1 }],
};
const noFindings = { ...second, matchedFiles: 0, findings: [] };

test("campaign measures per-repository breadth separately from repeated findings and preserves edit/review overlap", () => {
  const rendered = renderCampaign([first, second, noFindings]);
  assert.match(rendered, /3 assessments covering 12 source files.*matched 5 files and proposed edits to 3 files/);
  assert.match(rendered, /Any match or recipe finding \| 2/);
  assert.match(rendered, /At least one proposed edit \| 1/);
  assert.match(rendered, /At least one manual review finding \| 2/);
  const [review, edit] = rendered.split("## Proposed edits across repositories");
  const commonRule = review.indexOf("| K1 | 2 | 3 |");
  assert.ok(commonRule >= 0);
  assert.ok(review.indexOf("| KF2 | 1 | 12 |") > commonRule);
  assert.match(edit, /\| K1 \| 1 \| 5 \|/);
  assert.equal(renderCampaign([noFindings, second, first]), rendered);
});

test("an empty scan remains visible in the campaign totals", () => {
  const rendered = renderCampaign([noFindings]);
  assert.match(rendered, /At least one manual review finding \| 0/);
  assert.match(rendered, /No findings of this kind were reported/);
  assert.match(rendered, /one current summary per distinct repository/);
});

test("campaign rejects mixed recipes and unvalidated or excessive handoffs", () => {
  for (const input of [
    [], null, Array(101).fill(first),
    [first, { ...noFindings, recipe: "inngest-v3-to-v4" }],
    [first, { ...first, customerName: "private-value" }],
    [first, { ...first, sourceFiles: -1 }],
  ]) assert.throws(() => renderCampaign(input), error => !error.message.includes("private-value"));
});
