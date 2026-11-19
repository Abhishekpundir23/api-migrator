import { constants, closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runAssessment } from "./assess-command.mjs";
import { required, outputPath, writeNewFiles } from "./cli-io.mjs";
import { renderCampaign, renderTrackedCampaign } from "./campaign.mjs";
import { renderBrief, validateSummary } from "./brief.mjs";
import { suggestReviewPlan } from "./openai.mjs";

const usage = `SDK migration assessment
  service assess --recipe <inngest-v3-to-v4|knock-v0-to-v1> --repo DIR --out SUMMARY.json [--local-report PRIVATE.json]
  service brief --summary SUMMARY.json --out BRIEF.md [--ai]
  service campaign --summaries DIR [--roster ROSTER.json] --out CAMPAIGN.md

Run assess on the owner's machine. Only SUMMARY.json belongs in the handoff.
Choose new output files in an existing directory outside the assessed repository.
The optional AI review plan uses OPENAI_API_KEY. The default brief runs offline.`;

function readJson(path) {
  const limit = 65536;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Expected a regular JSON file of at most 64 KiB.");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > limit) throw new Error("Input exceeds 64 KiB.");
    try { return JSON.parse(bytes.toString("utf8", 0, length)); }
    catch { throw new Error("Invalid JSON input."); }
  } finally { closeSync(fd); }
}

async function main([command, ...args]) {
  if (command === "--help" || args.includes("--help")) { console.log(usage); return; }
  if (command === "assess") return runAssessment(args);
  if (command === "campaign") {
    const { values } = parseArgs({ args, options: { summaries: { type: "string" }, out: { type: "string" }, roster: { type: "string" } } });
    const dir = required(values, "summaries");
    const entries = readdirSync(dir, { withFileTypes: true }).filter(e => e.name.endsWith(".json"));
    if (entries.length > 100 || entries.some(e => !e.isFile()))
      throw new Error("Use a directory with at most 100 regular JSON summaries.");
    const submissions = new Map(entries.map(entry => [entry.name, readJson(join(dir, entry.name))]));
    const campaign = values.roster === undefined ? renderCampaign([...submissions.values()])
      : renderTrackedCampaign(submissions, readJson(required(values, "roster")));
    await writeNewFiles([outputPath(required(values, "out"))], () => [campaign.trimEnd() + "\n"]);
    console.log("Wrote the campaign assessment brief.");
    return;
  }
  if (command === "brief") {
    const { values } = parseArgs({ args, options: { summary: { type: "string" }, out: { type: "string" }, ai: { type: "boolean" } } });
    const summary = validateSummary(readJson(required(values, "summary")));
    const path = outputPath(required(values, "out"));
    await writeNewFiles([path], async () => {
      let plan = { order: [], questions: [] };
      let fallback = false;
      if (values.ai) {
        try { plan = await suggestReviewPlan(summary); }
        catch (error) {
          console.error(`Optional review plan unavailable: ${error.message}. Wrote the offline brief.`);
          process.exitCode = 2;
          fallback = true;
        }
      }
      let report = renderBrief(summary, plan.order).trimEnd() + "\n";
      if (plan.questions.length) {
        report += "\n## Suggested reviewer questions\n\nDrafted with OpenAI from aggregate rule counts. Check each question against the local findings.\n\n";
        for (const { code, question } of plan.questions) report += `- **${code}** ${question}\n`;
      }
      if (fallback) report += "\nThe optional OpenAI review plan was unavailable. This brief uses the source rules.\n";
      return [report];
    });
    console.log("Wrote the migration assessment brief.");
    return;
  }
  throw new Error(usage);
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : "Assessment failed.");
  process.exitCode = 1;
});
