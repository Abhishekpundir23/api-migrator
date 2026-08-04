import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DockerVerificationRunner,
  LocalVerificationRunner,
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

test("Docker npm-cache capacity remains bounded and cannot inject tmpfs options", () => {
  assert.equal(new DockerVerificationRunner().options.npmCacheSize, "1536m");
  assert.throws(
    () => new DockerVerificationRunner({ npmCacheSize: "1g,exec" }),
    /npm cache size/
  );
});

test("verification runners allocate isolated compiler temporary files", () => {
  const docker = new DockerVerificationRunner();
  const firstDockerFile = docker.createTemporaryFile("tsconfig.tsbuildinfo");
  const secondDockerFile = docker.createTemporaryFile("tsconfig.tsbuildinfo");
  assert.match(firstDockerFile.path, /^\/tmp\/api-migrator-[a-f0-9-]+-tsconfig\.tsbuildinfo$/);
  assert.notEqual(firstDockerFile.path, secondDockerFile.path);
  firstDockerFile.cleanup();
  secondDockerFile.cleanup();

  const localFile = new LocalVerificationRunner().createTemporaryFile("tsconfig.tsbuildinfo");
  const localRoot = dirname(localFile.path);
  writeFileSync(localFile.path, "build info");
  assert.equal(existsSync(localFile.path), true);
  localFile.cleanup();
  assert.equal(existsSync(localRoot), false);
});

test("Docker runner preserves host ownership and force-removes its named container after a timeout", () => {
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
  const runArgs = calls[0]!;
  const name = runArgs[runArgs.indexOf("--name") + 1]!;
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : 0;
  const expectedGid = typeof process.getgid === "function" ? process.getgid() : 0;
  assert.match(name, /^api-migrator-[a-f0-9-]+$/);
  assert.equal(runArgs[runArgs.indexOf("--user") + 1], `${expectedUid}:${expectedGid}`);
  assert.equal(
    runArgs.includes(`/npm-cache:rw,noexec,nosuid,size=1536m,mode=0700,uid=${expectedUid},gid=${expectedGid}`),
    true
  );
  assert.equal(runArgs[runArgs.indexOf("--memory") + 1], "3g");
  assert.deepEqual(calls[1], ["rm", "--force", name]);
});

const manifest: Manifest = {
  name: "Inngest v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  runtime: { node: { minimumMajor: 20, profile: "node22-bookworm-slim-2026-07", packageJson: "package.json", dockerfile: "Dockerfile" } },
  package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
  peerFloors: [{ name: "typescript", range: "^5.8.0" }],
};

