import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createSourceBundle,
  extractSourceBundle,
  parseSourceBundle,
  sourceBundleDigest,
  type CreateSourceBundleInput,
} from "../src/source-bundle.js";

const MANIFEST = "{\"name\":\"Inngest v4\",\"package\":{\"from\":\"^3.0.0\",\"name\":\"inngest\",\"to\":\"^4.0.0\"},\"peerFloors\":[],\"provider\":\"inngest\",\"transformSet\":\"inngest-v3-to-v4\"}";

test("builds, parses, and privately extracts an exact tracked source bundle", () => {
  const fixture = repositoryFixture();
  const extractionParent = realpathSync(mkdtempSync(join(tmpdir(), "api-migrator-source-extract-")));
  try {
    const first = createSourceBundle(fixture.input);
    const second = createSourceBundle(fixture.input);
    assert(first.bytes.equals(second.bytes));
    assert.equal(first.digest, second.digest);
    assert.equal(sourceBundleDigest(first.bytes), first.digest);

    const parsed = parseSourceBundle(first.bytes);
    assert.equal(parsed.digest, first.digest);
    assert.equal(parsed.header.repository.slug, "example-org/example-repo");
    assert.equal(parsed.header.base.sha, fixture.input.base.sha);
    assert.equal(parsed.header.base.treeSha, fixture.input.base.treeSha);
    assert.equal(parsed.header.manifest.canonicalJson, MANIFEST);
    assert.deepEqual(
      parsed.entries.map((entry) => [entry.path, entry.mode, entry.content.toString("utf8")]),
      [
        ["a.ts", "100644", "alpha\n"],
        ["b.ts", "100644", "beta\n"],
        ["scripts/run.sh", "100755", "#!/bin/sh\nexit 0\n"],
      ]
    );

    const destination = join(extractionParent, "repository");
    extractSourceBundle(parsed, destination);
    assert.equal(readFileSync(join(destination, "a.ts"), "utf8"), "alpha\n");
    assert.equal(readFileSync(join(destination, "scripts/run.sh"), "utf8"), "#!/bin/sh\nexit 0\n");
    assert.equal(lstatSync(destination).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(destination, "a.ts")).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(destination, "scripts/run.sh")).mode & 0o777, 0o700);
    assert.throws(() => extractSourceBundle(parsed, destination), /must not exist/);

    const forgedDestination = join(extractionParent, "forged");
    assert.throws(
      () => extractSourceBundle({
        ...parsed,
        entries: [{ path: "../escape", mode: "100644", content: Buffer.from("bad") }],
      }, forgedDestination),
      /not normalized/
    );
    assert.equal(lstatIfExists(forgedDestination), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(extractionParent, { recursive: true, force: true });
  }
});

