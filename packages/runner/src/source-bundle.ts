import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  gitBlobOid,
  gitObjectFormatFromOid,
  gitTreeOid,
  validateGitPath,
  type GitFileMode,
  type GitObjectFormat,
  type GitTreeEntry,
} from "./git-tree.js";

export const SOURCE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const MAX_SOURCE_ENTRIES = 50_000;
export const MAX_SOURCE_TOTAL_BYTES = 536_870_912;
export const MAX_SOURCE_FILE_BYTES = 268_435_456;
export const MAX_CANONICAL_MANIFEST_BYTES = 262_144;

const MAX_HEADER_BYTES = 524_288;
const MAX_PATH_BYTES = 4_096;
const FRAME_PREFIX_BYTES = 13;
const MAGIC = Buffer.from("API-MIGRATOR-SOURCE-BUNDLE\0V1\n", "ascii");
const FOOTER = Buffer.from("\nAPI-MIGRATOR-SOURCE-BUNDLE-END\0V1", "ascii");
const MAX_BUNDLE_BYTES =
  MAX_SOURCE_TOTAL_BYTES +
  MAX_SOURCE_ENTRIES * (MAX_PATH_BYTES + FRAME_PREFIX_BYTES) +
  MAX_HEADER_BYTES +
  MAGIC.length +
  FOOTER.length +
  4;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;

export interface SourceBundleRepositoryIdentity {
  slug: string;
  id: number;
  ownerId: number;
}

export interface SourceBundleBaseIdentity {
  branch: string;
  sha: string;
  treeSha: string;
}

export interface CreateSourceBundleInput {
  /** Existing clean checkout whose index and HEAD are the approved base. */
  checkoutPath: string;
  repository: SourceBundleRepositoryIdentity;
  base: SourceBundleBaseIdentity;
  /** Exact canonical UTF-8 manifest bytes. */
  manifestJson: string;
}

export interface SourceBundleHeader {
  schemaVersion: typeof SOURCE_BUNDLE_SCHEMA_VERSION;
  repository: SourceBundleRepositoryIdentity;
  base: SourceBundleBaseIdentity & { objectFormat: GitObjectFormat };
  manifest: {
    canonicalJson: string;
    byteLength: number;
    digest: string;
  };
  entryCount: number;
  totalFileBytes: number;
  entriesDigest: string;
}

export interface SourceBundleEntry extends GitTreeEntry {
  mode: GitFileMode;
  content: Buffer;
}

export interface SourceBundleRecord {
  bytes: Buffer;
  digest: string;
  header: Readonly<SourceBundleHeader>;
}

export interface ParsedSourceBundle {
  header: Readonly<SourceBundleHeader>;
  entries: readonly SourceBundleEntry[];
  digest: string;
}

/**
 * Build a canonical source bundle from stage-0 tracked index entries only.
 * Untracked/dirty files, symlinks, submodules, hardlinks, filters, and special
 * files cannot become runner input.
 */
export function createSourceBundle(input: CreateSourceBundleInput): SourceBundleRecord {
  const repository = validateRepository(input.repository);
  const base = validateBase(input.base);
  const manifestJson = validateCanonicalManifest(input.manifestJson);
  const checkout = validateCleanCheckout(input.checkoutPath, base);
  const objectFormat = gitObjectFormatFromOid(base.sha);
  const entries = readTrackedEntries(checkout, objectFormat);
  const calculatedTree = gitTreeOid(entries, objectFormat);
  if (calculatedTree !== base.treeSha) {
    throw new Error("Tracked checkout bytes and modes do not match the approved base tree");
  }

  const encoded = encodeEntries(entries);
  const header: SourceBundleHeader = {
    schemaVersion: SOURCE_BUNDLE_SCHEMA_VERSION,
    repository,
    base: { ...base, objectFormat },
    manifest: {
      canonicalJson: manifestJson,
      byteLength: Buffer.byteLength(manifestJson, "utf8"),
      digest: sha256(Buffer.from(manifestJson, "utf8")),
    },
    entryCount: entries.length,
    totalFileBytes: encoded.totalFileBytes,
    entriesDigest: encoded.digest,
  };
  const headerBytes = Buffer.from(canonicalJson(header), "utf8");
  if (headerBytes.length === 0 || headerBytes.length > MAX_HEADER_BYTES) {
    throw new Error("Source bundle header exceeds its byte limit");
  }
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerBytes.length);
  const bytes = Buffer.concat([MAGIC, headerLength, headerBytes, ...encoded.frames, FOOTER]);
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("Source bundle exceeds its byte limit");
  return {
    bytes,
    digest: sha256(bytes),
    header: freezeHeader(header),
  };
}

