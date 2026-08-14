import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256, validateHostProfile } from "./lib.mjs";

export const RUNTIME_MANIFEST_KIND = "api_migrator_linux_l7_runtime_manifest";
export const RUNTIME_MANIFEST_AUTHORIZATION_STATUS = "non_authorizing_runtime_manifest_only";
export const LIFECYCLE_RUNTIME_MANIFEST_KIND = RUNTIME_MANIFEST_KIND;
export const LIFECYCLE_RUNTIME_MANIFEST_AUTHORIZATION_STATUS = RUNTIME_MANIFEST_AUTHORIZATION_STATUS;

export const LIFECYCLE_RUNTIME_MANIFEST_LAYOUT = deepFreeze([
  { role: "lifecycle_orchestrator", relativePath: "deployment/run-gateway-lifecycle.mjs" },
  { role: "lifecycle_observer", relativePath: "deployment/observe-gateway-lifecycle.mjs" },
  { role: "lifecycle_preflight", relativePath: "deployment/lifecycle-preflight.mjs" },
  { role: "runtime_manifest_module", relativePath: "deployment/runtime-manifest.mjs" },
  { role: "lifecycle_drill", relativePath: "deployment/lifecycle-drill.mjs" },
  { role: "deployment_lib", relativePath: "deployment/lib.mjs" },
  { role: "gateway_probe", relativePath: "gateway/gateway-probe.mjs" },
  { role: "gateway_contract", relativePath: "gateway/gateway-contract.mjs" },
  { role: "nft_template", relativePath: "gateway/templates/forced-gateway-egress.nft.in" },
  { role: "cleanup", relativePath: "deployment/cleanup-runner.sh" },
  { role: "production_wrapper", relativePath: "run-credential-free-preview.sh" },
  { role: "production_observer", relativePath: "deployment/observe-runner.mjs" },
  { role: "production_runner_systemd_template", relativePath: "deployment/systemd/api-migrator-runner.service.in" },
  { role: "production_observer_systemd_template", relativePath: "deployment/systemd/api-migrator-runner-observer.service.in" },
  { role: "lifecycle_drill_systemd_template", relativePath: "deployment/systemd/api-migrator-lifecycle-drill.service.in" },
  { role: "lifecycle_drill_observer_systemd_template", relativePath: "deployment/systemd/api-migrator-lifecycle-drill-observer.service.in" },
]);

export const RUNTIME_MANIFEST_ROLES = Object.freeze(
  LIFECYCLE_RUNTIME_MANIFEST_LAYOUT.map(({ role }) => role)
);

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/**
 * Validate the fixed, non-authorizing transitive runtime closure. System
 * executables are intentionally absent: their absolute paths and digests stay
 * independently bound by the host profile.
 */
export function validateRuntimeManifest(value) {
  const root = record(value, "lifecycle runtime manifest");
  exactKeys(root, [
    "schemaVersion", "kind", "runtimeRootPath", "closurePolicy", "artifacts",
    "activationBlocked", "externalSigningEligible", "authorizationStatus",
  ], "lifecycle runtime manifest");
  if (
    root.schemaVersion !== 1 ||
    root.kind !== RUNTIME_MANIFEST_KIND ||
    root.closurePolicy !== "exact_root_sealed_transitive_closure" ||
    root.activationBlocked !== true ||
    root.externalSigningEligible !== false ||
    root.authorizationStatus !== RUNTIME_MANIFEST_AUTHORIZATION_STATUS
  ) {
    throw new Error("lifecycle runtime manifest is not the fixed non-authorizing profile");
  }
  const runtimeRootPath = canonicalAbsolutePath(root.runtimeRootPath, "lifecycle runtime root");
  if (runtimeRootPath === "/" || runtimeRootPath.split("/").filter(Boolean).length < 3) {
    throw new Error("lifecycle runtime root is too broad");
  }
  if (!Array.isArray(root.artifacts) || root.artifacts.length !== LIFECYCLE_RUNTIME_MANIFEST_LAYOUT.length) {
    throw new Error("lifecycle runtime manifest does not contain the exact fixed role closure");
  }

  const artifacts = root.artifacts.map((value, index) => {
    const expected = LIFECYCLE_RUNTIME_MANIFEST_LAYOUT[index];
    const artifact = record(value, `lifecycle runtime artifact ${index}`);
    exactKeys(artifact, ["role", "path", "digest"], `lifecycle runtime artifact ${index}`);
    if (artifact.role !== expected.role) {
      throw new Error("lifecycle runtime manifest roles are missing, duplicated, reordered, or substituted");
    }
    const path = canonicalAbsolutePath(artifact.path, `${artifact.role} path`);
    const expectedPath = join(runtimeRootPath, expected.relativePath);
    if (path !== expectedPath || !isStrictChild(runtimeRootPath, path)) {
      throw new Error(`lifecycle runtime artifact path is substituted for role ${artifact.role}`);
    }
    if (!DIGEST.test(artifact.digest)) {
      throw new Error(`lifecycle runtime artifact digest is invalid for role ${artifact.role}`);
    }
    return { role: artifact.role, path, digest: artifact.digest };
  });

  for (const [name, values] of [
    ["roles", artifacts.map(({ role }) => role)],
    ["paths", artifacts.map(({ path }) => path)],
    ["digests", artifacts.map(({ digest }) => digest)],
  ]) {
    if (new Set(values).size !== artifacts.length) {
      throw new Error(`lifecycle runtime manifest contains duplicate or substituted ${name}`);
    }
  }

  return deepFreeze({
    schemaVersion: 1,
    kind: RUNTIME_MANIFEST_KIND,
    runtimeRootPath,
    closurePolicy: "exact_root_sealed_transitive_closure",
    artifacts,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: RUNTIME_MANIFEST_AUTHORIZATION_STATUS,
  });
}

