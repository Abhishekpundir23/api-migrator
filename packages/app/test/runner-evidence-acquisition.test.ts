import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { FileHandle } from "node:fs/promises";
import { canonicalJson } from "../src/canonical-json.js";
import {
  RunnerEvidenceError, validateRunnerEvidenceContext,
  type RunnerEvidenceContext, type RunnerEvidenceResult, type RetainedRunnerEvidenceIdentity,
} from "../src/runner-evidence-contract.js";
import { createRunnerEvidenceClientWithDependencies, type RunnerEvidenceDependencies } from "../src/runner-evidence-core.js";
import { createRunnerEvidenceClient } from "../src/runner-evidence.js";
import type { RunnerEvidenceDeadline } from "../src/runner-evidence-deadline.js";
import { selectRunnerKey, readRunnerKeyRegistryWithIo, type RunnerKeyEntry, type RunnerRegistryIo } from "../src/runner-key-registry.js";
import { createRunnerEvidenceTransport } from "../src/runner-evidence-transport.js";
import { assertVerifiedPublicationRunnerAttestation, verifyPublicationRunnerAttestation, createPublicationRunnerPlan } from "../src/publication-runner.js";
import { runnerEvidenceFixture } from "./helpers/runner-evidence-fixture.js";
import { fixtureDigest, publicationRunnerPlanInput, publicationRunnerTrustPair, signedPublicationRunnerEnvelope } from "./helpers/publication-runner-fixture.js";
import { registryFixture, registryFixtureIo, tlsEvidenceFixture } from "./helpers/runner-evidence-io-fixture.js";

const now = 2_000_000_000_000;
let f: ReturnType<typeof runnerEvidenceFixture>;
before(() => { f = runnerEvidenceFixture(now); });
after(() => f.close());
const entry = (): RunnerKeyEntry => ({ ...f.trust, pilotId: f.context.plan.plan.subject.pilotId, repository: { ...f.context.source.repository } });
const encode = (...keys: unknown[]) => Buffer.from(canonicalJson({ schemaVersion: 1, keys }));
function success(result: RunnerEvidenceResult, observedAt = now) {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected successful fixture acquisition");
  assert.equal(assertVerifiedPublicationRunnerAttestation(result.verified, observedAt), result.verified);
  return result;
}
function harness(overrides: Partial<RunnerEvidenceDependencies> = {}) {
  const state = { wall: now, monotonic: 0, reads: 0, fetches: 0, bytes: encode(entry()) as Buffer, envelope: f.envelope };
  const budgets: RunnerEvidenceDeadline[] = [];
  const dependencies: RunnerEvidenceDependencies = {
    clock: { wallNow: () => state.wall, monotonicNow: () => state.monotonic },
    async readKey(context, deadline) {
      state.reads++;
      budgets.push(deadline);
      return selectRunnerKey(state.bytes, context, deadline.check());
    },
    async fetchEnvelope(jobId, deadline) {
      assert.equal(jobId, f.context.plan.plan.job.id);
      state.fetches++;
      budgets.push(deadline);
      return state.envelope;
    },
    ...overrides,
  };
  return { state, budgets, client: createRunnerEvidenceClientWithDependencies(dependencies) };
}

test("reacquisition reads twice again and returns a fresh genuine capability without renewal", async () => {
  const h = harness();
  const first = success(await h.client.acquireInitial(f.context));
  h.state.wall += 100;
  const second = success(await h.client.reacquire(f.context, first.identity), h.state.wall);
  assert.deepEqual(second.identity, first.identity);
  assert.notEqual(second.verified, first.verified);
  assert.throws(() => assertVerifiedPublicationRunnerAttestation({ ...second.verified }, now));
  assert.equal(first.identity.expiresAt, now + 599_500);
  assert.equal(h.state.reads, 4);
  assert.equal(h.state.fetches, 2);
  assert.equal(new Set(h.budgets.slice(0, 3)).size, 1);
  assert.equal(new Set(h.budgets.slice(3)).size, 1);
  assert.notEqual(h.budgets[0], h.budgets[3]);
  assert.throws(() => h.budgets[0]!.check());
  for (const object of [first, first.identity, second, second.identity]) assert.ok(Object.isFrozen(object));
});

