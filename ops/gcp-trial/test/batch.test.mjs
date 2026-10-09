import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareBatch } from "../batch.mjs";

const NOW = 2_000_000_000_000;
const PROJECT = "project-32bf49a2-bd30-4956-850";
export const batchRequest = (extra = {}) => ({ projectId: PROJECT,
  runId: "abcdef0123456789abcdef0123456789", sourceRevision: "a".repeat(40),
  sourceArchiveSha256: "b".repeat(64), bootImage: "batch-debian-12-official-20260914-00-p00",
  network: "api-migrator-trial-batch", subnetwork: "api-migrator-trial-batch",
  deleteAt: NOW + 3_600_000, ...extra });

test("Batch request bounds resources and uses only the dedicated account/network", () => {
  const p = prepareBatch(batchRequest(), { nowMs: NOW });
  assert.equal(p.jobId, "api-migrator-batch-abcdef0123456789abcdef0123456789");
  assert.equal(p.activationBlocked, true);
  const [group] = p.job.taskGroups;
  assert.equal(p.job.taskGroups.length, 1);
  assert.equal(group.taskCount, "1"); assert.equal(group.parallelism, "1");
  assert.equal(group.taskCountPerNode, "1");
  assert.equal(group.taskSpec.maxRetryCount, 0);
  assert.equal(group.taskSpec.maxRunDuration, "1800s");
  assert.equal(group.taskSpec.runnables.length, 1);
  assert.deepEqual(p.job.allocationPolicy.instances, [{ blockProjectSshKeys: true, policy: {
    machineType: "e2-medium", provisioningModel: "STANDARD", reservation: "NO_RESERVATION",
    bootDisk: { image: "projects/batch-custom-image/global/images/batch-debian-12-official-20260914-00-p00", type: "pd-standard", sizeGb: "30" },
  } }]);
  assert.deepEqual(p.job.allocationPolicy.location, { allowedLocations: ["zones/us-central1-a"] });
  assert.deepEqual(p.job.allocationPolicy.serviceAccount, {
    email: `api-migrator-batch-worker@${PROJECT}.iam.gserviceaccount.com`,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  assert.deepEqual(p.job.allocationPolicy.network.networkInterfaces, [{
    network: `projects/${PROJECT}/global/networks/api-migrator-trial-batch`,
    subnetwork: `projects/${PROJECT}/regions/us-central1/subnetworks/api-migrator-trial-batch`, noExternalIpAddress: false,
  }]);
  assert.deepEqual(p.job.logsPolicy, { destination: "CLOUD_LOGGING" });
  const script = group.taskSpec.runnables[0].script.text;
  assert.equal(p.scriptSha256, createHash("sha256").update(script).digest("hex"));
  assert.equal(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status, 0);
  assert.deepEqual(prepareBatch(batchRequest(), { nowMs: NOW }), p);
});

for (const bad of [{ projectId: "professional-project" }, { sourceRevision: "main" },
  { sourceArchiveSha256: "b".repeat(64) + "\n" }, { runId: "../../evil" },
  { bootImage: "batch-debian" }, { bootImage: "batch-debian-12-official-20260914-00-p00\n" },
  { network: "default" }, { subnetwork: "default" }, { deleteAt: NOW },
  { deleteAt: NOW + 3_600_001 }, { deleteAt: Infinity }, { script: "echo unsafe" },
  { serviceAccount: "default" }, { maxRetryCount: 10 }]) {
  test(`Batch refuses unbounded or alternate inputs ${JSON.stringify(bad)}`, () => {
    assert.throws(() => prepareBatch(batchRequest(bad), { nowMs: NOW }));
  });
}
test("Batch refuses accessors without executing caller code", () => {
  const input = batchRequest(); let invoked = false;
  Object.defineProperty(input, "runId", { enumerable: true, get() { invoked = true; return "a".repeat(32); } });
  assert.throws(() => prepareBatch(input, { nowMs: NOW })); assert.equal(invoked, false);
});
test("expired generated bootstrap stops before root/system checks", () => {
  const p = prepareBatch(batchRequest({ deleteAt: 1_003_600_000 }), { nowMs: 1_000_000_000 });
  const r = spawnSync("bash", ["-se"], { input: p.job.taskGroups[0].taskSpec.runnables[0].script.text, encoding: "utf8" });
  assert.equal(r.status, 70); assert.match(r.stderr, /deadline/); assert.equal(r.stdout, "");
});
test("Batch CLI renders only, refuses extra flags, and never needs gcloud", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "batch-prepare-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, "input.json"); writeFileSync(input, JSON.stringify(batchRequest({ deleteAt: Date.now() + 3_500_000 })));
  const cli = new URL("../prepare-batch.mjs", import.meta.url).pathname;
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { env: { PATH: dir }, encoding: "utf8" });
  const ok = run(["--input", input]); assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).activationBlocked, true);
  const bad = run(["--input", input, "--execute"]); assert.equal(bad.status, 2); assert.equal(bad.stdout, "");
});
