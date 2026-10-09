import { canonicalJson } from "../publication-runner/deployment/lib.mjs";
import { readInputFile } from "./input-file.mjs";
import { prepareBatch } from "./batch.mjs";
try {
  process.stdout.write(`${canonicalJson(prepareBatch(readInputFile(process.argv.slice(2))))}\n`);
} catch {
  process.stderr.write("Batch preparation rejected. Usage: prepare-batch.mjs --input REQUEST.json (render only)\n");
  process.exitCode = 2;
}
