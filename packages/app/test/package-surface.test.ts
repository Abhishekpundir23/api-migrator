import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { runnerEvidenceFixture } from "./helpers/runner-evidence-fixture.js";
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
