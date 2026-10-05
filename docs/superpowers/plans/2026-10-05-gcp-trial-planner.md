# GCP trial planner implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this bounded first slice.

**Goal:** Produce a validated, non-executing GCP trial plan without cloud changes.

**Architecture:** Pure command-array renderer plus bounded JSON CLI; permanent execution and production blocks.

**Tech Stack:** Node 22, node:test, existing canonical JSON helper.

**Spec:** `docs/superpowers/specs/2026-10-05-gcp-trial-planner-design.md`.

## Global constraints

- Personal project only; no cloud calls or cost authorization.
- Fixed `us-central1-a`, Node 22.23.2 Linux x64, one-hour maximum absolute deadline.
- No service account/scopes, restart, interactive serial, extra disks, or implicit egress.
- All production-authority fields remain false/blocked.
- Git author and committer: Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>.

## Review focus

Scope substitution, stale plans, shell arguments, logs for the wrong instance,
and mistaking a rendered proposal for approved or completed execution.

## Task 1: Planner and read-only CLI

- [x] Write failing tests for strict input validation, absolute lifetime, explicit network behavior, immutable bindings, command scope, evidence query bounds, and CLI behavior with no cloud tooling.
- [x] Implement `renderTrialPlan(input, {nowMs})` and `renderEvidenceRead(input)` in `ops/gcp-trial/plan.mjs`; return canonical, digest-bound non-authorizing proposals.
- [x] Add `render-plan.mjs` with only `--input FILE`, bounded regular JSON input, and canonical stdout. Refuse every execution/unknown flag.
- [x] Add test script to `test:ops`, document unmet runtime/cost gates, run focused tests and full Docker-enabled CI.
- [x] Obtain independent review and resolve confirmed findings.
- [ ] Verify final commit identity and open an unmerged PR (delivery step).

## Execution record

- PR #25 merged at bdfadcde844faedacc4afb60ea577677e37ed3e4 after 22 green hosted checks and fresh 1,251/1,251 local tests. First install-failure job stopped on DNS TTL floor; exact-head retry passed without changing policy.
- Existing linked worktree reused on `feat/gcp-trial-planner`; no new worktree or cloud resource needed.
- User's autonomous-continuation instruction applies to preparation, not payment or production activation.
- Initial TDD cycle: 29 tests failed against unimplemented entry points, then 29/29 passed. Initial Node 22.23.2 Docker-enabled CI passed 1,280/1,280 tests with zero failures or skips.
- Independent review identified an accessor-backed input substitution in both JavaScript renderers and incomplete originating-resource constraints in the log query. Six descriptor/snapshot regressions failed before the fix, then passed. The strengthened log-query assertion also failed before its fix. Final focused suite: 35/35 passing on Node 22.23.2.
- Renderers now reject accessor/non-enumerable fields and use only validated data snapshots. Evidence queries bind project, zone, numeric instance ID and fully qualified log name.
- Final `API_MIGRATOR_DOCKER_TEST=1 npm run ci` on Node 22.23.2 passed 1,286/1,286 tests with zero failures or skips, including package builds, workspace type checks, console build and packaging checks. `git diff --check` passed. No cloud resource or paid action was executed.
