import { canonicalJson } from "../publication-runner/deployment/lib.mjs";
import { renderTrialPlan } from "./plan.mjs";
import { readInputFile } from "./input-file.mjs";

try {
  const request = readInputFile(process.argv.slice(2));
  process.stdout.write(`${canonicalJson(renderTrialPlan(request))}\n`);
} catch {
  // Never echo arbitrary file contents, paths, or parse-error snippets.
  process.stderr.write("GCP trial proposal rejected. Usage: render-plan.mjs --input REQUEST.json (render only; execution unsupported)\n");
  process.exitCode = 2;
}
