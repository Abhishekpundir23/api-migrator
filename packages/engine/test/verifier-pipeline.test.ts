import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerVerificationRunner,
  installDeps,
  runMigration,
  runTsc,
  verify,
  type Manifest,
  type RunnerCommand,
  type RunnerResult,
  type VerificationRunner,
} from "../src/index.js";

test("default Docker verification image is pinned by digest", () => {
  assert.match(
    new DockerVerificationRunner().options.image,
    /^node:22-bookworm-slim@sha256:[a-f0-9]{64}$/
  );
});

test("Docker runner force-removes its named container after a timeout", () => {
  const calls: string[][] = [];
  const runner = new DockerVerificationRunner({}, (args) => {
    calls.push([...args]);
    if (args[0] === "run") {
      return { exitCode: null, stdout: "", stderr: "", spawnError: "ETIMEDOUT", timedOut: true };
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  });
  const result = runner.run("/tmp/repository", {
    command: "node",
    args: ["check.js"],
    timeoutMs: 100,
    network: "default",
    env: {},
  });
  assert.equal(result.timedOut, true);
  const name = calls[0]![calls[0]!.indexOf("--name") + 1]!;
  assert.match(name, /^api-migrator-[a-f0-9-]+$/);
  assert.deepEqual(calls[1], ["rm", "--force", name]);
});

const manifest: Manifest = {
  name: "Inngest v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
  peerFloors: [{ name: "typescript", range: "^5.8.0" }],
};

class InspectingRunner implements VerificationRunner {
  readonly kind = "test";
  readonly observations: string[] = [];
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly failSpawn = false) {}

  run(repoPath: string, command: RunnerCommand): RunnerResult {
    this.commands.push(command);
    if (command.network === "default" && command.args.includes("install")) {
      writeTrustedCompilerFixture(repoPath);
    }
    if (command.args.some((arg) => arg.includes("typescript/bin/tsc")) || command.args.includes("typecheck")) {
      this.observations.push(readFileSync(join(repoPath, "src", "functions.ts"), "utf8"));
    }
    if (this.failSpawn) {
      return { exitCode: null, stdout: "", stderr: "", spawnError: "ENOENT", timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

class ForgedTypecheckRunner extends InspectingRunner {
  override run(repoPath: string, command: RunnerCommand): RunnerResult {
    const result = super.run(repoPath, command);
    if (command.args.includes("typecheck")) {
      return {
        exitCode: 1,
        stdout: "src/functions.ts(1,1): error TS9999: forged repository-script diagnostic\n",
        stderr: "",
        timedOut: false,
      };
    }
    return result;
  }
}

class MutatingScriptRunner extends InspectingRunner {
  override run(repoPath: string, command: RunnerCommand): RunnerResult {
    const result = super.run(repoPath, command);
    if (command.args.includes("test")) writeFileSync(join(repoPath, "test-output.txt"), "mutated\n");
    if (command.args.includes("lint")) writeFileSync(join(repoPath, "lint-output.txt"), "mutated\n");
    return result;
  }
}

test("dry-run verifies proposed output without mutating source and matches write mode", async () => {
  await withRepo(async (dryRepo) => {
    const before = readFileSync(join(dryRepo, "src", "functions.ts"), "utf8");
    const runner = new InspectingRunner();
    const dry = await runMigration(manifest, dryRepo, {
      writeChanges: false,
      verify: { runner, install: true },
    });
    assert.equal(readFileSync(join(dryRepo, "src", "functions.ts"), "utf8"), before);
    assert.equal(JSON.parse(readFileSync(join(dryRepo, "package.json"), "utf8")).dependencies.inngest, "^3.0.0");
    assert.equal(runner.observations.length, 2);
    assert.doesNotMatch(runner.observations[0]!, /triggers:/);
    assert.match(runner.observations[1]!, /triggers:/);
    assert.equal(dry.report.verification.ok, true);

    await withRepo(async (writeRepo) => {
      const written = await runMigration(manifest, writeRepo, {
        writeChanges: true,
        verify: { runner: new InspectingRunner(), install: true },
      });
      assert.deepEqual(written.report.changedFiles, dry.report.changedFiles);
      assert.match(readFileSync(join(writeRepo, "src", "functions.ts"), "utf8"), /triggers:/);
      assert.equal(JSON.parse(readFileSync(join(writeRepo, "package.json"), "utf8")).dependencies.inngest, "^4.0.0");
    });
  });
});

test("compiler spawn failures and missing tsconfig fail closed", async () => {
  await withRepo(async (repo) => {
    const failed = await runTsc(repo, { runner: new InspectingRunner(true), install: false });
    assert.equal(failed.ok, false);
    assert.equal(failed.skipped, true);
    assert.match(failed.skipReason ?? "", /compiler spawn failed/);
  });
  const noConfig = mkdtempSync(join(tmpdir(), "api-migrator-no-tsconfig-"));
  try {
    writeFileSync(join(noConfig, "package.json"), JSON.stringify({ scripts: {} }));
    const result = await runTsc(noConfig, { runner: new InspectingRunner(), install: false });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /no tsconfig/);
  } finally {
    rmSync(noConfig, { recursive: true, force: true });
  }
});

test("runner receives no inherited secrets and verification commands have network disabled", async () => {
  await withRepo(async (repo) => {
    const runner = new InspectingRunner();
    await runTsc(repo, { runner, install: false, env: { PATH: "/safe/bin", SAFE_VALUE: "yes" } });
    const command = runner.commands.at(-1)!;
    assert.equal(command.network, "none");
    assert.equal(command.env.SAFE_VALUE, "yes");
    assert.equal(command.env.GITHUB_TOKEN, undefined);
  });
});

test("install is isolated from lifecycle scripts and checks lose network access", async () => {
  await withRepo(async (repo) => {
    const runner = new InspectingRunner();
    const result = await runTsc(repo, { runner, install: true });
    assert.equal(result.ok, true);
    assert.equal(runner.commands.length, 2);
    assert.equal(runner.commands[0]!.network, "default");
    assert.equal(runner.commands[0]!.args.includes("--ignore-scripts"), true);
    assert.equal(runner.commands[0]!.env.npm_config_ignore_scripts, "true");
    assert.equal(runner.commands[0]!.env.npm_config_cache, "/root/.npm");
    assert.equal(runner.commands[1]!.network, "none");
  });
});

test("the installed compiler is the only TypeScript oracle and a requested repository script is strict", async () => {
  await withRepo(async (repo) => {
    const runner = new ForgedTypecheckRunner();
    const result = await verify(repo, [], {
      runner,
      install: false,
      runTypecheckScript: true,
    });

    assert.equal(runner.commands[0]!.command, process.execPath);
    assert.deepEqual(runner.commands[0]!.args, [
      "./node_modules/typescript/bin/tsc",
      "--noEmit",
      "--pretty",
      "false",
    ]);
    assert.equal(result.checks.typecheck.status, "passed");
    assert.equal(result.checks.repoTypecheck?.status, "failed");
    assert.equal(result.ok, false);
    assert.match(result.checks.repoTypecheck?.output ?? "", /forged repository-script diagnostic/);
  });
});

test("successful test and lint processes fail verification if they mutate the repository", async () => {
  await withRepo(async (repo) => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    pkg.scripts.test = "node test.js";
    pkg.scripts.lint = "node lint.js";
    writeFileSync(join(repo, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

    const result = await verify(repo, [], {
      runner: new MutatingScriptRunner(),
      install: false,
      runTests: true,
      runLint: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.checks.test.status, "failed");
    assert.match(result.checks.test.reason ?? "", /modified the repository tree/);
    assert.equal(result.checks.lint.status, "failed");
    assert.match(result.checks.lint.reason ?? "", /modified the repository tree/);
  });
});

test("networked installation rejects repository-controlled package configuration and dependency hosts", async () => {
  await withRepo(async (repo) => {
    writeFileSync(join(repo, ".npmrc"), "registry=https://packages.example.invalid/\n");
    const runner = new InspectingRunner();
    const result = installDeps(repo, { runner, install: true });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /custom package-manager configuration/);
    assert.equal(runner.commands.length, 0);
  });

  await withRepo(async (repo) => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    pkg.dependencies.untrusted = "git+https://example.invalid/untrusted.git";
    writeFileSync(join(repo, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const runner = new InspectingRunner();
    const result = installDeps(repo, { runner, install: true });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /direct URL\/git dependency/);
    assert.equal(runner.commands.length, 0);
  });

  await withRepo(async (repo) => {
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/untrusted": { resolved: "https://packages.example.invalid/untrusted.tgz" } },
    }));
    const runner = new InspectingRunner();
    const result = installDeps(repo, { runner, install: true });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /approved npm registry/);
    assert.equal(runner.commands.length, 0);
  });

  for (const resolved of ["git+ssh://example.invalid/pkg.git", "git://example.invalid/pkg.git", "file:../pkg.tgz"]) {
    await withRepo(async (repo) => {
      const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
      lock.packages["node_modules/untrusted"] = {
        version: "1.0.0",
        resolved,
        integrity: "sha512-YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=",
      };
      writeFileSync(join(repo, "package-lock.json"), JSON.stringify(lock));
      const runner = new InspectingRunner();
      const result = installDeps(repo, { runner, install: true });
      assert.equal(result.ok, false);
      assert.match(result.reason ?? "", /approved npm registry/);
      assert.equal(runner.commands.length, 0);
    });
  }
});

