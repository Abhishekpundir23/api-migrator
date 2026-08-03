import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OWNER_AUTHORIZATION_AUDIENCE,
  OWNER_AUTHORIZATION_MAX_TTL_MS,
  OWNER_AUTHORIZATION_SIGNATURE_DOMAIN,
  assertConsumedOwnerGrant,
  assertCurrentConsumedOwnerGrant,
  assertCurrentOwnerGrant,
  canonicalSha256,
  markGrantConsumed,
  ownerAuthorizationConsumption,
  ownerAuthorizationReceipt,
  verifyOwnerAuthorizationEnvelope,
  type ExpectedOwnerAuthorizationBindings,
  type OwnerAuthorizationGrant,
  type OwnerAuthorizationPayload,
  type OwnerAuthorizationReceipt,
} from "../src/owner-authorization.js";

const NOW = Date.now();

interface Fixture {
  directory: string;
  registryPath: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  payload: OwnerAuthorizationPayload;
  registry: Record<string, unknown>;
  envelope: string;
  expected: ExpectedOwnerAuthorizationBindings;
  cleanup(): void;
}

function digest(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function publicKeyPem(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function publicKeyFingerprint(key: KeyObject): string {
  const spki = key.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(spki).digest("hex")}`;
}

function expectedBindings(payload: OwnerAuthorizationPayload): ExpectedOwnerAuthorizationBindings {
  return clone({
    pilotId: payload.pilotId,
    approvalEvidenceDigest: payload.approvalEvidenceDigest,
    preRunAuthorizationDigest: payload.preRunAuthorizationDigest,
    previewCompletedAt: payload.previewCompletedAt,
    authorizationExpiresAt: payload.authorizationExpiresAt,
    repository: payload.repository,
    github: payload.github,
    base: payload.base,
    engine: payload.engine,
    manifest: payload.manifest,
    preview: payload.preview,
    allowedActions: payload.allowedActions,
    pullRequestNumber: payload.pullRequestNumber,
  });
}

function signPayloadBytes(
  payloadBytes: Buffer,
  privateKey: KeyObject,
  domain = OWNER_AUTHORIZATION_SIGNATURE_DOMAIN
): string {
  return sign(
    null,
    Buffer.concat([Buffer.from(domain, "utf8"), payloadBytes]),
    privateKey
  ).toString("base64url");
}

function envelopeForRawPayload(
  payloadJson: string,
  privateKey: KeyObject,
  keyId = "owner-key-v1",
  domain = OWNER_AUTHORIZATION_SIGNATURE_DOMAIN
): string {
  const payloadBytes = Buffer.from(payloadJson, "utf8");
  return canonical({
    version: 1,
    keyId,
    payload: payloadBytes.toString("base64url"),
    signature: signPayloadBytes(payloadBytes, privateKey, domain),
  });
}

function envelopeForPayload(
  payload: OwnerAuthorizationPayload,
  privateKey: KeyObject,
  domain = OWNER_AUTHORIZATION_SIGNATURE_DOMAIN
): string {
  return envelopeForRawPayload(canonical(payload), privateKey, payload.keyId, domain);
}

function writeRegistry(path: string, registry: unknown): void {
  writeFileSync(path, canonical(registry), { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "api-migrator-owner-auth-"));
  const registryPath = join(directory, "owner-keys.json");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload: OwnerAuthorizationPayload = {
    version: 1,
    audience: OWNER_AUTHORIZATION_AUDIENCE,
    envelopeId: "envelope-001",
    authorizationId: "authorization-001",
    pilotId: "pilot-001",
    signerId: "github-owner-1234",
    keyId: "owner-key-v1",
    approvalEvidenceDigest: digest("approval-evidence"),
    preRunAuthorizationDigest: digest("pre-run-authorization"),
    previewCompletedAt: NOW - 5_000,
    issuedAt: NOW - 4_000,
    notBefore: NOW - 3_000,
    expiresAt: NOW + 10 * 60_000,
    authorizationExpiresAt: NOW + 60 * 60_000,
    nonce: randomBytes(32).toString("base64url"),
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
      findingsDigest: digest("findings"),
      resolutionsDigest: digest("resolutions"),
      commandScopeDigest: digest("command-scope"),
      runnerAttestationDigest: digest("runner-attestation"),
      rulesetDigest: digest("ruleset"),
      requiredCiDigest: digest("required-ci"),
    },
    allowedActions: ["create_branch", "create_pull_request"],
    pullRequestNumber: null,
  };
  const registry = {
    version: 1,
    keys: [{
      keyId: payload.keyId,
      signerId: payload.signerId,
      algorithm: "Ed25519",
      publicKeyPem: publicKeyPem(publicKey),
      fingerprint: publicKeyFingerprint(publicKey),
      repository: payload.repository,
      validFrom: NOW - 60 * 60_000,
      validUntil: NOW + 2 * 60 * 60_000,
      revokedAt: null,
    }],
    revokedAuthorizationIds: [],
  };
  writeRegistry(registryPath, registry);
  return {
    directory,
    registryPath,
    privateKey,
    publicKey,
    payload,
    registry,
    envelope: envelopeForPayload(payload, privateKey),
    expected: expectedBindings(payload),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function verifyFixture(value: Fixture, now = NOW): OwnerAuthorizationGrant {
  return verifyOwnerAuthorizationEnvelope(value.envelope, {
    registryPath: value.registryPath,
    expected: value.expected,
    now,
  });
}

test("verifies a canonical Ed25519 envelope and exposes only safe one-use projections", () => {
  const value = fixture();
  try {
    const grant = verifyFixture(value);
    assert.deepEqual(Object.keys(grant as object), []);
    assert.equal(Object.isFrozen(grant), true);
    assert.equal(
      canonicalSha256({ b: 2, a: [true, null] }),
      `sha256:${createHash("sha256").update('{"a":[true,null],"b":2}').digest("hex")}`
    );

    assert.equal(assertCurrentOwnerGrant(grant, {
      registryPath: value.registryPath,
      expected: value.expected,
      now: NOW,
    }), grant);
    const consumption = ownerAuthorizationConsumption(grant, { now: NOW });
    assert.deepEqual(consumption, {
      authorizationId: value.payload.authorizationId,
      envelopeId: value.payload.envelopeId,
      envelopeDigest: `sha256:${createHash("sha256").update(value.envelope).digest("hex")}`,
      nonceDigest: `sha256:${createHash("sha256")
        .update(Buffer.from(value.payload.nonce, "base64url"))
        .digest("hex")}`,
      signerId: value.payload.signerId,
      keyId: value.payload.keyId,
      repositorySlug: value.payload.repository.slug,
      repositoryId: value.payload.repository.id,
      baseSha: value.payload.base.sha,
      preflightId: value.payload.preview.preflightId,
      artifactDigest: value.payload.preview.artifactDigest,
      manifestDigest: value.payload.manifest.digest,
      candidateBranch: value.payload.preview.candidateBranch,
      candidateTreeSha: value.payload.preview.candidateTreeSha,
      expiresAt: value.payload.expiresAt,
    });
    assert.match(consumption.envelopeDigest, /^sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(consumption), /signature|payload|publicKeyPem/);
    assert.throws(() => assertConsumedOwnerGrant(grant), /not been durably consumed/);

    const dbReceipt = {
      ...consumption,
      envelopeDigest: consumption.envelopeDigest.slice(7),
      nonceDigest: consumption.nonceDigest.slice(7),
      artifactDigest: consumption.artifactDigest.slice(7),
      manifestDigest: consumption.manifestDigest.slice(7),
      consumedAt: NOW,
    } as OwnerAuthorizationReceipt;
    const receipt = markGrantConsumed(grant, dbReceipt);
    assert.match(receipt.envelopeDigest, /^sha256:/);
    assert.equal(receipt.consumedAt, NOW);
    assert.deepEqual(assertConsumedOwnerGrant(grant), receipt);
    assert.deepEqual(ownerAuthorizationReceipt(grant), receipt);
    assert.throws(() => ownerAuthorizationConsumption(grant, { now: NOW }), /already been consumed/);
    assert.throws(() => markGrantConsumed(grant, dbReceipt), /already been consumed/);
  } finally {
    value.cleanup();
  }
});

test("rejects a forged or cloned grant despite structural casting", () => {
  const value = fixture();
  try {
    const forged = {} as OwnerAuthorizationGrant;
    assert.throws(
      () => assertCurrentOwnerGrant(forged, { expected: value.expected, now: NOW }),
      /invalid owner authorization grant/
    );
    const grant = verifyFixture(value);
    const cloneGrant = { ...(grant as object) } as OwnerAuthorizationGrant;
    assert.throws(() => ownerAuthorizationConsumption(cloneGrant, { now: NOW }), /invalid owner authorization grant/);
  } finally {
    value.cleanup();
  }
});

test("binds every runtime-owned payload field exactly", () => {
  const value = fixture();
  try {
    const mutations: Array<[string, (expected: ExpectedOwnerAuthorizationBindings) => void]> = [
      ["pilotId", (entry) => { entry.pilotId = "pilot-002"; }],
      ["approvalEvidenceDigest", (entry) => { entry.approvalEvidenceDigest = digest("other-approval"); }],
      ["preRunAuthorizationDigest", (entry) => { entry.preRunAuthorizationDigest = digest("other-pre-run"); }],
      ["previewCompletedAt", (entry) => { entry.previewCompletedAt -= 1; }],
      ["authorizationExpiresAt", (entry) => { entry.authorizationExpiresAt += 1; }],
      ["repository.slug", (entry) => { entry.repository.slug = "other-org/example-repo"; }],
      ["repository.id", (entry) => { entry.repository.id += 1; }],
      ["repository.ownerId", (entry) => { entry.repository.ownerId += 1; }],
      ["github.appId", (entry) => { entry.github.appId += 1; }],
      ["github.installationId", (entry) => { entry.github.installationId += 1; }],
      ["base.branch", (entry) => { entry.base.branch = "release"; }],
      ["base.sha", (entry) => { entry.base.sha = "e".repeat(40); }],
      ["engine.tag", (entry) => { entry.engine.tag = "v0.1.1"; }],
      ["engine.commit", (entry) => { entry.engine.commit = "e".repeat(40); }],
      ["manifest.byteLength", (entry) => { entry.manifest.byteLength += 1; }],
      ["manifest.digest", (entry) => { entry.manifest.digest = digest("other-manifest"); }],
      ["preview.preflightId", (entry) => { entry.preview.preflightId = `pf_${"e".repeat(64)}`; }],
      ["preview.artifactDigest", (entry) => { entry.preview.artifactDigest = digest("other-artifact"); }],
      ["preview.candidateBranch", (entry) => { entry.preview.candidateBranch += "-other"; }],
      ["preview.candidateTreeSha", (entry) => { entry.preview.candidateTreeSha = "e".repeat(40); }],
      ["preview.findingsDigest", (entry) => { entry.preview.findingsDigest = digest("other-findings"); }],
      ["preview.resolutionsDigest", (entry) => { entry.preview.resolutionsDigest = digest("other-resolutions"); }],
      ["preview.commandScopeDigest", (entry) => { entry.preview.commandScopeDigest = digest("other-command"); }],
      ["preview.runnerAttestationDigest", (entry) => { entry.preview.runnerAttestationDigest = digest("other-runner"); }],
      ["preview.rulesetDigest", (entry) => { entry.preview.rulesetDigest = digest("other-ruleset"); }],
      ["preview.requiredCiDigest", (entry) => { entry.preview.requiredCiDigest = digest("other-ci"); }],
      ["allowedActions", (entry) => { entry.allowedActions = ["create_pull_request"]; }],
      ["pullRequestNumber", (entry) => { entry.pullRequestNumber = 123; }],
    ];
    for (const [label, mutate] of mutations) {
      const expected = clone(value.expected);
      mutate(expected);
      assert.throws(
        () => verifyOwnerAuthorizationEnvelope(value.envelope, {
          registryPath: value.registryPath,
          expected,
          now: NOW,
        }),
        /exact runtime bindings/,
        label
      );
    }
  } finally {
    value.cleanup();
  }
});

test("rejects unknown, missing, duplicate, noncanonical, unsafe, and invalid-Unicode payload data", () => {
  const value = fixture();
  try {
    const attempts: Array<[string, string]> = [];
    const unknown = { ...clone(value.payload), extra: true };
    attempts.push(["unknown", envelopeForPayload(unknown as OwnerAuthorizationPayload, value.privateKey)]);
    const missing = clone(value.payload) as unknown as Record<string, unknown>;
    delete missing.envelopeId;
    attempts.push(["missing", envelopeForRawPayload(canonical(missing), value.privateKey)]);

    const raw = canonical(value.payload);
    attempts.push([
      "duplicate",
      envelopeForRawPayload(
        raw.replace('"pilotId":"pilot-001"', '"pilotId":"pilot-001","pilotId":"pilot-002"'),
        value.privateKey
      ),
    ]);
    attempts.push(["noncanonical", envelopeForRawPayload(JSON.stringify(value.payload, null, 2), value.privateKey)]);
    attempts.push([
      "unsafe integer",
      envelopeForRawPayload(raw.replace('"id":1234567', '"id":9007199254740992'), value.privateKey),
    ]);
    attempts.push([
      "invalid Unicode",
      envelopeForRawPayload(raw.replace('"pilotId":"pilot-001"', '"pilotId":"\\ud800"'), value.privateKey),
    ]);

    for (const [label, envelope] of attempts) {
      assert.throws(
        () => verifyOwnerAuthorizationEnvelope(envelope, {
          registryPath: value.registryPath,
          expected: value.expected,
          now: NOW,
        }),
        /Owner authorization rejected/,
        label
      );
    }

    const badDigest = clone(value.payload);
    badDigest.preview.artifactDigest = "A".repeat(64);
    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(envelopeForPayload(badDigest, value.privateKey), {
        registryPath: value.registryPath,
        expected: expectedBindings(badDigest),
        now: NOW,
      }),
      /lowercase sha256/
    );
    const badNonce = clone(value.payload);
    badNonce.nonce = randomBytes(31).toString("base64url");
    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(envelopeForPayload(badNonce, value.privateKey), {
        registryPath: value.registryPath,
        expected: expectedBindings(badNonce),
        now: NOW,
      }),
      /exactly 32 bytes/
    );
  } finally {
    value.cleanup();
  }
});

test("rejects noncanonical outer JSON, duplicate keys, malformed base64url, padding, and wrong sizes", () => {
  const value = fixture();
  try {
    const parsed = JSON.parse(value.envelope) as Record<string, unknown>;
    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(JSON.stringify(parsed, null, 2), {
        registryPath: value.registryPath,
        expected: value.expected,
        now: NOW,
      }),
      /not canonical JSON/
    );
    const duplicate = value.envelope.replace(
      '"keyId":"owner-key-v1"',
      '"keyId":"owner-key-v1","keyId":"owner-key-v2"'
    );
    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(duplicate, {
        registryPath: value.registryPath,
        expected: value.expected,
        now: NOW,
      }),
      /not canonical JSON/
    );

    for (const field of ["payload", "signature"] as const) {
      const padded = { ...parsed, [field]: `${parsed[field]}=` };
      assert.throws(
        () => verifyOwnerAuthorizationEnvelope(canonical(padded), {
          registryPath: value.registryPath,
          expected: value.expected,
          now: NOW,
        }),
        /unpadded base64url/,
        field
      );
    }
    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(canonical({ ...parsed, signature: "AA" }), {
        registryPath: value.registryPath,
        expected: value.expected,
        now: NOW,
      }),
      /exactly 64 bytes/
    );
    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(canonical({ ...parsed, payload: "A" }), {
        registryPath: value.registryPath,
        expected: value.expected,
        now: NOW,
      }),
      /unpadded base64url/
    );
    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(canonical({ ...parsed, signature: "x".repeat(70_000) }), {
        registryPath: value.registryPath,
        expected: value.expected,
        now: NOW,
      }),
      /exceeds the supported size/
    );
  } finally {
    value.cleanup();
  }
});

test("rejects wrong signature keys, domain separation, key ids, algorithms, and fingerprints", () => {
  const value = fixture();
  try {
    const wrongDomain = envelopeForPayload(
      value.payload,
      value.privateKey,
      "api-migrator:owner-publication:wrong\0"
    );
    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(wrongDomain, {
        registryPath: value.registryPath,
        expected: value.expected,
        now: NOW,
      }),
      /signature verification failed/
    );

    const other = generateKeyPairSync("ed25519");
    const wrongKeyEnvelope = envelopeForPayload(value.payload, other.privateKey);
    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(wrongKeyEnvelope, {
        registryPath: value.registryPath,
        expected: value.expected,
        now: NOW,
      }),
      /signature verification failed/
    );

    const parsed = JSON.parse(value.envelope) as Record<string, unknown>;
    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(canonical({ ...parsed, keyId: "other-key" }), {
        registryPath: value.registryPath,
        expected: value.expected,
        now: NOW,
      }),
      /does not match payload/
    );

    const wrongAlgorithm = clone(value.registry) as { keys: Array<Record<string, unknown>> };
    wrongAlgorithm.keys[0]!.algorithm = "RSA";
    writeRegistry(value.registryPath, wrongAlgorithm);
    assert.throws(() => verifyFixture(value), /algorithm must be Ed25519/);

    const wrongFingerprint = clone(value.registry) as { keys: Array<Record<string, unknown>> };
    wrongFingerprint.keys[0]!.fingerprint = digest("wrong-fingerprint");
    writeRegistry(value.registryPath, wrongFingerprint);
    assert.throws(() => verifyFixture(value), /fingerprint does not match/);
  } finally {
    value.cleanup();
  }
});

test("registry accepts only canonical SPKI PUBLIC KEY PEM", () => {
  const value = fixture();
  try {
    const publicPem = publicKeyPem(value.publicKey);
    const privatePem = value.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwk = value.publicKey.export({ format: "jwk" }) as { x?: string };
    assert.ok(jwk.x);
    const sshAlgorithm = Buffer.from("ssh-ed25519", "utf8");
    const sshPublicKey = Buffer.from(jwk.x, "base64url");
    const sshField = (field: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(field.length);
      return Buffer.concat([length, field]);
    };
    const openSsh = `ssh-ed25519 ${Buffer.concat([
      sshField(sshAlgorithm),
      sshField(sshPublicKey),
    ]).toString("base64")} owner@example.com`;
    const certificate = publicPem
      .replace("BEGIN PUBLIC KEY", "BEGIN CERTIFICATE")
      .replace("END PUBLIC KEY", "END CERTIFICATE");

    const rejectedForms = [
      ["private key", privatePem],
      ["trailing private key", `${publicPem}${privatePem}`],
      ["OpenSSH key", openSsh],
      ["certificate", certificate],
      ["noncanonical SPKI", publicPem.trimEnd()],
    ] as const;
    for (const [label, publicKeyPem] of rejectedForms) {
      const registry = clone(value.registry) as { keys: Array<Record<string, unknown>> };
      registry.keys[0]!.publicKeyPem = publicKeyPem;
      writeRegistry(value.registryPath, registry);
      assert.throws(
        () => verifyFixture(value),
        /canonical SPKI PUBLIC KEY PEM/,
        label
      );
    }
  } finally {
    value.cleanup();
  }
});

test("enforces time ordering, the 30-minute TTL, authorization expiry, and PR state", () => {
  const value = fixture();
  try {
    const cases: Array<[string, (payload: OwnerAuthorizationPayload) => void, number]> = [
      ["preview after issue", (entry) => { entry.previewCompletedAt = entry.issuedAt + 1; }, NOW],
      ["issue after not-before", (entry) => { entry.notBefore = entry.issuedAt - 1; }, NOW],
      ["empty window", (entry) => { entry.notBefore = entry.expiresAt; }, NOW],
      ["excessive TTL", (entry) => { entry.expiresAt = entry.issuedAt + OWNER_AUTHORIZATION_MAX_TTL_MS + 1; }, NOW],
      ["underlying expiry", (entry) => { entry.authorizationExpiresAt = entry.expiresAt - 1; }, NOW],
      ["not yet valid", () => undefined, value.payload.notBefore - 1],
      ["expired", () => undefined, value.payload.expiresAt],
      ["create binds PR", (entry) => { entry.pullRequestNumber = 17; }, NOW],
      ["update lacks PR", (entry) => { entry.allowedActions = ["update_pull_request"]; }, NOW],
    ];
    for (const [label, mutate, clock] of cases) {
      const payload = clone(value.payload);
      mutate(payload);
      const envelope = envelopeForPayload(payload, value.privateKey);
      assert.throws(
        () => verifyOwnerAuthorizationEnvelope(envelope, {
          registryPath: value.registryPath,
          expected: expectedBindings(payload),
          now: clock,
        }),
        /Owner authorization rejected/,
        label
      );
    }

    const update = clone(value.payload);
    update.allowedActions = ["update_pull_request"];
    update.pullRequestNumber = 17;
    const updateGrant = verifyOwnerAuthorizationEnvelope(envelopeForPayload(update, value.privateKey), {
      registryPath: value.registryPath,
      expected: expectedBindings(update),
      now: NOW,
    });
    assert.equal(ownerAuthorizationConsumption(updateGrant, { expected: expectedBindings(update), now: NOW }).preflightId, update.preview.preflightId);
  } finally {
    value.cleanup();
  }
});

test("registry is strict, owner-only, non-symlinked, unique, scoped, and time-bounded", () => {
  const value = fixture();
  try {
    chmodSync(value.registryPath, 0o644);
    assert.throws(() => verifyFixture(value), /owner-only regular non-symlink/);
    chmodSync(value.registryPath, 0o600);

    const linkPath = join(value.directory, "owner-keys-link.json");
    symlinkSync(value.registryPath, linkPath);
    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(value.envelope, {
        registryPath: linkPath,
        expected: value.expected,
        now: NOW,
      }),
      /owner-only regular non-symlink/
    );

    assert.throws(
      () => verifyOwnerAuthorizationEnvelope(value.envelope, {
        registryPath: "relative-owner-keys.json",
        expected: value.expected,
        now: NOW,
      }),
      /path must be absolute/
    );

    writeFileSync(value.registryPath, JSON.stringify(value.registry, null, 2), "utf8");
    chmodSync(value.registryPath, 0o600);
    assert.throws(() => verifyFixture(value), /not canonical JSON/);

    const unknown = { ...clone(value.registry), extra: true };
    writeRegistry(value.registryPath, unknown);
    assert.throws(() => verifyFixture(value), /unknown or missing fields/);

    const duplicateKey = clone(value.registry) as { keys: Array<Record<string, unknown>> };
    duplicateKey.keys.push(clone(duplicateKey.keys[0]!));
    writeRegistry(value.registryPath, duplicateKey);
    assert.throws(() => verifyFixture(value), /duplicate key/);

    const other = generateKeyPairSync("ed25519");
    const duplicateScope = clone(value.registry) as { keys: Array<Record<string, unknown>> };
    duplicateScope.keys.push({
      ...clone(duplicateScope.keys[0]!),
      keyId: "owner-key-v2",
      publicKeyPem: publicKeyPem(other.publicKey),
      fingerprint: publicKeyFingerprint(other.publicKey),
    });
    writeRegistry(value.registryPath, duplicateScope);
    assert.throws(() => verifyFixture(value), /duplicate signer scope/);

    const duplicateRevocation = clone(value.registry) as { revokedAuthorizationIds: string[] };
    duplicateRevocation.revokedAuthorizationIds = ["authorization-old", "authorization-old"];
    writeRegistry(value.registryPath, duplicateRevocation);
    assert.throws(() => verifyFixture(value), /duplicate revoked/);
  } finally {
    value.cleanup();
  }
});

test("registry scope, key validity, key revocation, and authorization revocation fail closed", () => {
  const value = fixture();
  try {
    const cases: Array<[string, (registry: { keys: Array<Record<string, unknown>>; revokedAuthorizationIds: string[] }) => void]> = [
      ["signer scope", (registry) => { registry.keys[0]!.signerId = "another-owner"; }],
      ["repository scope", (registry) => {
        registry.keys[0]!.repository = { ...value.payload.repository, id: value.payload.repository.id + 1 };
      }],
      ["not yet valid", (registry) => { registry.keys[0]!.validFrom = NOW + 1; }],
      ["expired", (registry) => { registry.keys[0]!.validUntil = NOW; }],
      ["revoked key", (registry) => { registry.keys[0]!.revokedAt = NOW - 1; }],
      ["revoked authorization", (registry) => { registry.revokedAuthorizationIds = [value.payload.authorizationId]; }],
    ];
    for (const [label, mutate] of cases) {
      const registry = clone(value.registry) as {
        keys: Array<Record<string, unknown>>;
        revokedAuthorizationIds: string[];
      };
      mutate(registry);
      writeRegistry(value.registryPath, registry);
      assert.throws(() => verifyFixture(value), /Owner authorization rejected/, label);
    }
  } finally {
    value.cleanup();
  }
});

test("assertCurrentOwnerGrant rereads registry and detects post-verification revocation", () => {
  const value = fixture();
  try {
    const grant = verifyFixture(value);
    const revoked = clone(value.registry) as { revokedAuthorizationIds: string[] };
    revoked.revokedAuthorizationIds = [value.payload.authorizationId];
    writeRegistry(value.registryPath, revoked);
    assert.throws(
      () => assertCurrentOwnerGrant(grant, { expected: value.expected, now: NOW }),
      /has been revoked/
    );
    assert.throws(
      () => ownerAuthorizationConsumption(grant, { expected: value.expected, now: NOW }),
      /has been revoked/
    );
  } finally {
    value.cleanup();
  }
});

test("markGrantConsumed rejects mismatched, premature, expired, and duplicate receipts", () => {
  const value = fixture();
  try {
    const grant = verifyFixture(value);
    const consumption = ownerAuthorizationConsumption(grant, { now: NOW });
    assert.throws(
      () => markGrantConsumed(grant, {
        ...consumption,
        authorizationId: "authorization-other",
        consumedAt: NOW,
      }),
      /does not match/
    );
    assert.throws(
      () => markGrantConsumed(grant, { ...consumption, consumedAt: value.payload.notBefore - 1 }),
      /outside the authorization window/
    );
    assert.throws(
      () => markGrantConsumed(grant, { ...consumption, consumedAt: value.payload.expiresAt }),
      /outside the authorization window/
    );

    const receipt = markGrantConsumed(grant, { ...consumption, consumedAt: NOW });
    assert.equal(receipt.authorizationId, value.payload.authorizationId);
    assert.throws(
      () => markGrantConsumed(grant, { ...consumption, consumedAt: NOW }),
      /already been consumed/
    );
  } finally {
    value.cleanup();
  }
});

test("markGrantConsumed uses fresh wall time after durable reservation", () => {
  const value = fixture();
  const originalNow = Date.now;
  try {
    const payload = clone(value.payload);
    payload.expiresAt = NOW + 1;
    const grant = verifyOwnerAuthorizationEnvelope(envelopeForPayload(payload, value.privateKey), {
      registryPath: value.registryPath,
      expected: expectedBindings(payload),
      now: NOW,
    });
    const consumption = ownerAuthorizationConsumption(grant, {
      expected: expectedBindings(payload),
      now: NOW,
    });

    Date.now = () => payload.expiresAt;
    assert.throws(
      () => markGrantConsumed(grant, { ...consumption, consumedAt: NOW }),
      /has expired/
    );
    assert.throws(() => assertConsumedOwnerGrant(grant), /not been durably consumed/);
  } finally {
    Date.now = originalNow;
    value.cleanup();
  }
});

test("a consumed grant remains subject to live revocation at the token boundary", () => {
  const value = fixture();
  try {
    const grant = verifyFixture(value);
    const consumption = ownerAuthorizationConsumption(grant, { now: NOW });
    markGrantConsumed(grant, { ...consumption, consumedAt: NOW });
    assert.doesNotThrow(() =>
      assertCurrentConsumedOwnerGrant(grant, { expected: value.expected, now: NOW })
    );

    const revoked = clone(value.registry) as { revokedAuthorizationIds: string[] };
    revoked.revokedAuthorizationIds = [value.payload.authorizationId];
    writeRegistry(value.registryPath, revoked);
    assert.throws(
      () => assertCurrentConsumedOwnerGrant(grant, { expected: value.expected, now: NOW }),
      /has been revoked/
    );
  } finally {
    value.cleanup();
  }
});

test("canonicalSha256 rejects unsafe JSON values and invalid Unicode", () => {
  assert.throws(() => canonicalSha256({ value: Number.MAX_SAFE_INTEGER + 1 }), /unsafe JSON number/);
  assert.throws(() => canonicalSha256({ value: undefined }), /undefined JSON member/);
  assert.throws(() => canonicalSha256({ value: "\ud800" }), /unpaired high surrogate/);
});