/** Parse and fully validate exact bundle bytes before any filesystem write. */
export function parseSourceBundle(input: Uint8Array): ParsedSourceBundle {
  if (!(input instanceof Uint8Array)) throw new Error("Source bundle must be bytes");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < MAGIC.length + 4 + FOOTER.length || bytes.length > MAX_BUNDLE_BYTES) {
    throw new Error("Source bundle is truncated or exceeds its byte limit");
  }
  let offset = 0;
  expectBytes(bytes, offset, MAGIC, "source bundle magic");
  offset += MAGIC.length;
  const headerLength = bytes.readUInt32BE(offset);
  offset += 4;
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    throw new Error("Source bundle header length is invalid");
  }
  const headerEnd = checkedEnd(offset, headerLength, bytes.length, "source bundle header");
  const headerText = decodeUtf8(bytes.subarray(offset, headerEnd), "source bundle header");
  const header = validateHeader(parseCanonicalJson(headerText, "source bundle header"));
  offset = headerEnd;

  const entries: SourceBundleEntry[] = [];
  const entryHash = createHash("sha256");
  let totalFileBytes = 0;
  let previousPath: Buffer | null = null;
  for (let index = 0; index < header.entryCount; index += 1) {
    const frameStart = offset;
    const prefixEnd = checkedEnd(offset, FRAME_PREFIX_BYTES, bytes.length, "source entry prefix");
    const pathLength = bytes.readUInt32BE(offset);
    offset += 4;
    const modeByte = bytes[offset]!;
    offset += 1;
    const rawContentLength = bytes.readBigUInt64BE(offset);
    offset += 8;
    if (pathLength === 0 || pathLength > MAX_PATH_BYTES) {
      throw new Error("Source entry path length is invalid");
    }
    if (modeByte !== 0 && modeByte !== 1) throw new Error("Source entry mode is unsupported");
    if (rawContentLength > BigInt(MAX_SOURCE_FILE_BYTES)) {
      throw new Error("Source entry exceeds its file byte limit");
    }
    const contentLength = Number(rawContentLength);
    const pathEnd = checkedEnd(prefixEnd, pathLength, bytes.length, "source entry path");
    const pathBytes = bytes.subarray(prefixEnd, pathEnd);
    const path = validateGitPath(decodeUtf8(pathBytes, "source entry path"));
    if (previousPath && Buffer.compare(previousPath, pathBytes) >= 0) {
      throw new Error("Source entries are duplicated or not in canonical byte order");
    }
    previousPath = Buffer.from(pathBytes);
    const contentEnd = checkedEnd(pathEnd, contentLength, bytes.length, "source entry content");
    const content = Buffer.from(bytes.subarray(pathEnd, contentEnd));
    offset = contentEnd;
    totalFileBytes += content.length;
    if (totalFileBytes > MAX_SOURCE_TOTAL_BYTES) {
      throw new Error("Source bundle exceeds its total file byte limit");
    }
    entryHash.update(bytes.subarray(frameStart, contentEnd));
    entries.push({ path, mode: modeByte === 0 ? "100644" : "100755", content });
  }

  expectBytes(bytes, offset, FOOTER, "source bundle footer");
  offset += FOOTER.length;
  if (offset !== bytes.length) throw new Error("Source bundle has trailing bytes");
  if (entries.length !== header.entryCount || totalFileBytes !== header.totalFileBytes) {
    throw new Error("Source bundle entry count or byte total does not match its header");
  }
  const entriesDigest = `sha256:${entryHash.digest("hex")}`;
  if (entriesDigest !== header.entriesDigest) {
    throw new Error("Source bundle entry digest does not match its header");
  }
  if (gitTreeOid(entries, header.base.objectFormat) !== header.base.treeSha) {
    throw new Error("Source bundle entries do not match the approved Git tree");
  }

  return {
    header,
    entries,
    digest: sha256(bytes),
  };
}