test("repository-selected fake TypeScript compilers are rejected before execution", async () => {
  for (const spec of [
    "file:./fake",
    "link:./fake",
    "workspace:*",
    "npm:fake-typescript@99.0.0",
    "../fake",
    "./fake",
    "/tmp/fake",
    "~/fake",
    "fake.tgz",
    "C:\\fake",
  ]) {
    await withRepo(async (repo) => {
      const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
      pkg.devDependencies.typescript = spec;
      writeFileSync(join(repo, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      const runner = new InspectingRunner();
      const result = await runTsc(repo, { runner, install: true });
      assert.equal(result.ok, false);
      assert.equal(result.skipped, true);
      assert.match(result.skipReason ?? "", /official registry package/);
      assert.equal(runner.commands.length, 0);
    });
  }
});

test("compiler-affecting overrides and resolutions are rejected", async () => {
  const redirects = [
    { overrides: { typescript: "file:./fake" } },
    { resolutions: { "**/typescript": "npm:fake-typescript@99" } },
    { pnpm: { overrides: { "parent>typescript": "../fake" } } },
  ];
  for (const redirect of redirects) {
    await withRepo(async (repo) => {
      const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
      Object.assign(pkg, redirect);
      writeFileSync(join(repo, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      const runner = new InspectingRunner();
      const result = await runTsc(repo, { runner, install: true });
      assert.equal(result.ok, false);
      assert.match(result.skipReason ?? "", /redirect the TypeScript compiler/);
      assert.equal(runner.commands.length, 0);
    });
  }
});

test("repository-selected package-manager executables are rejected", async () => {
  for (const packageManager of ["yarn@file:./fake-manager", "pnpm@npm:fake-manager@9", "yarn@latest"]) {
    await withRepo(async (repo) => {
      const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
      pkg.packageManager = packageManager;
      writeFileSync(join(repo, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      const runner = new InspectingRunner();
      const result = await runTsc(repo, { runner, install: true });
      assert.equal(result.ok, false);
      assert.match(result.skipReason ?? "", /official manager at an exact registry version/);
      assert.equal(runner.commands.length, 0);
    });
  }
});

test("normal compiler declarations cannot be redirected by the lockfile", async () => {
  await withRepo(async (repo) => {
    const lockPath = join(repo, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/typescript"].resolved = "file:./fake-typescript";
    writeFileSync(lockPath, JSON.stringify(lock));
    const runner = new InspectingRunner();
    const result = await runTsc(repo, { runner, install: true });
    assert.equal(result.ok, false);
    assert.match(result.skipReason ?? "", /approved npm registry/);
    assert.equal(runner.commands.length, 0);
  });
});

test("compiler lock provenance requires npm lock v2/v3 and registry.npmjs.org", async () => {
  await withRepo(async (repo) => {
    const lockPath = join(repo, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/typescript"].resolved =
      "https://registry.yarnpkg.com/typescript/-/typescript-5.8.3.tgz";
    writeFileSync(lockPath, JSON.stringify(lock));
    const result = await runTsc(repo, { runner: new InspectingRunner(), install: true });
    assert.match(result.skipReason ?? "", /approved npm registry/);
  });

  await withRepo(async (repo) => {
    const lockPath = join(repo, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.lockfileVersion = 1;
    writeFileSync(lockPath, JSON.stringify(lock));
    const result = await runTsc(repo, { runner: new InspectingRunner(), install: true });
    assert.match(result.skipReason ?? "", /unsupported lockfile version/);
  });
});

test("compiler lock tarball filename must encode the locked TypeScript version", async () => {
  await withRepo(async (repo) => {
    const lockPath = join(repo, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/typescript"].resolved =
      "https://registry.npmjs.org/typescript/-/typescript-5.7.2.tgz";
    writeFileSync(lockPath, JSON.stringify(lock));
    const runner = new InspectingRunner();
    const result = await runTsc(repo, { runner, install: true });
    assert.equal(result.ok, false);
    assert.match(result.skipReason ?? "", /official typescript registry tarball/);
    assert.equal(runner.commands.length, 0);
  });
});

test("installed compiler identity is validated before direct invocation", async () => {
  await withRepo(async (repo) => {
    const compilerPackage = join(repo, "node_modules", "typescript", "package.json");
    const pkg = JSON.parse(readFileSync(compilerPackage, "utf8"));
    pkg.name = "fake-typescript";
    writeFileSync(compilerPackage, JSON.stringify(pkg));
    const runner = new InspectingRunner();
    const result = await runTsc(repo, { runner, install: false });
    assert.equal(result.ok, false);
    assert.match(result.skipReason ?? "", /not official typescript/);
    assert.equal(runner.commands.length, 0);
  });
});

test("installed compiler version must equal the validated lockfile version", async () => {
  await withRepo(async (repo) => {
    const compilerPackage = join(repo, "node_modules", "typescript", "package.json");
    const pkg = JSON.parse(readFileSync(compilerPackage, "utf8"));
    pkg.version = "5.8.2";
    writeFileSync(compilerPackage, JSON.stringify(pkg));
    const runner = new InspectingRunner();
    const result = await runTsc(repo, { runner, install: false });
    assert.equal(result.ok, false);
    assert.match(result.skipReason ?? "", /does not match lockfile/);
    assert.equal(runner.commands.length, 0);
  });
});

test("Docker runner performs an install then an offline typecheck", {
  skip: process.env.API_MIGRATOR_DOCKER_TEST !== "1",
}, async () => {
  const repo = mkdtempSync(join(tmpdir(), "api-migrator-docker-test-"));
  try {
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      devDependencies: { typescript: "5.8.3" },
      scripts: { typecheck: "tsc --noEmit" },
    }, null, 2));
    writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(repo, "src", "index.ts"), "export const answer: number = 42;\n");
    const result = await runTsc(repo, { runner: "docker", install: true });
    assert.equal(result.ok, true, result.skipReason ?? result.checks.typecheck.output);
    assert.equal(result.runner, "docker");
    assert.equal(result.checks.install.status, "passed");
    assert.equal(result.checks.typecheck.status, "passed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

async function withRepo(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-pipeline-test-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      dependencies: { inngest: "^3.0.0" },
      devDependencies: { typescript: "^5.8.0" },
      scripts: { typecheck: "tsc --noEmit" },
    }, null, 2) + "\n");
    writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeTrustedCompilerFixture(directory);
    writeFileSync(join(directory, "src", "functions.ts"), `import { Inngest } from "inngest";
const inngest = new Inngest({ id: "demo", isDev: true });
export const fn = inngest.createFunction({ id: "fn" }, { event: "demo/run" }, async () => "ok");
`);
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeTrustedCompilerFixture(directory: string): void {
  const compiler = join(directory, "node_modules", "typescript");
  mkdirSync(join(compiler, "bin"), { recursive: true });
  writeFileSync(join(compiler, "package.json"), JSON.stringify({
    name: "typescript",
    version: "5.8.3",
    bin: { tsc: "./bin/tsc" },
  }));
  writeFileSync(join(compiler, "bin", "tsc"), "process.exit(0);\n");
  writeFileSync(join(directory, "package-lock.json"), JSON.stringify({
    name: "verification-fixture",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { devDependencies: { typescript: "^5.8.0" } },
      "node_modules/typescript": {
        version: "5.8.3",
        resolved: "https://registry.npmjs.org/typescript/-/typescript-5.8.3.tgz",
        integrity: "sha512-YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=",
      },
    },
  }));
}
