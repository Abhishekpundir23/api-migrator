import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prepareBatch } from "../batch.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const log =
  "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
const marker = (x) => `API_MIGRATOR_BATCH_RESULT ${JSON.stringify(x)}`;
function fixture() {
  const prepared = prepareBatch(
    {
      projectId: "project-32bf49a2-bd30-4956-850",
      runId: "a".repeat(32),
      sourceRevision: "b".repeat(40),
      sourceArchiveSha256: "c".repeat(64),
      bootImage: "batch-debian-12-official-20261008-00",
      network: "api-migrator-trial-net",
      subnetwork: "api-migrator-trial-sub",
      deleteAt: 1800000,
    },
    { nowMs: 0 },
  );
  const accepted = {
    name: `projects/${prepared.projectId}/locations/us-central1/jobs/${prepared.jobId}`,
    uid: "job-123456",
    createTime: "1970-01-01T00:00:01Z",
  };
  const result = {
    schemaVersion: 1,
    profile: "batch-engine-smoke-v1",
    runId: prepared.runId,
    sourceRevision: prepared.source.revision,
    sourceArchiveSha256: prepared.source.sha256,
    phase: "complete",
    exitCode: 0,
    status: "passed",
    logBytes: 63,
    logChunks: 1,
    logSha256: hash(log),
    activationBlocked: true,
  };
  return {
    prepared,
    accepted,
    job: {
      ...structuredClone(prepared.job),
      ...accepted,
      updateTime: "1970-01-01T00:00:02Z",
      status: { state: "SUCCEEDED" },
    },
    logs: {
      jobUid: accepted.uid,
      complete: true,
      records: [
        `API_MIGRATOR_BATCH_LOG ${JSON.stringify({ runId: prepared.runId, index: 0, data: "IyB0ZXN0cyAyCiMgcGFzcyAyCiMgZmFpbCAwCiMgY2FuY2VsbGVkIDAKIyBza2lwcGVkIDAKIyB0b2RvIDAK" })}`,
        marker(result),
      ],
    },
    inventory: {
      projectId: prepared.projectId,
      observedAt: "1970-01-01T00:00:03Z",
      complete: true,
      instances: [],
      disks: [],
      instanceGroupManagers: [],
    },
    result,
  };
}
const classify = async (f) =>
  (await import("../batch-result.mjs")).classifyBatchResult(f);
