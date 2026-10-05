import { canonicalJson } from "../publication-runner/deployment/lib.mjs";
import { prepareTrial } from "./bootstrap.mjs";
import { readInputFile } from "./input-file.mjs";

try {
  process.stdout.write(`${canonicalJson(prepareTrial(readInputFile(process.argv.slice(2))))}\n`);
} catch {
  process.stderr.write("GCP trial preparation rejected. Usage: prepare-trial.mjs --input REQUEST.json (render only; execution unsupported)\n");
  process.exitCode = 2;
}
