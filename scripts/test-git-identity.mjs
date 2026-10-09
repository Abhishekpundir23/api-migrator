import { execFileSync } from "node:child_process";

const EXPECTED = "Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>";

export function verifyFixtureIdentity(cwd, env, head = false, { deadline } = {}) {
  const bounds = () => {
    if (deadline === undefined) return {};
    const remaining = deadline - Date.now();
    if (!Number.isSafeInteger(deadline) || remaining < 1) throw new Error('fixture identity deadline exhausted');
    return { timeout: Math.min(10_000, remaining), killSignal: 'SIGKILL', maxBuffer: 65_536 };
  };
  const git = (args) => execFileSync("git", args, {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    ...bounds(),
  }).trim();
  for (const kind of ["AUTHOR", "COMMITTER"]) {
    const value = git(["var", `GIT_${kind}_IDENT`]).replace(/ \d+ [+-]\d{4}$/, "");
    if (value !== EXPECTED) throw new Error("fixture Git identity rejected");
  }
  if (head) {
    for (const format of ["%an <%ae>", "%cn <%ce>"]) {
      if (git(["show", "-s", `--format=${format}`, "HEAD"]) !== EXPECTED)
        throw new Error("fixture commit identity rejected");
    }
  }
}
