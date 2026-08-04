import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveSealedCandidateIdentity } from "../src/phases.js";

test("publication identity is derived from sealed proposed bytes, never mutable replay bytes", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "api-migrator-sealed-candidate-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = join(root, "original");
  const proposed = join(root, "proposed");
  const replay = join(root, "replay");
  for (const path of [original, proposed, replay]) mkdirSync(path);
  writeFileSync(join(original, "index.ts"), "export const value = 'old';\n");
  writeFileSync(join(proposed, "index.ts"), "export const value = 'sealed';\n");
  writeFileSync(join(replay, "index.ts"), "export const value = 'late mutation';\n");

  const baseSha = "1".repeat(40);
  const sealed = deriveSealedCandidateIdentity(original, proposed, baseSha);
  const mutable = deriveSealedCandidateIdentity(original, replay, baseSha);

  assert.deepEqual(sealed.changedFiles, ["index.ts"]);
  assert.notEqual(sealed.artifact.digest, mutable.artifact.digest);
  assert.notEqual(sealed.candidateTreeSha, mutable.candidateTreeSha);
  assert.notEqual(sealed.outputTreeDigest, mutable.outputTreeDigest);
});
