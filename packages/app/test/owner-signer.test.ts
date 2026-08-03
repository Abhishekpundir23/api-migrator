import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalSha256,
  verifyOwnerAuthorizationEnvelope,
  type ExpectedOwnerAuthorizationBindings,
} from "../src/owner-authorization.js";
import { createOwnerAuthorizationChallenge } from "../src/owner-challenge.js";
import {
  signOwnerAuthorizationChallengeFile,
  type SignOwnerAuthorizationChallengeFileInput,
} from "../src/owner-signer.js";
import { runOwnerSignCli } from "../src/owner-sign-cli.js";
import { canonicalJson } from "../src/canonical-json.js";

const NOW = 2_000_000_000_000;
const AUTHORIZATION_ID = "authorization-sandbox-001";
const SIGNER_ID = "owner-signer-001";
const KEY_ID = "owner-key-v1";
const digest = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

interface Fixture {
  directory: string;
  challengePath: string;
  registryPath: string;
  privateKeyPath: string;
  outputPath: string;
  challengeDigest: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  bindings: ExpectedOwnerAuthorizationBindings;
  cleanup(): void;
}

function expectedBindings(): ExpectedOwnerAuthorizationBindings {
  return {
    pilotId: "pilot-sandbox-v1",
    approvalEvidenceDigest: digest("approval"),
    preRunAuthorizationDigest: digest("pre-run"),
    previewCompletedAt: NOW - 1_000,
    authorizationExpiresAt: NOW + 60 * 60_000,
    repository: {
      slug: "example-org/example-repo",
      id: 1_234_567,
      ownerId: 7_654_321,
    },
    github: {
      appId: 123_456,
      installationId: 654_321,
    },
    base: {
      branch: "main",
      sha: "a".repeat(40),
    },
    engine: {
      tag: "v0.1.0-pilot",
      commit: "b".repeat(40),
    },
    manifest: {
      byteLength: 1_024,
      digest: digest("manifest"),
    },
    preview: {
      preflightId: `pf_${"c".repeat(64)}`,
      artifactDigest: digest("artifact"),
      candidateBranch: "codex/api-migrator/candidate-0123456789abcdef",
      candidateTreeSha: "d".repeat(40),
      findingsDigest: canonicalSha256([]),
      resolutionsDigest: canonicalSha256([]),
      commandScopeDigest: digest("command-scope"),
      runnerAttestationDigest: digest("runner-attestation"),
      rulesetDigest: digest("ruleset"),
      requiredCiDigest: digest("required-ci"),
    },
    allowedActions: ["create_branch", "create_pull_request"],
    pullRequestNumber: null,
  };
}

function privateKeyPem(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}

