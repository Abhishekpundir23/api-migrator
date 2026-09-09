import { constants, type BigIntStats } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseCanonicalJson } from "./canonical-json.js";
import { validateAttestationTrust, type RunnerAttestationTrust } from "./publication-runner.js";
import { RunnerEvidenceError, runnerEvidenceDigest, type RunnerEvidenceContext } from "./runner-evidence-contract.js";
import type { RunnerEvidenceDeadline } from "./runner-evidence-deadline.js";
import { parseRepositorySlug } from "./repository.js";

export interface RunnerKeyEntry extends RunnerAttestationTrust {
  pilotId: string;
  repository: { slug: string; id: number; ownerId: number };
}
export interface RunnerKeySelection {
  entry: Readonly<RunnerKeyEntry>;
  trust: Readonly<RunnerAttestationTrust>;
  trustDigest: string;
}
export interface RunnerRegistryPolicy {
  applicationCheckout: string;
  excludedRoots: readonly string[];
  platformExcludedRoots?: readonly string[];
}
export type RunnerRegistryIo = Pick<typeof import("node:fs/promises"), "open" | "lstat" | "realpath">;

const MAX_REGISTRY_BYTES = 256 * 1024;
const TRUST_FIELDS = ["keyId", "algorithm", "publicKeyPem", "fingerprint", "validFrom", "validUntil", "revokedAt"] as const;

export function selectRunnerKey(bytes: Buffer, context: Readonly<RunnerEvidenceContext>, now: number): RunnerKeySelection {
  try {
    if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(now) || now < 0) unavailable();
    const root = exactRecord(parseCanonicalJson(bytes, MAX_REGISTRY_BYTES, "runner key registry"), ["schemaVersion", "keys"]);
    if (root.schemaVersion !== 1 || !Array.isArray(root.keys) || root.keys.length < 1 || root.keys.length > 128) unavailable();
    const ids = new Set<string>();
    const fingerprints = new Set<string>();
    const activeScopes = new Set<string>();
    let selected: RunnerKeyEntry | undefined;
    for (const value of root.keys) {
      const raw = exactRecord(value, ["pilotId", "repository", ...TRUST_FIELDS]);
      if (typeof raw.pilotId !== "string" || !/^pilot_[A-Za-z0-9_-]{6,80}$/.test(raw.pilotId)) unavailable();
      const repository = exactRecord(raw.repository, ["slug", "id", "ownerId"]);
      if (typeof repository.slug !== "string" || repository.slug.length > 140 || repository.slug !== repository.slug.toLowerCase()) unavailable();
      const slug = parseRepositorySlug(repository.slug).slug;
      for (const id of [repository.id, repository.ownerId]) {
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) unavailable();
      }
      // The existing verifier accepts only its seven trust fields, never scope
      // or the parsed KeyObject returned by its own validation helper.
      const trust = trustFields(raw);
      const validated = validateAttestationTrust(trust);
      const key: RunnerKeyEntry = {
        ...trustFields(validated),
        pilotId: raw.pilotId,
        repository: { slug, id: repository.id as number, ownerId: repository.ownerId as number },
      };
      if (ids.has(key.keyId) || fingerprints.has(key.fingerprint)) unavailable();
      ids.add(key.keyId);
      fingerprints.add(key.fingerprint);
      if (key.revokedAt !== null || now < key.validFrom || now >= key.validUntil) continue;
      const scope = JSON.stringify([key.pilotId, slug, key.repository.id, key.repository.ownerId]);
      if (activeScopes.has(scope)) unavailable();
      activeScopes.add(scope);
      const expected = context.source.repository;
      if (key.pilotId === context.plan.plan.subject.pilotId && slug === expected.slug && key.repository.id === expected.id && key.repository.ownerId === expected.ownerId) selected = key;
    }
    if (!selected) unavailable();
    Object.freeze(selected.repository);
    return Object.freeze({
      entry: Object.freeze(selected),
      trust: Object.freeze(trustFields(selected)),
      trustDigest: runnerEvidenceDigest(selected),
    });
  } catch {
    throw new RunnerEvidenceError("trust_unavailable");
  }
}

function unavailable(): never { throw new RunnerEvidenceError("trust_unavailable"); }

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) unavailable();
  return object;
}

function trustFields(value: object): RunnerAttestationTrust {
  return Object.fromEntries(TRUST_FIELDS.map((field) => [field, (value as Record<string, unknown>)[field]])) as unknown as RunnerAttestationTrust;
}

export async function readRunnerKeyRegistry(
  directory: string,
  policy: RunnerRegistryPolicy,
  context: Readonly<RunnerEvidenceContext>,
  deadline: RunnerEvidenceDeadline,
): Promise<RunnerKeySelection> {
  if (typeof process.geteuid !== "function") unavailable();
  return readRunnerKeyRegistryWithIo(directory, policy, context, deadline, { open, lstat, realpath }, process.geteuid());
}

