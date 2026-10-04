# Protected Source Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain and recover exact prepared source bytes with their original durable job for server-owned handoff.

**Architecture:** A separate protected directory holds immutable canonical source bundles. The existing job service prepares and binds those bytes to its committed plan, then revalidates source, job state, and time on every read.

**Tech Stack:** TypeScript, Node 22, existing SQLite job store, POSIX filesystem; no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-04-protected-source-handoff-design.md`

## Global Constraints

- `RUNNER_CAPABILITY_PROVIDER_AVAILABLE = false`; no activation, transport, publication, or professional assets.
- Source limit 8 MiB; observed inventory limit 100 directories / 64 MiB, including abandoned stages.
- Separate pre-existing 0700 directory, 0700 entries, 0600 source files; no automatic repair/pruning.
- Existing metadata-only callers remain compatible; no source in SQLite or runner storage dependency.
- Exact required author and committer identity before commit and push; never amend existing history.

## Review Focus

- A stopped writer leaves a partial stage: reads must never mistake it for a complete job.
- Two writers prepare the same job: only the durable winning plan and byte-identical bundle may escape.
- Checkout disappears after preparation: reopening must read original source without recreating a job.
- Time/state changes during filesystem work: revalidate before returning, without renewing expiry.
- Directory replacement or relaxed permissions after open: every operation must refuse unsafe custody.

### Task 1: Protected source storage

**Files:** Create `packages/db/src/runner-job-source-store.ts`, `packages/db/test/runner-job-source-store.test.ts`; modify `packages/db/src/runner-job-store-internal.ts`.

**Interfaces:**
- Consumes existing `StorePolicy` and protected path validation.
- Produces `JobSourceStore { put(jobId: string, bytes: Uint8Array): void; read(jobId: string): Buffer; close(): void }`, `openJobSourceStore(directory, storeId, policy)`, and a source-only temporary-root test factory. Exports only normal opener/types/size limit internally.

- [x] Write real filesystem tests for immutable byte publication/read/reopen, duplicate writers, wrong ID/path/permissions/links, bounds, missing/incomplete stages, closed handles, and child-process restart.
- [x] Run `node --import tsx --test packages/db/test/runner-job-source-store.test.ts`; expected RED: missing storage behavior.
- [x] Implement private staging + non-replacing complete-directory publication, pinned protected paths, bounded inventory and fixed error mapping.
- [x] Run focused tests and package build; expected exit 0, no failed tests.

### Task 2: Job service handoff integration

**Files:** Modify `packages/app/src/runner-job-producer.ts`, `runner-job-record.ts`, `runner-job-record-internal.ts`; create `runner-job-handoff.ts`, `packages/app/test/runner-job-handoff.test.ts` and a child-process fixture as needed.

**Interfaces:**
- Consumes Task 1 `JobSourceStore`, existing canonical source parser, committed job records, and clock checks.
- Produces `RunnerJobHandoff { job: Readonly<JobRecord>; sourceBundle: Buffer }`, optional `handoffDirectory` config, `prepareHandoff(input)` and `readHandoff(jobKey)` session operations.

- [x] Write tests proving committed-job/source byte identity; source-free reopen in another process; exact retry after job-only interruption; changed intent rejection; oversized rejection before insert; wrong/corrupt/missing source refusal; revision/expiry/rollback refusal; late I/O clock change; detached output; optional configuration and closed-session behavior; DB-directory equal/ancestor/descendant/alias overlap refusal.
- [x] Run `node --import tsx --test packages/app/test/runner-job-handoff.test.ts`; expected RED: handoff operations unavailable.
- [x] Refactor the internal producer to preserve its one generated bundle; existing `prepare` discards bytes as before. Wire source storage only when explicitly configured; include the configured DB directory in its protected path exclusions. Commit before put, validate fully and re-read current job/time after put/read. Keep test-only injection source-internal.
- [x] Run all job/store tests, build, and full `API_MIGRATOR_DOCKER_TEST=1 npm run ci` with a disposable database under Node 22; expected exit 0, zero failures/skips.
- [ ] Get fresh whole-branch review, fix important findings with RED/GREEN tests, retain verified results, commit with identity verification, push a topic branch and open a PR. Leave merging and live deployment separate.

## Verification record

- Storage RED: 17 tests failed on missing behavior; GREEN: 18/18 including simultaneous processes and writer death.
- Service RED: 15 tests failed on unavailable handoff operations; GREEN: 21/21 including the real runner input loader.
- Full local CI under Node 22.23.2 with Docker enabled: 1,230 tests passed, zero failures, cancellations or skips; all builds/typechecks and console packaging passed.
- The first full run caught the old internal export allowlist. It now explicitly lists the two new normal storage exports and rejects the additional private implementation/test paths; all six package-surface tests pass.
- Fresh Docker image build and configuration verification passed. Image integration and independent review are recorded in the PR when complete.
- These results establish local input custody and compatibility, not deployed execution or signing authority.
