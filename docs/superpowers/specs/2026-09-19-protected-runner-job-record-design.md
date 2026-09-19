# Protected runner job records: local-first design

Status: written specification approved in chat on 2026-09-19; local implementation
was subsequently authorized and executed. The [verification record](../../plans/2026-09-19-runner-job-record-verification.md)
records actual validation results and completed task, whole-branch and scoped fix
reviews. The non-blocking NFT diagnostic remains deferred. No service activation
is authorized.

Baseline: merged PR #18, `36bab9c85cd6c95bd0ac27ded0da0d3e44faa293`.
Predecessor: [protected runner evidence design](2026-09-09-protected-runner-evidence-design.md).

## 1. Outcome and scope

Preserve what a migration job was supposed to do before execution, then attach
its separately reviewed output and first verified evidence identity without
replacing the original expectation. A process restart must not create a new
job, forget the retained identity, or renew an expired job.

This is the next software-only step toward one supervised Inngest v3-to-v4
migration on an explicitly selected personal sandbox. It does not complete
that pilot. The deliverable is an internal producer and local durable store,
tested with disposable repositories and evidence fixtures; it remains unwired
from the console and any live runner.

Keep these boundaries unchanged:

- `RUNNER_CAPABILITY_PROVIDER_AVAILABLE = false`; `prepare_owner_challenge`,
  `prepare_publish`, and `publish` remain unconditionally blocked server-side.
- No cloud provisioning, spending, scheduler, source upload, migration
  execution, external signer, GitHub write-token request, owner approval
  consumption, PR publication, or merge.
- No GitHub App scope changes. Dynamo, Toloka, professional, and client assets
  remain excluded. No real sandbox is selected by this document.
- No new route, UI, environment activation switch, public CLI, or attested
  receipt format. Local preview reports and hosted smoke artifacts remain
  non-authorizing; reserved `preview-v3` stays rejected.
- Do not modify the runner image, owner replay ledger, or ordinary campaign
  database to make them serve as the new protected store.

## 2. Selected approach and its limits

Use a separate SQLite file through the existing `better-sqlite3` dependency.
It provides a concrete persistence target for duplicate-request, concurrent
writer, process-crash, and reopen tests without choosing a cloud provider.

An in-memory adapter alone would not establish restart recovery. Reusing
`migrationRuns.reportJson` would leave trusted expectations mixed with ordinary
reports. A hosted database would require deployment, account, budget, and
authentication decisions outside this slice.

Here, **protected** means a restricted local path, strict record validation,
and an internal API that cannot replace established fields. The assumed
boundary is an uncompromised control-plane process and OS account. No untrusted
migration code runs under that account during these tests. A live deployment
would require an OS-principal boundary separating this producer from untrusted
console/runner processes; path permissions alone cannot supply that separation.

Canonical SHA-256 record digests detect inconsistent bytes; they are not MACs
or signatures. Someone who can rewrite the database can recompute them. This
design does not resist a malicious process using the same OS identity, root,
or restoration of a coherent older disk snapshot. It adds neither an integrity
key nor a production key ceremony. Those limits are blockers to treating this
local store as a deployed trust boundary, not gaps to bypass with a flag.

## 3. Components and package boundaries

| Component | Responsibility | Does not do |
| --- | --- | --- |
| Expected-job producer | Validate canonical source, create the plan, assemble immutable job expectations | Derive expectations from downloaded runner evidence |
| Job-record service | Enforce transitions, retries, expiry, and evidence identity retention | Claim that stored metadata is execution or publication authority |
| SQLite adapter | Restrict storage location, transact bounded records, detect conflicts and corruption | Interpret attestations, approve migrations, or access GitHub |
| Existing evidence client | Fetch and genuinely verify evidence against the stored context | Create expected context, extend expiry, or persist capabilities |

Expose the new app API only through
`@api-migrator/app/runner-job-record-internal`, with storage plumbing through
`@api-migrator/db/runner-job-store-internal`. Keep validators and orchestration
in the app package; the database adapter accepts bounded canonical bytes and
transaction conditions, without importing the app package.

