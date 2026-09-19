# Protected Runner Job Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve an immutable expected migration job, separately reviewed output, and first verified evidence identity across local process restarts without granting publication authority.

**Architecture:** A server-internal app service owns validation and lifecycle transitions. A separate local SQLite adapter owns restricted-path storage, atomic writes, and recovery. The existing evidence client verifies against stored expectations; the new service returns metadata only.

**Tech Stack:** Node 22, TypeScript, existing `better-sqlite3`, Node test runner with `tsx`, existing canonical source/plan/evidence implementations, disposable Git and Ed25519 fixtures.

**Spec:** [Approved local-first design](../specs/2026-09-19-protected-runner-job-record-design.md).

Status: proposed implementation plan, awaiting user review and execution-method selection. This document does not implement its code examples. Product baseline: `36bab9c85cd6c95bd0ac27ded0da0d3e44faa293`; design commit: `44ba21d8ab079698ef4533fc4bceae8d233dd10e`.

## Global Constraints

- `RUNNER_CAPABILITY_PROVIDER_AVAILABLE = false`; `prepare_owner_challenge`, `prepare_publish`, and `publish` remain unconditionally blocked server-side.
- No cloud provisioning, spending, scheduler, source upload, migration execution, external signer, GitHub write-token request, owner approval consumption, PR publication, or merge by the new feature.
- No GitHub App scope changes. Dynamo, Toloka, professional, and client assets remain excluded. Only disposable fixtures are used during this slice.
- No new route, UI, environment activation switch, public CLI, or attested receipt format. Reserved `preview-v3` stays rejected.
- Node 22 is the implementation/test runtime. Add no runtime dependencies; do not change the lockfile except if a separately justified dependency correction is approved.
- Storage uses `DELETE` journal mode, `synchronous=FULL`, a 250 ms busy timeout, 0700 dedicated directory, and 0600 database/sidecar files.
- Limits: 256 KiB per canonical record, 100 records, 64 MiB database; plan lifetime 1-to-15 minutes; review lifetime 10 minutes; retained expiry never renewed.
- Hashes detect inconsistent records, not malicious same-UID database rewrites. Complete snapshot rollback, trusted time during downtime, and live custody remain unsolved deployment gates.
- No ordinary campaign DB singleton, owner replay ledger, or owner-store anchor reuse. No job modules or native database dependency in the credential-free runner.
- Both author and committer for every project or temporary fixture Git commit: `Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>`. No attribution trailers, history rewriting, or automatic push/merge.

## Review Focus

These five easy-to-miss cases are explicitly assigned below:

1. A retry arrives with less than one minute left on the original plan: return the same still-current job, not a new nonce or a new-plan minimum-TTL failure (Task 3).
2. The process dies after a committed write but before the caller receives success: retry returns that durable revision, not a second job (Tasks 2 and 5).
3. Two successful acquisitions race with different genuinely signed envelopes: retain one identity and reject the other without overwriting it (Task 4).
4. Expired historical records coexist with a valid record after restart: inspection/open succeeds, but only the valid record can advance (Tasks 1, 3, and 5).
5. An array getter or post-call mutation tries to change input while I/O is pending: reject getters without invoking them and use a detached snapshot (Tasks 1 and 4).

## File map and execution order

All paths below are repository-relative. Run commands from the repository root unless a step says otherwise. Files named here but absent at the baseline are proposed files, not existing APIs.

| Task | Files and responsibility |
| --- | --- |
| 1. Records | `packages/app/src/runner-job-record-contract.ts` (shape/codec/expiry/intent); small validator extractions in `runner-evidence-contract.ts` and `publication-runner.ts`; contract tests and fixture identity guards |
| 2. Storage | `packages/db/src/runner-job-store-contract.ts`, `runner-job-store-path.ts`, `runner-job-store-sqlite.ts`, `runner-job-store-internal.ts`; dedicated schema, file checks, transactions, bounded recovery tests |
| 3. Preparation/review | `packages/app/src/runner-job-producer.ts`, `runner-job-service-core.ts`; canonical source preparation and append-once review; new `test/helpers/runner-job-fixture.ts` |
| 4. Evidence | `packages/app/src/runner-job-evidence.ts`, `runner-job-record.ts`, `runner-job-record-internal.ts`; store-bound acquisition and normal factory, with source-internal test seams only |
| 5. Integration | process interruption tests, package-surface/console-gate/runtime-closure tests, actual image verification, README and implementation verification report |

Tasks 1 and 2 establish the interfaces consumed by Task 3. Task 4 requires all three; Task 5 checks the integrated branch. Do not parallelize writers touching shared contract files. A reviewer can check a finished task while the main worker prepares read-only context for the next one.

## Before execution

- [ ] Read the approved spec and this complete plan. Load the execution, test-driven-development, worktree, and identity skills. The current checkout is already a linked worktree; inspect it and preserve any later user changes instead of creating or resetting another checkout.
- [ ] Confirm a Node 22 binary and install dependencies under that same binary if needed. At plan authoring the default `node` was v26.5.0 and `/opt/homebrew/opt/node@22/bin/node` was absent: select or install a Node 22 runtime during authorized implementation before running the commands below. Verify that `node` and the npm subprocesses resolve that same runtime. Native `better-sqlite3` built under another Node ABI is not test evidence. Do not launch tests creating Git commits until Task 1's fixture guard is in place.

```sh
git status --short --branch
git rev-parse --git-dir --git-common-dir
node --version
npm --version
npm ci
npm run build:packages
```

- [ ] Before **every task commit**, inspect the staged paths and run the identity skill's `scripts/verify_commit_identity.sh` from its installed location; after committing run it with `--head`. Stage only the task's listed files. A failed identity or verification check stops the commit. Suggested commit messages appear with each task; no push is included.

## Task 1: Define immutable records and safe test fixtures

**Files**

- Create: `packages/app/src/runner-job-record-contract.ts`.
- Modify: `packages/app/src/runner-evidence-contract.ts` (factor structural validation from current-time validation, retaining existing client behavior).
- Modify: `packages/app/src/publication-runner.ts` (factor existing nonce-free plan input normalization, without changing wire bytes or constraints).
- Create: `packages/app/test/runner-job-record-contract.test.ts`.
- Create: `scripts/test-git-identity.mjs` and `packages/app/test/test-git-identity.test.ts`.
- Modify test-only Git helpers: `packages/app/test/helpers/runner-evidence-fixture.ts`, `packages/app/test/preview-source.test.ts`, `packages/app/test/github-preview-source.test.ts`, `packages/runner/test/source-bundle.test.ts`, `ops/publication-runner/image/run-phase-integration.mjs`.
- Reuse: `packages/app/test/helpers/publication-runner-fixture.ts`.

