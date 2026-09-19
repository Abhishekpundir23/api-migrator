import { createJobStoreTestAccess, setJobStoreTransactionTestHook } from "../src/runner-job-store-sqlite.js";
import type { StoredJobRow, StorePolicy } from "../src/runner-job-store-contract.js";

// Only test-owned child processes run this entry point. The parent installs
// listeners before sending a command, then waits for exit before recovery.
process.once("message", (message: {
  root: string; directory: string; policy: StorePolicy; storeId: string;
  point: "before_commit" | "after_commit"; row: StoredJobRow;
}) => {
  const access = createJobStoreTestAccess(message.root);
  const store = access.open(message.directory, message.storeId, message.policy);
  setJobStoreTransactionTestHook(({ point, operation }) => {
    if (point !== message.point) return;
    process.send!({ event: point, operation });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
  try { store.insert(message.row); process.send!({ event: "result" }); }
  finally { store.close(); }
});
process.send!({ event: "ready" });
