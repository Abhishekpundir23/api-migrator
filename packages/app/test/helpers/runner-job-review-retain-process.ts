import { readFileSync } from "node:fs";
import { createJobStoreTestAccess } from "../../../db/src/runner-job-store-sqlite.js";
import { createRunnerEvidenceClientWithDependencies } from "../../src/runner-evidence-core.js";
import { selectRunnerKey } from "../../src/runner-key-registry.js";
import { acquireRunnerJobEvidence } from "../../src/runner-job-evidence.js";

// Bounded synchronous child used only while the parent's review CAS is paused
// after commit. Transport and registry are disposable; verification stays real.
const request = JSON.parse(readFileSync(0, "utf8"));
const store = createJobStoreTestAccess(request.root).open(request.directory, request.storeId, request.policy);
const clock = { wallNow: () => request.wall, monotonicNow: () => 0 };
let reads = 0;
let fetches = 0;
const client = createRunnerEvidenceClientWithDependencies({
  clock,
  readKey: async (context, deadline) => {
    reads++;
    return selectRunnerKey(Buffer.from(request.registryJson), context, deadline.check());
  },
  fetchEnvelope: async (jobId) => {
    if (jobId !== request.key.jobId) throw new Error("unexpected fixture job");
    fetches++;
    return request.envelope;
  },
});
try {
  const result = await acquireRunnerJobEvidence(store, request.key, clock, client);
  process.stdout.write(JSON.stringify({ result, reads, fetches }));
} finally { store.close(); }
