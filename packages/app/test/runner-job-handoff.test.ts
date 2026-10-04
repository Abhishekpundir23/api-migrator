import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJobSourceStoreTestAccess } from "../../db/src/runner-job-source-store.js";
import { createJobFixture } from "./helpers/runner-job-fixture.js";
import { createRunnerJobService, createRunnerJobServiceForTest } from "../src/runner-job-record.js";
import { createSourceBundle, parseSourceBundle } from "../src/runner-source-bundle.js";
import { canonicalJson } from "../src/canonical-json.js";
import { loadRunnerInputs } from "../../runner/src/inputs.js";

function fixture(t: test.TestContext, options: { configured?: boolean; afterRead?: () => void; sourceContent?: string; directory?: (f: ReturnType<typeof createJobFixture>) => string } = {}) {
  const f = createJobFixture(options.sourceContent);
  t.after(() => f.close());
  const root = dirname(f.directory);
  const directory = options.directory?.(f) ?? join(root, "sources");
  if (!options.directory) mkdirSync(directory, { mode: 0o700 });
  const config = { directory: f.directory, expectedStoreId: f.storeId, evidence: null,
    ...(options.configured === false ? {} : { handoffDirectory: directory }) };
  const sources = createJobSourceStoreTestAccess(root);
  const service = createRunnerJobServiceForTest(config, { migrationWorkspaceRoots: f.policy.migrationWorkspaceRoots }, {
    clock: f.clock, client: null, openStore: f.access.open,
    openSources: (path, storeId, policy) => {
      const store = sources.open(path, storeId, policy);
      return { ...store, read(id) { const bytes = store.read(id); options.afterRead?.(); return bytes; } };
    },
  });
  assert.equal(service.ok, true, "handoff configuration must be recognized");
  if (!service.ok) throw new Error("configuration rejected");
  const opened = service.value.open();
  if (!opened.ok) return { ...f, config, directory, opened, sources, service: service.value, session: null! };
  const session = opened.value;
  t.after(() => session.close());
  return { ...f, config, directory, opened, sources, service: service.value, session };
}
function value<T>(result: { ok: true; value: T } | { ok: false }): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("expected success");
  return result.value;
}
function key(record: { campaignId: string; runId: string; jobId: string }) {
  return { campaignId: record.campaignId, runId: record.runId, jobId: record.jobId };
}

test("handoff retains the one exact bundle and committed original plan without authority", (t) => {
  const f = fixture(t);
  assert.ok(f.opened.ok);
  const expected = createSourceBundle(f.input);
  const handoff = value(f.session.prepareHandoff(f.input));
  assert.deepEqual(handoff.sourceBundle, expected.bytes);
  assert.equal(handoff.job.source.sourceArchiveDigest, expected.digest);
  assert.equal(handoff.job.revision, 1);
  assert.equal(handoff.job.plan.plan.job.expiresAt, f.input.expiresAt);
  assert.deepEqual(value(f.session.inspect(key(handoff.job))), handoff.job);
  assert.deepEqual(Object.keys(handoff).sort(), ["job", "sourceBundle"]);
  assert.equal(parseSourceBundle(handoff.sourceBundle).header.base.treeSha, f.input.base.treeSha);
  handoff.sourceBundle.fill(0);
  assert.deepEqual(value(f.session.readHandoff(key(handoff.job))).sourceBundle, expected.bytes);
  assert.deepEqual(readdirSync(f.config.directory), ["runner-jobs.sqlite"]);
});

test("exact retry and job-only interruption reuse the durable winner", (t) => {
  const f = fixture(t);
  const prepared = value(f.session.prepare(f.input));
  assert.equal(readdirSync(f.directory).length, 0);
  assert.deepEqual(f.session.readHandoff(key(prepared)), { ok: false, source: "job", code: "store_unavailable" });
  const first = value(f.session.prepareHandoff(f.input));
  f.state.wall += 1_000;
  assert.deepEqual(value(f.session.prepareHandoff(f.input)), first);
  assert.deepEqual(first.job, prepared);
  const changed = { ...f.input, repository: { ...f.input.repository, ownerId: f.input.repository.ownerId + 1 } };
  assert.deepEqual(f.session.prepareHandoff(changed), { ok: false, source: "job", code: "job_conflict" });
  assert.deepEqual(value(f.session.readHandoff(key(prepared))), first);
});

