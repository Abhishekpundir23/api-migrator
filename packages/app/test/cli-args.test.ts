import test from "node:test";
import assert from "node:assert/strict";
import { parsePreviewArgs } from "../src/cli-args.js";

test("CLI deployment is explicitly supplied or remains unknown", () => {
  assert.deepEqual(parsePreviewArgs(["owner/repo"]), { slug: "owner/repo" });
  for (const kind of ["long-running", "serverless"]) {
    assert.deepEqual(parsePreviewArgs(["owner/repo", "--deployment-kind", kind, "--base", "main", "--branch", "migration"]),
      { slug: "owner/repo", deploymentKind: kind, baseBranch: "main", branch: "migration" });
  }
});

test("CLI rejects ambiguous deployment arguments before starting a preview", () => {
  for (const args of [[], ["owner/repo", "extra"], ["owner/repo", "--publish"],
    ["owner/repo", "--deployment-kind"], ["owner/repo", "--deployment-kind", "docker"],
    ["owner/repo", "--deployment-kind", "long-running", "--deployment-kind", "serverless"]]) {
    assert.throws(() => parsePreviewArgs(args));
  }
});
