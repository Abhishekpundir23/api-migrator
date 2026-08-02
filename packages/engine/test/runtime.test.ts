import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyNodeRuntimeMigration,
  attestNodeRuntime,
  parseManifest,
  planNodeRuntimeMigration,
  runMigration,
  updateManifestDependencies,
  type Manifest,
  type ReportEntry,
} from "../src/index.js";

const policy = {
  minimumMajor: 20 as const,
  profile: "node22-bookworm-slim-2026-07" as const,
  packageJson: "package.json" as const,
  dockerfile: "Dockerfile" as const,
};

const pinnedDockerfileSyntax =
  "# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89";

const manifest: Manifest = {
  name: "Inngest v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  runtime: { node: policy },
  package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
  peerFloors: [{ name: "typescript", range: "^5.8.0" }],
};

const legacyDockerfile = `# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=18.8.0
FROM node:\${NODE_VERSION}-slim as base

LABEL fly_launch_runtime="Next.js"
WORKDIR /app
ENV NODE_ENV=production

FROM base AS build
RUN apt-get update -qq && \
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
`;

test("Inngest manifests require the audited Node runtime profile", () => {
  const base = {
    name: manifest.name,
    provider: manifest.provider,
    transformSet: manifest.transformSet,
    package: manifest.package,
    peerFloors: manifest.peerFloors,
  };
  assert.throws(() => parseManifest(base), /require the audited Node 20\/22 runtime policy/);
  assert.throws(
    () => parseManifest({ ...base, runtime: { node: { ...policy, minimumMajor: 18 } } }),
    /Invalid literal value, expected 20/
  );
  assert.throws(
    () => parseManifest({ ...base, runtime: { node: { ...policy, profile: "node:latest" } } }),
    /node22-bookworm-slim-2026-07/
  );
  assert.throws(
    () => parseManifest({ ...base, runtime: { node: { ...policy, dockerfile: "deploy/Dockerfile" } } }),
    /Dockerfile/
  );
});

test("runtime and dependency migration pins Node 22, adds the Node 20 floor, and is idempotent", () => {
  withRepo((repo) => {
    const entries: ReportEntry[] = [];
    const runtimePlan = planNodeRuntimeMigration(repo, policy);
    const dependencies = updateManifestDependencies(repo, manifest, { push: (entry) => entries.push(entry) });
    const runtime = applyNodeRuntimeMigration(repo, runtimePlan, { push: (entry) => entries.push(entry) });

    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    const dockerfile = readFileSync(join(repo, "Dockerfile"), "utf8");
    assert.equal(pkg.engines.node, ">=20");
    assert.equal(pkg.dependencies.inngest, "^4.0.0");
    assert.equal(pkg.devDependencies.typescript, "^5.8.0");
    assert.equal(dockerfile.split(/\r?\n/, 1)[0], pinnedDockerfileSyntax);
    assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64} AS base$/m);
    assert.doesNotMatch(dockerfile, /Adjust NODE_VERSION|ARG NODE_VERSION|\$\{NODE_VERSION\}/);
    assert.deepEqual(dependencies.packageFiles, ["package.json"]);
    assert.deepEqual(runtime.runtimeFiles, ["Dockerfile"]);
    assert.deepEqual(entries.map((entry) => entry.code), ["PKG1", "PKG2", "RT1", "RT2"]);
    const attestation = attestNodeRuntime(repo, policy);
    assert.equal(attestation.ok, true);
    assert.equal(attestation.nodeVersion, "22.23.2");

    assert.deepEqual(planNodeRuntimeMigration(repo, policy).edits, []);
    const again = updateManifestDependencies(repo, manifest, {
      push: () => assert.fail("idempotent dependency update reported a change"),
    });
    assert.deepEqual(again.packageFiles, []);
  });
});

test("a stronger simple Node engine floor is preserved", () => {
  withRepo((repo) => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    pkg.engines = { node: ">=22" };
    writeFileSync(join(repo, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    updateManifestDependencies(repo, manifest, { push: () => undefined });
    assert.equal(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).engines.node, ">=22");
    const plan = planNodeRuntimeMigration(repo, policy);
    applyNodeRuntimeMigration(repo, plan, { push: () => undefined });
    assert.equal(attestNodeRuntime(repo, policy).ok, true);
  });
});

test("Node engine floors use canonical syntax, rewrite old floors, and fit pinned Node 22.23.2", () => {
  for (const current of [">=0", ">=19", ">=19.99.99"]) {
    withRepo((repo) => {
      setNodeEngine(repo, current);
      updateManifestDependencies(repo, manifest, { push: () => undefined });
      assert.equal(readNodeEngine(repo), ">=20");
    });
  }

  for (const current of [">=20", ">=20.1", ">=20.1.2", ">=22", ">=22.23", ">=22.23.2"]) {
    withRepo((repo) => {
      setNodeEngine(repo, current);
      updateManifestDependencies(repo, manifest, { push: () => undefined });
      assert.equal(readNodeEngine(repo), current);
    });
  }

  for (const current of [">=23", ">=22.24", ">=22.23.3"]) {
    withRepo((repo) => {
      setNodeEngine(repo, current);
      const original = readFileSync(join(repo, "package.json"), "utf8");
      assert.throws(
        () => updateManifestDependencies(repo, manifest, { push: () => undefined }),
        /provides Node 22\.23\.2/
      );
      assert.equal(readFileSync(join(repo, "package.json"), "utf8"), original);
    });
  }

  for (const current of [
    ">=18 || >=22", " >=20", ">= 20", ">=020", ">=20.01", ">=20.0.01", "^20", "20",
  ]) {
    withRepo((repo) => {
      setNodeEngine(repo, current);
      const original = readFileSync(join(repo, "package.json"), "utf8");
      assert.throws(
        () => updateManifestDependencies(repo, manifest, { push: () => undefined }),
        /canonical >=N/
      );
      assert.equal(readFileSync(join(repo, "package.json"), "utf8"), original);
    });
  }
});