test("rejects dirty or untracked checkout state and noncanonical manifests", () => {
  const fixture = repositoryFixture();
  try {
    assert.throws(
      () => createSourceBundle({ ...fixture.input, manifestJson: '{"z":1, "a":2}' }),
      /not canonical JSON/
    );
    writeFileSync(join(fixture.root, "untracked.txt"), "not approved\n");
    assert.throws(() => createSourceBundle(fixture.input), /clean tracked and untracked/);
    rmSync(join(fixture.root, "untracked.txt"));
    writeFileSync(join(fixture.root, "a.ts"), "changed\n");
    assert.throws(() => createSourceBundle(fixture.input), /clean tracked and untracked/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects tracked symlinks and hardlinked working-tree files", () => {
  const symlinkFixture = repositoryFixture();
  try {
    symlinkSync("a.ts", join(symlinkFixture.root, "link.ts"));
    git(symlinkFixture.root, ["add", "link.ts"]);
    git(symlinkFixture.root, ["commit", "--quiet", "-m", "add symlink"]);
    const input = currentInput(symlinkFixture.root);
    assert.throws(() => createSourceBundle(input), /rejects symlinks/);
  } finally {
    rmSync(symlinkFixture.root, { recursive: true, force: true });
  }

  const hardlinkFixture = repositoryFixture();
  try {
    linkSync(join(hardlinkFixture.root, "a.ts"), join(hardlinkFixture.root, "hardlink.ts"));
    git(hardlinkFixture.root, ["add", "hardlink.ts"]);
    git(hardlinkFixture.root, ["commit", "--quiet", "-m", "add hardlink"]);
    const input = currentInput(hardlinkFixture.root);
    assert.throws(() => createSourceBundle(input), /one-link regular file/);
  } finally {
    rmSync(hardlinkFixture.root, { recursive: true, force: true });
  }
});

test("rejects traversal, duplicate, content-tampered, truncated, and trailing bundle bytes", () => {
  const fixture = repositoryFixture();
  try {
    const record = createSourceBundle(fixture.input);

    const traversal = Buffer.from(record.bytes);
    replaceOnce(traversal, Buffer.from("a.ts"), Buffer.from("../x"));
    assert.throws(() => parseSourceBundle(traversal), /not normalized/);

    const duplicate = Buffer.from(record.bytes);
    replaceOnce(duplicate, Buffer.from("b.ts"), Buffer.from("a.ts"));
    assert.throws(() => parseSourceBundle(duplicate), /duplicated|canonical byte order/);

    const content = Buffer.from(record.bytes);
    const contentOffset = content.indexOf(Buffer.from("alpha\n"));
    assert.notEqual(contentOffset, -1);
    content[contentOffset] = "A".charCodeAt(0);
    assert.throws(() => parseSourceBundle(content), /digest|Git tree/);

    assert.throws(() => parseSourceBundle(record.bytes.subarray(0, -1)), /footer|truncated/);
    assert.throws(
      () => parseSourceBundle(Buffer.concat([record.bytes, Buffer.from("extra")])),
      /trailing bytes/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("binds the exact approved commit, tree, repository identity, and executable mode", () => {
  const fixture = repositoryFixture();
  try {
    assert.throws(
      () => createSourceBundle({
        ...fixture.input,
        base: { ...fixture.input.base, sha: "0".repeat(40) },
      }),
      /does not match the approved base/
    );
    assert.throws(
      () => createSourceBundle({
        ...fixture.input,
        repository: { ...fixture.input.repository, slug: "Example-Org/example-repo" },
      }),
      /canonical lowercase/
    );
    chmodSync(join(fixture.root, "scripts/run.sh"), 0o644);
    // core.fileMode can be disabled on some filesystems, so the explicit
    // per-entry mode check remains the deterministic guard either way.
    assert.throws(() => createSourceBundle(fixture.input), /clean tracked|mode differs/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function repositoryFixture(): { root: string; input: CreateSourceBundleInput } {
  const root = mkdtempSync(join(tmpdir(), "api-migrator-source-repo-"));
  git(root, ["init", "--quiet", "--object-format=sha1"]);
  git(root, ["config", "user.name", "Runner Test"]);
  git(root, ["config", "user.email", "runner@example.invalid"]);
  writeFileSync(join(root, "a.ts"), "alpha\n");
  writeFileSync(join(root, "b.ts"), "beta\n");
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/run.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "scripts/run.sh"), 0o755);
  git(root, ["add", "--all", "--"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return { root, input: currentInput(root) };
}

function currentInput(root: string): CreateSourceBundleInput {
  return {
    checkoutPath: root,
    repository: { slug: "example-org/example-repo", id: 123, ownerId: 456 },
    base: {
      branch: "main",
      sha: git(root, ["rev-parse", "HEAD"]),
      treeSha: git(root, ["rev-parse", "HEAD^{tree}"]),
    },
    manifestJson: MANIFEST,
  };
}

function replaceOnce(target: Buffer, before: Buffer, after: Buffer): void {
  assert.equal(before.length, after.length);
  const offset = target.indexOf(before);
  assert.notEqual(offset, -1);
  after.copy(target, offset);
}

function lstatIfExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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
