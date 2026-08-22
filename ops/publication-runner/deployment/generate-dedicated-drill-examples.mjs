import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { canonicalJson, sha256 } from "./lib.mjs";
import {
  DEDICATED_DRILL_SCENARIOS,
  buildDedicatedDrillEvent,
  dedicatedDrillEventChainRoot,
  dedicatedDrillEventOrder,
  dedicatedDrillScenarioProofEvents,
  renderDedicatedDrillAttemptReport,
  renderDedicatedDrillHandoff,
} from "./dedicated-drill-handoff.mjs";

const NOW = 2_000_000_000_000;
const PROVIDER = "example-provider";
const PROVIDER_SCOPE_DIGEST = digest("example-provider-scope");
const EVIDENCE_LOCATION = "s3://example-api-migrator-evidence/dedicated-suite";

function digest(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function buildHandoffInput() {
  const controller = {
    controllerId: "controller-example-001",
    hostId: "controller-host-example-001",
    trustDomain: "controller.example.invalid",
    principalDigest: digest("controller-principal"),
    runtimeDigest: digest("controller-runtime"),
    role: "external_controller",
    targetMutationAccess: "provider_control_plane",
    evidenceSinkOwner: true,
    targetCredentialDelivery: "ephemeral_session_only",
  };
  const observer = {
    observerId: "observer-example-001",
    hostId: "observer-host-example-001",
    trustDomain: "observer.example.invalid",
    principalDigest: digest("observer-principal"),
    runtimeDigest: digest("observer-runtime"),
    role: "external_read_only_observer",
    targetMutationAccess: "none",
    evidenceSinkAppendOnly: true,
  };
  const attempts = DEDICATED_DRILL_SCENARIOS.map(({ name }, index) => {
    const bindings = {
      jobDigest: digest(`job-${name}`),
      planDigest: digest(`plan-${name}`),
      hostProfileDigest: digest(`host-profile-${name}`),
      runtimeManifestDigest: digest(`runtime-manifest-${name}`),
      gatewayContractDigest: digest(`gateway-contract-${name}`),
      nftablesPolicyDigest: digest(`nftables-policy-${name}`),
      imageDigest: digest(`image-${name}`),
    };
    const leaseId = `lease-example-${String(index + 1).padStart(2, "0")}`;
    const providerLeaseReceiptDigest = digest(`provider-lease-receipt-${name}`);
    const instanceId = `instance-example-${String(index + 1).padStart(2, "0")}`;
    const instanceIdentityDigest = digest(`instance-identity-${name}`);
    const createdAt = NOW - 60_000 + index;
    const expiresAt = NOW + 900_000 + index * 1_000;
    const attempt = {
      scenario: name,
      scenarioNonce: digest(`scenario-nonce-${name}`),
      deadlineAt: NOW + 600_000 + index * 1_000,
      jobId: `previewjob_${digest(`job-id-${name}`).slice("sha256:".length)}`,
      bindings,
      hostLease: {
        leaseId,
        provider: PROVIDER,
        providerScopeDigest: PROVIDER_SCOPE_DIGEST,
        providerLeaseReceiptDigest,
        providerLeaseReceipt: {
          kind: "provider_lease_receipt",
          provider: PROVIDER,
          providerScopeDigest: PROVIDER_SCOPE_DIGEST,
          leaseId,
          instanceId,
          instanceIdentityDigest,
          imageDigest: bindings.imageDigest,
          controllerPrincipalDigest: controller.principalDigest,
          createdAt,
          expiresAt,
          receiptDigest: providerLeaseReceiptDigest,
        },
        instanceId,
        instanceIdentityDigest,
        imageDigest: bindings.imageDigest,
        initialBootId: digest(`initial-boot-${name}`),
        createdAt,
        expiresAt,
        fresh: true,
        dedicated: true,
        disposable: true,
        reused: false,
        selfAttested: false,
      },
      faultProfile: { kind: "none" },
    };
    if (name === "oom") {
      attempt.faultProfile = {
        kind: "bounded_cgroup_v2_oom",
        cgroupVersion: 2,
        memoryMaxBytes: 128 * 1024 * 1024,
        memorySwapMaxBytes: 0,
        allocationBytes: 192 * 1024 * 1024,
        oomKillDeltaMinimum: 1,
        unitNameDigest: digest("oom-unit-name"),
        cgroupPathDigest: digest("oom-cgroup-path"),
        expectedSystemdResult: "oom-kill",
        hostMustRemainReachable: true,
      };
    } else if (name === "reboot") {
      attempt.faultProfile = {
        kind: "provider_control_plane_reboot",
        operationNonceDigest: digest("reboot-operation-nonce"),
        requireUnreachableTransition: true,
        requireReconnect: true,
        requireSameInstanceIdentity: true,
        requireBootIdChange: true,
        maxUnavailableMs: 120_000,
      };
    }
    return attempt;
  });
  return {
    suiteId: `dedicatedsuite_${digest("dedicated-suite").slice("sha256:".length)}`,
    sourceRevision: "1".repeat(40),
    issuedAt: NOW,
    provider: PROVIDER,
    providerScopeDigest: PROVIDER_SCOPE_DIGEST,
    controller,
    observer,
    evidenceSink: {
      kind: "controller_owned_append_only",
      ownerControllerId: controller.controllerId,
      locationReference: EVIDENCE_LOCATION,
      locationDigest: sha256(Buffer.from(EVIDENCE_LOCATION, "utf8")),
      retentionUntil: NOW + 31 * 24 * 60 * 60 * 1_000,
      offHost: true,
      appendOnly: true,
      controllerOwned: true,
      targetWriteAccess: false,
      targetCredentialsPresent: false,
    },
    attempts,
  };
}

function buildSuccessEvents(handoff) {
  const scenario = "success";
  const attempt = handoff.handoff.attempts.find((entry) => entry.scenario === scenario);
  const order = dedicatedDrillEventOrder(scenario);
  let previousEventDigest = dedicatedDrillEventChainRoot(handoff, scenario);
  return order.map((event, index) => {
    const built = buildDedicatedDrillEvent({
      scenario,
      sequence: index + 1,
      event,
      bootId: attempt.hostLease.initialBootId,
      observedAt: NOW + 10_000 + index * 1_000,
      evidenceDigest: event === "host_lease_verified"
        ? attempt.hostLease.providerLeaseReceiptDigest
        : digest(`success-event-${event}`),
      previousEventDigest,
    }, handoff);
    previousEventDigest = built.eventDigest;
    return built;
  });
}

function buildSuccessReportInput(handoff) {
  const scenario = "success";
  const attempt = handoff.handoff.attempts.find((entry) => entry.scenario === scenario);
  const events = buildSuccessEvents(handoff);
  const byName = Object.fromEntries(events.map((event) => [event.event, event]));
  const eventsDigest = sha256(Buffer.from(canonicalJson(events), "utf8"));
  const gatewayReceiptDigest = byName.gateway_ready.evidenceDigest;
  const proofEvents = dedicatedDrillScenarioProofEvents(scenario);
  const faultProof = {
    kind: "scenario_observation",
    scenario,
    ...proofEvents,
    stimulusEvidenceDigest: byName[proofEvents.stimulusEvent].evidenceDigest,
    outcomeEvidenceDigest: byName[proofEvents.observationEvent].evidenceDigest,
  };
  const teardown = {
    gatewayStoppedAt: byName.gateway_stopped.observedAt,
    runnerUidIdleAt: byName.runner_uid_idle.observedAt,
    gatewayUidIdleAt: byName.gateway_uid_idle.observedAt,
    cgroupNamespaceCleanupAt: byName.cgroup_namespace_cleanup.observedAt,
    workspaceCleanupAt: byName.workspace_cleanup.observedAt,
    containmentFinalizedAt: byName.nftables_policy_removed.observedAt,
    hostDestroyedAt: byName.host_destroyed.observedAt,
    containmentDisposition: "table_removed_last_after_quiescence",
    preFilesystemQuiescenceProven: true,
    workspaceAbsent: true,
    containmentAbsent: true,
    tableRemovedLast: true,
    rebootResetContainmentBeforeCleanup: false,
    providerDestroyReceipt: {
      kind: "provider_destroy_receipt",
      provider: handoff.handoff.provider,
      providerScopeDigest: handoff.handoff.providerScopeDigest,
      instanceId: attempt.hostLease.instanceId,
      instanceIdentityDigest: attempt.hostLease.instanceIdentityDigest,
      controllerPrincipalDigest: handoff.handoff.controller.principalDigest,
      destroyedAt: byName.host_destroyed.observedAt,
      receiptDigest: byName.host_destroyed.evidenceDigest,
    },
    hostDestroyed: true,
    complete: true,
    evidenceDigest: byName.scenario_finished.evidenceDigest,
  };
  const base = `${handoff.handoff.evidenceSink.locationReference}/dedicated-drill/` +
    `${handoff.digest.slice("sha256:".length)}/${attempt.attemptDigest.slice("sha256:".length)}`;
  const artifact = (value, name) => ({ digest: value, objectReference: `${base}/${name}` });
  return {
    scenario,
    startedAt: events[0].observedAt,
    finishedAt: events.at(-1).observedAt,
    observedOutcome: attempt.expectedOutcome,
    status: "passed",
    events,
    gatewayReceiptDigest,
    faultProof,
    teardown,
    evidenceBundle: {
      manifestVersion: 1,
      kind: "dedicated_drill_evidence_manifest",
      sinkLocationReference: handoff.handoff.evidenceSink.locationReference,
      sinkLocationDigest: handoff.handoff.evidenceSink.locationDigest,
      objectReference: `${base}/manifest.json`,
      controllerPrincipalDigest: handoff.handoff.controller.principalDigest,
      observerPrincipalDigest: handoff.handoff.observer.principalDigest,
      handoffDigest: handoff.digest,
      attemptDigest: attempt.attemptDigest,
      eventsDigest,
      eventEvidence: events.map((event) => ({
        sequence: event.sequence,
        event: event.event,
        eventDigest: event.eventDigest,
        evidenceDigest: event.evidenceDigest,
        objectReference: `${base}/events/${String(event.sequence).padStart(2, "0")}-${event.event}.json`,
      })),
      gatewayReceipt: artifact(gatewayReceiptDigest, "gateway-receipt.json"),
      faultProof: artifact(sha256(Buffer.from(canonicalJson(faultProof), "utf8")), "fault-proof.json"),
      faultEvidence: [{
        name: "stimulus",
        digest: faultProof.stimulusEvidenceDigest,
        objectReference: `${base}/fault/stimulus.json`,
      }, {
        name: "outcome",
        digest: faultProof.outcomeEvidenceDigest,
        objectReference: `${base}/fault/outcome.json`,
      }],
      teardown: artifact(sha256(Buffer.from(canonicalJson(teardown), "utf8")), "teardown.json"),
      providerLeaseReceipt: artifact(
        attempt.hostLease.providerLeaseReceiptDigest,
        "provider-lease-receipt.json"
      ),
      providerOperationReceipt: null,
      providerDestroyReceipt: artifact(
        teardown.providerDestroyReceipt.receiptDigest,
        "provider-destroy-receipt.json"
      ),
      rawEvidence: artifact(digest("success-raw-evidence"), "raw-evidence.tar.zst"),
      appendReceipt: artifact(digest("success-append-receipt"), "append-receipt.json"),
    },
  };
}

const handoff = renderDedicatedDrillHandoff(buildHandoffInput());
const report = renderDedicatedDrillAttemptReport(buildSuccessReportInput(handoff), handoff);

writeFileSync(new URL("dedicated-drill-handoff.example.json", import.meta.url), handoff.canonicalJson);
writeFileSync(new URL("dedicated-drill-attempt-report.example.json", import.meta.url), report.canonicalJson);
