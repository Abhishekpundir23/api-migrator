import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { runnerEvidenceFixture } from "./helpers/runner-evidence-fixture.js";
import { createJobFixture } from "./helpers/runner-job-fixture.js";
import { createRunnerJobServiceForTest } from "../src/runner-job-record.js";
import * as rootApi from "../src/index.js";
import * as consoleInternal from "../src/console-internal.js";

test("the package root exposes no write-capable repository or campaign executor", () => {
  assert.equal("migrateRepo" in rootApi, false);
  assert.equal("runCampaign" in rootApi, false);
  assert.equal("prepareCampaignOwnerChallenge" in rootApi, false);
  assert.equal("verifyCampaignOwnerAuthorizationEnvelope" in rootApi, false);
  assert.equal("signOwnerAuthorizationChallengeFile" in rootApi, false);
  assert.equal("runPublicationRunner" in rootApi, false);
  assert.equal("executePublicationRunner" in rootApi, false);
  assert.equal("signPublicationRunnerAttestation" in rootApi, false);
  assert.equal(typeof rootApi.runCampaignJobs, "function");
  assert.equal(typeof rootApi.parseOwnerAuthorizationChallenge, "function");
  assert.equal(typeof rootApi.createPublicationRunnerPlan, "function");
  assert.equal(typeof rootApi.validatePublicationRunnerPlan, "function");
  assert.equal(typeof rootApi.assertPublicationRunnerPlanCurrent, "function");
  assert.equal(typeof rootApi.verifyPublicationRunnerAttestation, "function");
  assert.equal(typeof consoleInternal.runCampaign, "function");
  assert.equal(typeof consoleInternal.prepareCampaignOwnerChallenge, "function");
  assert.equal(typeof consoleInternal.verifyCampaignOwnerAuthorizationEnvelope, "function");
});

