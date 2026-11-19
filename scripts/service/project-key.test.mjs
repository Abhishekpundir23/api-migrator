import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { projectKeyPath, reviewApiKey } from "./project-key.mjs";

test("operator profile re-reads a rotated key and refuses a broadly readable file", t => {
  const temp = mkdtempSync(join(tmpdir(), "migration-config-"));
  const oldConfig = process.env.XDG_CONFIG_HOME;
  const oldKey = process.env.OPENAI_API_KEY;
  t.after(() => {
    rmSync(temp, {recursive:true, force:true});
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  });
  process.env.XDG_CONFIG_HOME = temp;
  delete process.env.OPENAI_API_KEY;
  const file = projectKeyPath();
  mkdirSync(dirname(file));
  writeFileSync(file, "example-value-one\n", {mode:0o600});
  assert.equal(reviewApiKey(), "example-value-one");
  writeFileSync(file, "example-value-two\n");
  assert.equal(reviewApiKey(), "example-value-two");
  if (process.platform !== "win32") {
    chmodSync(file, 0o644);
    assert.throws(() => reviewApiKey(), /private project key/);
  }
  process.env.OPENAI_API_KEY = "example-env";
  assert.equal(reviewApiKey(), "example-env");
});
