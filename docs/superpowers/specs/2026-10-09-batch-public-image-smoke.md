# Public runner image on managed Batch

## Decision and scope

Run the real four-phase public Inngest image fixture on the already approved
disposable Debian 12 Batch host. This is a separate, non-authorizing protocol
smoke, not a Debian port of the Ubuntu native gateway fixture and not a rootless
production runner. The user delegated routine implementation choices and asked
for uninterrupted progress; no new IAM, billing, customer access or publication
authority is implied.

Reusing the joined Ubuntu/rootful-Docker fixture would require a platform and
gateway port. Replacing Docker with Podman would require a different UID, mount,
cgroup and network adapter. The smallest useful next evidence is therefore the
real image protocol on the approved host, with those remaining gaps explicit.

## Fixed authority and resources

- Personal project `project-32bf49a2-bd30-4956-850`, zone `us-central1-a`.
- Existing worker with only Batch reporting and log writing; existing isolated
  subnet/no-ingress policy; no credentials passed to source or containers.
- One `e2-medium`, 30 GB `pd-standard`, one task, zero retries, 1,800-second task
  maximum; supervise queue/initialization and independently fetch final absence.
- Same strict eight request fields as engine smoke. No arbitrary script, registry,
  repository URL, machine, service account or command inputs.
- Fixed profile `batch-public-image-phase-smoke-v1`; engine profile unchanged.
- Node 22.23.2 and public archive SHA-256 pinned. Runner Dockerfile already pins
  its base image. Build locally on the guest; retain exact image ID in evidence.

## Guest execution

Deadline and Debian 12/amd64/root admission occur before mutations. Provision
only bounded trusted tools. Inspect the image's existing Docker runtime first;
do not replace Batch agent/runtime packages or run a remote install script.
Fail closed if a working local rootful Docker/cgroup-v2 daemon is unavailable.

Repository acquisition, npm lifecycle-disabled install and package build run as
a fresh non-login UID. A root-controlled, non-writable runtime tree is required
before root launches fixture orchestration; quiesce the build UID before sealing
and never give it Docker socket access. The root controller may build the pinned
public Dockerfile and generate the synthetic fixture; this is trusted public
setup, not customer isolation. No private source or credentials are present.

The public build installs only the engine, db, app and runner workspaces plus
root build tools, with lifecycle scripts disabled. The console is not needed
for this profile and must not be installed. Retain a bounded 64 MiB per-file
limit for this public build: the initial 8 MiB cap was reproduced truncating
required TypeScript files. The 600-second public-build timeout, process limit,
output bounds, other phase limits and all production gates remain unchanged.

Use existing four-phase functions and exact owned-container cleanup. A dedicated
non-root UID/GID owns only fixture data. Prepare, migrate and verify use network
`none`; install uses `host` so host UID metadata rules apply. Retain dropped
capabilities, read-only root filesystem, no-new-privileges and resource limits.
Before phases, prove metadata ID is reachable from the trusted root controller
and unreachable by the actual non-root container. Never request a token. Keep
metadata denial until the VM is destroyed, including error paths.

This profile does NOT prove npm-only egress or live DNS-TTL enforcement. Explicitly
label the standalone fixture's synthetic resolution lifetime as scaffolding.
Do not weaken the existing joined fixture's 120-second DNS floor or Ubuntu guard.
The result must include the exact image ID, plan/evidence digests, output binding,
all four successful phases, verified owned-container/workspace cleanup and
`securityDrill:false`, `selfAttested:true`, `releaseEvidenceEligible:false`,
`activationBlocked:true`, `externalSigningEligible:false`, `productionReady:false`.

Bound every phase by remaining wall deadline, cap logs/reports, install failure
emission early once the pinned runtime exists. A killed client is not proof of
container death. Failed cleanup never yields passing evidence. Final VM/disk/MIG
absence remains a separate authenticated operator observation, not a guest claim.

## Evidence and compatibility

Separate render-only CLI `gcp:batch:image:prepare` and `prepareBatchImage` use the
same fixed infrastructure/request validator. Shared code may be extracted where
needed, but the legacy engine request, generated script and classifier behavior
must remain compatible. The new profile must not accept engine TAP evidence.

