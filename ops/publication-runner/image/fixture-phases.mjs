import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson, createPublicationRunnerPlan } from "../../../packages/app/dist/runner-internal.js";
import { createSourceBundle } from "../../../packages/runner/dist/index.js";
import { verifyFixtureIdentity } from "../../../scripts/test-git-identity.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export function fixtureContainerNames(plan) {
  const jobId = plan?.plan?.job?.id;
  if (typeof jobId !== "string" || !/^previewjob_[a-f0-9]{64}$/.test(jobId)) {
    throw new TypeError("fixture plan job identity invalid");
  }
  return Object.fromEntries(["prepare", "install", "migrate", "verify"]
    .map((phase) => [phase, `api-migrator-fixture-${jobId}-${phase}`]));
}

export function prepareFixtureWorkspace(root) {
  if (typeof root !== "string" || !isAbsolute(root)) throw new TypeError("fixture root must be absolute");
  const paths = Object.fromEntries(["checkout", "dependencies", "installation", "output", "result"]
    .map((name) => [name, join(root, name)]));
  paths.planPath = join(root, "plan.json");
  paths.sourcePath = join(root, "source.bundle");
  for (const path of Object.values(paths).slice(0, 5)) mkdirSync(path, { mode: 0o700 });
  prepareFixture(paths.checkout);
  git(paths.checkout, ["init", "--initial-branch=main"]);
  git(paths.checkout, ["add", "--all"]);
  git(paths.checkout, ["commit", "--no-gpg-sign", "--message", "runner integration fixture"]);
  const baseSha = git(paths.checkout, ["rev-parse", "HEAD"]).trim();
  const baseTreeSha = git(paths.checkout, ["rev-parse", "HEAD^{tree}"]).trim();
  const manifest = {
    name: "Inngest TypeScript SDK v3 -> v4",
    provider: "inngest",
    transformSet: "inngest-v3-to-v4",
    deployment: { kind: "long-running" },
    runtime: { node: {
      minimumMajor: 20,
      profile: "node22-bookworm-slim-2026-07",
      packageJson: "package.json",
      dockerfile: "Dockerfile",
    } },
    package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
    peerFloors: [{ name: "typescript", range: "^5.8.0" }],
  };
  const manifestJson = canonicalJson(manifest);
  const repository = { slug: "sandbox-owner/runner-fixture", id: 910_001, ownerId: 910_002 };
  const base = { branch: "main", sha: baseSha, treeSha: baseTreeSha };
  const bundle = createSourceBundle({ checkoutPath: paths.checkout, repository, base, manifestJson });
  return { paths, repository, base, bundle, manifestJson };
}

export function createFixturePlan(prepared, { imageDigest, addresses, resolutionObservedAt,
  resolutionExpiresAt, now, expiresAt }) {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 32
    || addresses.some((address) => typeof address !== "string" || !address)) {
    throw new TypeError("fixture origin addresses invalid");
  }
  for (const value of [resolutionObservedAt, resolutionExpiresAt, now, expiresAt]) {
    if (!Number.isSafeInteger(value)) throw new TypeError("fixture origin timestamps invalid");
  }
  if (resolutionExpiresAt <= now || expiresAt <= now || expiresAt > resolutionExpiresAt) {
    throw new Error("fixture plan must fit within fresh origin resolution");
  }
  const sortedAddresses = [...new Set(addresses)].sort();
  const plan = createPublicationRunnerPlan({
    pilotId: "pilot_runner_image_integration",
    repository: prepared.repository,
    base: { branch: prepared.base.branch, sha: prepared.base.sha },
    sourceArchiveDigest: prepared.bundle.digest,
    manifestDigest: digest(prepared.manifestJson),
    imageDigest,
    migrationInstallEgress: [{
      host: "registry.npmjs.org", protocol: "tcp", port: 443, tls: true,
      addresses: sortedAddresses,
      resolutionEvidenceDigest: digest(sortedAddresses.join("\n")),
      resolutionObservedAt, resolutionExpiresAt,
    }],
    expiresAt, now,
  });
  writeFileSync(prepared.paths.planPath, plan.canonicalJson, { mode: 0o600 });
  writeFileSync(prepared.paths.sourcePath, prepared.bundle.bytes, { mode: 0o600 });
  chmodSync(prepared.paths.planPath, 0o600);
  chmodSync(prepared.paths.sourcePath, 0o600);
  return plan;
}

