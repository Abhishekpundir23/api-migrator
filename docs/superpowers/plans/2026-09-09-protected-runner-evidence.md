# Protected Runner Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only server client that fetches an exact job's signed evidence, checks current protected trust, and returns the existing verified capability without enabling publication.

**Architecture:** Separate strict input/identity contracts, a shared deadline, protected registry reading, bounded pinned HTTPS transport, and acquisition orchestration. Only the production factory enters a new server-internal package subpath; dependency injection stays in unexported implementation modules. Existing signature bytes, local receipts, owner authorization, and console gates are preserved.

**Tech Stack:** TypeScript ESM, Node 22, built-in crypto/HTTPS/filesystem APIs, `node:test` with existing `tsx`, existing npm workspaces and Docker verification. No new runtime dependencies.

**Spec:** [Approved design](../specs/2026-09-09-protected-runner-evidence-design.md).

## Global Constraints

- "No cloud provisioning, paid-service activation, real signing keys, or changes to the GitHub App's installation scope. No Dynamo, Toloka, or client assets."
- "No remote job creation, source upload, migration execution, write-token request, owner challenge, approval consumption, publication, or merge."
- "Local `preview-v1`/`preview-v2` receipts do not become attested receipts. Reserved `preview-v3` remains unimplemented and rejected in this slice."
- "Keep `RUNNER_CAPABILITY_PROVIDER_AVAILABLE = false` and the unconditional three-action server gate. No environment-variable bypass is introduced."
- "Node 22 compatibility remains mandatory."
- "Do not package acquisition, network configuration, or registry reading into the credential-free runner image or its `runner-internal` export."
- Configuration is server-owned: HTTPS DNS origin, port 443, 1-32 exact global-unicast addresses, TLS SPKI SHA-256 pin, and protected registry directory. No credentials, redirects, DNS, retries, discovery, or proxy fallback.
- Response limits: 128 KiB envelope, 16 KiB headers, HTTP 200, exact canonical UTF-8 JSON, absent `Content-Encoding`, no trailers. Registry: 256 KiB, 1-128 entries, canonical UTF-8, owner-only POSIX directory/file.
- Acquisition budget: 10 seconds total, capped by preview completion + ten minutes, plan validity, selected key validity, and retained expiry. No late success, renewal, or reuse of cached trust/capabilities.
- Same still-valid exact evidence can be reacquired; any changed context, signed envelope, selected key policy, or original expiry is not a retry.
- Tests use disposable local fixtures. No new acquisition test contacts a real provider, GitHub, npm, or cloud. Existing Docker dependency-install checks remain separate.
- No application import or client construction performs I/O. No UI, DB schema, campaign executor, owner registry, runtime flags, or live configuration changes.

---

## Execution context and checkpoints

Worktree: `work/api-migrator-pilot-main`; branch: `codex/protected-runner-evidence`.
Approved specification commit: `effeba665c265f4acea583baf3d7a506888335e7`.
Merged baseline: `c1a6a6ea78de177ae6ceda07bcda1551f5c18948`.
Run commands below from the worktree root unless a command explicitly changes it.

This document contains proposed implementation and tests, not execution evidence.
The previous turn's Docker-enabled baseline had 532 passing tests; rerun on the
implemented head instead of carrying that count forward. The known Next NFT
tracing warning is not part of this slice.

Before execution, inspect `git status`, `git worktree list`, applicable
`AGENTS.md`, installed runtime, and the approved design. Reuse this isolated
worktree; preserve other worktrees and user changes. Do not create nested
worktrees. Confirm the execution method with the user; no agent is dispatched
by this planning step.

Tasks 1-6 run in order. Each is a reviewable deliverable with a red/green cycle.
For an existing behavior that is already green, use a temporary narrowly scoped
mutation of our own implementation to prove the regression test fails, then
restore it immediately. Never remove existing assertions to obtain green.

## File ownership map

| File | Responsibility |
| --- | --- |
| `packages/app/src/runner-evidence-contract.ts` | Context/configuration/retained-identity validation and safe result types |
| `packages/app/src/runner-evidence-deadline.ts` | One wall/monotonic budget, cancellation, late-resource cleanup |
| `packages/app/src/runner-key-registry.ts` | Canonical public-key registry parsing, selection, protected POSIX reads |
| `packages/app/src/runner-evidence-transport.ts` | Exact-IP TLS, fixed request, bounded HTTP response |
| `packages/app/src/runner-evidence-core.ts` | Internal dependency-injected acquisition sequence; not a package export |
| `packages/app/src/runner-evidence.ts` | Production factory, code-owned filesystem policy and dependencies |
| `packages/app/src/runner-evidence-internal.ts` | Explicit public server-internal export list |
| `packages/app/src/publication-runner.ts` | Export four existing pure helpers from this module only, with unchanged bodies |
| `packages/app/test/helpers/runner-evidence-fixture.ts` | Real source bundle, plan, disposable Ed25519 signing fixture |
| `packages/app/test/helpers/runner-evidence-io-fixture.ts` | Private temporary registry, TLS server, socket/descriptor counters, clocks |
| `packages/app/test/runner-evidence-{contract,deadline,registry,transport,acquisition}.test.ts` | Independent component and cross-boundary regressions |
| `packages/app/test/package-surface.test.ts` and `packages/app/package.json` | Exact export boundary |
| `packages/console/test/runs-route-runtime.test.ts` and `runner-capability.test.ts` | Actual blocked POSTs, no consumption, no acquisition integration |
| `ops/publication-runner/image/test/prepare-runtime-root.test.mjs` | Real assembled runtime excludes all privileged new modules |
| `docs/plans/2026-09-09-runner-evidence-verification.md` | Final execution ledger: commands, head, counts, limitations, live PR checks |

Do not change `prepare-runtime-root.mjs`'s module allowlist: the four shared
helpers stay in `publication-runner.ts`, which is already included. No new
network/file-reader module belongs in the image.

## Shared interfaces

Task 1 owns the following types in `runner-evidence-contract.ts`. Other tasks
import them; do not invent parallel names or result shapes.

