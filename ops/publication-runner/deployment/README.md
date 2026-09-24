# Runner Deployment v2 host contract — activation blocked

The production boundary in this directory remains a non-authorizing
**deployment contract candidate**, not a deployed runner or a source of signed
attestations. The test-only hosted integrations below cannot supply authoritative
Linux enforcement evidence. Live host activation and external signing
eligibility remain blocked.

The checked-in image protocol, v2 host/job descriptors, host-unit renderer,
gateway renderer and probe, structural lifecycle-drill contract, external
dedicated-host handoff, strict data validators, and native-configuration
preflight can be tested independently.
They do not yet form one safe live lifecycle. In particular, the current host
wrapper does not own the required sequence:

1. install the forced two-identity nftables policy;
2. start the pinned static-SNI Envoy gateway and prove its listeners;
3. run trusted source preparation with `--network=none` in the exact `prepare`
   container before any dependency installation;
4. run only trusted lifecycle-disabled dependency installation online;
5. stop the gateway and prove both identities idle;
6. remove the gateway policy before migration and repository checks;
7. independently validate the canonical gateway receipt and all teardown.

Until that sequence exists and passes a disposable-Linux drill:

- `run-credential-free-preview.sh` exits before reading job inputs or mutating
  host state;
- `observe-runner.mjs --live` refuses execution;
- rendered unit metadata reports `activationBlocked: true` and
  `externalSigningEligible: false`;
- the L7 document is only an exact `not_wired` integration-status sentinel. It
  is not gateway evidence and makes no TLS, redirect, request, or teardown
  claim;
- every unsigned request has `eligibleForExternalSigning: false` and
  `authorizationStatus: blocked_pending_linux_gateway_lifecycle_drill`.

`lifecycle-drill.mjs` cross-binds one reference v2 job, host profile, canonical
plan, and rendered gateway. Its scenario matrix defines 17 **independent**
disposable-host jobs; it does not claim those jobs ran. Its aggregate validator
accepts only the fixed observer-first event order, distinct per-scenario
job/plan/evidence identities, complete teardown timestamps, and an explicitly
non-authorizing result. Synthetic reports can exercise this data boundary, but
they are not Linux evidence and cannot remove any block.

The gateway probe is also a drill component, not authorization. It refuses the
wrong OS identity, uses numeric destinations only, tests the fixed listener and
forced origin path separately, and requires later correlation with independent
Envoy and nftables counters.

`run-gateway-lifecycle.mjs --preflight` and
`observe-gateway-lifecycle.mjs --preflight` establish the first executable
boundary without activating it. The observer must create an exact, canonical
readiness event before the orchestrator can render anything. The orchestrator
then runs only Envoy's native configuration validator and nftables check mode;
it never installs a table, starts Envoy, invokes the runner, or opens a network
connection. The independent observer repeats those checks, snapshots the exact
job tables and identities before and after, and reports that no gateway
lifecycle mutation was observed. Every result is permanently
marked non-authorizing and ineligible for release evidence, activation, or
external signing.

The v2 descriptor also binds the exact per-job runtime root that a later fault
drill may clean up. A root-sealed lifecycle runtime manifest covers the complete
imported script/library/template/unit closure; hashing only an entrypoint is not
treated as a transitive runtime binding. Example digests remain placeholders
and do not claim that any host is provisioned.

## External dedicated-host handoff contract

`dedicated-drill-handoff.mjs` defines the provider-neutral boundary between a
future external controller, an independently hosted read-only observer, and 17
fresh disposable target hosts. One provider name and provider-scope digest are
fixed across the entire handoff; every attempt and host lease must reproduce
that exact scope. A target host may be at most 15 minutes old when the handoff is
issued, its attempt deadline may be at most 30 minutes after issuance, and its
lease may extend at most one hour after issuance. Every deadline must precede
its lease expiry. The controller-owned append-only evidence sink must remain
target-inaccessible and retain evidence for at least 30 days after the latest
attempt deadline.