**Interfaces**

Consumes the existing `PreviewSourceIdentity`, `PublicationRunnerPlanRecord`, `PublicationRunnerOutput`, `RunnerEvidenceContext`, and `RetainedRunnerEvidenceIdentity`. Produce these source-internal contracts; none is a new public package-root export:

```ts
type JobKey = { campaignId: string; runId: string; jobId: string };
type JobFailureCode =
  | "input_invalid" | "job_missing" | "job_conflict" | "job_expired"
  | "clock_rollback" | "store_unsafe" | "store_mismatch"
  | "store_corrupt" | "store_full" | "store_unavailable";
declare class RunnerJobError extends Error {
  readonly code: JobFailureCode;
  constructor(code: JobFailureCode);
}
type JobResult<T> = { ok: true; value: T }
  | { ok: false; source: "job"; code: JobFailureCode }
  | { ok: false; source: "evidence"; code: RunnerEvidenceFailureCode };
type RecordBase = JobKey & {
  schemaVersion: 1; storeId: string; intentDigest: string;
  source: PreviewSourceIdentity; plan: PublicationRunnerPlanRecord;
  recordDigest: string;
};
type JobRecord = RecordBase & (
  | { revision: 1; state: "prepared" }
  | { revision: 2; state: "reviewed"; review: RunnerEvidenceContext }
  | { revision: 3; state: "evidence_retained";
      review: RunnerEvidenceContext; identity: RetainedRunnerEvidenceIdentity }
);
type PreparedFields = Pick<RecordBase,
  "storeId" | "campaignId" | "runId" | "source" | "plan">;
declare function makePreparedRecord(input: PreparedFields): Readonly<JobRecord>;
declare function encodeJobRecord(record: unknown): string;
declare function decodeJobRecord(bytes: unknown): Readonly<JobRecord>;
declare function assertJobCurrent(record: JobRecord, now: number): void;
declare function preparationIntent(input: PreparedFields): Readonly<{
  campaignId: string; runId: string; pilotId: string;
  source: PreviewSourceIdentity; imageDigest: string;
  migrationInstallEgress: readonly RunnerEgressDestination[]; expiresAt: number;
}>;
declare function appendJobReview(record: JobRecord,
  output: unknown, completedAt: unknown, now: number): Readonly<JobRecord>;
declare function appendJobIdentity(record: JobRecord,
  identity: RetainedRunnerEvidenceIdentity, now: number): Readonly<JobRecord>;
```

`appendJobIdentity` is a pure source-internal transition helper, not an evidence-import entry point. Only Task 4 calls it in the service after genuine acquisition. Normal callers cannot supply a retained identity.

- [ ] **Add the fixture identity guard before running Git-producing tests.** Existing fixtures use synthetic identities; change only test/integration fixture authoring, not real history. Export `verifyFixtureIdentity(cwd, env, head = false): void` from the new `.mjs` helper. Use the following comparison for both author and committer; call it immediately before each fixture commit and with `head=true` after it:

```js
import { execFileSync } from "node:child_process";
const EXPECTED = "Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>";
export function verifyFixtureIdentity(cwd, env, head = false) {
  const git = (args) => execFileSync("git", args, {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  for (const kind of ["AUTHOR", "COMMITTER"]) {
    const value = git(["var", `GIT_${kind}_IDENT`]).replace(/ \d+ [+-]\d{4}$/, "");
    if (value !== EXPECTED) throw new Error("fixture Git identity rejected");
  }
  if (head) {
    for (const format of ["%an <%ae>", "%cn <%ce>"]) {
      if (git(["show", "-s", `--format=${format}`, "HEAD"]) !== EXPECTED)
        throw new Error("fixture commit identity rejected");
    }
  }
}
```

Set the four fixture `GIT_AUTHOR_*`/`GIT_COMMITTER_*` name/email values to the exact identity. Remove conflicting `user.name`/`user.email` options in the image and source-bundle fixtures. Preserve fixture dates, isolated Git configuration, no-signing behavior, and repository bytes. Add the fixture checkout path to `runnerEvidenceFixture`'s return type/value so Task 3 can prepare from it. The path remains test-only and is removed by its existing cleanup.

- [ ] **Test the guard without making a bad commit.** Initialize a disposable repository, configure the exact identity, assert the precheck succeeds, then change only the subprocess's author or committer email and assert rejection. With correct metadata, make one fixture commit and assert the postcheck succeeds. Use Node's `mkdtempSync`, `t.after` cleanup of that exact directory, and `verifyFixtureIdentity` around the test's own commit.

```ts
for (const key of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) {
  assert.throws(() => verifyFixtureIdentity(repo, {
    ...goodEnv, [key]: "wrong@example.invalid",
  }), /fixture Git identity rejected/);
}
```

Here `repo` is that disposable repository and `goodEnv` is its sanitized exact-identity environment. This fixture guard is test support; do not put it in the runner image or public API.

- [ ] **Write the first failing record test.** Use the existing fixture at `NOW = 2_000_000_000_000` and an actual random UUID for the local store ID. The test owns and closes the fixture. Cover historical reads and current-use rejection separately:

```ts
const f = runnerEvidenceFixture(NOW);
t.after(() => f.close());
const record = makePreparedRecord({ storeId: randomUUID(),
  campaignId: f.context.campaignId, runId: f.context.runId,
  source: f.context.source, plan: f.context.plan });
const bytes = encodeJobRecord(record);
assert.deepEqual(decodeJobRecord(bytes), record);
assert.doesNotThrow(() => decodeJobRecord(bytes));
assert.throws(() => assertJobCurrent(record, record.plan.plan.job.expiresAt));
assert(Object.isFrozen(record.source.base));
let reads = 0;
const bad = structuredClone(record);
Object.defineProperty(bad.plan.plan.execution.phaseOrder, "0", {
  enumerable: true, get() { reads++; return "offline_preparation"; },
});
assert.throws(() => encodeJobRecord(bad));
assert.equal(reads, 0);
```

- [ ] Run `node --import tsx --test packages/app/test/test-git-identity.test.ts packages/app/test/runner-job-record-contract.test.ts`. Expected initial failure: missing new record functions; fixture identity tests pass. Do not count syntax/fixture failures as the intended red test.

- [ ] **Implement strict record encoding and structural validation.** Export `detachRunnerEvidenceData(value: unknown): unknown` from `runner-evidence-contract.ts` at source level, factoring its existing descriptor check plus canonical detach. This preserves array getter rejection before serialization. Factor `validateRunnerEvidenceContextStructure(value: unknown): Readonly<RunnerEvidenceContext>`; keep all existing clock checks and failure ordering in `validateRunnerEvidenceContext(value, now)`. Neither helper is re-exported from `runner-evidence-internal`.

