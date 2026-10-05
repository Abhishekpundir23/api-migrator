import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";

const ID = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_BUFFER = 16 * 1024 * 1024;
const CONTROL_TIMEOUT = 10_000;

export function createDockerFixtureExecutor({ command = execFileSync } = {}) {
  let cleanupComplete = true;
  const assertCleanupComplete = () => {
    if (!cleanupComplete) throw new Error("Docker fixture cleanup unverified");
  };
  const docker = (args, timeout = CONTROL_TIMEOUT, maxBuffer = 1024 * 1024) => command("docker", args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer, killSignal: "SIGKILL",
  });
  return {
    execute(request) {
      assertCleanupComplete();
      const { dockerArgs, timeoutMs, maxBuffer, image } = request;
      const { name, job, user, imageIndex } = identity(request);
      const nonce = randomBytes(16).toString("hex");
      let id, output, failure;
      const inspectOwned = (containerId, invoke) => {
        const records = JSON.parse(invoke(["container", "inspect", containerId]));
        const record = records?.[0];
        if (!Array.isArray(records) || records.length !== 1 || record?.Id !== containerId
          || record.Name !== `/${name}` || record.Image !== image || record.Config?.User !== user
          || record.Config?.Labels?.["api-migrator.fixture-job"] !== job
          || record.Config?.Labels?.["api-migrator.fixture-attempt"] !== nonce
          || record.HostConfig?.AutoRemove !== false) {
          throw new Error("Docker fixture container ownership mismatch");
        }
      };
      cleanupComplete = false;
      try {
        // Keep the container until explicit cleanup; unlike `run --rm`, a lost
        // client cannot erase the record needed to prove exact ownership.
        const options = dockerArgs.slice(1, imageIndex).filter((arg) => arg !== "--rm");
        const created = docker(["create", "--label", `api-migrator.fixture-attempt=${nonce}`,
          ...options, ...dockerArgs.slice(imageIndex)]).trim();
        if (!ID.test(created)) throw new Error("Docker create returned an invalid container ID");
        id = created;
        inspectOwned(id, docker);
        output = docker(["start", "--attach", id], timeoutMs, maxBuffer);
      } catch (error) { failure = error; }
      try {
        // A separate monotonic budget leaves cleanup time after phase timeout.
        const deadline = performance.now() + 30_000;
        const cleanupDocker = (args) => {
          const remaining = Math.floor(deadline - performance.now());
          if (remaining < 1) throw new Error("Docker fixture cleanup deadline exceeded");
          return docker(args, Math.min(CONTROL_TIMEOUT, remaining));
        };
        const inventory = (filter) => {
          const text = cleanupDocker(["container", "ls", "--all", "--no-trunc",
            "--filter", filter, "--format", "{{.ID}}"]);
          const ids = text.trim() ? text.trim().split("\n") : [];
          if (ids.length > 1 || ids.some((value) => !ID.test(value))) {
            throw new Error("Docker fixture inventory invalid");
          }
          return ids;
        };
        if (!id) {
          const ids = inventory(`name=^/${name}$`);
          // A timed-out daemon create can complete after an empty inventory.
          // Do not delete bind sources based on an uncertain absence snapshot.
          if (ids.length !== 1) throw new Error("Docker fixture creation outcome unverified");
          id = ids[0];
          inspectOwned(id, cleanupDocker);
        }
        const present = inventory(`id=${id}`);
        if (present.length && present[0] !== id) throw new Error("Docker fixture inventory ID mismatch");
        if (present.length) {
          inspectOwned(id, cleanupDocker);
          let removalError;
          try { cleanupDocker(["container", "rm", "--force", id]); }
          catch (error) { removalError = error; }
          if (inventory(`id=${id}`).length !== 0) {
            throw new Error("Docker fixture container remains after removal", { cause: removalError });
          }
        }
        cleanupComplete = true;
      } catch (error) {
        throw failure ? new AggregateError([failure, error], "Docker fixture execution and cleanup failed") : error;
      }
      if (failure) throw failure;
      return output;
    },
    assertCleanupComplete,
  };
}

function identity({ dockerArgs, timeoutMs, maxBuffer, image, phase }) {
  if (!Array.isArray(dockerArgs) || dockerArgs.some((arg) => typeof arg !== "string")
    || dockerArgs[0] !== "run" || !DIGEST.test(image ?? "")
    || !["prepare", "install", "migrate", "verify"].includes(phase)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60_000
    || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > MAX_BUFFER) {
    throw new TypeError("fixture execution configuration invalid");
  }
  const imageIndex = dockerArgs.indexOf(image);
  const options = dockerArgs.slice(1, imageIndex);
  const value = (option) => {
    if (options.filter((arg) => arg === option).length !== 1) throw new TypeError("fixture identity options invalid");
    return options[options.indexOf(option) + 1];
  };
  if (imageIndex < 1 || options.filter((arg) => arg === "--rm").length !== 1
    || options.some((arg) => /^(--(?:name|label|user)=|-l$|-u$|--label-file)/.test(arg))) {
    throw new TypeError("fixture identity options invalid");
  }
  const name = value("--name"), label = value("--label"), user = value("--user");
  const match = /^api-migrator\.fixture-job=(previewjob_[a-f0-9]{64})$/.exec(label ?? "");
  if (!match || name !== `api-migrator-fixture-${match[1]}-${phase}` || !/^[1-9][0-9]*:[1-9][0-9]*$/.test(user ?? "")) {
    throw new TypeError("fixture container identity invalid");
  }
  return { name, job: match[1], user, imageIndex };
}

export async function withFixtureWorkspace(root, executor, run) {
  let result, failure;
  try { result = await run(); }
  catch (error) { failure = error; }
  try { executor.assertCleanupComplete(); }
  catch (error) {
    throw new AggregateError(failure ? [failure, error] : [error],
      `Docker cleanup unverified; fixture workspace retained at ${root}`);
  }
  try { rmSync(root, { recursive: true, force: true }); }
  catch (error) {
    throw new AggregateError(failure ? [failure, error] : [error], `fixture workspace removal failed at ${root}`);
  }
  if (failure) throw failure;
  return result;
}
