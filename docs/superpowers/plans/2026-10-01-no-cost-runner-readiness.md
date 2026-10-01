# No-cost runner readiness implementation plan

> **For agentic workers:** Use test-first independent tasks and one fresh whole-change review. User explicitly authorized continuous execution without routine design/plan signoffs.

**Goal:** Close demonstrated lifetime/teardown gaps and establish a truthful free-tooling readiness record.
**Architecture:** Keep existing four-phase image, job/evidence and console boundaries. Add checks at their immediate use sites; only the sealed cleanup boundary can remove final containment. No new trust provider, authority path or live activation.
**Tech stack:** Node 22.23.2, TypeScript, node:test, Bash, existing systemd/Envoy/nftables contracts.
**Spec:** docs/superpowers/specs/2026-10-01-no-cost-runner-readiness-design.md

## Global constraints

- Work only in API Migrator; no Mindrift access, Claude API or paid services.
- Preserve main/user work; use a topic branch, exact required Git identity, non-force pushes.
- No host security/network mutation or production deployment.
- Existing activation gates, DNS floor and authorization semantics remain fail-closed.

## Review focus

- Callback never starts after close, shortened cap, rollback or either clock expiry.
- Gateway lifetime accounts for slow startup and is always below plan and DNS expiry.
- Failed/unknown idle, process or workspace observations retain policy.
- Cleanup failure/cancellation cannot report successful teardown or remove policy early.
- Local/hosted fixture metadata cannot supply publication authority.

### Task 1: Evidence callback deadline

Files: packages/app/src/runner-evidence-deadline.ts; packages/app/test/runner-evidence-deadline.test.ts.
Interface: existing createRunnerEvidenceDeadline and run/cap/close.
- [x] Add deterministic pre-callback close/cap/wall/monotonic/rollback regressions; observe callback-count assertions fail.
- [x] Add immediate check inside queued callback, preserve late disposal.
- [x] Run deadline and acquisition/job regression suites; record counts.

### Task 2: Hosted gateway deadline

Files: ops/publication-runner/deployment/run-hosted-smoke.mjs; deployment/test focused lifetime tests and fixture-container.test.mjs; deployment README.
Interface: canonical rendered contract expiry -> strictly bounded RuntimeMaxSec; existing gatewaySystemdArguments/startGateway.
- [x] Add failing elapsed/expired/invalid window and command-argument regressions.
- [x] Derive current startup budget from earliest expiry, reject exhausted input, require systemd bound.
- [x] Run DNS admission, gateway and deployment tests; preserve thresholds/cadence and cleanups.

### Task 3: Fail-closed cleanup ownership

Files: ops/publication-runner/run-credential-free-preview.sh; deployment/cleanup-runner.sh and focused harmless behavioral shell tests, minimal shared helper if needed; deployment runtime closure/tests if helper is added.
Interface: wrapper owns process/workspace teardown; sealed ExecStopPost owns policy removal after complete idle proof.
- [x] Reproduce probe-error-as-idle and premature-removal behaviors with harmless injected commands.
- [x] Retain containment on errors/unknown observations and remove wrapper's premature deletion paths.
- [x] Verify cancellation/error ordering, exact tables only, root-sealed closure and activation refusal; run shell syntax and deployment suite.

### Task 4: Integration readiness and release verification

Files: docs/plans/2026-10-01-no-cost-runner-readiness-verification.md; narrowly update outdated status notes if necessary.
- [x] Run supported Node 22 npm run ci; report local Docker integration separately if unavailable.
- [x] Fresh reviewer checks spec, diff and above failure modes; fix actual findings with regression tests.
- [ ] Verify commit identity, create draft PR, attach it, require exact-head hosted checks and review before ready/merge.
- [ ] Verify remote/local merged SHA, clean worktree and new post-merge CI. Record DNS refusal without bypass.
- [ ] Record satisfied checklist and specific external production gates/resources, with free alternatives; do not promise perfection.

## Execution record

Task 1 completed in a517b539: six meaningful failing regressions, then deadline/acquisition 181/181 and evidence/job/store 401/401. Task 3 completed in 3867b9ee: probe-error and premature-removal regressions failed before the changes; cleanup plus observation 44/44, shell syntax and complete deployment suite green. Task 2 completed in 6c3590a1: 11 initial failures and two forward-clock-step failures, then focused 89/89 and deployment 287/287. Final combined Node 22 CI passed 1090/1090, zero failures/skips/cancellations. The separate Docker image build/configuration/four-phase integration passed.

Ruling: Minimal existing observation-event parser changes are required because the wrapper now reports retained containment and local cleanup, while the independent snapshot proves final removal. No helper or runtime-closure expansion was needed. Cost if wrong: the native integration will refuse old event streams; unsigned/activation-blocked behavior remains in place.

Ruling: Native independently operated Linux/rootless-Podman proof and production publication remain external acceptance gates. Local functional fixtures cannot manufacture that authority. Cost if wrong: activation remains unavailable until real evidence and integration exist.

Final: fixed successful-execution/final-stop observation mismatch — four
regressions RED, then cleanup/observation 48/48 GREEN; combined Node 22 CI 1,094/1,094 GREEN, no failures/skips/cancellations.
Correction commit: f255c83cc1372b5a8bfd9a956c2d03a65d9bf128.

Ruling: The observation remains a data contract with separate retained execution
and completed-stop records. The existing one-point live collector is refused
because it cannot produce both stages; its unused native helpers were removed.
The observer template remains blocked until a trusted independent producer and
native drill exist. Cost if wrong: activation stays unavailable; no publication
or signing gate is opened by fixture data.

Ruling: The first hosted revision exposed Ubuntu's unsupported transient
JobTimeoutSec setter. Use supported JobRunningTimeoutSec plus an independent
native pre-start wall/monotonic admission guard; the running-job timeout alone
cannot bound queued admission. Three regressions RED, focused suite 25/25
GREEN; final combined Node 22 CI 1,096/1,096 GREEN, new exact-head hosted checks pending. Cost if wrong:
native startup refuses and release stays blocked rather than extending expiry.

Final: fixed independent pre-start completion reserve — late admission
regression RED, guard includes the additional five seconds, focused 25/25
GREEN and full CI 1,096/1,096 GREEN. Native compatibility requires new hosted
checks; no failed revision is accepted or bypassed.