class InspectingRunner implements VerificationRunner {
  readonly kind = "test";
  readonly observations: string[] = [];
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly failSpawn = false) {}

  createTemporaryFile(name: string) {
    return { path: `/tmp/api-migrator-test-${name}`, cleanup: () => {} };
  }

  run(repoPath: string, command: RunnerCommand): RunnerResult {
    this.commands.push(command);
    if (command.network === "default" && command.args.includes("install")) {
      writeTrustedCompilerFixture(repoPath);
    }
    if (this.failSpawn) {
      return { exitCode: null, stdout: "", stderr: "", spawnError: "ENOENT", timedOut: false };
    }
    if (command.args.includes("--showConfig")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ compilerOptions: { strict: true }, files: ["./src/functions.ts"] }),
        stderr: "",
        timedOut: false,
      };
    }
    if (command.args.some((arg) => arg.includes("typescript/bin/tsc")) || command.args.includes("typecheck")) {
      this.observations.push(readFileSync(join(repoPath, "src", "functions.ts"), "utf8"));
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

class PostInstallLockRedirectRunner extends InspectingRunner {
  override run(repoPath: string, command: RunnerCommand): RunnerResult {
    const result = super.run(repoPath, command);
    if (command.network === "default" && command.args.includes("install")) {
      const lockPath = join(repoPath, "package-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.packages["node_modules/post-install-redirect"] = {
        version: "1.0.0",
        resolved: "https://packages.example.invalid/post-install-redirect.tgz",
        integrity: "sha512-YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=",
      };
      writeFileSync(lockPath, JSON.stringify(lock));
    }
    return result;
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

class CompilerResultRunner extends InspectingRunner {
  constructor(private readonly compilerResult: RunnerResult) {
    super();
  }

  override run(repoPath: string, command: RunnerCommand): RunnerResult {
    const result = super.run(repoPath, command);
    return command.args.some((arg) => arg.includes("typescript/bin/tsc"))
      && !command.args.includes("--showConfig")
      ? this.compilerResult
      : result;
  }
}

class CompilerConfigRunner extends InspectingRunner {
  constructor(private readonly configResult: RunnerResult) {
    super();
  }

  override run(repoPath: string, command: RunnerCommand): RunnerResult {
    const result = super.run(repoPath, command);
    return command.args.includes("--showConfig") ? this.configResult : result;
  }
}

class TemporaryStorageFailureRunner extends InspectingRunner {
  constructor(private readonly failure: "allocate" | "cleanup") {
    super();
  }

  override createTemporaryFile(name: string) {
    if (this.failure === "allocate") throw new Error("temporary storage unavailable");
    return {
      path: `/tmp/api-migrator-test-${name}`,
      cleanup: () => {
        throw new Error("temporary storage cleanup failed");
      },
    };
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

class ConcurrentTargetMutationRunner extends InspectingRunner {
  private mutated = false;

  constructor(private readonly mutateTarget: () => void) {
    super();
  }

  override run(repoPath: string, command: RunnerCommand): RunnerResult {
    const result = super.run(repoPath, command);
    if (!this.mutated && command.args.includes("--showConfig")) {
      this.mutateTarget();
      this.mutated = true;
    }
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
    assert.equal(dry.report.verification.checks.runtime?.status, "passed");
    assert.equal(dry.report.changedFiles.includes("Dockerfile"), true);
    const checkpointingReview = dry.report.entries.find((entry) => entry.code === "F12");
    assert.equal(checkpointingReview?.kind, "review");
    assert.match(checkpointingReview?.message ?? "", /runtime container is unknown/i);

    await withRepo(async (writeRepo) => {
      const written = await runMigration(manifest, writeRepo, {
        writeChanges: true,
        verify: { runner: new InspectingRunner(), install: true },
      });
      assert.deepEqual(written.report.changedFiles, dry.report.changedFiles);
      assert.match(readFileSync(join(writeRepo, "src", "functions.ts"), "utf8"), /triggers:/);
      const writtenPackage = JSON.parse(readFileSync(join(writeRepo, "package.json"), "utf8"));
      assert.equal(writtenPackage.dependencies.inngest, "^4.0.0");
      assert.equal(writtenPackage.engines.node, ">=20");
      assert.match(readFileSync(join(writeRepo, "Dockerfile"), "utf8"), /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64} AS base$/m);
      assert.doesNotMatch(readFileSync(join(writeRepo, "Dockerfile"), "utf8"), /ARG NODE_VERSION/);
    });
  });
});

test("write mode rejects a concurrent target edit before applying any candidate file", async () => {
  await withRepo(async (repo) => {
    const packageBefore = readFileSync(join(repo, "package.json"));
    const dockerfileBefore = readFileSync(join(repo, "Dockerfile"));
    const externalEdit = "// concurrent operator edit; migration must not overwrite this\n";

    await assert.rejects(
      () => runMigration(manifest, repo, {
        writeChanges: true,
        verify: {
          runner: new ConcurrentTargetMutationRunner(() => {
            writeFileSync(join(repo, "src", "functions.ts"), externalEdit);
          }),
          install: true,
        },
      }),
      /Repository tree changed after migration planning|Repository file changed after migration planning/
    );

    assert.deepEqual(readFileSync(join(repo, "package.json")), packageBefore);
    assert.deepEqual(readFileSync(join(repo, "Dockerfile")), dockerfileBefore);
    assert.equal(readFileSync(join(repo, "src", "functions.ts"), "utf8"), externalEdit);
    const names = [
      ...readdirSync(repo),
      ...readdirSync(join(repo, "src")),
    ];
    assert.equal(names.some((name) => name.includes(".api-migrator-") && /\.(?:stage|backup)$/.test(name)), false);
  });
});

test("write mode rejects a parent-directory symlink swap without writing outside the repository", async () => {
  const external = mkdtempSync(join(tmpdir(), "api-migrator-external-"));
  try {
    await withRepo(async (repo) => {
      const packageBefore = readFileSync(join(repo, "package.json"));
      const dockerfileBefore = readFileSync(join(repo, "Dockerfile"));
      const sourceBefore = readFileSync(join(repo, "src", "functions.ts"));
      writeFileSync(join(external, "functions.ts"), sourceBefore);

      await assert.rejects(
        () => runMigration(manifest, repo, {
          writeChanges: true,
          verify: {
            runner: new ConcurrentTargetMutationRunner(() => {
              renameSync(join(repo, "src"), join(repo, "src-original"));
              symlinkSync(external, join(repo, "src"), "dir");
            }),
            install: true,
          },
        }),
        /Repository tree changed after migration planning|Migration output parent must be a real directory/
      );

      assert.deepEqual(readFileSync(join(repo, "package.json")), packageBefore);
      assert.deepEqual(readFileSync(join(repo, "Dockerfile")), dockerfileBefore);
      assert.deepEqual(readFileSync(join(external, "functions.ts")), sourceBefore);
      assert.deepEqual(readFileSync(join(repo, "src-original", "functions.ts")), sourceBefore);
    });
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("write mode preserves an unchanged relative symlink", async () => {
  await withRepo(async (repo) => {
    writeFileSync(join(repo, "runtime-notes.txt"), "notes\n");
    symlinkSync("runtime-notes.txt", join(repo, "runtime-notes-link"));

    const result = await runMigration(manifest, repo, {
      writeChanges: true,
      verify: { runner: new InspectingRunner(), install: true },
    });

    assert.equal(result.report.verification.ok, true);
    assert.equal(readlinkSync(join(repo, "runtime-notes-link")), "runtime-notes.txt");
    assert.equal(readFileSync(join(repo, "runtime-notes-link"), "utf8"), "notes\n");
  });
});

test("migration pipeline requires provider and changed sources in the compiler program", async () => {
  await withRepo(async (repo) => {
    const runner = new CompilerConfigRunner({
      exitCode: 0,
      stdout: JSON.stringify({ files: ["./src/unrelated.ts"] }),
      stderr: "",
      timedOut: false,
    });
    const result = await runMigration(manifest, repo, {
      writeChanges: false,
      verify: { runner, install: true },
    });

    assert.equal(result.report.verification.ok, false);
    assert.equal(result.report.verification.skipped, true);
    assert.match(result.report.verification.skipReason ?? "", /excludes required migration source/);
    assert.equal(runner.commands.some((command) => command.args.includes("--noEmit")), false);
  });
});

test("compiler spawn failures and missing tsconfig fail closed", async () => {
  await withRepo(async (repo) => {
    const failed = await runTsc(repo, { runner: new InspectingRunner(true), install: false });
    assert.equal(failed.ok, false);
    assert.equal(failed.skipped, true);
    assert.match(failed.skipReason ?? "", /spawn failed/);
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

test("compiler temporary-storage failures fail closed", async () => {
  for (const failure of ["allocate", "cleanup"] as const) {
    await withRepo(async (repo) => {
      const runner = new TemporaryStorageFailureRunner(failure);
      const result = await runTsc(repo, { runner, install: false });

      assert.equal(result.ok, false);
      assert.equal(result.skipped, true);
      assert.equal(result.checks.typecheck.status, "failed");
      assert.match(result.skipReason ?? "", failure === "allocate" ? /could not allocate/ : /failed to clean/);
      assert.equal(
        runner.commands.some((command) => command.args.includes("--noEmit")),
        failure === "cleanup"
      );
    });
  }
});

test("global compiler diagnostics fail closed even without file diagnostics", async () => {
  await withRepo(async (repo) => {
    const result = await runTsc(repo, {
      runner: new CompilerResultRunner({
        exitCode: 2,
        stdout: "error TS5033: Could not write file '/workspace/tsconfig.tsbuildinfo': EROFS\n",
        stderr: "",
        timedOut: false,
      }),
      install: false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.checks.typecheck.status, "failed");
    assert.equal(result.checks.typecheck.exitCode, 2);
    assert.match(result.checks.typecheck.output, /TS5033/);
    assert.match(result.skipReason ?? "", /non-file TypeScript diagnostic TS5033/);
  });
});

test("global compiler diagnostics cannot be hidden by baseline-matched file errors", async () => {
  await withRepo(async (repo) => {
    const existing = {
      file: "src/functions.ts",
      line: 1,
      col: 1,
      code: "TS2307",
      message: "Cannot find module '@upstash/redis' or its corresponding type declarations.",
      raw: "src/functions.ts(1,1): error TS2307: Cannot find module '@upstash/redis' or its corresponding type declarations.",
    };
    const result = await verify(repo, [existing], {
      runner: new CompilerResultRunner({
        exitCode: 2,
        stdout: [
          "error TS5033: Could not write file '/workspace/tsconfig.tsbuildinfo': EROFS",
          ...Array.from({ length: 400 }, () => existing.raw),
          "",
        ].join("\n"),
        stderr: "",
        timedOut: false,
      }),
      install: false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.checks.typecheck.status, "failed");
    assert.match(result.checks.typecheck.output, /TS2307/);
    assert.doesNotMatch(result.checks.typecheck.output, /TS5033/);
    assert.match(result.skipReason ?? "", /non-file TypeScript diagnostic TS5033/);
    assert.notEqual(result.checks.typecheck.reason, "only pre-existing errors remain");
  });
});

test("configuration diagnostics cannot become baseline exceptions", async () => {
  await withRepo(async (repo) => {
    const configError = {
      file: "tsconfig.json",
      line: 1,
      col: 30,
      code: "TS5024",
      message: "Compiler option 'strict' requires a value of type boolean.",
      raw: "tsconfig.json(1,30): error TS5024: Compiler option 'strict' requires a value of type boolean.",
    };
    const result = await verify(repo, [configError], {
      runner: new CompilerResultRunner({
        exitCode: 2,
        stdout: `${configError.raw}\n`,
        stderr: "",
        timedOut: false,
      }),
      install: false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.checks.typecheck.status, "failed");
    assert.match(result.skipReason ?? "", /configuration diagnostic TS5024/);
  });
});

test("solution-style and empty TypeScript roots fail closed", async () => {
  const configurations = [
    {
      config: { files: [], references: [{ path: "./packages/service" }] },
      reason: /does not yet support TypeScript project references/,
    },
    {
      config: { compilerOptions: { strict: true }, files: [] },
      reason: /does not select any verifiable source files/,
    },
  ];

  for (const { config, reason } of configurations) {
    await withRepo(async (repo) => {
      const runner = new CompilerConfigRunner({
        exitCode: 0,
        stdout: JSON.stringify(config),
        stderr: "",
        timedOut: false,
      });
      const result = await runTsc(repo, { runner, install: false });

      assert.equal(result.ok, false);
      assert.equal(result.skipped, true);
      assert.match(result.skipReason ?? "", reason);
      assert.equal(runner.commands.some((command) => command.args.includes("--noEmit")), false);
    });
  }
});

test("trusted TypeScript verification rejects compilerOptions.noCheck", async () => {
  await withRepo(async (repo) => {
    const runner = new CompilerConfigRunner({
      exitCode: 0,
      stdout: JSON.stringify({
        compilerOptions: { noCheck: true },
        files: ["./src/functions.ts"],
      }),
      stderr: "",
      timedOut: false,
    });
    const result = await runTsc(repo, { runner, install: false });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /forbids compilerOptions\.noCheck/);
    assert.equal(runner.commands.some((command) => command.args.includes("--noEmit")), false);
  });
});

test("trusted TypeScript verification requires checkJs for migrated JavaScript", async () => {
  await withRepo(async (repo) => {
    writeFileSync(join(repo, "src", "functions.js"), "export const value = unknownName;\n");
    const runner = new CompilerConfigRunner({
      exitCode: 0,
      stdout: JSON.stringify({
        compilerOptions: { allowJs: true, checkJs: false },
        files: ["./src/functions.js"],
      }),
      stderr: "",
      timedOut: false,
    });
    const result = await runTsc(repo, {
      runner,
      install: false,
      requiredFiles: ["src/functions.js"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /does not type-check required JavaScript source/);
    assert.equal(runner.commands.some((command) => command.args.includes("--noEmit")), false);
  });
});

test("required migration sources cannot disable compiler checking", async () => {
  await withRepo(async (repo) => {
    writeFileSync(
      join(repo, "src", "functions.ts"),
      "\uFEFF// @ts-nocheck\nexport const value: number = 'unchecked';\n"
    );
    const runner = new CompilerConfigRunner({
      exitCode: 0,
      stdout: JSON.stringify({
        compilerOptions: { strict: true },
        files: ["./src/functions.ts"],
      }),
      stderr: "",
      timedOut: false,
    });
    const result = await runTsc(repo, {
      runner,
      install: false,
      requiredFiles: ["src/functions.ts"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /disables TypeScript checking/);
    assert.equal(runner.commands.some((command) => command.args.includes("--noEmit")), false);
  });
});

test("trusted compiler must select every required migration source", async () => {
  await withRepo(async (repo) => {
    const runner = new CompilerConfigRunner({
      exitCode: 0,
      stdout: JSON.stringify({ files: ["./src/unrelated.ts"] }),
      stderr: "",
      timedOut: false,
    });
    const result = await runTsc(repo, {
      runner,
      install: false,
      requiredFiles: ["src/functions.ts"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /excludes required migration source: src\/functions\.ts/);
    assert.equal(runner.commands.some((command) => command.args.includes("--noEmit")), false);
  });
});

test("baseline-matched file diagnostics remain comparable", async () => {
  await withRepo(async (repo) => {
    const headline = "Cannot find module '@upstash/redis' or its corresponding type declarations.";
    const continuation = "  The imported package could not be resolved.";
    const existing = {
      file: "src/functions.ts",
      line: 1,
      col: 1,
      code: "TS2307",
      message: `${headline}\n${continuation}`,
      raw: `src/functions.ts(1,1): error TS2307: ${headline}\n${continuation}`,
    };
    const result = await verify(repo, [existing], {
      runner: new CompilerResultRunner({
        exitCode: 2,
        stdout: `${existing.raw}\n`,
        stderr: "",
        timedOut: false,
      }),
      install: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.checks.typecheck.status, "passed");
    assert.equal(result.checks.typecheck.reason, "only pre-existing errors remain");
    assert.deepEqual(result.introduced, []);
  });
});

test("baseline comparison includes multiline diagnostic details", async () => {
  await withRepo(async (repo) => {
    const headline = "Type 'Input' is not assignable to type 'Output'.";
    const baseline = {
      file: "src/functions.ts",
      line: 1,
      col: 1,
      code: "TS2322",
      message: `${headline}\n  Property 'old' is missing.`,
      raw: `src/functions.ts(1,1): error TS2322: ${headline}\n  Property 'old' is missing.`,
    };
    const result = await verify(repo, [baseline], {
      runner: new CompilerResultRunner({
        exitCode: 2,
        stdout: `src/functions.ts(1,1): error TS2322: ${headline}\n  Property 'new' is missing.\n`,
        stderr: "",
        timedOut: false,
      }),
      install: false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.equal(result.introduced.length, 1);
    assert.match(result.introduced[0]?.message ?? "", /Property 'new'/);
  });
});

test("compiler crashes cannot hide behind baseline-matched file diagnostics", async () => {
  await withRepo(async (repo) => {
    const existing = {
      file: "src/functions.ts",
      line: 1,
      col: 1,
      code: "TS2307",
      message: "Cannot find module '@upstash/redis' or its corresponding type declarations.",
      raw: "src/functions.ts(1,1): error TS2307: Cannot find module '@upstash/redis' or its corresponding type declarations.",
    };
    const result = await verify(repo, [existing], {
      runner: new CompilerResultRunner({
        exitCode: 1,
        stdout: `${existing.raw}\n`,
        stderr: "TypeError: compiler crashed\n    at compile (/trusted/tsc.js:1:1)\n",
        timedOut: false,
      }),
      install: false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.checks.typecheck.status, "failed");
    assert.match(result.skipReason ?? "", /unclassified output/);
  });
});

test("baseline comparison is column-aware and count-sensitive", async () => {
  const baseline = {
    file: "src/functions.ts",
    line: 1,
    col: 1,
    code: "TS2307",
    message: "Cannot find module 'missing'.",
    raw: "src/functions.ts(1,1): error TS2307: Cannot find module 'missing'.",
  };
  const variants = [
    `${baseline.raw}\nsrc/functions.ts(1,2): error TS2307: ${baseline.message}\n`,
    `${baseline.raw}\n${baseline.raw}\n`,
  ];

  for (const stdout of variants) {
    await withRepo(async (repo) => {
      const result = await verify(repo, [baseline], {
        runner: new CompilerResultRunner({ exitCode: 2, stdout, stderr: "", timedOut: false }),
        install: false,
      });

      assert.equal(result.ok, false);
      assert.equal(result.skipped, false);
      assert.equal(result.checks.typecheck.status, "failed");
      assert.equal(result.introduced.length, 1);
    });
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
    assert.equal(runner.commands.length, 3);
    assert.equal(runner.commands[0]!.network, "default");
    assert.equal(runner.commands[0]!.args.includes("--ignore-scripts"), true);
    assert.equal(runner.commands[0]!.env.npm_config_ignore_scripts, "true");
    assert.equal(runner.commands[0]!.env.npm_config_engine_strict, "true");
    assert.equal(runner.commands[0]!.env.npm_config_cache, "/npm-cache");
    assert.equal(runner.commands[1]!.args.includes("--showConfig"), true);
    assert.equal(runner.commands[1]!.network, "none");
    assert.equal(runner.commands[2]!.network, "none");
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

    const compilerCommand = runner.commands.find((command) => command.args.includes("--noEmit"))!;
    assert.equal(compilerCommand.command, process.execPath);
    assert.deepEqual(compilerCommand.args.slice(0, 4), [
      "./node_modules/typescript/bin/tsc",
      "--noEmit",
      "--pretty",
      "false",
    ]);
    assert.equal(compilerCommand.args[4], "--tsBuildInfoFile");
    assert.equal(compilerCommand.args[5], "/tmp/api-migrator-test-tsconfig.tsbuildinfo");
    assert.match(
      result.checks.typecheck.command ?? "",
      /--tsBuildInfoFile <runner-temp>\/tsconfig\.tsbuildinfo$/
    );
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

test("networked installation rejects local dependency sources even when the existing lockfile is trusted", async () => {
  for (const spec of [
    "file:./evil.tgz",
    "./evil",
    "../evil",
    "/tmp/evil",
    "~/evil",
    "evil.tgz",
    "workspace:*",
    "C:\\evil",
  ]) {
    await withRepo(async (repo) => {
      const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
      pkg.dependencies.evil = spec;
      writeFileSync(join(repo, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      const runner = new InspectingRunner();
      const result = installDeps(repo, { runner, install: true });
      assert.equal(result.ok, false, spec);
      assert.match(result.reason ?? "", /non-registry dependency/, spec);
      assert.equal(runner.commands.length, 0, spec);
    });
  }
});

test("networked installation rejects non-registry override and resolution leaves", async () => {
  const redirects = [
    { overrides: { inngest: "https://evil.invalid/inngest.tgz" } },
    { resolutions: { "**/inngest": "file:./evil.tgz" } },
    { pnpm: { overrides: { inngest: "../evil" } } },
  ];
  for (const redirect of redirects) {
    await withRepo(async (repo) => {
      const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
      Object.assign(pkg, redirect);
      writeFileSync(join(repo, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      const runner = new InspectingRunner();
      const result = installDeps(repo, { runner, install: true });
      assert.equal(result.ok, false);
      assert.match(result.reason ?? "", /non-registry (?:overrides|resolutions|pnpm\.overrides) value/);
      assert.equal(runner.commands.length, 0);
    });
  }
});

test("networked installation permits official registry semver, tags, and npm aliases", async () => {
  for (const spec of [
    "^4.17.0",
    ">=4 <5",
    "latest",
    "npm:lodash@^4.17.0",
    "npm:@scope/example@next",
    "npm:lodash",
  ]) {
    await withRepo(async (repo) => {
      const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
      pkg.dependencies.allowed = spec;
      pkg.overrides = { allowed: spec };
      writeFileSync(join(repo, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      const runner = new InspectingRunner();
      const result = installDeps(repo, { runner, install: true });
      assert.equal(result.ok, true, `${spec}: ${result.reason ?? "unexpected failure"}`);
      assert.equal(runner.commands.length, 1, spec);
    });
  }
});

test("successful installation revalidates rewritten lockfile provenance", async () => {
  await withRepo(async (repo) => {
    const runner = new PostInstallLockRedirectRunner();
    const result = installDeps(repo, { runner, install: true });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /post-install dependency trust validation failed/);
    assert.match(result.reason ?? "", /approved npm registry/);
    assert.equal(result.check.status, "failed");
    assert.equal(runner.commands.length, 1);
  });
});

test("networked installation rejects all custom package-manager arguments", async () => {
  const cases: Array<[label: string, installArgs: string[]]> = [
    ["long force", ["--force"]],
    ["assigned short force", ["-f=true"]],
    ["leading clustered force", ["-fD"]],
    ["trailing clustered force", ["-Df"]],
    ["split lifecycle override", ["--ignore-scripts", "false"]],
    ["abbreviated lifecycle override", ["--ig", "false"]],
    ["single-dash lifecycle override", ["-ignore-scripts", "false"]],
    ["negated lifecycle override", ["--no-ignore-scripts"]],
    ["split engine-strict override", ["--engine-strict", "false"]],
    ["registry override", ["--registry", "https://packages.example.invalid/"]],
    ["otherwise benign custom option", ["--prefer-offline"]],
  ];
  for (const [label, installArgs] of cases) {
    await withRepo(async (repo) => {
      const runner = new InspectingRunner();
      const result = installDeps(repo, { runner, install: true, installArgs });
      assert.equal(result.ok, false, label);
      assert.match(result.reason ?? "", /custom install arguments are not allowed/, label);
      assert.equal(runner.commands.length, 0, label);
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
    writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, incremental: true },
    }));
    writeFileSync(join(repo, "src", "index.ts"), "export const answer: number = 42;\n");
    const result = await runTsc(repo, {
      runner: "docker",
      install: true,
      requiredFiles: ["src/index.ts"],
    });
    const failureDetails = [
      result.skipReason,
      result.checks.install.reason,
      result.checks.install.output,
      result.checks.typecheck.reason,
      result.checks.typecheck.output,
    ].filter(Boolean).join("\n");
    assert.equal(result.ok, true, failureDetails);
    assert.equal(result.runner, "docker");
    assert.equal(result.checks.install.status, "passed");
    assert.equal(result.checks.typecheck.status, "passed");
    assert.equal(existsSync(join(repo, "tsconfig.tsbuildinfo")), false);
    if (typeof process.getuid === "function") {
      assert.equal(lstatSync(join(repo, "package-lock.json")).uid, process.getuid());
    }

    writeFileSync(join(repo, "src", "index.ts"), "export const answer: number = 'wrong';\n");
    const baseline = await runTsc(repo, {
      runner: "docker",
      install: false,
      requiredFiles: ["src/index.ts"],
    });
    assert.equal(baseline.skipped, false);
    assert.equal(baseline.after.length, 1);
    const compared = await verify(repo, baseline.after, {
      runner: "docker",
      install: false,
      requiredFiles: ["src/index.ts"],
    });
    assert.equal(compared.ok, true, compared.skipReason ?? compared.checks.typecheck.reason);
    assert.equal(compared.checks.typecheck.status, "passed");
    assert.equal(compared.checks.typecheck.reason, "only pre-existing errors remain");
    assert.equal(existsSync(join(repo, "tsconfig.tsbuildinfo")), false);
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
    writeFileSync(join(directory, "Dockerfile"), `# syntax = docker/dockerfile:1

ARG NODE_VERSION=18.8.0
FROM node:\${NODE_VERSION}-slim as base

LABEL fly_launch_runtime="Next.js"
WORKDIR /app
ENV NODE_ENV=production

FROM base AS build
RUN apt-get update -qq && \\
    apt-get install -y python-is-python3 pkg-config build-essential
COPY --link package-lock.json package.json ./
RUN npm ci --include=dev
COPY --link . .
RUN npm run build
RUN npm prune --omit=dev

FROM base
COPY --from=build /app /app
EXPOSE 3000
CMD [ "npm", "run", "start" ]
`);
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
