import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { RunnerEvidenceError } from "../src/runner-evidence-contract.js";
import {
  createRunnerEvidenceDeadline,
  type RunnerEvidenceClock,
} from "../src/runner-evidence-deadline.js";

function assertExpired(error: unknown) {
  return error instanceof RunnerEvidenceError && error.code === "expired";
}

test("a stalled operation is actively aborted and its late resource is disposed", async () => {
  const clock: RunnerEvidenceClock = {
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now(),
  };
  const budget = createRunnerEvidenceDeadline(clock, Date.now() + 100);
  let settle!: (value: { close(): void }) => void;
  let disposed = 0;
  try {
    const pending = budget.run(
      () => new Promise<{ close(): void }>((resolve) => { settle = resolve; }),
      (value) => value.close(),
    );
    await assert.rejects(pending, /expired/);
    assert.equal(budget.signal.aborted, true);
    settle({ close() { disposed += 1; } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposed, 1);
  } finally {
    budget.close();
  }
});

test("the monotonic ten-second ceiling expires even when wall time does not advance", () => {
  let wall = 1_000;
  let monotonic = 50;
  const budget = createRunnerEvidenceDeadline(
    { wallNow: () => wall, monotonicNow: () => monotonic },
    wall + 60_000,
  );
  try {
    assert.equal(budget.check(), 1_000);
    monotonic += 10_000;
    assert.throws(() => budget.check(), assertExpired);
    assert.equal(budget.signal.aborted, true);
  } finally {
    budget.close();
  }
});

test("a one-millisecond wall-clock rollback expires the shared deadline", () => {
  let wall = 1_000;
  let monotonic = 50;
  const budget = createRunnerEvidenceDeadline(
    { wallNow: () => wall, monotonicNow: () => monotonic },
    wall + 5_000,
  );
  try {
    assert.equal(budget.check(), 1_000);
    wall -= 1;
    monotonic += 1;
    assert.throws(() => budget.check(), assertExpired);
    assert.equal(budget.signal.aborted, true);
  } finally {
    budget.close();
  }
});

test("invalid and reversing clocks fail closed with the safe expired code", () => {
  const cases: Array<[string, RunnerEvidenceClock]> = [
    ["unsafe wall time", { wallNow: () => Number.MAX_SAFE_INTEGER + 1, monotonicNow: () => 1 }],
    ["non-finite monotonic time", { wallNow: () => 1_000, monotonicNow: () => Number.NaN }],
  ];
  for (const [name, clock] of cases) {
    assert.throws(
      () => createRunnerEvidenceDeadline(clock, 5_000),
      assertExpired,
      name,
    );
  }

  let wall = 1_000;
  let monotonic = 50;
  const budget = createRunnerEvidenceDeadline(
    { wallNow: () => wall, monotonicNow: () => monotonic },
    wall + 5_000,
  );
  try {
    budget.check();
    wall += 1;
    monotonic -= 1;
    assert.throws(() => budget.check(), assertExpired);
  } finally {
    budget.close();
  }
});

test("preview, plan, key, and retained caps only shorten and prevent final success", async () => {
  let wall = 1_000;
  let monotonic = 50;
  const budget = createRunnerEvidenceDeadline(
    { wallNow: () => wall, monotonicNow: () => monotonic },
    wall + 10_000,
  );
  try {
    const previewExpiry = wall + 9_000;
    const planExpiry = wall + 8_000;
    const keyExpiry = wall + 7_000;
    const retainedExpiry = wall + 6_000;
    budget.cap(previewExpiry);
    budget.cap(planExpiry);
    budget.cap(keyExpiry);
    budget.cap(retainedExpiry);
    budget.cap(wall + 9_000);
    assert.equal(budget.check(), 1_000);

    for (const stage of ["registry-open", "registry-read", "https-open"]) {
      assert.equal(await budget.run(async () => {
        await Promise.resolve();
        wall += 1_500;
        monotonic += 1_500;
        return stage;
      }), stage);
    }

    let successEmitted = false;
    let disposed = 0;
    const finalStage = budget.run(async () => {
      await Promise.resolve();
      wall += 1_500;
      monotonic += 1_500;
      return { close() { disposed += 1; } };
    }, (value) => value.close()).then((value) => {
      successEmitted = true;
      return value;
    });
    await assert.rejects(finalStage, assertExpired);
    assert.equal(successEmitted, false);
    assert.equal(disposed, 1);
  } finally {
    budget.close();
  }
});

test("shortening the wall cap reschedules active cancellation and extension is ignored", async () => {
  const clock: RunnerEvidenceClock = {
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now(),
  };
  const startedAt = Date.now();
  const budget = createRunnerEvidenceDeadline(clock, startedAt + 1_000);
  try {
    budget.cap(startedAt + 50);
    budget.cap(startedAt + 500);
    await assert.rejects(budget.run(() => new Promise<never>(() => undefined)), assertExpired);
    assert(Date.now() - startedAt < 750);
  } finally {
    budget.close();
  }
});

test("a late operation rejection is observed after timeout", async () => {
  const clock: RunnerEvidenceClock = {
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now(),
  };
  const budget = createRunnerEvidenceDeadline(clock, Date.now() + 30);
  let rejectLate!: (error: Error) => void;
  try {
    const pending = budget.run(
      () => new Promise<never>((_resolve, reject) => { rejectLate = reject; }),
    );
    await assert.rejects(pending, assertExpired);
    rejectLate(new Error("late transport detail"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    budget.close();
  }
});

test("operation settlement removes its abort listener", async () => {
  const now = Date.now();
  const budget = createRunnerEvidenceDeadline(
    { wallNow: () => Date.now(), monotonicNow: () => performance.now() },
    now + 1_000,
  );
  try {
    assert.equal(await budget.run(async (signal) => {
      assert.equal(signal, budget.signal);
      return "settled";
    }), "settled");
    assert.equal(getEventListeners(budget.signal, "abort").length, 0);

    await assert.rejects(budget.run(async () => {
      throw new Error("operation failed");
    }), /operation failed/);
    assert.equal(getEventListeners(budget.signal, "abort").length, 0);
  } finally {
    budget.close();
  }
});

test("a rejection after the operation crosses the deadline is reported as expired", async () => {
  let wall = 1_000;
  let monotonic = 50;
  const budget = createRunnerEvidenceDeadline(
    { wallNow: () => wall, monotonicNow: () => monotonic },
    wall + 100,
  );
  try {
    await assert.rejects(budget.run(async () => {
      await Promise.resolve();
      wall += 100;
      monotonic += 100;
      throw new Error("raw transport failure");
    }), assertExpired);
  } finally {
    budget.close();
  }
});

test("cap replacement and close leave no deadline timer active", () => {
  const activeTimeouts = () => process.getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
  const before = activeTimeouts();
  const now = Date.now();
  const budget = createRunnerEvidenceDeadline(
    { wallNow: () => Date.now(), monotonicNow: () => performance.now() },
    now + 5_000,
  );
  budget.cap(now + 4_000);
  budget.cap(now + 3_000);
  assert.equal(activeTimeouts(), before + 1);
  budget.close();
  budget.close();
  assert.equal(activeTimeouts(), before);
});

test("check returns the validated wall timestamp for finish-time trust selection", () => {
  let wall = 2_000_000_000_000;
  let monotonic = 0;
  const budget = createRunnerEvidenceDeadline({ wallNow: () => wall, monotonicNow: () => monotonic }, wall + 10_000);
  try {
    assert.equal(budget.check(), 2_000_000_000_000);
    wall += 7;
    monotonic += 7;
    assert.equal(budget.check(), 2_000_000_000_007);
  } finally { budget.close(); }
});
