import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  gitBlobOid,
  gitObjectFormatFromOid,
  gitTreeOid,
  validateGitPath,
  type GitObjectFormat,
  type GitTreeEntry,
} from "../src/git-tree.js";

test("matches git write-tree for nested SHA-1 blobs, modes, and directory ordering", () => {
  const entries: GitTreeEntry[] = [
    { path: "foo.bar", mode: "100644", content: Buffer.from("sibling\n") },
    { path: "foo/a.ts", mode: "100644", content: Buffer.from("export const a = 1;\n") },
    { path: "scripts/run.sh", mode: "100755", content: Buffer.from("#!/bin/sh\nexit 0\n") },
    { path: "z.txt", mode: "100644", content: Buffer.from("z\n") },
  ];
  const fixture = createGitTreeFixture(entries, "sha1");
  try {
    assert.equal(gitTreeOid([...entries].reverse(), "sha1"), fixture.treeOid);
    assert.match(fixture.treeOid, /^[a-f0-9]{40}$/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uses Git blob framing exactly", () => {
  const root = mkdtempSync(join(tmpdir(), "api-migrator-git-blob-"));
  try {
    git(root, ["init", "--quiet", "--object-format=sha1"]);
    const content = Buffer.from("binary\0payload\n");
    const expected = execFileSync("git", ["hash-object", "--stdin"], {
      cwd: root,
      input: content,
      encoding: "utf8",
    }).trim();
    assert.equal(gitBlobOid(content, "sha1"), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matches git write-tree for SHA-256 repositories when supported", (context) => {
  const entries: GitTreeEntry[] = [
    { path: "package.json", mode: "100644", content: Buffer.from("{}\n") },
    { path: "src/index.ts", mode: "100644", content: Buffer.from("export {};\n") },
    { path: "tool", mode: "100755", content: Buffer.from("#!/bin/sh\n") },
  ];
  let fixture: ReturnType<typeof createGitTreeFixture>;
  try {
    fixture = createGitTreeFixture(entries, "sha256");
  } catch {
    context.skip("installed Git does not support SHA-256 repositories");
    return;
  }
  try {
    assert.equal(gitTreeOid(entries, "sha256"), fixture.treeOid);
    assert.match(fixture.treeOid, /^[a-f0-9]{64}$/);
    assert.equal(gitObjectFormatFromOid(fixture.treeOid), "sha256");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects duplicate, colliding, non-portable, forbidden, and unsupported entries", () => {
  const file = { mode: "100644" as const, content: Buffer.from("x") };
  assert.throws(
    () => gitTreeOid([{ path: "a", ...file }, { path: "a", ...file }], "sha1"),
    /Duplicate/
  );
  assert.throws(
    () => gitTreeOid([{ path: "a", ...file }, { path: "a/b", ...file }], "sha1"),
    /collides/
  );
  assert.throws(() => validateGitPath("../escape"), /not normalized/);
  assert.throws(() => validateGitPath("/absolute"), /non-portable/);
  assert.throws(() => validateGitPath("dir\\file"), /non-portable/);
  assert.throws(() => validateGitPath("dir/new\nline"), /non-portable/);
  assert.throws(() => validateGitPath("src/node_modules/pkg.js"), /forbidden/);
  assert.throws(() => validateGitPath("src/NODE_MODULES/pkg.js"), /forbidden/);
  assert.throws(() => validateGitPath(".git/config"), /forbidden/);
  assert.throws(
    () => gitTreeOid([{ path: "link", mode: "120000" as never, content: Buffer.from("target") }], "sha1"),
    /Unsupported Git file mode/
  );
  assert.throws(() => gitTreeOid([], "md5" as never), /Unsupported Git object format/);
});

function createGitTreeFixture(
  entries: readonly GitTreeEntry[],
  objectFormat: GitObjectFormat
): { root: string; treeOid: string } {
  const root = mkdtempSync(join(tmpdir(), `api-migrator-git-tree-${objectFormat}-`));
  try {
    git(root, ["init", "--quiet", `--object-format=${objectFormat}`]);
    for (const entry of entries) {
      const absolute = join(root, ...entry.path.split("/"));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, entry.content);
      chmodSync(absolute, entry.mode === "100755" ? 0o755 : 0o644);
    }
    git(root, ["add", "--all", "--"]);
    return { root, treeOid: git(root, ["write-tree"]) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
