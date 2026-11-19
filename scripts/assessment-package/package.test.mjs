import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const archiveName = `sdk-assessment-${version}.tgz`;

function success(command, args, options) {
  const p = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.ifError(p.error);
  assert.equal(p.status, 0, p.stderr || p.stdout);
  return p.stdout;
}

test("the extracted offline owner package runs both recipes and its reports work in the operator CLI", t => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sdk-assessment-package-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const delivery = join(tmp, "delivery");
  const owner = join(tmp, "owner machine");
  const handoff = join(owner, "reports");
  mkdirSync(delivery);
  mkdirSync(handoff, { recursive: true });

  success(process.execPath, [join(root, "scripts/assessment-package/build.mjs"), delivery], { cwd: tmp });
  assert.deepEqual(readdirSync(delivery).sort(), [archiveName, archiveName + ".sha256"]);
  const bytes = readFileSync(join(delivery, archiveName));
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(readFileSync(join(delivery, archiveName + ".sha256"), "utf8"), `${digest}  ${archiveName}\n`);
  success("tar", ["-xzf", join(delivery, archiveName)], { cwd: owner });
  const kit = join(owner, "package");
  assert.deepEqual(readdirSync(kit).sort(), ["README.txt", "THIRD-PARTY-NOTICES.txt", "package.json", "sdk-assessment.cjs"]);
  const cli = join(kit, "sdk-assessment.cjs");
  assert.doesNotMatch(readFileSync(cli, "utf8"), /OPENAI_API_KEY|GITHUB_TOKEN|api\.openai\.com/);
  const notices = readFileSync(join(kit, "THIRD-PARTY-NOTICES.txt"), "utf8");
  for (const name of ["@babel/parser", "jscodeshift", "flow-parser", "flow-estree", "ast-types"]) assert.ok(notices.includes(name));
  assert.match(notices, /Permission is hereby granted/);

  // Deny outbound calls, subprocesses, source writes and reads outside this clean owner directory.
  const isolation = join(owner, "no-network.cjs");
  writeFileSync(isolation, `
    const denied = () => { throw new Error("Owner scan attempted network I/O"); };
    globalThis.fetch = denied;
    require("node:net").Socket.prototype.connect = denied;
    require("node:tls").connect = denied;
    require("node:dgram").createSocket = denied;
    for (const key of ["lookup", "resolve"]) require("node:dns")[key] = denied;
  `);
  const ownerArgs = ["--no-global-search-paths", "--experimental-permission", "--allow-fs-read=" + owner,
    "--allow-fs-write=" + handoff, "--require", isolation, cli];
  const options = { cwd: owner, env: { HOME: owner, USERPROFILE: owner, PATH: "" } };
  assert.equal(success(process.execPath, [...ownerArgs, "--version"], options).trim(), version);
  const help = success(process.execPath, [...ownerArgs, "--help"], options);
  assert.doesNotMatch(help, /--ai|\bbrief\b|\bcampaign\b/);
  assert.notEqual(spawnSync(process.execPath, [...ownerArgs, "brief"], options).status, 0);

  for (const [directory, fixture, recipe, rule] of [
    ["inngest", "inventory.ts", "inngest-v3-to-v4", "F12"],
    ["knock", "notifications.ts", "knock-v0-to-v1", "K1"],
  ]) {
    const repo = join(owner, directory);
    mkdirSync(repo);
    const privateName = "private-client-project.ts";
    const source = readFileSync(join(root, "examples/service", directory, fixture));
    writeFileSync(join(repo, privateName), source);
    const summary = join(handoff, directory + "-summary.json");
    const local = join(handoff, directory + "-private.json");
    success(process.execPath, [...ownerArgs, "assess", "--recipe", recipe, "--repo", repo,
      "--out", summary, "--local-report", local], options);
    assert.deepEqual(readFileSync(join(repo, privateName)), source);
    assert.deepEqual(readdirSync(repo), [privateName]);
    const aggregate = JSON.parse(readFileSync(summary, "utf8"));
    assert.deepEqual(Object.keys(aggregate).sort(),
      ["findings", "matchedFiles", "recipe", "sourceFiles", "version", "wouldChangeFiles"]);
    assert.equal(aggregate.recipe, recipe);
    assert.equal(aggregate.matchedFiles, 1);
    assert.equal(aggregate.wouldChangeFiles, 1);
    assert.ok(aggregate.findings.some(f => f.code === rule));
    assert.ok(!JSON.stringify(aggregate).includes(privateName));
    const details = JSON.parse(readFileSync(local, "utf8"));
    assert.deepEqual(details.summary, aggregate);
    assert.ok(details.details.some(f => f.file === privateName));
    const brief = join(handoff, directory + "-brief.md");
    success(process.execPath, [join(root, "scripts/service/cli.mjs"), "brief",
      "--summary", summary, "--out", brief], options);
    assert.ok(readFileSync(brief, "utf8").includes(rule));
  }
});