```ts
import type {
  PublicationRunnerOutput, PublicationRunnerPlanRecord,
  VerifiedPublicationRunnerAttestation,
} from "./publication-runner.js";
import type { PreviewSourceIdentity } from "./preview-evidence.js";

export interface RunnerEvidenceContext {
  campaignId: string;
  runId: string;
  plan: PublicationRunnerPlanRecord;
  source: PreviewSourceIdentity;
  reviewedOutput: PublicationRunnerOutput;
  previewCompletedAt: number;
}
export interface RunnerEvidenceConfig {
  serviceOrigin: string;
  serviceAddresses: readonly string[];
  serviceTlsSpkiDigest: string;
  registryDirectory: string;
}
export interface RunnerEvidenceWorkspacePolicy {
  migrationWorkspaceRoots: readonly string[];
}
export interface RetainedRunnerEvidenceIdentity {
  schemaVersion: 1;
  contextDigest: string;
  jobId: string;
  planDigest: string;
  attestationPayloadDigest: string;
  attestationEnvelopeDigest: string;
  signerKeyId: string;
  signerFingerprint: string;
  signerTrustDigest: string;
  expiresAt: number;
}
export type RunnerEvidenceFailureCode =
  | "configuration_invalid" | "expected_context_invalid"
  | "trust_unavailable" | "evidence_unavailable" | "evidence_invalid"
  | "identity_changed" | "expired";
export type RunnerEvidenceResult =
  | { ok: true; verified: VerifiedPublicationRunnerAttestation;
      identity: Readonly<RetainedRunnerEvidenceIdentity> }
  | { ok: false; code: RunnerEvidenceFailureCode };
export interface RunnerEvidenceClient {
  acquireInitial(context: unknown): Promise<RunnerEvidenceResult>;
  reacquire(context: unknown, identity: unknown): Promise<RunnerEvidenceResult>;
}
export type RunnerEvidenceClientResult =
  | { ok: true; client: RunnerEvidenceClient }
  | { ok: false; code: "configuration_invalid" };

// Internal exception type; never exported by the server package subpath.
export class RunnerEvidenceError extends Error {
  constructor(readonly code: RunnerEvidenceFailureCode) {
    super(code);
    this.name = "RunnerEvidenceError";
  }
}
```

The production signature is
`createRunnerEvidenceClient(config: unknown, policy: unknown): RunnerEvidenceClientResult`.
No third argument, clock, transport, registry reader, CA, port, or bypass is
exposed. Validate and detach both inputs synchronously before returning a
client. A required exclusion policy is a server integration dependency, not an
authorization capability or a guarantee that an operator listed every workspace.
Its completeness is a future deployment gate. Always add the module-derived
application checkout, OS temporary root, `/tmp`, `/var/tmp`, and `/run` to
production exclusions; resolve filesystem aliases during acquisition. Keep test
overrides confined to source-internal seams and test helpers.

### Task 1: Strict contracts and genuine signed fixtures

**Files:** Create contract module, fixture helper, contract tests from the map;
modify `packages/app/src/publication-runner.ts` at `validateRunnerOutput`,
`validateAttestationTrust`, `canonicalIpLiteral`, `isGlobalUnicastLiteral`.

**Interfaces:**

- Consumes existing canonical JSON, source validation, plan validation, and verifier.
- Produces shared types above and functions below. No I/O in production contract code.

```ts
export function validateRunnerEvidenceContext(value: unknown, now: number):
  Readonly<RunnerEvidenceContext>;
export function validateRetainedRunnerEvidenceIdentity(value: unknown):
  Readonly<RetainedRunnerEvidenceIdentity>;
export function validateRunnerEvidenceConfiguration(config: unknown, policy: unknown):
  { config: Readonly<RunnerEvidenceConfig>; policy: Readonly<RunnerEvidenceWorkspacePolicy> };
export function runnerEvidenceDigest(value: unknown): string;
export function runnerEvidenceFailure<C extends RunnerEvidenceFailureCode>(code: C):
  Readonly<{ ok: false; code: C }>;
```

- [ ] **1.1 Write contract regressions before adding the module.** Create a fixture
  helper with this test-only return contract:

```ts
export function runnerEvidenceFixture(now: number): {
  context: RunnerEvidenceContext;
  bundle: SourceBundleRecord;
  trust: RunnerAttestationTrust;
  payload: PublicationRunnerAttestation;
  envelope: string;
  signPayload(payload: PublicationRunnerAttestation): string;
  close(): void;
};
```

  `SourceBundleRecord` comes from `runner-source-bundle.ts`; attestation/trust
  types come from `publication-runner.ts`. Build a new one-file Git repository
  using the exact isolated Git environment pattern in
  `packages/app/test/preview-source.test.ts` (`git` and `fixture`). Set author and
  committer dates explicitly, clear inherited Git config, and disable signing.
  Generate/parse a real bundle using `createSourceBundle` and `parseSourceBundle`;
  use its actual base/tree/manifest/archive identities in both context and plan.
  The fixture must not invoke the local-preview capture API or a GitHub client.

  Use the existing `planInput`, `reviewedOutput`, `trustPair`, `attestation`, and
  `signedEnvelope` implementations in `packages/app/test/publication-runner.test.ts`
  as the concrete fixture source. Copy those helper bodies into the new helper,
  leaving the older tests untouched; replace their fixed `NOW` with
  `createdAt = now - 105_000`, plan expiry with `createdAt + 900_000`, and source
  fields with the real bundle. Keep the original +1_000 through +104_000 execution
  and teardown offsets, key validity to createdAt + 24 hours, completion at
  `now - 500`, and campaign/run `campaign_fixture`/`run_fixture`. The copied signing
  helper must still sign domain + canonical payload bytes, not fixture metadata.

```ts
test("context is detached, source-bound, and rejects getters before invocation", () => {
  const now = 2_000_000_000_000;
  const f = runnerEvidenceFixture(now);
  try {
    const original = structuredClone(f.context);
    const accepted = validateRunnerEvidenceContext(original, now);
    original.source.base.branch = "changed";
    assert.equal(accepted.source.base.branch, "main");
    assert(Object.isFrozen(accepted.source.base));
    const wrong = structuredClone(f.context);
    wrong.source.repository.id += 1;
    assert.throws(() => validateRunnerEvidenceContext(wrong, now));
    let reads = 0;
    const accessor = { ...f.context };
    Object.defineProperty(accessor, "source", {
      enumerable: true, get() { reads += 1; return f.context.source; },
    });
    assert.throws(() => validateRunnerEvidenceContext(accessor, now));
    assert.equal(reads, 0);
  } finally { f.close(); }
});
```