export const validateLifecycleRuntimeManifest = validateRuntimeManifest;

/** Parse exact canonical bytes and optionally cross-bind the host profile. */
export function parseCanonicalLifecycleRuntimeManifest(text, profileOrOptions = undefined) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") === 0 ||
    Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES
  ) {
    throw new Error("lifecycle runtime manifest bytes are missing or excessive");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("lifecycle runtime manifest is not JSON");
  }
  const manifest = validateRuntimeManifest(value);
  const canonical = canonicalJson(manifest);
  if (canonical !== text) throw new Error("lifecycle runtime manifest is not exact canonical JSON");
  const digest = sha256(Buffer.from(canonical, "utf8"));
  const expected = expectedBindings(profileOrOptions);
  if (expected.digest !== undefined && digest !== expected.digest) {
    throw new Error("lifecycle runtime manifest digest does not match the host binding");
  }
  if (expected.runtimeRootPath !== undefined && manifest.runtimeRootPath !== expected.runtimeRootPath) {
    throw new Error("lifecycle runtime manifest substitutes the expected runtime root");
  }
  if (expected.profile !== undefined) crossBindHostProfile(manifest, digest, expected.profile);
  return deepFreeze({ manifest, canonicalJson: canonical, digest });
}

export const parseCanonicalRuntimeManifest = parseCanonicalLifecycleRuntimeManifest;

/** Return one fixed role binding without accepting aliases or fallback roles. */
export function runtimeManifestArtifact(manifestValue, role) {
  const manifest = validateRuntimeManifest(manifestValue);
  if (!RUNTIME_MANIFEST_ROLES.includes(role)) throw new Error("lifecycle runtime manifest role is unsupported");
  const artifact = manifest.artifacts.find((entry) => entry.role === role);
  if (!artifact) throw new Error("lifecycle runtime manifest role is missing");
  return deepFreeze(structuredClone(artifact));
}

/**
 * Verify the complete deployed closure. The manifest file is verified but is
 * deliberately not an artifact entry, avoiding a self-digest cycle.
 */
