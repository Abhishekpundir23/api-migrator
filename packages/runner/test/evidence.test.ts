import assert from "node:assert/strict";
import test from "node:test";
import type { PublicationRunnerPlanRecord } from "@api-migrator/app/runner-internal";
import type { MigrationReport } from "@api-migrator/engine";
import type { DependencyStateRecord } from "../src/dependency-state.js";
import { createRunnerEvidence } from "../src/evidence.js";

test("runner evidence is never emitted for a publication blocker", () => {
  assert.throws(
    () => createRunnerEvidence({
      plan: {} as PublicationRunnerPlanRecord,
      dependencyState: {} as DependencyStateRecord,
      outputTreeDigest: `sha256:${"a".repeat(64)}`,
      output: {
        preflightId: `pf_${"b".repeat(64)}`,
        artifactDigest: `sha256:${"c".repeat(64)}`,
        candidateTreeSha: "d".repeat(40),
      },
      targetBranch: "api-migrator/test",
      report: {} as MigrationReport,
      blockers: [{ code: "manual_review_required", message: "review required" }],
    }),
    /cannot be emitted for a blocked publication/
  );
});