/** Source-internal seam. Never export IO or this reader from a package subpath. */
export async function readRunnerKeyRegistryWithIo(
  directory: string,
  policy: RunnerRegistryPolicy,
  context: Readonly<RunnerEvidenceContext>,
  deadline: RunnerEvidenceDeadline,
  io: RunnerRegistryIo,
  effectiveUid: number,
): Promise<RunnerKeySelection> {
  try {
    if (process.platform === "win32" || !Number.isSafeInteger(effectiveUid) || effectiveUid < 0 ||
        !Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0 ||
        !Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0 ||
        !Number.isInteger(constants.O_RDONLY)) unavailable();
    const uid = BigInt(effectiveUid);
    if (typeof directory !== "string" || !isAbsolute(directory) || resolve(directory) !== directory || directory.includes("\0")) unavailable();

    // Required roots are resolved independently, even when the same path also
    // appears in the optional platform list. Missing explicit roots fail closed.
    for (const root of [policy.applicationCheckout, ...policy.excludedRoots]) {
      await excludeRoot(root, false);
    }
    for (const root of policy.platformExcludedRoots ?? []) {
      await excludeRoot(root, true);
    }
    async function excludeRoot(root: string, optional: boolean): Promise<void> {
      if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0")) unavailable();
      const lexical = resolve(root);
      let resolved: string;
      try { resolved = await deadline.run(() => io.realpath(root)); }
      catch (error) {
        if (!optional || !error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
        resolved = lexical;
      }
      if (within(directory, lexical) || within(directory, resolved)) unavailable();
    }

    const paths: string[] = [];
    for (let path = directory; ; path = dirname(path)) {
      paths.unshift(path);
      if (path === dirname(path)) break;
    }
    const directories: Array<{ path: string; snapshot: BigIntStats }> = [];
    for (const path of paths) {
      const snapshot = await deadline.run(() => io.lstat(path, { bigint: true }));
      validateDirectory(snapshot, uid, path === directory);
      directories.push({ path, snapshot });
    }
    const file = join(directory, "runner-keys.json");
    const pathBefore = await deadline.run(() => io.lstat(file, { bigint: true }));
    validateFile(pathBefore, uid);
    const handle = await deadline.run(
      () => io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
      (lateHandle) => lateHandle.close(),
    );
    try {
      const before = await deadline.run(() => handle.stat({ bigint: true }));
      validateFile(before, uid);
      sameSnapshot(pathBefore, before, FILE_FIELDS);
      const buffer = Buffer.alloc(MAX_REGISTRY_BYTES + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await deadline.run(() => handle.read(buffer, used, buffer.length - used, used));
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      if (used > MAX_REGISTRY_BYTES) unavailable();
      const after = await deadline.run(() => handle.stat({ bigint: true }));
      sameSnapshot(before, after, FILE_FIELDS);
      if (BigInt(used) !== before.size) unavailable();
      const pathAfter = await deadline.run(() => io.lstat(file, { bigint: true }));
      sameSnapshot(before, pathAfter, FILE_FIELDS);
      for (const { path, snapshot } of directories) {
        const current = await deadline.run(() => io.lstat(path, { bigint: true }));
        sameSnapshot(snapshot, current, DIRECTORY_FIELDS);
      }
      const selection = selectRunnerKey(buffer.subarray(0, used), context, deadline.check());
      const finish = deadline.check();
      if (finish < selection.entry.validFrom || finish >= selection.entry.validUntil) unavailable();
      return selection;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RunnerEvidenceError && error.code === "expired") throw error;
    throw new RunnerEvidenceError("trust_unavailable");
  }
}

const DIRECTORY_FIELDS = ["dev", "ino", "uid", "mode"] as const;
const FILE_FIELDS = [...DIRECTORY_FIELDS, "nlink", "size", "mtimeNs", "ctimeNs"] as const;

function sameSnapshot(before: BigIntStats, after: BigIntStats, fields: readonly (keyof BigIntStats)[]): void {
  if (fields.some((field) => before[field] !== after[field])) unavailable();
}

function validateDirectory(snapshot: BigIntStats, uid: bigint, final: boolean): void {
  if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) unavailable();
  if (final) {
    if (snapshot.uid !== uid || (snapshot.mode & 0o7077n) !== 0n) unavailable();
  } else if ((snapshot.uid !== 0n && snapshot.uid !== uid) || (snapshot.mode & 0o22n) !== 0n) unavailable();
}

function validateFile(snapshot: BigIntStats, uid: bigint): void {
  const mode = snapshot.mode & 0o7777n;
  if (!snapshot.isFile() || snapshot.uid !== uid || snapshot.nlink !== 1n || (mode !== 0o400n && mode !== 0o600n)) unavailable();
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
