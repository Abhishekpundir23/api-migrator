import { runAssessment } from "../service/assess-command.mjs";

// The build fills in the version from the workspace package manifest.
const version = typeof ASSESSMENT_TOOL_VERSION === "string" ? ASSESSMENT_TOOL_VERSION : "development";
const usage = `SDK migration assessment ${version}

node sdk-assessment.cjs assess --recipe <inngest-v3-to-v4|knock-v0-to-v1> --repo DIR --out SUMMARY.json [--local-report PRIVATE.json]

Choose new output files outside the application. Share only the aggregate SUMMARY.json.
The optional PRIVATE.json contains findings with paths and stays with the repository owner.`;

async function main([command, ...args]) {
  if (command === "--version") return console.log(version);
  if (command === "--help" || args.includes("--help")) return console.log(usage);
  if (command !== "assess") throw new Error(usage);
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Use Node.js 22 or later.");
  await runAssessment(args);
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : "Assessment failed.");
  process.exitCode = 1;
});
