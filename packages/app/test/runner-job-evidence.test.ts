import assert from "node:assert/strict";
import test from "node:test";
import { acquireRunnerJobEvidence, runnerJobFailure } from "../src/runner-job-evidence.js";
import { encodeJobRecord } from "../src/runner-job-record-contract.js";
import { createJobEvidenceHarness, createJobFixture } from "./helpers/runner-job-fixture.js";
import { inspectRunnerJob } from "../src/runner-job-service-core.js";
import { prepareRunnerJob } from "../src/runner-job-producer.js";
import { canonicalJson } from "../src/canonical-json.js";
import { fixtureDigest } from "./helpers/publication-runner-fixture.js";
import { setJobStoreTransactionTestHook } from "../../db/src/runner-job-store-sqlite.js";
import { JobStoreError } from "../../db/src/runner-job-store-contract.js";
import { createRunnerJobService, createRunnerJobServiceForTest } from "../src/runner-job-record.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

function barrier(count = 1) {
  let release!: () => void;
  let arrived!: () => void;
  let arrivals = 0;
  const ready = new Promise<void>((resolve) => { arrived = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release, wait: async () => { if (++arrivals === count) arrived(); await pending; } };
}

test("genuine evidence retains metadata only and reopens without renewing or caching verification", async () => {
  const f = createJobFixture();
  try {
    const h = createJobEvidenceHarness(f);
    const first = await acquireRunnerJobEvidence(f.store, h.key, f.clock, h.client);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("fixture acquisition failed");
    assert.equal(first.value.revision, 3);
    assert.equal("verified" in first.value, false);
    assert.equal(h.state.reads, 2);
    const originalBytes = encodeJobRecord(first.value);
    f.store.close();
    const reopened = f.access.open(f.directory, f.storeId, f.policy);
    try {
      const again = await acquireRunnerJobEvidence(reopened, h.key, f.clock, h.client);
      assert.equal(again.ok, true);
      if (!again.ok) throw new Error("fixture reacquisition failed");
      assert.equal(encodeJobRecord(again.value), originalBytes);
      assert.equal(h.state.reads, 4);
      assert.equal(h.state.fetches, 2);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

for (const identical of [false, true]) test(`concurrent ${identical ? "identical" : "different"} genuine envelopes use immutable CAS`, async () => {
  const f = createJobFixture();
  const second = f.access.open(f.directory, f.storeId, f.policy);
  try {
    const h = createJobEvidenceHarness(f);
    const stateB = { ...h.state, envelope: identical ? h.state.envelope : h.signPayload({
      ...h.payload, runnerInstanceDigest: fixtureDigest("competing-instance"),
    }) };
    const gate = barrier(2);
    const pending = Promise.all([
      acquireRunnerJobEvidence(f.store, h.key, f.clock, h.createClient({ beforeFetchReturn: gate.wait })),
      acquireRunnerJobEvidence(second, h.key, f.clock, h.createClient({ state: stateB, beforeFetchReturn: gate.wait })),
    ]);
    await gate.ready;
    assert.equal(inspectRunnerJob(second, h.key).revision, 2);
    gate.release();
    const results = await pending;
    assert.equal(results.filter((r) => r.ok).length, identical ? 2 : 1);
    if (!identical) assert.deepEqual(results.find((r) => !r.ok), { ok: false, source: "job", code: "job_conflict" });
    const winner = inspectRunnerJob(second, h.key);
    assert.equal(winner.revision, 3);
    assert.equal(f.store.list().length, 1);
    assert.equal(h.state.reads, 2);
    assert.equal(stateB.reads, 2);
    assert.equal(winner.revision === 3 && winner.identity.expiresAt, f.sourceFixture.context.previewCompletedAt + 600_000);
  } finally { second.close(); f.close(); }
});

for (const change of ["instance", "revoked", "trust", "artifact", "tree"] as const) {
  test(`reacquisition rejects changed ${change} without changing retained row`, async () => {
    const f = createJobFixture();
    try {
      const h = createJobEvidenceHarness(f);
      assert.equal((await acquireRunnerJobEvidence(f.store, h.key, f.clock, h.client)).ok, true);
      const before = encodeJobRecord(inspectRunnerJob(f.store, h.key));
      const payload = structuredClone(h.payload);
      if (change === "instance") payload.runnerInstanceDigest = fixtureDigest("changed");
      if (change === "artifact") payload.output.artifactDigest = payload.execution.outputArtifactDigest = fixtureDigest("changed");
      if (change === "tree") payload.output.candidateTreeSha = payload.execution.candidateTreeSha = "4".repeat(40);
      h.state.envelope = h.signPayload(payload);
      if (change === "revoked" || change === "trust") {
        const registry = JSON.parse(h.state.registryBytes.toString());
        if (change === "revoked") registry.keys[0].revokedAt = f.state.wall;
        else registry.keys[0].validUntil -= 1;
        h.state.registryBytes = Buffer.from(canonicalJson(registry));
      }
      assert.deepEqual(await acquireRunnerJobEvidence(f.store, h.key, f.clock, h.client), {
        ok: false, source: "evidence", code: change === "revoked" ? "trust_unavailable" :
          change === "artifact" || change === "tree" ? "evidence_invalid" : "identity_changed",
      });
      assert.equal(encodeJobRecord(inspectRunnerJob(f.store, h.key)), before);
    } finally { f.close(); }
  });
}

for (const transport of ["malformed", "serialized-verified", "local-preview"] as const) {
  test(`${transport} transport cannot retain a capability or create revision three`, async () => {
    const f = createJobFixture();
    try {
      const h = createJobEvidenceHarness(f);
      if (transport === "serialized-verified") {
        const result = await h.client.acquireInitial(h.reviewed.revision !== 1 && h.reviewed.review);
        assert.equal(result.ok, true);
        if (!result.ok) throw new Error("genuine verification failed");
        h.state.envelope = JSON.stringify(result.verified);
      } else h.state.envelope = transport === "malformed" ? "{" : JSON.stringify({ kind: "local-preview", verified: true });
      const before = encodeJobRecord(inspectRunnerJob(f.store, h.key));
      assert.deepEqual(await acquireRunnerJobEvidence(f.store, h.key, f.clock, h.client), { ok: false, source: "evidence", code: "evidence_invalid" });
      assert.equal(encodeJobRecord(inspectRunnerJob(f.store, h.key)), before);
    } finally { f.close(); }
  });
}

test("invalid state and extended caller keys fail before network or registry work", async () => {
  const f = createJobFixture();
  try {
    const h = createJobEvidenceHarness(f);
    for (const extra of [{ identity: {} }, { plan: h.prepared.plan }]) {
      assert.deepEqual(await acquireRunnerJobEvidence(f.store, { ...h.key, ...extra }, f.clock, h.client),
        { ok: false, source: "job", code: "input_invalid" });
    }
    const prepared = prepareRunnerJob(f.store, { ...f.input, runId: "unreviewed" }, f.clock);
    assert.deepEqual(await acquireRunnerJobEvidence(f.store, { ...h.key, runId: prepared.runId, jobId: prepared.jobId }, f.clock, h.client),
      { ok: false, source: "job", code: "job_conflict" });
    assert.equal(h.state.reads, 0);
    assert.equal(h.state.fetches, 0);
  } finally { f.close(); }
});

test("pending I/O uses the detached original key", async () => {
  const f = createJobFixture();
  try {
    const h = createJobEvidenceHarness(f);
    const key = { ...h.key };
    const gate = barrier();
    const pending = acquireRunnerJobEvidence(f.store, key, f.clock, h.createClient({ beforeFetchReturn: gate.wait }));
    await gate.ready;
    key.runId = "changed";
    key.jobId = `previewjob_${"0".repeat(64)}`;
    gate.release();
    const result = await pending;
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.jobId, h.key.jobId);
  } finally { f.close(); }
});

for (const expiry of ["plan", "review", "key", "rollback", "monotonic"] as const) {
  test(`pending I/O rejects exact ${expiry} boundary with no retained row`, async () => {
    const f = createJobFixture();
    try {
      const h = createJobEvidenceHarness(f);
      let end = h.prepared.plan.plan.job.expiresAt;
      if (expiry === "review") end = f.sourceFixture.context.previewCompletedAt + 600_000;
      if (expiry === "key") {
        end = f.state.wall + 1_000;
        const registry = JSON.parse(h.state.registryBytes.toString());
        registry.keys[0].validUntil = end;
        h.state.registryBytes = Buffer.from(canonicalJson(registry));
      }
      const gate = barrier();
      const pending = acquireRunnerJobEvidence(f.store, h.key, f.clock, h.createClient({ beforeFetchReturn: gate.wait }));
      await gate.ready;
      if (expiry === "monotonic") f.state.monotonic = 10_000;
      else if (expiry === "rollback") f.state.wall -= 1;
      else f.state.wall = end;
      gate.release();
      assert.deepEqual(await pending, { ok: false, source: expiry === "rollback" ? "job" : "evidence",
        code: expiry === "rollback" ? "clock_rollback" : "expired" });
      assert.equal(inspectRunnerJob(f.store, h.key).revision, 2);
    } finally { f.close(); }
  });
}

test("expiry after durable CAS fails but preserves the immutable historical identity", async () => {
  const f = createJobFixture();
  try {
    const h = createJobEvidenceHarness(f);
    setJobStoreTransactionTestHook((event) => {
      if (event.operation === "compare_and_swap" && event.point === "after_commit") {
        f.state.wall = f.sourceFixture.context.previewCompletedAt + 600_000;
      }
    });
    assert.deepEqual(await acquireRunnerJobEvidence(f.store, h.key, f.clock, h.client),
      { ok: false, source: "job", code: "job_expired" });
    const history = inspectRunnerJob(f.store, h.key);
    assert.equal(history.revision, 3);
    const before = encodeJobRecord(history);
    assert.deepEqual(await acquireRunnerJobEvidence(f.store, h.key, f.clock, h.client),
      { ok: false, source: "job", code: "job_expired" });
    assert.equal(encodeJobRecord(inspectRunnerJob(f.store, h.key)), before);
    assert.equal(h.state.fetches, 1);
  } finally { setJobStoreTransactionTestHook(undefined); f.close(); }
});

test("failure normalization handles source DB errors and never leaks unknown exceptions", () => {
  assert.deepEqual(runnerJobFailure(new JobStoreError("clock_rollback")), { ok: false, source: "job", code: "clock_rollback" });
  for (const error of [new Error("secret SQL"), { name: "JobStoreError", code: "store_full" },
    Object.assign(new Error("secret path"), { name: "JobStoreError", code: "not_allowed" })]) {
    assert.deepEqual(runnerJobFailure(error), { ok: false, source: "job", code: "store_unavailable" });
  }
});

test("normal construction is IO-free, validates exact detached config, and cannot admit fixture roots", () => {
  const f = createJobFixture();
  try {
    const directory = join(f.directory, "not-created");
    const config = { directory, expectedStoreId: f.storeId, evidence: null };
    const policy = { migrationWorkspaceRoots: f.policy.migrationWorkspaceRoots };
    const service = createRunnerJobService(config, policy);
    assert.equal(service.ok, true);
    assert.equal(existsSync(directory), false);
    config.directory = f.directory;
    if (!service.ok) throw new Error("construction failed");
    assert.deepEqual(service.value.open(), { ok: false, source: "job", code: "store_unsafe" });
    for (const invalid of [{ ...config, clock: f.clock }, { ...config, client: {} },
      { ...config, expectedStoreId: "bad" }, { ...config, directory: "/path/../alias" }]) {
      assert.deepEqual(createRunnerJobService(invalid, policy), { ok: false, source: "job", code: "input_invalid" });
    }
    assert.deepEqual(createRunnerJobService(config, { ...policy, applicationCheckout: "/elsewhere" } as never),
      { ok: false, source: "job", code: "input_invalid" });
    assert.deepEqual(createRunnerJobService({ ...config, evidence: {} }, policy),
      { ok: false, source: "evidence", code: "configuration_invalid" });
  } finally { f.close(); }
});

test("null-evidence sessions prepare, review, inspect, then fail acquisition and close idempotently", async () => {
  const f = createJobFixture();
  try {
    let opens = 0;
    const service = createRunnerJobServiceForTest({ directory: f.directory, expectedStoreId: f.storeId, evidence: null },
      { migrationWorkspaceRoots: f.policy.migrationWorkspaceRoots }, { clock: f.clock, client: null,
        openStore: (...args) => { opens++; return f.access.open(...args); } });
    assert.equal(service.ok, true);
    assert.equal(opens, 0);
    if (!service.ok) throw new Error("construction failed");
    const opened = service.value.open();
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("open failed");
    const session = opened.value;
    const prepared = session.prepare(f.input);
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error("prepare failed");
    const key = { campaignId: prepared.value.campaignId, runId: prepared.value.runId, jobId: prepared.value.jobId };
    f.state.wall = f.sourceFixture.context.previewCompletedAt;
    assert.equal(session.recordReviewedOutput(key, f.sourceFixture.context.reviewedOutput, f.state.wall).ok, true);
    assert.deepEqual(await session.acquireEvidence(key), { ok: false, source: "evidence", code: "configuration_invalid" });
    assert.equal(session.inspect(key).ok, true);
    session.close(); session.close();
    const closed = { ok: false, source: "job", code: "store_unavailable" };
    assert.deepEqual(session.inspect(key), closed);
    assert.deepEqual(session.prepare(f.input), closed);
    assert.deepEqual(session.recordReviewedOutput(key, {}, 0), closed);
    assert.deepEqual(await session.acquireEvidence(key), closed);
    const reopened = service.value.open();
    assert.equal(reopened.ok, true);
    if (reopened.ok) { assert.equal(reopened.value.inspect(key).ok, true); reopened.value.close(); }
    assert.equal(opens, 2);
  } finally { f.close(); }
});

test("source-only service seam uses genuine verifier and closed pending acquisition cannot commit", async () => {
  const f = createJobFixture();
  try {
    const h = createJobEvidenceHarness(f);
    const gate = barrier();
    const service = createRunnerJobServiceForTest({ directory: f.directory, expectedStoreId: f.storeId, evidence: null },
      { migrationWorkspaceRoots: f.policy.migrationWorkspaceRoots }, { clock: f.clock,
        client: h.createClient({ beforeFetchReturn: gate.wait }), openStore: f.access.open });
    if (!service.ok) throw new Error("construction failed");
    const opened = service.value.open();
    if (!opened.ok) throw new Error("open failed");
    const pending = opened.value.acquireEvidence(h.key);
    await gate.ready;
    opened.value.close();
    gate.release();
    assert.deepEqual(await pending, { ok: false, source: "job", code: "store_unavailable" });
    assert.equal(inspectRunnerJob(f.store, h.key).revision, 2);
  } finally { f.close(); }
});

test("open validates every canonical row and closes its handle on validation failure", () => {
  const f = createJobFixture();
  try {
    const h = createJobEvidenceHarness(f);
    let closes = 0;
    const service = createRunnerJobServiceForTest({ directory: f.directory, expectedStoreId: f.storeId, evidence: null },
      { migrationWorkspaceRoots: f.policy.migrationWorkspaceRoots }, { clock: f.clock, client: null,
        openStore: (...args) => {
          const store = f.access.open(...args);
          return { ...store, list: () => [...store.list(), { ...store.list()[0]!, canonicalRecord: "{}" }],
            close: () => { closes++; store.close(); } };
        } });
    if (!service.ok) throw new Error("construction failed");
    assert.deepEqual(service.value.open(), { ok: false, source: "job", code: "store_corrupt" });
    assert.equal(closes, 1);
    assert.equal(inspectRunnerJob(f.store, h.key).revision, 2);
  } finally { f.close(); }
});

test("expiry during final durable time observation is rechecked before metadata success", async () => {
  const f = createJobFixture();
  try {
    const h = createJobEvidenceHarness(f);
    let committed = false;
    setJobStoreTransactionTestHook((event) => {
      if (event.operation === "compare_and_swap" && event.point === "after_commit") committed = true;
      if (committed && event.operation === "observe_time" && event.point === "after_commit") {
        f.state.wall = f.sourceFixture.context.previewCompletedAt + 600_000;
      }
    });
    assert.deepEqual(await acquireRunnerJobEvidence(f.store, h.key, f.clock, h.client),
      { ok: false, source: "job", code: "job_expired" });
    assert.equal(inspectRunnerJob(f.store, h.key).revision, 3);
  } finally { setJobStoreTransactionTestHook(undefined); f.close(); }
});

test("service reopen reacquires real evidence each time and inspects expired immutable history", async () => {
  const f = createJobFixture();
  try {
    const h = createJobEvidenceHarness(f);
    const service = createRunnerJobServiceForTest({ directory: f.directory, expectedStoreId: f.storeId, evidence: null },
      { migrationWorkspaceRoots: f.policy.migrationWorkspaceRoots }, { clock: f.clock, client: h.client, openStore: f.access.open });
    if (!service.ok) throw new Error("construction failed");
    let retained = "";
    for (let i = 0; i < 2; i++) {
      const opened = service.value.open();
      if (!opened.ok) throw new Error("open failed");
      try {
        const result = await opened.value.acquireEvidence(h.key);
        assert.equal(result.ok, true);
        if (!result.ok) throw new Error("acquisition failed");
        if (i === 0) retained = encodeJobRecord(result.value);
        else assert.equal(encodeJobRecord(result.value), retained);
      } finally { opened.value.close(); }
    }
    assert.equal(h.state.reads, 4);
    assert.equal(h.state.fetches, 2);
    f.state.wall = f.sourceFixture.context.previewCompletedAt + 600_000;
    const historical = service.value.open();
    if (!historical.ok) throw new Error("historical open failed");
    try {
      const inspected = historical.value.inspect(h.key);
      assert.equal(inspected.ok && encodeJobRecord(inspected.value), retained);
      assert.deepEqual(await historical.value.acquireEvidence(h.key), { ok: false, source: "job", code: "job_expired" });
      assert.equal(h.state.fetches, 2);
    } finally { historical.value.close(); }
  } finally { f.close(); }
});

for (const operation of ["prepare", "review"] as const) {
  for (const retry of [false, true]) {
    for (const boundary of ["expiry", "rollback"] as const) {
      test(`service ${operation} ${retry ? "retry" : "fresh"} rejects ${boundary} during final observation and preserves history`, () => {
        const f = createJobFixture();
        try {
          let read = false;
          let committed = false;
          const service = createRunnerJobServiceForTest({ directory: f.directory, expectedStoreId: f.storeId, evidence: null },
            { migrationWorkspaceRoots: f.policy.migrationWorkspaceRoots }, { clock: f.clock, client: null,
              openStore: (...args) => {
                const store = f.access.open(...args);
                return { ...store, read: (...key) => { read = true; return store.read(...key); } };
              } });
          if (!service.ok) throw new Error("construction failed");
          const opened = service.value.open();
          if (!opened.ok) throw new Error("open failed");
          const session = opened.value;
          try {
            let key: { campaignId: string; runId: string; jobId: string } | undefined;
            if (operation === "review" || retry) {
              const prepared = session.prepare(f.input);
              if (!prepared.ok) throw new Error("fixture preparation failed");
              key = { campaignId: prepared.value.campaignId, runId: prepared.value.runId, jobId: prepared.value.jobId };
            }
            f.state.wall = f.sourceFixture.context.previewCompletedAt;
            const completedAt = f.state.wall;
            const output = f.sourceFixture.context.reviewedOutput;
            if (operation === "review" && retry) {
              assert.equal(session.recordReviewedOutput(key!, output, completedAt).ok, true);
            }
            const original = retry ? f.store.list()[0]!.canonicalRecord : undefined;
            const observedAt = f.state.wall;
            const expiresAt = operation === "prepare" ? f.input.expiresAt : completedAt + 600_000;
            read = false;
            let boundaryReached = false;
            setJobStoreTransactionTestHook((event) => {
              if (event.point !== "after_commit") return;
              if (event.operation === (operation === "prepare" ? "insert" : "compare_and_swap")) committed = true;
              // Idempotent paths have read their existing row; fresh paths have
              // committed their new revision. Neither depends on clock-call counts.
              if (event.operation === "observe_time" && (retry ? read : committed)) {
                boundaryReached = true;
                f.state.wall = boundary === "expiry" ? expiresAt : observedAt - 1;
              }
            });
            const result = operation === "prepare" ? session.prepare(f.input) :
              session.recordReviewedOutput(key!, output, completedAt);
            assert.equal(boundaryReached, true);
            assert.equal(result.ok, false);
            assert.deepEqual(result, { ok: false, source: "job", code: boundary === "expiry" ? "job_expired" : "clock_rollback" });
            const [history] = f.store.list();
            assert.ok(history);
            assert.equal(history.revision, operation === "prepare" ? 1 : 2);
            if (original !== undefined) assert.equal(history.canonicalRecord, original);
            const inspected = session.inspect({ campaignId: history.campaignId, runId: history.runId, jobId: history.jobId });
            assert.equal(inspected.ok, true);
            if (inspected.ok) {
              assert.equal(encodeJobRecord(inspected.value), history.canonicalRecord);
              assert.equal(inspected.value.plan.plan.job.expiresAt, f.input.expiresAt);
              if (inspected.value.revision === 2) assert.equal(inspected.value.review.previewCompletedAt, completedAt);
            }
            assert.equal(f.store.list().length, 1);
          } finally { session.close(); }
        } finally { setJobStoreTransactionTestHook(undefined); f.close(); }
      });
    }
  }
}
