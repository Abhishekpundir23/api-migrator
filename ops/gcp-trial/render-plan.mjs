import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { canonicalJson } from "../publication-runner/deployment/lib.mjs";
import { renderTrialPlan } from "./plan.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--input" || !args[1]) throw new Error("usage");
  const fd = openSync(args[1], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let request;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 32_768) throw new Error("input");
    const bytes = Buffer.alloc(32_769);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size < 1 || size > 32_768) throw new Error("input");
    request = JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally { closeSync(fd); }
  process.stdout.write(`${canonicalJson(renderTrialPlan(request))}\n`);
} catch {
  // Never echo arbitrary file contents, paths, or parse-error snippets.
  process.stderr.write("GCP trial proposal rejected. Usage: render-plan.mjs --input REQUEST.json (render only; execution unsupported)\n");
  process.exitCode = 2;
}
