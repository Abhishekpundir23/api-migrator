import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCandidateFilesForTest } from "../src/pipeline.js";

test("a later commit conflict rolls prior files back and preserves the conflicting edit", () => {
  withTrees(({ repository, expected, proposed }) => {
    assert.throws(
      () => applyCandidateFilesForTest(
        repository,
        expected,
        proposed,
        ["a.txt", "b.txt"],
        (_file, index) => {
          if (index === 1) writeFileSync(join(repository, "b.txt"), "operator-b\n");
        }
      ),
      /Repository file changed after migration planning: b\.txt/
    );
    assert.equal(readFileSync(join(repository, "a.txt"), "utf8"), "original-a\n");
    assert.equal(readFileSync(join(repository, "b.txt"), "utf8"), "operator-b\n");
    assertNoTransactionArtifacts(repository);
  });
});

test("rollback never deletes a concurrent edit to an already installed candidate", () => {
  withTrees(({ repository, expected, proposed }) => {
    assert.throws(
      () => applyCandidateFilesForTest(
        repository,
        expected,
        proposed,
        ["a.txt", "b.txt"],
        (_file, index) => {
          if (index !== 1) return;
          writeFileSync(join(repository, "a.txt"), "operator-a\n");
          writeFileSync(join(repository, "b.txt"), "operator-b\n");
        }
      ),
      /Rollback also failed: a\.txt: Repository file changed while rolling back/
    );
    assert.equal(readFileSync(join(repository, "a.txt"), "utf8"), "operator-a\n");
    assert.equal(readFileSync(join(repository, "b.txt"), "utf8"), "operator-b\n");
    assertNoTransactionArtifacts(repository);
  });
});

test("successful return rejects an edit to an already installed candidate", () => {
  withTrees(({ repository, expected, proposed }) => {
    assert.throws(
      () => applyCandidateFilesForTest(
        repository,
        expected,
        proposed,
        ["a.txt", "b.txt"],
        (_file, index) => {
          if (index === 1) writeFileSync(join(repository, "a.txt"), "operator-a\n");
        }
      ),
      /Repository file changed while rolling back: a\.txt/
    );
    assert.equal(readFileSync(join(repository, "a.txt"), "utf8"), "operator-a\n");
    assert.equal(readFileSync(join(repository, "b.txt"), "utf8"), "original-b\n");
    assertNoTransactionArtifacts(repository);
  });
});

test("successful return rejects an unreported concurrent tree edit", () => {
  withTrees(({ repository, expected, proposed }) => {
    writeFileSync(join(repository, "c.txt"), "original-c\n");
    writeFileSync(join(expected, "c.txt"), "original-c\n");

    assert.throws(
      () => applyCandidateFilesForTest(
        repository,
        expected,
        proposed,
        ["a.txt", "b.txt"],
        (_file, index) => {
          if (index === 0) writeFileSync(join(repository, "c.txt"), "operator-c\n");
        }
      ),
      /Applied repository tree differs from the verified migration candidate/
    );
    assert.equal(readFileSync(join(repository, "a.txt"), "utf8"), "original-a\n");
    assert.equal(readFileSync(join(repository, "b.txt"), "utf8"), "original-b\n");
    assert.equal(readFileSync(join(repository, "c.txt"), "utf8"), "operator-c\n");
    assertNoTransactionArtifacts(repository);
  });
});

test("whole-tree digest framing rejects file bytes that impersonate another entry", () => {
  withTrees(({ repository, expected, proposed }) => {
    writeFileSync(join(repository, "c.txt"), "original-c\n");
    writeFileSync(join(expected, "c.txt"), "original-c\n");
    writeFileSync(join(proposed, "c.txt"), "candidate-c\n");
    writeFileSync(join(expected, "digest-a.txt"), "A");
    writeFileSync(join(expected, "digest-b.txt"), "B");
    const mode = String(lstatSync(join(expected, "digest-b.txt")).mode & 0o777);
    writeFileSync(
      join(repository, "digest-a.txt"),
      Buffer.from(`A\0f\0digest-b.txt\0${mode}\0B`)
    );

    assert.throws(
      () => applyCandidateFilesForTest(
        repository,
        expected,
        proposed,
        ["c.txt"],
        () => undefined
      ),
      /Repository tree changed after migration planning/
    );
    assert.equal(existsSync(join(repository, "digest-b.txt")), false);
    assert.equal(readFileSync(join(repository, "c.txt"), "utf8"), "original-c\n");
    assertNoTransactionArtifacts(repository);
  });
});

function withTrees(
  run: (paths: { repository: string; expected: string; proposed: string }) => void
): void {
  const root = mkdtempSync(join(tmpdir(), "api-migrator-transaction-"));
  const repository = join(root, "repository");
  const expected = join(root, "expected");
  const proposed = join(root, "proposed");
  try {
    for (const directory of [repository, expected, proposed]) {
      mkdirSync(directory);
    }
    for (const [name, value] of [["a.txt", "original-a\n"], ["b.txt", "original-b\n"]] as const) {
      writeFileSync(join(repository, name), value);
      writeFileSync(join(expected, name), value);
    }
    writeFileSync(join(proposed, "a.txt"), "candidate-a\n");
    writeFileSync(join(proposed, "b.txt"), "candidate-b\n");
    run({ repository, expected, proposed });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertNoTransactionArtifacts(repository: string): void {
  assert.equal(
    readdirSync(repository).some((name) => name.includes(".api-migrator-")),
    false
  );
}