/** Extract only after complete in-memory validation into a new private root. */
export function extractSourceBundle(
  input: Uint8Array | ParsedSourceBundle,
  destination: string
): ParsedSourceBundle {
  const parsed = input instanceof Uint8Array
    ? parseSourceBundle(input)
    : validateParsedSourceBundle(input);
  const root = validateNewDestination(destination);
  mkdirSync(root, { mode: 0o700 });
  return extractValidatedBundle(parsed, root, true);
}

/** Extract into an existing empty bind-mount root after validating its identity. */
export function extractSourceBundleIntoDirectory(
  input: Uint8Array | ParsedSourceBundle,
  destination: string
): ParsedSourceBundle {
  const parsed = input instanceof Uint8Array
    ? parseSourceBundle(input)
    : validateParsedSourceBundle(input);
  if (typeof destination !== "string" || !isAbsolute(destination) || resolve(destination) !== destination) {
    throw new Error("Source extraction destination must be an absolute canonical directory");
  }
  const stat = lstatSync(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(destination) !== destination) {
    throw new Error("Source extraction destination must be a real canonical directory");
  }
  if (readdirSync(destination).length !== 0) {
    throw new Error("Source extraction destination must be empty");
  }
  return extractValidatedBundle(parsed, destination, false);
}

function extractValidatedBundle(
  parsed: ParsedSourceBundle,
  root: string,
  removeRootOnFailure: boolean
): ParsedSourceBundle {
  try {
    for (const entry of parsed.entries) {
      const absolute = join(root, ...entry.path.split("/"));
      const parent = dirname(absolute);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      chmodDirectoryChain(root, parent);
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      const descriptor = openSync(
        absolute,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        entry.mode === "100755" ? 0o700 : 0o600
      );
      try {
        writeFileSync(descriptor, entry.content);
      } finally {
        closeSync(descriptor);
      }
      chmodSync(absolute, entry.mode === "100755" ? 0o700 : 0o600);
    }
    return parsed;
  } catch (error) {
    if (removeRootOnFailure) {
      rmSync(root, { recursive: true, force: true });
    } else {
      for (const name of readdirSync(root)) {
        rmSync(join(root, name), { recursive: true, force: true });
      }
    }
    throw error;
  }
}

function validateParsedSourceBundle(value: ParsedSourceBundle): ParsedSourceBundle {
  if (!value || typeof value !== "object") throw new Error("Parsed source bundle is invalid");
  const header = validateHeader(value.header);
  if (!Array.isArray(value.entries)) throw new Error("Parsed source bundle entries are invalid");
  const entries: SourceBundleEntry[] = [];
  let previous: Buffer | null = null;
  for (const raw of value.entries as readonly SourceBundleEntry[]) {
    if (!raw || typeof raw !== "object" || !(raw.content instanceof Uint8Array)) {
      throw new Error("Parsed source bundle entry is invalid");
    }
    const path = validateGitPath(raw.path);
    const pathBytes = Buffer.from(path, "utf8");
    if (previous && Buffer.compare(previous, pathBytes) >= 0) {
      throw new Error("Parsed source entries are duplicated or not in canonical byte order");
    }
    previous = pathBytes;
    if (raw.mode !== "100644" && raw.mode !== "100755") {
      throw new Error("Parsed source bundle entry mode is unsupported");
    }
    entries.push({
      path,
      mode: raw.mode,
      content: Buffer.from(raw.content.buffer, raw.content.byteOffset, raw.content.byteLength),
    });
  }
  const encoded = encodeEntries(entries);
  if (
    entries.length !== header.entryCount ||
    encoded.totalFileBytes !== header.totalFileBytes ||
    encoded.digest !== header.entriesDigest ||
    gitTreeOid(entries, header.base.objectFormat) !== header.base.treeSha
  ) {
    throw new Error("Parsed source bundle does not match its header");
  }
  return {
    header,
    entries,
    digest: validDigest(value.digest, "parsed bundle digest"),
  };
}

