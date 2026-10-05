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

- [ ] Write tests proving exact script hash in the final plan, immutable scope, CLI refusal and Bash behavior; run RED against unimplemented entry points.
- [ ] Implement deterministic root setup plus bounded unprivileged phases, persistent one-shot guard and terminal result marker. Share bounded JSON file reading with the existing CLI.
- [ ] Run focused tests GREEN; exercise real Bash in disposable local Docker for refusal/one-shot/checksum/privilege behavior without cloud access.
- [ ] Verify and commit with the identity gate.

## Task 2: Cleanup decisions

Files: `ops/gcp-trial/cleanup.mjs`, `test/cleanup.test.mjs`, existing plan and README.

Interfaces: `captureOwnership(planJson, observationJson, {nowMs}) -> record`;
`decideCleanup(planJson, recordJson, inventoryJson, {nowMs, reason}) -> decision`.

- [ ] Write failing tests using complete GCP-shaped operation/resources and paginated responses, exact deadline and early terminal outcomes, mismatches, missing disks, replacements and incomplete/error reads.
- [ ] Implement canonical plan reconstruction, strict ownership capture and bounded inventory chains; return wait/blocked/absence decisions with no delete execution.
- [ ] Clarify planner limitations and remove name-filtered inventory from proposed cleanup proof. Preserve blocked authority fields.
- [ ] Run focused and full Docker-enabled CI GREEN, get independent review, TDD-fix confirmed findings, then commit/push a new unmerged stacked PR.

## Decisions

- Autonomous preparation honors the user's existing no-routine-question instruction; this does not authorize spending or cloud mutation.
- Prefer guest bootstrap over browser SSH because execution and evidence must not depend on an interactive session. Prefer offline cleanup decisions over a premature live adapter because atomic ID-scoped deletion is not established by the current API documentation.
