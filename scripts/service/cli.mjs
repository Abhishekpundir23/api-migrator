import { constants, closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { assessRepository, TRANSFORM_ALLOWLIST } from "@api-migrator/engine";
import { renderCampaign } from "./campaign.mjs";
import { renderBrief, validateSummary } from "./brief.mjs";
import { suggestReviewPlan } from "./openai.mjs";

const usage = `SDK migration assessment
  service assess --recipe <inngest-v3-to-v4|knock-v0-to-v1> --repo DIR --out SUMMARY.json [--local-report PRIVATE.json]
  service brief --summary SUMMARY.json --out BRIEF.md [--ai]
  service campaign --summaries DIR --out CAMPAIGN.md

Run assess on the owner's machine. Only SUMMARY.json belongs in the handoff.
Choose new output files in an existing directory outside the assessed repository.
The optional AI review plan uses OPENAI_API_KEY. The default brief runs offline.`;

function required(values, key) {
  if (!values[key]?.trim()) throw new Error(`Missing --${key}. Use --help for usage.`);
  return values[key];
}

function outputPath(path, root) {
  const target = join(realpathSync(dirname(resolve(path))), basename(path));
  if (root) {
    const rel = relative(root, target);
    if (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))
      throw new Error("Choose an output directory outside the assessed repository.");
  }
  return target;
}

// Reserve all requested outputs before writing any of them or sending an API request.
async function writeNewFiles(paths, produce) {
  const opened = [];
  try {
    for (const path of paths) opened.push({ path, fd: openSync(path, "wx", 0o600) });
    const documents = await produce();
    for (let i = 0; i < documents.length; i++) writeFileSync(opened[i].fd, documents[i], "utf8");
  } catch (error) {
    for (const { path } of opened) unlinkSync(path);
    throw error;
  } finally {
    for (const { fd } of opened) closeSync(fd);
  }
}

function readSummary(path) {
  const limit = 65536;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Expected a regular summary file of at most 64 KiB.");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > limit) throw new Error("Summary exceeds 64 KiB.");
    let input;
    try { input = JSON.parse(bytes.toString("utf8", 0, length)); }
    catch { throw new Error("Invalid summary JSON. Supply the aggregate assessment export."); }
    return validateSummary(input);
  } finally { closeSync(fd); }
}

async function main([command, ...args]) {
  if (command === "--help" || args.includes("--help")) { console.log(usage); return; }
  if (command === "assess") {
    const { values } = parseArgs({ args, options: { recipe: { type: "string" }, repo: { type: "string" }, out: { type: "string" }, "local-report": { type: "string" } } });
    const recipe = required(values, "recipe");
    if (!Object.hasOwn(TRANSFORM_ALLOWLIST, recipe)) throw new Error("Unsupported recipe. See --help.");
    const root = realpathSync(required(values, "repo"));
    const paths = [outputPath(required(values, "out"), root)];
    if (values["local-report"] !== undefined) paths.push(outputPath(required(values, "local-report"), root));
    await writeNewFiles(paths, () => {
      const details = [];
      const summary = validateSummary(assessRepository(root, recipe, paths.length === 2 ? entry => details.push(entry) : undefined));
      const docs = [JSON.stringify(summary, null, 2) + "\n"];
      if (paths.length === 2) docs.push(JSON.stringify({ scope: "private-local-findings", summary, details }, null, 2) + "\n");
      return docs;
    });
    console.log("Wrote the aggregate assessment." + (paths.length === 2 ? " Keep the separate file-level report with the repository owner." : ""));
    return;
  }
  if (command === "campaign") {
    const { values } = parseArgs({ args, options: { summaries: { type: "string" }, out: { type: "string" } } });
    const dir = required(values, "summaries");
    const entries = readdirSync(dir, { withFileTypes: true }).filter(e => e.name.endsWith(".json"));
    if (!entries.length || entries.length > 100 || entries.some(e => !e.isFile()))
      throw new Error("Use a directory with 1 to 100 regular JSON summaries.");
    const summaries = entries.map(entry => readSummary(join(dir, entry.name)));
    await writeNewFiles([outputPath(required(values, "out"))], () => [renderCampaign(summaries).trimEnd() + "\n"]);
    console.log("Wrote the campaign assessment brief.");
    return;
  }
  if (command === "brief") {
    const { values } = parseArgs({ args, options: { summary: { type: "string" }, out: { type: "string" }, ai: { type: "boolean" } } });
    const summary = readSummary(required(values, "summary"));
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
