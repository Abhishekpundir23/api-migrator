import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyFixtureIdentity } from "../../../scripts/test-git-identity.mjs";
import { validatePreviewBundlePath, writePreviewBundle } from "../src/preview-bundle.js";
import type { PublicationOutcome } from "../src/publication.js";

const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  GIT_AUTHOR_NAME: "Abhishekpundir23",
  GIT_AUTHOR_EMAIL: "74260202+Abhishekpundir23@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Abhishekpundir23",
  GIT_COMMITTER_EMAIL: "74260202+Abhishekpundir23@users.noreply.github.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, args: string[]): string {
  if (args[0] === "commit") verifyFixtureIdentity(cwd, env);
  const result = execFileSync("git", ["-c", "commit.gpgSign=false", ...args], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (args[0] === "commit") verifyFixtureIdentity(cwd, env, true);
  return result;
}

function fixture(): { root: string; checkout: string; parent: string; publication: PublicationOutcome } {
  const root = fs.mkdtempSync(join(tmpdir(), "preview-bundle-test-"));
  const checkout = join(root, "checkout");
  const parent = join(root, "private-reviews");
  fs.mkdirSync(checkout);
  fs.mkdirSync(parent, { mode: 0o700 });
  git(checkout, ["init", "--initial-branch=main"]);
  fs.writeFileSync(join(checkout, "text.txt"), "old source\n");
  fs.writeFileSync(join(checkout, "remove.txt"), "to delete\n");
  fs.writeFileSync(join(checkout, "bytes.bin"), Buffer.from([0, 1, 255, 0, 127]));
  fs.writeFileSync(join(checkout, "nonutf.txt"), Buffer.from([0x61, 0xff, 0x0a]));
  fs.writeFileSync(join(checkout, ".gitattributes"), "nonutf.txt diff=custom\n");
  git(checkout, ["add", "--all"]);
  git(checkout, ["commit", "-m", "fixture"]);
  const publication: PublicationOutcome = {
    mode: "preview", status: "preview_ready", preflightId: `pf_${"a".repeat(64)}`,
    baseBranch: "main", baseSha: git(checkout, ["rev-parse", "HEAD"]), branch: "migration",
    candidateTreeSha: git(checkout, ["write-tree"]), previewCompletedAt: 1,
    artifactDigest: `sha256:${"b".repeat(64)}`, blockers: [], overridden: false,
  };
  return { root, checkout, parent, publication };
}

function exportInput(f: ReturnType<typeof fixture>, name = "bundle") {
  return { path: join(f.parent, name), checkoutPath: f.checkout, environment: env,
    repositorySlug: "owner/repo", publication: f.publication };
}