```ts
const body = { schemaVersion: 1 as const, storeId: input.storeId,
  campaignId: input.campaignId, runId: input.runId,
  jobId: input.plan.plan.job.id, revision: 1 as const, state: "prepared" as const,
  intentDigest: runnerEvidenceDigest(preparationIntent(input)),
  source: input.source, plan: input.plan };
const candidate = { ...body, recordDigest: runnerEvidenceDigest(body) };
return decodeJobRecord(canonicalJson(candidate));
```

`decodeJobRecord` uses `parseCanonicalJson(bytes, 256 * 1024, "job record")`; validates exact keys for each revision, UUID store ID, existing identifier/source/plan/output formats, canonical plan JSON/digest, and job/subject/source binding. Recompute intent and record digests. For revisions 2/3 require the embedded context's campaign/run/source/plan to equal the record, completion within the plan's lifetime, and retained context/job/plan digests to match. Retained expiry cannot exceed either plan expiry or completion plus 600000 ms. Do not claim stored signer fields are freshly trusted. Deep-freeze the validated result. `encodeJobRecord` detaches before property reads and round-trips through the same decoder.

- [ ] **Separate intent from random job identity.** Extract `normalizePublicationRunnerPlanInput(input: CreatePublicationRunnerPlanInput)` from the existing constructor; it returns `{createdAt, expiresAt, subject, inputs, imageDigest, destinations}` using the same existing validators and ordering. Constructor delegates to it, then generates the nonce and job ID exactly as before. Do not create a new plan format or loosen DNS controls. `preparationIntent` selects canonical source, pilot/campaign/run, image, normalized destinations, and absolute expiry; it excludes store ID, filesystem path, nonce, and creation time.

- [ ] **Pin mutation and expiry behavior in parameterized tests.** For each record mutation below, assert `encodeJobRecord` throws; for byte changes use `decodeJobRecord`. Keep the original digest unchanged to test corruption; separately recompute it to test semantic bindings. Use `runnerEvidenceDigest` only for that deliberate corruption fixture.

```ts
for (const mutate of [
  (r: any) => { r.extra = true; },
  (r: any) => { r.revision = 4; },
  (r: any) => { r.source.base.treeSha = "f".repeat(40); },
  (r: any) => { r.source.repository.id++; },
  (r: any) => { r.plan.digest = fixtureDigest("other"); },
  (r: any) => { r.jobId = `previewjob_${"f".repeat(64)}`; },
]) {
  const changed = structuredClone(record); mutate(changed);
  assert.throws(() => encodeJobRecord(changed));
}
for (const bytes of ["{}\n", '{"a":1,"a":1}', "x".repeat(262145)])
  assert.throws(() => decodeJobRecord(bytes));
```

Also exercise `appendJobReview` and `appendJobIdentity`: exact current duplicates preserve bytes; wrong state, output, completion, and each retained-identity field conflict; exact expiry rejects; pre-creation time rejects. Historical decode never calls a validator with a fabricated current time. Error construction exposes only fixed codes.

- [ ] Run the new tests plus `runner-evidence-contract.test.ts`, `runner-evidence-acquisition.test.ts`, and `publication-runner.test.ts`; run `npm run build:packages`. Expected: all pass, unchanged evidence-client rejection codes/wire formats, no test Git identity mismatch.
- [ ] Commit the listed files after the global checks: `Define immutable runner job record contracts`.

## Task 2: Implement the dedicated durable SQLite adapter

**Files**

- Create: `packages/db/src/runner-job-store-contract.ts`, `runner-job-store-path.ts`, `runner-job-store-sqlite.ts`, `runner-job-store-internal.ts`.
- Create: `packages/db/test/runner-job-store.test.ts`, `packages/db/test/runner-job-store-process.ts`.
- Modify: `packages/db/package.json` (new internal subpath only).
- Read patterns, do not import singleton code: `packages/db/src/client.ts:659` and `packages/db/test/owner-authorization.test.ts`.

**Interfaces**

The database must not import app types. The app converts between `JobRecord` and `StoredJobRow` and validates canonical bytes after reads. Adapter errors use the fixed codes declared below; store only the code as the error message, never the underlying SQL/path.

```ts
type StoreFailureCode = "input_invalid" | "job_conflict" | "clock_rollback"
  | "store_unsafe" | "store_mismatch" | "store_corrupt"
  | "store_full" | "store_unavailable";
declare class JobStoreError extends Error {
  readonly code: StoreFailureCode;
  constructor(code: StoreFailureCode);
}
type StorePolicy = {
  applicationCheckout: string; migrationWorkspaceRoots: readonly string[];
};
type StoredJobRow = {
  campaignId: string; runId: string; jobId: string;
  revision: 1 | 2 | 3; intentDigest: string; recordDigest: string;
  canonicalRecord: string;
};
interface JobStore {
  readonly storeId: string;
  list(): readonly StoredJobRow[];
  read(campaignId: string, runId: string): StoredJobRow | null;
  observeTime(now: number): void;
  insert(row: StoredJobRow): { inserted: boolean; row: StoredJobRow };
  compareAndSwap(previous: StoredJobRow, next: StoredJobRow): {
    committed: boolean; row: StoredJobRow;
  };
  close(): void;
}
declare function initializeJobStore(directory: string, policy: StorePolicy): { storeId: string };
declare function openJobStore(directory: string, expectedStoreId: string, policy: StorePolicy): JobStore;
```

Initialization generates the UUID and schema in an explicit operation. Open never initializes. Normal policy always rejects temporary/platform-excluded roots; expose a separate **source-only**, non-package-exported `createJobStoreTestAccess(testRoot)` returning the same initialize/open operations with exactly that disposable root admitted. Preserve every non-location protection. This is not an environment bypass.

```ts
declare function createJobStoreTestAccess(testRoot: string): {
  initialize(directory: string, policy: StorePolicy): { storeId: string };
  open(directory: string, expectedStoreId: string, policy: StorePolicy): JobStore;
};
```

- [ ] **Write failing disk-store tests.** Create a canonical temporary root, a 0700 empty child directory, and use `createJobStoreTestAccess(root)`. Define a test `row(label)` producing small canonical opaque DB bytes with valid index fields; the database tests do not pretend those rows are valid app evidence. The matching app validation is exercised in Tasks 3–5.

