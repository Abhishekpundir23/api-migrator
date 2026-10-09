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

### Task 3: Correct bounded fixture preparation and retain safe diagnostics

The corrected f7b6ce1 guest failed in image_smoke with exit 1 and zero worker-log bytes. Its redirected controller stderr was lost at verified VM teardown; the exact failing check is unobserved. Exact-source Debian x86_64 diagnosis then reproduced actual preparation failure under its inherited 8 MiB cap: npm @types/node metadata writes fail EFBIG. Preparation succeeds at 64 MiB. Correct only the public image_smoke controller's per-file cap to 64 MiB, alongside the newly established observability gap. Do not claim this is the exclusive guest cause or relax other checks.

- [x] Add RED tests for one failure-only fixed-enum record, last-entered checkpoints, actual child close code/signal, timeout/output/diagnostic limits and cleanup precedence. Inject messages, token-shaped secrets, HTTP bodies, newlines, arbitrary codes and aggregate/unknown errors; none may leak or invent a cause.
- [x] Add a RED generated-controller-wrapper regression with actual >8 MiB writes, then prove GREEN with finite 64 MiB refusal. Retain exact real fixture-preparation RED/control evidence on pinned x86_64 Node 22.23.2 and exact container absence, with all substituted test boundaries explicit.
- [x] Implement bounded typed failure stdout using the existing digest-bound worker-log path, and fixed safe CLI stderr. Add trusted empty-log/nonzero image_smoke fallback; never read controller.log.
- [x] Execute rendered-bootstrap failing-controller, abrupt empty-output and outer-timeout cases; reconstruct chunks, verify digest and failed classification. Success stays exactly the original one-summary line; mixed/malformed output and nonzero exits never pass.
- [x] Apart from the explicitly targeted image_smoke per-file cap, keep all caps, deadlines, public-build selectors, source/runtime pins, identity/isolation and cleanup rules unchanged. Run focused tests, full Docker-enabled CI and audit, retain evidence, verify exact Git identities and make a new commit without amend/push.
- [ ] Parent performs one scoped independent review and fresh-head verification. Any further cloud run remains supervised and uses a fresh nonce/deadline, with independent terminal/resource-absence evidence. No automatic merge.

### Task 4: Align public plan and phase lifetimes

The 25c104c guest failed at fixture_plan; exact downloaded receipts and independent resource absence are retained. Actual createFixturePlan reproduction rejects a fresh 1,140-second plan and the conservative 991.874-second elapsed case against the existing 900-second maximum. Its 600-second test fixture passes and hides this mismatch. Fix the caller only; preserve the shared 1–15-minute policy.

- [x] Add RED behavioral coverage through the actual plan builder and new-profile caller for the 1,200-second controller window, elapsed setup, exact upper/lower boundaries and insufficient time; prove rejection does not create plan/source output.
- [x] Cap requested expiry at min(controller deadline minus 60 seconds, now plus existing maximum TTL). Reuse the pure existing maximum constant. A small new-profile helper is allowed to make this exact caller path testable; do not change shared fixture/validator semantics.
- [x] Bound all new-profile phase operations by the earlier plan expiry while preserving the 60-second cleanup reserve. Test actual propagated timeout values and fail-closed expiry; success/failure protocols and synthetic-lifetime disclosure stay unchanged.
- [x] Exercise the corrected helper with the 1,200-second window in the real image fixture, then run focused tests, full Docker-enabled CI and audit. Retain evidence and limitations. Verify exact Git identities and make a new commit without amend/push/cloud actions.
- [ ] Parent performs one scoped independent review, verifies fresh remote checks and runs at most one supervised fresh-nonce trial after gates pass. Earlier failures remain preserved; no automatic merge.
