import { execFileSync } from "node:child_process";

const EXPECTED = "Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>";

export function verifyFixtureIdentity(cwd, env, head = false) {
  const git = (args) => execFileSync("git", args, {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
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