test("built job subpaths expose only their documented APIs and cannot leak test or custody access", async () => {
  assert.deepEqual(Object.keys(await import("@api-migrator/app/runner-job-record-internal")), ["createRunnerJobService"]);
  assert.deepEqual(Object.keys(await import("@api-migrator/db/runner-job-store-internal")), ["JobStoreError", "initializeJobStore", "openJobStore"]);
  const hidden = ["createRunnerJobService", "createRunnerJobServiceForTest", "initializeJobStore", "openJobStore",
    "createJobStoreTestAccess", "setJobStoreTransactionTestHook", "prepareRunnerJob", "recordRunnerJobReview", "acquireRunnerJobEvidence"];
  for (const name of ["@api-migrator/app", "@api-migrator/app/console-internal", "@api-migrator/app/preview-evidence", "@api-migrator/app/runner-internal", "@api-migrator/db", "@api-migrator/runner"]) {
    const api = await import(name);
    for (const key of hidden) assert.equal(key in api, false, `${name}: ${key}`);
  }
  for (const [pkg, modules] of [
    ["app", ["runner-job-record", "runner-job-record-contract", "runner-job-producer", "runner-job-service-core", "runner-job-evidence", "test/helpers/runner-job-process"]],
    ["db", ["runner-job-store-sqlite", "runner-job-store-path", "runner-job-store-contract", "test/runner-job-store-process"]],
  ] as const) for (const module of modules) {
    for (const path of [module, `src/${module}.js`, `dist/${module}.js`]) {
      await assert.rejects(import(`@api-migrator/${pkg}/${path}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    }
  }
});

test("built job factory does no filesystem or network I/O until explicit open", () => {
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import promises from 'node:fs/promises';
    import http from 'node:http'; import https from 'node:https';
    import net from 'node:net'; import tls from 'node:tls';
    import { mock } from 'node:test';
    import { syncBuiltinESMExports } from 'node:module';
    const directory = '/missing-runner-job-store-' + process.pid;
    assert.equal(fs.existsSync(directory), false);
    let io = 0;
    const trap = () => { io++; throw Error('unexpected application I/O'); };
    for (const [api, method] of [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [net, 'connect'], [net, 'createConnection'], [tls, 'connect'], [globalThis, 'fetch']]) mock.method(api, method, trap);
    syncBuiltinESMExports();
    const { createRunnerJobService: create } = await import('@api-migrator/app/runner-job-record-internal');
    assert.equal(io, 0);
    assert.equal(fs.existsSync(directory), false);
    const traps = [];
    // Module-loader filesystem reads must remain real until import completes.
    for (const method of ['open', 'stat', 'lstat', 'realpath', 'readFile', 'mkdir', 'writeFile']) traps.push(mock.method(promises, method, trap));
    for (const method of ['open', 'openSync', 'statSync', 'lstatSync', 'realpathSync', 'readFileSync', 'readdirSync', 'mkdirSync', 'writeFileSync', 'createReadStream', 'createWriteStream']) traps.push(mock.method(fs, method, trap));
    syncBuiltinESMExports();
    const config = { directory, expectedStoreId: '12345678-1234-4234-8234-123456789abc', evidence: null };
    const policy = { migrationWorkspaceRoots: ['/missing-runner-job-workspace'] };
    assert.deepEqual(create({ ...config, clock: {} }, policy), { ok: false, source: 'job', code: 'input_invalid' });
    assert.deepEqual(create(config, policy, {}), { ok: false, source: 'job', code: 'input_invalid' });
    const factory = create(config, policy);
    assert.equal(factory.ok, true);
    assert.equal(io, 0);
    for (const item of traps) item.mock.restore();
    syncBuiltinESMExports();
    assert.equal(fs.existsSync(directory), false);
    assert.deepEqual(factory.value.open(), { ok: false, source: 'job', code: 'store_unavailable' });
    assert.equal(fs.existsSync(directory), false);
    assert.equal(io, 0);
    mock.restoreAll(); syncBuiltinESMExports();
  `], { stdio: "pipe", encoding: "utf8" });
});

test("null-evidence factory prepares and reviews real validated rows but cannot acquire authority", (t) => {
  const f = createJobFixture(); t.after(() => f.close());
  const factory = createRunnerJobServiceForTest({ directory: f.directory, expectedStoreId: f.storeId, evidence: null },
    { migrationWorkspaceRoots: f.policy.migrationWorkspaceRoots }, { clock: f.clock, client: null, openStore: f.access.open });
  assert.equal(factory.ok, true); if (!factory.ok) return;
  const opened = factory.value.open(); assert.equal(opened.ok, true); if (!opened.ok) return;
  const session = opened.value; t.after(() => session.close());
  const result = session.prepare(f.input); assert.equal(result.ok, true); if (!result.ok) return;
  const key = { campaignId: result.value.campaignId, runId: result.value.runId, jobId: result.value.jobId };
  f.state.wall = f.sourceFixture.context.previewCompletedAt;
  const reviewed = session.recordReviewedOutput(key, f.sourceFixture.context.reviewedOutput, f.state.wall);
  assert.equal(reviewed.ok, true);
  return session.acquireEvidence(key).then((acquired) => {
    assert.deepEqual(acquired, { ok: false, source: "evidence", code: "configuration_invalid" });
    assert.deepEqual(session.inspect(key), reviewed);
  });
});

test("built evidence subpath exposes only the production factory and no privileged implementation paths", async () => {
  const evidence = await import("@api-migrator/app/runner-evidence-internal");
  assert.deepEqual(Object.keys(evidence), ["createRunnerEvidenceClient"]);
  for (const name of ["@api-migrator/app", "@api-migrator/app/console-internal", "@api-migrator/app/preview-evidence", "@api-migrator/app/runner-internal"]) {
    const api = await import(name);
    for (const hidden of ["createRunnerEvidenceClient", "createRunnerEvidenceClientWithDependencies", "readRunnerKeyRegistry", "createRunnerEvidenceTransport", "runnerEvidenceFixture"]) {
      assert.equal(hidden in api, false, `${name}: ${hidden}`);
    }
  }
  for (const module of ["runner-evidence", "runner-evidence-core", "runner-evidence-contract", "runner-evidence-deadline", "runner-key-registry", "runner-evidence-transport", "test/helpers/runner-evidence-fixture", "test/helpers/runner-evidence-io-fixture"]) {
    for (const path of [module, `src/${module}.js`, `dist/${module}.js`]) {
      await assert.rejects(import(`@api-migrator/app/${path}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    }
  }
});

test("built production factory rejects overrides before I/O and missing protected paths fail only on acquisition", () => {
  const fixture = runnerEvidenceFixture(Date.now());
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import promises from 'node:fs/promises';
      import https from 'node:https';
      import { mock } from 'node:test';
      import { syncBuiltinESMExports } from 'node:module';
      let io = 0;
      const traps = [];
      for (const method of ['lstat', 'realpath', 'open']) traps.push(mock.method(promises, method, async () => { io++; throw Error('unexpected I/O'); }));
      const network = mock.method(https, 'request', () => { io++; throw Error('unexpected network'); });
      syncBuiltinESMExports();
      try {
        const { createRunnerEvidenceClient: create } = await import('@api-migrator/app/runner-evidence-internal');
        // Keep module-loader filesystem reads real until the built import completes.
        for (const method of ['statSync', 'lstatSync', 'realpathSync', 'openSync', 'readFileSync']) traps.push(mock.method(fs, method, () => { io++; throw Error('unexpected I/O'); }));
        syncBuiltinESMExports();
        const config = { serviceOrigin: 'https://evidence.example.invalid', serviceAddresses: ['93.184.216.34'], serviceTlsSpkiDigest: 'sha256:' + 'a'.repeat(64), registryDirectory: '/missing-evidence-registry-' + process.pid };
        const policy = { migrationWorkspaceRoots: ['/missing-evidence-workspace-' + process.pid] };
        const result = create(config, policy);
        assert.equal(result.ok, true);
        assert.equal(io, 0);
        for (const args of [
          [undefined, undefined], [{}, policy], [config, {}],
          [{ ...config, serviceAddresses: ['127.0.0.1'] }, policy],
          ...['clock', 'ca', 'port', 'fetchEnvelope', 'readKey'].flatMap(key => [
            [{ ...config, [key]: true }, policy], [config, { ...policy, [key]: true }],
          ]),
          ...[undefined, null, {}, { clock: () => 0 }, { ca: 'fake', port: 8443 }, () => {}].map(extra => [config, policy, extra]),
        ]) {
          assert.deepEqual(Reflect.apply(create, undefined, args), { ok: false, code: 'configuration_invalid' });
          assert.equal(io, 0);
        }
        for (const trap of traps) trap.mock.restore();
        syncBuiltinESMExports();
        assert.deepEqual(await result.client.acquireInitial(JSON.parse(process.argv[1])), { ok: false, code: 'trust_unavailable' });
        assert.equal(io, 0);
      } finally {
        for (const trap of traps) trap.mock.restore();
        network.mock.restore();
        syncBuiltinESMExports();
      }
    `, JSON.stringify(fixture.context)], { cwd: new URL("../../..", import.meta.url), encoding: "utf8" });
  } finally {
    fixture.close();
  }
});
