import { createHash } from "node:crypto";
import { canonicalJson } from "../publication-runner/deployment/lib.mjs";
import { renderBatchScript } from "./batch-bootstrap.mjs";

const PROJECT = "project-32bf49a2-bd30-4956-850";
const KEYS = ["projectId", "runId", "sourceRevision", "sourceArchiveSha256", "bootImage", "network", "subnetwork", "deleteAt"];
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);

export function prepareBatch(request, { nowMs = Date.now() } = {}) {
  const input = JSON.parse(canonicalJson(request));
  if (!input || Array.isArray(input) || Object.keys(input).length !== KEYS.length || KEYS.some((key) => !Object.hasOwn(input, key))) throw new Error("invalid input fields");
  if (input.projectId !== PROJECT) throw new Error("project scope invalid");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(input.deleteAt)
    || input.deleteAt - nowMs < 900_000 || input.deleteAt - nowMs > 3_600_000) throw new Error("deadline invalid");
  if (!matches(/^[a-f0-9]{32}$/, input.runId) || !matches(/^[a-f0-9]{40}$/, input.sourceRevision)
    || !matches(/^[a-f0-9]{64}$/, input.sourceArchiveSha256)
    || !matches(/^batch-debian-12-official-[0-9]{8}-[a-z0-9-]+$/, input.bootImage)
    || !matches(/^api-migrator-trial-[a-z0-9-]{1,42}$/, input.network)
    || !matches(/^api-migrator-trial-[a-z0-9-]{1,42}$/, input.subnetwork)
    || [input.runId, input.sourceRevision, input.sourceArchiveSha256, input.bootImage, input.network, input.subnetwork].some((s) => s.includes("\n"))) throw new Error("immutable inputs invalid");
  const source = { revision: input.sourceRevision, sha256: input.sourceArchiveSha256,
    url: `https://codeload.github.com/Abhishekpundir23/api-migrator/tar.gz/${input.sourceRevision}` };
  const script = renderBatchScript(input, source);
  const jobId = `api-migrator-batch-${input.runId}`;
  return { schemaVersion: 1, projectId: PROJECT, region: "us-central1", jobId,
    runId: input.runId, source, issuedAt: nowMs, deleteAt: input.deleteAt,
    scriptSha256: createHash("sha256").update(script).digest("hex"), activationBlocked: true,
    job: { taskGroups: [{ taskCount: "1", parallelism: "1", taskCountPerNode: "1",
      taskSpec: { computeResource: { cpuMilli: "2000", memoryMib: "2048" }, maxRetryCount: 0, maxRunDuration: "1800s",
        runnables: [{ script: { text: script } }] } }],
    allocationPolicy: { location: { allowedLocations: ["zones/us-central1-a"] },
      instances: [{ blockProjectSshKeys: true, policy: { machineType: "e2-medium", provisioningModel: "STANDARD", reservation: "NO_RESERVATION",
        bootDisk: { image: `projects/batch-custom-image/global/images/${input.bootImage}`, type: "pd-standard", sizeGb: "30" } } }],
      serviceAccount: { email: `api-migrator-batch-worker@${PROJECT}.iam.gserviceaccount.com`, scopes: ["https://www.googleapis.com/auth/cloud-platform"] },
      network: { networkInterfaces: [{ network: `projects/${PROJECT}/global/networks/${input.network}`,
        subnetwork: `projects/${PROJECT}/regions/us-central1/subnetworks/${input.subnetwork}`, noExternalIpAddress: false }] },
      labels: { "api-migrator-run": input.runId } },
    labels: { "api-migrator-run": input.runId }, logsPolicy: { destination: "CLOUD_LOGGING" } },
    limitations: ["public_source_internal_smoke_only", "task_timeout_does_not_bound_queue_or_vm_initialization",
      "supervise_until_terminal_and_independent_resource_absence", "new_iam_requires_confirmation", "not_a_client_isolation_attestation"] };
}