Do not re-export either module through package roots, `console-internal`,
browser-safe preview exports, or `runner-internal`. Importing a module must not
open a database, initialize a directory, fetch evidence, or read credentials.
The assembled credential-free runner must not acquire SQLite or these modules
through its runtime dependency closure.

Reuse `createSourceBundle`, `parseSourceBundle`,
`createPublicationRunnerPlan`, existing canonical JSON and source validators,
`validateRunnerEvidenceContext`, and the existing evidence client. Do not add
a parallel source, plan, signature, or retained-identity format.

## 4. Records and lifecycle

Each schema-version-1 record has a store ID, `campaignId`, `runId`, `jobId`,
revision, preparation-intent digest, source identity, canonical plan record,
and optional review/evidence sections. Its record digest covers the complete
canonical record except the digest field itself. Index columns must equal the
corresponding canonical fields. Unknown fields and schema versions fail closed.

The source identity is the existing `PreviewSourceIdentity`, including the
base tree SHA. The plan is the existing `PublicationRunnerPlanRecord` with
its original canonical JSON, digest, creation time, and expiry.

| State | Revision | Required content | Permitted next addition |
| --- | --- | --- | --- |
| `prepared` | 1 | Immutable source, plan, and preparation intent | Reviewed output and original completion time |
| `reviewed` | 2 | Prepared content plus complete `RunnerEvidenceContext` | First genuinely verified retained identity |
| `evidence_retained` | 3 | Reviewed content plus `RetainedRunnerEvidenceIdentity` | None; evidence may only be reacquired and compared |

Expiry is derived from the original timestamps, not a resettable lifecycle
state. Expired records remain inspectable as metadata but cannot advance or
acquire evidence. There is no generic field-update, delete, job-reopen,
retry-as-new, or renew API.
Starting another job requires an explicit new run ID from future orchestration.

Do not store source archives, patch contents, credentials, signing keys, raw
attestation envelopes, or serialized `VerifiedPublicationRunnerAttestation`
objects. Store only the identity metadata needed to establish expectations and
compare evidence. A record read returns detached metadata, never a capability.

### Prepare before execution

The internal producer receives trusted server-owned pilot/campaign/run IDs,
repository slug/ID/owner ID, approved base branch/commit/tree, canonical
manifest, pinned image digest, validated install-egress destinations, and an
absolute requested expiry. Paths and identity policy are not browser inputs.

Preparation uses an existing clean checkout to build and parse the canonical
source bundle. Derive manifest and source-archive digests from those bytes;
verify all repository/base fields against the supplied expectation and verify
the tree against the bundle. The current plan binds the archive digest and
base commit, not an independently signed base-tree assertion.

Repository IDs supplied by a caller are not independently authenticated by
local Git. Tests use explicit fixture identities. Before live wiring, trusted
orchestration must independently resolve the selected personal repository and
enforce its owner/repository allowlist; copying a report or reading an origin
URL is not sufficient.

Compute the preparation-intent digest from all normalized inputs that affect
the plan and source, including campaign/run identity and requested expiry,
but excluding the plan generator's nonce and creation timestamp. Check for an
existing `(campaignId, runId)` before generating a plan. An exact retry returns
the stored current record and original plan; a changed intent is a conflict.
The intent's normalized identity fields must be recoverable from stored source,
plan, and campaign/run data so reads can recompute its digest. Filesystem paths
are neither persisted nor part of job identity.

For a new job, create the plan once and commit revision 1 before reporting
preparation success. If simultaneous callers generate plans, a transaction
selects one winner: the loser discards its generated plan and returns the
winner only when the preparation intent matches exactly. Enforce unique
campaign/run and job IDs. Never expose the loser's plan as a prepared job.

The original plan's 1-to-15-minute lifetime bounds remain unchanged. This
slice neither dispatches the job nor persists/transports its source bytes.

### Attach separately reviewed output