export function verifyLifecycleRuntimeManifestFiles(manifestValue, options = {}) {
  const manifest = validateRuntimeManifest(manifestValue?.manifest ?? manifestValue);
  const filesystem = options.fs ?? { lstatSync, readFileSync, readdirSync, realpathSync };
  const requireRootOwnership = options.requireRootOwnership ?? true;
  if (typeof requireRootOwnership !== "boolean") throw new Error("root ownership policy must be boolean");
  const ownershipCheck = options.ownershipCheck ?? ((path, info) => info.uid === 0 && info.gid === 0);
  if (typeof ownershipCheck !== "function") throw new Error("root ownership check must be callable");
  const manifestPath = canonicalAbsolutePath(
    options.manifestPath ?? join(manifest.runtimeRootPath, "deployment/runtime-manifest.json"),
    "lifecycle runtime manifest file path"
  );
  const expectedManifestPath = join(manifest.runtimeRootPath, "deployment/runtime-manifest.json");
  if (manifestPath !== expectedManifestPath || !isStrictChild(manifest.runtimeRootPath, manifestPath)) {
    throw new Error("lifecycle runtime manifest file escapes or substitutes the exact runtime root");
  }
  if (manifest.artifacts.some(({ path }) => path === manifestPath)) {
    throw new Error("lifecycle runtime manifest must not self-include in its artifact closure");
  }

  const expectedFiles = new Set([...manifest.artifacts.map(({ path }) => path), manifestPath]);
  const expectedDirectories = new Set([manifest.runtimeRootPath]);
  if (requireRootOwnership) {
    let ancestor = dirname(manifest.runtimeRootPath);
    while (true) {
      const info = safeLstat(filesystem, ancestor);
      if (!info.isDirectory() || info.isSymbolicLink() || filesystem.realpathSync(ancestor) !== ancestor ||
          (info.mode & 0o022) !== 0 || ownershipCheck(ancestor, info, "ancestor") !== true) {
        throw new Error(`lifecycle runtime closure has an unsealed ancestor: ${ancestor}`);
      }
      if (ancestor === "/") break;
      ancestor = dirname(ancestor);
    }
  }
  for (const path of expectedFiles) {
    let directory = dirname(path);
    while (isWithinOrEqual(manifest.runtimeRootPath, directory)) {
      expectedDirectories.add(directory);
      if (directory === manifest.runtimeRootPath) break;
      directory = dirname(directory);
    }
  }

  const observedFiles = new Set();
  const observedDirectories = new Set();
  const stack = [manifest.runtimeRootPath];
  while (stack.length > 0) {
    const path = stack.pop();
    const info = safeLstat(filesystem, path);
    if (!info.isDirectory() || info.isSymbolicLink() || filesystem.realpathSync(path) !== path) {
      throw new Error(`lifecycle runtime closure contains a non-canonical directory: ${path}`);
    }
    assertSealedMetadata(path, info, "directory", requireRootOwnership, ownershipCheck);
    observedDirectories.add(path);
    const children = filesystem.readdirSync(path, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of children) {
      const childPath = join(path, child.name);
      const childInfo = safeLstat(filesystem, childPath);
      if (childInfo.isSymbolicLink() || child.isSymbolicLink()) {
        throw new Error(`lifecycle runtime closure contains a symlink: ${childPath}`);
      }
      if (childInfo.isDirectory() && child.isDirectory()) {
        stack.push(childPath);
        continue;
      }
      if (!childInfo.isFile() || !child.isFile() || childInfo.nlink !== 1 || filesystem.realpathSync(childPath) !== childPath) {
        throw new Error(`lifecycle runtime closure contains a non-regular, hard-linked, or non-canonical file: ${childPath}`);
      }
      if (childInfo.size > MAX_ARTIFACT_BYTES) {
        throw new Error(`lifecycle runtime artifact is too large: ${childPath}`);
      }
      assertSealedMetadata(childPath, childInfo, "file", requireRootOwnership, ownershipCheck);
      observedFiles.add(childPath);
    }
  }

  assertExactSet(observedFiles, expectedFiles, "files");
  assertExactSet(observedDirectories, expectedDirectories, "directories");

  const expectedManifestBytes = canonicalJson(manifest);
  const observedManifestBytes = filesystem.readFileSync(manifestPath, "utf8");
  if (observedManifestBytes !== expectedManifestBytes) {
    throw new Error("deployed lifecycle runtime manifest bytes are non-canonical or drifted");
  }
  const manifestDigest = sha256(Buffer.from(observedManifestBytes, "utf8"));
  if (options.expectedManifestDigest !== undefined && manifestDigest !== options.expectedManifestDigest) {
    throw new Error("deployed lifecycle runtime manifest digest drifted from the host binding");
  }

  for (const artifact of manifest.artifacts) {
    const bytes = filesystem.readFileSync(artifact.path);
    if (sha256Bytes(bytes) !== artifact.digest) {
      throw new Error(`deployed lifecycle runtime artifact digest drifted for role ${artifact.role}`);
    }
  }
  const closureDigest = sha256(Buffer.from(canonicalJson(manifest.artifacts), "utf8"));
  return deepFreeze({
    verified: true,
    runtimeRootPath: manifest.runtimeRootPath,
    artifactCount: manifest.artifacts.length,
    manifestDigest,
    closureDigest,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: RUNTIME_MANIFEST_AUTHORIZATION_STATUS,
  });
}