test("fresh process reads handoff without the original checkout or new preparation", (t) => {
  const f = fixture(t);
  const first = value(f.session.prepareHandoff(f.input));
  rmSync(f.input.checkoutPath, { recursive: true, force: true });
  f.session.close();
  const paths = {
    service: new URL("../src/runner-job-record.ts", import.meta.url).href,
    store: new URL("../../db/src/runner-job-store-sqlite.ts", import.meta.url).href,
    sources: new URL("../../db/src/runner-job-source-store.ts", import.meta.url).href,
  };
  const code = `
    import { createRunnerJobServiceForTest } from ${JSON.stringify(paths.service)};
    import { createJobStoreTestAccess } from ${JSON.stringify(paths.store)};
    import { createJobSourceStoreTestAccess } from ${JSON.stringify(paths.sources)};
    const [root, config, policy, key, now] = JSON.parse(process.argv[1]);
    const s = createRunnerJobServiceForTest(config, policy, {
      clock: { wallNow: () => now, monotonicNow: () => 0 }, client: null,
      openStore: createJobStoreTestAccess(root).open,
      openSources: createJobSourceStoreTestAccess(root).open
    });
    if (!s.ok) throw new Error(s.code);
    const opened = s.value.open(); if (!opened.ok) throw new Error(opened.code);
    try {
      const read = opened.value.readHandoff(key); if (!read.ok) throw new Error(read.code);
      process.stdout.write(JSON.stringify({ job: read.value.job, bytes: read.value.sourceBundle.toString('base64') }));
    } finally { opened.value.close(); }`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code,
    JSON.stringify([dirname(f.config.directory), f.config, { migrationWorkspaceRoots: f.policy.migrationWorkspaceRoots }, key(first.job), f.state.wall + 100])],
  { encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
  const recovered = JSON.parse(child.stdout);
  assert.deepEqual(recovered.job, first.job);
  assert.deepEqual(Buffer.from(recovered.bytes, "base64"), first.sourceBundle);
});

for (const corruption of ["changed bytes", "different valid bundle", "missing"] as const) {
  test(`${corruption} source cannot be handed off or repaired by retry`, (t) => {
    const f = fixture(t);
    const first = value(f.session.prepareHandoff(f.input));
    const file = join(f.directory, `${f.storeId}_${first.job.jobId}`, "source.bundle");
    if (corruption === "changed bytes") writeFileSync(file, "corrupt");
    if (corruption === "different valid bundle") writeFileSync(file,
      createSourceBundle({ ...f.input, repository: { ...f.input.repository, id: 9876 } }).bytes);
    if (corruption === "missing") rmSync(file);
    const read = f.session.readHandoff(key(first.job));
    assert.equal(read.ok, false);
    assert.ok(["store_corrupt", "store_unsafe"].includes(read.code));
    assert.equal(f.session.prepareHandoff(f.input).ok, false);
  });
}

test("prepared state, original expiry and observed rollback bound every handoff", (t) => {
  const f = fixture(t);
  const first = value(f.session.prepareHandoff(f.input));
  f.state.wall += 1_000;
  value(f.session.readHandoff(key(first.job)));
  f.state.wall -= 1;
  assert.deepEqual(f.session.readHandoff(key(first.job)), { ok: false, source: "job", code: "clock_rollback" });
  f.state.wall = f.input.expiresAt;
  assert.deepEqual(f.session.readHandoff(key(first.job)), { ok: false, source: "job", code: "job_expired" });
  assert.deepEqual(f.session.prepareHandoff(f.input), { ok: false, source: "job", code: "job_expired" });
});

test("reviewed jobs cannot be handed out again as execution inputs", (t) => {
  const f = fixture(t);
  const first = value(f.session.prepareHandoff(f.input));
  f.state.wall = f.sourceFixture.context.previewCompletedAt;
  value(f.session.recordReviewedOutput(key(first.job), f.sourceFixture.context.reviewedOutput, f.state.wall));
  assert.deepEqual(f.session.readHandoff(key(first.job)), { ok: false, source: "job", code: "job_conflict" });
  assert.deepEqual(f.session.prepareHandoff(f.input), { ok: false, source: "job", code: "job_conflict" });
});

test("expiry during source I/O prevents bytes escaping", (t) => {
  let expire = false;
  const f = fixture(t, { afterRead: () => { if (expire) f.state.wall = f.input.expiresAt; } });
  const first = value(f.session.prepareHandoff(f.input));
  expire = true;
  assert.deepEqual(f.session.readHandoff(key(first.job)), { ok: false, source: "job", code: "job_expired" });
});

test("missing handoff configuration is fail-closed and metadata remains usable", (t) => {
  const f = fixture(t, { configured: false });
  const prepared = value(f.session.prepare(f.input));
  assert.deepEqual(f.session.prepareHandoff(f.input), { ok: false, source: "job", code: "input_invalid" });
  assert.deepEqual(f.session.readHandoff(key(prepared)), { ok: false, source: "job", code: "input_invalid" });
  f.session.close();
  assert.deepEqual(f.session.prepareHandoff(f.input), { ok: false, source: "job", code: "store_unavailable" });
});

for (const overlap of ["same", "parent", "child", "alias"] as const) {
  test(`handoff directory ${overlap} overlap with the database is refused`, (t) => {
    const f = fixture(t, { directory: (source) => {
      if (overlap === "same") return source.directory;
      if (overlap === "parent") return dirname(source.directory);
      if (overlap === "child") {
        const directory = join(source.directory, "sources");
        mkdirSync(directory, { mode: 0o700 }); return directory;
      }
      const alias = join(dirname(source.directory), "alias");
      symlinkSync(source.directory, alias); return alias;
    } });
    assert.deepEqual(f.opened, { ok: false, source: "job", code: "store_unsafe" });
  });
}

