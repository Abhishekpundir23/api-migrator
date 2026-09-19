import { createJobStoreTestAccess, setJobStoreTransactionTestHook } from "../src/runner-job-store-sqlite.js";
import type { StoredJobRow, StorePolicy } from "../src/runner-job-store-contract.js";

// Only test-owned child processes run this entry point. The parent installs
// listeners before sending a command, then waits for exit before recovery.
process.once("message", (message: {
  root: string; directory: string; policy: StorePolicy; storeId: string;
  point: "before_commit" | "after_commit"; row: StoredJobRow;
  operation?: "initialize" | "prepare" | "observe_time"; now?: number;
}) => {
  const access = createJobStoreTestAccess(message.root);
  const operation = message.operation ?? "prepare";
  const store = operation === "initialize" ? null : access.open(message.directory, message.storeId, message.policy);
  setJobStoreTransactionTestHook(({ point, operation }) => {
    if (point !== message.point) return;
    process.send!({ event: point, operation: operation === "insert" ? "prepare" : operation });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
  try {
    if (operation === "initialize") access.initialize(message.directory, message.policy);
    else if (operation === "observe_time") store!.observeTime(message.now!);
    else store!.insert(message.row);
    process.send!({ event: "result", operation }, () => process.disconnect());
  } finally { store?.close(); }
});
process.send!({ event: "ready", operation: process.argv[2] ?? "prepare" });
