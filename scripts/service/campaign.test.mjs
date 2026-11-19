import assert from "node:assert/strict";
import test from "node:test";
import { renderCampaign, renderTrackedCampaign } from "./campaign.mjs";

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

const roster = { recipe: first.recipe, repositories: [
  { alias: "Pilot A", summary: "a.json" }, { alias: "Pilot B", summary: "b.json" },
] };

test("tracked campaign keeps pending repositories distinct from received assessments with zero findings", () => {
  const empty = renderTrackedCampaign(new Map(), roster);
  assert.match(empty, /0 of 2 invited repositories submitted/);
  const result = renderTrackedCampaign(new Map([["b.json", noFindings]]), roster);
  assert.match(result, /1 of 2 invited repositories submitted/);
  assert.match(result, /Pilot A \| Awaiting assessment \| — \| —/);
  assert.match(result, /Pilot B \| Received \| 0 \| None reported/);
  const noSourceFiles = renderTrackedCampaign(new Map([["a.json", { ...noFindings, sourceFiles: 0 }]]), roster);
  assert.match(noSourceFiles, /Pilot A \| Received, no supported files/);
  assert.doesNotMatch(result, /a\.json|b\.json/);
  const full = renderTrackedCampaign(new Map([["a.json", first], ["b.json", second]]), roster);
  assert.match(full, /Pilot A \| Received \| 3 \| K1, KF2/);
  assert.match(full, /Any match or recipe finding \| 2/);
});

test("roster rejects unmatched submissions, mixed releases, unsafe labels, paths and ambiguous assignments", () => {
  const withEntry = entry => ({ ...roster, repositories: [roster.repositories[0], entry] });
  for (const invalid of [
    withEntry({ alias: "pilot a", summary: "new.json" }), withEntry({ alias: "New", summary: "A.json" }),
    withEntry({ alias: "New | status", summary: "b.json" }), withEntry({ alias: "New", summary: "../b.json" }),
    withEntry({ alias: "New", summary: "b.json", path: "private" }), { ...roster, recipe: "toString" },
  ]) assert.throws(() => renderTrackedCampaign(new Map(), invalid));
  assert.throws(() => renderTrackedCampaign(new Map([["A.json", first]]), roster), /does not match/);
  assert.throws(() => renderTrackedCampaign(new Map([["a.json", { ...noFindings, recipe: "inngest-v3-to-v4" }]]), roster), /same SDK/);
  assert.throws(() => renderTrackedCampaign(new Map([["a.json", { ...first, source: "private" }]]), roster));
});