test("normal factory has no filesystem/test-clock bypass and rejects handoff overrides", (t) => {
  const f = fixture(t);
  const service = value(createRunnerJobService(f.config, { migrationWorkspaceRoots: f.policy.migrationWorkspaceRoots }));
  assert.deepEqual(service.open(), { ok: false, source: "job", code: "store_unsafe" });
  assert.equal(f.session.prepareHandoff({ ...f.input, sourceBundle: Buffer.from("x") }).ok, false);
  assert.equal(f.store.list().length, 0);
});

test("oversized handoff source is refused before persisting any job", (t) => {
  const f = fixture(t, { sourceContent: "x".repeat(8 * 1024 * 1024) });
  assert.deepEqual(f.session.prepareHandoff(f.input), { ok: false, source: "job", code: "input_invalid" });
  assert.equal(f.store.list().length, 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("a failed source publication keeps the committed job for exact retry", (t) => {
  const f = fixture(t);
  chmodSync(f.directory, 0o755);
  assert.deepEqual(f.session.prepareHandoff(f.input), { ok: false, source: "job", code: "store_unsafe" });
  assert.equal(f.store.list().length, 1);
  const original = f.store.list()[0];
  assert.deepEqual(readdirSync(f.directory), []);
  // Explicit test-owner restoration, never a repair performed by the service.
  chmodSync(f.directory, 0o700);
  const handoff = value(f.session.prepareHandoff(f.input));
  assert.equal(handoff.job.jobId, original!.jobId);
  assert.equal(handoff.job.recordDigest, original!.recordDigest);
});

test("wrong job keys cannot retrieve otherwise valid source bytes", (t) => {
  const f = fixture(t);
  const first = value(f.session.prepareHandoff(f.input));
  assert.deepEqual(f.session.readHandoff({ ...key(first.job), jobId: `previewjob_${"f".repeat(64)}` }),
    { ok: false, source: "job", code: "job_conflict" });
  assert.deepEqual(f.session.readHandoff({ ...key(first.job), runId: "different" }),
    { ok: false, source: "job", code: "job_missing" });
  assert.deepEqual(f.session.readHandoff({ ...key(first.job), path: f.directory }),
    { ok: false, source: "job", code: "input_invalid" });
});

for (const mutation of ["review", "rollback"] as const) {
  test(`${mutation} during source read prevents a stale handoff`, (t) => {
    let change = false;
    const f = fixture(t, { afterRead: () => {
      if (!change) return;
      if (mutation === "rollback") f.state.wall -= 1;
      else value(f.session.recordReviewedOutput(selected, f.sourceFixture.context.reviewedOutput, f.state.wall));
    } });
    const first = value(f.session.prepareHandoff(f.input));
    const selected = key(first.job);
    f.state.wall = f.sourceFixture.context.previewCompletedAt;
    change = true;
    assert.deepEqual(f.session.readHandoff(selected), { ok: false, source: "job",
      code: mutation === "rollback" ? "clock_rollback" : "job_conflict" });
  });
}

test("handoff bytes and canonical plan are accepted by the actual credential-free runner input loader", (t) => {
  const f = fixture(t);
  f.input.manifestJson = canonicalJson({ name: "Inngest migration", provider: "inngest",
    transformSet: "inngest-v3-to-v4", package: { name: "inngest", from: "3", to: "4" }, peerFloors: [],
    runtime: { node: { minimumMajor: 20, profile: "node22-bookworm-slim-2026-07", packageJson: "package.json", dockerfile: "Dockerfile" } },
    deployment: { kind: "long-running" } });
  const handoff = value(f.session.prepareHandoff(f.input));
  const transportRoot = join(dirname(f.config.directory), "runner-input-fixture");
  mkdirSync(transportRoot, { mode: 0o700 });
  const planPath = join(transportRoot, "plan.json");
  const sourcePath = join(transportRoot, "source.bundle");
  writeFileSync(planPath, handoff.job.plan.canonicalJson, { mode: 0o600 });
  writeFileSync(sourcePath, handoff.sourceBundle, { mode: 0o600 });
  const inputs = loadRunnerInputs(planPath, sourcePath, f.state.wall);
  assert.equal(inputs.plan.digest, handoff.job.plan.digest);
  assert.equal(inputs.source.digest, handoff.job.source.sourceArchiveDigest);
  assert.equal(inputs.source.header.base.treeSha, f.input.base.treeSha);
  assert.equal(inputs.manifest.transformSet, "inngest-v3-to-v4");
  assert.equal(inputs.source.entries[0]!.content.toString(), "export const fixture = 1;\n");
});
