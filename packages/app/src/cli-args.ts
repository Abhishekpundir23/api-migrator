import { DeploymentPolicy, type DeploymentPolicy as Deployment } from "@api-migrator/engine";
import { isAbsolute } from "node:path";

export interface PreviewArgs {
  slug: string;
  baseBranch?: string;
  branch?: string;
  deploymentKind?: Deployment["kind"];
  previewBundlePath?: string;
}

/** Validate every argument before a preview can access a repository. */
export function parsePreviewArgs(args: string[]): PreviewArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const allowed = new Set(["--base", "--branch", "--deployment-kind", "--preview-bundle"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (allowed.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--") || flags.has(arg)) {
        throw new Error(`Missing value or duplicate argument: ${arg}`);
      }
      flags.set(arg, value);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) throw new Error("Provide exactly one owner/repo");
  const result: PreviewArgs = { slug: positional[0]! };
  if (flags.has("--base")) result.baseBranch = flags.get("--base")!;
  if (flags.has("--branch")) result.branch = flags.get("--branch")!;
  if (flags.has("--preview-bundle")) {
    const path = flags.get("--preview-bundle")!;
    if (!isAbsolute(path) || path !== path.trim() || /[\r\n\0]/.test(path) || Buffer.byteLength(path) > 4_096) {
      throw new Error("Preview bundle path must be absolute");
    }
    result.previewBundlePath = path;
  }
  if (flags.has("--deployment-kind")) {
    result.deploymentKind = DeploymentPolicy.parse({ kind: flags.get("--deployment-kind") }).kind;
  }
  return result;
}
