import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunnerRegistryIo, RunnerRegistryPolicy } from "../../src/runner-key-registry.js";

export function registryFixture(bytes: Buffer): {
  directory: string;
  file: string;
  policy: RunnerRegistryPolicy;
  replace(bytes: Buffer): void;
  close(): void;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-registry-test-")));
  try {
    chmodSync(root, 0o700);
    const directory = join(root, "registry");
    const applicationCheckout = join(root, "checkout");
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(applicationCheckout, { mode: 0o700 });
    const file = join(directory, "runner-keys.json");
    writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    let replacement = 0;
    return {
      directory, file, policy: { applicationCheckout, excludedRoots: [] },
      replace: (next) => {
        const sibling = join(directory, `replacement-${replacement++}.json`);
        writeFileSync(sibling, next, { flag: "wx", mode: 0o600 });
        renameSync(sibling, file);
      },
      close: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

// Only external OS-temp ancestors with sticky/write bits are synthesized.
// All created fixture directories, files, links and their metadata remain real.
export function registryFixtureIo(): RunnerRegistryIo {
  const stickyAncestors = new Set<string>();
  for (let path = realpathSync(tmpdir()); ; path = dirname(path)) {
    if ((lstatSync(path).mode & 0o1022) === 0o1022) stickyAncestors.add(path);
    if (path === dirname(path)) break;
  }
  return {
    open, realpath,
    lstat: (async (path, options) => {
      const snapshot = await lstat(path, options);
      if (!stickyAncestors.has(String(path))) return snapshot;
      return Object.assign(Object.create(Object.getPrototypeOf(snapshot)), snapshot, {
        mode: typeof snapshot.mode === "bigint"
          ? (snapshot.mode & ~0o7777n) | 0o755n
          : (snapshot.mode & ~0o7777) | 0o755,
      });
    }) as RunnerRegistryIo["lstat"],
  };
}
