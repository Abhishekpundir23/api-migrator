# GCP trial runtime implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline, with one independent final review.

**Goal:** Build a verified bootstrap artifact and offline cleanup decisions.

**Architecture:** Bootstrap generator binds script bytes to the existing plan. A pure JSON-input controller validates ownership and inventories without cloud execution.

**Tech Stack:** Node 22.23.2, Bash, node:test, local Docker.

**Spec:** `docs/superpowers/specs/2026-10-05-gcp-trial-runtime-design.md`.

## Global constraints

- Personal `project-32bf49a2-bd30-4956-850`, `us-central1-a` only.
- No GCP authentication, provisioning, billing changes or live deletion.
- Node 22.23.2; unprivileged engine smoke only; fixed expiry and one-shot guard.
- Production/signing/publication remain disabled; local fixtures are not cloud evidence.
- Exact author/committer: Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>.
- Base is PR #26 head 291e4f5; use a stacked branch while that PR is unmerged.

## Review focus

- Mutable or partially validated plan values must not change script/ownership scope.
- Root setup must not run repository code or inherit credentials.
- Reboot and process failure must not extend time or mint passing evidence.
- Pagination errors/reused names must not become cleanup success or deletion authority.
- Missing smoke evidence must not delay a cleanup decision.

## Task 1: Bootstrap artifact

Files: `ops/gcp-trial/bootstrap.mjs`, `prepare-trial.mjs`, `input-file.mjs`,
`render-plan.mjs`, `test/bootstrap.test.mjs`, package scripts and README.

Interface: `prepareTrial(requestWithoutStartupHash, {nowMs}) -> {plan, script}`.

- [x] Write tests proving exact script hash in the final plan, immutable scope, CLI refusal and Bash behavior; run RED against unimplemented entry points.
- [x] Implement deterministic root setup plus bounded unprivileged phases, persistent one-shot guard and terminal result marker. Share bounded JSON file reading with the existing CLI.
- [x] Run focused tests GREEN; exercise real Bash in disposable local Docker for refusal/one-shot/checksum/privilege behavior without cloud access.
- [x] Verify the effective author and committer with the identity gate before the implementation commit.

## Task 2: Cleanup decisions

Files: `ops/gcp-trial/cleanup.mjs`, `test/cleanup.test.mjs`, existing plan and README.

Interfaces: `captureOwnership(planJson, observationJson, {nowMs}) -> record`;
`decideCleanup(planJson, recordJson, inventoryJson, {nowMs, reason}) -> decision`.

- [x] Write failing tests using complete GCP-shaped operation/resources and paginated responses, exact deadline and early terminal outcomes, mismatches, missing disks, replacements and incomplete/error reads.
- [x] Implement canonical plan reconstruction, strict ownership capture and bounded inventory chains; return wait/blocked/absence decisions with no delete execution.
- [x] Clarify planner limitations and remove name-filtered inventory from proposed cleanup proof. Preserve blocked authority fields.
- [x] Run focused and full Docker-enabled CI GREEN, get independent review, and TDD-fix confirmed findings.

Delivery: commit and push a new unmerged stacked PR against `feat/gcp-trial-planner`; preserve both merge gates.

## Decisions

- Autonomous preparation honors the user's existing no-routine-question instruction; this does not authorize spending or cloud mutation.
- Prefer guest bootstrap over browser SSH because execution and evidence must not depend on an interactive session. Prefer offline cleanup decisions over a premature live adapter because atomic ID-scoped deletion is not established by the current API documentation.

## Validation record

- Bootstrap: 12 initial tests failed against unimplemented entry points, then passed. Real root-to-worker fixture caught restrictive extracted-runtime permissions; a regression caught request resnapshot substitution. Both fixed RED→GREEN.
- Cleanup: 41 initial tests failed, then passed. Added list-shape/kind/scope and unfiltered-inventory regressions and verified RED→GREEN; pagination loops are rejected.
- Independent review: one Important finding, unrestricted install pulling oversized console dependencies. Unrelated-workspace fixture failed first; engine-plus-root scoped installation fixed it. No Critical findings or deferred minors.
- Real Linux amd64 engine run caught the deliberate oversized-lockfile test hitting the original 32 MiB file limit, then exposed ignored trailing test-concurrency options. Sparse-file regression verified the 64 MiB limit; explicit `node --import tsx --test --test-concurrency=1` precedes file paths. No resource limit was removed.
- Final focused suite: 94/94 passed, no skips, on Node 22.23.2 with Docker enabled.
- Final full verification: `API_MIGRATOR_DOCKER_TEST=1 npm run ci` on Node 22.23.2 exited zero after the final fixes: 1,345 tests passed, zero failures and zero skips, including package builds, type checks, production console build and packaging checks.
- Real worker against main `bdfadcde844faedacc4afb60ea577677e37ed3e4`: 137 passed, zero failures, one intentionally skipped nested-Docker test. Engine source and lockfile match this branch. Public archive SHA-256: `e23bf9d125b04265b3417802bb7ed68f79cbcc2721b19e3077d5d25e31d05b9d`. Test container absence verified afterward. This is local Linux evidence only.
- Reviewer-excluded live GCP compatibility, authenticated custody, watchdog, attestation and production readiness remain unverified and explicitly blocked. Real dependency execution was separately checked locally as above. No cloud resource or paid action was executed.