test("malformed or expired expectations reject before any dependency call", async () => {
  for (const [context, code] of [
    [null, "expected_context_invalid"],
    [{ ...f.context, previewCompletedAt: now + 1 }, "expected_context_invalid"],
    [{ ...f.context, campaignId: "secret/token" }, "expected_context_invalid"],
  ] as const) {
    const h = harness();
    assert.deepEqual(await h.client.acquireInitial(context), { ok: false, code });
    assert.equal(h.state.reads + h.state.fetches, 0);
  }
  const h = harness();
  h.state.wall = now + 599_500;
  assert.deepEqual(await h.client.acquireInitial(f.context), { ok: false, code: "expired" });
  assert.equal(h.state.reads + h.state.fetches, 0);
});

test("every retained field is independently rejected when mutated after genuine success", async (t) => {
  const mutations: Record<keyof RetainedRunnerEvidenceIdentity, unknown> = {
    schemaVersion: 2, contextDigest: fixtureDigest("other-context"),
    jobId: `previewjob_${"a".repeat(64)}`, planDigest: fixtureDigest("other-plan"),
    attestationPayloadDigest: fixtureDigest("other-payload"), attestationEnvelopeDigest: fixtureDigest("other-envelope"),
    signerKeyId: "other-key", signerFingerprint: fixtureDigest("other-key"),
    signerTrustDigest: fixtureDigest("other-trust"), expiresAt: now + 599_499,
  };
  for (const [field, value] of Object.entries(mutations)) await t.test(field, async () => {
    const h = harness();
    const first = success(await h.client.acquireInitial(f.context));
    const mutated = { ...first.identity, [field]: value };
    assert.deepEqual(await h.client.reacquire(f.context, mutated), {
      ok: false, code: field === "schemaVersion" ? "expected_context_invalid" : "identity_changed",
    });
    if (["schemaVersion", "contextDigest", "jobId", "planDigest"].includes(field)) {
      assert.equal(h.state.reads, 2);
      assert.equal(h.state.fetches, 1);
    }
  });
});

function leaves(value: unknown, path: string[] = []): string[][] {
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]));
  return [path];
}
function changeLeaf(root: unknown, path: string[], value: unknown) {
  let target = root as Record<string, unknown>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[path.at(-1)!] = value;
}

test("each context leaf is independently validated before I/O", async (t) => {
  for (const path of leaves(f.context)) await t.test(path.join("."), async () => {
    const h = harness();
    const first = success(await h.client.acquireInitial(f.context));
    const context = structuredClone(f.context);
    changeLeaf(context, path, null);
    assert.deepEqual(await h.client.reacquire(context, first.identity), { ok: false, code: "expected_context_invalid" });
    assert.equal(h.state.reads, 2);
    assert.equal(h.state.fetches, 1);
  });
});