The controller and read-only observer must have distinct host IDs, principal
digests, runtime digests, identities, and trust domains. Each ordered scenario
has a non-reused host lease, job, nonce, initial boot identity, provider lease
receipt, instance identity, and plan. It also binds the image, runtime manifest,
gateway contract, and nftables policy used for that attempt.
Its contextual attempt digest additionally commits to the suite, source
revision, issue time, provider and scope, controller and observer, and complete
attempt body. The event-chain root is derived separately for each handoff and
attempt, and every event repeats both digests before extending that chain.

Every non-OOM/reboot scenario has its own ordered stimulus and observation
events rather than a generic label. Timeout and SIGKILL require explicit
injection events; network cases bind their exact probe start and observation;
gateway-stop, UID-idle, policy-removal, cgroup/namespace-cleanup, and
workspace-cleanup observations can occur only after their defining lifecycle
event. The generic proof binds both event names and both evidence digests.

The matching attempt-report validator requires a hash-chained, scenario-specific
observer event stream, a gateway-receipt digest bound to the ready event,
off-host evidence bundle bindings, complete host destruction, and fail-closed teardown. The host
lease receipt is bound to the `host_lease_verified` event. The final destruction
receipt fixes the provider, scope, instance and controller identities and is
bound to the `host_destroyed` event.

The OOM profile is restricted to a bounded cgroup-v2 kill with zero swap, a live
host, and retained containment. Its proof carries canonical before/after
`memory.events` snapshots that each include the exact unit, cgroup path,
observation boundary, and counters for `oom`, `oomKill`, and `oomGroupKill`.
It requires monotonic counters and the exact computed kill delta, and binds the
limit, workload, and observation evidence to their corresponding events. The
reboot profile requires a structured provider-control-plane receipt bound to the
operation nonce, provider scope, instance identity, controller identity, and
request/unreachable/reconnect/completion timestamps. The observed unavailable
interval cannot exceed the profile maximum, the instance identity must remain
the same, the boot identity must change, and post-boot unit quiescence,
containment absence, workspace cleanup, and final destruction are mandatory.

Every attempt report contains a deterministic evidence manifest below the
configured off-host `https`, `s3`, `gs`, or `az` location. Its base path is
derived from the handoff and attempt digests, and its exact object references
cover the event records, gateway receipt, fault proof and supporting OOM or
reboot evidence, teardown proof, provider lease/operation/destruction receipts,
raw evidence archive, and append receipt. The manifest therefore supplies both
retrieval coordinates and digest bindings without granting target hosts sink
credentials or write access.

This is executable contract validation only. The checked-in example uses a
placeholder provider; no provider adapter, cloud project, billing account, OIDC
trust, credential, evidence service, VM image, provisioning workflow, or live
drill is configured. The module does not provision, connect to, reboot, destroy,
or observe a host. Every handoff and attempt report therefore fixes
`selfAttested: false`,
`authoritativeDrill: false`, `releaseEvidenceEligible: false`,
`activationBlocked: true`, and `externalSigningEligible: false`. Those fields
cannot be promoted by supplying different JSON.

## GitHub-hosted Linux smoke

`.github/workflows/linux-l7-smoke.yml` is a separate, permanently
non-authorizing regression boundary. It runs 15 scenarios as independent fresh
`ubuntu-24.04` jobs, extracts the reviewed Envoy 1.39.0 binary from its exact
linux/amd64 image manifest without starting the image, seals the small runtime
closure as root, installs one exact job-owned nftables table, and proves both
loopback listeners and IPv4/IPv6 positive probes. Negative SNI, plaintext,
forced-route, non-443, non-npm, gateway-stop, fail-closed offline, fault, UID,
cgroup/process-namespace-reference, workspace, and policy-removal paths are
correlated with bounded native
evidence. Containment is removed only after the exact units, UIDs, cgroup, and
workspace are absent.