function publicKeyPem(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function publicKeyFingerprint(key: KeyObject): string {
  return digest(key.export({ type: "spki", format: "der" }) as Buffer);
}

function writeOwnerFile(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-owner-signer-"));
  chmodSync(directory, 0o700);
  const challengePath = join(directory, "challenge.json");
  const registryPath = join(directory, "registry.json");
  const privateKeyPath = join(directory, "owner-key.pem");
  const outputPath = join(directory, "owner-envelope.json");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bindings = expectedBindings();
  const challenge = createOwnerAuthorizationChallenge({ bindings, blockers: [], now: NOW });
  const registry = {
    version: 1,
    keys: [{
      keyId: KEY_ID,
      signerId: SIGNER_ID,
      algorithm: "Ed25519",
      publicKeyPem: publicKeyPem(publicKey),
      fingerprint: publicKeyFingerprint(publicKey),
      repository: bindings.repository,
      validFrom: NOW - 60_000,
      validUntil: NOW + 60 * 60_000,
      revokedAt: null,
    }],
    revokedAuthorizationIds: [],
  };
  writeOwnerFile(challengePath, challenge.challengeJson);
  writeOwnerFile(registryPath, canonicalJson(registry));
  writeOwnerFile(privateKeyPath, privateKeyPem(privateKey));
  return {
    directory,
    challengePath,
    registryPath,
    privateKeyPath,
    outputPath,
    challengeDigest: challenge.challengeDigest,
    privateKey,
    publicKey,
    bindings,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function signingInput(
  value: Fixture,
  overrides: Partial<SignOwnerAuthorizationChallengeFileInput> = {}
): SignOwnerAuthorizationChallengeFileInput {
  return {
    challengePath: value.challengePath,
    registryPath: value.registryPath,
    privateKeyPath: value.privateKeyPath,
    outputPath: value.outputPath,
    approveChallengeDigest: value.challengeDigest,
    authorizationId: AUTHORIZATION_ID,
    signerId: SIGNER_ID,
    keyId: KEY_ID,
    ttlMs: 5 * 60_000,
    now: NOW,
    ...overrides,
  };
}

test("offline signer writes a new 0600 envelope accepted by the runtime verifier", () => {
  const value = fixture();
  try {
    const receipt = signOwnerAuthorizationChallengeFile(signingInput(value));
    const envelope = readFileSync(value.outputPath, "utf8");
    verifyOwnerAuthorizationEnvelope(envelope, {
      expected: value.bindings,
      expectedChallengeDigest: value.challengeDigest,
      registryPath: value.registryPath,
      now: NOW,
    });
    assert.equal(lstatSync(value.outputPath).mode & 0o777, 0o600);
    assert.equal(receipt.envelopeDigest, digest(envelope));
    assert.equal(receipt.repositorySlug, value.bindings.repository.slug);
    assert.equal(receipt.preflightId, value.bindings.preview.preflightId);
    assert.equal(receipt.outputPath, realpathSync.native(value.outputPath));

    const safeReceipt = canonicalJson(receipt);
    assert.doesNotMatch(safeReceipt, /"payload"|"signature"|BEGIN PRIVATE KEY/);
    assert.deepEqual(Object.keys(receipt).sort(), [
      "allowedActions",
      "authorizationId",
      "baseBranch",
      "baseSha",
      "candidateBranch",
      "candidateTreeSha",
      "challengeDigest",
      "envelopeDigest",
      "envelopeId",
      "expiresAt",
      "githubAppId",
      "installationId",
      "keyId",
      "manifestDigest",
      "outputPath",
      "preflightId",
      "pullRequestNumber",
      "repositoryId",
      "repositorySlug",
      "requiredCiDigest",
      "rulesetDigest",
      "runnerAttestationDigest",
      "signerId",
      "version",
    ]);
  } finally {
    value.cleanup();
  }
});

test("wrong algorithms and unregistered private keys fail before output creation", () => {
  const value = fixture();
  try {
    const other = generateKeyPairSync("ed25519");
    writeOwnerFile(value.privateKeyPath, privateKeyPem(other.privateKey));
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(value)),
      /does not match the registered public key/
    );
    assert.equal(lstatExists(value.outputPath), false);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeOwnerFile(value.privateKeyPath, privateKeyPem(rsa.privateKey));
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(value)),
      /Ed25519/
    );
    assert.equal(lstatExists(value.outputPath), false);
  } finally {
    value.cleanup();
  }
});

test("registry signer, repository, revocation, and key identity are enforced", () => {
  for (const mutate of [
    (registry: any) => { registry.keys[0].signerId = "another-signer"; },
    (registry: any) => { registry.keys[0].repository.id += 1; },
    (registry: any) => { registry.revokedAuthorizationIds = [AUTHORIZATION_ID]; },
    (registry: any) => { registry.keys[0].keyId = "another-key"; },
  ]) {
    const value = fixture();
    try {
      const registry = JSON.parse(readFileSync(value.registryPath, "utf8"));
      mutate(registry);
      writeOwnerFile(value.registryPath, canonicalJson(registry));
      assert.throws(() => signOwnerAuthorizationChallengeFile(signingInput(value)));
      assert.equal(lstatExists(value.outputPath), false);
    } finally {
      value.cleanup();
    }
  }
});

