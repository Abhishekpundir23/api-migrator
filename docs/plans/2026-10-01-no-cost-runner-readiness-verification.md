# No-cost runner readiness verification

Date: 2026-10-01. Baseline main: bdb1e8c542cab951f6dda9fcec4e9556cc68e99e.
Branch: codex/no-cost-runner-readiness. Status: local implementation and hosted compatibility correction verified; new exact-head hosted release checks pending.

## Authorized boundary

The user authorized sustained free local work and API Migrator commits, draft PRs and checked merges without routine approvals. No Mindrift repository, Claude API, paid tool, production deployment, credential or persistent system-security change is part of this work.

## Acceptance checklist

- [x] Inspect current source, Git state, available tooling and existing workflow integrations.
- [x] Establish supported Node 22.23.2 from the official distribution with SHA-256 verification; temporary installation only.
- [x] Reproduce and fix queued evidence-operation start after deadline closure/expiry/rollback.
- [x] Enforce independent canonical plan/DNS lifetime on every hosted gateway start.
- [x] Retain containment on failed/unknown production cleanup observations and remove premature wrapper policy deletion.
- [x] Verify local credential-free four-phase image integration.
- [x] Run combined Node 22 workspace CI, including real Docker verification, console build and packaging checks.
- [x] Complete independent whole-change review and fix demonstrated findings.
- [ ] Verify exact PR revision's hosted checks, then permitted merge and post-merge state.
- [x] Preserve and behavior-test the unconditional three-action console/publication gate.

## Current evidence

Task 1's six deterministic regressions all failed before the fix on actual callback count 1 instead of 0. After the queued callback's immediate budget check, deadline/acquisition suites passed 181/181 and evidence/job plus DB store regression suites passed 401/401, with zero failures, skips or cancellations. The first restricted sandbox run's only failure was inability to bind the existing disposable loopback TLS fixture; the authorized local-test escalation passed it. Logs: `/tmp/api-migrator-free-readiness/task1/`.

The gateway change reproduced 11 initial failures in 21 tests, then two forward-wall-step regressions. Canonical plan/DNS windows now bound every launch; 30 seconds cover client submission, queueing, activation and shutdown, so a fresh 65-second window yields 34 seconds of runtime and five seconds of setup yields 29. The startup command and readiness guards reject invalid/exhausted clocks and stale selected runtimes. Focused checks passed 89/89, complete deployment 287/287 and gateway 17/17. DNS floors, complete-answer minimum, resolver, retry cadence and 90-second acquisition budget are unchanged.

Cleanup regressions reproduced 15 failures in 21 behavioral tests and one old-event-contract failure. The wrapper retains policy during cancellation, failure and local teardown; sealed ExecStopPost requires successful process, workspace and complete parsed table observations before removing only exact job tables. Failed or malformed probes refuse removal. Local teardown/retained-policy events require the independent final table-absence snapshot; signing and activation remain blocked. The final cleanup/observation checks passed 44/44, and both shell syntax checks passed.

Before the review correction, supported Node 22 `npm run ci`, with `API_MIGRATOR_DOCKER_TEST=1`, passed 1090/1090 tests, zero failures/skips/cancellations, package builds/typechecks, pilot validation, console production build and packaging. The emitted production route regression confirms all three owner-challenge/publication actions remain unavailable. Logs are retained locally in `/tmp/api-migrator-free-readiness/`; hosted exact-head checks provide the shareable release evidence.

The local runner image build, configuration verifier and generated-fixture four-phase integration passed. Image reference digest: sha256:6f3be6183adfb202ed77483c0593c904244dfc758d60d79429fa3227cac31e13. This is functional Docker evidence, with securityDrill: false, not authoritative Linux isolation evidence. Logs: `/tmp/api-migrator-free-readiness/runner-image-{build,verify,integration}.log`.

The existing main revision's post-merge CI and joined fixture passed, but Linux smoke run 36224459793 failed cgroup_namespace_cleanup DNS admission: 18 attempts/90,005ms, required floor 65s, observed minimum TTL range 4–60s, final 12 records. Its earlier PR smoke run at the same code was green. No failure is bypassed or represented as fixed; later exact-head outcomes will be recorded separately.

## Cost review

