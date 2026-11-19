import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const output = resolve(process.argv[2] ?? join(root, "dist"));
const archiveName = `sdk-assessment-${version}.tgz`;

function thirdPartyNotices(inputs) {
  const packages = new Set();
  for (const [path, { bytesInOutput }] of Object.entries(inputs)) {
    const match = path.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/);
    if (bytesInOutput && match) packages.add(match[1]);
  }
  const notices = [];
  for (const path of [...packages].sort()) {
    const dir = join(root, path);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const title = `${pkg.name} ${pkg.version} (${pkg.license})`;
    const names = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /^(?:licen[sc]e|notice|copying|copyright)/i.test(e.name))
      .map(e => e.name).sort();
    let bodies = names.map(name => readFileSync(join(dir, name), "utf8").trimEnd());
    // Both npm packages omit LICENSE. Preserve the exact file from their tagged repository.
    if (names.length === 0 && ["flow-estree", "flow-parser"].includes(pkg.name) && pkg.version === "0.325.0") {
      bodies = ["https://github.com/facebook/flow/blob/v0.325.0/LICENSE",
        readFileSync(join(here, "flow-v0.325.0-LICENSE"), "utf8").trimEnd()];
    }
    if (!bodies.length) throw new Error(`Missing distribution license text for ${title}`);
    notices.push([title, ...bodies].join("\n\n"));
  }
  return notices.join("\n\n----------------------------------------\n\n") + "\n";
}

mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(output, ".assessment-"));
try {
  const stage = join(scratch, "package");
  mkdirSync(stage);
  const bundled = await build({
    absWorkingDir: root,
    entryPoints: ["scripts/assessment-package/owner-cli.mjs"],
    outfile: join(stage, "sdk-assessment.cjs"),
    platform: "node", target: "node22", format: "cjs",
    bundle: true, metafile: true, legalComments: "eof",
    define: { ASSESSMENT_TOOL_VERSION: JSON.stringify(version) },
  });
  const [bundle] = Object.values(bundled.metafile.outputs);
  for (const entry of bundle.imports) {
    if (!isBuiltin(entry.path)) throw new Error(`External runtime dependency in owner scanner: ${entry.path}`);
  }
  writeFileSync(join(stage, "THIRD-PARTY-NOTICES.txt"), thirdPartyNotices(bundle.inputs));
  copyFileSync(join(here, "README.txt"), join(stage, "README.txt"));
  const manifest = { name: "sdk-assessment", version, private: true, engines: { node: ">=22" },
    files: ["sdk-assessment.cjs", "README.txt", "THIRD-PARTY-NOTICES.txt"] };
  writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

  // npm's pack format normalizes mode and time. The local directory contains only the owner handoff.
  const args = ["pack", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--pack-destination", scratch];
  const npm = process.env.npm_execpath;
  execFileSync(npm ? process.execPath : "npm", npm ? [npm, ...args] : args, { cwd: stage, stdio: "pipe" });
  const digest = createHash("sha256").update(readFileSync(join(scratch, archiveName))).digest("hex");
  writeFileSync(join(scratch, archiveName + ".sha256"), `${digest}  ${archiveName}\n`);
  for (const name of [archiveName, archiveName + ".sha256"]) renameSync(join(scratch, name), join(output, name));
  console.log(`Owner archive: ${join(output, archiveName)}\nSHA-256: ${digest}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
