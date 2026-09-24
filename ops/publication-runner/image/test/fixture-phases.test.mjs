import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../../../../packages/app/dist/runner-internal.js";
import { createFixturePhaseOperations, fixtureContainerNames } from "../fixture-phases.mjs";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const C = `sha256:${"c".repeat(64)}`;
const root = mkdtempSync(join(tmpdir(), "fixture-phase-unit-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const paths = Object.fromEntries(["planPath", "sourcePath", "dependencies", "installation", "output", "result"]
  .map((name) => [name, join(root, name)]));
mkdirSync(paths.installation);
mkdirSync(paths.result);
const evidence = {
  planDigest: A,
  output: { preflightId: `pf_${"d".repeat(64)}`, artifactDigest: B, candidateTreeSha: "e".repeat(40) },
  checks: Object.fromEntries(["install", "typecheck", "test", "lint", "runtime"].map((name) => [name, { status: "passed" }])),
  report: { verification: { ok: true, skipped: false }, summary: { review: 0 },
    manifest: { deployment: { kind: "long-running" } }, entries: [] },
  blockers: [],
};
const evidenceText = canonicalJson(evidence);
const evidenceDigest = `sha256:${createHash("sha256").update(evidenceText).digest("hex")}`;

test("container identities are fixed to one plan job and four phases", () => {
  const jobId = `previewjob_${"f".repeat(64)}`;
  assert.deepEqual(fixtureContainerNames({ plan: { job: { id: jobId } } }), {
    prepare: `api-migrator-fixture-${jobId}-prepare`,
    install: `api-migrator-fixture-${jobId}-install`,
    migrate: `api-migrator-fixture-${jobId}-migrate`,
    verify: `api-migrator-fixture-${jobId}-verify`,
  });
});

function phases(outputs, options = {}) {
  const calls = [];
  const execute = async (request) => {
    calls.push(request);
    return outputs[request.phase];
  };
  return { calls, operations: createFixturePhaseOperations({
    image: "api-migrator-runner:local", paths,
    plan: { digest: A, plan: { job: { id: `previewjob_${"f".repeat(64)}` } } },
    addresses: ["104.16.1.35"], execute, installNetwork: "host", uid: 43123, gid: 43123,
    timeoutMs: 20_000, ...options,
  }) };
}

test("phase protocol propagates exact previous digests and scopes network and process bounds", async () => {
  writeFileSync(join(paths.result, "runner-evidence.json"), evidenceText);
  const { calls, operations } = phases({
    prepare: `runner_phase=prepare status=passed prepared_state_digest=${A}\n`,
    install: `runner_phase=install status=passed prepared_state_digest=${A} install_state_digest=${B}\n`,
    migrate: `runner_phase=migrate status=passed dependency_state_digest=${C}\n`,
    verify: `runner_phase=verify status=passed evidence_digest=${evidenceDigest} preflight_id=pf_${"d".repeat(64)}\n`,
  });
  const prepared = await operations.prepare();
  const installed = await operations.install(prepared);
  const migrated = await operations.migrate(installed);
  const verified = await operations.verify(migrated);
  assert.equal(verified.evidenceDigest, evidenceDigest);
  assert.deepEqual(calls.map(({ phase }) => phase), ["prepare", "install", "migrate", "verify"]);
  assert.deepEqual(calls.map(({ network }) => network), ["none", "host", "none", "none"]);
  for (const call of calls) {
    assert.equal(call.timeoutMs, 20_000);
    assert.equal(call.maxBuffer, 16 * 1024 * 1024);
    assert(call.dockerArgs.includes("43123:43123"));
    assert(call.dockerArgs.includes("--read-only"));
    assert(call.dockerArgs.includes("--cap-drop=all"));
    assert(call.dockerArgs.includes("--security-opt=no-new-privileges"));
    assert(call.dockerArgs.includes(`api-migrator-fixture-previewjob_${"f".repeat(64)}-${call.phase}`));
    assert(call.dockerArgs.includes(`api-migrator.fixture-job=previewjob_${"f".repeat(64)}`));
    assert.equal(call.dockerArgs[call.dockerArgs.indexOf("--network") + 1], call.phase === "install" ? "host" : "none");
    assert.equal(call.dockerArgs.includes("registry.npmjs.org:104.16.1.35"), call.phase === "install");
  }
  assert(calls[1].dockerArgs.includes(A));
  assert(calls[2].dockerArgs.includes(A));
  assert(calls[2].dockerArgs.includes(B));
  assert(calls[3].dockerArgs.includes(C));
});

test("malformed status and mismatched digest stop phase progression", async () => {
  for (const bad of ["", `runner_phase=prepare status=passed prepared_state_digest=${A}\nextra\n`,
    `runner_phase=prepare status=passed prepared_state_digest=sha256:bad\n`]) {
    const { operations } = phases({ prepare: bad });
    await assert.rejects(operations.prepare(), /prepare.*status|status.*prepare/);
  }
  const { operations } = phases({ install: `runner_phase=install status=passed prepared_state_digest=${B} install_state_digest=${C}\n` });
  await assert.rejects(operations.install({ preparedStateDigest: A }), /install.*status|status.*install/);
});

test("migrate and verify reject extra status output", async () => {
  writeFileSync(join(paths.result, "runner-evidence.json"), evidenceText);
  const { operations: migrate } = phases({ migrate: `runner_phase=migrate status=passed dependency_state_digest=${C}\nextra\n` });
  await assert.rejects(migrate.migrate({ preparedStateDigest: A, installStateDigest: B }), /migrate.*status|status.*migrate/);
  const { operations: verify } = phases({
    verify: `runner_phase=verify status=passed evidence_digest=${evidenceDigest} preflight_id=pf_${"d".repeat(64)}\nextra\n`,
  });
  await assert.rejects(verify.verify({ dependencyStateDigest: C }), /runner_phase=verify/);
});