Keep indexed bounded log chunks and one trusted result marker bound to run,
source and script. Extend the operator classifier with an explicit known-profile
dispatch (default legacy engine for old prepared records). Reconstruct the image
summary independently; missing, duplicate, substituted or malformed phase output
must not pass. Existing job UID/material-config and independent inventory checks
apply unchanged. These are operator consistency checks, never attestation.

## Verification and completion

Tests must execute generated bootstrap/controller behavior, not merely search
its text. Supplemental controlled native bootstrap fixtures may substitute
provisioning, downloads and Docker build commands to cover control-flow failures;
label these substitutions and do not count them as live provisioning evidence.
Separately build the real image and execute real local containers where the host
supports them, substituting only the unavailable cloud metadata positive control
for those image tests. On explicitly opted-in GitHub-hosted Linux only, the test
must admit a local rootful/cgroup-v2 daemon and install an exact fixture-owned
inet table denying the current nonzero test UID's TCP/80 traffic to both metadata
addresses. Bounded cleanup may delete only that unchanged owned table, after
independently observing owned-container absence, then must observe table absence;
an always-run workflow step independently retries/audits the receipt. Other Linux
hosts fail without policy mutation. Mac explicitly reports local non-GCE evidence
and does not install nft rules. Probe failures report bounded exit/signal and fixed
reason enums, never response bodies, headers or tokens. GCE metadata isolation
still requires the supervised live guest run. Include failed phase, timeout,
wrong image/UID, missing cleanup,
cross-profile evidence, malformed report, stale deadline and broad-input denial.
Run full Docker-enabled CI, dependency audit, independent review, and preserve
exact Abhishek author/committer identities. Open a separate PR; do not auto-merge.

### Bounded public fixture preparation and failure diagnostics

The first corrected-head guest reached `image_smoke` but retained zero worker
bytes, because detailed controller stderr was redirected to a file destroyed
with the VM. Preserve one bounded failure-only stdout record in the existing
digest-bound worker log; never scrape or publish `controller.log`.

Exact-source Debian x86_64 reproduction also shows the inherited 8 MiB
controller file cap rejecting npm's @types/node metadata during public fixture
preparation. The same preparation succeeds under 64 MiB. Raise only this public
image_smoke controller's per-file limit to 64 MiB. Keep image_build at 8 MiB,
worker-log encoding at 4 MiB, child output/diagnostic bounds, deadlines, process
limits and every isolation/activation gate unchanged. This establishes a local
setup defect consistent with the guest failure, not its exclusive live cause.
Future metadata growth beyond the finite limit must still fail closed.

Use `API_MIGRATOR_BATCH_IMAGE_FAILURE` with exactly `schemaVersion`, `stage`,
`reason`, `exitCode` and `signal`; the complete line is at most 1,024 bytes.
Stage is the last entered checkpoint, not a claim about underlying root cause.
Stages are controller_entry, admission, public_setup, registry_resolution,
fixture_plan, fixture_ownership, root_metadata, container_metadata, prepare,
install, migrate, verify, cleanup and summary_validation. Reasons are
invalid_input, admission_denied, deadline_exhausted, output_limit,
diagnostic_limit, subprocess_failed, cleanup_unverified, invalid_output,
unexpected and controller_unavailable. Use `unexpected` without narrower typed
evidence. Exit is an integer 0–255 or null; signal is an allowlisted actual
signal or null. Never infer a signal from a shell exit number.

Never retain messages, stacks, causes, arbitrary codes, commands, URLs, HTTP
responses or raw subprocess output. Preserve actual preparation-child close
code/signal and existing timeout/output/cleanup precedence. Replace raw CLI
error stderr with a fixed safe message. If a nonzero image_smoke exit leaves
an empty worker log, the trusted emitter supplies controller_entry /
controller_unavailable using the observed shell exit and unknown signal.

Success remains byte-for-byte the existing single-summary protocol. Failure
diagnostics, mixed output and malformed records can never satisfy it; the
success predicate and activation gates stay unchanged. External cleanup proof
remains mandatory. No other cap or runtime-policy change is authorized.

The live supervised trial may run only after local gates are clean and source is
available at an immutable public revision. Retain accepted job, fetched terminal
job, complete digest-bound logs, and separately fetched full-project empty
instances/disks/managed-groups. No live claim may be based on local tests alone.
