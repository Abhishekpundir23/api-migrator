import { posix } from "node:path";
import { readRepositoryText, validateRepositoryFile } from "../repository-files.js";

type AliasConfig = { directory: string; paths: Record<string, unknown> };
const policy = { label: "Realtime import path configuration", maxBytes: 256 * 1024 };

/** Resolve simple, explicit tsconfig prefix aliases for review. Never load a compiler or follow extends. */
export function createRealtimeAliasResolver(root: string) {
  const cache = new Map<string, AliasConfig | null>();
  function configFor(directory: string): AliasConfig | null {
    if (cache.has(directory)) return cache.get(directory)!;
    const path = posix.join(directory, "tsconfig.json");
    let config: AliasConfig | null = null;
    try {
      if (validateRepositoryFile(root, path, policy, true)) {
        const json = JSON.parse(readRepositoryText(root, path, policy));
        const options = json?.compilerOptions;
        if (!json.extends && !json.references && !options?.baseUrl && !options?.moduleSuffixes && !options?.rootDirs
          && options?.paths && typeof options.paths === "object" && !Array.isArray(options.paths)) {
          config = { directory, paths: options.paths };
        }
      } else if (directory !== ".") {
        config = configFor(posix.dirname(directory));
      }
    } catch { /* Unsupported or unreadable configuration leaves the import unresolved. */ }
    cache.set(directory, config);
    return config;
  }
  return (importer: string, source: string): string | null => {
    if (!/^(?:@|~)\/[\w./-]+$/.test(source) || source.split("/").includes("..")) return null;
    const directory = posix.dirname(importer);
    const config = configFor(directory);
    if (!config) return null;
    const prefix = source.slice(0, 2);
    const key = `${prefix}*`;
    // Other matching patterns could override this mapping. Leave custom configurations for manual tracing.
    if (Object.keys(config.paths).some(pattern => pattern !== key && (pattern.startsWith(prefix) || pattern === source))) return null;
    const targets = config.paths[key];
    if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== "string"
      || !/^\.\/(?:[\w-]+\/)*\*$/.test(targets[0])) return null;
    const target = posix.join(config.directory, targets[0].slice(0, -1), source.slice(prefix.length));
    const relative = posix.relative(directory, target);
    return relative.startsWith("../") ? relative : `./${relative}`;
  };
}