- [ ] **1.2 Run the new test red.**

```bash
node --import tsx --test packages/app/test/runner-evidence-contract.test.ts
```

  Expected: missing contract module/export. Once linked, each negative case must
  fail for its asserted rejection, not a broken fixture. Verify the fixture's
  envelope with the existing verifier as a positive control.

- [ ] **1.3 Implement strict, side-effect-free validation.** Add only the `export`
  keyword to the four existing pure helper declarations. Do not change their
  bodies, root exports, signed bytes, or existing callers.

```ts
export function runnerEvidenceDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
export function runnerEvidenceFailure<C extends RunnerEvidenceFailureCode>(code: C) {
  return Object.freeze({ ok: false as const, code });
}
```

  For context: canonicalize before accessing properties, parse into detached
  plain JSON, enforce exact keys at the context and plan-record boundaries,
  validate plan structure with `validatePublicationRunnerPlan`, compare its
  record digest/canonical bytes, then validate source via the existing
  `validateLocalPreviewExecution({schemaVersion: 1, kind: "local-preview", source})`
  solely as a shape validator. This does not classify execution as attested.
  Reject null source. Use the returned canonical source, not the raw input.
  Compare source repository/base/manifest/archive fields with validated plan;
  preserve source tree in `contextDigest`. Use `validateRunnerOutput` for output.
  Validate positive safe timestamps within the existing timestamp ceiling,
  createdAt <= completion <= now, and strict IDs `/^[A-Za-z0-9_-]{1,128}$/`.
  Before `assertPublicationRunnerPlanCurrent`, distinguish a structurally valid
  exhausted plan or preview window by throwing `RunnerEvidenceError("expired")`;
  malformed values or time ordering throw `expected_context_invalid`. Call the
  existing current-plan assertion after these checks. Deep-freeze the result.

  Retained identities accept exactly the ten declared fields. Digests use
  `/^sha256:[a-f0-9]{64}$/`; job IDs use `/^previewjob_[a-f0-9]{64}$/`; signer IDs
  retain the existing identifier expression. Reject all unknown fields, unsafe
  integers, accessors, symbols, hidden properties, non-plain data, and cycles.
  Recursively inspect data descriptors before canonicalization for every input,
  including arrays nested in plan/configuration. Reject accessor descriptors
  without evaluating them, then let canonical JSON enforce the remaining shape
  rules. The existing canonical serializer's array path is not a getter guard;
  do not change that shared serializer in this slice. Add a nested plan-array
  getter regression with an invocation count of zero.

  Configuration is exact-key and byte-bounded. Accept origin as either
  `https://hostname` or `https://hostname/` and normalize once to the no-slash
  origin; reject uppercase/non-ASCII/escaped or malformed DNS labels, IP hosts,
  explicit ports (including normalized `:443` aliases), query/fragment/userinfo.
  Preserve address order so index 0 is the operator's chosen endpoint. Reuse
  the two exported IP helpers; reject duplicates and noncanonical literals.
  Pin is a SHA-256 digest. Registry path must be absolute, <=4096 UTF-8 bytes,
  without controls, NUL, trailing separator, `.`/`..`, or a normalized alias.
  Policy has exactly `migrationWorkspaceRoots`: 1-128 unique paths with those
  same syntactic rules, frozen. No I/O or environment-based configuration.

- [ ] **1.4 Expand the red/green table and verify unchanged contracts.** Test every
  source/output field, ID length boundaries, all retained fields, invalid times,
  alternate GitHub casing equivalence, branch case sensitivity, extra nested
  plan-record keys, canonical IPv4/IPv6, private/metadata/reserved addresses,
  URL tricks, root aliases, accessor arrays, and no caller mutation.

```bash
node --import tsx --test packages/app/test/runner-evidence-contract.test.ts packages/app/test/publication-runner.test.ts packages/app/test/preview-evidence.test.ts
npm run build:packages
npm run typecheck:workspaces
git diff --check
```

- [ ] **1.5 Commit this tested unit.**

```bash
git add packages/app/src/runner-evidence-contract.ts packages/app/src/publication-runner.ts packages/app/test/runner-evidence-contract.test.ts packages/app/test/helpers/runner-evidence-fixture.ts
git commit -m "feat: define strict runner evidence acquisition contracts"
```

### Task 2: One cancellable acquisition deadline

**Files:** Create `runner-evidence-deadline.ts` and deadline tests.

**Interfaces:** Consumes safe failure code `expired`. Produces:

```ts
export interface RunnerEvidenceClock {
  wallNow(): number;
  monotonicNow(): number;
}
export interface RunnerEvidenceDeadline {
  readonly signal: AbortSignal;
  check(): number;
  cap(expiresAt: number): void;
  run<T>(operation: (signal: AbortSignal) => Promise<T>,
    disposeLate?: (value: T) => void | Promise<void>): Promise<T>;
  close(): void;
}
export function createRunnerEvidenceDeadline(
  clock: RunnerEvidenceClock, expiresAt: number,
): RunnerEvidenceDeadline;
```

  This module is source-internal, not an exported factory option. Production uses
  `Date.now()` and `performance.now()`. Test clocks provide deterministic values.

- [ ] **2.1 Add a failing late-result/cancellation test.** Imports include
  `createRunnerEvidenceDeadline` and `RunnerEvidenceClock` from the new module.

```ts
test("a stalled operation is actively aborted and its late resource is disposed", async () => {
  const clock: RunnerEvidenceClock = {
    wallNow: () => Date.now(), monotonicNow: () => performance.now(),
  };
  const budget = createRunnerEvidenceDeadline(clock, Date.now() + 100);
  let settle!: (value: { close(): void }) => void;
  let disposed = 0;
  try {
    const pending = budget.run(
      () => new Promise<{ close(): void }>((resolve) => { settle = resolve; }),
      (value) => value.close(),
    );
    await assert.rejects(pending, /expired/);
    assert.equal(budget.signal.aborted, true);
    settle({ close() { disposed += 1; } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposed, 1);
  } finally { budget.close(); }
});
```

- [ ] **2.2 Run red, then implement the deadline.**

