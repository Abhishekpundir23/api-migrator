import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hostedNpmPlanWindow, resolveHostedNpmOrigin } from "../run-hosted-smoke.mjs";

const EPOCH = 2_000_000_000_000;

function diagnosticFile(t) {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-dns-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "dns-resolution-diagnostics.json");
  return {
    writeDiagnostics: (bytes) => { writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); },
    read() {
      assert.equal(existsSync(path), true, "DNS diagnostics must persist on this exit path");
      const bytes = readFileSync(path, "utf8");
      assert(Buffer.byteLength(bytes) <= 64 * 1024, "diagnostics exceed the byte budget");
      const report = JSON.parse(bytes);
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.kind, "api_migrator_hosted_dns_diagnostics");
      assert.equal(report.releaseEvidenceEligible, false);
      assert.equal(report.activationBlocked, true);
      assert.equal(report.externalSigningEligible, false);
      assert.equal(report.authorizationStatus, "non_authorizing_github_hosted_smoke_only");
      assert.equal(report.requiredMinimumTtlSeconds, 65);
      assert.equal(report.budgetMs, 90_000);
      assert.equal(report.retryIntervalMs, 5_000);
      assert.equal(report.runtime.node, process.versions.node);
      assert.equal(report.runtime.resolverServerCount, null); // Injected resolver, not invented native provenance.
      return { report, bytes };
    },
  };
}

function timedAnswers(answers, queryDuration = 25) {
  let elapsed = 0;
  let calls = 0;
  return {
    now: () => EPOCH + elapsed,
    elapsedNow: () => elapsed,
    sleep: async (milliseconds) => { elapsed += milliseconds; },
    resolver: async (hostname, options) => {
      assert.equal(hostname, "registry.npmjs.org");
      assert.deepEqual(options, { ttl: true });
      elapsed += queryDuration;
      return answers[Math.min(calls++, answers.length - 1)];
    },
  };
}

// Losing low-TTL attempts or reporting retry sleep as query latency must fail this test.
test("persists the complete countdown and recovery without changing the resolution", async (t) => {
  const file = diagnosticFile(t);
  const result = await resolveHostedNpmOrigin({
    ...timedAnswers([
      [{ address: "104.16.0.34", ttl: 4 }],
      [{ address: "104.16.1.34", ttl: 300 }, { address: "104.16.0.34", ttl: 300 }],
    ]),
    writeDiagnostics: file.writeDiagnostics,
  });
  assert.deepEqual(result, {
    addresses: ["104.16.0.34", "104.16.1.34"], minimumTtlSeconds: 300,
    observedAt: EPOCH + 5050, attempts: 2,
  });
  const { report, bytes } = file.read();
  assert.equal(report.outcome, "accepted");
  assert.equal(report.attempts, 2);
  assert.equal(report.elapsedMs, 5050);
  assert.deepEqual(report.entries[0], {
    attempt: 1, startedAfterMs: 0, completedAfterMs: 25, queryDurationMs: 25,
    outcome: "ttl_below_minimum", answerCount: 1, uniqueAddressCount: 1,
    minimumTtlSeconds: 4, maximumTtlSeconds: 4, distinctTtlCount: 1,
    addressSetDigest: `sha256:${createHash("sha256").update('["104.16.0.34"]').digest("hex")}`,
  });
  assert.deepEqual(report.entries[1], {
    attempt: 2, startedAfterMs: 5025, completedAfterMs: 5050, queryDurationMs: 25,
    outcome: "accepted", answerCount: 2, uniqueAddressCount: 2,
    minimumTtlSeconds: 300, maximumTtlSeconds: 300, distinctTtlCount: 1,
    addressSetDigest: `sha256:${createHash("sha256").update('["104.16.0.34","104.16.1.34"]').digest("hex")}`,
  });
  assert.doesNotMatch(bytes, /104\.16\./, "diagnostics must not contain raw addresses");
});

// A successful-only writer or a fallback accepting the longest-lived RR would fail this test.
test("persists mixed-TTL exhaustion while keeping the complete-answer minimum", async (t) => {
  const file = diagnosticFile(t);
  const low = Array.from({ length: 12 }, (_, index) => ({
    address: `104.16.${index}.34`, ttl: index === 0 ? 62 : 300,
  }));
  await assert.rejects(resolveHostedNpmOrigin({
    ...timedAnswers([low], 0), writeDiagnostics: file.writeDiagnostics,
  }), /reason=ttl_floor_exhausted, attempts=18, elapsedMs=90000/);
  const { report } = file.read();
  assert.equal(report.outcome, "ttl_floor_exhausted");
  assert.equal(report.entries.length, 18);
  assert.equal(report.entries.length, report.attempts);
  assert.equal(report.elapsedMs, 90_000);
  assert.equal(report.entries.at(-1).startedAfterMs, 85_000);
  assert.equal(report.entries.at(-1).completedAfterMs, 85_000);
  for (const entry of report.entries) {
    assert.equal(entry.outcome, "ttl_below_minimum");
    assert.equal(entry.answerCount, 12);
    assert.equal(entry.minimumTtlSeconds, 62);
    assert.equal(entry.maximumTtlSeconds, 300);
    assert.equal(entry.distinctTtlCount, 2);
  }
});

