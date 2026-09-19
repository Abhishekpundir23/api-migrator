import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const image = process.argv[2];
if (!image || !/^[A-Za-z0-9._/:@+-]+$/.test(image)) {
  throw new Error("usage: verify-image-config.mjs IMAGE");
}
const inspect = JSON.parse(docker(["image", "inspect", image]))[0];
assert(inspect && typeof inspect === "object", "Docker did not return an image record");
const config = inspect.Config ?? {};
assert.deepEqual(config.Env ?? [], ["PATH=/usr/local/bin:/usr/bin:/bin"]);
assert.deepEqual(config.Entrypoint ?? [], []);
assert.deepEqual(config.Cmd ?? [], []);
assert.deepEqual(config.Volumes ?? null, null);
assert.equal(config.User ?? "", "");
assert.equal(config.WorkingDir ?? "", "/");
assert.deepEqual(config.Healthcheck ?? null, null);
assert.deepEqual(config.Shell ?? [], []);

assert.equal(run(["--entrypoint", "/usr/local/bin/node", image, "--version"]).trim(), "v22.23.2");
const failure = runFailure([
  "--user", "31337:31337",
  "--read-only",
  "--network", "none",
  "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
  "--entrypoint", "/usr/local/bin/api-migrator-runner",
  image,
  "unsupported",
]);
assert.notEqual(failure.status, 0);
assert.match(`${failure.stdout}${failure.stderr}`, /phase must be prepare, install, migrate, or verify/);
run([
  "--read-only", "--network", "none", "--entrypoint", "/bin/sh", image, "-c",
  "test ! -e /opt/api-migrator/node_modules/@octokit && test ! -e /opt/api-migrator/node_modules/next",
]);
run([
  "--read-only", "--network", "none", "--entrypoint", "/usr/local/bin/node", image,
  "-e", `const assert = require('node:assert/strict'); const { existsSync } = require('node:fs');
    for (const name of ['runner-job-record-contract', 'runner-job-producer', 'runner-job-service-core',
      'runner-job-evidence', 'runner-job-record', 'runner-job-record-internal']) {
      assert.equal(existsSync('/opt/api-migrator/packages/app/dist/' + name + '.js'), false, name);
    }
    for (const name of ['better-sqlite3', '@api-migrator/db']) {
      assert.equal(existsSync('/opt/api-migrator/node_modules/' + name), false, name);
    }`,
]);
assert.match(
  run([
    "--read-only", "--network", "none", "--entrypoint", "/usr/local/bin/node", image,
    "-e", "const n=require('node:tls').rootCertificates.length;if(n<100)process.exit(1);process.stdout.write(String(n))",
  ]),
  /^\d+$/
);
process.stdout.write(`${JSON.stringify({ image, imageId: inspect.Id, config: "passed" })}\n`);

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function run(args) {
  return docker(["run", "--rm", ...args]);
}

function runFailure(args) {
  try {
    run(args);
    return { status: 0, stdout: "", stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}
