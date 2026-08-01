import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveDatabasePath } from "@api-migrator/db";
import { createApprovalToken, verifyApprovalToken } from "../lib/approval";
import { credentialsFromEnv } from "../lib/operator-auth";
import { loadWorkspaceEnv } from "../workspace-env.mjs";

test("root env reaches console authentication, approval, and the shared database path", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-console-env-test-"));
  const keys = [
    "OPERATOR_USERNAME",
    "OPERATOR_PASSWORD",
    "OPERATOR_APPROVAL_SECRET",
    "API_MIGRATOR_DB_PATH",
    "API_MIGRATOR_WORKSPACE_ROOT",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]] as const));
  try {
    for (const key of keys) delete process.env[key];
    writeFileSync(join(directory, ".env"), [
      "OPERATOR_USERNAME=root-env-operator",
      "OPERATOR_PASSWORD=root-env-password",
      "OPERATOR_APPROVAL_SECRET=root-env-approval-secret-at-least-32-bytes",
      "API_MIGRATOR_DB_PATH=data/env-smoke.db",
      "",
    ].join("\n"));

    loadWorkspaceEnv(directory);
    assert.deepEqual(credentialsFromEnv(), {
      username: "root-env-operator",
      password: "root-env-password",
    });
    const manifestJson = '{"provider":"inngest"}';
    const approval = createApprovalToken({
      campaignId: "campaign-env",
      manifestJson,
      preflights: [{ slug: "owner/repo", preflightId: "preflight-env-0123456789" }],
      concurrency: 1,
    });
    assert.equal(verifyApprovalToken({
      token: approval.token,
      confirmation: approval.confirmationPhrase,
      campaignId: "campaign-env",
      manifestJson,
    }).campaignId, "campaign-env");
    assert.equal(
      resolveDatabasePath(),
      join(directory, "data", "env-smoke.db")
    );
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
