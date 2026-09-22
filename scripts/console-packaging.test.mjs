import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Inspect actual production artifacts, not source/config text. Run after
// build:console; missing artifacts must fail rather than silently skip.
const workspace = fileURLToPath(new URL("..", import.meta.url));
const server = resolve(workspace, "packages/console/.next/server");
const runsTrace = "app/api/campaigns/[id]/runs/route.js.nft.json";

test("production route traces contain only reviewed runtime files and metadata", () => {
  const manifests = readdirSync(server, { recursive: true })
    .filter((file) => file.endsWith(".nft.json"));
  assert.ok(manifests.includes(runsTrace), "the real campaign runs route must be built");
  for (const name of manifests) {
    const manifest = resolve(server, name);
    const { files } = JSON.parse(readFileSync(manifest, "utf8"));
    assert.ok(Array.isArray(files) && files.length > 0, `${name}: nonempty trace`);
    for (const entry of files) {
      const path = resolve(dirname(manifest), entry);
      const local = relative(workspace, path).split(sep).join("/");
      assert.ok(existsSync(path), `${name}: missing runtime dependency ${local}`);
      // Vendor sources may be runtime dependencies. Our workspace contributes
      // only built modules and reviewed metadata, never source, tests, scripts,
      // credentials, or databases (including journal/WAL sidecars).
      const dependency = local.startsWith("node_modules/") || local.startsWith("packages/console/.next/node_modules/");
      const generated = local.startsWith("packages/console/.next/server/");
      const compiled = /^packages\/[^/]+\/dist\//.test(local);
      // The engine's named tsconfig.json probe is still traced. This single
      // public config is harmless; do not allow arbitrary build/config files.
      const metadata = local === "package.json" || /^packages\/[^/]+\/package\.json$/.test(local)
        || local === "packages/console/tsconfig.json" || local === "packages/console/.next/package.json";
      assert.ok(dependency || generated || compiled || metadata,
        `${name}: non-runtime workspace file ${local}`);
    }
  }
});

test("the emitted production runs route still blocks owner challenge and publication", () => {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-packaged-route-"));
  try {
    // A child owns every SQLite handle and exits before cleanup. Only synthetic
    // test configuration crosses this boundary, never the operator's .env.
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { closeDb, createCampaign, createProvider, init, listRunsForCampaign } from '@api-migrator/db';
      const require = createRequire(import.meta.url);
      const { NextRequest } = require('next/server');
      init();
      const provider = createProvider({ name: 'Packaging test', slug: 'packaging-test' });
      const campaign = createCampaign({ providerId: provider.id, name: 'Closed packaging route',
        status: 'active', manifest: { name: 'Packaging test', provider: 'inngest',
          transformSet: 'inngest-v3-to-v4', package: { name: 'inngest', from: '^3.0.0', to: '^4.0.0' } } });
      closeDb();
      const { routeModule } = require(process.argv[1]);
      assert.equal(typeof routeModule.userland.POST, 'function');
      for (const action of ['prepare_owner_challenge', 'prepare_publish', 'publish']) {
        const response = await routeModule.userland.POST(new NextRequest('http://127.0.0.1/api/campaigns/' + campaign.id + '/runs', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action })
        }), { params: Promise.resolve({ id: campaign.id }) });
        assert.equal(response.status, 503, action);
        assert.match((await response.json()).error, /verified runner-capability provider/);
        assert.deepEqual(listRunsForCampaign(campaign.id), []);
      }
      closeDb();
    `, resolve(server, "app/api/campaigns/[id]/runs/route.js")], {
      cwd: workspace,
      env: { PATH: process.env.PATH, NODE_ENV: "production", API_MIGRATOR_DB_PATH: join(directory, "test.db") },
      encoding: "utf8", timeout: 30_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("campaign runtime trace retains its native SQLite dependency", () => {
  const manifest = resolve(server, runsTrace);
  const { files } = JSON.parse(readFileSync(manifest, "utf8"));
  // Turbopack traces its external-package link, not every file behind it.
  // Load that traced runtime and exercise the native binding itself.
  const entry = files.find((file) => /\/\.next\/node_modules\/better-sqlite3-[^/]+$/.test(resolve(dirname(manifest), file)));
  assert.ok(entry, "the SQLite external must be in the actual route trace");
  const Database = createRequire(import.meta.url)(resolve(dirname(manifest), entry));
  const db = new Database(":memory:");
  try {
    assert.deepEqual(db.prepare("SELECT 1 AS alive").get(), { alive: 1 });
  } finally {
    db.close();
  }
});