test("invalid Docker runtime declarations fail before dependency or source writes", async () => {
  await withRepoAsync(async (repo) => {
    writeFileSync(join(repo, "Dockerfile"), "FROM node:18-slim AS runner\n");
    const packageBefore = readFileSync(join(repo, "package.json"));
    await assert.rejects(
      () => runMigration(manifest, repo, { writeChanges: true, skipVerify: true }),
      /approved Dockerfile frontend directive/
    );
    assert.deepEqual(readFileSync(join(repo, "package.json")), packageBefore);
  });
});

test("runtime planning rejects symlinks, invalid UTF-8, and ambiguous declarations", () => {
  withRepo((repo) => {
    rmSync(join(repo, "Dockerfile"));
    writeFileSync(join(repo, "actual.Dockerfile"), legacyDockerfile);
    symlinkSync("actual.Dockerfile", join(repo, "Dockerfile"));
    assert.throws(() => planNodeRuntimeMigration(repo, policy), /must not be a symlink/);
  });

  withRepo((repo) => {
    writeFileSync(join(repo, "Dockerfile"), Buffer.from([0xff, 0xfe, 0xfd]));
    assert.throws(() => planNodeRuntimeMigration(repo, policy), /not valid UTF-8/);
  });

  withRepo((repo) => {
    writeFileSync(join(repo, "Dockerfile"), `${legacyDockerfile}\nARG NODE_VERSION=18.9.0\n`);
    assert.throws(() => planNodeRuntimeMigration(repo, policy), /exactly one static ARG/);
  });
});

test("runtime attestation rejects instructions outside the audited three-stage recipe", () => {
  const mutations: Array<(dockerfile: string) => string> = [
    (dockerfile) => dockerfile.replace("COPY --from=build /app /app", "COPY --from=build / /"),
    (dockerfile) => dockerfile.replace("EXPOSE 3000", "RUN npm install -g node@18\nEXPOSE 3000"),
    (dockerfile) => dockerfile.replace(
      "WORKDIR /app",
      "WORKDIR /app\nONBUILD RUN cp /tmp/node /usr/local/bin/node"
    ),
    (dockerfile) => dockerfile.replace(
      "ENV NODE_ENV=production",
      "ENV NODE_ENV=production\nRUN true && " + "\\\n" + "    cp /tmp/node /usr/local/bin/node"
    ),
    (dockerfile) => dockerfile.replace(
      'CMD [ "npm", "run", "start" ]',
      'ENTRYPOINT ["/app/node"]\nCMD [ "npm", "run", "start" ]'
    ),
    (dockerfile) => dockerfile.replace(
      pinnedDockerfileSyntax,
      "# syntax = attacker.example/dockerfile:latest"
    ),
    (dockerfile) => dockerfile.replace(
      "RUN npm run build",
      "ARG BUILD_COMMAND\nRUN $BUILD_COMMAND"
    ),
  ];

  for (const mutate of mutations) {
    withMigratedRepo((repo) => {
      const path = join(repo, "Dockerfile");
      writeFileSync(path, mutate(readFileSync(path, "utf8")));
      const result = attestNodeRuntime(repo, policy);
      assert.equal(result.ok, false, "unsafe Dockerfile unexpectedly passed attestation");
      assert.match(result.reason, /approved syntax|audited three-stage|dynamic variables/);
    });
  }
});

test("runtime attestation rejects an engine floor above the pinned profile", () => {
  withMigratedRepo((repo) => {
    setNodeEngine(repo, ">=23");
    const result = attestNodeRuntime(repo, policy);
    assert.equal(result.ok, false);
    assert.match(result.reason, /provides Node 22\.23\.2/);
  });
});

function withRepo(run: (repo: string) => void): void {
  const repo = mkdtempSync(join(tmpdir(), "api-migrator-runtime-"));
  try {
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({
      dependencies: { inngest: "^3.0.0" },
      devDependencies: { typescript: "^5.1.0" },
    }, null, 2)}\n`);
    writeFileSync(join(repo, "Dockerfile"), legacyDockerfile);
    run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

async function withRepoAsync(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "api-migrator-runtime-"));
  try {
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({
      dependencies: { inngest: "^3.0.0" },
      devDependencies: { typescript: "^5.1.0" },
    }, null, 2)}\n`);
    writeFileSync(join(repo, "Dockerfile"), legacyDockerfile);
    await run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function withMigratedRepo(run: (repo: string) => void): void {
  withRepo((repo) => {
    const plan = planNodeRuntimeMigration(repo, policy);
    updateManifestDependencies(repo, manifest, { push: () => undefined });
    applyNodeRuntimeMigration(repo, plan, { push: () => undefined });
    run(repo);
  });
}

function setNodeEngine(repo: string, range: string): void {
  const path = join(repo, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.engines = { node: range };
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

function readNodeEngine(repo: string): string {
  return JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).engines.node;
}