export function createFixturePhaseOperations({ image, paths, plan, addresses, execute,
  installNetwork = "bridge", uid = typeof process.getuid === "function" ? process.getuid() : 1000,
  gid = typeof process.getgid === "function" ? process.getgid() : 1000,
  timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof execute !== "function" || typeof image !== "string" || !/^[A-Za-z0-9._/:@+-]+$/.test(image)
    || !paths || !plan || !Array.isArray(addresses)
    || !["bridge", "host"].includes(installNetwork)
    || !Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new TypeError("fixture phase configuration invalid");
  }
  const containerNames = fixtureContainerNames(plan);
  const jobId = plan.plan.job.id;
  const base = ["run", "--rm", "--pull=never", "--read-only", "--cap-drop=all",
    "--security-opt=no-new-privileges", "--pids-limit=256", "--memory=2g", "--cpus=2",
    "--user", `${uid}:${gid}`,
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=536870912,mode=1777,uid=${uid},gid=${gid}`,
    "--tmpfs", `/npm-cache:rw,noexec,nosuid,nodev,size=268435456,mode=0700,uid=${uid},gid=${gid}`,
    "--entrypoint", "/usr/local/bin/api-migrator-runner",
    "--env", "HOME=/tmp", "--env", "PATH=/usr/local/bin:/usr/bin:/bin"];
  async function run(phase, network, mounts, args, hostAddresses = []) {
    const dockerArgs = [...base, "--name", containerNames[phase],
      "--label", `api-migrator.fixture-job=${jobId}`, "--network", network,
      ...hostAddresses.flatMap((address) => ["--add-host", `registry.npmjs.org:${address}`]),
      ...mounts.flatMap(([source, target, readOnly]) => bind(source, target, readOnly)), image, ...args];
    const output = await execute({ phase, network, dockerArgs, timeoutMs, maxBuffer: MAX_BUFFER });
    if (typeof output !== "string") throw new TypeError(`${phase} status output invalid`);
    return output;
  }
  return {
    async prepare() {
      const output = await run("prepare", "none", [
        [paths.planPath, "/run/api-migrator/plan.json", true],
        [paths.sourcePath, "/run/api-migrator/source.bundle", true],
        [paths.dependencies, "/run/api-migrator/dependencies", false],
        [paths.installation, "/run/api-migrator/installation", false],
      ], ["prepare", "--plan", "/run/api-migrator/plan.json", "--source", "/run/api-migrator/source.bundle",
        "--dependencies", "/run/api-migrator/dependencies", "--installation", "/run/api-migrator/installation"]);
      const match = exactPhaseOutput(output, /^runner_phase=prepare status=passed prepared_state_digest=(sha256:[a-f0-9]{64})\n$/, "prepare");
      assert.equal(existsSync(join(paths.installation, "baseline", "src")), false);
      assert.equal(existsSync(join(paths.installation, "candidate", "Dockerfile")), false);
      return { preparedStateDigest: match[1] };
    },
    async install(prepared) {
      const preparedStateDigest = requireDigest(prepared?.preparedStateDigest, "prepared state");
      const output = await run("install", installNetwork, [
        [paths.planPath, "/run/api-migrator/plan.json", true],
        [paths.installation, "/run/api-migrator/installation", false],
      ], ["install", "--plan", "/run/api-migrator/plan.json", "--installation", "/run/api-migrator/installation",
        "--prepared-state-digest", preparedStateDigest], addresses);
      const match = exactPhaseOutput(output,
        new RegExp(`^runner_phase=install status=passed prepared_state_digest=${preparedStateDigest} install_state_digest=(sha256:[a-f0-9]{64})\\n$`), "install");
      assert.equal(existsSync(join(paths.installation, "baseline", "LIFECYCLE_RAN")), false);
      assert.equal(existsSync(join(paths.installation, "candidate", "LIFECYCLE_RAN")), false);
      return { preparedStateDigest, installStateDigest: match[1] };
    },
    async migrate(installed) {
      const preparedStateDigest = requireDigest(installed?.preparedStateDigest, "prepared state");
      const installStateDigest = requireDigest(installed?.installStateDigest, "install state");
      const output = await run("migrate", "none", [
        [paths.planPath, "/run/api-migrator/plan.json", true],
        [paths.sourcePath, "/run/api-migrator/source.bundle", true],
        [paths.dependencies, "/run/api-migrator/dependencies", false],
        [paths.installation, "/run/api-migrator/installation", true],
        [paths.output, "/run/api-migrator/output", false],
      ], ["migrate", "--plan", "/run/api-migrator/plan.json", "--source", "/run/api-migrator/source.bundle",
        "--dependencies", "/run/api-migrator/dependencies", "--installation", "/run/api-migrator/installation",
        "--prepared-state-digest", preparedStateDigest, "--install-state-digest", installStateDigest,
        "--output", "/run/api-migrator/output"]);
      const match = exactPhaseOutput(output, /^runner_phase=migrate status=passed dependency_state_digest=(sha256:[a-f0-9]{64})\n$/, "migrate");
      return { preparedStateDigest, installStateDigest, dependencyStateDigest: match[1] };
    },
    async verify(migrated) {
      const dependencyStateDigest = requireDigest(migrated?.dependencyStateDigest, "dependency state");
      const output = await run("verify", "none", [
        [paths.planPath, "/run/api-migrator/plan.json", true],
        [paths.output, "/run/api-migrator/input", true],
        [paths.dependencies, "/run/api-migrator/dependencies", true],
        [paths.result, "/run/api-migrator/result", false],
      ], ["verify", "--plan", "/run/api-migrator/plan.json", "--input", "/run/api-migrator/input",
        "--dependencies", "/run/api-migrator/dependencies", "--dependency-state-digest", dependencyStateDigest,
        "--result", "/run/api-migrator/result"]);
      const evidencePath = join(paths.result, "runner-evidence.json");
      const evidenceStat = lstatSync(evidencePath);
      if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink() || evidenceStat.nlink !== 1 || evidenceStat.size < 1 || evidenceStat.size > 98_304) {
        throw new Error("fixture verify requires bounded regular evidence");
      }
      const evidenceText = readFileSync(evidencePath, "utf8");
      const evidence = JSON.parse(evidenceText);
      assert.equal(evidenceText, canonicalJson(evidence));
      assert.equal(evidence.planDigest, plan.digest);
      assert.match(evidence.output.preflightId, /^pf_[a-f0-9]{64}$/);
      assert.match(evidence.output.artifactDigest, DIGEST);
      assert.match(evidence.output.candidateTreeSha, /^[a-f0-9]{40}$/);
      for (const name of ["install", "typecheck", "test", "lint", "runtime"]) {
        assert.equal(evidence.checks[name].status, "passed", name);
      }
      assert.equal(evidence.report.verification.ok, true);
      assert.equal(evidence.report.verification.skipped, false);
      assert.equal(evidence.report.summary.review, 0);
      assert.deepEqual(evidence.report.manifest.deployment, { kind: "long-running" });
      assert.equal(evidence.report.entries.some((entry) => entry.kind === "review"), false);
      assert.deepEqual(evidence.blockers, []);
      assert.equal(output,
        `runner_phase=verify status=passed evidence_digest=${digest(evidenceText)} preflight_id=${evidence.output.preflightId}\n`);
      return { planDigest: plan.digest, evidenceDigest: digest(evidenceText), output: evidence.output,
        phaseIntegration: "passed", securityDrill: false };
    },
  };
}

export function executeDockerFixturePhase({ dockerArgs, timeoutMs, maxBuffer }) {
  if (!Array.isArray(dockerArgs) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > MAX_BUFFER) {
    throw new TypeError("fixture execution bounds invalid");
  }
  return execFileSync("docker", dockerArgs, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer,
  });
}

function exactPhaseOutput(output, pattern, phase) {
  const match = output.match(pattern);
  assert(match, `${phase} must emit exactly one trusted status line`);
  return match;
}

function requireDigest(value, name) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${name} digest invalid`);
  return value;
}