// Detects UTF-8 decoding, missing binary/full-index/mode handling, or local diff config leakage.
test("raw staged patch reconstructs the exact candidate including binary, non-UTF-8, modes, add and delete", () => {
  const f = fixture();
  try {
    fs.writeFileSync(join(f.checkout, "text.txt"), "new private source\n");
    fs.chmodSync(join(f.checkout, "text.txt"), 0o755);
    fs.unlinkSync(join(f.checkout, "remove.txt"));
    fs.writeFileSync(join(f.checkout, "bytes.bin"), Buffer.from([255, 0, 3, 0, 129]));
    fs.writeFileSync(join(f.checkout, "nonutf.txt"), Buffer.from([0x62, 0xfe, 0x0a]));
    fs.writeFileSync(join(f.checkout, "added\tfile.txt"), "added source\n");
    git(f.checkout, ["add", "--all"]);
    f.publication.candidateTreeSha = git(f.checkout, ["write-tree"]);
    git(f.checkout, ["config", "diff.noprefix", "true"]);
    git(f.checkout, ["config", "diff.mnemonicprefix", "true"]);
    git(f.checkout, ["config", "diff.custom.textconv", "false"]);
    const input = exportInput(f);
    input.environment = { ...env, GIT_EXTERNAL_DIFF: "false" };
    const result = writePreviewBundle(input);
    const patch = fs.readFileSync(join(result.path, "candidate.patch"));
    const receipt = JSON.parse(fs.readFileSync(join(result.path, "receipt.json"), "utf8"));
    assert.deepEqual(receipt, result.receipt);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.kind, "local-preview-bundle");
    assert.equal(receipt.authorizesPublication, false);
    assert.equal(receipt.repositorySlug, "owner/repo");
    assert.equal(receipt.preflightId, f.publication.preflightId);
    assert.equal(receipt.baseBranch, "main");
    assert.equal(receipt.baseSha, f.publication.baseSha);
    assert.equal(receipt.candidateTreeSha, f.publication.candidateTreeSha);
    assert.equal(receipt.artifactDigest, f.publication.artifactDigest);
    assert.equal(receipt.previewStatus, "preview_ready");
    assert.deepEqual(receipt.blockers, []);
    assert.equal(receipt.patchBytes, patch.length);
    assert.equal(receipt.patchSha256, `sha256:${createHash("sha256").update(patch).digest("hex")}`);
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o700);
    for (const file of ["candidate.patch", "receipt.json"]) {
      assert.equal(fs.statSync(join(result.path, file)).mode & 0o777, 0o600);
    }
    assert.deepEqual(Object.keys(result).sort(), ["path", "receipt"]);
    const reconstruction = join(f.root, "reconstruction");
    git(f.root, ["clone", "--quiet", "--", f.checkout, reconstruction]);
    git(reconstruction, ["checkout", "--quiet", f.publication.baseSha]);
    git(reconstruction, ["apply", "--index", "--", join(result.path, "candidate.patch")]);
    assert.equal(git(reconstruction, ["write-tree"]), receipt.candidateTreeSha);
    assert.deepEqual(fs.readFileSync(join(reconstruction, "nonutf.txt")), Buffer.from([0x62, 0xfe, 0x0a]));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// Detects inherited zero-context diff configuration producing a completed but non-applicable patch.
test("checkout-local diff context cannot prevent ordinary git apply --index reconstruction", () => {
  const f = fixture();
  try {
    fs.writeFileSync(join(f.checkout, "text.txt"), "line one\nline two\nold middle\nline four\nline five\n");
    git(f.checkout, ["add", "--all"]);
    git(f.checkout, ["commit", "-m", "fixture context"]);
    f.publication.baseSha = git(f.checkout, ["rev-parse", "HEAD"]);
    fs.writeFileSync(join(f.checkout, "text.txt"), "line one\nline two\nnew middle\nline four\nline five\n");
    git(f.checkout, ["add", "--all"]);
    f.publication.candidateTreeSha = git(f.checkout, ["write-tree"]);
    git(f.checkout, ["config", "diff.context", "0"]);
    const result = writePreviewBundle(exportInput(f));
    const reconstruction = join(f.root, "reconstruction");
    git(f.root, ["clone", "--quiet", "--", f.checkout, reconstruction]);
    git(reconstruction, ["checkout", "--quiet", result.receipt.baseSha]);
    git(reconstruction, ["apply", "--index", "--", join(result.path, "candidate.patch")]);
    assert.equal(git(reconstruction, ["write-tree"]), result.receipt.candidateTreeSha);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// Detects synthetic empty patches that do not bind the unchanged Git tree, or losing blocker state.
test("unchanged and blocked bundles retain exact preview metadata without authorizing publication", () => {
  const f = fixture();
  try {
    f.publication.status = "no_changes";
    const unchanged = writePreviewBundle(exportInput(f, "unchanged"));
    assert.equal(fs.readFileSync(join(unchanged.path, "candidate.patch")).length, 0);
    assert.equal(unchanged.receipt.candidateTreeSha, git(f.checkout, ["rev-parse", "HEAD^{tree}"]));
    f.publication.status = "blocked";
    f.publication.blockers = [{ code: "manual_review_required", message: "1 unresolved item(s) require manual review" }];
    const blocked = writePreviewBundle(exportInput(f, "blocked"));
    assert.equal(blocked.receipt.previewStatus, "blocked");
    assert.deepEqual(blocked.receipt.blockers, ["1 unresolved item(s) require manual review"]);
    assert.equal(blocked.receipt.authorizesPublication, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// Detects unsafe parent permissions, preexisting targets, symlink following, or workspace acceptance.
test("validation accepts only a new absolute destination under a private external non-symlink parent", () => {
  const f = fixture();
  try {
    const good = exportInput(f).path;
    assert.equal(validatePreviewBundlePath(good), join(fs.realpathSync(f.parent), "bundle"));
    const existing = join(f.parent, "existing");
    fs.mkdirSync(existing);
    const link = join(f.parent, "link");
    fs.symlinkSync(existing, link);
    const parentLink = join(f.root, "parent-link");
    fs.symlinkSync(f.parent, parentLink);
    const missingParent = join(f.root, "missing", "bundle");
    const regularParent = join(f.root, "regular-parent");
    fs.writeFileSync(regularParent, "not a directory");
    for (const invalid of ["relative", "", `${good}\n`, existing, link,
      join(parentLink, "new"), missingParent, join(regularParent, "new"),
      resolve("packages/app/preview-output")]) {
      assert.throws(() => validatePreviewBundlePath(invalid));
    }
    fs.chmodSync(f.parent, 0o750);
    assert.throws(() => validatePreviewBundlePath(good));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// Detects a redundant slash/dot suffix causing lstat to dereference the final parent symlink.
for (const suffix of ["//bundle", "/./bundle"]) {
  test(`non-normalized symlink parent is rejected for ${suffix}`, () => {
    const f = fixture();
    try {
      const link = join(f.root, "parent-link");
      fs.symlinkSync(f.parent, link);
      assert.equal(validatePreviewBundlePath(join(f.parent, "ordinary")), join(fs.realpathSync(f.parent), "ordinary"));
      assert.throws(() => validatePreviewBundlePath(`${link}/bundle`));
      assert.throws(() => validatePreviewBundlePath(`${link}${suffix}`));
      assert.equal(fs.existsSync(join(f.parent, "bundle")), false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

// Detects accepting lexical aliases even when no symlink is present, preserving target interpretation.
test("preview bundle paths reject dot, dotdot, redundant and trailing components without normalizing them", () => {
  const f = fixture();
  try {
    const parent = fs.realpathSync(f.parent);
    fs.mkdirSync(join(parent, "nested"));
    for (const invalid of [`${parent}//bundle`, `${parent}/./bundle`, `${parent}/nested/../bundle`,
      `${parent}/nested/..//bundle`, `${parent}/bundle/`, `${parent}/bundle/.`, `${parent}/bundle/..`,
      `${parent}/nested/.././bundle`, `/${parent}/bundle`]) {
      assert.throws(() => validatePreviewBundlePath(invalid), `ambiguous path accepted: ${invalid}`);
    }
    assert.equal(validatePreviewBundlePath(`${parent}/ordinary`), `${parent}/ordinary`);
    assert.equal(fs.existsSync(join(parent, "bundle")), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// Detects writing over a destination which appeared after the initial pre-clone check.
test("writer refuses destinations created after validation without changing their contents", () => {
  const f = fixture();
  try {
    const input = exportInput(f);
    validatePreviewBundlePath(input.path);
    fs.mkdirSync(input.path);
    fs.writeFileSync(join(input.path, "candidate.patch"), "untouched");
    assert.throws(() => writePreviewBundle(input));
    assert.equal(fs.readFileSync(join(input.path, "candidate.patch"), "utf8"), "untouched");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// Detects relying on an existence check instead of exclusive mkdir at the actual creation point.
test("a destination appearing during creation is left intact", (t) => {
  const f = fixture();
  try {
    const input = exportInput(f);
    const canonicalPath = join(fs.realpathSync(f.parent), "bundle");
    const original = fs.mkdirSync;
    t.mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
      if (args[0] === canonicalPath) {
        original(canonicalPath, { mode: 0o700 });
        fs.writeFileSync(join(input.path, "keep"), "concurrent owner data");
      }
      return original(...args);
    });
    assert.throws(() => writePreviewBundle(input));
    assert.equal(fs.readFileSync(join(input.path, "keep"), "utf8"), "concurrent owner data");
  } finally { t.mock.restoreAll(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

// Detects returning a successful bundle with permissions accidentally reduced by host umask.
test("successful output uses exact private modes even with a restrictive owner umask", () => {
  const f = fixture();
  const priorMask = process.umask(0o300);
  try {
    const result = writePreviewBundle(exportInput(f));
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o700);
    assert.equal(fs.statSync(join(result.path, "candidate.patch")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(join(result.path, "receipt.json")).mode & 0o777, 0o600);
  } finally { process.umask(priorMask); fs.rmSync(f.root, { recursive: true, force: true }); }
});

// Detects clobbering or following a file/symlink that appeared inside the newly created directory.
test("exclusive patch creation never follows a concurrently inserted symlink", (t) => {
  const f = fixture();
  try {
    const input = exportInput(f);
    const protectedFile = join(f.parent, "protected");
    fs.writeFileSync(protectedFile, "owner data");
    const patchPath = join(fs.realpathSync(f.parent), "bundle", "candidate.patch");
    const original = fs.openSync;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === patchPath) fs.symlinkSync(protectedFile, patchPath);
      return original(...args);
    });
    assert.throws(() => writePreviewBundle(input));
    assert.equal(fs.readFileSync(protectedFile, "utf8"), "owner data");
    assert.equal(fs.lstatSync(patchPath).isSymbolicLink(), true);
    assert.equal(fs.existsSync(join(input.path, "receipt.json")), false);
  } finally { t.mock.restoreAll(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

// Detects treating Unix permission bits as Windows ACL enforcement.
test("Windows preview bundle destinations fail closed", () => {
  const f = fixture();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    assert.throws(() => validatePreviewBundlePath(exportInput(f).path));
    assert.equal(fs.existsSync(exportInput(f).path), false);
  } finally {
    Object.defineProperty(process, "platform", platform);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

// Detects receipt identity derived from arbitrary callers instead of the staged Git candidate.
test("writer rejects mismatched base or candidate before creating output", () => {
  const f = fixture();
  try {
    for (const key of ["baseSha", "candidateTreeSha"] as const) {
      const input = exportInput(f, key);
      input.publication = { ...f.publication, [key]: "c".repeat(40) };
      assert.throws(() => writePreviewBundle(input));
      assert.equal(fs.existsSync(input.path), false);
    }
    const input = exportInput(f, "publish");
    input.publication = { ...f.publication, mode: "publish" };
    assert.throws(() => writePreviewBundle(input));
    assert.equal(fs.existsSync(input.path), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// Detects unbounded diff output and subprocess exceptions which leak partial source.
test("patches exceeding 8 MiB are rejected without output or source-bearing errors", () => {
  const f = fixture();
  try {
    fs.writeFileSync(join(f.checkout, "large.txt"), "PRIVATE_SOURCE_SENTINEL\n" + "z".repeat(8 * 1024 * 1024));
    git(f.checkout, ["add", "--all"]);
    f.publication.candidateTreeSha = git(f.checkout, ["write-tree"]);
    const input = exportInput(f);
    assert.throws(() => writePreviewBundle(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /preview bundle/i);
      assert.doesNotMatch(error.message, /PRIVATE_SOURCE_SENTINEL|zzzzzz/);
      assert.equal("stdout" in error || "stderr" in error || "cause" in error, false);
      return true;
    });
    assert.equal(fs.existsSync(input.path), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// The only double replaces a failing disk write; Git capture and patch write remain real.
test("receipt write failure removes only the incomplete export and hides the underlying error", (t) => {
  const f = fixture();
  try {
    const input = exportInput(f);
    fs.writeFileSync(join(f.parent, "keep"), "untouched sibling");
    const original = fs.writeFileSync;
    let writes = 0;
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      writes++;
      if (writes === 2) {
        assert.equal(fs.existsSync(join(input.path, "candidate.patch")), true);
        throw new Error("PRIVATE_SOURCE_SENTINEL disk failure");
      }
      return original(...args);
    });
    assert.throws(() => writePreviewBundle(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /PRIVATE_SOURCE_SENTINEL/);
      return true;
    });
    assert.equal(writes, 2);
    assert.equal(fs.existsSync(input.path), false);
    assert.equal(fs.readFileSync(join(f.parent, "keep"), "utf8"), "untouched sibling");
  } finally { t.mock.restoreAll(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
