import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  createPublicationRunnerPlan,
} from "../../../packages/app/dist/runner-internal.js";
import { createSourceBundle } from "../../../packages/runner/dist/index.js";

const image = process.argv[2];
if (!image || !/^[A-Za-z0-9._/:@+-]+$/.test(image)) {
  throw new Error("usage: run-phase-integration.mjs IMAGE");
}
const root = mkdtempSync(join(tmpdir(), "api-migrator-image-integration-"));
try {
  const checkout = join(root, "checkout");
  const dependencies = join(root, "dependencies");
  const installation = join(root, "installation");
  const output = join(root, "output");
  const result = join(root, "result");
  for (const path of [checkout, dependencies, installation, output, result]) mkdirSync(path, { mode: 0o700 });
  prepareFixture(checkout);
  git(checkout, ["init", "--initial-branch=main"]);
  git(checkout, ["add", "--all"]);
  git(checkout, [
    "-c", "user.name=Runner Integration", "-c", "user.email=runner@example.invalid",
    "commit", "--no-gpg-sign", "--message", "runner integration fixture",
  ]);
  const baseSha = git(checkout, ["rev-parse", "HEAD"]).trim();
  const baseTreeSha = git(checkout, ["rev-parse", "HEAD^{tree}"]).trim();
  const manifest = {
    name: "Inngest TypeScript SDK v3 -> v4",
    provider: "inngest",
    transformSet: "inngest-v3-to-v4",
    runtime: {
      node: {
        minimumMajor: 20,
        profile: "node22-bookworm-slim-2026-07",
        packageJson: "package.json",
        dockerfile: "Dockerfile",
      },
    },
    package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
    peerFloors: [{ name: "typescript", range: "^5.8.0" }],
    // Exercise only deterministic transforms in this blocker-free protocol
    // fixture. A real campaign that enables deployment-specific F12 remains
    // blocked until its runtime-container behavior is independently reviewed.
    transforms: ["T1", "T2", "T3", "T4", "T5"],
  };
  const manifestJson = canonicalJson(manifest);
  const repository = { slug: "sandbox-owner/runner-fixture", id: 910_001, ownerId: 910_002 };
  const bundle = createSourceBundle({
    checkoutPath: checkout,
    repository,
    base: { branch: "main", sha: baseSha, treeSha: baseTreeSha },
    manifestJson,
  });
  const addresses = [...new Set((await lookup("registry.npmjs.org", { all: true }))
    .map((entry) => entry.address))].sort();
  assert(addresses.length > 0 && addresses.length <= 32);
  const now = Date.now();
  const imageDigest = docker(["image", "inspect", "--format", "{{.Id}}", image]).trim();
  const plan = createPublicationRunnerPlan({
    pilotId: "pilot_runner_image_integration",
    repository,
    base: { branch: "main", sha: baseSha },
    sourceArchiveDigest: bundle.digest,
    manifestDigest: digest(manifestJson),
    imageDigest,
    migrationInstallEgress: [{
      host: "registry.npmjs.org",
      protocol: "tcp",
      port: 443,
      tls: true,
      addresses,
      resolutionEvidenceDigest: digest(addresses.join("\n")),
      resolutionObservedAt: now,
      resolutionExpiresAt: now + 20 * 60 * 1_000,
    }],
    expiresAt: now + 14 * 60 * 1_000,
    now,
  });
  const planPath = join(root, "plan.json");
  const sourcePath = join(root, "source.bundle");
  writeFileSync(planPath, plan.canonicalJson, { mode: 0o600 });
  writeFileSync(sourcePath, bundle.bytes, { mode: 0o600 });
  chmodSync(planPath, 0o600);
  chmodSync(sourcePath, 0o600);

  const prepareOutput = runPhase(commonDockerArgs(image, "none"), [
    bind(planPath, "/run/api-migrator/plan.json", true),
    bind(sourcePath, "/run/api-migrator/source.bundle", true),
    bind(dependencies, "/run/api-migrator/dependencies", false),
    bind(installation, "/run/api-migrator/installation", false),
  ], [
    "prepare", "--plan", "/run/api-migrator/plan.json", "--source", "/run/api-migrator/source.bundle",
    "--dependencies", "/run/api-migrator/dependencies", "--installation", "/run/api-migrator/installation",
  ]);
  const prepareMatch = exactPhaseOutput(
    prepareOutput,
    /^runner_phase=prepare status=passed prepared_state_digest=(sha256:[a-f0-9]{64})\n$/,
    "prepare"
  );
  const preparedStateDigest = prepareMatch[1];
  assert.equal(existsSync(join(installation, "baseline", "src")), false);
  assert.equal(existsSync(join(installation, "candidate", "Dockerfile")), false);

  const installOutput = runPhase(commonDockerArgs(image, "bridge"), [
    bind(planPath, "/run/api-migrator/plan.json", true),
    bind(installation, "/run/api-migrator/installation", false),
  ], [
    "install", "--plan", "/run/api-migrator/plan.json", "--installation", "/run/api-migrator/installation",
    "--prepared-state-digest", preparedStateDigest,
  ], addresses);
  const installMatch = exactPhaseOutput(
    installOutput,
    new RegExp(`^runner_phase=install status=passed prepared_state_digest=${preparedStateDigest} install_state_digest=(sha256:[a-f0-9]{64})\\n$`),
    "install"
  );
  const installStateDigest = installMatch[1];
  assert.equal(existsSync(join(installation, "baseline", "LIFECYCLE_RAN")), false);
  assert.equal(existsSync(join(installation, "candidate", "LIFECYCLE_RAN")), false);

  const migrateOutput = runPhase(commonDockerArgs(image, "none"), [
    bind(planPath, "/run/api-migrator/plan.json", true),
    bind(sourcePath, "/run/api-migrator/source.bundle", true),
    bind(dependencies, "/run/api-migrator/dependencies", false),
    bind(installation, "/run/api-migrator/installation", true),
    bind(output, "/run/api-migrator/output", false),
  ], [
    "migrate", "--plan", "/run/api-migrator/plan.json", "--source", "/run/api-migrator/source.bundle",
    "--dependencies", "/run/api-migrator/dependencies", "--installation", "/run/api-migrator/installation",
    "--prepared-state-digest", preparedStateDigest, "--install-state-digest", installStateDigest,
    "--output", "/run/api-migrator/output",
  ]);
  const migrateMatch = exactPhaseOutput(
    migrateOutput,
    /^runner_phase=migrate status=passed dependency_state_digest=(sha256:[a-f0-9]{64})\n$/,
    "migrate"
  );
  const dependencyStateDigest = migrateMatch[1];

  const verifyOutput = runPhase(commonDockerArgs(image, "none"), [
    bind(planPath, "/run/api-migrator/plan.json", true),
    bind(output, "/run/api-migrator/input", true),
    bind(dependencies, "/run/api-migrator/dependencies", true),
    bind(result, "/run/api-migrator/result", false),
  ], [
    "verify", "--plan", "/run/api-migrator/plan.json", "--input", "/run/api-migrator/input",
    "--dependencies", "/run/api-migrator/dependencies", "--dependency-state-digest", dependencyStateDigest,
    "--result", "/run/api-migrator/result",
  ]);

  const evidenceText = readFileSync(join(result, "runner-evidence.json"), "utf8");
  const evidence = JSON.parse(evidenceText);
  assert.equal(evidenceText, canonicalJson(evidence));
  assert.equal(evidence.planDigest, plan.digest);
  assert.match(evidence.output.preflightId, /^pf_[a-f0-9]{64}$/);
  assert.match(evidence.output.artifactDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(evidence.output.candidateTreeSha, /^[a-f0-9]{40}$/);
  for (const name of ["install", "typecheck", "test", "lint", "runtime"]) {
    assert.equal(evidence.checks[name].status, "passed", name);
  }
  assert.equal(evidence.report.verification.ok, true);
  assert.equal(evidence.report.verification.skipped, false);
  assert.deepEqual(evidence.blockers, []);
  assert.equal(
    verifyOutput,
    `runner_phase=verify status=passed evidence_digest=${digest(evidenceText)} preflight_id=${evidence.output.preflightId}\n`
  );
  process.stdout.write(`${JSON.stringify({
    image,
    planDigest: plan.digest,
    evidenceDigest: digest(evidenceText),
    output: evidence.output,
    phaseIntegration: "passed",
    securityDrill: false,
  })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function prepareFixture(checkout) {
  mkdirSync(join(checkout, "src"));
  writeFileSync(join(checkout, "package.json"), `${JSON.stringify({
    name: "runner-integration-fixture",
    private: true,
    type: "module",
    scripts: {
      preinstall: "node -e \"require('node:fs').writeFileSync('LIFECYCLE_RAN','unsafe')\"",
      test: "node --test test.mjs",
      lint: "node lint.mjs",
    },
    dependencies: { inngest: "^3.0.0" },
    devDependencies: { "@types/node": "^20.0.0", typescript: "^5.8.0" },
  }, null, 2)}\n`);
  writeFileSync(join(checkout, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
    include: ["src/**/*.ts"],
  }, null, 2)}\n`);
  writeFileSync(join(checkout, "src", "functions.ts"), `import { Inngest } from "inngest";
const inngest = new Inngest({ id: "runner-fixture", isDev: true });
export const fn = inngest.createFunction({ id: "hello" }, { event: "demo/hello" }, async () => "ok");
`);
  writeFileSync(join(checkout, "test.mjs"), `import test from "node:test";
import assert from "node:assert/strict";
test("fixture", () => assert.equal(2 + 2, 4));
`);
  writeFileSync(join(checkout, "lint.mjs"), "process.exitCode = 0;\n");
  writeFileSync(join(checkout, "Dockerfile"), `# syntax = docker/dockerfile:1

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
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: checkout,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: join(checkout, ".npm-home"),
      npm_config_cache: join(checkout, ".npm-cache"),
      npm_config_strict_ssl: "true",
      npm_config_registry: "https://registry.npmjs.org/",
    },
  });
  rmSync(join(checkout, ".npm-home"), { recursive: true, force: true });
  rmSync(join(checkout, ".npm-cache"), { recursive: true, force: true });
}

function commonDockerArgs(selectedImage, network) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return [
    "run", "--rm", "--pull=never", "--read-only", "--cap-drop=all",
    "--security-opt=no-new-privileges", "--pids-limit=256", "--memory=2g", "--cpus=2",
    "--user", `${uid}:${gid}`, "--network", network,
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=536870912,mode=1777,uid=${uid},gid=${gid}`,
    "--tmpfs", `/npm-cache:rw,noexec,nosuid,nodev,size=268435456,mode=0700,uid=${uid},gid=${gid}`,
    "--entrypoint", "/usr/local/bin/api-migrator-runner",
    "--env", "HOME=/tmp", "--env", "PATH=/usr/local/bin:/usr/bin:/bin",
    selectedImage,
  ];
}

function runPhase(common, mounts, runnerArgs, addresses = []) {
  const imageIndex = common.length - 1;
  const prefix = common.slice(0, imageIndex);
  const selectedImage = common[imageIndex];
  const hostArgs = addresses.flatMap((address) => ["--add-host", `registry.npmjs.org:${address}`]);
  const output = docker([...prefix, ...hostArgs, ...mounts.flat(), selectedImage, ...runnerArgs]);
  return output;
}

function exactPhaseOutput(output, pattern, phase) {
  const match = output.match(pattern);
  assert(match, `${phase} must emit exactly one trusted status line`);
  return match;
}

function bind(source, target, readOnly) {
  return ["--mount", `type=bind,src=${resolve(source)},dst=${target}${readOnly ? ",readonly" : ""}`];
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
