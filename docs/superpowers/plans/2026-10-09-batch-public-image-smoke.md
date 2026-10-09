# Batch Public Image Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the existing public four-phase runner image on a managed Debian Batch VM and classify its evidence separately from engine tests.

**Architecture:** A separate fixed profile reuses strict Batch resource validation and existing phase/owned-container helpers. Trusted root orchestration controls the Docker socket; fixture code runs as an isolated non-root UID with metadata denial. Operator classification binds the image result to immutable source, job and logs without granting production authority.

**Tech Stack:** Node 22.23.2, Bash, Docker, node:test, Google Cloud Batch/Logging/Compute.

**Spec:** `docs/superpowers/specs/2026-10-09-batch-public-image-smoke.md`

## Global Constraints

- Personal project `project-32bf49a2-bd30-4956-850`, zone `us-central1-a`.
- One `e2-medium`, 30 GB `pd-standard`, one task, zero retries, 1,800-second task maximum.
- Fixed profile `batch-public-image-phase-smoke-v1`; engine profile unchanged.
- No new IAM, billing upgrade, public ingress, customer/professional data, credentials or publication activation.
- Every commit's author and committer: `Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>`; load identity skill and verify before commit and push.
- Do not weaken Ubuntu joined-fixture or DNS guards; rootless/gateway/independent-attestation gaps remain explicit.

## Review Focus

- Root controller executes a tree still writable by a surviving build UID: quiesce and seal before launch.
- Container host UID differs from metadata firewall UID: verify actual runtime mapping and negative container probe.
- Build/phase timeout leaves a running owned container: audit cleanup, never infer death from client status.
- Engine log or substituted image JSON is classified as image success: strict profile, exact bounded report and digest binding.
- Guest success hides incomplete cloud teardown: preserve separate authenticated inventory outcome.

### Task 1: Bounded public-image Batch profile

**Files:** create `ops/gcp-trial/batch-image.mjs`, `batch-image-bootstrap.mjs`, `batch-image-summary.mjs`, `run-batch-image-smoke.mjs`, `prepare-batch-image.mjs`, and focused `ops/gcp-trial/test/batch-image*.test.mjs`; modify `batch-result.mjs`, `package.json`, README and release-gate documentation. Small internal extraction from `batch.mjs`/`batch-bootstrap.mjs` is allowed only to avoid duplication while preserving legacy output.

**Interfaces:**
- Consumes `prepareBatch(request, {nowMs})` strict eight-field request and existing public fixture APIs in `ops/publication-runner/image/fixture-phases.mjs`/`docker-fixture-executor.mjs`.
- Produces `prepareBatchImage(request, {nowMs})` with legacy prepared fields plus `profile`, fixed generated job script and matching script digest. CLI accepts only `--input REQUEST.json`, renders only.
- Produces `hasBatchImageSummary(output)` strict boolean validator shared by guest emitter and classifier; `renderBatchImageScript(input, source)` fixed script builder.
- `run-batch-image-smoke.mjs` accepts exact image ID and dedicated UID/GID plus absolute deadline; root-only Linux host orchestrator, no arbitrary commands. Emits one bounded canonical image summary only after four phases and owned cleanup pass.
- `classifyBatchResult` defaults absent prepared profile to legacy engine, accepts only the two known profiles and compares the trusted marker's profile exactly. Image success requires image summary, never TAP. Existing smoke/cleanup states remain backward compatible.

- [ ] Write tests first for render-only resource/input parity and profile separation: broad extra fields reject; script changes bind SHA; default engine remains unchanged; missing image implementation fails.
- [ ] Implement fixed image renderer and shell bootstrap. Reuse pinned Node/archive/metadata helpers, inspect existing Docker, build as public trusted setup, seal source before root orchestration, leave workload without socket membership.
- [ ] Write failing controller/summary tests: all four phases ordered with exact digests; non-root/foreign runtime refuses; actual container metadata denial; cleanup failure rejects; engine TAP/duplicate JSON/invalid flags/missing output/wrong digests reject. Test emitted logs through the real classifier.
- [ ] Implement image orchestration and strict bounded result validation using existing helpers; synthetic DNS lifetime explicitly non-authorizing. Use a new CLI rather than altering standalone or joined fixture behavior.
- [ ] Execute generated bootstrap in controlled native fixture and real local image/container paths where supported. Cover stale deadline, failed provisioning/build, phase failure, timeout and cleanup. Do not replace these behavioral checks with source-text assertions.
- [ ] Run `PATH=/Users/abhi/.npm/_npx/5dad66f2cb301fc2/node_modules/node/bin:$PATH API_MIGRATOR_DOCKER_TEST=1 npm run ci` and `npm run audit:dependencies`; expect zero failures/skips and no high vulnerabilities. Record exact output/totals.
- [ ] Update operator README with new command, meaning of evidence, supervised deadline/cleanup and remaining gates. Verify identities, commit changes on this feature branch without push. Parent performs independent review, PR and supervised cloud run.

## Execution decisions

Routine design/execution prompts are omitted under the user's repeated explicit delegation. Use a subagent implementation and independent review while the parent checks cloud readiness; no parallel writers and no new security authority.

### Task 2: Correct the reproduced public-build file-limit failure

The first supervised trial at `4207c3b` failed in `public_build` with exit 153; resource cleanup was independently verified. Exact-source Debian x86_64 reproduction established SIGXFSZ: 8 MiB truncates TypeScript, and full installation still fails at 64 MiB on unused Next SWC. Four required workspaces plus root tools pass installation and all builds under 64 MiB.

Scope: change only the public build worker's file cap from 8192 to 65536 and explicit engine/db/app/runner workspace selectors with `--include-workspace-root`. Keep `--ignore-scripts`, pinned source/runtime, 600-second budget, process limits, all other file/output caps, metadata policies, Docker handling, DNS guards and activation gates unchanged. This is a newly discovered live-host acceptance defect, separate from the closed Linux test-prerequisite finding.

- [x] Add a RED behavioral regression executing the generated worker with a real file larger than 8 MiB; assert the exact scoped npm argv and finite file limit. Clearly label any substituted package commands.
- [x] Apply the narrow correction and prove the regression GREEN.
- [x] Execute the corrected rendered worker against the exact public source's real dependency graph on pinned Node 22.23.2 Debian x86_64, verify install/build success, and independently verify exact diagnostic-container absence. No source/archive/hash or lifecycle bypass.
- [x] Run focused tests, full Docker-enabled CI and dependency audit; retain output. Verify both Git identities and make a new commit (no amend/push).
- [ ] Parent performs one scoped independent review, pushes for fresh checks, and supervises a fresh-nonce live trial only after applicable gates clear. Existing failed attempts remain retained; no automatic PR merge.
