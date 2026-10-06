import { prepareTrial } from "../bootstrap.mjs";
import { captureOwnership } from "../cleanup.mjs";

export function resultFixture(now = 2_000_000_000_000, request = {}) {
  const artifact = prepareTrial({ projectId: "project-32bf49a2-bd30-4956-850", runId: "abcdef0123456789abcdef0123456789",
    sourceRevision: "a".repeat(40), sourceArchiveSha256: "b".repeat(64), bootImage: "debian-12-bookworm-v20260908",
    network: "api-migrator-trial-net", subnetwork: "api-migrator-trial-subnet", egress: "existing-nat",
    deleteAt: now + 3_600_000, ...request }, { nowMs: now });
  const { plan } = artifact, base = `https://www.googleapis.com/compute/v1/projects/${plan.projectId}/zones/${plan.zone}`;
  const vmId = "18446744073709551614", name = plan.instanceName;
  const observation = { projectId: plan.projectId, zone: plan.zone, observedAt: now + 1000,
    operation: { id: "123", status: "DONE", operationType: "insert", zone: base, targetId: vmId, targetLink: `${base}/instances/${name}` },
    instance: { id: vmId, name, selfLink: `${base}/instances/${name}`, zone: base, creationTimestamp: new Date(now + 500).toISOString(),
      labels: { "api-migrator-trial": plan.runId }, disks: [{ boot: true, autoDelete: true, source: `${base}/disks/${name}` }] },
    disk: { id: "18446744073709551613", name, selfLink: `${base}/disks/${name}`, zone: base,
      creationTimestamp: new Date(now + 500).toISOString(), users: [`${base}/instances/${name}`] } };
  const ownership = captureOwnership(JSON.stringify(plan), JSON.stringify(observation), { nowMs: now + 1000 });
  const marker = { schemaVersion: 1, profile: "engine-smoke-v1", runId: plan.runId, sourceRevision: plan.source.revision,
    sourceArchiveSha256: plan.source.sha256, phase: "complete", status: "passed", exitCode: 0, activationBlocked: true };
  const entry = { logName: `projects/${plan.projectId}/logs/serialconsole.googleapis.com%2Fserial_port_1_output`,
    resource: { type: "gce_instance", labels: { project_id: plan.projectId, zone: plan.zone, instance_id: vmId } },
    timestamp: new Date(now + 2000).toISOString(), receiveTimestamp: new Date(now + 3000).toISOString(), insertId: "fixture-entry",
    textPayload: `API_MIGRATOR_TRIAL_RESULT ${JSON.stringify(marker)}\n` };
  return { ...artifact, ownership, marker, entry, nowMs: now + 4000 };
}
