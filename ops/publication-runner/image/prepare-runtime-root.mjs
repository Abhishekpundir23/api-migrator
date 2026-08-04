import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const [workspaceInput, outputInput] = process.argv.slice(2);
if (!workspaceInput || !outputInput) throw new Error("usage: prepare-runtime-root.mjs WORKSPACE OUTPUT");
const workspace = resolve(workspaceInput);
const output = resolve(outputInput);
if (output === workspace || output.startsWith(`${workspace}${sep}`)) {
  throw new Error("runtime output must be outside the source workspace");
}
const lock = JSON.parse(readFileSync(join(workspace, "package-lock.json"), "utf8"));
if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
  throw new Error("runtime image requires the audited npm lockfile v3 shape");
}

const runtimeRoot = join(output, "opt", "api-migrator");
const runtimePackages = join(runtimeRoot, "packages");
const runtimeModules = join(runtimeRoot, "node_modules");
const runtimeConfiguration = join(output, "etc", "api-migrator");
const runnerAppModules = [
  "artifact.js",
  "canonical-json.js",
  "publication-runner.js",
  "publication.js",
  "report.js",
  "repository.js",
  "runner-internal.js",
  "security.js",
];
mkdirSync(runtimePackages, { recursive: true, mode: 0o755 });
mkdirSync(runtimeModules, { recursive: true, mode: 0o755 });
mkdirSync(runtimeConfiguration, { recursive: true, mode: 0o755 });
writeFileSync(join(runtimeConfiguration, "npm-userconfig"), "", { mode: 0o444 });
writeFileSync(join(runtimeConfiguration, "npm-globalconfig"), "", { mode: 0o444 });

for (const name of ["engine", "app", "runner"]) {
  const source = join(workspace, "packages", name);
  const destination = join(runtimePackages, name);
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  cpSync(join(source, "package.json"), join(destination, "package.json"));
  if (name === "app") {
    const destinationDist = join(destination, "dist");
    mkdirSync(destinationDist, { recursive: true, mode: 0o755 });
    for (const module of runnerAppModules) {
      cpSync(join(source, "dist", module), join(destinationDist, module));
    }
  } else {
    cpSync(join(source, "dist"), join(destination, "dist"), { recursive: true });
  }
}

const selected = dependencyClosure(["jscodeshift", "recast", "zod"]);
for (const location of [...selected].sort()) {
  const source = join(workspace, location);
  if (!existsSync(source)) throw new Error(`locked runtime dependency is not installed: ${location}`);
  const destination = join(runtimeRoot, location);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  cpSync(source, destination, { recursive: true, dereference: false });
}

for (const name of ["engine", "app", "runner"]) {
  const scope = join(runtimeModules, "@api-migrator");
  mkdirSync(scope, { recursive: true, mode: 0o755 });
  symlinkSync(`../../packages/${name}`, join(scope, name));
}
writeFileSync(join(runtimeRoot, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`, { mode: 0o644 });

function dependencyClosure(rootNames) {
  const selected = new Set();
  const queue = rootNames.map((name) => resolvePackageLocation("", name, false));
  while (queue.length > 0) {
    const location = queue.shift();
    if (!location || selected.has(location)) continue;
    selected.add(location);
    const entry = lock.packages[location];
    if (!entry || typeof entry !== "object") throw new Error(`missing lock metadata for ${location}`);
    for (const name of Object.keys(entry.dependencies ?? {})) {
      queue.push(resolvePackageLocation(location, name, false));
    }
    for (const name of Object.keys(entry.optionalDependencies ?? {})) {
      const optional = resolvePackageLocation(location, name, true);
      if (optional && existsSync(join(workspace, optional))) queue.push(optional);
    }
    for (const name of Object.keys(entry.peerDependencies ?? {})) {
      const peer = resolvePackageLocation(location, name, true);
      if (peer && existsSync(join(workspace, peer))) queue.push(peer);
    }
  }
  return selected;
}

function resolvePackageLocation(fromLocation, name, optional) {
  if (!/^(@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`invalid locked package name: ${name}`);
  }
  let directory = fromLocation || "";
  while (true) {
    const candidate = join(directory, "node_modules", name).replaceAll("\\", "/");
    if (lock.packages[candidate]) return candidate;
    if (!directory) break;
    const parent = dirname(directory);
    directory = parent === "." ? "" : parent;
  }
  if (optional) return null;
  throw new Error(`could not resolve locked runtime dependency ${name} from ${fromLocation || "root"}`);
}