```bash
node --import tsx --test packages/app/test/runner-evidence-deadline.test.ts
```

  Capture wall and monotonic start once, set `monotonicEnd = start + 10_000`,
  maintain the smallest wall expiry and last wall reading, and own one
  `AbortController`. `cap()` can only shorten, including the scheduled timer.
  Before/after every asynchronous operation and on final return, calculate:

```ts
const wall = clock.wallNow();
const mono = clock.monotonicNow();
const remaining = Math.min(wallExpiry - wall, monotonicEnd - mono);
if (!Number.isSafeInteger(wall) || !Number.isFinite(mono) ||
    wall < lastWall || mono < lastMono || remaining <= 0) {
  const error = new RunnerEvidenceError("expired");
  controller.abort(error);
  throw error;
}
lastWall = wall;
lastMono = mono;
```

  Keep these values private in the returned closure. `run` races the operation
  against a single abort event and calls `check()` after settlement; catch both
  late rejection and resolution. A value arriving after timeout is passed to
  `disposeLate`, with cleanup rejection swallowed safely; no raw error is logged.
  Remove per-operation abort listeners; clear the timer on `close`. Do not use
  an unreferenced timer that lets the process exit before a pending test settles.
  Do not expose a configurable longer timeout. Synchronous verification is
  bounded by input limits and checked immediately afterward.

- [ ] **2.3 Add deterministic clock tests and run green.** Set injected monotonic
  time to +10_000 without advancing wall time; assert expiry. Decrease wall by
  one millisecond within one call; assert expiry. Cap to exact preview/plan/key/
  retained deadline, try extending it, delay each IO stage, and check no success
  is emitted after expiry. Track disposal after late open and all timer cleanup.

```bash
node --import tsx --test packages/app/test/runner-evidence-deadline.test.ts
npm run build:packages
git diff --check
git add packages/app/src/runner-evidence-deadline.ts packages/app/test/runner-evidence-deadline.test.ts
git commit -m "feat: bound runner evidence acquisition lifetime"
```

### Task 3: Fresh protected key-registry reads

**Files:** Create `runner-key-registry.ts`, registry tests and IO fixture helper.

**Interfaces:** Consumes Task 1 types/pure key validator, Task 2 deadline. Produces:

```ts
export interface RunnerKeyEntry extends RunnerAttestationTrust {
  pilotId: string;
  repository: { slug: string; id: number; ownerId: number };
}
export interface RunnerKeySelection {
  entry: Readonly<RunnerKeyEntry>;
  trust: Readonly<RunnerAttestationTrust>;
  trustDigest: string;
}
export interface RunnerRegistryPolicy {
  applicationCheckout: string;
  excludedRoots: readonly string[];
}
export function selectRunnerKey(bytes: Buffer,
  context: Readonly<RunnerEvidenceContext>, now: number): RunnerKeySelection;
export function readRunnerKeyRegistry(directory: string,
  policy: RunnerRegistryPolicy, context: Readonly<RunnerEvidenceContext>,
  deadline: RunnerEvidenceDeadline): Promise<RunnerKeySelection>;
```

  Internal filesystem seam for race tests must be confined to this
  module's direct import and never exported from the package subpath. Define
  `RunnerRegistryIo` as a `Pick<typeof import("node:fs/promises"), "open" | "lstat" | "realpath">`
  and put injectable IO only on `readRunnerKeyRegistryWithIo` with the same four
  parameters plus `io: RunnerRegistryIo` and `effectiveUid: number`. The normal
  reader captures native IO/UID itself. The test-only policy may exclude a
  synthetic checkout instead of the OS temporary root; production cannot.

- [ ] **3.1 Write strict parser tests and a real protected-file test.** In
  `runner-evidence-io-fixture.ts`, provide
  `registryFixture(bytes: Buffer): { directory: string; file: string;
  policy: RunnerRegistryPolicy; replace(bytes: Buffer): void; close(): void }`.
  Use `realpathSync(mkdtempSync(...))`, separate registry and fake checkout
  directories, mode 0700, and an exclusive 0600 file. `replace` writes a new
  exclusive sibling, then atomically renames it. Cleanup only the created tree.

```ts
test("key policy changes alter the retained trust digest", () => {
  const now = 2_000_000_000_000;
  const f = runnerEvidenceFixture(now);
  try {
    const entry = { ...f.trust, pilotId: f.context.plan.plan.subject.pilotId,
      repository: f.context.source.repository };
    const encode = (key: RunnerKeyEntry) =>
      Buffer.from(canonicalJson({ schemaVersion: 1, keys: [key] }));
    const a = selectRunnerKey(encode(entry), f.context, now);
    const b = selectRunnerKey(encode({ ...entry, validUntil: entry.validUntil - 1 }), f.context, now);
    assert.notEqual(a.trustDigest, b.trustDigest);
    assert.throws(() => selectRunnerKey(encode({ ...entry, revokedAt: now }), f.context, now));
  } finally { f.close(); }
});
```

- [ ] **3.2 Run red, then implement parsing and selection.**

```bash
node --import tsx --test packages/app/test/runner-evidence-registry.test.ts
```

  Parse canonical UTF-8 under 256 KiB; root exactly `schemaVersion,keys`, version
  1, 1-128 entries; each entry exact spec keys. Validate every entry before
  selection, even expired/revoked entries. Extract only the seven trust fields
  into `validateAttestationTrust`; never pass scope/extra `publicKey` fields.
  Validate pilot ID with `/^pilot_[A-Za-z0-9_-]{6,80}$/`, positive safe repository
  IDs, and canonical lowercase GitHub slug. Reject duplicate key IDs/fingerprints
  globally and more than one current nonrevoked entry for any scope. Select
  exactly one by expected pilot/repository and finish-time validity, never by
  the envelope's key ID. `trustDigest = runnerEvidenceDigest(entry)` over all
  normalized fields. Return a detached frozen entry/trust selection.

- [ ] **3.3 Implement protected descriptor reads, then test each rejection.**

