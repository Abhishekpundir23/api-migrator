import { posix } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import { readRepositoryFile, validateRepositoryFile } from "./repository-files.js";
import type { ReportEntry } from "./types.js";

/** Use the already parsed source and the transform's scoped client bindings. */
export function inferredRegistrationLine(root: any, isRegistration: (path: any) => boolean): number | undefined {
  const first = root.get();
  const program = first.node.type === "File" ? first.get("program") : first;
  const body = program.node.body;
  const exported = new Set<string>();
  for (const statement of body) {
    if (statement.type === "ExportDefaultDeclaration" && statement.declaration.type === "Identifier") {
      exported.add(statement.declaration.name);
    }
    if (statement.type === "ExportNamedDeclaration" && !statement.source && statement.exportKind !== "type") {
      for (const spec of statement.specifiers) {
        if (spec.type === "ExportSpecifier" && spec.exportKind !== "type") exported.add(spec.local.name);
      }
    }
  }
  function inferred(path: any): boolean {
    while (path.node?.type === "TSSatisfiesExpression") path = path.get("expression");
    const call = path.node;
    return call?.type === "CallExpression" && [2, 3].includes(call.arguments.length)
      && (!call.callee.computed || call.callee.property?.type === "StringLiteral") && isRegistration(path);
  }
  for (let i = 0; i < body.length; i++) {
    const statement = program.get("body", i);
    if (statement.node.type === "ExportDefaultDeclaration" && inferred(statement.get("declaration"))) {
      return statement.node.loc?.start.line;
    }
    const direct = statement.node.type === "ExportNamedDeclaration" && !!statement.node.declaration;
    const declaration = direct ? statement.get("declaration") : statement;
    if (declaration.node.type !== "VariableDeclaration" || declaration.node.kind !== "const") continue;
    for (let j = 0; j < declaration.node.declarations.length; j++) {
      const item = declaration.get("declarations", j);
      const id = item.node.id;
      if (id.type === "Identifier" && !id.typeAnnotation && (direct || exported.has(id.name))
        && item.node.init && inferred(item.get("init"))) return id.loc?.start.line;
    }
  }
  return undefined;
}

type JsonObject = Record<string, any>;
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const policy = { label: "Declaration build metadata", maxBytes: 128 * 1024 };
const lockPolicy = { label: "Declaration build workspace lock", maxBytes: 1024 * 1024 };
const unresolvedBase = Symbol("unresolved compiler settings");
type Config = JsonObject & { [unresolvedBase]?: boolean };
const configName = /^[\w-]+(?:\.[\w-]+)*\.json$/;

/** Support literal paths and TypeScript's common trailing wildcard file patterns.
 * Unknown patterns are indeterminate, so an unknown exclusion suppresses the review.
 */
