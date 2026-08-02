import assert from "node:assert/strict";
import test from "node:test";
import { Manifest } from "@api-migrator/engine";
import { DEFAULT_INNGEST_MANIFEST_JSON } from "../lib/default-manifest";

test("new-campaign default satisfies the audited Inngest runtime boundary", () => {
  const manifest = Manifest.parse(JSON.parse(DEFAULT_INNGEST_MANIFEST_JSON));
  assert.equal(manifest.transformSet, "inngest-v3-to-v4");
  assert.deepEqual(manifest.runtime, {
    node: {
      minimumMajor: 20,
      profile: "node22-bookworm-slim-2026-07",
      packageJson: "package.json",
      dockerfile: "Dockerfile",
    },
  });
});