test("independent retained evidence proves smoke only and absent resources independently", async () => {
  assert.deepEqual(await classify(fixture()), {
    smoke: "passed",
    cleanup: "verified_absent",
    activationBlocked: true,
    productionReady: false,
  });
});
for (const [name, mutate] of [
  ["script digest", (f) => (f.prepared.scriptSha256 = "0".repeat(64))],
  ["accepted UID", (f) => (f.job.uid = "different")],
  ["logs UID", (f) => (f.logs.jobUid = "different")],
  [
    "source",
    (f) => {
      f.result.sourceRevision = "d".repeat(40);
      f.logs.records[1] = marker(f.result);
    },
  ],
  [
    "run",
    (f) => {
      f.result.runId = "d".repeat(32);
      f.logs.records[1] = marker(f.result);
    },
  ],
  ["duplicate chunks", (f) => f.logs.records.unshift(f.logs.records[0])],
  ["missing chunks", (f) => f.logs.records.shift()],
  [
    "altered bytes",
    (f) => (f.logs.records[0] = f.logs.records[0].replace("IyB0", "JyB0")),
  ],
  [
    "noncanonical base64",
    (f) =>
      (f.logs.records[0] = f.logs.records[0].replace("b2RvIDAK", "b2RvIDAK=")),
  ],
  [
    "malformed marker",
    (f) => f.logs.records.push("API_MIGRATOR_BATCH_RESULT nope"),
  ],
  ["duplicate result", (f) => f.logs.records.push(f.logs.records[1])],
  [
    "out of range index",
    (f) =>
      (f.logs.records[0] = f.logs.records[0].replace(
        '"index":0',
        '"index":2000',
      )),
  ],
  [
    "oversized result",
    (f) => {
      f.result.logBytes = 4194305;
      f.logs.records[1] = marker(f.result);
    },
  ],
])
  test(`rejects ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(classify(f));
  });
for (const state of ["FAILED", "CANCELLED"])
  test(`${state} without markers is failed`, async () => {
    const f = fixture();
    f.job.status.state = state;
    f.logs.records = [];
    assert.equal((await classify(f)).smoke, "failed");
  });
test("running with successful marker is unverified", async () => {
  const f = fixture();
  f.job.status.state = "RUNNING";
  assert.equal((await classify(f)).smoke, "unverified");
});
for (const mutate of [
  (f) => (f.logs = undefined),
  (f) => (f.logs.complete = false),
  (f) => (f.logs.records = []),
  (f) => {
    f.result.status = "failed";
    f.logs.records[1] = marker(f.result);
  },
])
  test("incomplete or unsuccessful smoke is unverified", async () => {
    const f = fixture();
    mutate(f);
    assert.equal((await classify(f)).smoke, "unverified");
  });
for (const [name, mutate] of [
  ["survivor", (f) => f.inventory.instances.push({ name: "vm" })],
  ["partial", (f) => (f.inventory.complete = false)],
  ["stale", (f) => (f.inventory.observedAt = "1970-01-01T00:06:00Z")],
  ["early", (f) => (f.inventory.observedAt = "1970-01-01T00:00:01Z")],
  ["unknown content", (f) => (f.inventory.filtered = true)],
  ["missing", (f) => (f.inventory = undefined)],
])
  test(`cleanup ${name} is unverified without weakening smoke`, async () => {
    const f = fixture();
    mutate(f);
    assert.deepEqual(await classify(f), {
      smoke: "passed",
      cleanup: "unverified",
      activationBlocked: true,
      productionReady: false,
    });
  });
test("wrong project inventory throws", async () => {
  const f = fixture();
  f.inventory.projectId = "elsewhere";
  await assert.rejects(classify(f));
});
test("empty log cannot claim passed", async () => {
  const f = fixture();
  f.logs.records = [
    marker({ ...f.result, logBytes: 0, logChunks: 0, logSha256: hash("") }),
  ];
  assert.equal((await classify(f)).smoke, "unverified");
});
test("retrieval order is immaterial after sorting sequential chunks", async () => {
  const f = fixture();
  const bytes = Buffer.from("\n".repeat(3072) + log);
  f.result = {
    ...f.result,
    logBytes: 3135,
    logChunks: 2,
    logSha256: hash(bytes),
  };
  f.logs.records = [
    `API_MIGRATOR_BATCH_LOG ${JSON.stringify({ runId: f.prepared.runId, index: 1, data: "IyB0ZXN0cyAyCiMgcGFzcyAyCiMgZmFpbCAwCiMgY2FuY2VsbGVkIDAKIyBza2lwcGVkIDAKIyB0b2RvIDAK" })}`,
    `API_MIGRATOR_BATCH_LOG ${JSON.stringify({ runId: f.prepared.runId, index: 0, data: Buffer.alloc(3072, 10).toString("base64") })}`,
    marker(f.result),
  ];
  assert.equal((await classify(f)).smoke, "passed");
});
test("zero success summary stays unverified", async () => {
  const f = fixture();
  const bytes = Buffer.from(
    "# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n",
  );
  f.logs.records = [
    `API_MIGRATOR_BATCH_LOG ${JSON.stringify({ runId: f.prepared.runId, index: 0, data: bytes.toString("base64") })}`,
    marker({ ...f.result, logSha256: hash(bytes) }),
  ];
  assert.equal((await classify(f)).smoke, "unverified");
});
test("too many records rejects before parsing", async () => {
  const f = fixture();
  f.logs.records = Array(4097).fill("ordinary");
  await assert.rejects(classify(f));
});
test("oversized logging line rejects before parsing", async () => {
  const f = fixture();
  f.logs.records = ["x".repeat(65537)];
  await assert.rejects(classify(f));
});
test("overlarge chunk rejects", async () => {
  const f = fixture();
  f.logs.records[0] = `API_MIGRATOR_BATCH_LOG ${JSON.stringify({ runId: f.prepared.runId, index: 0, data: Buffer.alloc(3073).toString("base64") })}`;
  await assert.rejects(classify(f));
});
test("acceptance at deadline rejects", async () => {
  const f = fixture();
  f.accepted.createTime = "1970-01-01T00:30:00Z";
  await assert.rejects(classify(f));
});
for (const [name, mutate] of [
  [
    "script",
    (f) =>
      (f.job.taskGroups[0].taskSpec.runnables[0].script.text +=
        "\necho changed"),
  ],
  [
    "service account",
    (f) => (f.job.allocationPolicy.serviceAccount.email = "other@example.com"),
  ],
  [
    "image",
    (f) =>
      (f.job.allocationPolicy.instances[0].policy.bootDisk.image =
        "other-image"),
  ],
  [
    "network",
    (f) =>
      (f.job.allocationPolicy.network.networkInterfaces[0].network =
        "other-network"),
  ],
  ["retry count", (f) => (f.job.taskGroups[0].taskSpec.maxRetryCount = 1)],
  ["timeout", (f) => (f.job.taskGroups[0].taskSpec.maxRunDuration = "3600s")],
  [
    "extra runnable",
    (f) =>
      f.job.taskGroups[0].taskSpec.runnables.push({
        script: { text: "echo extra" },
      }),
  ],
  [
    "extra environment",
    (f) =>
      (f.job.taskGroups[0].taskSpec.environment = {
        variables: { TOKEN: "extra" },
      }),
  ],
  [
    "unknown execution config",
    (f) => (f.job.taskGroups[0].taskSpec.futurePermission = true),
  ],
])
  test(`refuses fetched job drift: ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(classify(f));
  });