`recordReviewedOutput(jobKey, reviewedOutput, previewCompletedAt)` accepts
the existing `PublicationRunnerOutput`: preflight ID, artifact digest, and
candidate tree SHA. Here and below, `jobKey` includes campaign ID, run ID, and
job ID; all three must match the record. Construct `RunnerEvidenceContext`
using the stored source and plan; validate its complete bindings and timeline before committing
revision 2. Do not accept a caller-supplied replacement context or plan.

The output and original completion time come from a separate trusted review
path, not from the evidence response. This module validates their shape and
binding; it does not perform or prove that review. That review path is exercised
with fixtures here and remains a live-integration prerequisite.

An identical retry while current is idempotent, including after evidence
retention. Different output or completion time is a conflict. Never substitute the time of the
retry for the original completion time, even if the previous record expired.

### Acquire and retain evidence

`acquireEvidence(jobKey)` loads the stored reviewed context and delegates to
the existing evidence client. For revision 2 use `acquireInitial`; for revision
3 use `reacquire` with the exact stored retained identity. Do not expose an API
that imports an arbitrary identity, success object, or attestation envelope.

The normal internal factory constructs the real evidence client from explicit
server-only configuration. A source-internal test seam may substitute fixture
transport and clock behavior but must still exercise the genuine signature
verifier; it must not be reachable through package exports or runtime flags.
No real endpoint or registry is configured or contacted in this slice.

Do not hold a SQLite transaction during network I/O. Snapshot the job revision,
validate time, acquire evidence, then reread and compare-and-swap the record.
Only a genuine successful acquisition can append revision 3. Concurrent
initial acquisitions may converge on byte-identical retained identity; a
different envelope, payload, context, signer, trust digest, or expiry is a
conflict, not last-writer-wins. Recheck time before reporting success.

Return metadata indicating that identity was retained or freshly matched,
not the verified capability. Discard the in-process capability after this
operation. Reopening the store always requires fresh acquisition for a fresh
evidence result; it must never deserialize authority. Future publication
integration and its point-of-use verification require a separate design.

## 5. Storage, time, and recovery contract

Initialization is an explicit internal operation on a new, empty, dedicated
directory. Normal open requires an existing database, schema version, and
expected random store ID supplied by trusted configuration; it must not
silently create or repair a missing, corrupt, or mismatched store. The store ID
detects a different store, not restoration of an older copy of the same store.
No production directory or persistent user data is initialized during this
implementation slice. Tests use disposable directories only.

Open validates the expected tables, indexes, constraints, absence of unexpected
triggers, SQLite integrity, and every bounded canonical record. Keep structural
validation separate from current-time validation so an expired historical
record does not prevent opening the store for inspection.

Require an absolute canonical directory outside the application checkout and
all configured migration workspace roots. Validate path components, ownership,
and permissions before opening and before each operation. Reject symlinked
paths, non-regular database files, hardlinked database files, and unsafe
group/world access. Require mode 0700 for the dedicated directory and 0600 for
the database and any SQLite sidecars; validate file identity again after open.
Do not chmod or repair an existing unsafe path. A source-internal test-only
policy permits disposable temporary roots; it cannot bypass type, identity,
ownership, or mode checks, and cannot be selected by an environment variable.

Use local-disk SQLite rollback-journal mode (`DELETE`) and `synchronous=FULL`,
checking the effective settings. Use immediate write transactions and revision
compare-and-swap for lifecycle changes, with a 250 ms busy timeout and no
automatic retry loop. Follow the existing owner-store durability pattern where
applicable, but use a separate file/schema and no owner-authorization counters
or shared anchor. Before reporting success, synchronize the database and parent
directory, recheck open-file identity, and read back the committed canonical
record. Reject unexpected WAL/SHM files; validate any recovery journal's regular
file type, ownership, mode, and lack of links before allowing SQLite recovery.
Network filesystems are not a supported target.

Bound each canonical job record to 256 KiB and the store to 100 records for
this local slice, enforcing the count in the insertion transaction. These are
implementation limits, not pricing or production quotas. A full store rejects
new jobs; exact retries of current existing jobs still work. Bound record bytes
before parsing, and bound the database file to 64 MiB before opening and after
commits; configure SQLite's page-count ceiling to enforce that growth limit.
Do not introduce automatic pruning, vacuuming, or record replacement to recover
capacity.

