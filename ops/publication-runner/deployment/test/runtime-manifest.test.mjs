import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "../lib.mjs";
import {
  LIFECYCLE_RUNTIME_MANIFEST_LAYOUT,
  RUNTIME_MANIFEST_AUTHORIZATION_STATUS,
  RUNTIME_MANIFEST_ROLES,
  parseCanonicalLifecycleRuntimeManifest,
  runtimeManifestArtifact,
  validateRuntimeManifest,
  verifyLifecycleRuntimeManifestFiles,
} from "../runtime-manifest.mjs";

const DEPLOYMENT_DIR = new URL("../", import.meta.url);

function digest(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function checkedInFixture() {
  const profile = JSON.parse(readFileSync(new URL("host-profile.example.json", DEPLOYMENT_DIR), "utf8"));
  const value = JSON.parse(readFileSync(new URL("runtime-manifest.example.json", DEPLOYMENT_DIR), "utf8"));
  return { profile, value, text: canonicalJson(value) };
}

function filesystemFixture() {
  const runtimeRootPath = realpathSync(mkdtempSync(join(tmpdir(), "api-migrator-runtime-manifest.")));
  chmodSync(runtimeRootPath, 0o700);
  const artifacts = LIFECYCLE_RUNTIME_MANIFEST_LAYOUT.map(({ role, relativePath }) => {
    const path = join(runtimeRootPath, relativePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(`fixture:${role}\n`, "utf8");
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
    return { role, path, digest: sha256(bytes) };
  });
  const manifest = validateRuntimeManifest({
    schemaVersion: 1,
    kind: "api_migrator_linux_l7_runtime_manifest",
    runtimeRootPath,
    closurePolicy: "exact_root_sealed_transitive_closure",
    artifacts,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: RUNTIME_MANIFEST_AUTHORIZATION_STATUS,
  });
  const manifestPath = join(runtimeRootPath, "deployment/runtime-manifest.json");
  writeFileSync(manifestPath, canonicalJson(manifest), { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  return {
    runtimeRootPath,
    artifacts,
    manifest,
    manifestPath,
    cleanup: () => rmSync(runtimeRootPath, { recursive: true, force: true }),
  };
}

test("parses the exact fixed runtime closure and cross-binds every host artifact", () => {
  const { profile, value, text } = checkedInFixture();
  const parsed = parseCanonicalLifecycleRuntimeManifest(text, profile);
  assert.equal(parsed.digest, profile.artifacts.lifecycleRuntimeManifestDigest);
  assert.equal(parsed.manifest.artifacts.length, 16);
  assert.deepEqual(parsed.manifest.artifacts.map(({ role }) => role), RUNTIME_MANIFEST_ROLES);
  assert.deepEqual(runtimeManifestArtifact(parsed.manifest, "gateway_probe"), {
    role: "gateway_probe",
    path: profile.artifacts.gatewayProbePath,
    digest: profile.artifacts.gatewayProbeDigest,
  });
  assert.equal(parsed.manifest.activationBlocked, true);
  assert.equal(parsed.manifest.externalSigningEligible, false);
  assert.equal(parsed.manifest.authorizationStatus, RUNTIME_MANIFEST_AUTHORIZATION_STATUS);
  assert.throws(() => parseCanonicalLifecycleRuntimeManifest(`${text}\n`, profile), /exact canonical JSON/);

  const changedProfile = structuredClone(profile);
  changedProfile.artifacts.lifecycleRuntimeManifestDigest = digest("substituted-manifest");
  assert.throws(() => parseCanonicalLifecycleRuntimeManifest(text, changedProfile), /digest does not match/);
  assert.deepEqual(validateRuntimeManifest(value).artifacts.map(({ role }) => role), RUNTIME_MANIFEST_ROLES);
});

test("rejects missing, duplicated, reordered, relocated, or authorizing runtime roles", () => {
  const { value } = checkedInFixture();
  const mutations = [
    (manifest) => { manifest.artifacts.pop(); },
    (manifest) => { manifest.artifacts[1].role = manifest.artifacts[0].role; },
    (manifest) => { [manifest.artifacts[0], manifest.artifacts[1]] = [manifest.artifacts[1], manifest.artifacts[0]]; },
    (manifest) => { manifest.artifacts[1].path = manifest.artifacts[0].path; },
    (manifest) => { manifest.artifacts[1].digest = manifest.artifacts[0].digest; },
    (manifest) => { manifest.artifacts[0].path = "/usr/local/libexec/substituted.mjs"; },
    (manifest) => { manifest.runtimeRootPath = "/tmp/runtime"; },
    (manifest) => { manifest.activationBlocked = false; },
    (manifest) => { manifest.externalSigningEligible = true; },
    (manifest) => { manifest.authorizationStatus = "authorized"; },
    (manifest) => { manifest.artifacts[0].unexpected = true; },
  ];
  for (const mutate of mutations) {
    const manifest = structuredClone(value);
    mutate(manifest);
    assert.throws(() => validateRuntimeManifest(manifest));
  }
  assert.throws(() => runtimeManifestArtifact(value, "node"), /role is unsupported/);
});

test("verifies the root-sealed filesystem closure without authorizing activation", () => {
  const fx = filesystemFixture();
  try {
    const verified = verifyLifecycleRuntimeManifestFiles(fx.manifest, {
      manifestPath: fx.manifestPath,
      expectedManifestDigest: sha256(Buffer.from(canonicalJson(fx.manifest), "utf8")),
      requireRootOwnership: false,
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.artifactCount, RUNTIME_MANIFEST_ROLES.length);
    assert.match(verified.closureDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(verified.activationBlocked, true);
    assert.equal(verified.externalSigningEligible, false);
    assert.equal(verified.authorizationStatus, RUNTIME_MANIFEST_AUTHORIZATION_STATUS);
    assert.throws(() => verifyLifecycleRuntimeManifestFiles(fx.manifest, {
      manifestPath: fx.manifestPath,
      requireRootOwnership: true,
      ownershipCheck: () => false,
    }), /not root-owned|unsealed ancestor/);
  } finally {
    fx.cleanup();
  }
});

test("rejects symlinks, hardlinks, writable files, digest drift, and closure additions", () => {
  const cases = [
    (fx) => {
      unlinkSync(fx.artifacts[0].path);
      symlinkSync(fx.artifacts[1].path, fx.artifacts[0].path);
    },
    (fx) => { linkSync(fx.artifacts[0].path, join(fx.runtimeRootPath, "hardlink.mjs")); },
    (fx) => { chmodSync(fx.artifacts[0].path, 0o620); },
    (fx) => { writeFileSync(fx.artifacts[0].path, "drifted\n", { mode: 0o600 }); },
    (fx) => { writeFileSync(join(fx.runtimeRootPath, "unexpected.mjs"), "unexpected\n", { mode: 0o600 }); },
    (fx) => { writeFileSync(fx.manifestPath, `${canonicalJson(fx.manifest)}\n`, { mode: 0o600 }); },
  ];
  for (const mutate of cases) {
    const fx = filesystemFixture();
    try {
      mutate(fx);
      assert.throws(() => verifyLifecycleRuntimeManifestFiles(fx.manifest, {
        manifestPath: fx.manifestPath,
        requireRootOwnership: false,
      }));
    } finally {
      fx.cleanup();
    }
  }
});
