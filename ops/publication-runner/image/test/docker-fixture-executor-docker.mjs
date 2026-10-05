// Explicit real-daemon regression: FIXTURE_TEST_IMAGE=sha256:... node --test THIS_FILE
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createDockerFixtureExecutor } from "../docker-fixture-executor.mjs";

const image = process.env.FIXTURE_TEST_IMAGE;
assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/, "use an already-built image ID");

for (const scenario of ["timeout", "nonzero"]) {
  test(`real Docker ${scenario} leaves no owned container`, (t) => {
    const job = `previewjob_${randomBytes(32).toString("hex")}`;
    const name = `api-migrator-fixture-${job}-prepare`;
    let createdId;
    const executor = createDockerFixtureExecutor({ command(file, args, options) {
      const output = execFileSync(file, args, options);
      if (args[0] === "create") createdId = output.trim();
      return output;
    } });
    assert.throws(() => executor.execute({ phase: "prepare", image, timeoutMs: 1500, maxBuffer: 1024,
      dockerArgs: ["run", "--rm", "--pull=never", "--read-only", "--network", "none",
        "--cap-drop=all", "--security-opt=no-new-privileges", "--memory=128m", "--pids-limit=64",
        "--name", name, "--label", `api-migrator.fixture-job=${job}`, "--user", "1000:1000",
        "--entrypoint", "/usr/local/bin/node", image, "-e",
        scenario === "timeout" ? "setInterval(() => {}, 1000)" : "process.exit(23)"] }),
    (error) => {
      if (scenario === "timeout" ? error.code === "ETIMEDOUT" : error.status === 23) return true;
      if (error instanceof AggregateError) t.diagnostic(error.errors.map((item) => item.message).join("\n"));
      throw error;
    });
    assert.match(createdId, /^[a-f0-9]{64}$/);
    executor.assertCleanupComplete();
    assert.equal(execFileSync("docker", ["container", "ls", "--all", "--no-trunc",
      "--filter", `id=${createdId}`, "--format", "{{.ID}}"],
    { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" }).trim(), "");
  });
}