```ts
const access = createJobStoreTestAccess(root);
const { storeId } = access.initialize(directory, policy);
const first = access.open(directory, storeId, policy);
first.observeTime(1000);
assert.equal(first.insert(row("one")).inserted, true);
assert.equal(first.insert(row("one")).inserted, false);
first.close();
const reopened = access.open(directory, storeId, policy);
assert.equal(reopened.list().length, 1);
assert.throws(() => reopened.observeTime(999), { code: "clock_rollback" });
assert.deepEqual(reopened.read("campaign_one", "run_one"), row("one"));
reopened.close();
```

Here `row(label)` uses `campaign_${label}`, `run_${label}`, a job ID made by prefixing a 64-character lowercase SHA-256 hex digest with `previewjob_`, revision 1, and SHA-256 digests of its small canonical JSON. The test defines that helper locally with Node crypto. A new random store ID, not any real deployment value, is used for every test.

- [ ] Run `node --import tsx --test packages/db/test/runner-job-store.test.ts`. Expected initial failure: adapter not implemented. No ordinary DB or replay-store initializer is called.

- [ ] **Implement path custody and bounded initialization/open.** Keep path code separate from SQL. Walk ancestor components with `lstat`; reject symlinks, relative/dot paths, NUL/control characters, unsafe writable ancestors, and workspace overlap. Ancestors may be root/current-user owned; the leaf directory/database must be current-user owned with exact 0700/0600 modes, no special mode bits, and a single link for regular files. Test-only location admission permits the canonical temporary ancestor but not unsafe descendants. Reject unsupported ownership APIs/platforms. Check exclusion policy in both directions so the store cannot contain a migration root. Use one fixed basename, `runner-jobs.sqlite`.

Create the database file exclusively (`O_CREAT | O_EXCL | O_NOFOLLOW`, 0600) in the already validated empty directory. Pin device/inode/owner/mode/link-count during each open handle's lifetime, checking before operations, after SQLite open, and after durable sync. Validate journal files before SQLite can recover them; reject WAL/SHM, non-regular/linked journals, and weak modes. Do not repair unsafe paths or partially initialized directories. Do not claim an inode remembered only within a process prevents cross-restart snapshot restoration.

- [ ] **Create a fixed schema and settings.** The complete schema has two tables and SQLite's associated unique indexes; no app tables, triggers, or extra attached databases. Compare stored SQL/index metadata with expected definitions and run `integrity_check` before exposing a handle. Validate all row lengths, counts, revisions, keys and digest syntax. The app performs semantic decoding before it exposes its service.

```sql
CREATE TABLE job_store_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  store_id TEXT NOT NULL UNIQUE,
  wall_high_water INTEGER NOT NULL CHECK (wall_high_water >= 0)
);
CREATE TABLE runner_jobs (
  campaign_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision IN (1, 2, 3)),
  intent_digest TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  canonical_record TEXT NOT NULL
    CHECK (length(CAST(canonical_record AS BLOB)) BETWEEN 1 AND 262144),
  PRIMARY KEY (campaign_id, run_id)
);
```

Use `journal_mode=DELETE`, `synchronous=FULL`, `fullfsync=ON`, `busy_timeout=250`, and a `max_page_count` computed as `floor(67108864 / page_size)`; verify effective settings. Reject a file larger than 64 MiB before opening and after writes. Do not call or expose extension loading, raw SQL, or the native handle; reject attached databases. Bound journal size to 68 MiB, above the database limit for page/header overhead; never parse arbitrary files as journals. No new environment settings.

- [ ] **Implement atomic writes and durable readback.** Wrap insertion, high-water updates, and CAS in immediate transactions. Count before insert in the same transaction; existing-key lookup precedes capacity rejection. Existing-key insertion returns its current row without replacing it; same job ID under a different key is a conflict. CAS compares all prior index/digest/byte fields, permits only revision + 1 with unchanged key/intent, and returns the actual winner if another writer advanced it. App code decides whether that winner is an exact permitted duplicate.

```sql
UPDATE runner_jobs
SET revision = @next_revision, record_digest = @next_digest,
    canonical_record = @next_bytes
WHERE campaign_id = @campaign AND run_id = @run AND job_id = @job
  AND revision = @previous_revision AND intent_digest = @intent
  AND record_digest = @previous_digest AND canonical_record = @previous_bytes;
```

Every successful modifying operation fsyncs the main-file descriptor and directory, rechecks identity/settings, then reads back the committed row or high-water value. Map busy/storage failures to `store_unavailable`; map capacity/SQLite-full to `store_full`. A sync failure after commit is an uncertain success, not permission to roll back or overwrite: return failure and let a later exact retry inspect committed state. `observeTime` is its own committed operation, so a later failed job transition does not erase the observed high-water mark.

- [ ] **Test real file rejection, count limits, and uncertain completion.** Use separate stores for each mutation and restore neither production data nor history:

```ts
const mutations: Array<(directory: string, databasePath: string, root: string) => void> = [
  (directory) => chmodSync(directory, 0o755),
  (_directory, databasePath) => chmodSync(databasePath, 0o644),
  (_directory, databasePath, root) => linkSync(databasePath, join(root, "second-link")),
  (_directory, databasePath) => writeFileSync(`${databasePath}-wal`, "unexpected", { mode: 0o600 }),
];
for (const [index, mutate] of mutations.entries()) {
  await t.test(`unsafe store ${index}`, (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-job-store-test-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, "store");
    mkdirSync(directory, { mode: 0o700 });
    const policy = { applicationCheckout: process.cwd(), migrationWorkspaceRoots: [join(root, "workspace")] };
    const access = createJobStoreTestAccess(root);
    const { storeId } = access.initialize(directory, policy);
    mutate(directory, join(directory, "runner-jobs.sqlite"), root);
    assert.throws(() => access.open(directory, storeId, policy));
  });
}
```

Run each case inside its own test fixture (not successively on the same corrupted directory). Add missing/wrong UUID, symlink ancestors/files/journal, replaced inode while open, wrong schema/extra trigger, malformed UTF-8 row bytes, 101st insert, 262145-byte record, oversized database/journal, and backwards clock. For CAS, start two handles at revision 1, let A commit 2, and assert B cannot replace A. Use a source-only failpoint after commit and before sync/readback to assert failure followed by successful exact read; no exported failpoint parameter.

- [ ] Re-run the focused DB tests and `npm run build:packages`; expected all pass. Add the DB internal export mapping to `dist/runner-job-store-internal.{js,d.ts}`; root `index.ts`, `client.ts`, migration scripts and owner store stay untouched.
- [ ] Commit after the global checks: `Add durable local runner job storage`.

## Task 3: Prepare expected jobs and append separately reviewed output

**Files**

- Create: `packages/app/src/runner-job-producer.ts`, `packages/app/src/runner-job-service-core.ts`.
- Create: `packages/app/test/helpers/runner-job-fixture.ts`, `packages/app/test/runner-job-preparation.test.ts`, `packages/app/test/runner-job-review.test.ts`.
- Consume: Tasks 1–2 contracts, existing `runner-source-bundle.ts` and `publication-runner.ts`.

