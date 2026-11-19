import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { assessRepository } from "../src/assessment.js";
import { applyInngestV3ToV4 } from "../src/transforms/inngest-v3-to-v4.js";
import type { ReportEntry } from "../src/types.js";

const client = 'import { Inngest } from "inngest"; export const app = new Inngest({ id: "private" });';
const call = 'app.createFunction({ id: "job", triggers: [{ event: "go" }] }, async () => 42)';
const worker = 'import { app } from "./client.js";\nexport const job = ' + call + ';';
const manifest = JSON.stringify({ scripts: { build: "tsc -p tsconfig.build.json" } });
const settings = JSON.stringify({ compilerOptions: { declaration: true }, include: ["src/**/*"] });

function fixture(t: TestContext, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "inngest-declarations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), body);
  }
  return root;
}

function collect(root: string) {
  const local: ReportEntry[] = [];
  const aggregate = assessRepository(root, "inngest-v3-to-v4", entry => {
    if (entry.code === "F19") local.push(entry);
  });
  return { aggregate, local };
}

test("one F19 per active package includes one-hop .js imports and v4 registrations", t => {
  const root = fixture(t, {
    "app/package.json": manifest,
    "app/tsconfig.build.json": '{"extends":"./tsconfig.json","exclude":["**/*.test.ts"]}',
    "app/tsconfig.json": '{"extends":"@shared/tsconfig/base","compilerOptions":{"declaration":true},"include":["src/**/*"]}',
    "app/src/client.ts": client, "app/src/a.test.ts": worker, "app/src/b.ts": worker,
    "app/src/c.ts": worker, "app/not-included.ts": client + "\nexport default " + call,
    "lib/package.json": '{"scripts":{"build":"tsc"}}',
    "lib/tsconfig.json": '{"compilerOptions":{"composite":true},"files":["worker.mts"]}',
    "lib/worker.mts": client + "\nconst job = " + call + ";\nexport { job as send };",
  });
  const { aggregate, local } = collect(root);
  assert.deepEqual(local.map(e => [e.file, e.line, e.kind]), [["app/src/b.ts", 2, "review"], ["lib/worker.mts", 2, "review"]]);
  assert.deepEqual(aggregate.findings.filter(f => f.code === "F19"), [{ code: "F19", kind: "review", count: 2 }]);
  assert.doesNotMatch(JSON.stringify(aggregate), /worker|private|TS2742|src\/|tsconfig/);
  assert.equal(aggregate.wouldChangeFiles, 0);
  assert.match(local[0].message, /effective compiler settings.*If it does, run that build.*TS2742/);
  assert.match(local[1].message, /Run the package’s build.*check for TS2742.*If required.*public Inngest function type.*step results/);
});

test("the package review persists across the trigger migration until the last export is annotated", t => {
  const legacy = 'app.createFunction({ id: "job" }, { event: "go" }, async () => 42)';
  const file = "src/worker.ts";
  const root = fixture(t, { "package.json": '{"scripts":{"build":"tsc -b tsconfig.build.json"}}',
    "tsconfig.build.json": settings, [file]: client + "\nexport const job = " + legacy });
  assert.equal(collect(root).local.length, 1);
  writeFileSync(join(root, file), client + "\nexport const job: F = " + call + ";\nexport const pending = " + call + ";");
  assert.equal(collect(root).local.at(0)?.line, 3);
  writeFileSync(join(root, file), client + "\nexport const job: F = " + call + ";\nexport const pending: F = " + call + ";");
  assert.equal(collect(root).local.length, 0);
});

test("annotations, foreign receivers, reexports, non-exported and JS registrations do not qualify", t => {
  const base = client + "\n";
  const root = fixture(t, {
    "package.json": manifest, "tsconfig.build.json": settings,
    "src/typed.ts": base + 'export const job: PublicFunction = ' + call,
    "src/asserted.ts": base + 'export const job = ' + call + ' as PublicFunction;',
    "src/other.ts": base + 'const job = ' + call + '; export const other = 3;',
    "src/foreign.ts": 'const app = unrelated(); export const job = ' + call,
    "src/handler.ts": base + 'export const work = () => ' + call,
    "src/barrel.ts": 'export { job } from "./other.js";',
    "src/js.js": base + 'export const job = ' + call,
  });
  assert.deepEqual(collect(root).local, []);
});

test("source outside the active project or missing evidence of declaration emit stays quiet", t => {
  const cases: Array<[string, string, string, string?]> = [
    ["overridden", manifest, '{"extends":"./tsconfig.json","compilerOptions":{"declaration":false}}', settings],
    ["noemit", manifest, '{"compilerOptions":{"declaration":true,"noEmit":true}}'],
    ["external", manifest, '{"extends":"@example/tsconfig/library","include":["src/**/*"],"exclude":[]}'],
    ["escape", manifest, '{"extends":"../tsconfig.json","compilerOptions":{"declaration":true}}'],
    ["multi-command", '{"scripts":{"build":"tsc\\n-p tsconfig.build.json"}}', settings],
    ["inactive", '{"scripts":{"build":"tsc --noEmit"}}', settings],
    ["unknown", '{"scripts":{"build":"other && tsc"}}', settings],
    ["files", manifest, '{"compilerOptions":{"declaration":true},"files":["another.ts"]}'],
    ["include", manifest, '{"compilerOptions":{"declaration":true},"include":["lib/**/*"]}'],
    ["exclude", manifest, '{"compilerOptions":{"declaration":true},"exclude":["src"]}'],
    ["ambiguous-exclude", manifest, '{"compilerOptions":{"declaration":true},"exclude":["src/[ab].ts"]}'],
    ["building-other-config", manifest, '{"compilerOptions":{}}', settings],
    ["oversized", manifest, " ".repeat(128 * 1024) + settings],
    ["cycle", manifest, '{"extends":"./tsconfig.build.json","compilerOptions":{"declaration":true}}'],
  ];
  const files: Record<string, string> = {};
  for (const [dir, pkg, active, standard] of cases) {
    files[dir + "/package.json"] = pkg;
    files[dir + "/tsconfig.build.json"] = active;
    if (standard) files[dir + "/tsconfig.json"] = standard;
    files[dir + "/src/job.ts"] = client + "\nexport default " + call;
  }
  const root = fixture(t, files);
  assert.deepEqual(collect(root).local, []);
});

