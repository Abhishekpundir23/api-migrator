import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { JobStoreError, type StorePolicy } from "./runner-job-store-contract.js";

export const DATABASE_BASENAME = "runner-jobs.sqlite";
export const MAX_DATABASE_BYTES = 67_108_864;
const MAX_JOURNAL_BYTES = 71_303_168;
const checkout = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const unsafe = (): never => { throw new JobStoreError("store_unsafe"); };

function uid(): number {
  if (!["darwin", "linux"].includes(process.platform) || typeof process.getuid !== "function" || !constants.O_NOFOLLOW) unsafe();
  return process.getuid!();
}
function absolute(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || normalize(value) !== value ||
    value.split(sep).some((part) => part === "." || part === "..") || (value !== sep && value.endsWith(sep))) unsafe();
  return value;
}
function beneath(path: string, root: string): boolean { return path === root || path.startsWith(root === sep ? root : `${root}${sep}`); }
function overlaps(a: string, b: string): boolean { return beneath(a, b) || beneath(b, a); }
// Resolve aliases in configured exclusions, including roots not created yet.
function canonicalExclusion(path: string): string {
  absolute(path);
  try { return realpathSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalExclusion(parent), path.slice(parent.length + (parent === sep ? 0 : 1)));
  }
}
export function validateTestRoot(root: string): string {
  absolute(root);
  const stat = lstatSync(root);
  if (realpathSync(root) !== root || !beneath(root, realpathSync(tmpdir())) || root === realpathSync(tmpdir()) ||
    !stat.isDirectory() || stat.uid !== uid() || (stat.mode & 0o7777) !== 0o700) unsafe();
  return root;
}
export function validateDirectory(directory: string, policy: StorePolicy, testRoot?: string): void {
  const owner = uid();
  absolute(directory);
  if (!policy || !Array.isArray(policy.migrationWorkspaceRoots)) unsafe();
  const exclusions = [checkout, policy.applicationCheckout, ...policy.migrationWorkspaceRoots].map(canonicalExclusion);
  if (exclusions.some((root) => overlaps(directory, root))) unsafe();
  const platformRoots = [tmpdir(), "/tmp", "/var/tmp", "/run"].map(canonicalExclusion);
  if (testRoot) {
    validateTestRoot(testRoot);
    if (!beneath(directory, testRoot) || directory === testRoot) unsafe();
  } else if (platformRoots.some((root) => overlaps(directory, root))) unsafe();
  let current: string = sep;
  for (const component of ["", ...directory.slice(1).split(sep)]) {
    if (component) current = join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== owner)) unsafe();
    const admittedStickyAncestor = testRoot && current !== testRoot && beneath(testRoot, current) &&
      stat.uid === 0 && (stat.mode & 0o7777) === 0o1777;
    if (((stat.mode & 0o022) !== 0 || (stat.mode & 0o7000) !== 0) && !admittedStickyAncestor) unsafe();
    if (current === directory && (stat.uid !== owner || (stat.mode & 0o7777) !== 0o700)) unsafe();
  }
}
function regular(path: string, max: number): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== uid() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size > max) unsafe();
  return stat;
}
export function validateFiles(directory: string): Stats {
  for (const entry of readdirSync(directory)) {
    if (entry === `${DATABASE_BASENAME}-journal`) regular(join(directory, entry), MAX_JOURNAL_BYTES);
    else if (entry !== DATABASE_BASENAME) unsafe();
  }
  return regular(join(directory, DATABASE_BASENAME), MAX_DATABASE_BYTES);
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink;
}
export function pinStore(directory: string, policy: StorePolicy, testRoot?: string) {
  validateDirectory(directory, policy, testRoot);
  const database = validateFiles(directory);
  const leaf = lstatSync(directory);
  let fileFd: number | undefined;
  let directoryFd: number | undefined;
  try {
    fileFd = openSync(join(directory, DATABASE_BASENAME), constants.O_RDONLY | constants.O_NOFOLLOW);
    directoryFd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const check = () => {
      validateDirectory(directory, policy, testRoot);
      if (!same(database, validateFiles(directory)) || !same(database, fstatSync(fileFd!)) ||
        !same(leaf, lstatSync(directory)) || !same(leaf, fstatSync(directoryFd!))) unsafe();
    };
    check();
    return {
      check,
      sync: () => { check(); fsyncSync(fileFd!); fsyncSync(directoryFd!); check(); },
      close: () => { closeSync(fileFd!); closeSync(directoryFd!); },
    };
  } catch (error) {
    if (fileFd !== undefined) closeSync(fileFd);
    if (directoryFd !== undefined) closeSync(directoryFd);
    throw error;
  }
}