test("valid changed campaign, run, tree and completion cannot reuse retained identity", async (t) => {
  const cases: Array<[string, (context: RunnerEvidenceContext) => void]> = [
    ["campaign", (c) => { c.campaignId = "campaign_other"; }],
    ["run", (c) => { c.runId = "run_other"; }],
    ["tree", (c) => { c.source.base.treeSha = "4".repeat(40); }],
    ["completion", (c) => { c.previewCompletedAt--; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const h = harness();
    const first = success(await h.client.acquireInitial(f.context));
    const context = structuredClone(f.context);
    mutate(context);
    assert.doesNotThrow(() => validateRunnerEvidenceContext(context, now));
    assert.deepEqual(await h.client.reacquire(context, first.identity), { ok: false, code: "identity_changed" });
    assert.equal(h.state.reads, 2);
  });
});

test("fresh valid job and source plans are identity changes, not malformed contexts", async (t) => {
  for (const field of ["job", "repository", "base", "manifest", "archive"] as const) await t.test(field, async () => {
    const h = harness();
    const first = success(await h.client.acquireInitial(f.context));
    const context = structuredClone(f.context);
    const input = publicationRunnerPlanInput(context.plan.plan.job.createdAt);
    input.repository = { ...context.source.repository };
    input.base = { branch: context.source.base.branch, sha: context.source.base.sha };
    input.manifestDigest = context.source.manifestDigest;
    input.sourceArchiveDigest = context.source.sourceArchiveDigest;
    input.expiresAt = context.plan.plan.job.expiresAt;
    if (field === "repository") input.repository = context.source.repository = { ...input.repository, id: 42 };
    if (field === "base") { input.base.sha = "5".repeat(40); context.source.base.sha = input.base.sha; }
    if (field === "manifest") input.manifestDigest = context.source.manifestDigest = fixtureDigest("changed-manifest");
    if (field === "archive") input.sourceArchiveDigest = context.source.sourceArchiveDigest = fixtureDigest("changed-archive");
    context.plan = createPublicationRunnerPlan(input);
    assert.notEqual(context.plan.plan.job.id, f.context.plan.plan.job.id);
    assert.doesNotThrow(() => validateRunnerEvidenceContext(context, now));
    assert.deepEqual(await h.client.reacquire(context, first.identity), { ok: false, code: "identity_changed" });
    assert.equal(h.state.reads, 2);
  });
});

test("different genuinely verified signed evidence for the exact job is not reacquisition", async () => {
  const h = harness();
  const first = success(await h.client.acquireInitial(f.context));
  const changed = { ...f.payload, runnerInstanceDigest: fixtureDigest("replacement-runner") };
  const replacement = f.signPayload(changed);
  assertVerifiedPublicationRunnerAttestation(verifyPublicationRunnerAttestation(replacement, f.context.plan, f.context.reviewedOutput, f.trust, now), now);
  h.state.envelope = replacement;
  assert.deepEqual(await h.client.reacquire(f.context, first.identity), { ok: false, code: "identity_changed" });
});

test("invalid signed output, malformed envelopes and non-authoritative reports cannot mint a capability", async (t) => {
  const pair = publicationRunnerTrustPair(now - 105_000);
  const genuine = verifyPublicationRunnerAttestation(f.envelope, f.context.plan, f.context.reviewedOutput, f.trust, now);
  const cases: Array<[string, string, Buffer?]> = [
    ["altered output", f.signPayload({ ...f.payload, output: { ...f.payload.output, artifactDigest: fixtureDigest("altered") } })],
    ["malformed JSON", "sensitive invalid JSON"],
    ["noncanonical JSON", `${f.envelope}\n`],
    // Deliberately invoke the signing helper outside its literal-domain type.
    ["wrong domain", Reflect.apply(signedPublicationRunnerEnvelope, undefined, [f.payload, pair.privateKey, pair.trust.keyId, "wrong-domain"]), encode({ ...entry(), ...pair.trust })],
    ["forged capability", canonicalJson({ ...genuine })],
    ["local receipt", canonicalJson({ schemaVersion: 2, kind: "local-preview", source: f.context.source })],
    ["future v3", canonicalJson({ schemaVersion: 3, kind: "attested-preview", attestation: f.payload })],
    ["container report", canonicalJson(f.payload)],
  ];
  for (const [label, envelope, bytes] of cases) await t.test(label, async () => {
    const h = harness();
    success(await h.client.acquireInitial(f.context));
    h.state.envelope = envelope;
    if (bytes) h.state.bytes = bytes;
    assert.deepEqual(await h.client.acquireInitial(f.context), { ok: false, code: "evidence_invalid" });
  });
});

test("selected policy races during fetch fail before granting authority", async (t) => {
  for (const field of ["removed", "revoked", "rotated", "validity"] as const) await t.test(field, async () => {
    const h = harness({ async fetchEnvelope() {
      h.state.fetches++;
      h.state.bytes = field === "removed" ? encode() : encode({ ...entry(),
        ...(field === "revoked" ? { revokedAt: now } : field === "rotated" ? publicationRunnerTrustPair(now - 105_000).trust : { validUntil: f.trust.validUntil - 1 }),
      });
      return f.envelope;
    } });
    assert.deepEqual(await h.client.acquireInitial(f.context), { ok: false, code: "trust_unavailable" });
    assert.equal(h.state.reads, 2);
    assert.equal(h.state.fetches, 1);
  });
});

test("fresh key reads catch between-call removal, revocation, rotation and validity changes", async (t) => {
  for (const field of ["removed", "revoked", "rotated", "validity"] as const) await t.test(field, async () => {
    const h = harness();
    const first = success(await h.client.acquireInitial(f.context));
    let next = entry();
    if (field === "rotated") {
      const pair = publicationRunnerTrustPair(now - 105_000);
      next = { ...next, ...pair.trust, keyId: "rotated-key" };
      h.state.envelope = signedPublicationRunnerEnvelope(f.payload, pair.privateKey, next.keyId);
      assertVerifiedPublicationRunnerAttestation(verifyPublicationRunnerAttestation(h.state.envelope, f.context.plan, f.context.reviewedOutput, { ...pair.trust, keyId: next.keyId }, now), now);
    }
    if (field === "revoked") next.revokedAt = now;
    if (field === "validity") next.validUntil--;
    h.state.bytes = field === "removed" ? encode() : encode(next);
    assert.deepEqual(await h.client.reacquire(f.context, first.identity), {
      ok: false, code: field === "removed" || field === "revoked" ? "trust_unavailable" : "identity_changed",
    });
  });
});

test("caller mutation during the first blocked await cannot change either operation snapshot", async () => {
  let release!: () => void;
  let blocked = false;
  const h = harness({ async readKey(context, deadline) {
    h.state.reads++;
    if (blocked) await new Promise<void>((resolve) => { release = resolve; });
    assert.ok(Object.isFrozen(context.source.base));
    return selectRunnerKey(h.state.bytes, context, deadline.check());
  } });
  const first = success(await h.client.acquireInitial(f.context));
  for (const kind of ["initial", "reacquire"]) {
    const context = structuredClone(f.context);
    const identity = { ...first.identity };
    blocked = true;
    const pending = kind === "initial" ? h.client.acquireInitial(context) : h.client.reacquire(context, identity);
    // A microtask lets the already-budgeted dependency enter its controlled await.
    await delay(0);
    context.campaignId = "changed";
    context.source.base.treeSha = "6".repeat(40);
    context.plan.plan.job.id = `previewjob_${"7".repeat(64)}`;
    identity.attestationPayloadDigest = fixtureDigest("changed-caller-identity");
    blocked = false;
    release();
    assert.deepEqual(success(await pending).identity, first.identity);
  }
});

test("same evidence succeeds repeatedly until exact retained preview expiry, never renews", async () => {
  const h = harness();
  const first = success(await h.client.acquireInitial(f.context));
  for (const elapsed of [1, 100_000, 599_499]) {
    h.state.wall = now + elapsed;
    assert.deepEqual(success(await h.client.reacquire(f.context, first.identity), h.state.wall).identity, first.identity);
  }
  const reads = h.state.reads;
  h.state.wall = now + 599_500;
  assert.deepEqual(await h.client.reacquire(f.context, first.identity), { ok: false, code: "expired" });
  assert.equal(h.state.reads, reads);
  // The verifier's hidden plan/key lifetime is deliberately not rebranded by the
  // client: retained preview expiry is a separate, shorter acquisition deadline.
  assert.equal(assertVerifiedPublicationRunnerAttestation(first.verified, h.state.wall), first.verified);
});

test("retained expiry and selected key expiry cap the whole operation", async () => {
  const h = harness();
  const first = success(await h.client.acquireInitial(f.context));
  assert.deepEqual(await h.client.reacquire(f.context, { ...first.identity, expiresAt: now }), { ok: false, code: "expired" });
  assert.equal(h.state.reads, 2);
  h.state.bytes = encode({ ...entry(), validUntil: now + 1 });
  const short = success(await h.client.acquireInitial(f.context));
  assert.equal(short.identity.expiresAt, now + 1);
  h.state.wall++;
  assert.deepEqual(await h.client.reacquire(f.context, short.identity), { ok: false, code: "expired" });
});

test("preview, plan, key and retained lifetimes each abort a stalled whole fetch", async (t) => {
  for (const cap of ["preview", "plan", "key", "retained"] as const) await t.test(cap, async () => {
    let blocked = false;
    let release: (() => void) | undefined;
    const h = harness({ async fetchEnvelope() {
      if (blocked) await new Promise<void>((resolve) => { release = resolve; });
      return f.envelope;
    } });
    const first = success(await h.client.acquireInitial(f.context));
    const context = structuredClone(f.context);
    const retained = { ...first.identity };
    if (cap === "preview") h.state.wall = now + 599_470;
    if (cap === "retained") retained.expiresAt = now + 30;
    if (cap === "key") h.state.bytes = encode({ ...entry(), validUntil: now + 30 });
    if (cap === "plan") {
      const input = publicationRunnerPlanInput(context.plan.plan.job.createdAt);
      input.repository = { ...context.source.repository };
      input.base = { branch: context.source.base.branch, sha: context.source.base.sha };
      input.manifestDigest = context.source.manifestDigest;
      input.sourceArchiveDigest = context.source.sourceArchiveDigest;
      input.expiresAt = now + 30;
      context.plan = createPublicationRunnerPlan(input);
      assert.doesNotThrow(() => validateRunnerEvidenceContext(context, now));
    }
    blocked = true;
    const timeout = new AbortController();
    try {
      const pending = cap === "plan" ? h.client.acquireInitial(context) : h.client.reacquire(context, retained);
      const result = await Promise.race([pending, delay(1_000, "stalled", { signal: timeout.signal }).catch(() => "cancelled")]);
      assert.deepEqual(result, { ok: false, code: "expired" });
    } finally {
      timeout.abort();
      release?.();
    }
  });
});

test("late first/second key reads and envelope resolution cannot return success", async (t) => {
  for (const stage of ["first", "fetch", "second"] as const) await t.test(stage, async () => {
    const h = harness({
      async readKey(context, deadline) {
        h.state.reads++;
        const result = selectRunnerKey(h.state.bytes, context, deadline.check());
        if ((stage === "first" && h.state.reads === 1) || (stage === "second" && h.state.reads === 2)) h.state.wall += 10_000;
        return result;
      },
      async fetchEnvelope() { h.state.fetches++; if (stage === "fetch") h.state.monotonic = 10_000; return f.envelope; },
    });
    assert.deepEqual(await h.client.acquireInitial(f.context), { ok: false, code: "expired" });
    assert.equal(h.state.fetches, stage === "first" ? 0 : 1);
  });
});

test("the verifier brands capabilities at the checked finish time, not the operation start", async () => {
  const h = harness({ async readKey(context, deadline) {
    h.state.reads++;
    const key = selectRunnerKey(h.state.bytes, context, deadline.check());
    if (h.state.reads === 2) h.state.wall += 100;
    return key;
  } });
  const result = success(await h.client.acquireInitial(f.context), now + 100);
  assert.throws(() => assertVerifiedPublicationRunnerAttestation(result.verified, now));
  assert.equal(result.identity.expiresAt, now + 599_500);
});

test("expiry reached immediately after verification still prevents returning authority", async () => {
  let finishChecks = 0;
  let secondReadDone = false;
  const h = harness({
    clock: {
      // After the second dependency resolves: run's check, cap's check, verifier
      // timestamp, then the post-verification check. Only that last one expires.
      wallNow: () => secondReadDone && ++finishChecks >= 4 ? now + 10_000 : now,
      monotonicNow: () => 0,
    },
    async readKey(context, deadline) {
      h.state.reads++;
      const key = selectRunnerKey(h.state.bytes, context, deadline.check());
      if (h.state.reads === 2) secondReadDone = true;
      return key;
    },
  });
  assert.deepEqual(await h.client.acquireInitial(f.context), { ok: false, code: "expired" });
  assert.equal(h.state.reads, 2);
  assert.equal(finishChecks, 4);
});

test("whole dependency promises time out even when cleanup or transport ignores cancellation", async (t) => {
  for (const stage of ["first", "fetch", "second"] as const) await t.test(stage, async () => {
    let release!: () => void;
    let observedBudget!: RunnerEvidenceDeadline;
    const h = harness({
      async readKey(context, deadline) {
        h.state.reads++;
        const selected = selectRunnerKey(h.state.bytes, context, deadline.check());
        if ((stage === "first" && h.state.reads === 1) || (stage === "second" && h.state.reads === 2)) {
          observedBudget = deadline;
          deadline.cap(now + 30);
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return selected;
      },
      async fetchEnvelope(_job, deadline) {
        if (stage === "fetch") {
          observedBudget = deadline;
          deadline.cap(now + 30);
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return f.envelope;
      },
    });
    const timeout = new AbortController();
    const result = await Promise.race([
      h.client.acquireInitial(f.context),
      delay(1_000, "stalled", { signal: timeout.signal }).catch(() => "cancelled"),
    ]);
    timeout.abort();
    assert.deepEqual(result, { ok: false, code: "expired" });
    assert.equal(observedBudget.signal.aborted, true);
    release();
    await delay(0);
  });
});

test("operation boundaries serialize only safe local codes, never sensitive exception data", async (t) => {
  const secret = "TOKEN=private-auth /secret/workspace raw-key-material";
  for (const [stage, error, code] of [
    ["read", new Error(secret), "trust_unavailable"],
    ["read", { code: "identity_changed", message: secret }, "trust_unavailable"],
    ["fetch", new Error(secret), "evidence_unavailable"],
    ["fetch", { code: "expired", message: secret }, "evidence_unavailable"],
    ["fetch", new RunnerEvidenceError("evidence_invalid"), "evidence_invalid"],
    ["fetch", new RunnerEvidenceError("expired"), "expired"],
  ] as const) await t.test(`${stage} ${code} ${error instanceof Error}`, async () => {
    const h = harness(stage === "read" ? { async readKey() { throw error; } } : { async fetchEnvelope() { throw error; } });
    const result = await h.client.acquireInitial(f.context);
    assert.deepEqual(result, { ok: false, code });
    assert.deepEqual(Object.keys(result).sort(), ["code", "ok"]);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.ok(Object.isFrozen(result));
  });
});

test("production construction detaches validated configuration without I/O or environment activation", () => {
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import promises from 'node:fs/promises';
    import https from 'node:https';
    import { syncBuiltinESMExports } from 'node:module';
    let io = 0;
    for (const method of ['lstat', 'realpath', 'open']) promises[method] = async () => { io++; throw Error('sensitive'); };
    https.request = () => { io++; throw Error('sensitive'); };
    syncBuiltinESMExports();
    const { createRunnerEvidenceClient } = await import('./packages/app/src/runner-evidence.ts');
    // Node's module loader legitimately resolves source files with realpathSync;
    // install synchronous filesystem traps only after that import completes.
    for (const method of ['statSync', 'lstatSync', 'realpathSync']) fs[method] = () => { io++; throw Error('sensitive'); };
    syncBuiltinESMExports();
    const config = { serviceOrigin: 'https://evidence.example.invalid', serviceAddresses: ['93.184.216.34'], serviceTlsSpkiDigest: 'sha256:' + 'a'.repeat(64), registryDirectory: '/missing-registry' };
    const policy = { migrationWorkspaceRoots: ['/missing-workspace'] };
    const result = createRunnerEvidenceClient(config, policy);
    assert.equal(result.ok, true);
    assert.equal(io, 0);
    config.serviceAddresses[0] = '127.0.0.1';
    policy.migrationWorkspaceRoots.push('/');
    assert.equal(Object.isFrozen(result.client), true);
    assert.deepEqual(await result.client.acquireInitial(null), { ok: false, code: 'expected_context_invalid' });
    assert.equal(io, 0);
    assert.deepEqual(createRunnerEvidenceClient(undefined, undefined), { ok: false, code: 'configuration_invalid' });
    assert.equal(io, 0);
  `;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, RUNNER_EVIDENCE_ENABLED: "true", RUNNER_EVIDENCE_SERVICE_ORIGIN: "https://secret.invalid" },
  });
  assert.deepEqual(createRunnerEvidenceClient({}, {}), { ok: false, code: "configuration_invalid" });
});

test("production factory rejects extra positional clock, CA, port or dependency arguments", async (t) => {
  const config = { serviceOrigin: "https://evidence.example.invalid", serviceAddresses: ["93.184.216.34"],
    serviceTlsSpkiDigest: `sha256:${"a".repeat(64)}`, registryDirectory: "/missing-registry" };
  const policy = { migrationWorkspaceRoots: ["/missing-workspace"] };
  assert.equal(createRunnerEvidenceClient(config, policy).ok, true);
  for (const [label, extra] of [
    ["clock", { wallNow: () => now, monotonicNow: () => 0 }],
    ["CA", { ca: "sensitive-test-CA" }], ["port", 8443],
    ["dependencies", { readKey: () => { throw new Error("sensitive"); } }],
    ["explicit undefined", undefined],
  ] as const) await t.test(label, () => {
    assert.deepEqual(Reflect.apply(createRunnerEvidenceClient, undefined, [config, policy, extra]), {
      ok: false, code: "configuration_invalid",
    });
  });
});

test("production policy uses module checkout and detached mandatory roots plus code-owned optional roots", () => {
  const script = `
    import assert from 'node:assert/strict';
    import promises from 'node:fs/promises';
    import https from 'node:https';
    import { tmpdir } from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    const paths = [];
    let stats = 0;
    let network = 0;
    promises.realpath = async (path) => {
      paths.push(path);
      if (path === '/run') throw Object.assign(new Error('sensitive'), { code: 'ENOENT' });
      return path;
    };
    promises.lstat = async () => { stats++; throw new Error('stop after observing exclusions'); };
    https.request = () => { network++; throw new Error('network must not start'); };
    syncBuiltinESMExports();
    const { createRunnerEvidenceClient } = await import('./packages/app/src/runner-evidence.ts');
    Date.now = () => ${now};
    const context = ${JSON.stringify(f.context)};
    const config = { serviceOrigin: 'https://evidence.example.invalid', serviceAddresses: ['93.184.216.34'], serviceTlsSpkiDigest: 'sha256:' + 'a'.repeat(64), registryDirectory: '/protected-registry-fixture' };
    const policy = { migrationWorkspaceRoots: ['/migration-workspace-fixture'] };
    const first = createRunnerEvidenceClient(config, policy);
    assert.equal(first.ok, true);
    config.registryDirectory = '/';
    config.serviceAddresses[0] = '127.0.0.1';
    policy.migrationWorkspaceRoots[0] = '/';
    assert.deepEqual(await first.client.acquireInitial(context), { ok: false, code: 'trust_unavailable' });
    assert.deepEqual(paths, [process.cwd(), '/migration-workspace-fixture', ...new Set([tmpdir(), '/tmp', '/var/tmp', '/run'])]);
    assert.equal(stats, 1);
    assert.equal(network, 0);
    paths.length = 0;
    const second = createRunnerEvidenceClient({ ...config, serviceAddresses: ['93.184.216.34'], registryDirectory: '/protected-registry-fixture' }, { migrationWorkspaceRoots: ['/run'] });
    assert.equal(second.ok, true);
    assert.deepEqual(await second.client.acquireInitial(context), { ok: false, code: 'trust_unavailable' });
    assert.deepEqual(paths, [process.cwd(), '/run']);
    assert.equal(stats, 1); // Required /run ENOENT was not made optional by duplication.
    assert.equal(network, 0);
  `;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, TMPDIR: "/tmp" },
  });
});

test("real protected registry reads, pinned TLS requests and signatures compose, including actual atomic revocation", async () => {
  const registry = registryFixture(encode(entry()));
  const tls = await tlsEvidenceFixture(f.envelope);
  const transport = createRunnerEvidenceTransport(tls.request);
  const nativeIo = registryFixtureIo();
  let reads = 0;
  let opens = 0;
  let closes = 0;
  const io: RunnerRegistryIo = { ...nativeIo, open: (async (...args: Parameters<RunnerRegistryIo["open"]>) => {
    const handle = await nativeIo.open(...args);
    opens++;
    const close = handle.close.bind(handle);
    handle.close = async () => { try { await close(); } finally { closes++; } };
    return handle as FileHandle;
  }) as RunnerRegistryIo["open"] };
  const client = createRunnerEvidenceClientWithDependencies({
    clock: { wallNow: () => now, monotonicNow: () => performance.now() },
    async readKey(context, deadline) {
      reads++;
      return readRunnerKeyRegistryWithIo(registry.directory, registry.policy, context, deadline, io, process.geteuid!());
    },
    fetchEnvelope: (jobId, deadline) => transport(tls.config, jobId, deadline),
  });
  try {
    const first = success(await client.acquireInitial(f.context));
    const second = success(await client.reacquire(f.context, first.identity));
    assert.deepEqual(second.identity, first.identity);
    assert.notEqual(second.verified, first.verified);
    assert.equal(reads, 4);
    assert.equal(opens, 4);
    assert.equal(closes, opens);
    assert.equal(tls.requests.length, 2);
    for (const request of tls.requests) {
      assert.equal(request.path, `/v1/runner-evidence/${f.context.plan.plan.job.id}`);
      assert.equal(request.method, "GET");
    }
    registry.replace(encode({ ...entry(), revokedAt: now }));
    assert.deepEqual(await client.reacquire(f.context, first.identity), { ok: false, code: "trust_unavailable" });
    assert.equal(reads, 5);
    assert.equal(tls.requests.length, 2);
    assert.equal(closes, opens);
  } finally {
    await tls.close();
    assert.equal(tls.activeSockets(), 0);
    registry.close();
  }
});
