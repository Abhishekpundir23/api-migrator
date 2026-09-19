import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyFixtureIdentity } from "../../../scripts/test-git-identity.mjs";

test("fixture guard rejects either wrong identity before a commit and verifies the resulting commit", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "api-migrator-git-identity-test-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const goodEnv = {
    PATH: process.env.PATH,
    GIT_AUTHOR_NAME: "Abhishekpundir23",
    GIT_AUTHOR_EMAIL: "74260202+Abhishekpundir23@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Abhishekpundir23",
    GIT_COMMITTER_EMAIL: "74260202+Abhishekpundir23@users.noreply.github.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: repo, env: goodEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  git(["init", "--quiet"]);
  verifyFixtureIdentity(repo, goodEnv);
  for (const key of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"] as const) {
    assert.throws(() => verifyFixtureIdentity(repo, {
      ...goodEnv, [key]: "wrong@example.invalid",
    }), /fixture Git identity rejected/);
  }
  verifyFixtureIdentity(repo, goodEnv);
  git(["commit", "--allow-empty", "--no-gpg-sign", "-m", "fixture"]);
  verifyFixtureIdentity(repo, goodEnv, true);
});