function bind(source, target, readOnly) {
  if (typeof source !== "string" || !isAbsolute(source)) throw new TypeError("fixture mount source must be absolute");
  return ["--mount", `type=bind,src=${resolve(source)},dst=${target}${readOnly ? ",readonly" : ""}`];
}

function git(cwd, args) {
  const env = {
    PATH: process.env.PATH,
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Abhishekpundir23",
    GIT_AUTHOR_EMAIL: "74260202+Abhishekpundir23@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Abhishekpundir23",
    GIT_COMMITTER_EMAIL: "74260202+Abhishekpundir23@users.noreply.github.com",
  };
  const committing = args[0] === "commit";
  if (committing) verifyFixtureIdentity(cwd, env);
  const output = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  if (committing) verifyFixtureIdentity(cwd, env, true);
  return output;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function prepareFixture(checkout) {
  mkdirSync(join(checkout, "src"));
  writeFileSync(join(checkout, "package.json"), `${JSON.stringify({
    name: "runner-integration-fixture", private: true, type: "module",
    scripts: {
      preinstall: "node -e \"require('node:fs').writeFileSync('LIFECYCLE_RAN','unsafe')\"",
      test: "node --test test.mjs", lint: "node lint.mjs",
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
    cwd: checkout, stdio: ["ignore", "pipe", "pipe"], timeout: DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
    env: { PATH: process.env.PATH, HOME: join(checkout, ".npm-home"),
      npm_config_cache: join(checkout, ".npm-cache"), npm_config_strict_ssl: "true",
      npm_config_registry: "https://registry.npmjs.org/" },
  });
  rmSync(join(checkout, ".npm-home"), { recursive: true, force: true });
  rmSync(join(checkout, ".npm-cache"), { recursive: true, force: true });
}
