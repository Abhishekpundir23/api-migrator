# Runner lifecycle fixture: execution-first design

Status: execution authorized on 2026-09-24. The user instructed us to proceed
without further design/plan questions. This permission does not activate live
hosts, signing, publication, paid infrastructure, or external repositories.
Baseline: `53d635fa20855f7ef998c567f387b7aff518e46f`.

## Outcome

Join the real four-phase runner-image fixture to the existing forced-SNI Linux
gateway controls. The acceptance result is one disposable Linux fixture run,
with observable network denial and cleanup, not a production authorization.
The existing image integration and hosted gateway smoke currently test these
halves separately. Keep their existing entrypoints and checks working.

## Scope and boundaries

- Node 22.23.2; existing dependencies only. Native integration targets disposable
  Ubuntu 24.04 GitHub-hosted workers, never the operator's macOS network stack.
- Use only the generated Inngest fixture; accept no repository URL, source path,
  arbitrary workload, shell command, signing key, or service URL from the CLI.
- All generated Git commits use author and committer
  `Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>`.
- The existing live wrapper and observer remain disabled. The console's three
  post-preview actions, provider-availability constant, and receipt versions
  remain unchanged. No App permission changes or professional/client access.
- Every successful result explicitly carries `securityDrill: false`,
  `selfAttested: true`, `releaseEvidenceEligible: false`,
  `activationBlocked: true`, and `externalSigningEligible: false`.
- GitHub-hosted checks are co-resident regression evidence. They do not replace
  independent observer/signing, protected custody, OOM/reboot drills, a chosen
  provider, or the future console bridge.

## Design

### One reusable phase protocol

Extract the fixed fixture and four-phase protocol from
`image/run-phase-integration.mjs` into import-safe helpers. The existing image
integration becomes a thin caller. Reuse canonical source creation, runner plan
creation, exact status-line/digest validation, report checks, and existing image
verification. Do not create a second migration engine or copy the guarded live
wrapper into another executable. Keep fixture creation and dependency-lock
generation outside the restricted execution being measured and label that
distinction explicitly.

The phase adapter launches the same image with read-only root, dropped
capabilities, no-new-privileges, bounded memory/PIDs/CPU/logs/time, sanitized
environment, fixed entrypoint, and narrow mounts. Preparation, migration, and
verification always use `--network=none`. Only dependency installation can use
the online adapter. Lifecycle scripts stay disabled.

For this test-only Linux slice, the online adapter uses the preloaded Docker
image with host networking and an explicit dedicated non-root numeric UID.
That makes the fixture's sockets subject to the existing host-UID nftables
rules. Docker bridge mode does not satisfy this test. This is not the live
rootless-Podman profile: moving the same sequence to that production adapter is
a later deployment task, and must not be represented as completed here.

### Explicit lifecycle

`runFixtureLifecycle(operations)` owns the ordering:

1. Install the exact two-identity forced-gateway policy before running a phase.
2. Run preparation offline.
3. Start the pinned gateway under the separate gateway UID and prove listeners.
4. Exercise positive and negative transport probes with counter observations.
5. Run lifecycle-disabled installation through the gateway, proving forced-route
   traffic occurred during that phase rather than only during readiness probes.
6. Stop the gateway; prove its process/cgroup and both dedicated UIDs idle.
7. Prove offline closure while containment remains installed.
8. Run migration and verification offline and validate their exact output.
9. Tear down owned containers, units, namespaces, fixture workspace and finally
   the owned nftables table. Prove absence before reporting success.

On failure, no later phase runs. Cleanup is attempted even after a partial
setup failure. Cleanup failure cannot be hidden by an earlier failure or by a
successful phase; no passing result is returned. Native commands and the whole
CI job have deadlines, and an always-run cleanup step is a second boundary for
termination. This is not a claim that JavaScript finally handles SIGKILL/reboot.

### Native adapter and CLI

Add a separate fixture-only entrypoint; do not widen the existing hosted-smoke
scenario contract or enable `--live` on the production paths. Reuse gateway
rendering and existing hosted resource, identity, DNS, probe, and teardown
primitives where practical. Extract shared implementation rather than weakening
the established smoke checks. Reject ambient credentials/proxies/preloads;
launch workload children with an allowlisted environment. Require the existing
pinned Envoy binary, isolated dedicated UIDs, exact owned paths and an empty
starting resource boundary. Preserve real DNS expiry without invented TTLs.

The CLI accepts only a preloaded image identity and a new, narrow absolute
result directory on the disposable worker. It exposes no activation switch.
Output is a bounded summary with source/plan/image/output identity, phase
results, transport/teardown observations, and the permanent non-authorizing
fields. Raw fixture source and credentials must not become CI artifacts.

### Verification

- Unit tests execute the coordinator and phase protocol with doubles only at
  the external process boundary. Literal expected phase order, malformed status
  lines/digests, failure at every operation, and cleanup failure are covered.
- Run the actual existing image integration after extraction.
- A separate read-only-permission CI workflow provisions only job-local test
  identities, extracts the pinned Envoy binary, builds the local image, invokes
  the fixed Linux fixture, and uploads only bounded sanitized result evidence.
- Native success includes wrong/absent SNI rejection and successful direct-to-npm
  traffic with counters proving forced gateway traversal (not a bypass),
  gateway-stop closure, forced-route counters during install, all four real
  phases and final resource absence. A failure-injection fixture run demonstrates
  cleanup after a phase failure. The existing 15-scenario smoke remains intact.
- Full `API_MIGRATOR_DOCKER_TEST=1 npm run ci`, image integration, independent
  review, and fresh hosted outcomes gate claims of completion.

## Deferred outcome

This slice does not connect the console to a deployed trusted provider. It
establishes a real joined execution test needed before that connection. Provider
selection, spending authority, rootless production integration, independent
evidence custody, signing and customer pilot permission remain separate gates.
