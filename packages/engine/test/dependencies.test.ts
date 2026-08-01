import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLockfiles,
  updateManifestDependencies,
  type Manifest,
  type ReportEntry,
} from "../src/index.js";
import {
  MAX_PACKAGE_MANIFEST_BYTES,
  MAX_ROOT_LOCKFILE_BYTES,
} from "../src/repository-files.js";

const manifest: Manifest = {
  name: "Inngest v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
  peerFloors: [{ name: "typescript", range: "^5.8.0" }],
};

test("dependency update uses target and peer floors and is idempotent", () => {
  withTemp((directory) => {
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      dependencies: { inngest: "^3.22.0" },
      devDependencies: { typescript: "^5.4.0" },
    }, null, 2) + "\n");
    const entries: ReportEntry[] = [];
    const result = updateManifestDependencies(directory, manifest, { push: (entry) => entries.push(entry) });
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    assert.equal(pkg.dependencies.inngest, "^4.0.0");
    assert.equal(pkg.devDependencies.typescript, "^5.8.0");
    assert.deepEqual(result.packageFiles, ["package.json"]);
    assert.deepEqual(entries.map((entry) => entry.code), ["PKG1", "PKG2"]);

    const again = updateManifestDependencies(directory, manifest, { push: () => assert.fail("idempotent update reported a change") });
    assert.deepEqual(again.packageFiles, []);
  });
});

test("dependency update fails when source major does not match", () => {
  withTemp((directory) => {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { inngest: "^2.0.0" } }));
    assert.throws(
      () => updateManifestDependencies(directory, manifest, { push: () => undefined }),
      /outside manifest source/
    );
  });
});

test("dependency update changes every declaration section", () => {
  withTemp((directory) => {
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      devDependencies: { inngest: "^3.2.0", typescript: "^5.4.0" },
      peerDependencies: { inngest: "^3.0.0", typescript: ">=5.0.0" },
      optionalDependencies: { inngest: "^4.1.0" },
    }, null, 2) + "\n");
    const entries: ReportEntry[] = [];
    updateManifestDependencies(directory, manifest, { push: (entry) => entries.push(entry) });
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    assert.equal(pkg.devDependencies.inngest, "^4.0.0");
    assert.equal(pkg.peerDependencies.inngest, "^4.0.0");
    assert.equal(pkg.optionalDependencies.inngest, "^4.1.0", "target-major compatible spec is preserved");
    assert.equal(pkg.devDependencies.typescript, "^5.8.0");
    assert.equal(pkg.peerDependencies.typescript, "^5.8.0");
    assert.equal(entries.filter((entry) => entry.code === "PKG1").length, 2);
    assert.equal(entries.filter((entry) => entry.code === "PKG2").length, 2);

    const again = updateManifestDependencies(directory, manifest, {
      push: () => assert.fail("idempotent multi-section update reported a change"),
    });
    assert.deepEqual(again.packageFiles, []);
  });
});

test("dependency update rejects any incompatible duplicate declaration before writing", () => {
  withTemp((directory) => {
    const original = JSON.stringify({
      devDependencies: { inngest: "^3.0.0" },
      peerDependencies: { inngest: "^2.0.0" },
    }, null, 2) + "\n";
    writeFileSync(join(directory, "package.json"), original);
    assert.throws(
      () => updateManifestDependencies(directory, manifest, { push: () => undefined }),
      /outside manifest source/
    );
    assert.equal(readFileSync(join(directory, "package.json"), "utf8"), original);
  });
});

test("peer floors without a root package are added only to target owners", () => {
  withTemp((directory) => {
    mkdirSync(join(directory, "packages", "a"), { recursive: true });
    mkdirSync(join(directory, "packages", "z"), { recursive: true });
    writeFileSync(
      join(directory, "packages", "a", "package.json"),
      JSON.stringify({ name: "unrelated", devDependencies: {} }, null, 2)
    );
    writeFileSync(
      join(directory, "packages", "z", "package.json"),
      JSON.stringify({ name: "target", dependencies: { inngest: "^3.0.0" } }, null, 2)
    );
    updateManifestDependencies(directory, manifest, { push: () => undefined });
    const unrelated = JSON.parse(readFileSync(join(directory, "packages", "a", "package.json"), "utf8"));
    const target = JSON.parse(readFileSync(join(directory, "packages", "z", "package.json"), "utf8"));
    assert.equal(unrelated.devDependencies.typescript, undefined);
    assert.equal(target.devDependencies.typescript, "^5.8.0");
  });
});

test("root lockfiles reject symlinks, non-regular entries, and oversized files before reads", () => {
  withTemp((directory) => {
    writeFileSync(join(directory, "actual-lock.json"), "{}\n");
    symlinkSync("actual-lock.json", join(directory, "package-lock.json"));
    assert.throws(() => findLockfiles(directory), /lockfile must not be a symlink/);
  });

  withTemp((directory) => {
    mkdirSync(join(directory, "yarn.lock"));
    assert.throws(() => findLockfiles(directory), /lockfile must be a regular file/);
  });

  withTemp((directory) => {
    writeFileSync(join(directory, "pnpm-lock.yaml"), "");
    truncateSync(join(directory, "pnpm-lock.yaml"), MAX_ROOT_LOCKFILE_BYTES + 1);
    assert.throws(() => findLockfiles(directory), /lockfile exceeds/);
  });
});

test("package manifests reject symlinks and oversized files before parsing", () => {
  withTemp((directory) => {
    writeFileSync(join(directory, "actual-package.json"), JSON.stringify({ dependencies: { inngest: "^3" } }));
    symlinkSync("actual-package.json", join(directory, "package.json"));
    assert.throws(
      () => updateManifestDependencies(directory, manifest, { push: () => undefined }),
      /manifest must be a regular non-symlink file/
    );
  });

  withTemp((directory) => {
    writeFileSync(join(directory, "package.json"), "");
    truncateSync(join(directory, "package.json"), MAX_PACKAGE_MANIFEST_BYTES + 1);
    assert.throws(
      () => updateManifestDependencies(directory, manifest, { push: () => undefined }),
      /manifest exceeds/
    );
  });
});

function withTemp(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-deps-test-"));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