**Interfaces**

The source-only functions below throw fixed `JobStoreError` or Task 1's
`RunnerJobError` carrying `JobFailureCode`; Task 4 maps them into `JobResult`.
`RunnerJobError` lives in the record-contract module. No raw exception
message crosses the normal service boundary.

```ts
type JobClock = { wallNow(): number; monotonicNow(): number };
type PrepareJobInput = {
  campaignId: string; runId: string; pilotId: string;
  checkoutPath: string;
  repository: PreviewSourceIdentity["repository"];
  base: PreviewSourceIdentity["base"];
  manifestJson: string; imageDigest: string;
  migrationInstallEgress: RunnerEgressDestination[];
  expiresAt: number;
};
declare function recordToStoredRow(record: JobRecord): StoredJobRow;
declare function validateStoredJob(row: StoredJobRow, storeId: string): Readonly<JobRecord>;
declare function inspectRunnerJob(store: JobStore, key: unknown): Readonly<JobRecord>;
declare function prepareRunnerJob(store: JobStore, input: unknown,
  clock: JobClock): Readonly<JobRecord>;
declare function recordRunnerJobReview(store: JobStore, key: unknown,
  output: unknown, completedAt: unknown, clock: JobClock): Readonly<JobRecord>;
```

Define `recordToStoredRow` by selecting the six index fields and
`canonicalRecord: encodeJobRecord(record)`. `validateStoredJob` decodes those
bytes, compares every index field and expected store ID, and reports corruption
or store mismatch without returning unvalidated data. `inspectRunnerJob`
validates exactly `{campaignId, runId, jobId}`, looks up campaign/run, and
requires matching job ID; missing pair is `job_missing`, mismatched job is
`job_conflict`. Inspection does not require current time or mutate the store.

- [ ] **Build the disposable job fixture.** Export `createJobFixture()` from
the new test helper. It creates `runnerEvidenceFixture(2_000_000_000_000)`, a
separate canonical temporary store root, test-only store access, and initialized
store. Return `{sourceFixture, input, clock, state, store, storeId, directory,
policy, access, close}`. `state = {wall: sourceFixture.context.plan.plan.job.createdAt,
monotonic: 0}`; `clock` reads that state. `input` takes repository/base/manifest
from the bundle, the newly exposed fixture checkout path, and the original
plan's pilot/image/destinations/expiry. `close()` closes all opened handles and
removes only these two fixtures. Do not let any fixture create a real store in
the user's directories or set activation environment variables.

- [ ] **Write a failing prepare/retry test with the original expiry.** Use a
fresh fixture for each test and `t.after(() => f.close())`:

```ts
const first = prepareRunnerJob(f.store, f.input, f.clock);
f.state.wall = first.plan.plan.job.expiresAt - 1000;
const retry = prepareRunnerJob(f.store, structuredClone(f.input), f.clock);
assert.deepEqual(retry, first);
assert.equal(f.store.list().length, 1);
assert.equal(retry.plan.plan.job.createdAt, first.plan.plan.job.createdAt);
assert.equal(retry.plan.plan.job.expiresAt, first.plan.plan.job.expiresAt);
assert.throws(() => prepareRunnerJob(f.store,
  { ...f.input, imageDigest: fixtureDigest("another image") }, f.clock),
  { code: "job_conflict" });
```

- [ ] Run `node --import tsx --test packages/app/test/runner-job-preparation.test.ts`.
Expected initial failure: producer missing, not a bad source fixture or an
expired fixture clock.

- [ ] **Implement source preparation and nonce-safe idempotency.** Detach the
input and validate its exact keys before touching the checkout. Reject a
caller-provided `now`, plan, output, URL, or retained identity. Commit
`store.observeTime(clock.wallNow())` before source I/O. Call `createSourceBundle`
then `parseSourceBundle` on the resulting bytes; derive the entire source
identity from the validated header and digests. Discard bundle contents after
preparation; never persist or return them from the record service.

Read any existing campaign/run row and validate it. For a retry, normalize the
candidate plan inputs with the **stored** creation time and compare the
nonce-free intent. For a new job, normalize/create using current trusted time.
The following construction uses the parsed bundle, not fields from evidence:

```ts
const planInput: CreatePublicationRunnerPlanInput = {
  pilotId: input.pilotId,
  repository: parsed.header.repository,
  base: { branch: parsed.header.base.branch, sha: parsed.header.base.sha },
  sourceArchiveDigest: parsed.digest,
  manifestDigest: parsed.header.manifest.digest,
  imageDigest: input.imageDigest,
  migrationInstallEgress: input.migrationInstallEgress,
  expiresAt: input.expiresAt,
  now: existing ? existing.plan.plan.job.createdAt : clock.wallNow(),
};
const normalized = normalizePublicationRunnerPlanInput(planInput);
```

Build a nonce-free candidate intent directly from `normalized` plus source and
campaign/run (the same fields/order-insensitive canonical shape as
`preparationIntent`). If an existing record's intent differs, return conflict;
otherwise assert it is still current and return it without calling the random
plan constructor. For new jobs create the plan, build revision 1, observe time
again, assert current, and insert. If insertion finds a winner, validate it and
compare exact intent, then return only the winner. If source validation detects
a change or the plan expires before insertion, no new job row may be inserted. If
expiry is first observed after a durable insert, return `job_expired` while
preserving the immutable revision-1 row as historical state; do not delete or
replace it, or return success. That expired row consumes one bounded slot. Keep
the observed high-water mark even when preparation fails.

- [ ] **Implement append-once review.** Snapshot and validate key/output/time
before storage use. Read/validate the current record, check high-water and
expiry, call `appendJobReview`, then CAS the complete previous bytes. The pure
helper builds review from stored expectations only:

```ts
const review = validateRunnerEvidenceContext({
  campaignId: record.campaignId, runId: record.runId,
  source: record.source, plan: record.plan,
  reviewedOutput: output, previewCompletedAt: completedAt,
}, now);
```

For revision 1 append that context and recompute the record digest. At revisions
2/3 compare canonical review bytes and return the original record if identical;
otherwise conflict. On CAS loss, reread, validate, and accept only the identical
review (including completion time and immutable prepared fields); do not retry
with a new timestamp. Recheck current time after write/readback before returning.

- [ ] **Test each source and review boundary with explicit expectations.**
Use independent fixtures for dirty/missing source, wrong approved base tree,
wrong commit, invalid manifest, invalid image, and invalid DNS inputs. For
repository identity, a previously prepared campaign/run with changed ID or
owner must conflict; local Git is not claimed to authenticate an arbitrary
first-time caller's repository ID. Verify invalid preparation leaves zero rows.

