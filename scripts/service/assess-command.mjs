import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { assessRepository, ASSESSMENT_RULES } from "@api-migrator/engine";
import { validateSummary } from "./brief.mjs";
import { required, outputPath, writeNewFiles } from "./cli-io.mjs";

export async function runAssessment(args) {
  const { values } = parseArgs({
    args,
    options: {
      recipe: { type: "string" }, repo: { type: "string" },
      out: { type: "string" }, "local-report": { type: "string" },
    },
  });
  const recipe = required(values, "recipe");
  if (!Object.hasOwn(ASSESSMENT_RULES, recipe)) throw new Error("Unsupported recipe. See --help.");
  const root = realpathSync(required(values, "repo"));
  const paths = [outputPath(required(values, "out"), root)];
  if (values["local-report"] !== undefined) paths.push(outputPath(required(values, "local-report"), root));
  await writeNewFiles(paths, () => {
    const details = [];
    const onFinding = paths.length === 2 ? entry => details.push(entry) : undefined;
    const summary = validateSummary(assessRepository(root, recipe, onFinding));
    const docs = [JSON.stringify(summary, null, 2) + "\n"];
    if (paths.length === 2) docs.push(JSON.stringify({ scope: "private-local-findings", summary, details }, null, 2) + "\n");
    return docs;
  });
  console.log("Wrote the aggregate assessment." + (paths.length === 2 ? " Keep the separate file-level report with the repository owner." : ""));
}
