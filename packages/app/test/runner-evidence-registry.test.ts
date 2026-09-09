import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { constants, chmodSync, linkSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { execFileSync } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "../src/canonical-json.js";
import { RunnerEvidenceError } from "../src/runner-evidence-contract.js";
import { createRunnerEvidenceDeadline } from "../src/runner-evidence-deadline.js";
import { selectRunnerKey, readRunnerKeyRegistry, readRunnerKeyRegistryWithIo, type RunnerKeyEntry, type RunnerRegistryIo } from "../src/runner-key-registry.js";
import { runnerEvidenceFixture } from "./helpers/runner-evidence-fixture.js";
import { publicationRunnerTrustPair } from "./helpers/publication-runner-fixture.js";
import { registryFixture, registryFixtureIo } from "./helpers/runner-evidence-io-fixture.js";

const now = 2_000_000_000_000;
let f: ReturnType<typeof runnerEvidenceFixture>;
before(() => { f = runnerEvidenceFixture(now); });
after(() => f.close());
const entry = (): RunnerKeyEntry => ({ ...f.trust, pilotId: f.context.plan.plan.subject.pilotId, repository: { ...f.context.source.repository } });
const encode = (...keys: unknown[]) => Buffer.from(canonicalJson({ schemaVersion: 1, keys }));
const unavailable = (error: unknown) => error instanceof RunnerEvidenceError && error.code === "trust_unavailable";
function deadline() {
  return createRunnerEvidenceDeadline({ wallNow: () => now, monotonicNow: () => 0 }, now + 10_000);
}
async function read(fixture: ReturnType<typeof registryFixture>, io = registryFixtureIo(), uid = process.geteuid!()) {
  const d = deadline();
  try { return await readRunnerKeyRegistryWithIo(fixture.directory, fixture.policy, f.context, d, io, uid); }
  finally { d.close(); }
}

test("key policy changes alter retained digest and selections are detached and frozen", () => {
  const bytes = encode(entry());
  const a = selectRunnerKey(bytes, f.context, now);
  const b = selectRunnerKey(encode({ ...entry(), validUntil: entry().validUntil - 1 }), f.context, now);
  assert.notEqual(a.trustDigest, b.trustDigest);
  assert.match(a.trustDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(a.entry.repository.slug, "fixture-org/fixture-repo");
  for (const object of [a, a.entry, a.entry.repository, a.trust]) assert.ok(Object.isFrozen(object));
  assert.deepEqual(Object.keys(a.trust).sort(), ["algorithm", "fingerprint", "keyId", "publicKeyPem", "revokedAt", "validFrom", "validUntil"]);
  bytes.fill(0);
  assert.equal(a.entry.keyId, f.trust.keyId);
});

test("canonical bytes reject duplicate members, invalid UTF-8, trailing data and unknown fields", () => {
  const canonical = encode(entry());
  for (const bytes of [
    Buffer.from(canonical.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
    Buffer.concat([canonical, Buffer.from("\n")]), Buffer.from([0xff]), Buffer.from("{}"),
    Buffer.from(canonicalJson({ schemaVersion: 2, keys: [entry()] })),
    Buffer.from(canonicalJson({ schemaVersion: 1, keys: [entry()], other: true })),
    encode({ ...entry(), publicKey: "not permitted" }),
    encode({ ...entry(), repository: { ...entry().repository, extra: 1 } }),
    encode(), encode(...Array(129).fill(entry())),
  ]) assert.throws(() => selectRunnerKey(bytes, f.context, now), unavailable);
});

test("scope and validity are strict, including malformed inactive entries", () => {
  for (const patch of [
    { pilotId: "pilot_x" }, { pilotId: "pilot_abcdef!" },
    { repository: { ...entry().repository, slug: "Fixture-org/fixture-repo" } },
    { repository: { ...entry().repository, slug: "a/b/c" } },
    { repository: { ...entry().repository, id: 0 } },
    { repository: { ...entry().repository, ownerId: 0 } },
    { validFrom: now + 1 }, { validUntil: now }, { revokedAt: now },
    { revokedAt: now + 1 }, { validFrom: -1 }, { validUntil: entry().validFrom },
    { fingerprint: "sha256:" + "0".repeat(64) }, { algorithm: "RSA" },
  ]) {
    const bytes = encode({ ...entry(), ...patch });
    assert.throws(() => selectRunnerKey(bytes, f.context, now), unavailable);
  }
  assert.doesNotThrow(() => selectRunnerKey(encode({ ...entry(), validFrom: now }), f.context, now));
  assert.throws(() => selectRunnerKey(Buffer.from(encode(entry()).toString().replace('"ownerId":7654321', '"ownerId":1.5')), f.context, now), unavailable);
  const inactive = { ...entry(), keyId: "old-key", validUntil: now - 1, algorithm: "RSA" };
  assert.throws(() => selectRunnerKey(encode(entry(), inactive), f.context, now), unavailable);
  for (const invalidNow of [NaN, now + 0.5, -1]) assert.throws(() => selectRunnerKey(encode(entry()), f.context, invalidNow), unavailable);
});

test("selection validates all entries and rejects duplicate IDs, fingerprints and active scope ambiguity globally", () => {
  const second = { ...entry(), ...publicationRunnerTrustPair(now).trust, keyId: "second-key" };
  assert.throws(() => selectRunnerKey(encode(entry(), { ...second, keyId: entry().keyId, revokedAt: now }), f.context, now), unavailable);
  assert.throws(() => selectRunnerKey(encode(entry(), { ...entry(), keyId: "old-key", revokedAt: now }), f.context, now), unavailable);
  assert.throws(() => selectRunnerKey(encode(entry(), second), f.context, now), unavailable);
  const unrelated = { ...second, pilotId: "pilot_other_001" };
  const third = { ...unrelated, ...publicationRunnerTrustPair(now).trust, keyId: "third-key" };
  assert.throws(() => selectRunnerKey(encode(entry(), unrelated, third), f.context, now), unavailable);
  assert.equal(selectRunnerKey(encode(unrelated, entry()), f.context, now).entry.keyId, f.trust.keyId);
  assert.equal(selectRunnerKey(encode({ ...second, revokedAt: now }, entry()), f.context, now).entry.keyId, f.trust.keyId);
  assert.throws(() => selectRunnerKey(encode(unrelated), f.context, now), unavailable);
});

test("multiple PEM blocks, private keys and certificates cannot become public trust", () => {
  const privateKeyPem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  for (const pem of [entry().publicKeyPem.repeat(2), privateKeyPem, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"]) {
    assert.throws(() => selectRunnerKey(encode({ ...entry(), publicKeyPem: pem }), f.context, now), unavailable);
  }
});

test("128 independently valid entries are accepted but a 129th is rejected", () => {
  const keys = [entry()];
  for (let index = 1; index < 129; index++) {
    keys.push({ ...entry(), ...publicationRunnerTrustPair(now).trust, keyId: `key-${index}`, pilotId: `pilot_other_${index}` });
  }
  assert.equal(selectRunnerKey(encode(...keys.slice(0, 128)), f.context, now).entry.keyId, entry().keyId);
  assert.throws(() => selectRunnerKey(encode(...keys), f.context, now), unavailable);
});

test("real owner-only file reads fresh bytes across atomic replacement", async () => {
  const r = registryFixture(encode(entry()));
  try {
    const first = await read(r);
    chmodSync(r.file, 0o400);
    assert.equal((await read(r)).trustDigest, first.trustDigest);
    r.replace(encode({ ...entry(), validUntil: entry().validUntil - 1 }));
    assert.notEqual((await read(r)).trustDigest, first.trustDigest);
    r.replace(encode({ ...entry(), revokedAt: now }));
    await assert.rejects(read(r), unavailable);
  } finally { r.close(); }
});

test("real wrong file modes, directory modes and hardlinks fail closed", async () => {
  const r = registryFixture(encode(entry()));
  try {
    for (const mode of [0o644, 0o640, 0o200, 0o700, 0o4600, 0o2600, 0o1600]) {
      chmodSync(r.file, mode);
      await assert.rejects(read(r), unavailable);
    }
    chmodSync(r.file, 0o600);
    for (const mode of [0o750, 0o710, 0o1700]) {
      chmodSync(r.directory, mode);
      await assert.rejects(read(r), unavailable);
    }
    chmodSync(r.directory, 0o700);
    linkSync(r.file, join(r.directory, "hardlink"));
    await assert.rejects(read(r), unavailable);
  } finally { r.close(); }
});

test("real file, registry and parent symlinks are rejected", async () => {
  const r = registryFixture(encode(entry()));
  try {
    renameSync(r.file, join(r.directory, "actual.json"));
    symlinkSync("actual.json", r.file);
    await assert.rejects(read(r), unavailable);
    unlinkSync(r.file);
    renameSync(join(r.directory, "actual.json"), r.file);
    const alias = join(dirname(r.directory), "alias");
    symlinkSync(r.directory, alias);
    await assert.rejects(read({ ...r, directory: alias }), unavailable);
    const parentAlias = join(dirname(r.directory), "parent-alias");
    symlinkSync(dirname(r.directory), parentAlias);
    await assert.rejects(read({ ...r, directory: join(parentAlias, "registry") }), unavailable);
  } finally { r.close(); }
});

test("real workspace aliases and containment fail while lexical siblings are not excluded", async () => {
  const r = registryFixture(encode(entry()));
  try {
    const alias = join(r.policy.applicationCheckout, "alias");
    symlinkSync(r.directory, alias);
    for (const root of [r.directory, dirname(r.directory), alias]) {
      await assert.rejects(read({ ...r, policy: { ...r.policy, excludedRoots: [root] } }), unavailable);
    }
    await assert.rejects(read({ ...r, policy: { applicationCheckout: alias, excludedRoots: [] } }), unavailable);
    const sibling = r.directory + "-sibling";
    mkdirSync(sibling, { mode: 0o700 });
    assert.equal((await read({ ...r, policy: { ...r.policy, excludedRoots: [sibling] } })).entry.keyId, entry().keyId);
  } finally { r.close(); }
});

test("required roots cannot disappear or be deduplicated into optional platform roots", async () => {
  const r = registryFixture(encode(entry()));
  try {
    const missing = join(r.policy.applicationCheckout, "missing");
    await assert.rejects(read({ ...r, policy: { ...r.policy, applicationCheckout: missing } }), unavailable);
    await assert.rejects(read({ ...r, policy: { ...r.policy, excludedRoots: [missing], platformExcludedRoots: [missing] } }), unavailable);
    assert.equal((await read({ ...r, policy: { ...r.policy, platformExcludedRoots: [missing] } })).entry.keyId, entry().keyId);
    for (const code of ["EACCES", "ELOOP", "ENOTDIR"]) {
      const io = registryFixtureIo();
      io.realpath = (async (path) => {
        if (String(path) === missing) throw Object.assign(new Error("native secret"), { code });
        return registryFixtureIo().realpath(path);
      }) as RunnerRegistryIo["realpath"];
      await assert.rejects(read({ ...r, policy: { ...r.policy, platformExcludedRoots: [missing] } }, io), unavailable);
    }
    // Inject ENOENT for a lexical containing platform root: it must still exclude.
    const io = registryFixtureIo();
    io.realpath = (async (path) => {
      if (String(path) === r.directory) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return registryFixtureIo().realpath(path);
    }) as RunnerRegistryIo["realpath"];
    await assert.rejects(read({ ...r, policy: { ...r.policy, platformExcludedRoots: [r.directory] } }, io), unavailable);
    await assert.rejects(read({ ...r, policy: { ...r.policy, platformExcludedRoots: [r.directory] } }), unavailable);
  } finally { r.close(); }
});

function changed(snapshot: BigIntStats, patch: Partial<BigIntStats>): BigIntStats {
  return Object.assign(Object.create(Object.getPrototypeOf(snapshot)), snapshot, patch);
}
function interceptHandle(io: RunnerRegistryIo, overrides: (handle: FileHandle) => Partial<FileHandle>): RunnerRegistryIo {
  return {
    ...io,
    open: async (...args) => {
      const handle = await io.open(...args);
      const methods = overrides(handle);
      return new Proxy(handle, {
        get(target, property) {
          const replacement = Reflect.get(methods, property);
          if (replacement !== undefined) return replacement;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

test("wrong-owner and unsafe ancestor snapshots reject before opening (injected metadata)", async () => {
  const r = registryFixture(encode(entry()));
  try {
    for (const [path, patch] of [
      [r.file, { uid: BigInt(process.geteuid!() + 1) }],
      [r.directory, { uid: BigInt(process.geteuid!() + 1) }],
      [dirname(r.directory), { uid: BigInt(process.geteuid!() + 1) }],
      [dirname(r.directory), { mode: 0o40777n }],
      [dirname(r.directory), { mode: 0o41777n }],
      [r.file, { mode: 0o20600n }],
    ] as Array<[string, Partial<BigIntStats>]>) {
      const native = registryFixtureIo();
      let opened = false;
      const io: RunnerRegistryIo = {
        ...native,
        open: async (...args) => { opened = true; return native.open(...args); },
        lstat: (async (name, options) => {
          const stat = await native.lstat(name, options);
          return String(name) === path ? changed(stat as BigIntStats, patch) : stat;
        }) as RunnerRegistryIo["lstat"],
      };
      await assert.rejects(read(r, io), unavailable);
      assert.equal(opened, false);
    }
    await assert.rejects(read(r, registryFixtureIo(), NaN), unavailable);
  } finally { r.close(); }
});

test("real FIFO and directory files reject before open; normal reader retains native checks", async () => {
  const r = registryFixture(encode(entry()));
  try {
    unlinkSync(r.file);
    execFileSync("mkfifo", ["-m", "600", r.file]);
    let opened = false;
    const native = registryFixtureIo();
    const io = { ...native, open: async (...args: Parameters<RunnerRegistryIo["open"]>) => { opened = true; return native.open(...args); } };
    await assert.rejects(read(r, io), unavailable);
    assert.equal(opened, false);
    const d = deadline();
    try { await assert.rejects(readRunnerKeyRegistry(r.directory, r.policy, f.context, d), unavailable); }
    finally { d.close(); }
    unlinkSync(r.file);
    mkdirSync(r.file, { mode: 0o700 });
    await assert.rejects(read(r, io), unavailable);
  } finally { r.close(); }
});

test("Windows and missing effective UID fail before filesystem IO", async () => {
  const r = registryFixture(encode(entry()));
  const d = deadline();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const geteuid = Object.getOwnPropertyDescriptor(process, "geteuid")!;
  let ioCalled = false;
  const io: RunnerRegistryIo = {
    open: async () => { ioCalled = true; throw new Error("unexpected IO"); },
    lstat: (async () => { ioCalled = true; throw new Error("unexpected IO"); }) as RunnerRegistryIo["lstat"],
    realpath: (async () => { ioCalled = true; throw new Error("unexpected IO"); }) as RunnerRegistryIo["realpath"],
  };
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await assert.rejects(readRunnerKeyRegistryWithIo(r.directory, r.policy, f.context, d, io, process.geteuid!()), unavailable);
    assert.equal(ioCalled, false);
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "geteuid", { ...geteuid, value: undefined });
    await assert.rejects(readRunnerKeyRegistry(r.directory, r.policy, f.context, d), unavailable);
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "geteuid", geteuid);
    d.close();
    r.close();
  }
});

test("open errors and real descriptor read failure return safe errors and close descriptors", async () => {
  const r = registryFixture(encode(entry()));
  try {
    await assert.rejects(read(r, { ...registryFixtureIo(), open: async () => { throw new Error("native secret"); } }), unavailable);
    let closed = 0;
    const io = interceptHandle(registryFixtureIo(), (handle) => ({
      read: (async () => { await handle.close(); return handle.read(Buffer.alloc(1), 0, 1, 0); }) as FileHandle["read"],
      close: async () => { closed++; await handle.close(); },
    }));
    await assert.rejects(read(r, io), unavailable);
    assert.equal(closed, 1);
  } finally { r.close(); }
});

test("file growth and truncation during native reads are rejected", async () => {
  for (const bytes of [Buffer.alloc(1), Buffer.alloc(512 * 1024)]) {
    const r = registryFixture(encode(entry()));
    try {
      let changedFile = false;
      const io = interceptHandle(registryFixtureIo(), (handle) => ({
        read: (async (...args: Parameters<FileHandle["read"]>) => {
          if (!changedFile) { changedFile = true; writeFileSync(r.file, bytes); }
          return handle.read(...args);
        }) as FileHandle["read"],
      }));
      await assert.rejects(read(r, io), unavailable);
    } finally { r.close(); }
  }
});

test("exact size and size plus one use bounded native IO and reject invalid oversized content", async () => {
  for (const size of [256 * 1024, 256 * 1024 + 1, 512 * 1024]) {
    const bytes = Buffer.alloc(size, 0x20);
    const r = registryFixture(bytes);
    try {
      let readBytes = 0;
      const io = interceptHandle(registryFixtureIo(), (handle) => ({
        read: (async (...args: Parameters<FileHandle["read"]>) => {
          const result = await handle.read(...args);
          readBytes += result.bytesRead;
          return result;
        }) as FileHandle["read"],
      }));
      await assert.rejects(read(r, io), unavailable);
      assert.ok(readBytes <= 256 * 1024 + 1);
      assert.equal(readBytes, Math.min(size, 256 * 1024 + 1));
      assert.throws(() => selectRunnerKey(bytes, f.context, now), unavailable);
    } finally { r.close(); }
  }
});

test("real path replacement before open and during read cannot match the original descriptor", async () => {
  for (const moment of ["open", "read"] as const) {
    const r = registryFixture(encode(entry()));
    try {
      const native = registryFixtureIo();
      let replaced = false;
      let io: RunnerRegistryIo;
      if (moment === "open") {
        io = { ...native, open: async (...args) => { r.replace(encode(entry())); return native.open(...args); } };
      } else {
        io = interceptHandle(native, (handle) => ({
          read: (async (...args: Parameters<FileHandle["read"]>) => {
            if (!replaced) { replaced = true; r.replace(encode(entry())); }
            return handle.read(...args);
          }) as FileHandle["read"],
        }));
      }
      await assert.rejects(read(r, io), unavailable);
    } finally { r.close(); }
  }
});

test("a raced real symlink is not followed and raced FIFO open uses nonblocking flags", async () => {
  for (const kind of ["symlink", "fifo"] as const) {
    const r = registryFixture(encode(entry()));
    try {
      const native = registryFixtureIo();
      let observedFlags: number | undefined;
      const io: RunnerRegistryIo = { ...native, open: async (path, flags, mode) => {
        observedFlags = typeof flags === "number" ? flags : undefined;
        // Keep a broken blocking-open implementation from hanging the test process.
        if (typeof flags !== "number" || !(flags & constants.O_NONBLOCK)) throw new Error("unsafe open");
        renameSync(r.file, join(r.directory, "original.json"));
        if (kind === "symlink") symlinkSync("original.json", r.file);
        else execFileSync("mkfifo", ["-m", "600", r.file]);
        return native.open(path, flags, mode);
      } };
      await assert.rejects(read(r, io), unavailable);
      assert.equal(typeof observedFlags, "number");
      assert.equal(observedFlags! & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
      assert.equal(observedFlags! & constants.O_NONBLOCK, constants.O_NONBLOCK);
      assert.equal(observedFlags! & (constants.O_WRONLY | constants.O_RDWR), constants.O_RDONLY);
    } finally { r.close(); }
  }
});

test("real registry-directory replacement during read fails", async () => {
  const r = registryFixture(encode(entry()));
  try {
    let replaced = false;
    const io = interceptHandle(registryFixtureIo(), (handle) => ({
      read: (async (...args: Parameters<FileHandle["read"]>) => {
        if (!replaced) {
          replaced = true;
          renameSync(r.directory, r.directory + "-old");
          mkdirSync(r.directory, { mode: 0o700 });
          writeFileSync(r.file, encode(entry()), { mode: 0o600, flag: "wx" });
        }
        return handle.read(...args);
      }) as FileHandle["read"],
    }));
    await assert.rejects(read(r, io), unavailable);
  } finally { r.close(); }
});

test("every protected descriptor snapshot field and exact byte size are enforced (injected races)", async () => {
  const r = registryFixture(encode(entry()));
  try {
    for (const field of ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const) {
      let snapshots = 0;
      const io = interceptHandle(registryFixtureIo(), (handle) => ({
        stat: (async () => {
          const stat = await handle.stat({ bigint: true });
          return ++snapshots === 2 ? changed(stat, { [field]: stat[field] + 1n }) : stat;
        }) as FileHandle["stat"],
      }));
      await assert.rejects(read(r, io), unavailable, field);
    }
    // Stable fabricated size on all path/fd snapshots still cannot match bytes read.
    const native = registryFixtureIo();
    const io = interceptHandle({ ...native, lstat: (async (path, options) => {
      const stat = await native.lstat(path, options);
      return String(path) === r.file ? changed(stat as BigIntStats, { size: (stat as BigIntStats).size + 1n }) : stat;
    }) as RunnerRegistryIo["lstat"] }, (handle) => ({ stat: (async () => {
      const stat = await handle.stat({ bigint: true });
      return changed(stat, { size: stat.size + 1n });
    }) as FileHandle["stat"] }));
    await assert.rejects(read(r, io), unavailable);
  } finally { r.close(); }
});

test("directory identity, ownership and mode snapshots are rechecked after reading (injected races)", async () => {
  const r = registryFixture(encode(entry()));
  try {
    for (const path of [r.directory, dirname(r.directory)]) {
      for (const field of ["dev", "ino", "uid", "mode"] as const) {
        const native = registryFixtureIo();
        let snapshots = 0;
        const io: RunnerRegistryIo = { ...native, lstat: (async (name, options) => {
          const stat = await native.lstat(name, options);
          if (String(name) !== path || ++snapshots === 1) return stat;
          return changed(stat as BigIntStats, { [field]: (stat as BigIntStats)[field] + 1n });
        }) as RunnerRegistryIo["lstat"] };
        await assert.rejects(read(r, io), unavailable, `${path}: ${field}`);
      }
    }
  } finally { r.close(); }
});

test("delayed open is rejected at deadline and the late real descriptor is closed", async () => {
  const r = registryFixture(encode(entry()));
  let release!: () => void;
  let entered!: () => void;
  const opening = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const d = deadline();
  let nativeHandle: FileHandle | undefined;
  try {
    const native = registryFixtureIo();
    const io: RunnerRegistryIo = { ...native, open: async (...args) => {
      nativeHandle = await native.open(...args);
      entered();
      await held;
      return nativeHandle;
    } };
    const pending = readRunnerKeyRegistryWithIo(r.directory, r.policy, f.context, d, io, process.geteuid!());
    await opening;
    assert.throws(() => d.cap(now), /expired/);
    await assert.rejects(pending, (error: unknown) => error instanceof RunnerEvidenceError && error.code === "expired");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(nativeHandle!.stat(), { code: "EBADF" });
  } finally { release?.(); await nativeHandle?.close(); d.close(); r.close(); }
});

test("finish-time key expiry uses the deadline wall clock, not read-start time", async () => {
  const r = registryFixture(encode({ ...entry(), validUntil: now + 10 }));
  let wall = now;
  const d = createRunnerEvidenceDeadline({ wallNow: () => wall, monotonicNow: () => 0 }, now + 1000);
  try {
    const io = interceptHandle(registryFixtureIo(), (handle) => ({
      read: (async (...args: Parameters<FileHandle["read"]>) => { wall = now + 10; return handle.read(...args); }) as FileHandle["read"],
    }));
    await assert.rejects(readRunnerKeyRegistryWithIo(r.directory, r.policy, f.context, d, io, process.geteuid!()), unavailable);
  } finally { d.close(); r.close(); }
});
