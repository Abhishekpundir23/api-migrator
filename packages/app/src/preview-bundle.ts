/** Sensitive, local-only review output. This is not a publication capability. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { constants, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PublicationOutcome } from "./publication.js";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

export interface PreviewBundleInput {
  path: string;
  checkoutPath: string;
  environment: NodeJS.ProcessEnv;
  repositorySlug: string;
  publication: PublicationOutcome;
}

export interface PreviewBundleReceipt {
  schemaVersion: 1;
  kind: "local-preview-bundle";
  authorizesPublication: false;
  repositorySlug: string;
  preflightId: string;
  baseBranch: string;
  baseSha: string;
  candidateTreeSha: string;
  artifactDigest: string;
  previewStatus: "preview_ready" | "blocked" | "no_changes";
  blockers: string[];
  patchSha256: string;
  patchBytes: number;
}

export interface PreviewBundleResult {
  path: string;
  receipt: PreviewBundleReceipt;
}

/** Validate before resolving authentication or cloning; repeat immediately before writing. */
export function validatePreviewBundlePath(path: string): string {
  try {
    if (process.platform === "win32" || typeof process.getuid !== "function" ||
      typeof path !== "string" || !isAbsolute(path) || path !== path.trim() ||
      /[\r\n\0]/.test(path) || Buffer.byteLength(path) > 4_096) throw new Error("unsafe path");
    if (path.slice(1).split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("non-normalized path");
    }
    const parent = dirname(path);
    const stat = fs.lstatSync(parent);
    assertPrivateDirectory(stat);
    const canonicalParent = fs.realpathSync.native(parent);
    const rel = relative(fs.realpathSync.native(WORKSPACE_ROOT), canonicalParent);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      throw new Error("workspace output");
    }
    const name = basename(path);
    if (!name || name === "." || name === "..") throw new Error("unsafe child");
    const canonical = join(canonicalParent, name);
    try {
      fs.lstatSync(canonical);
      throw new Error("destination exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return canonical;
  } catch {
    throw new Error("Preview bundle requires a new absolute directory under an owner-only non-symlink parent outside the workspace (Unix only)");
  }
}

export function writePreviewBundle(input: PreviewBundleInput): PreviewBundleResult {
  const path = validatePreviewBundlePath(input.path);
  const outcome = input.publication;
  if (outcome.mode !== "preview" || outcome.status === "pr_opened") {
    throw new Error("Preview bundle is available only for plain previews");
  }
  let patch: Buffer;
  try {
    const git = (args: string[], maxBuffer: number): Buffer => execFileSync("git", [
      "-c", "core.hooksPath=/dev/null", ...args,
    ], { cwd: input.checkoutPath, env: input.environment, stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000, maxBuffer });
    const assertIdentity = (): void => {
      if (git(["rev-parse", "--verify", "HEAD"], 256).toString("ascii").trim() !== outcome.baseSha ||
        git(["write-tree"], 256).toString("ascii").trim() !== outcome.candidateTreeSha) {
        throw new Error("candidate identity changed");
      }
    };
    assertIdentity();
    patch = git(["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv",
      "--no-color", "--no-renames", "--unified=3", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-submodules=none",
      outcome.baseSha, "--"], MAX_PATCH_BYTES);
    if (patch.length > MAX_PATCH_BYTES) throw new Error("patch too large");
    assertIdentity();
  } catch {
    // Never retain subprocess errors: even maxBuffer exceptions carry partial source bytes.
    throw new Error("Preview bundle capture failed: candidate identity mismatch, Git failure, or patch exceeds 8 MiB");
  }
  const receipt: PreviewBundleReceipt = {
    schemaVersion: 1, kind: "local-preview-bundle", authorizesPublication: false,
    repositorySlug: input.repositorySlug, preflightId: outcome.preflightId,
    baseBranch: outcome.baseBranch, baseSha: outcome.baseSha,
    candidateTreeSha: outcome.candidateTreeSha, artifactDigest: outcome.artifactDigest,
    previewStatus: outcome.status, blockers: outcome.blockers.map((blocker) => blocker.message),
    patchSha256: `sha256:${createHash("sha256").update(patch).digest("hex")}`, patchBytes: patch.length,
  };
  // Capture first, then revalidate: an output created during Git capture must never be replaced.
  validatePreviewBundlePath(path);
  const createdFiles: { path: string; stat: Stats }[] = [];
  let directory: Stats | undefined;
  try {
    fs.mkdirSync(path, { mode: 0o700 }); // Exclusive, non-recursive creation.
    directory = fs.lstatSync(path);
    assertPrivateDirectory(directory);
    // These paths are new operator-requested output outside the workspace, not
    // packaged assets. Turbopack traces each join/open independently; keep the
    // annotations on the bare first arguments without bypassing runtime checks.
    const directoryFd = fs.openSync(/* turbopackIgnore: true */ path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameInode(fs.fstatSync(directoryFd), directory)) throw new Error("directory changed");
      fs.fchmodSync(directoryFd, 0o700);
    } finally { fs.closeSync(directoryFd); }
    const write = (name: string, bytes: Buffer): void => {
      assertSameDirectory(path, directory!);
      const file = join(/* turbopackIgnore: true */ path, name);
      const fd = fs.openSync(/* turbopackIgnore: true */ file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        createdFiles.push({ path: file, stat });
        fs.fchmodSync(fd, 0o600);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()) throw new Error("unsafe output");
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      assertSameDirectory(path, directory!);
    };
    write("candidate.patch", patch);
    write("receipt.json", Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8")); // Completion marker last.
    const fd = fs.openSync(/* turbopackIgnore: true */ path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameInode(fs.fstatSync(fd), directory)) throw new Error("directory changed");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return { path, receipt };
  } catch {
    // Best-effort, identity-bound cleanup. No recursive deletion, symlink following or sibling removal.
    for (const file of createdFiles.reverse()) {
      try {
        if (directory && sameInode(fs.lstatSync(path), directory) && sameInode(fs.lstatSync(file.path), file.stat)) {
          fs.unlinkSync(file.path);
        }
      } catch { /* Cleanup must not replace the export failure. */ }
    }
    try {
      if (directory && sameInode(fs.lstatSync(path), directory)) fs.rmdirSync(path);
    } catch { /* Nonempty or replaced output is left untouched. */ }
    throw new Error("Preview bundle output failed; incomplete private output cleanup was attempted");
  }
}

function assertPrivateDirectory(stat: Stats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid!()) throw new Error("unsafe directory");
}

function sameInode(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function assertSameDirectory(path: string, original: Stats): void {
  const stat = fs.lstatSync(path);
  assertPrivateDirectory(stat);
  if (!sameInode(stat, original)) throw new Error("directory changed");
}