test("permits only the known output-only task group name", async () => {
  const f = fixture();
  f.job.taskGroups[0].name = `${f.accepted.name}/taskGroups/group0`;
  assert.equal((await classify(f)).smoke, "passed");
});

function providerNormalizedFixture() {
  const f = fixture();
  f.job.allocationPolicy.labels["batch-job-id"] = f.prepared.jobId;
  f.job.allocationPolicy.location.allowedLocations = [
    "regions/us-central1",
    "zones/us-central1-a",
  ];
  delete f.job.taskGroups[0].taskSpec.maxRetryCount;
  delete f.job.allocationPolicy.network.networkInterfaces[0]
    .noExternalIpAddress;
  return f;
}

function withDecodedLog(output) {
  const f = fixture();
  const bytes = Buffer.from(output);
  f.result = { ...f.result, logBytes: bytes.length, logSha256: hash(bytes) };
  f.logs.records = [
    `API_MIGRATOR_BATCH_LOG ${JSON.stringify({ runId: f.prepared.runId, index: 0, data: bytes.toString("base64") })}`,
    marker(f.result),
  ];
  return f;
}
const dockerSkipLog =
  "ok 138 - Docker runner performs an install then an offline typecheck # SKIP\n# tests 138\n# pass 137\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n";
test("classifier accepts only named Docker-only skip with consistent summaries", async () => {
  assert.equal((await classify(withDecodedLog(dockerSkipLog))).smoke, "passed");
});
for (const [name, output] of [
  ["duplicate tests", log + "# tests 2\n"],
  ["duplicate failure", log + "# fail 0\n"],
  ["malformed count", log.replace("# tests 2", "# tests 02")],
  ["malformed recognized summary", log + "# tests: 2\n"],
  ["missing cancelled", log.replace("# cancelled 0\n", "")],
  ["cancelled", log.replace("# cancelled 0", "# cancelled 1")],
  ["todo", log.replace("# todo 0", "# todo 1")],
  [
    "other skip",
    dockerSkipLog.replace(
      "Docker runner performs an install then an offline typecheck",
      "other test",
    ),
  ],
  [
    "double skip",
    dockerSkipLog +
      "ok 2 - Docker runner performs an install then an offline typecheck # SKIP\n",
  ],
  ["skip count two", dockerSkipLog.replace("# skipped 1", "# skipped 2")],
  [
    "all skipped",
    dockerSkipLog
      .replace("# tests 138", "# tests 1")
      .replace("# pass 137", "# pass 0"),
  ],
  ["mismatched total", dockerSkipLog.replace("# tests 138", "# tests 139")],
  ["hidden skip with zero summary", "ok 1 - other test # SKIP\n" + log],
])
  test(`classifier cannot pass ${name}`, async () => {
    assert.equal((await classify(withDecodedLog(output))).smoke, "unverified");
  });
test("retained failed status cannot be reclassified by the new skip policy", async () => {
  const f = withDecodedLog(dockerSkipLog);
  f.result.status = "failed";
  f.logs.records[1] = marker(f.result);
  assert.equal((await classify(f)).smoke, "unverified");
});

test("accepts exactly observed provider normalization without changing input", async () => {
  const f = providerNormalizedFixture();
  const before = structuredClone(f);
  assert.equal((await classify(f)).smoke, "passed");
  assert.deepEqual(f, before);
});

for (const [name, mutate] of [
  [
    "region only",
    (f) =>
      (f.job.allocationPolicy.location.allowedLocations = [
        "regions/us-central1",
      ]),
  ],
  [
    "extra zone",
    (f) =>
      f.job.allocationPolicy.location.allowedLocations.push(
        "zones/us-central1-b",
      ),
  ],
  [
    "extra region",
    (f) =>
      f.job.allocationPolicy.location.allowedLocations.push("regions/us-west1"),
  ],
  [
    "wrong parent",
    (f) =>
      (f.job.allocationPolicy.location.allowedLocations[0] =
        "regions/us-west1"),
  ],
  [
    "wrong generated job label",
    (f) => (f.job.allocationPolicy.labels["batch-job-id"] = "other-job"),
  ],
  [
    "extra generated label",
    (f) => (f.job.allocationPolicy.labels["batch-job-uid"] = f.accepted.uid),
  ],
  ["retry one", (f) => (f.job.taskGroups[0].taskSpec.maxRetryCount = 1)],
  [
    "private IP",
    (f) =>
      (f.job.allocationPolicy.network.networkInterfaces[0].noExternalIpAddress = true),
  ],
  [
    "unknown task field",
    (f) =>
      (f.job.taskGroups[0].taskSpec.environment = {
        variables: { SECRET: "no" },
      }),
  ],
])
  test(`provider normalization still refuses ${name}`, async () => {
    const f = providerNormalizedFixture();
    mutate(f);
    await assert.rejects(classify(f));
  });
