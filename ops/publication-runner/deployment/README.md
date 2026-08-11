# Runner Deployment v2 host contract — activation blocked

This directory is a non-authorizing **deployment contract candidate**. It is not
a deployed runner, a working gateway integration, Linux enforcement evidence,
or a source of signed attestations. Live host activation and external signing
eligibility are deliberately blocked.

The checked-in image protocol, v2 host/job descriptors, host-unit renderer,
gateway renderer and probe, structural lifecycle-drill contract, and strict
data validators can be tested independently. They do not yet form one safe
live lifecycle. In particular, the current host wrapper does not own the
required sequence:

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
Envoy and nftables counters. The v2 profile's orchestrator and observer paths
are provisioning bindings for future executables; their example digests are
placeholders, not a statement that a live orchestrator is checked in.

Do not sign the generated request, populate a runner-attestation digest from it,
or install/start the rendered units. The request exists only to make the future
schema and non-authorizing boundary testable.

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
```

The renderer writes candidate unit text to stdout only and does not install it.
Snapshot mode validates a synthetic contract fixture and labels the resulting
observation `contract_fixture`; it cannot become live or signing-eligible. The
fixture binds the exact four-container order (`prepare`, `install`, `migrate`,
`verify`) and the offline-preparation log digest, but does not claim those
containers ran on Linux.

## Required next Linux milestone

Use a disposable dedicated Linux host to implement the pinned orchestrator and
independent observer that own
the entire gateway/runner phase boundary. Bind every deployed executable,
script, library, unit, Envoy configuration, and nftables artifact by digest.
Exercise success, timeout, SIGKILL, OOM, reboot, wrong/no-SNI, direct-bypass,
offline-network, gateway-stop, UID-idle, policy-removal, and workspace-cleanup
paths. An independent observer must then validate the exact gateway contract and
canonical receipt, including the separate gateway UID, unit/cgroup, listener,
table, and teardown timestamps. Only a later reviewed change may remove the
activation block or make a request eligible for external signing.
