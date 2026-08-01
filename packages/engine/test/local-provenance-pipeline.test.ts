import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigration, type Manifest } from "../src/index.js";

const manifest: Manifest = {
  name: "Inngest v4",
  provider: "inngest",
  transformSet: "inngest-v3-to-v4",
  package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
  peerFloors: [],
  transforms: ["T1"],
};

const knockManifest: Manifest = {
  name: "Knock Node v1",
  provider: "knock",
  transformSet: "knock-v0-to-v1",
  package: { name: "@knocklabs/node", from: "^0.6.0", to: "^1.0.0" },
  peerFloors: [],
  transforms: ["K1", "K4", "K5"],
};

test("pipeline resolves the scanned one-hop Inngest client fixture", async () => {
  const repo = mkdtempSync(join(tmpdir(), "api-migrator-provenance-"));
  try {
    mkdirSync(join(repo, "src", "inngest"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { inngest: "^3.0.0" } }, null, 2));
    writeFileSync(join(repo, "src", "inngest", "client.ts"), `import { Inngest } from "inngest";
export const inngest = new Inngest({ id: "demo" });
`);
    writeFileSync(join(repo, "src", "inngest", "functions.ts"), `import { inngest } from "./client";
export const fn = inngest /* wrapper comment */ . createFunction({ id: "fn" }, { event: "demo/run" }, async () => "ok");
`);

    const result = await runMigration(manifest, repo, { writeChanges: true, skipVerify: true });
    const migrated = readFileSync(join(repo, "src", "inngest", "functions.ts"), "utf8");
    assert.match(migrated, /triggers:/);
    assert.deepEqual(result.report.scannedFiles, ["src/inngest/client.ts", "src/inngest/functions.ts"]);
    assert.equal(result.report.entries.filter((entry) => entry.code === "T1" && entry.kind === "applied").length, 1);
    assert.equal(
      result.report.entries.some((entry) => entry.kind === "review" && /local module/.test(entry.message)),
      false
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pipeline refuses proof when an unscanned sibling can win module resolution", async () => {
  const repo = mkdtempSync(join(tmpdir(), "api-migrator-provenance-shadow-"));
  try {
    mkdirSync(join(repo, "src", "inngest"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { inngest: "^3.0.0" } }, null, 2));
    writeFileSync(join(repo, "src", "inngest", "client.ts"), `export const inngest = makeUnrelatedClient();\n`);
    writeFileSync(join(repo, "src", "inngest", "client.js"), `import { Inngest } from "inngest";
export const inngest = new Inngest({ id: "demo" });
`);
    const functionsPath = join(repo, "src", "inngest", "functions.ts");
    const original = `import { inngest } from "./client";
export const fn = inngest.createFunction({ id: "fn" }, { event: "demo/run" }, async () => "ok");
`;
    writeFileSync(functionsPath, original);

    const result = await runMigration(manifest, repo, { writeChanges: true, skipVerify: true });
    assert.equal(readFileSync(functionsPath, "utf8"), original);
    assert.equal(result.report.entries.some((entry) => entry.code === "T1" && entry.kind === "applied"), false);
    assert.equal(
      result.report.entries.some((entry) => entry.code === "T1" && entry.kind === "review" && /local module/.test(entry.message)),
      true
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pipeline reports namespace mutation of a one-hop client across files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "api-migrator-provenance-namespace-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { inngest: "^3.0.0" } }, null, 2));
    writeFileSync(join(repo, "src", "client.ts"), `import { Inngest } from "inngest";
export const client = new Inngest({ id: "demo" });
`);
    writeFileSync(join(repo, "src", "functions.ts"), `import { client } from "./client";
export const fn = client.createFunction({ id: "fn" }, { event: "demo/run" }, async () => "ok");
`);
    writeFileSync(join(repo, "src", "mutator.ts"), `import * as state from "./client";
Object.assign(state.client, { createFunction: fakeCreateFunction });
`);

    const result = await runMigration(manifest, repo, { writeChanges: true, skipVerify: true });
    assert.equal(result.report.entries.some((entry) => entry.code === "T1" && entry.kind === "review"), true);
    assert.equal(
      result.report.entries.some((entry) => entry.kind === "review" && /Namespace or dynamic loading/.test(entry.message)),
      true
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pipeline reports path-alias and computed mutation of a one-hop client", async () => {
  const repo = mkdtempSync(join(tmpdir(), "api-migrator-provenance-alias-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { inngest: "^3.0.0" } }, null, 2));
    writeFileSync(join(repo, "src", "client.ts"), `import { Inngest } from "inngest";
export const client = new Inngest({ id: "demo" });
`);
    writeFileSync(join(repo, "src", "functions.ts"), `import { client } from "./client";
export const fn = client.createFunction({ id: "fn" }, { event: "demo/run" }, async () => "ok");
`);
    writeFileSync(join(repo, "src", "mutator.ts"), `import * as state from "@/client";
const key = "createFunction";
state.client[key] = fakeCreateFunction;
`);

    const result = await runMigration(manifest, repo, { writeChanges: true, skipVerify: true });
    assert.equal(
      result.report.entries.some((entry) => entry.code === "T1" && entry.kind === "review" && /Path-alias/.test(entry.message)),
      true
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pipeline blocks a legacy Knock call on a local factory result", async () => {
  const repo = mkdtempSync(join(tmpdir(), "api-migrator-knock-factory-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      dependencies: { "@knocklabs/node": "^0.6.0" },
    }, null, 2));
    writeFileSync(join(repo, "src", "wrapper.ts"), `import { Knock } from "@knocklabs/node";
export function makeKnock() { return new Knock(process.env.KNOCK_KEY!); }
`);
    const notifyPath = join(repo, "src", "notify.ts");
    const notifySource = `import { makeKnock as makeApi } from "./wrapper";
const knock = makeApi();
export async function send() { return knock.notify("welcome", { recipients: ["u_1"] }); }
`;
    writeFileSync(notifyPath, notifySource);

    const result = await runMigration(knockManifest, repo, { writeChanges: true, skipVerify: true });
    assert.equal(readFileSync(notifyPath, "utf8"), notifySource);
    assert.equal(
      result.report.entries.some((entry) => entry.code === "K1" && entry.kind === "review"),
      true
    );
    assert.equal(result.report.summary.review > 0, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
