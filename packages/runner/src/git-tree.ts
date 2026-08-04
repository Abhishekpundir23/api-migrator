import { createHash } from "node:crypto";

export const MAX_GIT_PATH_BYTES = 4_096;
export const MAX_GIT_TREE_DEPTH = 64;

export type GitObjectFormat = "sha1" | "sha256";
export type GitFileMode = "100644" | "100755";

export interface GitTreeEntry {
  /** UTF-8 repository-relative path using `/` separators. */
  path: string;
  /** Runner v1 deliberately supports regular Git blobs only. */
  mode: GitFileMode;
  content: Uint8Array;
}

interface FileNode {
  mode: GitFileMode;
  content: Buffer;
}

interface DirectoryNode {
  directories: Map<string, DirectoryNode>;
  files: Map<string, FileNode>;
}

interface EncodedTreeItem {
  name: string;
  directory: boolean;
  mode: GitFileMode | "40000";
  oid: Buffer;
}

/** Infer the Git object format from an exact lowercase object id. */
export function gitObjectFormatFromOid(oid: string): GitObjectFormat {
  if (/^[a-f0-9]{40}$/.test(oid)) return "sha1";
  if (/^[a-f0-9]{64}$/.test(oid)) return "sha256";
  throw new Error("Git object id must be a lowercase SHA-1 or SHA-256 value");
}

/** Hash a regular-file blob using Git's canonical object framing. */
export function gitBlobOid(
  content: Uint8Array,
  objectFormat: GitObjectFormat
): string {
  return hashGitObject("blob", asBuffer(content), objectFormat).toString("hex");
}

/**
 * Calculate the root tree id without consulting attributes, filters, hooks,
 * configuration, or a working tree. SHA-256 repositories use the same object
 * framing with 32-byte child object ids.
 */
export function gitTreeOid(
  entries: readonly GitTreeEntry[],
  objectFormat: GitObjectFormat
): string {
  assertObjectFormat(objectFormat);
  const root = directoryNode();
  const seen = new Set<string>();

  for (const entry of entries) {
    const path = validateGitPath(entry.path);
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new Error(`Unsupported Git file mode for ${path}`);
    }
    if (seen.has(path)) throw new Error(`Duplicate Git tree path: ${path}`);
    seen.add(path);
    insert(root, path, { mode: entry.mode, content: asBuffer(entry.content) });
  }

  return encodeDirectory(root, objectFormat).oid.toString("hex");
}

/** Validate the portable, traversal-free path profile supported by Runner v1. */
export function validateGitPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_GIT_PATH_BYTES
  ) {
    throw new Error("Git tree path is empty, oversized, absolute, or non-portable");
  }
  assertValidUnicode(value, "Git tree path");
  const parts = value.split("/");
  if (
    parts.length > MAX_GIT_TREE_DEPTH ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Git tree path is not normalized or exceeds depth ${MAX_GIT_TREE_DEPTH}: ${value}`);
  }
  if (parts.some((part) => part.toLowerCase() === ".git" || part.toLowerCase() === "node_modules")) {
    throw new Error(`Git tree path contains a forbidden component: ${value}`);
  }
  return value;
}

function insert(root: DirectoryNode, path: string, file: FileNode): void {
  const parts = path.split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    if (directory.files.has(part)) {
      throw new Error(`Git tree path collides with a file: ${path}`);
    }
    let next = directory.directories.get(part);
    if (!next) {
      next = directoryNode();
      directory.directories.set(part, next);
    }
    directory = next;
  }

  const name = parts.at(-1)!;
  if (directory.directories.has(name)) {
    throw new Error(`Git tree path collides with a directory: ${path}`);
  }
  directory.files.set(name, file);
}

function encodeDirectory(
  directory: DirectoryNode,
  objectFormat: GitObjectFormat
): { oid: Buffer; body: Buffer } {
  const items: EncodedTreeItem[] = [];
  for (const [name, child] of directory.directories) {
    items.push({
      name,
      directory: true,
      mode: "40000",
      oid: encodeDirectory(child, objectFormat).oid,
    });
  }
  for (const [name, file] of directory.files) {
    items.push({
      name,
      directory: false,
      mode: file.mode,
      oid: hashGitObject("blob", file.content, objectFormat),
    });
  }
  items.sort(compareTreeItems);

  const chunks: Buffer[] = [];
  for (const item of items) {
    chunks.push(
      Buffer.from(`${item.mode} `, "ascii"),
      Buffer.from(item.name, "utf8"),
      Buffer.from([0]),
      item.oid
    );
  }
  const body = Buffer.concat(chunks);
  return { oid: hashGitObject("tree", body, objectFormat), body };
}

/** Match Git's base_name_compare: directories compare as if suffixed by `/`. */
function compareTreeItems(left: EncodedTreeItem, right: EncodedTreeItem): number {
  const leftName = Buffer.from(`${left.name}${left.directory ? "/" : ""}`, "utf8");
  const rightName = Buffer.from(`${right.name}${right.directory ? "/" : ""}`, "utf8");
  return Buffer.compare(leftName, rightName);
}

function hashGitObject(
  type: "blob" | "tree",
  body: Buffer,
  objectFormat: GitObjectFormat
): Buffer {
  assertObjectFormat(objectFormat);
  return createHash(objectFormat)
    .update(Buffer.from(`${type} ${body.length}\0`, "ascii"))
    .update(body)
    .digest();
}

function assertObjectFormat(value: string): asserts value is GitObjectFormat {
  if (value !== "sha1" && value !== "sha256") {
    throw new Error("Unsupported Git object format");
  }
}

function directoryNode(): DirectoryNode {
  return { directories: new Map(), files: new Map() };
}

function asBuffer(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new Error("Git blob content must be bytes");
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function assertValidUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${label} contains an unpaired high surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} contains an unpaired low surrogate`);
    }
  }
}