```ts
const handle = await deadline.run(
  () => io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  (lateHandle) => lateHandle.close(),
);
try {
  const before = await deadline.run(() => handle.stat({ bigint: true }));
  const buffer = Buffer.alloc(256 * 1024 + 1);
  let used = 0;
  while (used < buffer.length) {
    const { bytesRead } = await deadline.run(() =>
      handle.read(buffer, used, buffer.length - used, used));
    if (bytesRead === 0) break;
    used += bytesRead;
  }
  if (used > 256 * 1024) throw new RunnerEvidenceError("trust_unavailable");
  const after = await deadline.run(() => handle.stat({ bigint: true }));
  // Compare these snapshots and path/directory snapshots before parsing bytes.
  return selectRunnerKey(buffer.subarray(0, used), context, deadline.check());
} finally { await handle.close(); }
```

  The snapshot comparison is mandatory code around this read skeleton: require
  regular single-link file, euid ownership, exact 0400/0600 permission bits,
  no special mode bits, stable device/inode/UID/mode/nlink/size/mtimeNs/ctimeNs,
  and exactly `BigInt(used) === before.size`. Check path `lstat` before open and after
  read against the descriptor. Walk and snapshot every directory component,
  rejecting symlinks; final registry directory must be euid-owned with no
  group/other or special bits. Ancestors must be directories owned by root or
  euid and not group/other-writable. Reject registry equal to or inside any
  realpath-resolved application/workspace exclusion; absent explicit migration
  roots fail closed, not silently disappear. Built-in nonexistent platform
  exclusions are retained lexically. Compare directory identity/mode/ownership
  after reading. No creates/chmod/repair in production. Reject Windows or missing
  POSIX constants/UID before IO. Reject FIFOs/devices before open; nonblocking
  open also prevents a raced FIFO from hanging indefinitely.

  Tests cover exact size and size+1, invalid UTF-8, duplicate/unknown fields,
  multiple PEMs/private/certificate keys, malformed inactive entries, ambiguous
  scope, key validity bounds, symlink at each relevant path component, hardlink,
  wrong file/dir mode, workspace aliases/containment, open/read failures, file
  growth/truncation, inode/path/directory replacement, and delayed late handle.
  Real fixtures beneath OS temp use `readRunnerKeyRegistryWithIo` with an IO
  wrapper that changes only the known external sticky temp ancestor snapshot
  to a protected ancestor. Preserve real metadata for all created registry,
  checkout, file and link paths; report the ancestry check as injected, not a
  production-ready temp deployment. Do not relax production checks. Inject
  wrong-owner and otherwise-unreproducible race snapshots, label those as
  injected, and separately retain real symlink/hardlink/read tests.

- [ ] **3.4 Run green and commit.**

```bash
node --import tsx --test packages/app/test/runner-evidence-registry.test.ts packages/app/test/owner-authorization.test.ts
npm run build:packages
git diff --check
git add packages/app/src/runner-key-registry.ts packages/app/test/runner-evidence-registry.test.ts packages/app/test/helpers/runner-evidence-io-fixture.ts
git commit -m "feat: read fresh protected runner signing trust"
```

### Task 4: Exact pinned HTTPS transport with bounded responses

**Files:** Create transport module/tests; extend IO fixture helper.

**Interfaces:** Consumes validated config and Task 2 budget. Produces:

```ts
export function fetchRunnerEvidenceEnvelope(config: Readonly<RunnerEvidenceConfig>,
  jobId: string, deadline: RunnerEvidenceDeadline): Promise<string>;
```

  Use source-internal `createRunnerEvidenceTransport(request: typeof https.request)`
  returning the same signature for socket tests. The normal exported-from-source
  function binds native `https.request`. Only the test helper wraps request options
  to connect to 127.0.0.1 + ephemeral port and trust its disposable CA, preserving
  the configured SNI/Host and production certificate/pin checking callback.
  The production factory must not accept that seam.

- [ ] **4.1 Add failing real TLS tests.** Extend the IO helper with
  `tlsEvidenceFixture(body: string): Promise<{ request: typeof https.request;
  config: RunnerEvidenceConfig; requests: Array<{method: string; path: string;
  host: string; headers: Record<string, string | string[] | undefined>}>;
  activeSockets(): number; close(): Promise<void> }>`.
  Generate disposable local TLS certificate/key files via `openssl` arguments
  in the helper, with SAN `DNS:evidence.example.invalid`; use Node's default
  chain verification with only this CA in the internal request wrapper.
  Never check in those private keys. Assert wrapper input before changing only
  connect IP/port/CA, so the real test records the production-selected IP and
  fixed port. Fixture URL is never a real service request.

```ts
test("TLS fixture gets only the exact job request and closes sockets", async () => {
  const tlsFixture = await tlsEvidenceFixture('{"schemaVersion":1}');
  const budget = createRunnerEvidenceDeadline({
    wallNow: () => Date.now(), monotonicNow: () => performance.now(),
  }, Date.now() + 5_000);
  const job = `previewjob_${"a".repeat(64)}`;
  try {
    const transport = createRunnerEvidenceTransport(tlsFixture.request);
    const text = await transport(tlsFixture.config, job, budget);
    assert.equal(text, '{"schemaVersion":1}');
    assert.equal(tlsFixture.requests.length, 1);
    assert.equal(tlsFixture.requests[0].method, "GET");
    assert.equal(tlsFixture.requests[0].path, `/v1/runner-evidence/${job}`);
    assert.equal(tlsFixture.requests[0].host, "evidence.example.invalid");
    assert.equal(tlsFixture.requests[0].headers.authorization, undefined);
  } finally {
    budget.close();
    await tlsFixture.close();
  }
  assert.equal(tlsFixture.activeSockets(), 0);
});
```

  This transport-only test intentionally uses canonical JSON that is not a signed
  envelope; Task 5 rejects it cryptographically. Do not make transport a second
  signature verifier.

- [ ] **4.2 Run red, then implement fixed request construction.**

```bash
node --import tsx --test packages/app/test/runner-evidence-transport.test.ts
```

