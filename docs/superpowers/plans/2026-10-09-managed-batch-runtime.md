# Managed Batch Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a bounded public-source engine smoke with managed VM ownership and separately verified teardown.

**Architecture:** A strict renderer produces one Batch job from pinned source/runtime/image and private-project inputs. Reuse the engine worker while keeping repository execution unprivileged and blocking metadata HTTP. A read-only classifier joins matching job, result marker, and complete resource observations without enabling production publication.

**Tech Stack:** Node 22.23.2, node:test, Bash, Google Cloud Batch/Compute/Logging.

**Spec:** `docs/superpowers/specs/2026-10-09-managed-batch-runtime.md`

## Global Constraints

- Personal project `project-32bf49a2-bd30-4956-850`; `us-central1-a` only.
- One e2-medium, one 30 GB pd-standard boot disk, one task, zero retries, 1,800-second task ceiling.
- No customer code, credentials, public ingress, default-network changes, or publication activation.
- New cloud grants require exact action-time confirmation; trial-credit use is already authorized.
- Use existing isolated checkout; preserve PR #35 separately. Exact Abhishek author and committer gate before commits/pushes.

## Review Focus

- Stale queued job starts after deadline: refuse before guest mutation.
- Unexpected API/renderer fields inject alternate resources: reject unknown inputs and build a fixed body.
- Logs claim success for another run/revision: classifier rejects mismatches and duplicate result markers.
- Terminal job has surviving disk or incomplete inventory: never call teardown verified.
- Non-root worker reaches metadata credentials: deny HTTP before worker launch and test ordering/behavior.

### Task 1: Strict managed job and bootstrap

**Files:** create `ops/gcp-trial/batch.mjs`, `ops/gcp-trial/prepare-batch.mjs`, `ops/gcp-trial/test/batch.test.mjs`; update `package.json` and `ops/gcp-trial/README.md`.

**Interfaces:** `prepareBatch(input, {nowMs})` consumes projectId, runId, sourceRevision, sourceArchiveSha256, bootImage, network, subnetwork, deleteAt; produces `{jobId, job, scriptSha256, source, runId, deleteAt, activationBlocked:true}`. CLI accepts one JSON file and emits the preparation object only; it does not submit jobs.

- [ ] Write table-driven rejection and fixed API payload tests; execute Node tests and observe missing-feature failure.
- [ ] Implement strict renderer and fixed guest bootstrap with pinned downloads, absolute deadline, unprivileged worker, and metadata HTTP block.
- [ ] Execute generated bootstrap under a controlled command fixture for stale time, failed metadata rules, non-root launch, and result logging; no source-text assertions.
- [ ] Run all GCP tests, then full CI; expect zero failures.

### Task 2: Evidence classification and operational handoff

**Files:** create `ops/gcp-trial/batch-result.mjs`, `ops/gcp-trial/test/batch-result.test.mjs`; update README/release gates.

**Interfaces:** `classifyBatchResult({prepared, accepted, job, logs, inventory})` consumes the retained create response, matching fetched job/UID, complete retained task-log records, and full personal-project instances/disks/managed-groups observation after terminal time. Returns separate smoke/cleanup states and `activationBlocked:true`; malformed evidence throws, missing evidence stays unverified.

- [ ] Write failing tests for matching success, failed/timeout job, wrong UID/run/source, duplicate markers, stale/truncated inventory, and survivors.
- [ ] Implement the classifier and run tests; expect explicit unverified/failure for every incomplete path.
- [ ] Fresh independent whole-change review; fix important findings with regression tests, run full CI and dependency audit.
- [ ] Verify identities, commit and push a separate branch/PR; leave merging to explicit authorization.
- [ ] At action time request the exact Batch service-agent/worker grants and isolated network setup together. If confirmed, run bounded public-source smoke and timeout checks; verify retained logs and resource absence. Otherwise report the precise security boundary without claiming a deployment.

## Execution decisions

The user explicitly requested continuous execution and delegated implementation choices, so routine plan-approval and execution-method prompts are omitted. New security authority remains a hard boundary. This plan intentionally does not treat Batch task timeout as a total job-age or cost cap.