```ts
const prepared = prepareRunnerJob(f.store, f.input, f.clock);
f.state.wall += 105000;
const completedAt = f.state.wall - 500;
const output = publicationRunnerReviewedOutput();
const key = { campaignId: prepared.campaignId, runId: prepared.runId, jobId: prepared.jobId };
const reviewed = recordRunnerJobReview(f.store, key, output, completedAt, f.clock);
assert.equal(reviewed.revision, 2);
assert.deepEqual(recordRunnerJobReview(f.store, key, output, completedAt, f.clock), reviewed);
assert.throws(() => recordRunnerJobReview(f.store, key,
  { ...output, candidateTreeSha: "4".repeat(40) }, completedAt, f.clock),
  { code: "job_conflict" });
assert.throws(() => recordRunnerJobReview(f.store, key, output,
  completedAt + 1, f.clock), { code: "job_conflict" });
```

Pass only the strict `JobKey` selection, not the complete prepared record.
Unknown keys are rejected, so passing the complete record is a separate
negative test expecting `input_invalid`.

- [ ] **Pin historical inspection, exact expiry and input mutation.** Close and
reopen, validate every row, and inspect the same reviewed record at its expiry.
`recordRunnerJobReview` must then throw `job_expired`, even for an exact repeat.
Before review, completion earlier than creation or later than the current clock
is `input_invalid`. Test missing/mismatched job keys, hidden fields, malformed
Git OIDs, and current-time overrides without source/DB side effects.

```ts
f.state.wall = completedAt + 600000;
assert.deepEqual(inspectRunnerJob(f.store, key), reviewed);
assert.throws(() => recordRunnerJobReview(f.store, key, output, completedAt, f.clock),
  { code: "job_expired" });
```

- [ ] Run both new app test files, the contract/store tests, existing
`preview-source.test.ts`, and `npm run build:packages`. Expected: all pass;
plans/reports/source bytes never become evidence by themselves.
- [ ] Commit after the global checks: `Prepare and retain expected runner jobs`.

## Task 4: Retain only genuinely verified evidence identity

**Files**

- Create: `packages/app/src/runner-job-evidence.ts`, `runner-job-record.ts`, `runner-job-record-internal.ts`.
- Create: `packages/app/test/runner-job-evidence.test.ts`.
- Extend: `packages/app/test/helpers/runner-job-fixture.ts` with a store-bound genuine-verifier harness.
- Modify: `packages/app/package.json` (new internal subpath only).

**Interfaces**

The normal factory validates configuration without I/O and exposes an explicit
open operation. It supplies `Date.now`/`performance.now` and the actual checkout
exclusion internally; callers cannot override either. `evidence: null` permits
preparation/inspection without configuring a live service, but acquisition
then fails with an evidence `configuration_invalid` result, never fabricated
success.

```ts
type RunnerJobConfig = {
  directory: string; expectedStoreId: string;
  evidence: RunnerEvidenceConfig | null;
};
interface RunnerJobSession {
  inspect(key: unknown): JobResult<Readonly<JobRecord>>;
  prepare(input: unknown): JobResult<Readonly<JobRecord>>;
  recordReviewedOutput(key: unknown, output: unknown,
    completedAt: unknown): JobResult<Readonly<JobRecord>>;
  acquireEvidence(key: unknown): Promise<JobResult<Readonly<JobRecord>>>;
  close(): void;
}
declare function createRunnerJobService(config: unknown,
  policy: RunnerEvidenceWorkspacePolicy): JobResult<{
    open(): JobResult<RunnerJobSession>;
  }>;
declare function acquireRunnerJobEvidence(store: JobStore, key: unknown,
  clock: JobClock, client: RunnerEvidenceClient): Promise<JobResult<Readonly<JobRecord>>>;
```

`acquireRunnerJobEvidence` is source-internal. The package subpath exports only
`createRunnerJobService` and the types required by its normal callers. Do not
export core functions, raw row codecs, acquisition dependencies, clocks,
temporary-root admission, or failpoints through the app subpath.

- [ ] **Create a real-verifier evidence harness.** Add
`createJobEvidenceHarness(f: ReturnType<typeof createJobFixture>)` to the test
helper. It prepares/reviews using Task 3 at the fixture times and signs a new
`publicationRunnerAttestation(prepared.plan, prepared.plan.plan.job.createdAt,
output)` against that actual newly prepared plan. Do not reuse the source
fixture's old envelope: the new job has a different nonce.

Use `createRunnerEvidenceClientWithDependencies` with `f.clock`, a
`selectRunnerKey` reader over canonical registry fixture bytes, and a fetcher
returning the new signed envelope for the expected job ID. Return `{key,
prepared, reviewed, client, state, signPayload}`; `state` tracks `{reads, fetches,
envelope, registryBytes}`. Read keys twice through the real client and leave its
genuine verifier non-injectable. Only disposable test private keys are used.

- [ ] **Write the first failing retention/reopen test.**

```ts
const h = createJobEvidenceHarness(f);
const first = await acquireRunnerJobEvidence(f.store, h.key, f.clock, h.client);
assert.equal(first.ok, true);
if (!first.ok) throw new Error("fixture acquisition failed");
assert.equal(first.value.revision, 3);
assert.equal("verified" in first.value, false);
assert.equal(h.state.reads, 2);
const originalBytes = encodeJobRecord(first.value);
f.store.close();
const reopened = f.access.open(f.directory, f.storeId, f.policy);
const again = await acquireRunnerJobEvidence(reopened, h.key, f.clock, h.client);
assert.equal(again.ok, true);
if (!again.ok) throw new Error("fixture reacquisition failed");
assert.equal(encodeJobRecord(again.value), originalBytes);
assert.equal(h.state.reads, 4);
assert.equal(h.state.fetches, 2);
reopened.close();
```

- [ ] Run `node --import tsx --test packages/app/test/runner-job-evidence.test.ts`.
Expected initial failure: store-bound acquisition missing. Use fixture times,
not the actual wall clock, and do not contact a real service.

- [ ] **Implement snapshot/acquire/CAS.** Detach the exact job key before the
first await. Observe wall time, inspect the record, require revision 2/3, and
check current lifetime before starting network work. Use the genuine client:

```ts
const result = snapshot.revision === 3
  ? await client.reacquire(snapshot.review, snapshot.identity)
  : await client.acquireInitial(snapshot.review);
store.observeTime(clock.wallNow());
if (!result.ok) return { ok: false, source: "evidence", code: result.code };
assertJobCurrent(snapshot, clock.wallNow());
const candidate = appendJobIdentity(snapshot, result.identity, clock.wallNow());
```

