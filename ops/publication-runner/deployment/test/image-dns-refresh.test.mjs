import assert from "node:assert/strict";
import test from "node:test";
import { resolveHostedNpmOrigin, hostedNpmPlanWindow } from "../run-hosted-smoke.mjs";
import { resolveImageFixtureOrigin } from "../run-image-lifecycle-fixture.mjs";

const epoch = 1800000000000;
function acquisition(ttl) {
  let elapsed = 0, calls = 0, diagnostic;
  return {
    options: {
      now: () => epoch + elapsed, elapsedNow: () => elapsed,
      sleep: async (ms) => { elapsed += ms; },
      resolver: async () => { calls += 1; return [{ address: "104.16.0.34", ttl: ttl(elapsed) }]; },
      writeDiagnostics: (bytes) => { diagnostic = JSON.parse(bytes); },
    },
    state: () => ({ elapsed, calls, diagnostic }),
  };
}

for (const residual of [104, 119]) {
  test(`joined acquisition reaches a fresh answer after cached TTL ${residual} expires`, async () => {
    const f = acquisition((ms) => ms < residual * 1000 ? residual - Math.floor(ms / 1000) : 300);
    // The joined caller cannot be weakened back to the generic smoke profile.
    const value = await resolveImageFixtureOrigin({ ...f.options, acquisitionProfile: "hosted-smoke" });
    const acceptedAfter = Math.ceil(residual / 5) * 5000;
    assert.equal(value.observedAt, epoch + acceptedAfter);
    assert.equal(value.minimumTtlSeconds, 300);
    assert.equal(value.attempts, acceptedAfter / 5000 + 1);
    assert.equal(f.state().diagnostic.budgetMs, 125000);
    assert.equal(f.state().diagnostic.requiredMinimumTtlSeconds, 120);
    assert.equal(f.state().diagnostic.retryIntervalMs, 5000);
    const window = hostedNpmPlanWindow({ minimumTtlSeconds: value.minimumTtlSeconds,
      resolutionObservedAt: value.observedAt, createdAt: value.observedAt });
    assert.equal(window.resolutionExpiresAt, value.observedAt + 300000);
  });
}

for (const ttl of [119, 60]) {
  test(`joined acquisition retains its floor and hard bound for persistent TTL ${ttl}`, async () => {
    const f = acquisition(() => ttl);
    await assert.rejects(resolveImageFixtureOrigin(f.options), /DNS admission failed/);
    assert.equal(f.state().elapsed, 125000);
    assert.equal(f.state().calls, 25);
    assert.equal(f.state().diagnostic.outcome, "ttl_floor_exhausted");
    assert(f.state().diagnostic.entries.every((entry) => entry.outcome === "ttl_below_minimum"));
  });
}

test("generic smoke keeps its original 90-second acquisition budget", async () => {
  for (const floor of [65, 120]) {
    const f = acquisition(() => floor - 1);
    await assert.rejects(resolveHostedNpmOrigin({ ...f.options, requiredMinimumTtlSeconds: floor }), /ttl_floor_exhausted/);
    assert.equal(f.state().elapsed, 90000);
    assert.equal(f.state().calls, 18);
    assert.equal(f.state().diagnostic.budgetMs, 90000);
  }
});

test("unknown or weakened joined acquisition profiles refuse before querying", async () => {
  for (const [profile, floor] of [["arbitrary", 120], ["joined-image", 65], ["joined-image", 119], ["joined-image", 1800]]) {
    const f = acquisition(() => 1800);
    await assert.rejects(resolveHostedNpmOrigin({ ...f.options, acquisitionProfile: profile,
      requiredMinimumTtlSeconds: floor }), /profile|requirement/);
    assert.equal(f.state().calls, 0);
  }
});

test("DNS elapsed rollback cannot renew acquisition or admit a later answer", async () => {
  let calls = 0;
  const values = [0, 10, 5];
  await assert.rejects(resolveHostedNpmOrigin({ requiredMinimumTtlSeconds: 120, acquisitionProfile: "joined-image",
    now: () => epoch, elapsedNow: () => values.shift(),
    resolver: async () => { calls += 1; return [{ address: "104.16.0.34", ttl: 300 }]; },
  }), /clock/);
  assert.equal(calls, 1);
});

test("joined resolver timeout stays bounded and cancels the stuck query", async () => {
  let elapsed = 0, cancelled = 0, delay;
  await assert.rejects(resolveImageFixtureOrigin({ now: () => epoch + elapsed, elapsedNow: () => elapsed,
    resolver: () => new Promise(() => {}), cancelResolver: () => { cancelled += 1; },
    setTimer: (callback, ms) => { delay = ms; queueMicrotask(() => { elapsed = ms; callback(); }); return 1; },
    clearTimer: () => {},
  }), /DNS admission failed/);
  assert.equal(delay, 125000);
  assert.equal(elapsed, 125000);
  assert.equal(cancelled, 1);
});

test("joined acquisition refuses a fresh response completed exactly at its ceiling", async () => {
  let elapsed = 0, diagnostic;
  await assert.rejects(resolveImageFixtureOrigin({ now: () => epoch + elapsed, elapsedNow: () => elapsed,
    resolver: async () => { elapsed = 125000; return [{ address: "104.16.0.34", ttl: 300 }]; },
    writeDiagnostics: (bytes) => { diagnostic = JSON.parse(bytes); },
  }), /DNS admission failed/);
  assert.equal(diagnostic.outcome, "resolver_timeout");
  assert.equal(diagnostic.budgetMs, 125000);
  assert.equal(diagnostic.elapsedMs, 125000);
});

test("joined refresh still uses the minimum of the complete answer", async () => {
  const f = acquisition(() => 119), resolver = f.options.resolver;
  await assert.rejects(resolveImageFixtureOrigin({ ...f.options,
    resolver: async () => [...await resolver(), { address: "104.16.1.34", ttl: 300 }],
  }), /DNS admission failed/);
  assert.equal(f.state().elapsed, 125000);
  assert.equal(f.state().calls, 25);
  assert(f.state().diagnostic.entries.every((entry) => entry.minimumTtlSeconds === 119 && entry.maximumTtlSeconds === 300));
});
