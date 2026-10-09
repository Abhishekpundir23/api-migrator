import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  renderMetadataIsolation,
  encodeBatchLog,
} from "../batch-bootstrap.mjs";

const context = {
  runId: "a".repeat(32),
  sourceRevision: "b".repeat(40),
  sourceArchiveSha256: "c".repeat(64),
  phase: "complete",
  exitCode: 0,
};
test("public worker log round trips in bounded sequenced records with digest and result", () => {
  const bytes = Buffer.from(
    "# tests 12\n# pass 12\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n" +
      "x".repeat(7000),
  );
  const records = encodeBatchLog(bytes, context);
  const parts = records
    .filter((x) => x.startsWith("API_MIGRATOR_BATCH_LOG "))
    .map((x) => JSON.parse(x.slice(23)));
  const result = JSON.parse(
    records.at(-1).slice("API_MIGRATOR_BATCH_RESULT ".length),
  );
  assert.equal(parts.length, 3);
  assert.deepEqual(
    parts.map((x) => x.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    Buffer.concat(parts.map((x) => Buffer.from(x.data, "base64"))),
    bytes,
  );
  assert.equal(
    result.logSha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(result.logBytes, bytes.length);
  assert.equal(result.logChunks, 3);
  assert.equal(result.status, "passed");
  assert.equal(result.activationBlocked, true);
  assert.equal(result.sourceRevision, context.sourceRevision);
});
test("failed execution and oversized output never report passed", () => {
  const bad = encodeBatchLog(Buffer.from("# fail 1\n"), {
    ...context,
    exitCode: 1,
  });
  assert.equal(JSON.parse(bad.at(-1).slice(25)).status, "failed");
  assert.throws(
    () => encodeBatchLog(Buffer.alloc(4_194_305), context),
    /large/,
  );
});
const dockerSkipLog =
  "ok 138 - Docker runner performs an install then an offline typecheck # SKIP\n# tests 138\n# pass 137\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n";
test("smoke emitter refuses a malformed recognized summary alongside valid summaries", () => {
  const bytes = Buffer.from(
    "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# tests: 2\n",
  );
  const records = encodeBatchLog(bytes, context);
  assert.equal(JSON.parse(records.at(-1).slice(25)).status, "failed");
});
test("smoke emitter accepts the sole named Docker-only skip", () => {
  const records = encodeBatchLog(Buffer.from(dockerSkipLog), context);
  assert.equal(JSON.parse(records.at(-1).slice(25)).status, "passed");
});
for (const [name, output] of [
  ["duplicate tests", dockerSkipLog + "# tests 138\n"],
  ["duplicate zero failure", dockerSkipLog + "# fail 0\n"],
  ["malformed skipped", dockerSkipLog.replace("# skipped 1", "# skipped 01")],
  [
    "other skip name",
    dockerSkipLog.replace(
      "Docker runner performs an install then an offline typecheck",
      "other test",
    ),
  ],
  [
    "duplicate skip",
    dockerSkipLog +
      "ok 2 - Docker runner performs an install then an offline typecheck # SKIP\n",
  ],
  ["skip count two", dockerSkipLog.replace("# skipped 1", "# skipped 2")],
  ["missing skip directive", dockerSkipLog.replace(/^ok .*\n/, "")],
  [
    "all skipped",
    dockerSkipLog
      .replace("# tests 138", "# tests 1")
      .replace("# pass 137", "# pass 0"),
  ],
  ["cancelled", dockerSkipLog.replace("# cancelled 0", "# cancelled 1")],
  ["todo", dockerSkipLog.replace("# todo 0", "# todo 1")],
  ["missing cancelled", dockerSkipLog.replace("# cancelled 0\n", "")],
  ["mismatched tests", dockerSkipLog.replace("# tests 138", "# tests 139")],
])
  test(`smoke emitter rejects ${name}`, () => {
    const records = encodeBatchLog(Buffer.from(output), context);
    assert.equal(JSON.parse(records.at(-1).slice(25)).status, "failed");
  });
for (const fault of [
  "nft",
  "metadata_accessible",
  "root_control_failed",
  "ok",
]) {
  test(`metadata isolation ${fault} gates repository execution`, () => {
    // External kernel/metadata boundaries are controlled here; the real generated
    // orchestration is executed. Live cloud denial is a separate acceptance check.
    const fixture = `set -euo pipefail
account=worker
uid=12345
table=am_batch_test
nft() { input=$(cat); [ '${fault}' != nft ] || return 87; [[ "$input" == *'169.254.169.254'* ]] && [[ "$input" == *'fd20:ce::254'* ]] && [[ "$input" == *'meta skuid 12345'* ]]; }
curl() { [ '${fault}' != root_control_failed ] || return 7; printf 200; }
runuser() { [ '${fault}' = metadata_accessible ] && return 0; return 7; }
`;
    const r = spawnSync("bash", ["-se"], {
      input:
        fixture + renderMetadataIsolation() + "\nprintf 'WORKER_ALLOWED'\n",
      encoding: "utf8",
    });
    if (fault === "ok") {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "WORKER_ALLOWED");
    } else {
      assert.notEqual(r.status, 0);
      assert(!r.stdout.includes("WORKER_ALLOWED"));
    }
  });
}
