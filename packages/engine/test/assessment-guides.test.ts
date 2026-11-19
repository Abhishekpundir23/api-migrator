import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assessRepository } from "../src/assessment.js";
import type { ReportEntry } from "../src/types.js";

test("the owner report locates legacy JS/TS guide examples and keeps their paths private", t => {
  const root = mkdtempSync(join(tmpdir(), "assessment-guides-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"));
  const legacy = "inngest.createFunction({ id: 'x' }, [{ cron: '* * * * *' }], handler);";
  const md = ["# Job guide", "", "~~~typescript", legacy, "~~~", "text", "```json", legacy, "```",
    "```js", "inngest.createFunction({ triggers: [{ event: 'x' }] }, handler);",
    "function unrelated(inngest) { " + legacy + " }",
    "other.createFunction({ id: 'x' }, { event: 'x' }, handler);", "// " + legacy, "```",
    "````md", "```typescript", legacy, "```", "````", "```js", "const incomplete = " + legacy + " {", "```"].join("\n");
  writeFileSync(join(root, "docs/private-name.md"), md);
  symlinkSync("private-name.md", join(root, "docs/linked.md"));
  writeFileSync(join(root, "client.ts"), 'import { Inngest } from "inngest"; export const app = new Inngest({ id: "app" });');
  const entries: ReportEntry[] = [];
  const report = assessRepository(root, "inngest-v3-to-v4", entry => entries.push(entry));
  assert.deepEqual(entries.filter(e => e.code === "F17").map(e => [e.file, e.line, e.kind]), [["docs/private-name.md", 4, "review"]]);
  assert.equal(report.sourceFiles, 1);
  assert.doesNotMatch(JSON.stringify(report), /private-name/);
  assert.deepEqual(assessRepository(root, "knock-v0-to-v1").findings, []);
  writeFileSync(join(root, "client.ts"), "export const x = 1;");
  assert.deepEqual(assessRepository(root, "inngest-v3-to-v4").findings, []);
});
