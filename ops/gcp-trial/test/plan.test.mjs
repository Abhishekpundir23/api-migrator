import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson } from "../../publication-runner/deployment/lib.mjs";
import { renderTrialPlan, renderEvidenceRead } from "../plan.mjs";

const NOW = 2_000_000_000_000;
const PROJECT = "project-32bf49a2-bd30-4956-850";
const RUN = "abcdef0123456789abcdef0123456789";
const NAME = `api-migrator-trial-${RUN}`;
const input = (overrides = {}) => ({ projectId: PROJECT, runId: RUN,
  sourceRevision: "a".repeat(40), sourceArchiveSha256: "b".repeat(64),
  bootImage: "debian-12-bookworm-v20260908", network: "api-migrator-trial-net",
  subnetwork: "api-migrator-trial-subnet", egress: "existing-nat",
  startupScriptSha256: "c".repeat(64), deleteAt: NOW + 3_600_000, ...overrides });

test("private proposal scopes every command and fixes an absolute deletion deadline", () => {
  const plan = renderTrialPlan(input(), { nowMs: NOW });
  assert.equal(plan.instanceName, NAME);
  assert.equal(plan.issuedAt, NOW);
  assert.equal(plan.createBefore, NOW + 300_000);
  const create = plan.commands.create;
  assert.deepEqual(create.slice(0, 4), ["gcloud", "compute", "instances", "create"]);
  for (const arg of [NAME, `--project=${PROJECT}`, "--zone=us-central1-a", "--machine-type=e2-medium",
    "--no-service-account", "--no-scopes", "--no-restart-on-failure", "--boot-disk-auto-delete",
    "--instance-termination-action=DELETE", "--termination-time=2033-05-18T04:33:20.000Z", "--no-address"]) {
    assert(create.includes(arg), arg);
  }
  assert(!create.some((arg) => arg.startsWith("--max-run-duration")));
  for (const command of Object.values(plan.commands)) assert(command.includes(`--project=${PROJECT}`));
  assert.equal(plan.runtime.version, "22.23.2");
  assert.match(plan.runtime.sha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.source.revision, "a".repeat(40));
  assert.equal(plan.startup.sha256, "c".repeat(64));
});

test("an ephemeral IP must be declared and still cannot authorize execution", () => {
  const plan = renderTrialPlan(input({ egress: "ephemeral-external-ip" }), { nowMs: NOW });
  assert(!plan.commands.create.includes("--no-address"));
  assert.equal(plan.egress, "ephemeral-external-ip");
  assert.equal(plan.executionBlocked, true);
  assert.equal(plan.billingApprovalRequired, true);
  assert.equal(plan.activationBlocked, true);
  assert.equal(plan.authoritativeDrill, false);
  assert.equal(plan.releaseEvidenceEligible, false);
  assert.equal(plan.externalSigningEligible, false);
  assert(plan.requiredBeforeExecution.includes("effective_ingress_policy_verified"));
  assert(plan.requiredBeforeExecution.includes("reviewed_bootstrap_matches_digest"));
  assert(plan.requiredBeforeExecution.includes("billing_and_trial_credit_approval"));
});

test("the digest commits to the complete proposal including startup and egress", () => {
  const plan = renderTrialPlan(input(), { nowMs: NOW });
  const { planDigest, ...body } = plan;
  assert.equal(planDigest, `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`);
  const changed = renderTrialPlan(input({ startupScriptSha256: "d".repeat(64) }), { nowMs: NOW });
  assert.notEqual(planDigest, changed.planDigest);
  assert.notEqual(planDigest, renderTrialPlan(input({ egress: "ephemeral-external-ip" }), { nowMs: NOW }).planDigest);
});

for (const [name, change] of [
  ["professional project", { projectId: "toloka-production" }],
  ["unrecognized personal project", { projectId: "other-personal-project" }],
  ["mutable source", { sourceRevision: "main" }],
  ["archive checksum", { sourceArchiveSha256: "z".repeat(64) }],
  ["bootstrap checksum", { startupScriptSha256: "" }],
  ["mutable OS image", { bootImage: "family/debian-12" }],
  ["cross-project network", { network: "projects/work/global/networks/shared" }],
  ["default shared network", { network: "default" }],
  ["subnet injection", { subnetwork: "api-migrator-trial-x;touch /tmp/oops" }],
  ["undeclared egress", { egress: "private-google-access" }],
  ["expired deadline", { deleteAt: NOW }],
  ["short deadline", { deleteAt: NOW + 899_999 }],
  ["long deadline", { deleteAt: NOW + 3_600_001 }],
  ["unbounded timestamp", { deleteAt: Infinity }],
  ["run identity injection", { runId: "$(whoami)" }],
  ["authority override", { activationBlocked: false }],
  ["execute override", { execute: true }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => renderTrialPlan(input(change), { nowMs: NOW }), /invalid|unknown|scope|deadline/);
  });
}