Do not hold a transaction over this await. `appendJobIdentity` verifies identity
shape/bindings/expiry; only this genuine-client path can invoke it in the normal
service. If the stored row is unchanged, append revision 3 with CAS; if another
caller won, decode and compare the winner's complete canonical identity and
unchanged context. Identical winner is success; different winner is
`job_conflict`. Never return or store `result.verified`. For revision 3,
reacquire and compare without rewriting the row. After readback, observe time
again and revalidate original expiry before returning metadata.

Map known job/storage exceptions to the job result arm, retain the client's
exact failure codes in the evidence arm, and map unexpected storage/I/O errors
to `store_unavailable`. Reject invalid state before invoking the client. Do not
log raw exception messages, SQL, envelopes or source data.

- [ ] **Test competing genuinely signed envelopes using a barrier, not sleep.**
Create two real clients over the same plan/context: one fetches the original
envelope, one a valid envelope with a changed `runnerInstanceDigest`, signed by
the same disposable key. Add source-only test barriers around fetch completion
so both acquire from revision 2 before either commits. The barrier uses a Promise
and explicit release callbacks; no exported implementation bypass.

```ts
const results = await Promise.all([
  acquireRunnerJobEvidence(storeA, h.key, f.clock, clientA),
  acquireRunnerJobEvidence(storeB, h.key, f.clock, clientB),
]);
assert.equal(results.filter((r) => r.ok).length, 1);
assert.deepEqual(results.find((r) => !r.ok), {
  ok: false, source: "job", code: "job_conflict",
});
const winner = inspectRunnerJob(storeA, h.key);
assert.equal(winner.revision, 3);
```

`storeA`/`storeB` are independent handles on the fixture store; both clients are
constructed by the harness with genuine signatures and coordinated fetches.
Repeat with byte-identical envelopes: both may report success, but only one
revision-3 row exists and its original expiry is unchanged.

- [ ] **Test every changed identity and trust failure through real verification.**
After initial retention, replace the fixture envelope with another valid signed
envelope and expect evidence `identity_changed`; revoke/change the selected
registry entry and expect the existing client rejection; sign a different
artifact/tree and expect `evidence_invalid`. Feed malformed JSON, serialized
verified-object JSON, and local preview report JSON as transport responses;
none may create revision 3. Supply an extra identity/plan property in the job
key and assert `input_invalid` before `reads`/`fetches` increase.

```ts
const before = encodeJobRecord(inspectRunnerJob(f.store, h.key));
h.state.envelope = JSON.stringify({ kind: "local-preview", verified: true });
const failed = await acquireRunnerJobEvidence(f.store, h.key, f.clock, h.client);
assert.equal(failed.ok, false);
assert.equal(encodeJobRecord(inspectRunnerJob(f.store, h.key)), before);
```

- [ ] **Test pending-I/O mutation and expiry.** Hold fetch with an explicit
Promise; mutate the caller's key after invoking acquisition, release fetch,
and require comparison against the initial detached key. In separate runs move
the wall clock to exact plan/review/key expiry, backwards below the persisted
high-water mark, or move the monotonic clock beyond the existing deadline before
release. Require failure and no returned capability; identity already committed
before a late failure remains immutable and must not be silently rolled back.

- [ ] **Wire only the normal internal factory.** `open()` calls the dedicated
store open, validates every row via Task 3, closes it on any failure, and returns
a session of guarded operations. Construction validates exact config keys and
server-owned workspace exclusions; null evidence does not create a client.
Non-null evidence uses `createRunnerEvidenceClient` with real clock, transport,
and registry reader. Add a source-only factory for test access/dependencies;
do not export it. Closing a session invalidates every method and is idempotent;
reopening uses fresh validation and no cached evidence success.

- [ ] Run the new evidence tests, existing `runner-evidence-*.test.ts`, and
`npm run build:packages`. Expected all pass, two key reads on each successful
acquisition, and no durable/runtime capability returned by the new API.
- [ ] Commit after the global checks: `Retain verified runner evidence identities`.

## Task 5: Prove restart recovery and preserve publication isolation

**Files**

- Create: `packages/app/test/runner-job-recovery.test.ts`, `packages/app/test/helpers/runner-job-process.ts`.
- Extend: `packages/db/test/runner-job-store.test.ts` and its process helper from Task 2.
- Modify tests: `packages/app/test/package-surface.test.ts`, `packages/console/test/runner-capability.test.ts`, `ops/publication-runner/image/test/prepare-runtime-root.test.mjs`.
- Modify verifier only: `ops/publication-runner/image/verify-image-config.mjs` (additional absence assertions, no packaging changes).
- Modify documentation: `README.md`; create `docs/plans/2026-09-19-runner-job-record-verification.md` after actual results exist.

**Interfaces**

Consumes normal `createRunnerJobService`, source-only test access, and the
existing fixture/worker patterns. No new feature API. Worker IPC uses a fixed
test protocol `{event: "ready" | "before_commit" | "after_commit" | "result",
operation: "initialize" | "prepare" | "review" | "retain" | "observe_time"}`; request data
contains only disposable fixture paths/identities. Production exports do not
contain worker protocol, fault hooks, or test keys.

- [ ] **Write failing child-process recovery tests.** Use `child_process.fork`
with `execArgv: ["--import", "tsx"]`, explicit IPC barriers, a bounded 10-second
test timeout, and `SIGKILL` only for that test-owned child PID. Parent waits for
the child's exit before reopening, avoiding lock-release races. No sleeps are
used to guess whether a commit happened. A worker sends the selected failpoint
and waits indefinitely for termination; hooks are source-only.

```ts
for (const point of ["before_commit", "after_commit"] as const) {
  await t.test(point, async (t) => {
    const f = createJobFixture();
    t.after(() => f.close());
    prepareRunnerJob(f.store, f.input, f.clock);
    const child = startFixtureProcess(f, { operation: "review", point });
    await waitForFixtureMessage(child, point);
    const exited = waitForFixtureExit(child);
    child.kill("SIGKILL");
    await exited;
    const recovered = reopenAndInspectFixtureJob(f);
    assert.equal(recovered.revision, point === "before_commit" ? 1 : 2);
    assert.doesNotThrow(() => decodeJobRecord(encodeJobRecord(recovered)));
  });
}
```

