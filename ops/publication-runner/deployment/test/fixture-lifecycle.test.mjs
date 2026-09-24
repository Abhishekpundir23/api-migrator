import assert from "node:assert/strict";
import test from "node:test";
import { runFixtureLifecycle } from "../fixture-lifecycle.mjs";

const expected = ["installPolicy", "prepare", "startGateway", "probeOnline",
  "install", "stopGateway", "assertOffline", "migrate", "verify", "cleanup"];

function fixture(failureAt, cleanupResult = { complete: true }) {
  const calls = [];
  const operations = Object.fromEntries(expected.map((name) => [name, async () => {
    calls.push(name);
    if (name === failureAt) throw new Error(`${name} failed`);
    return name === "cleanup" ? cleanupResult : { fixture: true };
  }]));
  return { calls, operations };
}

test("runs literal lifecycle order and marks verified result non-authorizing", async () => {
  const { calls, operations } = fixture();
  const result = await runFixtureLifecycle(operations);
  assert.deepEqual(calls, expected);
  assert.equal(result.fixture, true);
  assert.equal(result.activationBlocked, true);
  assert.equal(result.releaseEvidenceEligible, false);
  assert.equal(result.externalSigningEligible, false);
  assert.equal(result.securityDrill, false);
  assert.equal(result.selfAttested, true);
});

for (const failedStep of expected.slice(0, -1)) {
  test(`${failedStep} failure stops later phases and still cleans up`, async () => {
    const { calls, operations } = fixture(failedStep);
    await assert.rejects(runFixtureLifecycle(operations), new RegExp(`${failedStep} failed`));
    assert.deepEqual(calls, [...expected.slice(0, expected.indexOf(failedStep) + 1), "cleanup"]);
  });
}

test("cleanup rejection and incomplete cleanup reject an otherwise verified result", async () => {
  for (const [failureAt, cleanupResult] of [["cleanup", { complete: true }], [null, { complete: false }]]) {
    const { calls, operations } = fixture(failureAt, cleanupResult);
    await assert.rejects(runFixtureLifecycle(operations), /cleanup/);
    assert.deepEqual(calls, expected);
  }
});

test("original phase and cleanup errors both remain observable", async () => {
  const { calls, operations } = fixture("install");
  operations.cleanup = async () => { calls.push("cleanup"); throw new Error("cleanup failed"); };
  await assert.rejects(runFixtureLifecycle(operations), (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((inner) => inner.message), ["install failed", "cleanup failed"]);
    return true;
  });
  assert.deepEqual(calls, [...expected.slice(0, expected.indexOf("install") + 1), "cleanup"]);
});

test("falsy phase and cleanup rejections still fail closed", async () => {
  for (const rejected of [undefined, null, false, 0]) {
    const first = fixture();
    first.operations.stopGateway = async () => { first.calls.push("stopGateway"); throw rejected; };
    await assert.rejects(runFixtureLifecycle(first.operations), (error) => error === rejected);
    assert.deepEqual(first.calls, [...expected.slice(0, expected.indexOf("stopGateway") + 1), "cleanup"]);

    const second = fixture();
    second.operations.cleanup = async () => { second.calls.push("cleanup"); throw rejected; };
    await assert.rejects(runFixtureLifecycle(second.operations), (error) => error === rejected);
    assert.deepEqual(second.calls, expected);
  }
});

test("malformed operation surfaces fail before side effects", async () => {
  for (const malformed of [null, {}, { ...fixture().operations, verify: null }, { ...fixture().operations, extra: async () => {} }]) {
    const calls = [];
    const operations = malformed && Object.fromEntries(Object.entries(malformed).map(([name, operation]) => [name,
      typeof operation === "function" ? async () => { calls.push(name); return operation(); } : operation]));
    await assert.rejects(runFixtureLifecycle(operations), /operations/);
    assert.deepEqual(calls, []);
  }
  const calls = [];
  const accessor = { ...fixture().operations };
  Object.defineProperty(accessor, "verify", { enumerable: true, get() {
    calls.push("verify getter");
    return async () => ({ fixture: true });
  } });
  await assert.rejects(runFixtureLifecycle(accessor), /operations/);
  assert.deepEqual(calls, []);
});