```ts
const host = new URL(config.serviceOrigin).hostname;
const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
const options: https.RequestOptions = {
  protocol: "https:", hostname: config.serviceAddresses[0], port: 443,
  servername: host, method: "GET", path: `/v1/runner-evidence/${jobId}`,
  agent, rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
  signal: deadline.signal,
  headers: { Host: host, Connection: "close", Accept: "application/json",
    "Accept-Encoding": "identity" },
  checkServerIdentity: (_name, cert) => {
    const hostnameError = checkServerIdentity(host, cert);
    if (hostnameError) return new RunnerEvidenceError("evidence_unavailable");
    const der = new X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" });
    const fingerprint = `sha256:${createHash("sha256").update(der).digest("hex")}`;
    return fingerprint === config.serviceTlsSpkiDigest
      ? undefined : new RunnerEvidenceError("evidence_unavailable");
  },
};
```

  Imports are `https` from `node:https`, `checkServerIdentity` from `node:tls`,
  and `X509Certificate/createHash` from `node:crypto`. Wrap the certificate
  callback so parse exceptions become the same safe error. Reject invalid job
  IDs before request construction. Never inherit global agents or set proxyEnv,
  lookup, cookies, auth, client certificates, or keylog callbacks. Use native
  HTTPS's fixed numeric host; no resolver. Explicitly disable HTTP parser
  leniency and keep the default trusted certificate chain checks enabled.

- [ ] **4.3 Add response framing, deadline and cleanup implementation.** Own one
  request/response/agent per call and destroy them on every error, timeout, and
  successful completion. Use the shared budget to await the complete exchange.
  Reject `upgrade`, `connect`, informational response tricks, redirects/non-200,
  any `Content-Encoding`/`Trailer`, actual trailers, conflicting duplicate
  singleton headers and transfer encodings. Inspect `rawHeaders`, not only
  Node's merged header object. Allow one canonical decimal Content-Length
  (including 0, which later fails as an empty envelope) or exactly chunked
  framing, never both. Validate declared byte length against the cap and actual
  final bytes. Reject incomplete streams and unexpected close/abort.

