import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runTsc,
  type RunnerCommand,
  type RunnerResult,
  type RunnerTemporaryFile,
  type VerificationRunner,
} from "../src/index.js";

const TYPESCRIPT_VERSION = "5.8.2";

class OuterSandboxRunner implements VerificationRunner {
  readonly kind = "publication-runner-v1";

  createTemporaryFile(name: string): RunnerTemporaryFile {
    const root = mkdtempSync(join(tmpdir(), "api-migrator-preinstalled-temp-"));
    return { path: join(root, name), cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  run(repoPath: string, command: RunnerCommand): RunnerResult {
    if (command.args.includes("--showConfig")) {
      return result(JSON.stringify({ files: [join(repoPath, "src.ts")], compilerOptions: {} }));
    }
    return result("");
  }
}

test("trusted outer sandbox may supply an exact read-only dependency tree", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "api-migrator-preinstalled-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const dependenciesPath = join(root, "dependencies");
  prepareRepository(repository);
  prepareDependencies(dependenciesPath);
  const dependencies = realpathSync(dependenciesPath);
  symlinkSync(join(dependencies, "node_modules"), join(repository, "node_modules"));

  const verification = await runTsc(repository, {
    runner: new OuterSandboxRunner(),
    install: false,
    preinstalledDependenciesRoot: dependencies,
    requiredFiles: ["src.ts"],
    env: {},
  });

  assert.equal(verification.ok, true, verification.skipReason);
  assert.equal(verification.runner, "publication-runner-v1");
  assert.equal(verification.checks.typecheck.status, "passed");
});

test("preinstalled dependency root fails closed when the repository link is substituted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "api-migrator-preinstalled-substitute-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const dependenciesPath = join(root, "dependencies");
  const substitutePath = join(root, "substitute");
  prepareRepository(repository);
  prepareDependencies(dependenciesPath);
  prepareDependencies(substitutePath);
  const dependencies = realpathSync(dependenciesPath);
  const substitute = realpathSync(substitutePath);
  symlinkSync(join(substitute, "node_modules"), join(repository, "node_modules"));

  const verification = await runTsc(repository, {
    runner: new OuterSandboxRunner(),
    install: false,
    preinstalledDependenciesRoot: dependencies,
    env: {},
  });

  assert.equal(verification.ok, false);
  assert.match(verification.skipReason ?? "", /exact preinstalled dependency tree/);
});

function prepareRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture",
    private: true,
    devDependencies: { typescript: `^${TYPESCRIPT_VERSION}` },
  }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", devDependencies: { typescript: `^${TYPESCRIPT_VERSION}` } },
      "node_modules/typescript": {
        version: TYPESCRIPT_VERSION,
        resolved: `https://registry.npmjs.org/typescript/-/typescript-${TYPESCRIPT_VERSION}.tgz`,
        integrity: "sha512-AA==",
      },
    },
  }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, files: ["src.ts"] }));
  writeFileSync(join(root, "src.ts"), "export const value: number = 1;\n");
}

function prepareDependencies(root: string): void {
  const compiler = join(root, "node_modules", "typescript", "bin");
  mkdirSync(compiler, { recursive: true });
  writeFileSync(join(root, "node_modules", "typescript", "package.json"), JSON.stringify({
    name: "typescript",
    version: TYPESCRIPT_VERSION,
    bin: { tsc: "./bin/tsc" },
  }));
  writeFileSync(join(compiler, "tsc"), "process.exitCode = 0;\n");
}

function result(stdout: string): RunnerResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}
