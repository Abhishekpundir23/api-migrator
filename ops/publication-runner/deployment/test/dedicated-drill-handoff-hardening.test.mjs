import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { canonicalJson, sha256 } from "../lib.mjs";
import {
  DEDICATED_DRILL_SCENARIOS,
  buildDedicatedDrillEvent,
  dedicatedDrillEventChainRoot,
  dedicatedDrillEventOrder,
  dedicatedDrillScenarioProofEvents,
  renderDedicatedDrillAttemptReport,
  renderDedicatedDrillHandoff,
} from "../dedicated-drill-handoff.mjs";

const NOW = 2_000_000_000_000;
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
    const expiresAt = NOW + 900_000 + index * 1_000;
    const attempt = {
      scenario: name,
      scenarioNonce: digest(`scenario-nonce-${name}`),
      deadlineAt: NOW + 600_000 + index * 1_000,
      jobId: `previewjob_${(index + 1).toString(16).padStart(64, "0")}`,
      bindings,
      hostLease: {
        leaseId,
        provider: "acme-cloud",
        providerScopeDigest: PROVIDER_SCOPE_DIGEST,
        providerLeaseReceiptDigest,
        providerLeaseReceipt: {
          kind: "provider_lease_receipt",
          provider: "acme-cloud",
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
    suiteId: `dedicatedsuite_${"a".repeat(64)}`,
    sourceRevision: "b".repeat(40),
    issuedAt: NOW,
    provider: "acme-cloud",
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

function eventFixture(handoff, scenario, unavailableMs = undefined) {
  const attempt = attemptFor(handoff, scenario);
  const order = dedicatedDrillEventOrder(scenario);
  const unreachableIndex = order.indexOf("host_unreachable");
  const reconnectIndex = order.indexOf("host_reconnected");
  const postBootId = digest(`post-reboot-boot-${scenario}`);
  const base = NOW + 10_000;
  const unreachableAt = base + unreachableIndex * 1_000;
  let previousEventDigest = dedicatedDrillEventChainRoot(handoff, scenario);
  return order.map((event, index) => {
    let observedAt = base + index * 1_000;
    if (scenario === "reboot" && unavailableMs !== undefined && index >= reconnectIndex) {
      observedAt = unreachableAt + unavailableMs + (index - reconnectIndex) * 1_000;
    }
    const built = buildDedicatedDrillEvent({
      scenario,
      sequence: index + 1,
      event,
      bootId: scenario === "reboot" && index >= reconnectIndex
        ? postBootId
        : attempt.hostLease.initialBootId,
      observedAt,
      evidenceDigest: event === "host_lease_verified"
        ? attempt.hostLease.providerLeaseReceiptDigest
        : digest(`event-evidence-${scenario}-${event}`),
      previousEventDigest,
    }, handoff);
    previousEventDigest = built.eventDigest;
    return built;
  });
}

function reportInput(handoff, scenario = "success", events = eventFixture(handoff, scenario)) {
  const attempt = attemptFor(handoff, scenario);
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
      counters: { oom: 3, oomKill: 2, oomGroupKill: 0 },
    };
    const memoryEventsAfter = {
      unitNameDigest: attempt.faultProfile.unitNameDigest,
      cgroupPathDigest: attempt.faultProfile.cgroupPathDigest,
      observedAt: byName.oom_observed.observedAt,
      counters: { oom: 4, oomKill: 3, oomGroupKill: 0 },
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
  const eventEvidence = events.map((event) => ({
    sequence: event.sequence,
    event: event.event,
    eventDigest: event.eventDigest,
    evidenceDigest: event.evidenceDigest,
    objectReference: `${base}/events/${String(event.sequence).padStart(2, "0")}-${event.event}.json`,
  }));
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
  ] : [{
    name: "stimulus",
    digest: faultProof.stimulusEvidenceDigest,
    objectReference: `${base}/fault/stimulus.json`,
  }, {
    name: "outcome",
    digest: faultProof.outcomeEvidenceDigest,
    objectReference: `${base}/fault/outcome.json`,
  }];
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
      eventEvidence,
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
      providerOperationReceipt: scenario === "reboot" ? {
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

function attemptFor(handoff, scenario) {
  return handoff.handoff.attempts.find((attempt) => attempt.scenario === scenario);
}

test("rejects replaying an event chain under a different handoff and source revision", () => {
  const first = renderDedicatedDrillHandoff(handoffInput());
  const replayedEvents = eventFixture(first, "success");
  const secondInput = handoffInput();
  secondInput.suiteId = `dedicatedsuite_${"c".repeat(64)}`;
  secondInput.sourceRevision = "d".repeat(40);
  const second = renderDedicatedDrillHandoff(secondInput);

  assert.notEqual(attemptFor(first, "success").attemptDigest, attemptFor(second, "success").attemptDigest);
  assert.throws(
    () => renderDedicatedDrillAttemptReport(reportInput(second, "success", replayedEvents), second),
    /handoff|source|event|chain|substitut|replay/i
  );
});

test("rejects controller and observer identities in the same trust domain", () => {
  const input = handoffInput();
  input.observer.trustDomain = input.controller.trustDomain;
  assert.throws(
    () => renderDedicatedDrillHandoff(input),
    /trust|independent/i
  );
});

test("rejects a stale host even when the lease labels it fresh", () => {
  const input = handoffInput();
  input.attempts[0].hostLease.createdAt = NOW - 24 * 60 * 60 * 1_000;
  assert.throws(
    () => renderDedicatedDrillHandoff(input),
    /fresh|creation|stale|lease/i
  );
});

test("rejects overly long attempt deadlines and host leases", async (t) => {
  await t.test("deadline window", () => {
    const input = handoffInput();
    input.attempts[0].deadlineAt = NOW + 24 * 60 * 60 * 1_000;
    input.attempts[0].hostLease.expiresAt = NOW + 25 * 60 * 60 * 1_000;
    assert.throws(
      () => renderDedicatedDrillHandoff(input),
      /deadline|duration|window|lease/i
    );
  });

  await t.test("lease window", () => {
    const input = handoffInput();
    input.attempts[0].hostLease.expiresAt = NOW + 24 * 60 * 60 * 1_000;
    assert.throws(
      () => renderDedicatedDrillHandoff(input),
      /expiry|duration|window|lease/i
    );
  });
});

test("rejects short-lived or credential-bearing evidence locations", async (t) => {
  await t.test("retention shorter than 30 days after the final deadline", () => {
    const input = handoffInput();
    const latestDeadline = Math.max(...input.attempts.map(({ deadlineAt }) => deadlineAt));
    input.evidenceSink.retentionUntil = latestDeadline + 30 * 24 * 60 * 60 * 1_000 - 1;
    assert.throws(
      () => renderDedicatedDrillHandoff(input),
      /evidence sink|retention|off-host|target-inaccessible/i
    );
  });

  await t.test("object reference containing embedded credentials", () => {
    const input = handoffInput();
    input.evidenceSink.locationReference = "https://user:secret@example.com/dedicated-suite";
    input.evidenceSink.locationDigest = sha256(
      Buffer.from(input.evidenceSink.locationReference, "utf8")
    );
    assert.throws(
      () => renderDedicatedDrillHandoff(input),
      /credential-free off-host object reference/i
    );
  });

  await t.test("object reference containing a normalizable path alias", () => {
    const input = handoffInput();
    input.evidenceSink.locationReference = "https://evidence.example/a/../dedicated-suite";
    input.evidenceSink.locationDigest = sha256(
      Buffer.from(input.evidenceSink.locationReference, "utf8")
    );
    assert.throws(
      () => renderDedicatedDrillHandoff(input),
      /exact canonical object reference/i
    );
  });

  for (const hostname of ["127.0.0.2", "0.0.0.0", "evidence.localhost"]) {
    await t.test(`object reference using non-off-host name ${hostname}`, () => {
      const input = handoffInput();
      input.evidenceSink.locationReference = `https://${hostname}/dedicated-suite`;
      input.evidenceSink.locationDigest = sha256(
        Buffer.from(input.evidenceSink.locationReference, "utf8")
      );
      assert.throws(
        () => renderDedicatedDrillHandoff(input),
        /credential-free off-host object reference/i
      );
    });
  }
});

test("rejects reuse of one initial boot identity across target hosts", () => {
  const input = handoffInput();
  input.attempts[1].hostLease.initialBootId = input.attempts[0].hostLease.initialBootId;
  assert.throws(
    () => renderDedicatedDrillHandoff(input),
    /boot|independent|reuse/i
  );
});

test("rejects reuse of one bound job digest across target hosts", () => {
  const input = handoffInput();
  input.attempts[1].bindings.jobDigest = input.attempts[0].bindings.jobDigest;
  assert.throws(
    () => renderDedicatedDrillHandoff(input),
    /one fresh independent job digest/i
  );
});

test("rejects provider or provider-scope drift inside one suite", async (t) => {
  await t.test("provider", () => {
    const input = handoffInput();
    input.attempts[1].hostLease.provider = "other-cloud";
    assert.throws(
      () => renderDedicatedDrillHandoff(input),
      /provider|scope|suite/i
    );
  });

  await t.test("provider scope", () => {
    const input = handoffInput();
    input.attempts[1].hostLease.providerScopeDigest = digest("other-provider-scope");
    assert.throws(
      () => renderDedicatedDrillHandoff(input),
      /provider|scope|suite/i
    );
  });

  await t.test("structured lease receipt instance binding", () => {
    const input = handoffInput();
    input.attempts[0].hostLease.providerLeaseReceipt.instanceId = "instance/substituted-lease";
    assert.throws(
      () => renderDedicatedDrillHandoff(input),
      /provider lease receipt substitutes instanceId/i
    );
  });
});

test("binds every generic scenario to its own ordered stimulus and observation", () => {
  const handoff = renderDedicatedDrillHandoff(handoffInput());
  const genericScenarios = DEDICATED_DRILL_SCENARIOS
    .map(({ name }) => name)
    .filter((name) => name !== "oom" && name !== "reboot");
  const cleanupBoundary = {
    gateway_stop: "offline_network_checked",
    uid_idle: "gateway_uid_idle",
    policy_removal: "nftables_policy_removed",
    cgroup_namespace_cleanup: "cgroup_namespace_cleanup",
    workspace_cleanup: "workspace_cleanup",
  };

  for (const scenario of genericScenarios) {
    const proofEvents = dedicatedDrillScenarioProofEvents(scenario);
    const order = dedicatedDrillEventOrder(scenario);
    const stimulusIndex = order.indexOf(proofEvents.stimulusEvent);
    const observationIndex = order.indexOf(proofEvents.observationEvent);
    assert.notEqual(stimulusIndex, -1, `${scenario} stimulus`);
    assert.notEqual(observationIndex, -1, `${scenario} observation`);
    assert.ok(stimulusIndex < observationIndex, `${scenario} stimulus precedes observation`);
    if (cleanupBoundary[scenario]) {
      assert.ok(
        order.indexOf(cleanupBoundary[scenario]) < observationIndex,
        `${scenario} observation follows its defining teardown event`
      );
    } else {
      assert.ok(observationIndex < order.indexOf("gateway_stopped"));
    }
    assert.doesNotThrow(
      () => renderDedicatedDrillAttemptReport(reportInput(handoff, scenario), handoff),
      scenario
    );
  }

  assert.deepEqual(dedicatedDrillScenarioProofEvents("timeout"), {
    stimulusEvent: "timeout_injected",
    observationEvent: "timeout_observed",
  });
  assert.deepEqual(dedicatedDrillScenarioProofEvents("sigkill"), {
    stimulusEvent: "sigkill_injected",
    observationEvent: "sigkill_observed",
  });
});

test("all 17 runtime-rendered reports satisfy their strict conditional schema branch", () => {
  const handoff = renderDedicatedDrillHandoff(handoffInput());
  const schema = JSON.parse(readFileSync(
    new URL("../dedicated-drill-attempt-report.schema.json", import.meta.url),
    "utf8"
  ));
  const validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  for (const { name: scenario } of DEDICATED_DRILL_SCENARIOS) {
    const rendered = renderDedicatedDrillAttemptReport(reportInput(handoff, scenario), handoff);
    assert.equal(
      validator(rendered.report),
      true,
      `${scenario}: ${validator.errors?.map(({ instancePath, message }) =>
        `${instancePath} ${message}`).join("; ")}`
    );
  }
});

test("rejects a generic proof labeled as another scenario", () => {
  const handoff = renderDedicatedDrillHandoff(handoffInput());
  const input = reportInput(handoff, "success");
  input.faultProof.scenario = "timeout";
  assert.throws(
    () => renderDedicatedDrillAttemptReport(input, handoff),
    /generic scenario proof is substituted/i
  );
});

test("accepts the reboot unavailability maximum and rejects one millisecond beyond it", () => {
  const handoff = renderDedicatedDrillHandoff(handoffInput());
  const maximum = attemptFor(handoff, "reboot").faultProfile.maxUnavailableMs;
  const atMaximum = eventFixture(handoff, "reboot", maximum);
  assert.doesNotThrow(
    () => renderDedicatedDrillAttemptReport(reportInput(handoff, "reboot", atMaximum), handoff)
  );

  const overMaximum = eventFixture(handoff, "reboot", maximum + 1);
  assert.throws(
    () => renderDedicatedDrillAttemptReport(reportInput(handoff, "reboot", overMaximum), handoff),
    /reboot|unavailable|duration|maximum/i
  );
});

test("rejects identical OOM before/after evidence and inconsistent kill counters", async (t) => {
  const handoff = renderDedicatedDrillHandoff(handoffInput());

  await t.test("identical before and after evidence", () => {
    const input = reportInput(handoff, "oom");
    input.faultProof.memoryEventsAfter = structuredClone(input.faultProof.memoryEventsBefore);
    input.faultProof.memoryEventsAfterDigest = input.faultProof.memoryEventsBeforeDigest;
    assert.throws(
      () => renderDedicatedDrillAttemptReport(input, handoff),
      /OOM|memory|before|after|evidence/i
    );
  });

  await t.test("declared delta does not match observed counters", () => {
    const input = reportInput(handoff, "oom");
    input.faultProof.oomKillDelta = 2;
    assert.throws(
      () => renderDedicatedDrillAttemptReport(input, handoff),
      /OOM|counter|delta|unsupported/i
    );
  });

  await t.test("oom kill increases without an OOM event increase", () => {
    const input = reportInput(handoff, "oom");
    input.faultProof.memoryEventsAfter.counters.oom =
      input.faultProof.memoryEventsBefore.counters.oom;
    input.faultProof.memoryEventsAfterDigest = sha256(
      Buffer.from(canonicalJson(input.faultProof.memoryEventsAfter), "utf8")
    );
    assert.throws(
      () => renderDedicatedDrillAttemptReport(input, handoff),
      /OOM|counter|kill|unsupported/i
    );
  });

  await t.test("snapshot substitutes its bound cgroup", () => {
    const input = reportInput(handoff, "oom");
    input.faultProof.memoryEventsBefore.cgroupPathDigest = digest("other-cgroup-path");
    input.faultProof.memoryEventsBeforeDigest = sha256(
      Buffer.from(canonicalJson(input.faultProof.memoryEventsBefore), "utf8")
    );
    assert.throws(
      () => renderDedicatedDrillAttemptReport(input, handoff),
      /substitutes its cgroup, unit, or observation boundary/i
    );
  });

  await t.test("snapshot substitutes its observation boundary", () => {
    const input = reportInput(handoff, "oom");
    input.faultProof.memoryEventsAfter.observedAt -= 1;
    input.faultProof.memoryEventsAfterDigest = sha256(
      Buffer.from(canonicalJson(input.faultProof.memoryEventsAfter), "utf8")
    );
    assert.throws(
      () => renderDedicatedDrillAttemptReport(input, handoff),
      /substitutes its cgroup, unit, or observation boundary/i
    );
  });
});

test("rejects event, receipt, and teardown evidence substitution", async (t) => {
  const handoff = renderDedicatedDrillHandoff(handoffInput());

  await t.test("event evidence", () => {
    const input = reportInput(handoff);
    input.evidenceBundle.eventEvidence[0].evidenceDigest = digest("substituted-event-evidence");
    assert.throws(
      () => renderDedicatedDrillAttemptReport(input, handoff),
      /event|evidence|digest|chain/i
    );
  });

  await t.test("gateway receipt evidence", () => {
    const input = reportInput(handoff);
    input.gatewayReceiptDigest = digest("substituted-gateway-receipt");
    assert.throws(
      () => renderDedicatedDrillAttemptReport(input, handoff),
      /gateway|receipt|evidence|digest|substitut/i
    );
  });

  await t.test("teardown evidence", () => {
    const input = reportInput(handoff);
    input.teardown.evidenceDigest = digest("substituted-teardown-evidence");
    assert.throws(
      () => renderDedicatedDrillAttemptReport(input, handoff),
      /teardown|evidence|digest|substitut/i
    );
  });
});