test("challenge tampering and excessive envelope TTL fail closed", () => {
  const value = fixture();
  try {
    const challenge = JSON.parse(readFileSync(value.challengePath, "utf8"));
    challenge.bindings.base.sha = "e".repeat(40);
    writeOwnerFile(value.challengePath, canonicalJson(challenge));
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(value)),
      /challenge digest does not match/
    );
    assert.equal(lstatExists(value.outputPath), false);
  } finally {
    value.cleanup();
  }

  const ttl = fixture();
  try {
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(ttl, { ttlMs: 30 * 60_000 + 1 })),
      /exceeds 30 minutes/
    );
    assert.equal(lstatExists(ttl.outputPath), false);
  } finally {
    ttl.cleanup();
  }
});

test("signing requires explicit approval of the exact parsed challenge digest", () => {
  const value = fixture();
  try {
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(value, {
        approveChallengeDigest: `sha256:${"0".repeat(64)}`,
      })),
      /explicit approved challenge digest does not match/
    );
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(value, {
        approveChallengeDigest: undefined as unknown as string,
      })),
      /explicit approved challenge digest does not match/
    );
    assert.equal(lstatExists(value.outputPath), false);
    assert.throws(
      () => runOwnerSignCli([
        "--challenge", value.challengePath,
        "--registry", value.registryPath,
        "--key", value.privateKeyPath,
        "--out", value.outputPath,
        "--authorization-id", AUTHORIZATION_ID,
        "--signer-id", SIGNER_ID,
        "--key-id", KEY_ID,
      ], NOW),
      /Usage:/
    );
  } finally {
    value.cleanup();
  }
});

test("relative, weak-permission, symlink, in-workspace, and pre-existing paths are rejected", () => {
  const relative = fixture();
  try {
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(relative, { privateKeyPath: "owner-key.pem" })),
      /owner private key path must be absolute/
    );
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(relative, { registryPath: "registry.json" })),
      /owner key registry path must be absolute/
    );
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(relative, { outputPath: "envelope.json" })),
      /output path must be absolute/
    );
  } finally {
    relative.cleanup();
  }

  for (const field of ["challengePath", "registryPath", "privateKeyPath"] as const) {
    const weak = fixture();
    try {
      chmodSync(weak[field], 0o644);
      assert.throws(
        () => signOwnerAuthorizationChallengeFile(signingInput(weak)),
        /owner-only regular non-symlink/
      );
      assert.equal(lstatExists(weak.outputPath), false);
    } finally {
      weak.cleanup();
    }
  }

  const symlink = fixture();
  try {
    const link = join(symlink.directory, "owner-key-link.pem");
    symlinkSync(symlink.privateKeyPath, link);
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(symlink, { privateKeyPath: link })),
      /owner-only regular non-symlink/
    );
  } finally {
    symlink.cleanup();
  }

  const hardlink = fixture();
  try {
    const link = join(hardlink.directory, "owner-key-hardlink.pem");
    linkSync(hardlink.privateKeyPath, link);
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(hardlink, { privateKeyPath: link })),
      /owner-only regular non-symlink/
    );
  } finally {
    hardlink.cleanup();
  }

  const existing = fixture();
  try {
    writeOwnerFile(existing.outputPath, "do-not-overwrite");
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(existing)),
      /must be a new owner-only non-symlink file/
    );
    assert.equal(readFileSync(existing.outputPath, "utf8"), "do-not-overwrite");
  } finally {
    existing.cleanup();
  }

  const insideWorkspace = fixture();
  try {
    assert.throws(
      () => signOwnerAuthorizationChallengeFile(signingInput(insideWorkspace, {
        outputPath: join(process.cwd(), "packages", "app", "test", "should-not-exist-envelope.json"),
      })),
      /outside the workspace/
    );
  } finally {
    insideWorkspace.cleanup();
  }
});

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