The workflow has no App, customer, signing, cloud, or application credentials
and never loads customer source. GitHub Actions still supplies runner-control
state, repository-controlled code has passwordless `sudo`, and the observer is
co-resident with the runner. Every scenario and aggregate therefore uses the
distinct `api_migrator_github_hosted_l7_smoke_*` kinds, declares
`selfAttested: true`, `authoritativeDrill: false`,
`releaseEvidenceEligible: false`, `activationBlocked: true`, and
`externalSigningEligible: false`, and is rejected if an authority-like field is
introduced. These reports cannot satisfy a gateway receipt, runner attestation,
signing request, capability, challenge, or publication boundary. Separately,
the preflight-generated signing request must not be signed or populated into a
runner attestation, and the candidate production units remain blocked; that
request exists only to make the future schema boundary testable.

### DNS preflight diagnostics

Every DNS acquisition writes one `*-dns-resolution-diagnostics.txt` JSON file
under the scenario's `evidence/` directory, including on preflight failure. The
existing bounded diagnostic upload retains it even when no scenario report was
produced. It is non-authorizing diagnostic data, not a passed scenario or runner
attestation. A failed preflight and the aggregate still fail.

The record is capped at 100 attempt entries and 64 KiB. It records monotonic
start/completion offsets and query durations, answer and unique-address counts,
minimum/maximum TTL, distinct-TTL count, a SHA-256 digest of the sorted unique
address set, and fixed outcome codes. Malformed/unavailable answers have null
TTL and identity fields. Runtime metadata contains Node/c-ares versions and the
native resolver-server count (null when unavailable or using a test resolver); raw DNS server
addresses, answer addresses, environment values, and exception text are omitted.
These digests are for comparing answer sets, not secrecy or authorization.

An attempt can be `ttl_below_minimum` while the final outcome is
`ttl_floor_exhausted`; the final retry sleep is not an additional query. Offsets
and total elapsed time describe DNS acquisition, excluding diagnostic file I/O.
The synchronous write does not refresh the answer's observation timestamp; plan
construction afterward still checks its remaining lifetime. A failed required
write blocks successful acquisition, and a write failure during acquisition
failure preserves the original sanitized DNS error.

The 65-second DNS floor, 60-second minimum plan lifetime, 90-second query/retry
budget, five-second retry interval, default resolver selection, and expiry caps
are unchanged. Diagnostic capture does not fix intermittent upstream DNS
freshness failures. Inspect an instrumented hosted run before choosing a
functional retry or resolver change.

## Joined runner-image fixture

[`runner-lifecycle-fixture.yml`](../../../.github/workflows/runner-lifecycle-fixture.yml)
runs the fixed image protocol and native gateway controls together on disposable
Ubuntu 24.04 workers. This is a separate test entrypoint,
`run-image-lifecycle-fixture.mjs`; it does not enable the guarded production
wrapper, observer, or console actions. The existing 15-scenario smoke stays
separate.

The shared `image/fixture-phases.mjs` generates the fixed Inngest fixture and
dependency lockfile before restricted execution is measured. After fresh DNS
acquisition, the adapter binds the real source, image config digest, runner plan
and gateway contract. It installs containment before preparation, uses
`--network=none` for preparation, migration and verification, and permits host
networking only for installation under the dedicated non-root UID. The native
adapter checks the actual container host UID and rejects Docker rootless or
user-namespace modes that would invalidate that attribution.

Readiness probes cover both loopback listener families, wrong/missing TLS SNI,
and prohibited destinations. A direct npm connection is expected to succeed
only through forced redirection: correlated counters establish traversal, not
HTTP success alone. Installation has its own before/after counter observations.
The gateway must stop and offline closure must pass before migration and
verification. Containment remains installed until exact owned containers,
units/cgroups, processes and workspace trees have been cleared. An incomplete
cleanup or failed evidence write cannot produce a passing result.

The joined fixture admits only DNS answers with a complete-answer minimum TTL
of at least 120 seconds. This is stronger admission headroom, not a guarantee
that the worst-case lifecycle fits. The existing smoke retains its 65-second
floor; both callers retain the same bounded 90-second acquisition window and
5-second retry interval. Neither observed TTL nor observation time is extended
or renewed. Each image phase still has a 45-second maximum and must fit before
both plan and DNS expiry with a 30-second cleanup reserve. Freshness failures
name the allowlisted stage, plan age, remaining plan/DNS lifetime, command
budget and cleanup reserve in bounded CLI output, including when cleanup also
fails. Arbitrary error text, source and subprocess output are not printed.
Other failures report fixed setup/operation/probe/phase stages and allowlisted
categories, with bounded exit status, signal, timeout or command-budget facts
only when observed. A `cleanupFailed` boolean distinguishes initial cleanup
failure without hiding the original diagnostic. These diagnostics do not relax
any lifecycle check or establish the cause of an earlier generic failure.

