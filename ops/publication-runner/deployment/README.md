# Runner Deployment v2 host contract — activation blocked

This directory is a non-authorizing **deployment contract candidate**. It is not
a deployed runner, a working gateway integration, Linux enforcement evidence,
or a source of signed attestations. Live host activation and external signing
eligibility are deliberately blocked.

The checked-in image protocol, v2 host/job descriptors, host-unit renderer,
gateway renderer and probe, structural lifecycle-drill contract, strict data
validators, and native-configuration preflight can be tested independently.
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

The authoritative drill still requires fresh disposable dedicated Linux hosts
controlled by an external observer. Exercise success, timeout, SIGKILL, bounded
cgroup OOM, reboot, wrong/no-SNI, direct-bypass, offline-network, gateway-stop,
UID-idle, policy-removal, namespace/cgroup cleanup, and workspace-cleanup paths
as independent jobs. The observer must validate the exact gateway contract and
canonical receipt, including the separate gateway UID, unit/cgroup, both
listeners, correlated counters, exact runtime root, and teardown timestamps.
Only a later reviewed change may remove the activation block or make a request
eligible for external signing.