test("clock and exact lower deadline boundary remain bounded", () => {
  assert.throws(() => renderTrialPlan(input(), { nowMs: NaN }), /clock/);
  const plan = renderTrialPlan(input({ deleteAt: NOW + 900_000 }), { nowMs: NOW });
  assert.equal(plan.createBefore, NOW);
});

for (const [name, makeInput, field, valid, unsafe, render] of [
  ["trial", input, "network", "api-migrator-trial-net", "projects/professional-project/global/networks/shared",
    (request) => renderTrialPlan(request, { nowMs: NOW })],
  ["evidence", () => ({ projectId: PROJECT, instanceId: "123", fromMs: NOW, toMs: NOW }),
    "instanceId", "123", '123" OR resource.type="gce_instance', renderEvidenceRead],
]) {
  test(`${name} rejects accessors without invoking them`, () => {
    let reads = 0;
    const request = makeInput();
    Object.defineProperty(request, field, { enumerable: true, get: () => ++reads <= 2 ? valid : unsafe });
    assert.throws(() => render(request), /invalid/);
    assert.equal(reads, 0);
  });
  test(`${name} rejects non-enumerable input fields`, () => {
    const request = makeInput();
    Object.defineProperty(request, field, { value: valid, enumerable: false });
    assert.throws(() => render(request), /invalid/);
  });
  test(`${name} renders only the validated data-property snapshot`, () => {
    let reads = 0;
    const request = makeInput();
    const wrapped = new Proxy(request, { get(target, key) {
      if (key === field) return ++reads <= 2 ? valid : unsafe;
      return Reflect.get(target, key);
    } });
    assert.deepEqual(render(wrapped), render(request));
    assert.equal(reads, 0);
  });
}

test("serial evidence reads use the numeric instance ID and a bounded explicit window", () => {
  const proposal = renderEvidenceRead({ projectId: PROJECT, instanceId: "8553341044168520058", fromMs: NOW, toMs: NOW + 3_900_000 });
  assert.deepEqual(proposal.command.slice(0, 3), ["gcloud", "logging", "read"]);
  const query = proposal.command[3];
  assert(query.includes('resource.labels.instance_id="8553341044168520058"'));
  assert(query.includes(`resource.labels.project_id="${PROJECT}"`));
  assert(query.includes('resource.labels.zone="us-central1-a"'));
  assert(query.includes(`logName="projects/${PROJECT}/logs/serialconsole.googleapis.com%2Fserial_port_1_output"`));
  assert(query.includes('timestamp>="2033-05-18T03:33:20.000Z"'));
  assert(query.includes('timestamp<="2033-05-18T04:38:20.000Z"'));
  assert(proposal.command.includes(`--project=${PROJECT}`));
  assert(proposal.command.includes("--limit=1000"));
  assert.equal(proposal.retentionVerified, false);
  assert.equal(proposal.truncationMustBeRejected, true);
});

for (const change of [{ instanceId: "api-migrator-trial-name" }, { instanceId: 8553341044168520000 },
  { projectId: "dynamo-professional" }, { fromMs: NOW + 1 }, { toMs: NOW + 7_200_001 }, { authorize: true }]) {
  test(`rejects unsafe evidence request ${JSON.stringify(change)}`, () => {
    assert.throws(() => renderEvidenceRead({ projectId: PROJECT, instanceId: "123456789", fromMs: NOW, toMs: NOW, ...change }), /invalid|unknown|scope|window/);
  });
}

const cli = fileURLToPath(new URL("../render-plan.mjs", import.meta.url));
test("CLI renders without cloud tooling and refuses execution, links, directories, and oversized input", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gcp-planner-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "request.json");
  const bytes = JSON.stringify(input({ deleteAt: Date.now() + 3_600_000 }));
  writeFileSync(config, bytes);
  const invoke = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { PATH: root }, timeout: 5000 });
  const result = invoke(["--input", config]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).executionBlocked, true);
  assert.equal(result.stdout, canonicalJson(JSON.parse(result.stdout)) + "\n");
  for (const args of [["--execute", "--input", config], ["--input", config, "--execute"], [], ["--input", root]]) {
    const bad = invoke(args);
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, "");
  }
  const link = join(root, "link.json"); symlinkSync(config, link);
  assert.equal(invoke(["--input", link]).status, 2);
  writeFileSync(config, " ".repeat(32_769));
  assert.equal(invoke(["--input", config]).status, 2);
});
