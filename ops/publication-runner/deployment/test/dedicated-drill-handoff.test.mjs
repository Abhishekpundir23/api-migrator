import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson, sha256 } from "../lib.mjs";
import {
  DEDICATED_DRILL_AUTHORIZATION_STATUS,
  DEDICATED_DRILL_SCENARIOS,
  buildDedicatedDrillEvent,
  dedicatedDrillEventChainRoot,
  dedicatedDrillEventOrder,
  dedicatedDrillScenarioProofEvents,
  parseCanonicalDedicatedDrillAttemptReport,
  renderDedicatedDrillAttemptReport,
  renderDedicatedDrillHandoff,
  validateDedicatedDrillAttemptReportRecord,
  validateDedicatedDrillHandoffRecord,
} from "../dedicated-drill-handoff.mjs";

const NOW = 2_000_000_000_000;
const PROVIDER = "acme-cloud";
const PROVIDER_SCOPE_DIGEST = digest("provider-scope");
const EVIDENCE_LOCATION = "s3://api-migrator-evidence/dedicated-suite";

function digest(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function handoffInput() {
  const controller = {
    controllerId: "controller.external-01",
    hostId: "controller-host-01",
    trustDomain: "controller.trust-01",
    principalDigest: digest("controller-principal"),
    runtimeDigest: digest("controller-runtime"),
    role: "external_controller",
    targetMutationAccess: "provider_control_plane",
    evidenceSinkOwner: true,
    targetCredentialDelivery: "ephemeral_session_only",
  };
  const observer = {
    observerId: "observer.external-01",
    hostId: "observer-host-01",
    trustDomain: "observer.trust-01",
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
    const leaseId = `lease.external-${index.toString().padStart(2, "0")}`;
    const instanceId = `instance/external-${index.toString().padStart(2, "0")}`;
    const instanceIdentityDigest = digest(`instance-identity-${name}`);
    const providerLeaseReceiptDigest = digest(`provider-lease-receipt-${name}`);
    const createdAt = NOW - 10_000 - index;
    const expiresAt = NOW + 3_000_000 + index * 10_000;
    const common = {
      scenario: name,
      scenarioNonce: digest(`scenario-nonce-${name}`),
      deadlineAt: NOW + 1_000_000 + index * 10_000,
      jobId: `previewjob_${(index + 1).toString(16).padStart(64, "0")}`,
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
    };
    if (name === "oom") {
      return {
        ...common,
        faultProfile: {
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
        },
      };
    }
    if (name === "reboot") {
      return {
        ...common,
        faultProfile: {
          kind: "provider_control_plane_reboot",
          operationNonceDigest: digest("reboot-operation-nonce"),
          requireUnreachableTransition: true,
          requireReconnect: true,
          requireSameInstanceIdentity: true,
          requireBootIdChange: true,
          maxUnavailableMs: 120_000,
        },
      };
    }
    return { ...common, faultProfile: { kind: "none" } };
  });
  return {
    suiteId: `dedicatedsuite_${"a".repeat(64)}`,
    sourceRevision: "b".repeat(40),
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

function renderHandoffFixture(input = handoffInput()) {
  return renderDedicatedDrillHandoff(input);
}

function eventEvidenceDigest(attempt, scenario, event) {
  if (event === "host_lease_verified") return attempt.hostLease.providerLeaseReceiptDigest;
  if (event === "gateway_ready") return digest(`gateway-receipt-${scenario}`);
  if (event === "reboot_requested") return digest(`reboot-provider-operation-${scenario}`);
  if (event === "host_destroyed") return digest(`provider-destroy-${scenario}`);
  if (event === "scenario_finished") return digest(`teardown-${scenario}`);
  return digest(`event-evidence-${scenario}-${event}`);
}

function eventFixture(handoff, scenario) {
  const attempt = handoff.handoff.attempts.find((entry) => entry.scenario === scenario);
  const order = dedicatedDrillEventOrder(scenario);
  const postBootId = digest(`post-reboot-boot-${scenario}`);
  let previousEventDigest = dedicatedDrillEventChainRoot(handoff, scenario);
  return order.map((event, index) => {
    const usePostBoot = scenario === "reboot" && index >= order.indexOf("host_reconnected");
    const built = buildDedicatedDrillEvent({
      scenario,
      sequence: index + 1,
      event,
      bootId: usePostBoot ? postBootId : attempt.hostLease.initialBootId,
      observedAt: NOW + 10_000 + index * 1_000,
      evidenceDigest: eventEvidenceDigest(attempt, scenario, event),
      previousEventDigest,
    }, handoff);
    previousEventDigest = built.eventDigest;
    return built;
  });
}

function reportInput(handoff, scenario = "success") {
  const attempt = handoff.handoff.attempts.find((entry) => entry.scenario === scenario);
  const events = eventFixture(handoff, scenario);
  const byName = Object.fromEntries(events.map((event) => [event.event, event]));
  const gatewayReceiptDigest = byName.gateway_ready.evidenceDigest;
  let faultProof;
  if (scenario !== "oom" && scenario !== "reboot") {
    const proofEvents = dedicatedDrillScenarioProofEvents(scenario);
    faultProof = {
      kind: "scenario_observation",
      scenario,
      ...proofEvents,
      stimulusEvidenceDigest: byName[proofEvents.stimulusEvent].evidenceDigest,
      outcomeEvidenceDigest: byName[proofEvents.observationEvent].evidenceDigest,
    };
  }
  if (scenario === "oom") {
    const memoryEventsBefore = {
      unitNameDigest: attempt.faultProfile.unitNameDigest,
      cgroupPathDigest: attempt.faultProfile.cgroupPathDigest,
      observedAt: byName.oom_limits_verified.observedAt,
      counters: { oom: 0, oomKill: 0, oomGroupKill: 0 },
    };
    const memoryEventsAfter = {
      unitNameDigest: attempt.faultProfile.unitNameDigest,
      cgroupPathDigest: attempt.faultProfile.cgroupPathDigest,
      observedAt: byName.oom_observed.observedAt,
      counters: { oom: 1, oomKill: 1, oomGroupKill: 0 },
    };
    faultProof = {
      kind: attempt.faultProfile.kind,
      memoryMaxBytes: attempt.faultProfile.memoryMaxBytes,
      memorySwapMaxBytes: attempt.faultProfile.memorySwapMaxBytes,
      allocationBytes: attempt.faultProfile.allocationBytes,
      unitNameDigest: attempt.faultProfile.unitNameDigest,
      cgroupPathDigest: attempt.faultProfile.cgroupPathDigest,
      memoryEventsBefore,
      memoryEventsAfter,
      memoryEventsBeforeDigest: sha256(Buffer.from(canonicalJson(memoryEventsBefore), "utf8")),
      memoryEventsAfterDigest: sha256(Buffer.from(canonicalJson(memoryEventsAfter), "utf8")),
      oomKillDelta: 1,
      systemdResult: "oom-kill",
      hostReachableAfterFault: true,
      containmentPresentAtFault: true,
      limitsEvidenceDigest: byName.oom_limits_verified.evidenceDigest,
      workloadEvidenceDigest: byName.oom_workload_started.evidenceDigest,
      evidenceDigest: byName.oom_observed.evidenceDigest,
    };
  } else if (scenario === "reboot") {
    faultProof = {
      kind: attempt.faultProfile.kind,
      providerOperation: {
        kind: "provider_reboot_receipt",
        operationNonceDigest: attempt.faultProfile.operationNonceDigest,
        provider: handoff.handoff.provider,
        providerScopeDigest: handoff.handoff.providerScopeDigest,
        instanceId: attempt.hostLease.instanceId,
        instanceIdentityDigest: attempt.hostLease.instanceIdentityDigest,
        controllerPrincipalDigest: handoff.handoff.controller.principalDigest,
        requestedAt: byName.reboot_requested.observedAt,
        unreachableAt: byName.host_unreachable.observedAt,
        reconnectedAt: byName.host_reconnected.observedAt,
        completedAt: byName.post_reboot_boot_observed.observedAt,
        receiptDigest: byName.reboot_requested.evidenceDigest,
      },
      instanceIdentityBeforeDigest: attempt.hostLease.instanceIdentityDigest,
      instanceIdentityAfterDigest: attempt.hostLease.instanceIdentityDigest,
      bootIdBefore: attempt.hostLease.initialBootId,
      bootIdAfter: byName.post_reboot_boot_observed.bootId,
      unreachableObserved: true,
      reconnectedObserved: true,
      postRebootUnitsIdle: true,
      postRebootContainmentAbsent: true,
      evidenceDigest: byName.post_reboot_boot_observed.evidenceDigest,
    };
  }
  const reboot = scenario === "reboot";
  const teardown = {
    gatewayStoppedAt: reboot ? byName.post_reboot_units_idle.observedAt : byName.gateway_stopped.observedAt,
    runnerUidIdleAt: reboot ? byName.post_reboot_units_idle.observedAt : byName.runner_uid_idle.observedAt,
    gatewayUidIdleAt: reboot ? byName.post_reboot_units_idle.observedAt : byName.gateway_uid_idle.observedAt,
    cgroupNamespaceCleanupAt: byName.cgroup_namespace_cleanup.observedAt,
    workspaceCleanupAt: byName.workspace_cleanup.observedAt,
    containmentFinalizedAt: reboot
      ? byName.post_reboot_containment_absent.observedAt
      : byName.nftables_policy_removed.observedAt,
    hostDestroyedAt: byName.host_destroyed.observedAt,
    containmentDisposition: reboot
      ? "reboot_reset_then_pre_policy_quiescence"
      : "table_removed_last_after_quiescence",
    preFilesystemQuiescenceProven: true,
    workspaceAbsent: true,
    containmentAbsent: true,
    tableRemovedLast: !reboot,
    rebootResetContainmentBeforeCleanup: reboot,
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
  const eventsDigest = sha256(Buffer.from(canonicalJson(events), "utf8"));
  const base = `${handoff.handoff.evidenceSink.locationReference}/dedicated-drill/` +
    `${handoff.digest.slice("sha256:".length)}/${attempt.attemptDigest.slice("sha256:".length)}`;
  const faultEvidence = scenario === "oom" ? [
    { name: "memory_events_before", digest: faultProof.memoryEventsBeforeDigest,
      objectReference: `${base}/fault/memory-events-before.json` },
    { name: "memory_events_after", digest: faultProof.memoryEventsAfterDigest,
      objectReference: `${base}/fault/memory-events-after.json` },
    { name: "limits", digest: faultProof.limitsEvidenceDigest,
      objectReference: `${base}/fault/limits.json` },
    { name: "workload", digest: faultProof.workloadEvidenceDigest,
      objectReference: `${base}/fault/workload.json` },
    { name: "observation", digest: faultProof.evidenceDigest,
      objectReference: `${base}/fault/observation.json` },
  ] : scenario === "reboot" ? [
    { name: "provider_operation", digest: faultProof.providerOperation.receiptDigest,
      objectReference: `${base}/provider-operation-receipt.json` },
    { name: "observation", digest: faultProof.evidenceDigest,
      objectReference: `${base}/fault/observation.json` },
  ] : [
    { name: "stimulus", digest: faultProof.stimulusEvidenceDigest,
      objectReference: `${base}/fault/stimulus.json` },
    { name: "outcome", digest: faultProof.outcomeEvidenceDigest,
      objectReference: `${base}/fault/outcome.json` },
  ];
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
      gatewayReceipt: { digest: gatewayReceiptDigest, objectReference: `${base}/gateway-receipt.json` },
      faultProof: {
        digest: sha256(Buffer.from(canonicalJson(faultProof), "utf8")),
        objectReference: `${base}/fault-proof.json`,
      },
      faultEvidence,
      teardown: {
        digest: sha256(Buffer.from(canonicalJson(teardown), "utf8")),
        objectReference: `${base}/teardown.json`,
      },
      providerLeaseReceipt: {
        digest: attempt.hostLease.providerLeaseReceiptDigest,
        objectReference: `${base}/provider-lease-receipt.json`,
      },
      providerOperationReceipt: reboot ? {
        digest: faultProof.providerOperation.receiptDigest,
        objectReference: `${base}/provider-operation-receipt.json`,
      } : null,
      providerDestroyReceipt: {
        digest: teardown.providerDestroyReceipt.receiptDigest,
        objectReference: `${base}/provider-destroy-receipt.json`,
      },
      rawEvidence: {
        digest: digest(`raw-evidence-${scenario}`),
        objectReference: `${base}/raw-evidence.tar.zst`,
      },
      appendReceipt: {
        digest: digest(`append-receipt-${scenario}`),
        objectReference: `${base}/append-receipt.json`,
      },
    },
  };
}

function recanonicalizeHandoff(record) {
  const canonical = canonicalJson(record.handoff);
  record.canonicalJson = canonical;
  record.digest = sha256(Buffer.from(canonical, "utf8"));
  return record;
}

function recanonicalizeReport(record) {
  const canonical = canonicalJson(record.report);
  record.canonicalJson = canonical;
  record.digest = sha256(Buffer.from(canonical, "utf8"));
  return record;
}

test("renders the canonical 17-attempt non-authorizing handoff with independent fresh hosts", () => {
  const rendered = renderHandoffFixture();
  const validated = validateDedicatedDrillHandoffRecord(rendered);
  assert.deepEqual(validated, rendered);
  assert.deepEqual(rendered.handoff.attempts.map(({ scenario }) => scenario),
    DEDICATED_DRILL_SCENARIOS.map(({ name }) => name));
  assert.equal(new Set(rendered.handoff.attempts.map(({ hostLease }) => hostLease.leaseId)).size, 17);
  assert.equal(new Set(rendered.handoff.attempts.map(({ hostLease }) => hostLease.instanceId)).size, 17);
  assert.ok(rendered.handoff.attempts.every(({ hostLease }) =>
    hostLease.fresh && hostLease.dedicated && hostLease.disposable && !hostLease.reused));
  assert.notEqual(rendered.handoff.controller.hostId, rendered.handoff.observer.hostId);
  assert.notEqual(rendered.handoff.controller.principalDigest, rendered.handoff.observer.principalDigest);
  assert.equal(rendered.handoff.authorizationStatus, DEDICATED_DRILL_AUTHORIZATION_STATUS);
  assert.equal(rendered.handoff.releaseEvidenceEligible, false);
  assert.equal(rendered.handoff.activationBlocked, true);
});

test("renders and canonically parses a generic attempt with a complete hash chain and table removed last", () => {
  const handoff = renderHandoffFixture();
  const rendered = renderDedicatedDrillAttemptReport(reportInput(handoff), handoff);
  const validated = validateDedicatedDrillAttemptReportRecord(rendered, handoff);
  const parsed = parseCanonicalDedicatedDrillAttemptReport(rendered.canonicalJson, handoff);
  assert.deepEqual(validated, rendered);
  assert.deepEqual(parsed.report, rendered.report);
  assert.equal(
    rendered.report.events[0].previousEventDigest,
    dedicatedDrillEventChainRoot(handoff, "success")
  );
  rendered.report.events.slice(1).forEach((event, index) => {
    assert.equal(event.previousEventDigest, rendered.report.events[index].eventDigest);
  });
  assert.equal(rendered.report.teardown.tableRemovedLast, true);
  assert.ok(rendered.report.teardown.workspaceCleanupAt < rendered.report.teardown.containmentFinalizedAt);
  assert.throws(() => parseCanonicalDedicatedDrillAttemptReport(`${rendered.canonicalJson}\n`, handoff),
    /not exact canonical JSON/);
});

test("proves a bounded cgroup-v2 OOM while the host and containment remain live", () => {
  const handoff = renderHandoffFixture();
  const rendered = renderDedicatedDrillAttemptReport(reportInput(handoff, "oom"), handoff);
  assert.equal(rendered.report.faultProof.kind, "bounded_cgroup_v2_oom");
  assert.equal(rendered.report.faultProof.oomKillDelta, 1);
  assert.equal(rendered.report.faultProof.systemdResult, "oom-kill");
  assert.equal(rendered.report.faultProof.hostReachableAfterFault, true);
  assert.equal(rendered.report.faultProof.containmentPresentAtFault, true);
});

test("proves an external reboot transition and post-boot cleanup without policy removal", () => {
  const handoff = renderHandoffFixture();
  const rendered = renderDedicatedDrillAttemptReport(reportInput(handoff, "reboot"), handoff);
  const events = rendered.report.events;
  const reconnect = events.findIndex(({ event }) => event === "host_reconnected");
  assert.ok(events.slice(0, reconnect).every(({ bootId }) =>
    bootId === rendered.report.faultProof.bootIdBefore));
  assert.ok(events.slice(reconnect).every(({ bootId }) =>
    bootId === rendered.report.faultProof.bootIdAfter));
  assert.notEqual(rendered.report.faultProof.bootIdBefore, rendered.report.faultProof.bootIdAfter);
  assert.equal(events.some(({ event }) => event === "nftables_policy_removed"), false);
  assert.equal(rendered.report.teardown.rebootResetContainmentBeforeCleanup, true);
  assert.ok(rendered.report.teardown.containmentFinalizedAt < rendered.report.teardown.cgroupNamespaceCleanupAt);
});

test("rejects authorizing handoff and report fields even with recomputed canonical bytes", () => {
  const substituted = structuredClone(renderHandoffFixture());
  substituted.handoff.activationBlocked = false;
  recanonicalizeHandoff(substituted);
  assert.throws(() => validateDedicatedDrillHandoffRecord(substituted), /cannot authorize release/);

  const handoff = renderHandoffFixture();
  const report = structuredClone(renderDedicatedDrillAttemptReport(reportInput(handoff), handoff));
  report.report.releaseEvidenceEligible = true;
  recanonicalizeReport(report);
  assert.throws(() => validateDedicatedDrillAttemptReportRecord(report, handoff), /cannot authorize release/);
});

test("rejects a co-resident or reused controller-observer identity", () => {
  const input = handoffInput();
  input.observer.hostId = input.controller.hostId;
  assert.throws(() => renderHandoffFixture(input), /independently identified and hosted/);
});

test("rejects duplicate leases and duplicate target instances across attempts", () => {
  for (const property of ["leaseId", "instanceId"]) {
    const input = handoffInput();
    input.attempts[1].hostLease[property] = input.attempts[0].hostLease[property];
    input.attempts[1].hostLease.providerLeaseReceipt[property] =
      input.attempts[0].hostLease.providerLeaseReceipt[property];
    assert.throws(() => renderHandoffFixture(input), /one fresh independent/);
  }
});

test("rejects a weak OOM proof", () => {
  const handoff = renderHandoffFixture();
  const input = reportInput(handoff, "oom");
  input.faultProof.oomKillDelta = 0;
  assert.throws(() => renderDedicatedDrillAttemptReport(input, handoff), /bounded cgroup kill and live host/);
});

test("rejects a missing reboot reachability transition", () => {
  const handoff = renderHandoffFixture();
  const input = reportInput(handoff, "reboot");
  input.events.splice(input.events.findIndex(({ event }) => event === "host_unreachable"), 1);
  assert.throws(() => renderDedicatedDrillAttemptReport(input, handoff), /event stream is incomplete/);
});

test("rejects wrong boot identities on reboot and non-reboot reports", () => {
  const handoff = renderHandoffFixture();
  const generic = structuredClone(reportInput(handoff));
  generic.events.at(-1).bootId = digest("substituted-generic-boot");
  const { eventDigest: _eventDigest, ...eventWithoutDigest } = generic.events.at(-1);
  generic.events.at(-1).eventDigest = sha256(Buffer.from(canonicalJson(eventWithoutDigest), "utf8"));
  assert.throws(() => renderDedicatedDrillAttemptReport(generic, handoff), /changed the bound boot identity/);

  const reboot = reportInput(handoff, "reboot");
  reboot.faultProof.bootIdAfter = reboot.faultProof.bootIdBefore;
  assert.throws(() => renderDedicatedDrillAttemptReport(reboot, handoff), /new boot/);
});

test("rejects a broken event chain and unsafe table teardown", () => {
  const handoff = renderHandoffFixture();
  const chain = structuredClone(reportInput(handoff));
  chain.events[1].previousEventDigest = digest("broken-chain");
  assert.throws(() => renderDedicatedDrillAttemptReport(chain, handoff), /reordered, unchained/);

  const teardown = reportInput(handoff);
  teardown.teardown.tableRemovedLast = false;
  assert.throws(() => renderDedicatedDrillAttemptReport(teardown, handoff), /teardown is incomplete/);
});

test("rejects substitution of controller-owned off-host evidence", () => {
  const handoff = renderHandoffFixture();
  const input = reportInput(handoff);
  input.evidenceBundle.sinkLocationDigest = digest("target-host-evidence");
  assert.throws(() => renderDedicatedDrillAttemptReport(input, handoff), /evidence bundle substitutes sinkLocationDigest/);
});