export function sourceBundleDigest(input: Uint8Array): string {
  if (!(input instanceof Uint8Array) || input.byteLength === 0 || input.byteLength > MAX_BUNDLE_BYTES) {
    throw new Error("Source bundle is missing or exceeds its byte limit");
  }
  return sha256(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
}

function validateCleanCheckout(checkoutPath: string, base: SourceBundleBaseIdentity): string {
  if (typeof checkoutPath !== "string" || checkoutPath.length === 0) {
    throw new Error("Source bundle checkout path is required");
  }
  const checkout = realpathSync(resolve(checkoutPath));
  const stat = lstatSync(checkout);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Source bundle checkout must be a real directory");
  }
  const top = gitText(checkout, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(top) !== checkout) throw new Error("Source bundle checkout must be the Git top level");
  if (gitBytes(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length !== 0) {
    throw new Error("Source bundle checkout must have a clean tracked and untracked working tree");
  }
  const head = gitText(checkout, ["rev-parse", "HEAD"]);
  const tree = gitText(checkout, ["rev-parse", "HEAD^{tree}"]);
  if (head !== base.sha || tree !== base.treeSha) {
    throw new Error("Source bundle checkout does not match the approved base commit and tree");
  }
  let reportedFormat: string;
  try {
    reportedFormat = gitText(checkout, ["rev-parse", "--show-object-format"]);
  } catch {
    reportedFormat = gitObjectFormatFromOid(head);
  }
  if (reportedFormat !== gitObjectFormatFromOid(base.sha)) {
    throw new Error("Source bundle checkout Git object format does not match the approved base");
  }
  return checkout;
}

function readTrackedEntries(checkout: string, objectFormat: GitObjectFormat): SourceBundleEntry[] {
  const raw = gitBytes(checkout, ["ls-files", "--cached", "--stage", "--full-name", "-z"]);
  const records = splitNul(raw);
  if (records.length > MAX_SOURCE_ENTRIES) {
    throw new Error(`Source bundle exceeds ${MAX_SOURCE_ENTRIES} tracked entries`);
  }
  const entries: SourceBundleEntry[] = [];
  let totalFileBytes = 0;
  const seen = new Set<string>();

  for (const record of records) {
    const tab = record.indexOf(0x09);
    if (tab <= 0 || tab === record.length - 1) throw new Error("Git returned a malformed index entry");
    const metadata = record.subarray(0, tab).toString("ascii");
    const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])$/.exec(metadata);
    if (!match) throw new Error("Git returned an unsupported index entry");
    const mode = match[1]!;
    const indexedOid = match[2]!;
    const stage = match[3]!;
    if (stage !== "0") throw new Error("Source bundle rejects unmerged index stages");
    if (mode !== "100644" && mode !== "100755") {
      throw new Error("Source bundle rejects symlinks, submodules, and non-regular Git modes");
    }
    if (gitObjectFormatFromOid(indexedOid) !== objectFormat) {
      throw new Error("Git index object format is inconsistent");
    }
    const path = validateGitPath(decodeUtf8(record.subarray(tab + 1), "Git index path"));
    if (seen.has(path)) throw new Error(`Source bundle contains duplicate tracked path: ${path}`);
    seen.add(path);
    const content = readTrackedFile(checkout, path, mode);
    if (gitBlobOid(content, objectFormat) !== indexedOid) {
      throw new Error(`Tracked file changed after clean-checkout validation: ${path}`);
    }
    totalFileBytes += content.length;
    if (totalFileBytes > MAX_SOURCE_TOTAL_BYTES) {
      throw new Error("Source bundle exceeds its total file byte limit");
    }
    entries.push({ path, mode, content });
  }

  return entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"))
  );
}