test("diagnostic address identity ignores answer order but detects a changed set", async (t) => {
  const file = diagnosticFile(t);
  await resolveHostedNpmOrigin({
    ...timedAnswers([
      [{ address: "104.16.1.34", ttl: 4 }, { address: "104.16.0.34", ttl: 4 }],
      [{ address: "104.16.0.34", ttl: 4 }, { address: "104.16.1.34", ttl: 4 }],
      [{ address: "104.16.2.34", ttl: 300 }],
    ]), writeDiagnostics: file.writeDiagnostics,
  });
  const { report } = file.read();
  assert.equal(report.entries[0].addressSetDigest, report.entries[1].addressSetDigest);
  assert.notEqual(report.entries[1].addressSetDigest, report.entries[2].addressSetDigest);
});

test("records malformed and rejected replies without invoking getters or exposing error text", async (t) => {
  let getterCalls = 0;
  const accessor = { ttl: 300 };
  Object.defineProperty(accessor, "address", { get() { getterCalls++; throw new Error("secret getter"); } });
  const cases = [
    { name: "empty", answer: [], reason: "missing_or_excessive_answer", count: 0 },
    { name: "accessor", answer: [accessor], reason: "invalid_answer", count: 1 },
    { name: "invalid address", answer: [{ address: "secret address", ttl: 300 }], reason: "invalid_answer", count: 1 },
    { name: "excessive", answer: Array(33).fill({ address: "104.16.0.34", ttl: 300 }), reason: "missing_or_excessive_answer", count: 33 },
    { name: "descriptor trap", answer: [new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("secret descriptor trap"); } })], reason: "invalid_answer", count: 1 },
    { name: "resolver error", error: new Error("secret resolver credentials"), reason: "resolver_error", count: null },
  ];
  for (const fixture of cases) await t.test(fixture.name, async (t) => {
    const file = diagnosticFile(t);
    await assert.rejects(resolveHostedNpmOrigin({
      ...timedAnswers([fixture.answer], 0),
      ...(fixture.error ? { resolver: async () => { throw fixture.error; } } : {}),
      writeDiagnostics: file.writeDiagnostics,
    }), new RegExp(`reason=${fixture.reason}`));
    const { report, bytes } = file.read();
    assert.equal(report.outcome, fixture.reason);
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0].outcome, fixture.reason);
    assert.equal(report.entries[0].answerCount, fixture.count);
    assert.equal(report.entries[0].addressSetDigest, null);
    assert.equal(report.entries[0].minimumTtlSeconds, null);
    assert.doesNotMatch(bytes, /secret|credentials/);
  });
  assert.equal(getterCalls, 0);
});

test("persists a timed-out attempt and ignores a later resolver completion", async (t) => {
  const file = diagnosticFile(t);
  let elapsed = 0;
  let complete;
  let cancellations = 0;
  await assert.rejects(resolveHostedNpmOrigin({
    resolver: () => new Promise(resolve => { complete = resolve; }),
    now: () => EPOCH + elapsed, elapsedNow: () => elapsed,
    setTimer: (callback, ms) => {
      queueMicrotask(() => { elapsed += ms; callback(); });
      return 1;
    },
    clearTimer: () => {}, cancelResolver: () => { cancellations++; },
    writeDiagnostics: file.writeDiagnostics,
  }), /reason=resolver_timeout/);
  const before = file.read();
  assert.equal(cancellations, 1);
  assert.equal(before.report.outcome, "resolver_timeout");
  assert.equal(before.report.entries.length, 1);
  assert.equal(before.report.entries[0].queryDurationMs, 90_000);
  assert.equal(before.report.entries[0].answerCount, null);
  complete([{ address: "104.16.0.34", ttl: 300 }]);
  await Promise.resolve();
  assert.equal(file.read().bytes, before.bytes);
});

