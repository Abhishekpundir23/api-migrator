# Docker fixture cleanup implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this bounded fix.

**Goal:** A standalone image test must clean up its exact containers before deleting bind sources or reporting success.

**Architecture:** Create a retained container, validate its immutable ID and per-attempt ownership label, then attach/start it. Bounded cleanup removes only that validated ID. Unknown create completion or failed cleanup retains the workspace and fails closed. The native joined fixture keeps its separate lifecycle.

**Tech Stack:** Node.js 22, Docker CLI, node:test.

**Spec:** The architecture and constraints in this document are the bounded bugfix specification.

## Global constraints

- Production activation and external publication remain disabled.
- No paid cloud resources or professional repositories.
- Both Git identities must be Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>.
- Cleanup uses a full container ID, never a mutable name or blanket prune.
- A failed create followed by an empty inventory is not confirmed cleanup.

## Review focus

Timeouts, output overflow, name collisions/rebinding, unavailable daemon, and ambiguous create outcomes must fail safely without deleting unrelated resources or losing original errors.

## Task 1: Scoped Docker lifecycle and workspace teardown

- [x] Add failing executor tests for success, timeout/nonzero/overflow, duplicate identity options, wrong ownership, ambiguous create, removal failure, and workspace retention.
- [x] Implement `createDockerFixtureExecutor({command})` with `execute(request)` and `assertCleanupComplete()` in `image/docker-fixture-executor.mjs`; use a new random attempt label, exact name/job/image/user validation, bounded SIGKILL CLI calls, and ID-based removal/absence verification.
- [x] Wire standalone integration through the executor and use the inspected image ID. Success output follows workspace cleanup. Do not change native cancellation behavior.
- [x] Run image tests, full `npm run ci`, and an actual image build/configuration/four-phase check if local Docker is available.
- [ ] Obtain independent diff review; fix important findings with regressions. Verify identity before commit/push and create an unmerged PR.

## Execution record

- Baseline: clean linked checkout at 2656e3c; working branch `fix/docker-fixture-timeout-cleanup`; package builds and 7 image tests passed.
- Design audit confirmed that client termination cannot prove daemon cleanup. An ambiguous create retains its workspace even if the first inventory is empty.
- User previously requested autonomous continuation; implementation proceeds without another routine approval prompt.
- Regressions: 19 assertions failed against the old run-only behavior and passed after implementation. Added two explicit real-daemon regressions to CI (timeout and nonzero exit); both passed against the newly built image.
- First live regression invocation used a previous image that was no longer available after rebuilding; creation failed closed without leaving containers. Retried using the newly inspected image ID.
- Actual image build, configuration checks, and prepare/install/migrate/verify passed using `sha256:065dc1dfd910aa47ee8268674d03ea4541a537bed08b99b4495a547b8dfe46c0`; result reported `cleanup: complete`, `securityDrill: false`. Post-run fixture inventory was empty.
- Independent whole-patch review found no Critical, Important, or Minor defects. Fresh full-suite and real-image results are verified by the executing agent. Host crashes, external orchestrator termination, hostile daemons, and production readiness remain outside this fixture guarantee and are not claimed.
- Final local validation: Node 22.23.2, `API_MIGRATOR_DOCKER_TEST=1 npm run ci`, exit 0; 1,251 passed, 0 failed, 0 skipped, 0 cancelled. Separate real-Docker cleanup tests: 2/2 passed. Runtime containers were Linux arm64 on Docker Desktop, not a GCP production-host drill.