function readTrackedFile(checkout: string, path: string, mode: GitFileMode): Buffer {
  assertNoSymlinkComponents(checkout, path);
  const absolute = join(checkout, ...path.split("/"));
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(absolute, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new Error(`Tracked source must be a one-link regular file: ${path}`);
    }
    if ((before.mode & 0o7000) !== 0 || before.size > MAX_SOURCE_FILE_BYTES) {
      throw new Error(`Tracked source has unsupported mode or size: ${path}`);
    }
    const actualMode: GitFileMode = (before.mode & 0o111) === 0 ? "100644" : "100755";
    if (actualMode !== mode) throw new Error(`Tracked source mode differs from the Git index: ${path}`);
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      content.length !== before.size
    ) {
      throw new Error(`Tracked source changed while it was read: ${path}`);
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function assertNoSymlinkComponents(root: string, path: string): void {
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Tracked source traverses a symlink: ${path}`);
  }
  const real = realpathSync(current);
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new Error(`Tracked source escapes the checkout: ${path}`);
  }
}

function encodeEntries(entries: readonly SourceBundleEntry[]): {
  frames: Buffer[];
  digest: string;
  totalFileBytes: number;
} {
  const frames: Buffer[] = [];
  const hash = createHash("sha256");
  let totalFileBytes = 0;
  for (const entry of entries) {
    const path = validateGitPath(entry.path);
    const pathBytes = Buffer.from(path, "utf8");
    if (pathBytes.length === 0 || pathBytes.length > MAX_PATH_BYTES) {
      throw new Error("Source entry path exceeds its byte limit");
    }
    if (entry.content.length > MAX_SOURCE_FILE_BYTES) {
      throw new Error(`Source entry exceeds its file byte limit: ${path}`);
    }
    const prefix = Buffer.alloc(FRAME_PREFIX_BYTES);
    prefix.writeUInt32BE(pathBytes.length, 0);
    prefix[4] = entry.mode === "100644" ? 0 : entry.mode === "100755" ? 1 : 255;
    if (prefix[4] === 255) throw new Error(`Source entry has unsupported mode: ${path}`);
    prefix.writeBigUInt64BE(BigInt(entry.content.length), 5);
    const frame = Buffer.concat([prefix, pathBytes, entry.content]);
    frames.push(frame);
    hash.update(frame);
    totalFileBytes += entry.content.length;
    if (totalFileBytes > MAX_SOURCE_TOTAL_BYTES) {
      throw new Error("Source bundle exceeds its total file byte limit");
    }
  }
  return {
    frames,
    digest: `sha256:${hash.digest("hex")}`,
    totalFileBytes,
  };
}

function validateHeader(value: unknown): Readonly<SourceBundleHeader> {
  const root = record(value, "source bundle header");
  exactKeys(root, [
    "schemaVersion",
    "repository",
    "base",
    "manifest",
    "entryCount",
    "totalFileBytes",
    "entriesDigest",
  ], "source bundle header");
  if (root.schemaVersion !== SOURCE_BUNDLE_SCHEMA_VERSION) {
    throw new Error("Source bundle schema version is unsupported");
  }
  const repository = validateRepository(record(root.repository, "source repository"));
  const baseRoot = record(root.base, "source base");
  exactKeys(baseRoot, ["branch", "sha", "treeSha", "objectFormat"], "source base");
  const base = validateBase(baseRoot);
  const objectFormat = baseRoot.objectFormat;
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error("Source base object format is unsupported");
  }
  if (objectFormat !== gitObjectFormatFromOid(base.sha)) {
    throw new Error("Source base object format does not match its commit id");
  }
  const manifestRoot = record(root.manifest, "source manifest");
  exactKeys(manifestRoot, ["canonicalJson", "byteLength", "digest"], "source manifest");
  const manifestJson = validateCanonicalManifest(manifestRoot.canonicalJson);
  const manifestByteLength = positiveInteger(manifestRoot.byteLength, "manifest byte length", true);
  const manifestDigest = validDigest(manifestRoot.digest, "manifest digest");
  if (
    manifestByteLength !== Buffer.byteLength(manifestJson, "utf8") ||
    manifestDigest !== sha256(Buffer.from(manifestJson, "utf8"))
  ) {
    throw new Error("Source manifest byte length or digest does not match its canonical bytes");
  }
  const entryCount = positiveInteger(root.entryCount, "entry count", true);
  const totalFileBytes = positiveInteger(root.totalFileBytes, "total file bytes", true);
  if (entryCount > MAX_SOURCE_ENTRIES || totalFileBytes > MAX_SOURCE_TOTAL_BYTES) {
    throw new Error("Source bundle header exceeds entry or byte limits");
  }
  return freezeHeader({
    schemaVersion: SOURCE_BUNDLE_SCHEMA_VERSION,
    repository,
    base: { ...base, objectFormat },
    manifest: {
      canonicalJson: manifestJson,
      byteLength: manifestByteLength,
      digest: manifestDigest,
    },
    entryCount,
    totalFileBytes,
    entriesDigest: validDigest(root.entriesDigest, "entries digest"),
  });
}

function validateRepository(value: unknown): SourceBundleRepositoryIdentity {
  const root = record(value, "source repository");
  exactKeys(root, ["slug", "id", "ownerId"], "source repository");
  if (typeof root.slug !== "string" || root.slug !== root.slug.toLowerCase()) {
    throw new Error("Source repository slug must be canonical lowercase owner/repo");
  }
  const parts = root.slug.split("/");
  if (
    parts.length !== 2 ||
    !OWNER.test(parts[0]!) ||
    parts[0]!.includes("--") ||
    !REPOSITORY.test(parts[1]!) ||
    parts[1] === "." ||
    parts[1] === ".." ||
    parts[1]!.endsWith(".git")
  ) {
    throw new Error("Source repository slug is invalid");
  }
  return {
    slug: root.slug,
    id: positiveInteger(root.id, "repository id"),
    ownerId: positiveInteger(root.ownerId, "repository owner id"),
  };
}

function validateBase(value: unknown): SourceBundleBaseIdentity {
  const root = record(value, "source base");
  for (const key of ["branch", "sha", "treeSha"]) {
    if (!(key in root)) throw new Error(`Source base is missing ${key}`);
  }
  if (typeof root.branch !== "string") throw new Error("Source base branch is invalid");
  const branch = validateBranch(root.branch);
  if (typeof root.sha !== "string" || typeof root.treeSha !== "string") {
    throw new Error("Source base object ids are invalid");
  }
  const objectFormat = gitObjectFormatFromOid(root.sha);
  if (gitObjectFormatFromOid(root.treeSha) !== objectFormat) {
    throw new Error("Source base commit and tree use different object formats");
  }
  return { branch, sha: root.sha, treeSha: root.treeSha };
}

function validateCanonicalManifest(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_CANONICAL_MANIFEST_BYTES
  ) {
    throw new Error("Source manifest is missing or exceeds its byte limit");
  }
  const parsed = parseCanonicalJson(value, "source manifest");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Source manifest must be a canonical JSON object");
  }
  return value;
}

function validateBranch(value: string): string {
  if (
    value.length === 0 ||
    value.length > 240 ||
    value !== value.trim() ||
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(value) ||
    value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith("."))
  ) {
    throw new Error("Source base branch is invalid");
  }
  return value;
}

function validateNewDestination(destination: string): string {
  if (typeof destination !== "string" || destination.length === 0 || !isAbsolute(destination)) {
    throw new Error("Source extraction destination must be an absolute new path");
  }
  const root = resolve(destination);
  if (root !== destination || existsSync(root)) {
    throw new Error("Source extraction destination must be canonical and must not exist");
  }
  const parent = dirname(root);
  const parentReal = realpathSync(parent);
  const stat = lstatSync(parentReal);
  if (!stat.isDirectory() || stat.isSymbolicLink() || parentReal !== parent) {
    throw new Error("Source extraction parent must be a canonical real directory");
  }
  return root;
}

function chmodDirectoryChain(root: string, target: string): void {
  let current = root;
  chmodSync(current, 0o700);
  const relative = target === root ? "" : target.slice(root.length + 1);
  for (const part of relative ? relative.split(sep) : []) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Source extraction created a non-directory path component");
    }
    chmodSync(current, 0o700);
  }
}

function gitBytes(cwd: string, args: readonly string[]): Buffer {
  try {
    return execFileSync(
      "git",
      [
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.attributesFile=/dev/null",
        "-c", "core.excludesFile=/dev/null",
        ...args,
      ],
      {
        cwd,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: "/nonexistent",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
          LC_ALL: "C",
        },
      }
    );
  } catch {
    throw new Error(`Git source-bundle operation failed: ${args[0] ?? "unknown"}`);
  }
}

function gitText(cwd: string, args: readonly string[]): string {
  const value = decodeUtf8(gitBytes(cwd, args), "Git command output");
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n")) {
    throw new Error("Git source-bundle operation returned an unexpected result");
  }
  return value.slice(0, -1);
}

function splitNul(value: Buffer): Buffer[] {
  if (value.length === 0) return [];
  if (value.at(-1) !== 0) throw new Error("Git index output is not NUL terminated");
  const entries: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    if (index === start) throw new Error("Git index output contains an empty entry");
    entries.push(value.subarray(start, index));
    start = index + 1;
  }
  return entries;
}

function expectBytes(source: Buffer, offset: number, expected: Buffer, label: string): void {
  const end = checkedEnd(offset, expected.length, source.length, label);
  if (!source.subarray(offset, end).equals(expected)) throw new Error(`${label} is invalid`);
}

function checkedEnd(offset: number, length: number, available: number, label: string): number {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 0) {
    throw new Error(`${label} length is invalid`);
  }
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end > available) throw new Error(`${label} is truncated`);
  return end;
}

function decodeUtf8(value: Uint8Array, label: string): string {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`${label} is not valid UTF-8`);
  assertValidUnicode(text, label);
  return text;
}

function parseCanonicalJson(value: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (canonicalJson(parsed) !== value) {
    throw new Error(`${label} is not canonical JSON, including duplicate keys`);
  }
  return parsed;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertValidUnicode(value, "canonical JSON string");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error("Canonical JSON contains an unsafe number");
    }
    return String(value);
  }
  if (typeof value !== "object") throw new Error("Canonical JSON contains an unsupported value");
  if (ancestors.has(value)) throw new Error("Canonical JSON contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      const ownKeys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index)) ||
        ownKeys.length !== value.length + 1 ||
        ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !keys.includes(key)))
      ) {
        throw new Error("Canonical JSON contains a sparse or extended array");
      }
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical JSON object has an unsupported prototype");
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    if (
      Reflect.ownKeys(object).length !== keys.length ||
      Reflect.ownKeys(object).some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      throw new Error("Canonical JSON contains hidden or symbolic members");
    }
    return `{${keys.map((key) => {
      assertValidUnicode(key, "canonical JSON key");
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.value === undefined) {
        throw new Error("Canonical JSON contains an accessor, hidden, or undefined member");
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function assertValidUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${label} has invalid Unicode`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} has invalid Unicode`);
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(root: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(root).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} contains missing or unsupported fields`);
  }
}

function positiveInteger(value: unknown, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) {
    throw new Error(`Source bundle ${label} is invalid`);
  }
  return Number(value);
}

function validDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`Source bundle ${label} is invalid`);
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function freezeHeader(value: SourceBundleHeader): Readonly<SourceBundleHeader> {
  Object.freeze(value.repository);
  Object.freeze(value.base);
  Object.freeze(value.manifest);
  return Object.freeze(value);
}
