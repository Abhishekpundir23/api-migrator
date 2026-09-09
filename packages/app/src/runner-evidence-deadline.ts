import { RunnerEvidenceError } from "./runner-evidence-contract.js";

export interface RunnerEvidenceClock {
  wallNow(): number;
  monotonicNow(): number;
}

export interface RunnerEvidenceDeadline {
  readonly signal: AbortSignal;
  check(): number;
  cap(expiresAt: number): void;
  run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    disposeLate?: (value: T) => void | Promise<void>,
  ): Promise<T>;
  close(): void;
}

export function createRunnerEvidenceDeadline(
  clock: RunnerEvidenceClock,
  expiresAt: number,
): RunnerEvidenceDeadline {
  const controller = new AbortController();
  const startWall = clock.wallNow();
  const startMonotonic = clock.monotonicNow();
  const monotonicEnd = startMonotonic + 10_000;
  let wallExpiry = expiresAt;
  let lastWall = startWall;
  let lastMonotonic = startMonotonic;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const expire = (): RunnerEvidenceError => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (controller.signal.aborted && controller.signal.reason instanceof RunnerEvidenceError) {
      return controller.signal.reason;
    }
    const error = new RunnerEvidenceError("expired");
    controller.abort(error);
    return error;
  };

  const remainingAt = (wall: number, monotonic: number): number => {
    const remaining = Math.min(
      wallExpiry - wall,
      monotonicEnd - monotonic,
    );
    if (
      !Number.isSafeInteger(wall) ||
      !Number.isFinite(monotonic) ||
      !Number.isSafeInteger(wallExpiry) ||
      !Number.isFinite(monotonicEnd) ||
      wall < lastWall ||
      monotonic < lastMonotonic ||
      remaining <= 0
    ) {
      throw expire();
    }
    lastWall = wall;
    lastMonotonic = monotonic;
    return remaining;
  };

  const arm = (remaining: number) => {
    if (timer !== undefined) clearTimeout(timer);
    if (closed || controller.signal.aborted) {
      timer = undefined;
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      expire();
    }, remaining);
  };

  const check = (): number => {
    if (closed || controller.signal.aborted) throw expire();
    const remaining = remainingAt(clock.wallNow(), clock.monotonicNow());
    arm(remaining);
    return remaining;
  };

  arm(remainingAt(startWall, startMonotonic));

  return {
    signal: controller.signal,
    check,
    cap: (nextExpiry) => {
      if (!Number.isSafeInteger(nextExpiry)) throw expire();
      wallExpiry = Math.min(wallExpiry, nextExpiry);
      check();
    },
    run: async <T>(
      operation: (signal: AbortSignal) => Promise<T>,
      disposeLate?: (value: T) => void | Promise<void>,
    ): Promise<T> => {
      check();
      let rejectAbort!: (reason: RunnerEvidenceError) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => rejectAbort(expire());
      controller.signal.addEventListener("abort", onAbort, { once: true });

      let disposed = false;
      const dispose = async (value: T) => {
        if (disposed || disposeLate === undefined) return;
        disposed = true;
        try {
          await disposeLate(value);
        } catch {
          // Cleanup is best effort and never exposes a raw resource error.
        }
      };
      const pending = Promise.resolve().then(() => operation(controller.signal));
      void pending.then(
        (value) => { if (controller.signal.aborted) void dispose(value); },
        () => undefined,
      );

      try {
        let value: T;
        try {
          value = await Promise.race([pending, aborted]);
        } catch (error) {
          if (controller.signal.aborted) throw expire();
          check();
          throw error;
        }
        try {
          check();
        } catch (error) {
          void dispose(value);
          throw error;
        }
        return value;
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
    close: () => {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