Persist a store-level wall-clock high-water mark. Every active operation must
transactionally reject a clock earlier than that mark and advance the mark
before proceeding; after I/O, check and advance it again. Use the existing
monotonic acquisition deadline within each process. Audit-only inspection may
read expired metadata but cannot advance the lifecycle or claim fresh evidence.

Active operations enforce `now < plan.expiresAt`; after review also enforce
`now < previewCompletedAt + 10 minutes`; after retention additionally enforce
`now < retainedIdentity.expiresAt`. Existing DNS/egress, key-validity, revocation,
and evidence-client checks remain applicable. No caller override of current
time is exported from the normal factory. A backward clock fails closed; a
forward jump may expire a job and does not justify recreating it.

The high-water mark detects rollback relative to time this store observed,
assuming the store itself has not been rolled back. It cannot establish trusted
time while the process was stopped or detect a coherent backup restore.

After a process dies, reopening must expose either the complete previously
committed revision or the complete next revision, never a partially attached
review/identity. Missing/corrupt data causes a fixed failure, not fallback to
ordinary report JSON or a new empty store. Process-crash tests establish this
application recovery behavior, not immunity to hardware loss or snapshot rollback.

## 6. Failure behavior and verification requirements

Use the fixed store/service codes `input_invalid`, `job_missing`, `job_conflict`,
`job_expired`, `clock_rollback`, `store_unsafe`, `store_mismatch`, `store_corrupt`,
`store_full`, and `store_unavailable` (including busy storage). Preserve existing
evidence-client failure distinctions in a separate evidence-error result arm.
Never surface raw SQL, source paths, source contents, envelopes, credentials,
or key material in public-facing error text.

The implementation must demonstrate:

1. **Preparation binding:** clean canonical source succeeds; dirty source,
   wrong tree, repository/base mismatch, manifest mismatch, invalid image or
   egress inputs, unknown fields, and oversized records fail before job persistence.
2. **Immutable retries:** exact repeats preserve every original identity and
   timestamp; changed preparation, review, or retained identity is rejected.
   Two independent handles/processes cannot replace each other's winning job.
3. **Real persistence:** close/reopen a disk database at each revision; use
   child-process interruption before and after commit to verify atomic recovery,
   including interrupted initialization and evidence-retention races.
4. **Integrity and path checks:** reject inconsistent record digests/indexes,
   malformed/unknown schemas, oversized files, wrong store ID, missing stores,
   unsafe permissions, symlink/hardlink replacement, and unexpected sidecars.
   These tests must not be described as protection from a privileged DB writer.
5. **Time:** expiry boundaries, backward-clock detection, forward jumps, delayed
   I/O, and restart do not extend plan, review, or retained-evidence lifetime.
6. **Genuine evidence verification:** disposable signed fixtures pass; wrong
   output, changed envelope, revoked/replaced signer state, and serialized
   capability imitations fail. Restart reacquisition compares the original
   identity and rereads trust instead of using cached success.
7. **Isolation:** existing console gate tests still block all three actions;
   no owner authorization is consumed, no write token is requested, no source
   is executed, and no new store dependency leaks into the runner image.

Run focused store/app tests and the repository's full Node 22 validation and
actual runner-image checks during implementation. Record exact results then;
this design document does not claim those new tests exist or have passed.

## 7. Review and later milestones

Approval of this written specification permits an implementation plan. Code
work begins only after review of that plan and selection of its execution
method. No cloud, GitHub App, signing, or publication authority is implied.

After implementation, the next integration design still needs private job and
source transport, authenticated evidence access, protected deployed custody
and time/rollback policy, independently reviewed output production, and a
separate observer/signer. Select a personal provider/account, spending cap, and
eligible sandbox before provisioning. Complete the dedicated-host drill,
GitHub protection checks, owner-signing/replay/revocation ceremony, and one
supervised end-to-end migration before calling the product pilot-ready.
