import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import test, { type TestContext } from "node:test";
import { createJobEvidenceHarness, createJobFixture } from "./helpers/runner-job-fixture.js";
import { prepareRunnerJob } from "../src/runner-job-producer.js";
import { inspectRunnerJob } from "../src/runner-job-service-core.js";
import { assertJobCurrent, decodeJobRecord, encodeJobRecord, type JobKey, type JobRecord } from "../src/runner-job-record-contract.js";
import { acquireRunnerJobEvidence } from "../src/runner-job-evidence.js";

type Fixture = ReturnType<typeof createJobFixture>;
type Operation = "prepare" | "review" | "retain";
type Point = "before_commit" | "after_commit";
type Message = { event: "ready" | Point | "result"; operation: Operation; result?: { ok: boolean; value?: JobRecord; source?: string; code?: string } };
const keyOf = (record: JobRecord): JobKey => ({ campaignId: record.campaignId, runId: record.runId, jobId: record.jobId });

function waitForFixtureMessage(child: ChildProcess, event: Message["event"], operation: Operation): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`worker timed out: ${operation}/${event}`)), 8000);
    const onExit = () => done(new Error(`worker exited before ${operation}/${event}`));
    const onError = (error: Error) => done(error);
    const onMessage = (value: unknown) => {
      const message = value as Message;
      if (message.event === event && message.operation === operation) done(undefined, message);
    };
    function done(error?: Error, value?: Message) {
      clearTimeout(timer);
      child.off("message", onMessage); child.off("exit", onExit); child.off("error", onError);
      if (error) reject(error); else resolve(value!);
    }
    child.on("message", onMessage); child.on("exit", onExit); child.on("error", onError);
  });
}

function waitForFixtureExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off("exit", onExit); reject(new Error("worker exit timeout")); }, 8000);
    const onExit = () => { clearTimeout(timer); resolve(); };
    child.once("exit", onExit);
  });
}

