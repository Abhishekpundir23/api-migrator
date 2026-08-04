import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RunnerCommand,
  RunnerResult,
  RunnerTemporaryFile,
  VerificationRunner,
} from "@api-migrator/engine";

/**
 * Process runner used only inside the outer, read-only-root publication
 * container. Network policy is supplied by the host/container boundary; the
 * selected phase still rejects a mismatched engine command before spawning.
 */
export class PublicationVerificationRunner implements VerificationRunner {
  // Preflight identity intentionally uses the same stable runner label as the
  // existing Docker publisher. Deployment provenance is bound separately by
  // the signed runner attestation; divergent labels would make the exact
  // owner-authorized preflight impossible to replay at publication time.
  readonly kind = "docker";

  constructor(private readonly allowedNetwork: "default" | "none") {}

  createTemporaryFile(name: string): RunnerTemporaryFile {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) {
      throw new Error("Runner temporary filename is invalid");
    }
    const root = mkdtempSync(join(tmpdir(), "api-migrator-runner-temp-"));
    return {
      path: join(root, name),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  run(repoPath: string, command: RunnerCommand): RunnerResult {
    if (command.network !== this.allowedNetwork) {
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        spawnError: `runner phase forbids ${command.network} network commands`,
        timedOut: false,
      };
    }
    const result = spawnSync(command.command, command.args, {
      cwd: repoPath,
      env: command.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: command.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      spawnError: result.error?.message,
      timedOut: result.signal === "SIGKILL" && Boolean(result.error),
    };
  }
}