function matches(file: string, input: unknown): boolean | undefined {
  if (typeof input !== "string" || input.length > 512) return undefined;
  const pattern = input.replace(/^\.\//, "").replace(/\/$/, "");
  if (!pattern || pattern.split("/").some(part => !part || part === ".." || part === ".")) return undefined;
  const match = /^((?:[\w.-]+\/)*)(\*\*\/)?\*([\w.-]*)$/.exec(pattern);
  if (match) {
    if (!file.startsWith(match[1])) return false;
    const rest = file.slice(match[1].length);
    return (!!match[2] || !rest.includes("/")) && rest.endsWith(match[3]);
  }
  if (!/^[\w./-]+$/.test(pattern)) return undefined;
  return file === pattern || (!posix.extname(pattern) && file.startsWith(pattern + "/"));
}

function includesSource(config: JsonObject, file: string): boolean {
  if (file.split("/").some(part => part.startsWith("."))) return false;
  if (config.files !== undefined && (!Array.isArray(config.files) || config.files.length > 256)) return false;
  if (config.files?.some((p: unknown) => typeof p === "string" && p.replace(/^\.\//, "") === file)) return true;
  const include = config.include ?? (config.files === undefined ? ["**/*"] : []);
  const exclude = config.exclude ?? [];
  if (!Array.isArray(include) || !Array.isArray(exclude) || include.length + exclude.length > 256) return false;
  const outDir = config.compilerOptions.outDir;
  if (outDir !== undefined && matches(file, outDir) !== false) return false;
  return include.some((p: unknown) => matches(file, p) === true)
    && exclude.every((p: unknown) => matches(file, p) === false);
}

/** One private review per proven package build. The scanner never invokes the build. */
export class InngestDeclarationAssessment {
  private sites = new Map<string, number>();
  observe(file: string, line: number): void {
    this.sites.set(file.replaceAll("\\", "/"), line);
  }

  *entries(root: string): Generator<ReportEntry> {
    // Missing manifests allow ascent; unreadable/invalid manifests are package boundaries.
    const metadata = new Map<string, JsonObject | null | undefined>();
    let bytes = 0;
    function read(path: string): JsonObject | null | undefined {
      if (metadata.has(path)) return metadata.get(path);
      if (metadata.size >= 1024 || bytes >= 2 * 1024 * 1024) return null;
      let value: JsonObject | null | undefined;
      try {
        const file = validateRepositoryFile(root, path, policy, true);
        if (file) {
          if (bytes + file.size > 2 * 1024 * 1024) return null;
          const buffer = readRepositoryFile(root, path, { ...policy, maxBytes: Math.min(policy.maxBytes, 2 * 1024 * 1024 - bytes) });
          bytes += buffer.length;
          const source = buffer.toString("utf8");
          const errors: ParseError[] = [];
          const parsed = posix.basename(path) === "package.json" ? JSON.parse(source)
            : parseJsonc(source.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
          value = !errors.length && isObject(parsed) ? parsed : null;
        }
      } catch { value = null; }
      metadata.set(path, value);
      return value;
    }
    let importers: JsonObject | null | undefined;
    function workspaceConfig(dir: string, spec: string, depth: number): Config | null {
      const match = /^((?:@[\w-]+\/)?[\w-]+)\/([\w.-]+\.json)$/.exec(spec);
      if (!match) return null;
      const [, name, file] = match;
      const manifest = read(posix.join(dir, "package.json"));
      const sections = ["dependencies", "devDependencies", "optionalDependencies"];
      const section = sections.find(key => typeof manifest?.[key]?.[name] === "string");
      const requested = section && manifest?.[section][name];
      if (!section || !requested?.startsWith("workspace:")) return null;
      if (importers === undefined) {
        importers = null;
        try {
          const limit = { ...lockPolicy, maxBytes: Math.min(lockPolicy.maxBytes, 2 * 1024 * 1024 - bytes) };
          const lock = readRepositoryFile(root, "pnpm-lock.yaml", limit);
          bytes += lock.length;
          const parsed = parseYaml(lock.toString("utf8"), { schema: "failsafe", maxAliasCount: 0, logLevel: "silent" });
          if (parsed?.lockfileVersion === "9.0" && isObject(parsed.importers)) importers = parsed.importers;
        } catch { /* Unavailable or unsupported lockfiles leave this base unresolved. */ }
      }
      const pinned = importers?.[dir]?.[section]?.[name];
      if (pinned?.specifier !== requested || typeof pinned.version !== "string"
        || !/^link:(?:[\w.-]+\/)*[\w.-]+$/.test(pinned.version)) return null;
      const target = posix.join(dir, pinned.version.slice(5));
      if (target.split("/").some(part => part === ".." || part === "node_modules")) return null;
      const pkg = read(posix.join(target, "package.json"));
      if (pkg?.name !== name || pkg.exports !== undefined) return null;
      return buildConfig(target, file, depth + 1);
    }
    function buildConfig(dir: string, name: string, depth = 0): Config | null {
      if (!configName.test(name) || depth >= 6) return null;
      const own = read(posix.join(dir, name));
      if (!own || (own.compilerOptions !== undefined && !isObject(own.compilerOptions))) return null;
      let base: Config = {};
      if (own.extends !== undefined) {
        if (typeof own.extends !== "string") return null;
        if (own.extends.startsWith("./")) {
          const parent = buildConfig(dir, own.extends.slice(2), depth + 1);
          if (!parent) return null;
          base = parent;
        } else {
          if (!/^(?:@[\w-]+\/)?[\w-]+(?:\/[\w.-]+)*$/.test(own.extends)) return null;
          const shared = workspaceConfig(dir, own.extends, depth);
          // Cross-package inclusion patterns are relative to their own config.
          // Require local membership evidence if a shared pattern could apply.
          base = {
            include: shared && shared.files === undefined && shared.include === undefined ? undefined : [],
            exclude: shared && shared.exclude === undefined ? undefined : [null],
            compilerOptions: {
              noEmit: shared?.compilerOptions.noEmit,
              declaration: shared?.compilerOptions.declaration === false ? false : undefined,
            },
            [unresolvedBase]: !shared || shared[unresolvedBase],
          };
        }
      }
      return { ...base, ...own, compilerOptions: { ...base.compilerOptions, ...own.compilerOptions } };
    }
    const projects = new Map<string, Config | null>();
    const reported = new Set<string>();
    for (const [file, line] of this.sites) {
      let dir = posix.dirname(file);
      let manifest = read(posix.join(dir, "package.json"));
      while (dir !== "." && manifest === undefined) {
        dir = posix.dirname(dir);
        manifest = read(posix.join(dir, "package.json"));
      }
      if (!manifest || reported.has(dir)) continue;
      if (!projects.has(dir)) {
        const build = manifest.scripts?.build;
        const selected = typeof build === "string" && /^tsc(?:[ \t]+(?:-p|--project|-b|--build)[ \t]+(?:\.\/)?([\w.-]+\.json)|[ \t]+(?:-b|--build))?$/.exec(build.trim());
        projects.set(dir, selected ? buildConfig(dir, selected[1] ?? "tsconfig.json") : null);
      }
      const config = projects.get(dir);
      if (!config) continue;
      const options = config.compilerOptions;
      if (["declaration", "composite", "noEmit"].some(k => options[k] !== undefined && typeof options[k] !== "boolean")) continue;
      if (options.noEmit === true || options.declaration === false
        || (options.declaration !== true && options.composite !== true)) continue;
      if (!includesSource(config, posix.relative(dir, file))) continue;
      reported.add(dir);
      const advice = config[unresolvedBase] && (options.noEmit !== false || options.declaration !== true)
        ? "This package enables declaration types locally and exports an inferred Inngest registration. Inspect the effective compiler settings to confirm whether its build emits declarations. If it does, run that build and check for TS2742."
        : "This package requests declaration emit and exports an inferred Inngest registration. Run the package’s build and check for TS2742.";
      yield { file, line, code: "F19", kind: "review", message: advice
        + " If required, annotate affected exports with a public Inngest function type and recheck typed step results." };
    }
  }
}
