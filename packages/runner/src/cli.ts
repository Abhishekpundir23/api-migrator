#!/usr/bin/env node

import { parseRunnerCliArguments } from "./cli-arguments.js";
import { runInstallPhase, runMigratePhase, runPreparePhase, runVerifyPhase } from "./phases.js";

async function main(): Promise<void> {
  const input = parseRunnerCliArguments(process.argv.slice(2));
  switch (input.phase) {
    case "prepare":
      {
        const prepared = await runPreparePhase(input);
        process.stdout.write(
          `runner_phase=prepare status=passed prepared_state_digest=${prepared.digest}\n`
        );
      }
      return;
    case "install":
      {
        const installed = await runInstallPhase(input);
        process.stdout.write(
          `runner_phase=install status=passed prepared_state_digest=${installed.state.preparedStateDigest} install_state_digest=${installed.digest}\n`
        );
      }
      return;
    case "migrate":
      {
        const dependencies = await runMigratePhase(input);
        process.stdout.write(
          `runner_phase=migrate status=passed dependency_state_digest=${dependencies.digest}\n`
        );
      }
      return;
    case "verify": {
      const evidence = await runVerifyPhase(input);
      process.stdout.write(
        `runner_phase=verify status=passed evidence_digest=${evidence.digest} preflight_id=${evidence.evidence.output.preflightId}\n`
      );
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`runner_failed=${safeError(error)}\n`);
  process.exitCode = 1;
});

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown runner failure";
  return message
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted-key]")
    .replace(/(?:gh[opsu]_|github_pat_|npm_)[A-Za-z0-9_-]{8,}/gi, "[redacted-token]")
    .replace(/[\r\n\0]+/g, " ")
    .slice(0, 500);
}