```ts
let total = 0;
const chunks: Buffer[] = [];
for await (const part of response) {
  deadline.check();
  const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
  total += chunk.length;
  if (total > 128 * 1024) throw new RunnerEvidenceError("evidence_invalid");
  chunks.push(chunk);
}
if (!response.complete || response.rawTrailers.length !== 0)
  throw new RunnerEvidenceError("evidence_invalid");
const bytes = Buffer.concat(chunks, total);
parseCanonicalJson(bytes, 128 * 1024, "runner evidence");
const envelope = bytes.toString("utf8");
```

  Match Content-Type case-insensitively to `application/json` optionally followed
  by only `charset=utf-8`, with normal HTTP whitespace. Reject extra parameters.
  Return no remote diagnostics. Throw `RunnerEvidenceError("evidence_invalid")`
  for locally detected framing/canonical JSON failures; native network/parser/
  TLS errors map to evidence_unavailable. Preserve a deadline's expired code.
  The orchestrator never branches on arbitrary native exception text.

  Implementation references: [Node 22 HTTPS request and custom agent options](https://nodejs.org/download/release/latest-jod/docs/api/https.html)
  and [Node 22 HTTP request cancellation](https://nodejs.org/download/release/latest-jod/docs/api/http.html).
  A timeout event alone is not cancellation; this implementation owns abort and
  destruction through the shared deadline.

- [ ] **4.4 Expand TLS and adversarial wire tests, run green.** Include incorrect
  CA/hostname/SPKI, SNI observation, IPv4/IPv6 options, canonical body cap-1/cap/
  cap+1, oversized headers, invalid UTF-8, duplicate headers, gzip and explicit
  identity encoding, zero/large/wrong Content-Length, raw chunked trailers,
  truncated body, header/body/connect stalls, and socket destruction. For an
  uncompleted TCP connect, use a narrow injected request fixture, not a flaky
  public blackhole. Use raw TLS fixture responses for malformed wire data.
  Poison `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NODE_USE_ENV_PROXY`, `GH_TOKEN`
  and `GITHUB_TOKEN` with fake values in isolated child-process tests; record zero
  proxy requests and absence of credential headers. Restore state or exit child.
  Explicitly test production factory rejects CA/port/loopback/test options in
  Task 6; successful fixture TLS does not prove production ingress is deployed.

```bash
node --import tsx --test packages/app/test/runner-evidence-transport.test.ts packages/app/test/runner-evidence-deadline.test.ts
npm run build:packages
git diff --check
git add packages/app/src/runner-evidence-transport.ts packages/app/test/runner-evidence-transport.test.ts packages/app/test/helpers/runner-evidence-io-fixture.ts
git commit -m "feat: fetch bounded pinned runner evidence over HTTPS"
```

### Task 5: Initial acquisition and exact fresh reacquisition

**Files:** Create core/factory modules and acquisition tests.

**Interfaces:** Consumes Tasks 1-4 and existing verifier; produces production
factory signature in Shared interfaces. Core remains source-internal:

```ts
export interface RunnerEvidenceDependencies {
  clock: RunnerEvidenceClock;
  readKey(context: Readonly<RunnerEvidenceContext>,
    deadline: RunnerEvidenceDeadline): Promise<RunnerKeySelection>;
  fetchEnvelope(jobId: string, deadline: RunnerEvidenceDeadline): Promise<string>;
}
export function createRunnerEvidenceClientWithDependencies(
  dependencies: RunnerEvidenceDependencies,
): RunnerEvidenceClient;
```

  The verifier is imported directly, not replaceable by a dependency. Factory
  config/policy validation happens in the production wrapper; core revalidates
  all per-operation contexts/retained identities. Configure no live client now.

- [ ] **5.1 Write failing initial/reacquisition tests using real signatures.**

```ts
test("reacquisition reads twice again and returns a fresh genuine capability", async () => {
  const now = 2_000_000_000_000;
  const f = runnerEvidenceFixture(now);
  let keyReads = 0;
  let fetches = 0;
  try {
    const entry = { ...f.trust, pilotId: f.context.plan.plan.subject.pilotId,
      repository: f.context.source.repository };
    const bytes = Buffer.from(canonicalJson({ schemaVersion: 1, keys: [entry] }));
    const client = createRunnerEvidenceClientWithDependencies({
      clock: { wallNow: () => now, monotonicNow: () => performance.now() },
      async readKey(context, budget) {
        keyReads += 1;
        return selectRunnerKey(bytes, context, budget.check());
      },
      async fetchEnvelope(jobId) {
        assert.equal(jobId, f.context.plan.plan.job.id);
        fetches += 1;
        return f.envelope;
      },
    });
    const first = await client.acquireInitial(f.context);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("fixture acquisition failed");
    const second = await client.reacquire(f.context, first.identity);
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("fixture reacquisition failed");
    assert.deepEqual(second.identity, first.identity);
    assert.notEqual(second.verified, first.verified);
    assert.equal(assertVerifiedPublicationRunnerAttestation(second.verified, now), second.verified);
    assert.throws(() => assertVerifiedPublicationRunnerAttestation({ ...second.verified }, now));
    assert.equal(keyReads, 4);
    assert.equal(fetches, 2);
  } finally { f.close(); }
});
```

- [ ] **5.2 Run red and implement the read-only sequence.**

```bash
node --import tsx --test packages/app/test/runner-evidence-acquisition.test.ts
```

  For each call: create one budget initially capped at current wall + 10 seconds;
  detach/validate context before the first await, then cap by completion + ten
  minutes and plan expiry; reject invalid or already expired expectations before
  all I/O. On reacquisition, validate the retained shape, expected context digest/job/plan,
  and retained expiry before I/O, also cap the budget by retained expiry. Read
  key #1, cap budget by key validity, fetch exact job, read key #2, compare trust
  digests, verify with the finish-time
  clock, recheck deadline and context lifetime, then return the original branded
  object with the identity below. Always close the budget in `finally`.
  Wrap each entire dependency call in `budget.run`, in addition to inner IO
  checks, so even a delayed reader cleanup or uncooperative dependency cannot
  prevent the caller from receiving a timely failure. Late results are ignored;
  the registry still owns its descriptor cleanup.

```ts
const expiresAt = Math.min(context.previewCompletedAt + 600_000,
  context.plan.plan.job.expiresAt, freshKey.trust.validUntil);
const identity: RetainedRunnerEvidenceIdentity = {
  schemaVersion: 1,
  contextDigest: runnerEvidenceDigest(context),
  jobId: context.plan.plan.job.id,
  planDigest: context.plan.digest,
  attestationPayloadDigest: verified.payloadDigest,
  attestationEnvelopeDigest: verified.envelopeDigest,
  signerKeyId: verified.signer.keyId,
  signerFingerprint: verified.signer.fingerprint,
  signerTrustDigest: freshKey.trustDigest,
  expiresAt,
};
if (retained && canonicalJson(identity) !== canonicalJson(retained))
  return runnerEvidenceFailure("identity_changed");
budget.check();
return Object.freeze({ ok: true as const, verified,
  identity: validateRetainedRunnerEvidenceIdentity(identity) });
```

  This recomputation must match the original exactly, not renew it: all expiry
  inputs are already original context/key policy fields. A changed key expiry
  rejects even if preview expiry remains shorter. Do not clone `verified` or
  confuse `identity` with runtime authority. Its existing hidden expiry remains
  plan/key-bounded; document the shorter retained preview deadline separately.

  Map errors by operation stage using `RunnerEvidenceError`, not
  exception strings: invalid factory input -> configuration_invalid; malformed
  per-call input -> expected_context_invalid; expired valid lifetimes/budget ->
  expired; registry failure or selected-key race -> trust_unavailable; network
  failure -> evidence_unavailable; framing/JSON/signature/output mismatch ->
  evidence_invalid; verified replacement or retained-field mismatch ->
  identity_changed. Return only `{ok:false,code}`. Do not expose stack/message,
  echo metadata, invoke a logger, or consume any DB/approval state. Preserve
  only this local exception's closed `code`; map all other exceptions at the
  known operation boundary. Wrap canonical parser/validator errors at that
  boundary rather than reading their native messages.

  Implement production factory with module-derived checkout path (as existing
  owner authorization does), immutable explicit policy, native registry and
  HTTPS functions, and real clocks. Computing paths is not an IO read; directory
  canonicalization and protection checks run on each acquisition under budget.
  No root/console/campaign import, `.env` load, construction-time stat, or
  module-import network activity.

- [ ] **5.3 Add independent mutation and failure tests.** For each retained field
  and each context leaf, start with an independently verified success and mutate
  only that value. Separate (a) malformed expected context, (b) valid new context
  with old retained identity, and (c) exact context with wrong signed evidence.
  A different valid signature/payload must first pass the existing verifier in
  a control, then fail `reacquire`; mutate runnerInstanceDigest and resign to
  produce replacement evidence for the same job. Change campaign/run/tree/
  completion while preserving other context; use fresh plan generation when
  testing new job/source inputs so failures are not merely broken plan digests.
  Verify same bytes + same policy succeeds repeatedly until exact expiry.

  Test key removal/revoke/rotation/validity change during fetch and between
  calls; mutation of caller objects during a blocked await; expired/late key
  reads, altered output, malformed envelopes, wrong-domain signatures, forged
  structurally cast capabilities, local receipts, future v3-shaped JSON, and
  container reports. Inject sensitive exception strings and assert failure
  serialization contains only the two allowed fields and no raw content.

- [ ] **5.4 Run one integrated registry + TLS + signature test, then commit.**
  Compose the real registry fixture, production transport logic through its
  test-only TLS connection wrapper, and the real verifier. Count two registry
  reads per call, real socket requests, and disposal. Repeat after actual atomic
  registry revocation; expect failure with no additional acquisition authority.

```bash
node --import tsx --test packages/app/test/runner-evidence-*.test.ts
npm run build:packages
npm run typecheck:workspaces
git diff --check
git add packages/app/src/runner-evidence-core.ts packages/app/src/runner-evidence.ts packages/app/test/runner-evidence-acquisition.test.ts
git commit -m "feat: acquire exact runner evidence with fresh trust"
```

### Task 6: Export isolation, closed routes, runtime image, and PR evidence

**Files:** Create `runner-evidence-internal.ts`; modify app package exports,
package-surface test, console tests, image test; create final verification record.

**Interfaces:** Produces only the factory and shared consumer types through
`@api-migrator/app/runner-evidence-internal`. Does not connect any console route.

- [ ] **6.1 Add a failing package-surface test, then the explicit subpath.**
  Test built package resolution from `@api-migrator/app/runner-evidence-internal`
  and assert exactly one runtime export, `createRunnerEvidenceClient`.

```ts
export { createRunnerEvidenceClient } from "./runner-evidence.js";
export type {
  RunnerEvidenceContext, RunnerEvidenceConfig, RunnerEvidenceWorkspacePolicy,
  RetainedRunnerEvidenceIdentity, RunnerEvidenceFailureCode,
  RunnerEvidenceResult, RunnerEvidenceClient, RunnerEvidenceClientResult,
} from "./runner-evidence-contract.js";
```

  Add only this package exports entry:

```json
"./runner-evidence-internal": {
  "types": "./dist/runner-evidence-internal.d.ts",
  "default": "./dist/runner-evidence-internal.js"
}
```

  Assert absence from root, console-internal, preview-evidence and runner-internal
  namespaces; assert internal dependency factories/readers/test helpers cannot
  be imported via arbitrary package subpaths. Constructing a client with valid
  syntax plus nonexistent protected paths must perform no IO; acquiring then
  fails trust_unavailable. Invalid config/policy/extra clock/CA/port arguments or
  fields produce configuration_invalid before any IO. Invalid additional JS
  positional arguments must not install dependencies or overrides.

- [ ] **6.2 Extend the actual POST matrix and retain its consumption controls.**
  In `runs-route-runtime.test.ts`, define this control factory before the existing
  `shapedControls` array, then add `acquisitionControls` to that array:

```ts
const acquisitionControls = () => ({
  previewReceipt: "preview-v3.claimed-attestation.token",
  runnerEvidence: { ok: true, verified: {}, identity: { schemaVersion: 1 } },
  runnerEvidenceConfig: {
    serviceOrigin: "https://evidence.example.invalid",
    serviceAddresses: ["127.0.0.1"], registryDirectory: "/untrusted",
  },
  runnerCapabilityProviderAvailable: true,
});
```

  Keep the three real POST actions, exact 503 body, zero run rows, reusable lock,
  reusable valid preview/operator controls, and consumed-token negative control.
  Add a test-only network spy around the route invocation using `mock.method`
  on Node HTTPS and `syncBuiltinESMExports()` in the isolated test process; any
  call throws and increments a counter. Restore it in `finally`. Assert zero
  network calls and no server-side acquisition imports/activation switches.
  Also construct a valid-syntax production client in the test (never acquire)
  and show that its existence cannot affect any POST gate. Do not add production
  injection hooks to the route merely to support the test.

- [ ] **6.3 Extend real assembled-image exclusion checks.** In
  `prepare-runtime-root.test.mjs`, reject seven new privileged module files and
  the entire test-helper tree alongside the existing `privilegedPath` checks.

```js
for (const name of ["runner-evidence-contract", "runner-evidence-deadline",
  "runner-key-registry", "runner-evidence-transport", "runner-evidence-core",
  "runner-evidence", "runner-evidence-internal"]) {
  assert.equal(existsSync(join(runtimeRoot, "packages/app/dist", `${name}.js`)), false);
}
assert.equal(existsSync(join(runtimeRoot, "packages/app/test")), false);
```

  Retain the real CLI-load and fixed source-bundle digest checks. Do not broaden
  the image allowlist to make imports work; new pure-helper exports in the
  already included publication-runner module require no allowlist change.

- [ ] **6.4 Verify final software head and create an honest execution record.**

```bash
npm run build:packages
node --import tsx --test packages/app/test/runner-evidence-*.test.ts packages/app/test/package-surface.test.ts
npm run test --workspace @api-migrator/console
env API_MIGRATOR_DOCKER_TEST=1 npm run ci
npm run runner:image:build
npm run runner:image:verify
npm run runner:image:integration
git diff --check
```

  First verify Docker context/socket and runtime availability without changing
  the user's daemon/configuration. If a credential helper blocks public image
  operations, use an isolated temporary anonymous Docker client configuration
  and the verified local socket; never copy secrets or alter global settings.
  Where sandbox restrictions prevent network/Docker checks, request the needed
  scoped permission through supported tools and record unexecuted checks until
  they actually run. Do not substitute mocks for required Docker evidence.

  The verification record must contain actual commands/exit codes, per-suite
  totals, real versus injected tests, final code SHA, image ID, phase results,
  Node version, remaining warning, no-live-service boundary, and what remains
  gated. Do not publish private paths, keys, registry data, response bodies, or
  fabricated success. Run requesting-code-review and verification-before-completion
  workflows before presenting a feature PR as ready.

- [ ] **6.5 Commit the reviewed integration boundary and submit without merging.**

```bash
git add packages/app/src/runner-evidence-internal.ts packages/app/package.json packages/app/test/package-surface.test.ts packages/console/test/runs-route-runtime.test.ts packages/console/test/runner-capability.test.ts ops/publication-runner/image/test/prepare-runtime-root.test.mjs docs/plans/2026-09-09-runner-evidence-verification.md
git commit -m "test: lock runner evidence integration boundaries"
git remote get-url origin
git status --short --branch
git rev-parse HEAD
```

  Only after confirming the personal `Abhishekpundir23/api-migrator` remote and
  feature branch, push that branch and open one feature PR to `main`, using
  normal authenticated GitHub tooling. Resolve any existing matching PR first
  instead of duplicating it. Do not merge. Inspect current-head CI and runner
  image checks plus the existing hosted smoke workflow; report their exact head
  identity and status, not a prior successful run. If network permission or
  repository authority is unavailable, leave local commits intact and say so.

## Spec coverage and completion definition

| Specification requirement | Task / evidence |
| --- | --- |
| Scope, no activation, no writes, no credential access | Global constraints; 5 and 6 |
| Strict expected context and exact retained identity | 1 and 5 mutation tests |
| Preserved canonical source, branch casing, output and signature format | 1 existing-verifier controls; 5 |
| Fixed origin/IP/SPKI and bounded response | 1 configuration table; 4 real TLS/raw wire tests |
| Deadline, rollback, late IO, cancellation and no renewal | 2; 4 sockets; 5 reacquisition |
| Protected file, strict keys, all-entry validation, live revoke/rotation | 3 and 5 before/after reads |
| Exact branded capability and shorter preview lifetime | 5 and existing verifier assertions |
| Reusable reads, no authorization consumption, closed console | 5 exact rechecks; 6 actual POST controls |
| Privileged modules absent from image | 6 real assembly and actual image commands |
| Future producer/store/auth/deployment/attested receipts remain separate | Approved spec section 10; final execution record |

Completion means the software-only client passes its actual tests, unchanged
boundaries remain verified, and a reviewed feature PR has current-head evidence.
It does not mean an independently operated signer, live service, paid pilot,
production deployment, or publication flow is complete. Those require separate
work and authorization. No merge is part of executing this plan.