Define these test helpers in `runner-job-recovery.test.ts`: `startFixtureProcess`
forks the new worker against the current test's fixture; `waitForFixtureMessage`
resolves only on a matching IPC event and rejects on error/early exit/timeout;
`waitForFixtureExit` resolves on exit and rejects on timeout;
`reopenAndInspectFixtureJob` calls the fixture's normal store open then Task 3's
strict inspection, closing its handle afterwards. Register listeners before
dispatching the worker operation: the worker first waits for an explicit start
message, which the parent sends only after its listeners are installed. Register
the exit listener before sending the kill signal. Terminate and await any still
running test-owned child in test cleanup, even when an assertion fails. A before-commit failpoint occurs inside the
transaction after tentative writes; after-commit occurs before result delivery.

- [ ] Run `node --import tsx --test packages/app/test/runner-job-recovery.test.ts`
and fix only recovery behavior exposed by a red test; do not add resubmission,
backup restoration, auto-repair, longer lifetimes, or publication fallback.

- [ ] **Complete the recovery matrix.** Run the same interrupted-write protocol
for initialization, preparation, review, retention, and high-water updates.
Interrupted initialization can leave an unusable partial store and must fail
closed; only a complete committed schema/ID can reopen. After-commit preparation
retries return the same job. After-commit retention reopens revision 3 and
reacquires exactly the original signed identity. Test two fresh processes
preparing the same intent and two conflicting intents; validate a single winner
and no exposed loser nonce. Test a held write lock: a contender fails within
the 250 ms busy budget plus a generous 1-second scheduling allowance, and does
not spin or change any row.

```ts
const expired = inspectRunnerJob(store, expiredKey);
const current = inspectRunnerJob(store, currentKey);
assert.doesNotThrow(() => decodeJobRecord(encodeJobRecord(expired)));
assert.doesNotThrow(() => assertJobCurrent(current, now));
assert.throws(() => assertJobCurrent(expired, now), { code: "job_expired" });
```

Create those two records at different trusted times within one fixture store,
with the first already expired when the second is prepared. Reopen it before
these assertions. Opening must not mint an attestation, clear expiry, or remove
the expired row. A deliberately coherent snapshot restore is **not** a passing
anti-rollback test: document that it remains outside the local trust boundary.

- [ ] **Extend package and import-side-effect tests.** Assert the new app/db
internal subpaths expose only their documented APIs and neither package root
nor console/preview/runner exports expose them. Trap filesystem-open and network
entry points for application I/O during factory construction; no store is opened
until explicit `open()`. Keep module-loader filesystem reads working during the
import, as the existing package-surface test does, then install filesystem
traps before constructing a factory. Trap networking before import as well.
Check the store path remains absent/untouched after import and construction.
Invalid config and missing store produce fixed errors.
Check null-evidence preparation is possible but acquisition fails closed. Import
test code must not accidentally use a raw adapter that skips app row validation.

- [ ] **Extend route and image absence assertions.** Reuse existing runtime
route tests for the three blocked actions; retain gate ordering before challenge,
approval, token acquisition, and publication. Add `runner-job` and
`createRunnerJobService` to forbidden route/capability imports. Extend the real
runtime-root test and actual image verifier with these absences:

```js
for (const name of ["runner-job-record-contract", "runner-job-producer",
  "runner-job-service-core", "runner-job-evidence", "runner-job-record",
  "runner-job-record-internal"]) {
  assert.equal(existsSync(join(runtimeRoot, "packages/app/dist", `${name}.js`)), false);
}
assert.equal(existsSync(join(runtimeRoot, "node_modules/better-sqlite3")), false);
assert.equal(existsSync(join(runtimeRoot, "node_modules/@api-migrator/db")), false);
```

For the actual image, express these as checks inside the existing container
verification command, not checks against the host checkout. Keep the existing
image module/dependency allowlist unchanged. Existing image integration may
execute its known disposable fixture; the new job-record service must not
execute or dispatch any source.

- [ ] **Run integrated validation on the exact implementation head.** First
run the focused tests below, then the repository's real suite and actual image.
These commands are future verification steps, not results from plan authoring:

```sh
npm run build:packages
node --import tsx --test packages/app/test/runner-job-*.test.ts packages/db/test/runner-job-store.test.ts
node --import tsx --test packages/app/test/package-surface.test.ts packages/console/test/runner-capability.test.ts packages/console/test/runs-route-runtime.test.ts
API_MIGRATOR_DOCKER_TEST=1 npm run ci
npm run runner:image:build
npm run runner:image:verify
npm run runner:image:integration
git diff --check
```

Expected: zero failures, with all new store/app/recovery tests executed rather
than skipped; successful real image verification/integration. If Docker or its
network-dependent fixture fails, record the exact failure and leave that gate
incomplete. Do not weaken the existing DNS floor, timeouts, signing boundaries,
or CI definitions to manufacture a pass. Do not quote the old 832-test baseline
as the new result.

- [ ] **Document the evidence and review the branch.** README describes this
as a local durable/corruption-checked record layer, not deployed protected
custody or pilot completion. The verification report records tested commit,
Node version, commands, counts/skips, image identity, crash/concurrency results,
remaining trust limits, and unchanged publication gate. Do not include temporary
keys, source bundles, database files or real credentials. Obtain an independent
whole-branch review; address findings with new commits and rerun affected tests.
- [ ] Commit the tests/docs after the global checks: `Verify runner job recovery and isolation`.

## Self-review coverage and handoff

| Design requirement | Owning task and acceptance evidence |
| --- | --- |
| Canonical source, pre-execution plan, nonce-safe duplicate preparation | 1 and 3: normalized intent, bundle checks, late retry, winner identity |
| Immutable reviewed output and original completion | 1 and 3: exact-context construction, duplicate/conflict and expiry tests |
| First genuine retained identity and no durable authority | 4: real verifier, signed-envelope race, no capability return, fresh reopen acquisition |
| Dedicated protected-path SQLite, bounds, schema and durable readback | 2: path/schema/capacity/CAS/sync tests |
| Restart, high-water time, uncertain commit and no automatic recovery action | 2 and 5: process barriers, old/new revisions, mixed expired/current rows |
| No live services, permissions, receipts, route wiring or image leakage | 4 and 5: fixed factory, no activation, surface/route/actual-image checks |
| Exact Git attribution, including temporary fixtures | 1 and global commit gates: pre/post verification, no history rewrite |

Execution recommendation: **subagent-driven**, with one implementer and an
independent reviewer per task, then a whole-branch review. Storage recovery and
identity retention are safety-sensitive, and explicit task interfaces make
independent review useful. Native execution is the lower-overhead alternative:
one implementer handles every task, followed by an independent whole-branch
review. Neither approach authorizes cloud deployment, GitHub App changes,
publication, pushing, or merging this work.

Next action: the user reviews this written plan and selects an execution
method. Until then, do not create product code, install new dependencies,
initialize stores, or run this plan's migration/image workload.
