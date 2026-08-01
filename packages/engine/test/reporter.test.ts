import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, reportToMarkdown } from "../src/index.js";

test("report includes provider notes without overstating verification", () => {
  const report = buildReport(
    {
      name: "Inngest v4",
      provider: "inngest",
      notes: "Confirm event payload compatibility with the provider guide.",
    },
    ["src/functions.ts"],
    ["src/functions.ts"],
    [],
    {
      ok: false,
      baseline: [],
      after: [],
      introduced: [],
      skipped: false,
      runner: "docker",
      checks: {
        install: { status: "passed", command: "npm ci", exitCode: 0, output: "" },
        typecheck: { status: "failed", command: "npm run typecheck", exitCode: 1, output: "type error" },
        test: { status: "skipped", command: null, exitCode: null, output: "", reason: "typecheck failed" },
        lint: { status: "skipped", command: null, exitCode: null, output: "", reason: "typecheck failed" },
      },
    }
  );

  const markdown = reportToMarkdown(report);
  assert.match(markdown, /### Provider migration notes/);
  assert.match(markdown, /Confirm event payload compatibility/);
  assert.match(markdown, /Verification: \*\*failed\*\*/);
  assert.match(markdown, /No manual-review items were reported/);
  assert.doesNotMatch(markdown, /all changes are deterministic/);
});
