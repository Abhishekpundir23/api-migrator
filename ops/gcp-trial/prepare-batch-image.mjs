import { canonicalJson } from '../publication-runner/deployment/lib.mjs';
import { readInputFile } from './input-file.mjs';
import { prepareBatchImage } from './batch-image.mjs';
try {
  process.stdout.write(`${canonicalJson(prepareBatchImage(readInputFile(process.argv.slice(2))))}\n`);
} catch {
  process.stderr.write('Batch image preparation rejected. Usage: prepare-batch-image.mjs --input REQUEST.json (render only)\n');
  process.exitCode = 2;
}