test("caps diagnostic entries even when an injected clock does not advance", async (t) => {
  const file = diagnosticFile(t);
  await assert.rejects(resolveHostedNpmOrigin({
    ...timedAnswers([[{ address: "104.16.0.34", ttl: 4 }]], 0),
    sleep: async () => {}, writeDiagnostics: file.writeDiagnostics,
  }), /reason=ttl_floor_exhausted, attempts=100/);
  const { report } = file.read();
  assert.equal(report.attempts, 100);
  assert.equal(report.entries.length, 100);
});

test("a failing diagnostic sink cannot turn acquisition failure into success", async () => {
  let recorded;
  let writes = 0;
  await assert.rejects(resolveHostedNpmOrigin({
    ...timedAnswers([[]], 0),
    writeDiagnostics: (bytes) => { writes++; recorded = JSON.parse(bytes); throw new Error("secret write failure"); },
  }), { message: "hosted smoke npm DNS resolution failed (reason=missing_or_excessive_answer, attempts=1, elapsedMs=0, requiredMinimumTtlSeconds=65, lowestObservedTtlSeconds=none, highestObservedTtlSeconds=none, lastAnswerCount=0)" });
  assert.equal(recorded?.outcome, "missing_or_excessive_answer");
  assert.equal(writes, 1);
});

test("refuses successful acquisition when required diagnostic persistence fails", async () => {
  let writes = 0;
  await assert.rejects(resolveHostedNpmOrigin({
    ...timedAnswers([[{ address: "104.16.0.34", ttl: 300 }]], 0),
    writeDiagnostics: () => { writes++; throw new Error("secret write failure"); },
  }), { message: "hosted smoke DNS diagnostic persistence failed" });
  assert.equal(writes, 1);
});

test("diagnostic persistence cannot refresh the answer timestamp or extend the plan window", async (t) => {
  for (const delay of [5000, 5001]) await t.test(`${delay}ms write`, async (t) => {
    const file = diagnosticFile(t);
    let now = EPOCH;
    const result = await resolveHostedNpmOrigin({
      ...timedAnswers([[{ address: "104.16.0.34", ttl: 65 }]], 0),
      now: () => now,
      writeDiagnostics: (bytes) => { file.writeDiagnostics(bytes); now += delay; },
    });
    assert.equal(result.observedAt, EPOCH);
    const plan = () => hostedNpmPlanWindow({
      minimumTtlSeconds: result.minimumTtlSeconds,
      resolutionObservedAt: result.observedAt, createdAt: now,
    });
    if (delay === 5000) {
      assert.deepEqual(plan(), { resolutionExpiresAt: EPOCH + 65_000, expiresAt: EPOCH + 65_000 });
    } else {
      assert.throws(plan, /cannot bind a complete plan lifetime/);
    }
    assert.equal(file.read().report.entries.length, 1);
  });
});

test("records duplicate answers separately from their unique address identity", async (t) => {
  const file = diagnosticFile(t);
  await resolveHostedNpmOrigin({
    ...timedAnswers([Array(2).fill({ address: "104.16.0.34", ttl: 300 })], 0),
    writeDiagnostics: file.writeDiagnostics,
  });
  const { report } = file.read();
  assert.equal(report.entries[0].answerCount, 2);
  assert.equal(report.entries[0].uniqueAddressCount, 1);
  assert.equal(report.entries[0].addressSetDigest, `sha256:${createHash("sha256").update('["104.16.0.34"]').digest("hex")}`);
});

test("retains a bounded failure record when the elapsed clock becomes invalid", async (t) => {
  const file = diagnosticFile(t);
  let elapsed = 0;
  await assert.rejects(resolveHostedNpmOrigin({
    ...timedAnswers([[{ address: "104.16.0.34", ttl: 300 }]], 0),
    elapsedNow: () => elapsed,
    resolver: async () => { elapsed = Number.NaN; return [{ address: "104.16.0.34", ttl: 300 }]; },
    writeDiagnostics: file.writeDiagnostics,
  }), /elapsed clock is invalid/);
  const { report } = file.read();
  assert.equal(report.outcome, "internal_error");
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].addressSetDigest, null);
});

test("optional native resolver metadata cannot prevent persistence of the DNS failure", async (t) => {
  const file = diagnosticFile(t);
  t.mock.method(Resolver.prototype, "getServers", () => { throw new Error("secret resolver metadata"); });
  t.mock.method(Resolver.prototype, "resolve4", async () => []);
  await assert.rejects(resolveHostedNpmOrigin({
    now: () => EPOCH, writeDiagnostics: file.writeDiagnostics,
  }), /reason=missing_or_excessive_answer/);
  const { report, bytes } = file.read();
  assert.equal(report.runtime.resolverServerCount, null);
  assert.equal(report.outcome, "missing_or_excessive_answer");
  assert.doesNotMatch(bytes, /secret/);
});
