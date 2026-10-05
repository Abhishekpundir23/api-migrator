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

- [ ] Write failing tests for strict input validation, absolute lifetime, explicit network behavior, immutable bindings, command scope, evidence query bounds, and CLI behavior with no cloud tooling.
- [ ] Implement `renderTrialPlan(input, {nowMs})` and `renderEvidenceRead(input)` in `ops/gcp-trial/plan.mjs`; return canonical, digest-bound non-authorizing proposals.
- [ ] Add `render-plan.mjs` with only `--input FILE`, bounded regular JSON input, and canonical stdout. Refuse every execution/unknown flag.
- [ ] Add test script to `test:ops`, document unmet runtime/cost gates, run focused tests and full Docker-enabled CI.
- [ ] Obtain independent review, verify identity, and open an unmerged PR.

## Execution record

- PR #25 merged at bdfadcde844faedacc4afb60ea577677e37ed3e4 after 22 green hosted checks and fresh 1,251/1,251 local tests. First install-failure job stopped on DNS TTL floor; exact-head retry passed without changing policy.
- Existing linked worktree reused on `feat/gcp-trial-planner`; no new worktree or cloud resource needed.
- User's autonomous-continuation instruction applies to preparation, not payment or production activation.
