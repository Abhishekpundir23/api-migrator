import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixtureDigest } from "./helpers/publication-runner-fixture.js";
import { createJobFixture } from "./helpers/runner-job-fixture.js";
import { prepareRunnerJob } from "../src/runner-job-producer.js";
import { inspectRunnerJob, validateStoredJob } from "../src/runner-job-service-core.js";
import { setJobStoreTransactionTestHook } from "../../db/src/runner-job-store-sqlite.js";

test("same expected job retries retain original identity and expiry without another row", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  const first = prepareRunnerJob(f.store, f.input, f.clock);
  f.state.wall = first.plan.plan.job.expiresAt - 1000;
  const retry = prepareRunnerJob(f.store, structuredClone(f.input), f.clock);
  assert.deepEqual(retry, first);
  assert.equal(f.store.list().length, 1);
  assert.equal(retry.plan.plan.job.createdAt, first.plan.plan.job.createdAt);
  assert.equal(retry.plan.plan.job.expiresAt, first.plan.plan.job.expiresAt);
  assert.throws(() => prepareRunnerJob(f.store,
    { ...f.input, imageDigest: fixtureDigest("another image") }, f.clock),
  { code: "job_conflict" });
});

for (const [name, change] of [
  ["dirty source", (f: ReturnType<typeof createJobFixture>) => writeFileSync(join(f.input.checkoutPath, "index.ts"), "changed\n")],
  ["missing source", (f: ReturnType<typeof createJobFixture>) => rmSync(f.input.checkoutPath, { recursive: true, force: true })],
  ["wrong approved base tree", (f: ReturnType<typeof createJobFixture>) => { f.input.base.treeSha = "f".repeat(40); }],
  ["wrong commit", (f: ReturnType<typeof createJobFixture>) => { f.input.base.sha = "f".repeat(40); }],
  ["invalid manifest", (f: ReturnType<typeof createJobFixture>) => { f.input.manifestJson += " "; }],
  ["invalid image", (f: ReturnType<typeof createJobFixture>) => { f.input.imageDigest = "not-a-digest"; }],
  ["invalid DNS", (f: ReturnType<typeof createJobFixture>) => { f.input.migrationInstallEgress[0]!.addresses = ["127.0.0.1"]; }],
] as const) {
  test(`${name} cannot create an expected job`, (t) => {
    const f = createJobFixture();
    t.after(() => f.close());
    change(f);
    assert.throws(() => prepareRunnerJob(f.store, f.input, f.clock), { code: "input_invalid" });
    assert.equal(f.store.list().length, 0);
  });
}

test("failed source validation retains observed high-water time", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  f.state.wall += 10;
  writeFileSync(join(f.input.checkoutPath, "index.ts"), "changed\n");
  assert.throws(() => prepareRunnerJob(f.store, f.input, f.clock), { code: "input_invalid" });
  writeFileSync(join(f.input.checkoutPath, "index.ts"), "export const fixture = 1;\n");
  f.state.wall -= 1;
  assert.throws(() => prepareRunnerJob(f.store, f.input, f.clock), { code: "clock_rollback" });
  assert.equal(f.store.list().length, 0);
});

test("repository ID and owner drift conflict with the prepared campaign and run", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  prepareRunnerJob(f.store, f.input, f.clock);
  for (const repository of [
    { ...f.input.repository, id: f.input.repository.id + 1 },
    { ...f.input.repository, ownerId: f.input.repository.ownerId + 1 },
  ]) assert.throws(() => prepareRunnerJob(f.store, { ...f.input, repository }, f.clock),
    { code: "job_conflict" });
  assert.equal(f.store.list().length, 1);
});

test("hidden fields, malformed Git OIDs, and time overrides fail before store I/O", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  const hidden = structuredClone(f.input);
  Object.defineProperty(hidden.repository, "hidden", { value: 1, enumerable: false });
  for (const input of [hidden, { ...f.input, base: { ...f.input.base, sha: "g".repeat(40) } },
    { ...f.input, now: f.state.wall }, { ...f.input, output: {} },
    { ...f.input, plan: {} }, { ...f.input, url: "https://example.com" },
    { ...f.input, retainedIdentity: {} }]) {
    assert.throws(() => prepareRunnerJob(f.store, input, f.clock), { code: "input_invalid" });
  }
  assert.equal(f.store.list().length, 0);
  // The rejected inputs did not even advance the trusted store clock.
  assert.doesNotThrow(() => f.store.observeTime(f.state.wall - 1));
});

test("input is detached before the clock callback can mutate caller data", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  const original = f.input.imageDigest;
  let called = false;
  const clock = { ...f.clock, wallNow() {
    if (!called) { called = true; f.input.imageDigest = fixtureDigest("mutated later"); }
    return f.state.wall;
  } };
  const prepared = prepareRunnerJob(f.store, f.input, clock);
  assert.equal(prepared.plan.plan.imageDigest, original);
});

test("expiry reached during preparation leaves no job row", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  let calls = 0;
  const clock = { ...f.clock, wallNow() {
    calls++;
    return calls >= 3 ? f.input.expiresAt : f.state.wall;
  } };
  assert.throws(() => prepareRunnerJob(f.store, f.input, clock), { code: "job_expired" });
  assert.equal(f.store.list().length, 0);
});

test("expiry first observed after durable insert preserves an immutable prepared row", (t) => {
  const f = createJobFixture();
  t.after(() => { setJobStoreTransactionTestHook(undefined); f.close(); });
  const createdAt = f.state.wall;
  const originalExpiry = f.input.expiresAt;
  setJobStoreTransactionTestHook((event) => {
    if (event.operation === "insert" && event.point === "after_commit") f.state.wall = originalExpiry;
  });
  assert.throws(() => prepareRunnerJob(f.store, f.input, f.clock), { code: "job_expired" });
  const [row] = f.store.list();
  assert.ok(row);
  const committed = validateStoredJob(row, f.storeId);
  assert.equal(committed.revision, 1);
  assert.equal(committed.state, "prepared");
  assert.equal(committed.plan.plan.job.createdAt, createdAt);
  assert.equal(committed.plan.plan.job.expiresAt, originalExpiry);
  assert.equal(committed.jobId, committed.plan.plan.job.id);
  const key = { campaignId: committed.campaignId, runId: committed.runId, jobId: committed.jobId };
  assert.deepEqual(inspectRunnerJob(f.store, key), committed);
  f.state.wall = originalExpiry;
  assert.throws(() => prepareRunnerJob(f.store, structuredClone(f.input), f.clock),
    { code: "job_expired" });
  assert.deepEqual(f.store.list(), [row]);
  assert.deepEqual(inspectRunnerJob(f.store, key), committed);
});

test("invalid trusted time cannot poison the store high-water mark", (t) => {
  const f = createJobFixture();
  t.after(() => f.close());
  const clock = { ...f.clock, wallNow: () => 8_640_000_000_000_001 };
  assert.throws(() => prepareRunnerJob(f.store, f.input, clock), { code: "input_invalid" });
  assert.doesNotThrow(() => f.store.observeTime(f.state.wall));
  assert.equal(f.store.list().length, 0);
});