API Migrator is public and the three workflows use standard Ubuntu GitHub-hosted runners; no Claude/API/deployment integration, paid larger runner or repository webhook was found. [GitHub documents standard public-repository runner use as free](https://docs.github.com/en/billing/concepts/product-billing/github-actions). Repository cache usage was 123,074,764 bytes; all 66 artifacts totalled 1,331,729 bytes at audit. Storage is bounded by existing workflows. This is a repository-level tooling audit, not a statement about unrelated account charges or an account-wide storage bill; no billing setting was changed.

## Production integration gates that remain

The current retained job/evidence records are metadata. Every publication boundary must reacquire the original identity through the genuine verifier, re-read current protected signer trust, preserve the exact source/plan/review/execution identity, and reject replacement/revocation/expiry before consuming owner approval or minting a write token. The existing token broker has no fresh runner acquisition input. Opening the console availability flag would not complete this integration.

Required external evidence and resources are not configured: a trusted dispatch/producer/reviewer service; rootless Podman UID/cgroup/resource/egress enforcement and fault/teardown observations on disposable Linux hosts; independent controller and observer principals/hosts/trust domains; protected off-host evidence custody and signing; supervised sandbox publication; current repository ruleset and required-CI evidence. Local mocks, local digests and co-resident GitHub smoke cannot satisfy those gates.

No paid software/API is required by the implementation. Suitable existing independently operated Linux machines plus free Podman, Envoy/nftables, native Ed25519 and self-hosted evidence storage are a no-license-cost alternative. If that environment is unavailable, the later spending boundary is disposable Linux compute and separate protected retained evidence storage, not a paid LLM or migration SDK. Provisioning or activation requires an explicit environment decision and the required security authority; none is performed here.

## Independent review and correction

Fresh whole-branch review of `bdb1e8c5..6c3590a1` found one important dormant
integration defect: after the wrapper retains policy, the old single snapshot
required `active/exited` and final policy absence together, although sealed
`ExecStopPost` runs after a separate stop. Four regression tests failed before
the correction, including acceptance of the fabricated single-stage success.
The corrected contract retains the successful execution record and separately
requires a completed stop, exact invocation/cgroup binding, successful cleanup
exit status, final cgroup absence, and ordered final teardown. The local
cleanup/observation suite passed 48/48. Full supported Node 22 CI then passed
1,094/1,094 tests with zero failures, skips or cancellations, including all
291 deployment tests. Correction commit: `f255c83cc1372b5a8bfd9a956c2d03a65d9bf128`. Both live entrypoints refuse until a
trusted independent two-stage producer exists. This changes the unsigned data
contract and does not assert that a native lifecycle or producer was deployed.
The reviewer found no other significant issue in the reviewed changes.

## Hosted compatibility correction

PR 23 at `f86d9b1` passed hosted CI but the Linux smoke and joined fixtures
refused startup: Ubuntu 24.04/systemd 255 rejects `JobTimeoutSec` on transient
units (`Cannot set property JobTimeoutUSec`). The pinned upstream setter falls
through without returning success; the sibling `JobRunningTimeoutUSec` setter
is supported. [Pinned systemd source](https://github.com/systemd/systemd/blob/v255/src/core/dbus-unit.c).

The correction uses `JobRunningTimeoutSec` and a fixed native `ExecStartPre`
admission guard through the already sealed Node executable. Queue admission
must finish within the original ten-second combined client/queue allowance;
the selected runtime plus 25 seconds for pre-start completion, main activation
and shutdown must still precede both
canonical wall expiry and the original host-monotonic deadline. No later
queued start can renew the plan, even after controller exit. JIT/Wasm are
disabled to preserve the unit's existing memory-execution restriction. Three
regressions failed before the correction; focused tests then passed 25/25,
including harmless executions of the actual guard for permitted, delayed,
expired and rolled-back clock cases. The DNS floor and existing reserves are
preserved. Native acceptance awaits the new exact PR revision's hosted checks.

Peer review also identified that systemd re-arms the startup timer separately
for `ExecStartPre` and main start. A late pre-start guard regression failed
(actual status 0 instead of 1), then the guard reserved five additional seconds
for descheduling/completion after its clock read. The original 15-second
shutdown reserve remains intact. [Pinned stage timer source](https://github.com/systemd/systemd/blob/v255/src/core/service.c#L1512-L1520).
[Node's pinned Linux monotonic clock](https://github.com/nodejs/node/blob/v22.23.2/deps/uv/src/unix/linux.c#L1525-L1556)
is shared by controller and pre-start process in the same host/time namespace;
this cross-process property is not inferred from `process.uptime`.

After the pre-start completion correction, focused tests passed 25/25 and
full supported Node 22 CI passed 1,096/1,096, with zero failures, skips or
cancellations. The complete deployment suite passed 293/293.


## Continued DNS investigation and fixture timing

At topic head `579ef075`, CI run 36870094410 and all 15 Linux smoke scenarios
(run 36870094369) passed. Joined run 36870094375 passed install failure and
cancellation, but success twice refused DNS admission: 18 valid subfloor
answers over 90,006/90,005ms, floor 120s, cleanup successful. GitHub's synthetic
merge `c483d624` has topic/main parents and the same tree as `579ef075`; these
logs tested current bytes. Admission precedes plan creation and gateway
startup. Neither plan aging nor native startup explains these failures.

The joined workflow saved per-attempt DNS diagnostics but uploaded only the
final report, which does not exist after admission failure. This diagnostic
loss prevented a precise hosted cache-age diagnosis. The workflow now exports
only that exact bounded diagnostic independently of report completion. Strict
root-owned metadata/path checks and an allowlisted JSON parser precede upload;
raw addresses, resolver addresses and adjacent evidence remain private.
Meaningful missing-export and failed-probe regressions failed before the fix;
43 workflow tests now pass. Explicit shell guards also reject malformed
metadata on the local Bash version, whose errexit does not stop every failing
conditional/arithmetic command.

Two non-activating 150-second probes used pinned Node 22.23.2 and the existing
cached Docker image, without image pulls or host resolver changes. Mac: 30
valid replies, TTLs 2–298s, 150,003ms; default Docker bridge: 30 valid replies,
constant TTL 274s, 150,008ms. Both observed the same 12-address set, stored only
as a digest. Two discovered authoritative nameservers returned TTL 300s. Mac
cache ages differed across replies; one sample met 120 before 90 seconds.
Neither probe reproduced Ubuntu's failure. Pinned Node disables c-ares query
caching, so recreating Resolver objects would not remedy that upstream
behavior. [Node source](https://github.com/nodejs/node/blob/v22.23.2/src/cares_wrap.cc#L824-L844).
Recursive resolvers can return a TTL below authority TTL, so authority 300s
alone does not establish the hosted answer lifetime. [RFC 2181, section 8](https://www.rfc-editor.org/rfc/rfc2181.html#section-8).
Local probe evidence: `/tmp/api-migrator-free-readiness/dns-investigation/`.
The 120s floor, 90s acquisition budget, five-second retry cadence, default
resolver and complete-answer minimum remain unchanged. The next instrumented
hosted run is a discriminating experiment, not a blind retry.

Independent timing review also identified two fixture correctness defects.
Successful phase settlement checked freshness while rejected settlement could
be converted to expected failure/cancellation after expiry. Four initial
regressions reproduced rejected acceptance, wall/elapsed rollback, and stalled
wall-time reuse. One wall/elapsed anchor now charges operations after
construction, refuses invalid/reversing clocks, and applies the same completion
check to success and rejection. The genuine native cancellation composition
also failed when the old success-only check was restored; fresh native proof
retains its original error identity. Focused lifecycle/cancellation checks
passed 50/50, including exact floor-120 phase admission and setup age.
This anchor does not claim to measure time before operations construction.

Execution gateway stop previously admitted 15s but invoked independent 20/30s
native commands and a wall-clock polling loop. Its commands and observations
now consume one monotonic 15s budget; polling also rejects a truthy observation
completed after its deadline. Eleven regressions demonstrated the old failures.
Cleanup still makes its separate unconditional stop attempt after execution
expiry and requires full native absence. The combined deployment suite passed
351/351, zero failures/skips. Full supported Node 22 project CI passed
1,154/1,154 tests, zero failures/skips/cancellations, with package builds,
typechecks, existing Docker verification, pilot validation, console build and
packaging checks. Log: `/tmp/api-migrator-free-readiness/full-ci-dns-investigation.log`.
Fresh exact-revision review and instrumented hosted checks remain pending.