function startFixtureProcess(t: TestContext, f: Fixture, operation: Operation) {
  const child = fork(new URL("./helpers/runner-job-process.ts", import.meta.url), [operation], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(async () => {
    const exited = waitForFixtureExit(child);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const ready = waitForFixtureMessage(child, "ready", operation);
  const request = { root: dirname(f.directory), directory: f.directory, storeId: f.storeId,
    policy: f.policy, wall: f.state.wall, operation, input: f.input,
    completedAt: f.sourceFixture.context.previewCompletedAt, output: f.sourceFixture.context.reviewedOutput };
  return { child, ready, request };
}

function reopenAndInspectFixtureJob(f: Fixture, key: JobKey) {
  const store = f.access.open(f.directory, f.storeId, f.policy);
  try { return inspectRunnerJob(store, key); } finally { store.close(); }
}

for (const operation of ["prepare", "review", "retain"] as const) {
  for (const point of ["before_commit", "after_commit"] as const) {
    test(`${operation} interrupted ${point} reopens only the complete old or new revision`, { timeout: 10000 }, async (t) => {
      const f = createJobFixture();
      const h = operation === "retain" ? createJobEvidenceHarness(f) : null;
      const previous = h?.reviewed ?? (operation === "review" ? prepareRunnerJob(f.store, f.input, f.clock) : null);
      if (operation === "review") f.state.wall = f.sourceFixture.context.previewCompletedAt;
      f.store.close();
      const worker = startFixtureProcess(t, f, operation);
      t.after(() => f.close());
      await worker.ready;
      const barrier = waitForFixtureMessage(worker.child, point, operation);
      worker.child.send({ ...worker.request, point, key: previous && keyOf(previous),
        evidence: h && { envelope: h.state.envelope, registryJson: h.state.registryBytes.toString("utf8") } });
      await barrier;
      const exited = waitForFixtureExit(worker.child);
      worker.child.kill("SIGKILL");
      await exited;
      assert.equal(worker.child.signalCode, "SIGKILL");
      const store = f.access.open(f.directory, f.storeId, f.policy);
      let recovered: Readonly<JobRecord> | null = null;
      try {
        const rows = store.list();
        if (operation === "prepare" && point === "before_commit") assert.equal(rows.length, 0);
        else {
          assert.equal(rows.length, 1);
          const key = previous ? keyOf(previous) : { campaignId: f.input.campaignId, runId: f.input.runId, jobId: rows[0]!.jobId };
          recovered = inspectRunnerJob(store, key);
          assert.equal(recovered.revision, (previous?.revision ?? 0) + (point === "after_commit" ? 1 : 0));
          assert.doesNotThrow(() => decodeJobRecord(encodeJobRecord(recovered!)));
          if (point === "before_commit") assert.deepEqual(recovered, previous);
          if (operation === "prepare") assert.deepEqual(prepareRunnerJob(store, f.input, f.clock), recovered);
          if (operation === "retain" && point === "after_commit") {
            assert.equal(recovered.state, "evidence_retained");
            const result = await acquireRunnerJobEvidence(store, key, f.clock, h!.client);
            assert.deepEqual(result, { ok: true, value: recovered });
            assert.equal(h!.state.reads, 2);
            assert.equal(h!.state.fetches, 1);
          }
        }
      } finally { store.close(); }
      if (recovered) assert.deepEqual(reopenAndInspectFixtureJob(f, keyOf(recovered)), recovered);
    });
  }
}

for (const conflicting of [false, true]) {
  test(`two fresh processes preparing ${conflicting ? "conflicting intents expose no loser identity" : "the same intent return one identity"}`, { timeout: 10000 }, async (t) => {
    const f = createJobFixture(); f.store.close();
    const workers = [startFixtureProcess(t, f, "prepare"), startFixtureProcess(t, f, "prepare")];
    t.after(() => f.close());
    await Promise.all(workers.map((worker) => worker.ready));
    for (const [index, worker] of workers.entries()) {
      const opened = waitForFixtureMessage(worker.child, "ready", "prepare");
      worker.child.send({ ...worker.request, waitForStart: true,
        input: conflicting && index === 1 ? { ...f.input, imageDigest: `sha256:${"a".repeat(64)}` } : f.input });
      await opened;
    }
    const results = workers.map((worker) => waitForFixtureMessage(worker.child, "result", "prepare"));
    const exits = workers.map((worker) => waitForFixtureExit(worker.child));
    workers.forEach((worker) => worker.child.send({ start: true }));
    const replies = (await Promise.all(results)).map((message) => message.result!);
    await Promise.all(exits);
    for (const worker of workers) assert.equal(worker.child.exitCode, 0);
    const winners = replies.filter((reply) => reply.ok);
    assert.equal(winners.length, conflicting ? 1 : 2, JSON.stringify(replies.map(({ ok, code }) => ({ ok, code }))));
    if (conflicting) assert.deepEqual(replies.find((reply) => !reply.ok), { ok: false, source: "job", code: "job_conflict" });
    else assert.deepEqual(replies[0], replies[1]);
    const winner = winners[0]!.value!;
    assert.deepEqual(reopenAndInspectFixtureJob(f, keyOf(winner)), winner);
    const store = f.access.open(f.directory, f.storeId, f.policy);
    try { assert.equal(store.list().length, 1); } finally { store.close(); }
  });
}

test("reopen preserves expired history alongside a current job without minting evidence", (t) => {
  const f = createJobFixture(); t.after(() => f.close());
  const expired = prepareRunnerJob(f.store, f.input, f.clock);
  f.state.wall = expired.plan.plan.job.expiresAt;
  const current = prepareRunnerJob(f.store, { ...f.input, runId: "later_run", expiresAt: f.state.wall + 60_000,
    migrationInstallEgress: f.input.migrationInstallEgress.map((destination) => ({ ...destination,
      resolutionObservedAt: f.state.wall, resolutionExpiresAt: f.state.wall + 120_000 })) }, f.clock);
  const originalRows = f.store.list(); f.store.close();
  const store = f.access.open(f.directory, f.storeId, f.policy);
  try {
    assert.deepEqual(store.list(), originalRows);
    const old = inspectRunnerJob(store, keyOf(expired));
    const fresh = inspectRunnerJob(store, keyOf(current));
    assert.doesNotThrow(() => decodeJobRecord(encodeJobRecord(old)));
    assert.doesNotThrow(() => assertJobCurrent(fresh, f.state.wall));
    assert.throws(() => assertJobCurrent(old, f.state.wall), { code: "job_expired" });
    assert.deepEqual(old, expired); assert.deepEqual(fresh, current);
    assert.equal("identity" in old, false); assert.equal("identity" in fresh, false);
  } finally { store.close(); }
});