test("a linked config is never used as local evidence, and campaign mode cannot collect F19", t => {
  const outside = fixture(t, { "remote.json": settings });
  const source = client + "\nexport const job = " + call;
  const root = fixture(t, { "package.json": manifest, "src/job.ts": source });
  symlinkSync(join(outside, "remote.json"), join(root, "tsconfig.build.json"));
  assert.deepEqual(collect(root).local, []);
  let signals = 0;
  const campaignResult = applyInngestV3ToV4(source, "src/job.ts", { push: () => {} }, new Set(["F19"]), {
    scannedSources: new Map(), sourcePaths: new Set(), onInferredRegistrationExport: () => signals++,
  });
  assert.equal(signals, 0);
  assert.equal(campaignResult, null);
});


test("compiler JSONC permits comments, trailing commas and a BOM, while package manifests stay strict", t => {
  const root = fixture(t, {
    "package.json": manifest, "src/job.ts": client + "\nexport default " + call,
    "tsconfig.build.json": `\uFEFF{
      // Legacy builds still generate public declarations.
      "$schema": "https://example.invalid/schemas/tsconfig.json",
      "compilerOptions": { "declaration": true, /* keep declarations */ },
      "include": ["src/**/*",],
    }`,
  });
  assert.match(collect(root).local[0].message, /Run the package’s build/);
  writeFileSync(join(root, "package.json"), '{ "scripts": {"build": "tsc -p tsconfig.build.json",} }');
  assert.deepEqual(collect(root).local, []);
  writeFileSync(join(root, "package.json"), manifest);
  writeFileSync(join(root, "tsconfig.build.json"), '{"compilerOptions": {"declaration": true} // missing closing brace');
  assert.deepEqual(collect(root).local, []);
});

test("a checked-in pnpm workspace config controls inherited noEmit and local overrides", t => {
  const base = "packages/config/base.json";
  const config = (noEmit?: boolean) => JSON.stringify({
    extends: "@org/config/library.json", compilerOptions: { declaration: true, noEmit },
    include: ["src/**/*"], exclude: [],
  });
  const pkg = JSON.stringify({ scripts: { build: "tsc" }, devDependencies: { "@org/config": "workspace:*" } });
  const lock = `lockfileVersion: '9.0'
importers:
  apps/worker:
    devDependencies:
      '@org/config':
        specifier: workspace:*
        version: link:../../packages/config
`;
  const root = fixture(t, {
    "apps/worker/package.json": pkg, "apps/worker/tsconfig.json": config(),
    "apps/worker/src/job.ts": client + "\nexport default " + call,
    "packages/config/package.json": '{"name":"@org/config"}',
    "packages/config/library.json": '{"extends":"./base.json"}',
    [base]: '{"compilerOptions":{"noEmit":true,},}', "pnpm-lock.yaml": lock,
  });
  assert.deepEqual(collect(root).local, []);
  writeFileSync(join(root, "apps/worker/tsconfig.json"), config(false));
  assert.match(collect(root).local[0].message, /Run the package’s build/);
  writeFileSync(join(root, "apps/worker/tsconfig.json"), config());
  writeFileSync(join(root, base), '{"compilerOptions":{"noEmit":false}}');
  assert.match(collect(root).local[0].message, /Run the package’s build/);
  writeFileSync(join(root, base), '{"compilerOptions":{"noEmit":true}}');
  for (const invalid of [lock.replace("workspace:*", "^1"), lock.replace("apps/worker:", "apps/other:"),
    lock.replace("../../packages/config", "../../../external/config")]) {
    writeFileSync(join(root, "pnpm-lock.yaml"), invalid);
    assert.match(collect(root).local[0].message, /confirm whether its build emits declarations/);
  }
  writeFileSync(join(root, "pnpm-lock.yaml"), lock);
  writeFileSync(join(root, "packages/config/package.json"), '{"name":"different-package"}');
  assert.match(collect(root).local[0].message, /confirm whether its build emits declarations/);
  const outside = fixture(t, { "base.json": '{"compilerOptions":{"noEmit":true}}' });
  rmSync(join(root, base));
  symlinkSync(join(outside, "base.json"), join(root, base));
  writeFileSync(join(root, "packages/config/package.json"), '{"name":"@org/config"}');
  assert.match(collect(root).local[0].message, /confirm whether its build emits declarations/);
});
