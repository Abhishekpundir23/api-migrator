import { createJobStoreTestAccess, setJobStoreTransactionTestHook } from "../../../db/src/runner-job-store-sqlite.js";
import { createRunnerJobServiceForTest } from "../../src/runner-job-record.js";
import { createRunnerEvidenceClientWithDependencies } from "../../src/runner-evidence-core.js";
import { selectRunnerKey } from "../../src/runner-key-registry.js";
import type { StorePolicy } from "../../../db/src/runner-job-store-contract.js";

// Disposable fixtures only. No production exports or verifier replacement.
const operation = process.argv[2] as "prepare" | "review" | "retain";
process.once("message", async (request: {
  root: string; directory: string; storeId: string; policy: StorePolicy; wall: number;
  operation: typeof operation; point?: "before_commit" | "after_commit";
  waitForStart?: boolean;
  input: unknown; key: unknown; output: unknown; completedAt: number;
  evidence?: { envelope: string; registryJson: string };
}) => {
  const access = createJobStoreTestAccess(request.root);
  const clock = { wallNow: () => request.wall, monotonicNow: () => 0 };
  const client = request.evidence ? createRunnerEvidenceClientWithDependencies({
    clock,
    readKey: async (context, deadline) => selectRunnerKey(Buffer.from(request.evidence!.registryJson), context, deadline.check()),
    fetchEnvelope: async () => request.evidence!.envelope,
  }) : null;
  const factory = createRunnerJobServiceForTest({ directory: request.directory, expectedStoreId: request.storeId, evidence: null },
    { migrationWorkspaceRoots: request.policy.migrationWorkspaceRoots }, { clock, client, openStore: access.open });
  if (!factory.ok) throw new Error(factory.code);
  const opened = factory.value.open();
  if (!opened.ok) {
    process.send!({ event: "result", operation, result: opened }, () => process.disconnect());
    return;
  }
  const session = opened.value;
  if (request.waitForStart) {
    const start = new Promise<void>((resolve) => process.once("message", () => resolve()));
    process.send!({ event: "ready", operation });
    await start;
  }
  const target = operation === "prepare" ? "insert" : "compare_and_swap";
  setJobStoreTransactionTestHook((event) => {
    if (event.operation !== target || event.point !== request.point) return;
    process.send!({ event: event.point, operation });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
  try {
    const result = operation === "prepare" ? session.prepare(request.input) : operation === "review"
      ? session.recordReviewedOutput(request.key, request.output, request.completedAt)
      : await session.acquireEvidence(request.key);
    process.send!({ event: "result", operation, result }, () => process.disconnect());
  } finally { setJobStoreTransactionTestHook(undefined); session.close(); }
});
process.send!({ event: "ready", operation });