export const verifyRuntimeManifestFilesystem = verifyLifecycleRuntimeManifestFiles;

function expectedBindings(profileOrOptions) {
  if (profileOrOptions === undefined) return {};
  if (
    profileOrOptions !== null &&
    typeof profileOrOptions === "object" &&
    profileOrOptions.schemaVersion === 2 &&
    profileOrOptions.profile === "api-migrator-runner-host-v2"
  ) {
    const profile = validateHostProfile(profileOrOptions);
    return { digest: profile.artifacts.lifecycleRuntimeManifestDigest, profile };
  }
  const options = record(profileOrOptions, "lifecycle runtime manifest expected bindings");
  exactKeys(options, ["expectedDigest", "expectedRuntimeRootPath"], "lifecycle runtime manifest expected bindings", true);
  if (options.expectedDigest !== undefined && !DIGEST.test(options.expectedDigest)) {
    throw new Error("expected lifecycle runtime manifest digest is invalid");
  }
  const runtimeRootPath = options.expectedRuntimeRootPath === undefined
    ? undefined
    : canonicalAbsolutePath(options.expectedRuntimeRootPath, "expected lifecycle runtime root");
  return { digest: options.expectedDigest, runtimeRootPath };
}

function crossBindHostProfile(manifest, manifestDigest, profile) {
  const manifestPath = join(manifest.runtimeRootPath, "deployment/runtime-manifest.json");
  if (
    profile.artifacts.lifecycleRuntimeManifestPath !== manifestPath ||
    profile.artifacts.lifecycleRuntimeManifestDigest !== manifestDigest
  ) {
    throw new Error("lifecycle runtime manifest path or digest substitutes the host binding");
  }
  const bindings = [
    ["production_wrapper", "wrapperPath", "wrapperDigest"],
    ["cleanup", "cleanupPath", "cleanupDigest"],
    ["production_observer", "observerPath", "observerDigest"],
    ["gateway_probe", "gatewayProbePath", "gatewayProbeDigest"],
    ["lifecycle_orchestrator", "lifecycleOrchestratorPath", "lifecycleOrchestratorDigest"],
    ["lifecycle_observer", "lifecycleObserverPath", "lifecycleObserverDigest"],
  ];
  for (const [role, pathKey, digestKey] of bindings) {
    const artifact = runtimeManifestArtifact(manifest, role);
    if (artifact.path !== profile.artifacts[pathKey] || artifact.digest !== profile.artifacts[digestKey]) {
      throw new Error(`lifecycle runtime manifest substitutes host artifact binding ${role}`);
    }
  }
}

function safeLstat(filesystem, path) {
  try {
    return filesystem.lstatSync(path);
  } catch {
    throw new Error(`lifecycle runtime closure entry is missing or unreadable: ${path}`);
  }
}

function assertSealedMetadata(path, info, kind, requireRootOwnership, ownershipCheck) {
  if ((info.mode & 0o022) !== 0) {
    throw new Error(`lifecycle runtime ${kind} is group- or world-writable: ${path}`);
  }
  if (requireRootOwnership && ownershipCheck(path, info, kind) !== true) {
    throw new Error(`lifecycle runtime ${kind} is not root-owned: ${path}`);
  }
}

function assertExactSet(observed, expected, label) {
  if (observed.size !== expected.size || [...observed].some((path) => !expected.has(path))) {
    throw new Error(`lifecycle runtime closure contains missing or unexpected ${label}`);
  }
}

function canonicalAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length > 1_024 ||
    !ABSOLUTE_PATH.test(value) ||
    resolve(value) !== value ||
    (value.length > 1 && value.endsWith(sep))
  ) {
    throw new Error(`${label} must be a canonical supported absolute path`);
  }
  return value;
}

function isWithinOrEqual(root, path) {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !child.includes("\0"));
}

function isStrictChild(root, path) {
  return path !== root && isWithinOrEqual(root, path);
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label, allowMissing = false) {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.some((key) => !expected.has(key)) ||
    (!allowMissing && (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))))
  ) {
    throw new Error(`${label} has missing or unexpected fields`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
