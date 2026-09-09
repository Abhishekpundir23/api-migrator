import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../prepare-runtime-root.mjs");
const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

test("runtime closure keeps the dependency version resolved from the requiring package", () => {
  const root = mkdtempSync(join(tmpdir(), "api-migrator-runtime-root-test-"));
  const workspace = join(root, "workspace");
  const output = join(root, "output");
  try {
    for (const name of ["engine", "app", "runner"]) {
      writeJson(join(workspace, "packages", name, "package.json"), {
        name: `@api-migrator/${name}`,
        version: "0.1.0",
        type: "module",
      });
      writeFile(join(workspace, "packages", name, "dist", "index.js"), "export {};\n");
    }
    for (const name of [
      "artifact", "canonical-json", "publication-runner", "publication",
      "preview-evidence", "report", "repository", "repository-validation",
      "runner-git-tree", "runner-internal", "runner-source-bundle", "security",
    ]) {
      writeFile(join(workspace, "packages", "app", "dist", `${name}.js`), "export {};\n");
    }
    writeFile(
      join(workspace, "packages", "app", "dist", "github.js"),
      "throw new Error('remote mutation code must not enter the runner image');\n"
    );
    for (const [location, value] of Object.entries({
      "node_modules/jscodeshift": { name: "jscodeshift", version: "1.0.0", dependencies: { "make-dir": "1.0.0" } },
      "node_modules/make-dir": { name: "make-dir", version: "1.0.0", dependencies: { semver: "5.7.2" } },
      "node_modules/make-dir/node_modules/semver": { name: "semver", version: "5.7.2" },
      "node_modules/semver": { name: "semver", version: "6.3.1" },
      "node_modules/recast": { name: "recast", version: "1.0.0" },
      "node_modules/zod": { name: "zod", version: "1.0.0" },
    })) {
      writeJson(join(workspace, location, "package.json"), value);
    }
    writeJson(join(workspace, "package-lock.json"), {
      name: "closure-fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "closure-fixture" },
        "node_modules/jscodeshift": { version: "1.0.0", dependencies: { "make-dir": "1.0.0" } },
        "node_modules/make-dir": { version: "1.0.0", dependencies: { semver: "5.7.2" } },
        "node_modules/make-dir/node_modules/semver": { version: "5.7.2" },
        "node_modules/semver": { version: "6.3.1" },
        "node_modules/recast": { version: "1.0.0" },
        "node_modules/zod": { version: "1.0.0" },
      },
    });

    execFileSync(process.execPath, [SCRIPT, workspace, output], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const nested = JSON.parse(readFileSync(join(
      output,
      "opt/api-migrator/node_modules/make-dir/node_modules/semver/package.json"
    ), "utf8"));
    assert.equal(nested.version, "5.7.2");
    assert.throws(
      () => readFileSync(join(output, "opt/api-migrator/node_modules/semver/package.json")),
      /ENOENT/
    );
    assert.equal(
      existsSync(join(output, "opt/api-migrator/packages/app/dist/github.js")),
      false
    );
    assert.equal(
      existsSync(join(output, "opt/api-migrator/packages/app/dist/runner-internal.js")),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real built runtime root loads the runner entrypoint and canonical app exports without privileged modules", async () => {
  const testRoot = mkdtempSync(join(tmpdir(), "api-migrator-real-runtime-root-test-"));
  const output = join(testRoot, "output");
  try {
    execFileSync(process.execPath, [SCRIPT, WORKSPACE, output], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const runtimeRoot = join(output, "opt", "api-migrator");
    const runnerCli = join(runtimeRoot, "packages", "runner", "dist", "cli.js");
    const executed = spawnSync(process.execPath, [runnerCli], {
      cwd: runtimeRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.equal(executed.status, 1);
    assert.match(executed.stderr, /^runner_failed=Runner phase must be prepare, install, migrate, or verify\n$/);
    assert.doesNotMatch(executed.stderr, /ERR_MODULE_NOT_FOUND/);

    const runner = await import(pathToFileURL(join(runtimeRoot, "packages/runner/dist/index.js")).href);
    const canonical = await import(pathToFileURL(join(runtimeRoot, "packages/app/dist/runner-internal.js")).href);
    const bytes = Buffer.from("runtime-root", "utf8");
    const expectedBundleDigest = "sha256:14d09151a3f3305a6f2f5ed58383df841b0060dfe4bfbc12acdc0215e4207c95";
    assert.equal(runner.sourceBundleDigest(bytes), expectedBundleDigest);
    assert.equal(canonical.sourceBundleDigest(bytes), expectedBundleDigest);
    assert.equal(runner.gitBlobOid(bytes, "sha1"), "0e128b9d52b2e2943eee0815d961d94d3aad83d4");
    assert.equal(canonical.gitBlobOid(bytes, "sha1"), "0e128b9d52b2e2943eee0815d961d94d3aad83d4");

    for (const privilegedPath of [
      "packages/app/dist/auth.js",
      "packages/app/dist/github.js",
      "packages/app/dist/owner-authorization.js",
      "packages/app/dist/campaign",
      "node_modules/@api-migrator/db",
      "node_modules/@octokit",
    ]) {
      assert.equal(existsSync(join(runtimeRoot, privilegedPath)), false, privilegedPath);
    }
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

function writeFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeJson(path, value) {
  writeFile(path, `${JSON.stringify(value)}\n`);
}