The two workflow scenarios are:

- `success`: all four real image phases, transport checks and cleanup.
- `install_failure`: a real install container receives a deliberately wrong
  prepared-state digest after gateway setup. Protocol rejection must prevent
  migration and verification, then cleanup must succeed. This is not an
  interrupted-download, SIGKILL, OOM or reboot test.

The workflow seals its runtime, invokes it with an allowlisted environment, and
runs `cleanup-image-lifecycle-fixture.mjs` plus a residual audit even after the
main step fails. Only the bounded `fixture-report.json` summary is uploaded; the
fixture checkout, raw source bundle and phase workspaces are not artifacts.
Every passing result fixes `securityDrill: false`, `selfAttested: true`,
`releaseEvidenceEligible: false`, `activationBlocked: true`, and
`externalSigningEligible: false`.

Check the current revision's hosted jobs and artifacts before claiming this
integration passed on Linux. Local command-boundary tests and the standalone
Docker image integration do not prove native Linux enforcement. Even a passing
hosted fixture does not validate the production rootless-Podman adapter,
independent observation, protected custody, signing, or the console bridge.

## Static checks

These commands do not provision or activate a host:

```sh
node --test ops/publication-runner/deployment/test/*.test.mjs
node --test ops/publication-runner/gateway/test/*.test.mjs
node ops/publication-runner/deployment/render-units.mjs \
  --job /absolute/job-descriptor.json \
  --host-profile /absolute/host-profile.json \
  --now-ms 2000000000000
node ops/publication-runner/deployment/observe-runner.mjs \
  --job /absolute/job-descriptor.json \
  --snapshot /absolute/contract-fixture-snapshot.json
node ops/publication-runner/deployment/observe-gateway-lifecycle.mjs \
  --preflight --job /absolute/job-descriptor.json
node ops/publication-runner/deployment/run-gateway-lifecycle.mjs \
  --preflight --job /absolute/job-descriptor.json
```

The renderer writes candidate unit text to stdout only and does not install it.
Snapshot mode validates a synthetic contract fixture and labels the resulting
observation `contract_fixture`; it cannot become live or signing-eligible. The
fixture binds the exact four-container order (`prepare`, `install`, `migrate`,
`verify`) and the offline-preparation log digest, but does not claim those
containers ran on Linux. The two preflight commands require their exact sealed
Linux inputs and observer-first handshake; they are not ordinary local macOS
commands and do not perform the lifecycle scenario matrix.

## Remaining Linux milestone

The hosted workflow covers the non-authorizing full-Linux regression slice but
does not replace externally observed release evidence. OOM and reboot are
deliberately omitted because a co-resident hosted job cannot safely or
authoritatively observe those host-loss boundaries.

The joined fixture adds real image-phase orchestration to that test surface. A
production rootless runner, independently observed gateway lifecycle, and a
verified control-plane provider for the console are still separate work.

The provider-neutral handoff and attempt-report contracts now define the data
boundary, but the authoritative drill still requires infrastructure and
authority that are absent from this repository: a chosen provider and isolated
project, billing and quotas, immutable disposable Linux images, short-lived
controller access, a separately hosted observer, and a target-inaccessible
off-host evidence sink. Each of success, timeout, SIGKILL, bounded cgroup OOM,
reboot, wrong/no-SNI, direct-bypass, offline-network, gateway-stop, UID-idle,
policy-removal, namespace/cgroup cleanup, and workspace-cleanup must run as an
independent host job. The observer must validate the exact gateway contract and
canonical receipt, including the separate gateway UID, unit/cgroup, both
listeners, correlated counters, exact runtime root, and teardown timestamps.
Only a later reviewed change, after real externally observed evidence, may
remove the activation block or make a request eligible for external signing.
