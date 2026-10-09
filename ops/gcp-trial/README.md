# GCP trial preparation and read-only observations

## Managed Batch trial

`npm run gcp:batch:prepare -- --input REQUEST.json` renders a separate Batch
artifact; it never submits it. The request uses `projectId`, `runId`,
`sourceRevision`, `sourceArchiveSha256`, `bootImage`, `network`, `subnetwork`,
and `deleteAt`. Values follow the table below, except `bootImage` must be a
specific `batch-custom-image` version named
`batch-debian-12-official-YYYYMMDD-...`. There is no arbitrary script, account,
machine-size, retry, or project override.

The job uses one e2-medium task, a 30 GB standard boot disk, zero task retries,
a 30-minute task timeout, the dedicated `api-migrator-batch-worker` account,
and a separate no-ingress network. It needs outbound internet access through
an ephemeral external IP. Enable Batch and grant its Google-managed service
agent the documented service-agent role only after approval; the worker needs
only `roles/batch.agentReporter` and `roles/logging.logWriter`. No keys are
needed. Do not use the Compute default service account or default network.

The trusted bootstrap checks the absolute deadline, verifies Node and source
hashes, and runs only the public engine smoke under a separate Unix account.
Before repository execution, a UID-specific firewall blocks metadata HTTP on
both documented IP endpoints, with a positive root control and negative worker
probes. DNS to the IPv4 metadata resolver is allowed. This is not a hostile-code
sandbox: customer source, secrets, publication, and console activation remain
blocked.

The smoke requires positive test passes and unique test totals with no failures,
cancellations, or TODOs. It permits at most one skip: the engine test named
`Docker runner performs an install then an offline typecheck`, because this
profile does not install Docker. Every other skip is rejected. The separate
Docker-enabled local/CI suite must still run without skips.

Task timeouts do **not** bound queue or VM initialization time. Supervise the
first jobs, cancel stale/non-progressing jobs, and keep observing until terminal
state and independent VM/disk/instance-group absence. Do not call this a hard
cost cap or an unattended absolute-deadline controller.

Worker output is emitted as bounded, indexed base64 records plus a digest-bound
result in Cloud Logging. `classifyBatchResult` in `batch-result.mjs` joins the
prepared script, retained create response, fresh job response, complete task
logs filtered to the server-assigned job UID, and a full-project resource
inventory. It reports smoke and cleanup separately and never authorizes
production. Missing chunks, wrong identities, surviving resources, and incomplete
reads must not be treated as success. The inventory check is conservative: any
remaining VM, disk, or managed instance group in this otherwise empty trial
project leaves cleanup unverified. This function checks operator-collected
evidence; it is not an authenticated collector or an independent attestation.
The current classifier accepts absence receipts only within five minutes after
the terminal job update. A later empty inventory can be read manually, but this
classifier deliberately leaves that late receipt unverified; do not relabel its
timestamp or treat the refusal as evidence that resources survived.

Fetched job comparison accepts only the observed provider defaults: omitted zero
retries and false external-IP prohibition, the exact generated job-ID label,
output-only task-group name, and the exact parent-region plus pinned-zone pair.
Additional zones, changed accounts/scripts/resources, and unknown execution
fields still fail comparison. These normalization rules do not authenticate
operator-supplied observations.

Provider references: [Batch job lifecycle](https://docs.cloud.google.com/batch/docs/create-run-job),
[custom service accounts](https://docs.cloud.google.com/batch/docs/create-run-job-custom-service-account),
[timeouts](https://docs.cloud.google.com/batch/docs/set-timeouts), and
[Batch OS images](https://docs.cloud.google.com/batch/docs/view-os-images).

## Earlier Compute trial tools

The planning and preparation CLIs are **proposal renderers**, not deployment
commands. They make no network calls and never invoke `gcloud`. The inventory
and ownership/log collectors and cleanup check described below make authenticated reads
only. None can create, approve, or delete resources, authorize payment, or
enable production.
`--execute` and unknown flags fail.

```sh
npm run gcp:trial:plan -- --input /absolute/path/request.json
npm run test:ops:gcp
```

The input is one regular JSON file (at most 32 KiB, not a link) with exactly:

| Field | Required value |
| --- | --- |
| `projectId` | `project-32bf49a2-bd30-4956-850` only |
| `runId` | Fresh 32-character lowercase hexadecimal nonce |
| `sourceRevision` | Reviewed 40-character commit SHA in `Abhishekpundir23/api-migrator` |
| `sourceArchiveSha256` | Independently verified SHA-256 of that public source archive |
| `bootImage` | Verified existing `debian-cloud` image named `debian-12-bookworm-vYYYYMMDD`, not a family |
| `network`, `subnetwork` | Existing dedicated names prefixed `api-migrator-trial-` |
| `egress` | `existing-nat` or `ephemeral-external-ip`, explicitly chosen |
| `startupScriptSha256` | Verified hash of the separately reviewed future `startup.sh` |
| `deleteAt` | Absolute Unix milliseconds, 15-60 minutes after rendering |

The canonical JSON output binds all proposed commands and inputs to
`planDigest`. Commands are argument arrays, not shell strings: do not join them
and `eval` them. The create proposal fixes `us-central1-a`, `e2-medium`, a 30 GB
standard boot disk with auto-delete, no service account or scopes, no restart,
and an absolute deletion time. It uses explicit resource and quota projects.
The VM/disk names are not ownership proof; a future controller must capture
numeric IDs and verify ownership again before any delete operation.

`executionBlocked` and `billingApprovalRequired` stay true. A valid rendered
plan is not approval. The five-minute creation window is checked by the future
controller, not enforced by copying a gcloud command. Re-render stale plans.
The JavaScript renderers accept only enumerable data fields and validate a
snapshot of their values; getter-backed and hidden fields are rejected.
Never stop/restart a trial to extend its life or treat a timer as a receipt that
the VM and disk were deleted. Automatic termination can start late, and stopped
VMs still require independent cleanup/read-back.

## Egress and evidence

`existing-nat` renders `--no-address` and requires an already verified outbound
path to GitHub, Node, npm, package repositories and image registries. Private
Google Access is not a replacement for general internet egress. The external-IP
option requires explicit approval and verified effective ingress denial; a
dedicated network name or absence of HTTP tags does not establish this.
No NAT, VPC, firewall, IAM or billing configuration is created here.

The create proposal enables instance-only serial logging and disables
interactive serial access. `renderEvidenceRead({projectId, instanceId, fromMs,
toMs})` renders a Cloud Logging read by fixed originating project, zone, numeric
instance ID, fully qualified serial log name and a maximum two-hour window.
It requests at most 1,000 records; reaching that limit or
missing terminal records must be treated as possibly truncated/incomplete.
The renderer does not parse or certify log results. Direct serial-output reads
are not post-deletion retention proof. Try to download and hash evidence before
deletion, then verify it remains retrievable afterward. Evidence collection
must never delay cleanup: missing evidence means an incomplete trial, not an
extension of the deadline.

## Prepare the guest bootstrap

```sh
npm run gcp:trial:prepare -- --input /absolute/path/request-without-startup-hash.json
```

Use the same request fields above, **omitting** `startupScriptSha256`. The output
is `{plan, script}`; the returned plan binds the exact generated script bytes.
Save those bytes as `startup.sh` only for a separately approved trial. The CLI
does not write or execute the script. Re-render an expired plan and review its
new digest. Existing planner-only proposals are not upgraded or authorized.

The generated Bash expects root on a disposable Debian 12 amd64 guest. It
verifies the pinned Node 22.23.2 archive, creates a non-login user, clears the
worker environment, verifies the source archive, installs only the engine and
root build tools with `npm ci --ignore-scripts`, and runs engine build/tests.
Unrelated console dependencies are excluded. The 64 MiB per-file limit permits
the engine's deliberate oversized-lockfile test, and test files run serially
within the 128-process limit. It reserves 90 seconds before
the deletion deadline, bounds child processes, and rejects any second run using
a persistent root-owned directory. Repository code never runs as root. No
GitHub credentials or application secrets are supplied.

Only the root wrapper emits `API_MIGRATOR_TRIAL_RESULT` after the bounded worker
returns. Worker output stays in a root-owned log, not the marker stream. An
absent marker is incomplete; a marker is not signed or independently verified.
This `engine-smoke-v1` profile does not exercise Docker, deploy the app, or
satisfy the dedicated runner drill. Local Docker tests use real verified Node,
tar, npm, user creation and privilege dropping with a small source fixture;
downloads and OS-package installation inside the test container are substituted.
The full bootstrap test downloads the pinned official Node archive to the local
temporary fixture before running the container without network access.

## Offline cleanup decisions

`cleanup.mjs` exports `captureOwnership(planJson, observationJson, {nowMs})` and
`decideCleanup(planJson, recordJson, inventoryJson, {nowMs, reason})`. Inputs are
bounded JSON strings. The controller validates but does not fetch observations.

- Capture requires a completed error-free insert operation, matching uint64 VM
  ID, matching nonce, exact project/zone links and a single auto-delete boot disk
  with its own ID. IDs remain strings. Records bind the original plan/deadline.
- Inventory envelopes contain `projectId`, `zone`, `observedAt`, `filter: ""`,
  and `instances`/`disks` page chains. Each page is `{pageToken, response}` with
  the original GCP list response. All pages must be present in order, ending
  without a next token. Reads must be at most 30 seconds old. Filtered, error,
  malformed, repeated or partial responses are rejected.
- `deadline` waits only before the absolute deadline. `completed`, `failed`,
  `cancelled` and `controller_failure` require immediate cleanup decisions.
  There is no dependency on successful log collection.
- Replacements, changed attachments and unexpected run-labelled resources are
  flagged without adopting them. Remaining disks are reported independently.
  Only complete absence observations yield `absence_observed`.

Every output retains `executionBlocked`, `activationBlocked`, and
`cloudVerified: false`. Digests detect accidental changes; they are not
authentication or custody. Forged JSON observations do not prove cloud state.
The public deletion reference describes names; the discovery contract also
accepts numeric instance selectors (see the rehearsal below). There is no
documented expected-ID precondition for a **name-targeted** delete. Fresh ID
checks do not eliminate that name-reuse race, so cleanup due still returns
`generation_safe_delete_unverified`, **not an executable delete command**.
The older planner command arrays are review material, not controller approval.

## Read-only live inventory preflight

Unlike the proposal renderers, the inventory CLI performs **authenticated GET
requests**. It cannot create, delete or modify resources. Use the existing personal
Cloud Shell session and a short-lived token through stdin, never a token argument,
environment variable or saved credential file:

```sh
set -o pipefail
gcloud auth print-access-token \
  --account=YOUR_APPROVED_PERSONAL_EMAIL \
  --project=project-32bf49a2-bd30-4956-850 \
  --billing-project=project-32bf49a2-bd30-4956-850 |
  node ops/gcp-trial/collect-inventory.mjs --read-only --token-stdin \
    --expected-account=YOUR_APPROVED_PERSONAL_EMAIL
```

Do not enable shell tracing or credential/debug logging. The token is sent only
to Google's fixed UserInfo and Compute endpoints. Supply the same approved
personal email in both places; there is no default. The same token must identify
that exact verified email before any Compute request, and service-account emails
are refused. The CLI verifies identity, not whether an account is personally
owned: independently confirm the selected account first. No project, zone,
URL, HTTP method, impersonation or execution override is accepted.
Native HTTPS certificate verification must remain enabled.
Compute requests explicitly set the pinned quota project. UserInfo is an
identity lookup, not a project resource request, and receives no quota-project
header: the live preflight observed `USER_PROJECT_DENIED` with that header and
successful verified identity without it. No IAM or API-enablement change is
needed for that correction.

The collector fetches complete **unfiltered** zonal instance and disk page chains
in `us-central1-a`. Field projections retain only identities, timestamps, labels,
disk attachment/auto-delete information and disk users; startup metadata,
service-account configuration and disk encryption material are not requested.
Unexpected fields are rejected. IDs stay strings, redirects and API errors fail,
and the complete read is limited to 20 seconds, 20 pages per kind, 1,000 resources
per kind and 256 KiB. It never retries a partial read as if it were complete.

Output wraps the existing cleanup `inventory` envelope plus the observed account
and completion time. `inventory.observedAt` uses the oldest read's time, not a
fresh timestamp painted over earlier pages. It is an observation, not a globally
atomic snapshot, signed receipt, ownership record, cleanup proof or deployment
authorization. `cloudVerified: false`, `executionBlocked: true` and
`activationBlocked: true` remain set. All failures use sanitized diagnostics;
the credential is neither saved nor included in results. Output contains the
verified account email and resource details; do not commit live output publicly.

An empty inventory only means no matching zonal resources were observed. It
does not certify account-wide absence or remaining trial credit. Credit, billing
mode, effective network rules, quota, images, logging and watchdog readiness
must be checked separately before provisioning.

## Read-only ownership capture

This adapter reads an **already existing** creation operation, exact trial VM,
and same-name boot disk. It cannot provision or recover a missing trial. Supply
a regular, single-link JSON file of at most 32 KiB with exactly
`{ "plan": <original rendered plan>, "operationName": <original insert operation name> }`.
The original plan is reconstructed and validated before any network request;
altered commands/digests, future plans, and plans at or beyond `deleteAt` fail.
Do not substitute an unrelated operation or regenerate a plan to adopt a VM.

```sh
set -o pipefail
gcloud auth print-access-token --account="$TRIAL_ACCOUNT" \
  --project=project-32bf49a2-bd30-4956-850 \
  --billing-project=project-32bf49a2-bd30-4956-850 |
  node ops/gcp-trial/capture-ownership.mjs --read-only --token-stdin \
    --expected-account="$TRIAL_ACCOUNT" --input /absolute/path/plan-and-operation.json
```

The package entry point is `npm run gcp:trial:ownership -- <same flags>`.
Use the approved personal account, with no impersonation; keep shell tracing,
debug logging and disabled HTTPS verification off. The token comes only from
stdin and is never saved or returned. Verified exact-email UserInfo must succeed
before Compute, with no quota header on UserInfo. The only subsequent requests
are three fixed-project/zone **GETs**, each with the pinned Compute quota header:
[zonal operation](https://docs.cloud.google.com/compute/docs/reference/rest/v1/zoneOperations/get),
[instance](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/get),
and [boot disk](https://docs.cloud.google.com/compute/docs/reference/rest/v1/disks/get).
No URL, method, project, authentication or execution override is accepted.

Google defines operation names as server-defined, not instance RFC1035 names.
This CLI deliberately accepts only a bounded ASCII alphanumeric, hyphen and
underscore segment, starting with an alphanumeric character, at most 256
characters. That is a conservative local input constraint, not a claim about
all Google operation names. Paths, queries, fragments, percent escapes and
traversal are refused. There is no polling, retry, provisioning or deletion.

Narrow projections request only ownership identities, creation times, nonce
labels, operation status/target/error fields and disk attachment/users. Startup
metadata, credentials, disk keys/encryption material and logs are not requested.
Unexpected fields, warnings, errors, redirects, pending/non-insert operations,
scope/link mismatches, wrong uint64 generations, extra or missing disks, changed
nonce and attachments fail. Both resource creation times must be within the
original `issuedAt` through `createBefore` window and no later than the earliest
read. Capture itself may happen after that creation window, but before `deleteAt`.
The existing `captureOwnership` validator binds the plan digest, original nonce,
deadline and exact string-valued VM, disk and operation IDs.

The complete read is limited to 20 seconds and 256 KiB across all responses,
including identity. Clock rollback or completion at/after the deletion deadline
fails, with sanitized exit `2` and no partial result. Success exits `0` and wraps
the verified account, earliest `observedAt`, completion time and `handoff`.
Extract **only** `handoff`, an exact `{plan, ownership}` object, for the existing
log and cleanup-check CLI inputs; the enclosing observation has extra fields
and is intentionally not accepted by those CLIs. Keep all live output private.

Authenticated reads are not a globally atomic snapshot, signed evidence, a
safe-delete authorization or proof that the VM's runtime configuration/source
matches the proposal. Ownership does not verify machine type, network policy,
service accounts, guest bootstrap or source execution; configuration remains a
separate gate. `executionBlocked` and `activationBlocked` remain true;
`cloudVerified`, `releaseEvidenceEligible` and `evidenceAuthenticityVerified`
remain false. No billing, publication, watchdog, signing or release gate changes.

## Read-only cleanup check

`observe-cleanup.mjs` joins the authenticated inventory collector to the offline
ownership and deadline checks. It validates the original plan and captured
ownership before making any request, then fetches fresh, complete VM and disk
inventories. It evaluates the decision at completion, so crossing the deadline
during a read cannot return `waiting`. The inventory retains its oldest read
timestamp. Backward clock movement and reads exceeding 20 seconds fail.

The CLI accepts a regular, single-link JSON file of at most 32 KiB containing
exactly `{ "plan": <original plan>, "ownership": <captured record> }`. Use the
approved personal account, with no impersonation, as in the inventory example:

```sh
set -o pipefail
gcloud auth print-access-token --account="$TRIAL_ACCOUNT" \
  --project=project-32bf49a2-bd30-4956-850 \
  --billing-project=project-32bf49a2-bd30-4956-850 |
  node ops/gcp-trial/check-cleanup.mjs --read-only --token-stdin \
    --expected-account="$TRIAL_ACCOUNT" --reason=deadline \
    --input /absolute/path/trial-input.json
```

The package entry point is `npm run gcp:trial:cleanup-check -- <same flags>`.
Keep shell tracing/debug logging off and native HTTPS verification enabled.
Never save the token or pass it as an argument. The only network calls are the
existing fixed Google UserInfo and personal-project Compute **GET** requests.
There are no log reads, retries, deletion requests or executable command output.
The JSON summary omits the account email, raw inventory and token; resource IDs
and binding digests remain, so keep live output private.

| Exit | Meaning | Follow-up |
| --- | --- | --- |
| `0` | `absence_observed` in complete zonal inventory | Not a verified cleanup or billing receipt |
| `3` | `waiting`, before the original deadline | `nextCheckAt` is advisory, no check is scheduled |
| `4` | `blocked`, resources require operator attention | Inspect the decision reason; no deletion is authorized |
| `2` | Input, authentication, inventory or clock failure | State is unknown; investigate without extending the deadline |

`--reason=completed`, `failed`, `cancelled`, or `controller_failure` requests an
immediate decision before the deadline. Missing logs never postpone it.
`deadlineReached` and `overdueMs` use the original immutable `deleteAt`.
Remaining owned resources still report `generation_safe_delete_unverified`;
changed ownership or replacements report their existing blocking reasons.
An owned disk can remain a blocker after the VM disappears.

This is **one observation, not an independent cleanup controller or watchdog**.
No timer, scheduler, alert delivery, credential refresh or durable custody is
installed. `nextCheckAt` is not evidence that anything will run later, and the
read is not an atomic cloud snapshot. `executionBlocked` and `activationBlocked`
remain true; `cloudVerified`, `cleanupVerified`, `releaseEvidenceEligible`,
`evidenceAuthenticityVerified` and `independentControllerReady` remain false.

The [instance deletion reference](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/delete)
and [disk deletion reference](https://docs.cloud.google.com/compute/docs/reference/rest/v1/disks/delete)
describe resource names, without an expected-ID precondition. The discovery
contract supports numeric instance selectors, but that does not establish a
complete VM-and-disk cleanup guarantee. `requestId` deduplicates requests; it
does not bind a name-targeted request to a resource generation.
Provisioning stays blocked until an independently reviewed cleanup mechanism
and the remaining network, billing and trial preflights are in place.

## Immutable-ID cleanup protocol rehearsal

`cleanup-protocol.mjs` exports `rehearseTrialCleanup(planJson, ownershipJson,
{transport, readInventory, now, wait, reason, timeoutMs})`. This is an **offline
protocol kernel**, not a live deletion tool. It has no default network transport,
credentials, CLI, scheduler, or production caller. The existing read-only CLIs
and their blocked decisions are unchanged. Run its fixture tests with:

```sh
node --test ops/gcp-trial/test/cleanup-protocol.test.mjs
```

The required callbacks substitute the external I/O boundary:

- `readInventory({signal})` returns a bounded complete inventory JSON string in
  the existing format. Its oldest observation must be at or after this read's
  request time; reusing an earlier snapshot cannot prove post-delete absence.
- `transport({method, url, signal})` returns `{status, body}`, where `body` is an
  operation JSON string of at most 64 KiB. Fixtures receive exact-ID `DELETE`
  requests and fixed-scope operation `GET` requests. There are no headers or
  credentials in these descriptors. Connect only controlled fixtures today.
- `now()` supplies the clock; `wait(milliseconds, signal)` supplies polling
  delays. Defaults use the system clock and abortable timers, not network I/O.

The kernel validates original plan/ownership bindings, checks a complete fresh
inventory, and addresses only the captured decimal-string uint64 IDs. VM removal
precedes any orphan-disk removal. Every operation must match its resource ID,
type, scope and link, and retain the same operation ID and name across polls.
Each operation allows at most five GET polls. A 20-second timer bounds asynchronous
waits, including callbacks that ignore abort, provided they yield to the event
loop. It cannot interrupt synchronously blocking trusted code. Callers may
shorten but not extend the timer. Timeouts and ambiguous DELETE responses stop the sequence.
No resource-name fallback or second DELETE for the same resource occurs within
an invocation. A 404 still requires fresh full inventory. Remaining resources,
replacements, changed attachments, or incomplete observations cannot report
absence. A successful operation is not itself proof of absence.

Every result is marked `mode: rehearsal`, with execution/activation blocked and
cloud/cleanup/evidence verification false. These flags describe the absence of
a repository-provided live execution path; they do not sandbox injected code.
The caller and callbacks are trusted. The kernel has no durable attempt journal;
starting another invocation is **not** recovery from an indeterminate live delete.

### What remains before a live adapter

The official [Compute v1 discovery contract](https://www.googleapis.com/discovery/v1/apis/compute/v1/rest),
revision `20260922` inspected on 2026-10-08, explicitly allows the decimal-ID
alternative in `instances.delete.instance`. `disks.delete.disk` instead uses a
generic non-whitespace pattern; it does not establish exact-ID lookup semantics.
The [operation resource](https://docs.cloud.google.com/compute/docs/reference/rest/v1/zoneOperations)
defines `targetId` as identifying one resource incarnation. These facts support
the protocol design, not a claim that a live trial has passed.

Live activation still needs verified disk-ID DELETE semantics, protection
against concurrent changes to auto-delete attachments, checked live scheduling
and deletion-protection settings, authenticated transport and observations,
durable attempt custody/recovery, and an independent deadline controller.
Fresh inventory is not an atomic attachment lock. Google's
[runtime-limit documentation](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime)
also says stop/suspend clears the termination timestamp and automatic termination
can start late; the native timer alone cannot replace that controller. No
disposable-resource canary or cloud mutation is part of these fixture tests.

## Offline smoke-result read-back

`result.mjs` exports `parseTrialResult(planJson, ownershipJson, logsJson,
{nowMs, eventUntilMs})`. The optional event cutoff defaults to parsing time;
collectors freeze it at query start, while receive timestamps may extend to
parsing time. Supply the original plan, captured ownership record, and the JSON
array downloaded by the existing `renderEvidenceRead` command. It makes no
cloud calls, changes no resource and runs no guest code. Keep raw logs private.

The parser revalidates the plan and ownership digests, then checks **every**
record's exact project, zone, lossless VM ID and serial-port-1 log name. UTC
event timestamps must fall between plan issuance and the earlier of the
deadline or parsing time; nanoseconds are compared without rounding. A supplied
receive timestamp must be coherent and no later than parsing time. Retrieve
the same bounded event window after deletion when checking retention; a later
retrieval does not itself prove deletion or retention.

Input is capped at 1 MiB and 1,000 entries. Hitting the 1,000-entry query limit,
split entries, a missing/partial marker, or multiple markers returns
`incomplete`. Wrong resource identities, invalid timestamps, malformed input
and unsupported payload types fail with a sanitized error. There is no
best-effort fallback, silent deduplication or split-record reconstruction.
An extra `API_MIGRATOR` stem without a complete marker also makes the evidence
incomplete; shorter fragments are indistinguishable from ordinary boot text.

Exactly one compact `API_MIGRATOR_TRIAL_RESULT` marker is required, either bare
or following the console's `startup-script: ` prefix. Its fixed wrapper wire
format must match run, source revision/hash, profile, phase, exit code and
blocked activation. Unknown fields and duplicate JSON keys are refused.
Coherent output is labelled `reported_passed` or `reported_failed`, **not a
verified cloud result**. Only bounded enums/identity/digests leave the parser;
raw payloads do not. The SHA-256 binds the exact supplied log bytes, not their
authenticity or completeness. A caller can forge a JSON array or omit records;
authenticated collection with durable custody is still required for stronger
evidence. The bounded collector below covers the read, not durable custody.

`executionBlocked` and `activationBlocked` remain true. `cloudVerified`,
`evidenceAuthenticityVerified`, `cleanupVerified` and `releaseEvidenceEligible`
remain false even for a reported pass. The real local Docker bootstrap test
feeds its actual wrapper stdout through the parser with synthetic Logging
metadata; that is format compatibility only, not a VM/Logging integration test.
Unknown live serial formatting must be inspected and tested before accepting
it. Log availability or parser failure must never delay scheduled cleanup.

Format references: [Cloud Logging LogEntry](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry),
[serial port output](https://docs.cloud.google.com/compute/docs/troubleshooting/viewing-serial-port-output).

## Authenticated bounded log collection

`logs.mjs` exports `collectTrialLogs(planJson, ownershipJson, token,
{expectedAccount})`. The CLI accepts one regular, single-link JSON file of at
most 32 KiB, with exactly `{ "plan": <original plan>, "ownership": <captured record> }`.
Do not manufacture ownership records to claim a real trial was run.

Confirm that `TRIAL_ACCOUNT` is the approved personal email and that the
selected gcloud configuration has no impersonation. Then pipe that account's
short-lived access token to the collector. Never put it in a shell argument,
file, log, issue or PR:

```sh
set -o pipefail
gcloud auth print-access-token --account="$TRIAL_ACCOUNT" \
  --project=project-32bf49a2-bd30-4956-850 \
  --billing-project=project-32bf49a2-bd30-4956-850 |
  node ops/gcp-trial/collect-logs.mjs --read-only --token-stdin \
    --expected-account="$TRIAL_ACCOUNT" --input /absolute/path/trial-input.json
```

The collector validates the original plan and ownership binding before any
network request. UserInfo must confirm the exact expected verified email;
service-account identities are refused. As with the inventory collector, this
checks identity, not personal ownership of the supplied email. Keep native
HTTPS verification enabled and shell tracing/debug logging disabled.
Only then does it call Cloud Logging
for the fixed personal project, originating zone, lossless VM ID and serial
port 1. It uses the reviewed time-window filter without a marker-text filter,
so ordinary output, fragments and duplicate markers remain visible to the
parser. The event cutoff is fixed at the earlier of collection start or trial
deadline. Later ingestion is allowed only through collection completion.

Google's [`entries.list`](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list)
uses POST for a read. Requests use the fixed Google endpoint, explicit personal
quota project, no redirects or retries, and descending event order. Empty
pages with continuation tokens are followed; every other query parameter
stays fixed. Token loops, malformed responses, a 20-page cap, an unfinished
continuation at 1,000 entries, or a 1 MiB cumulative response budget fail
closed. Reaching exactly 1,000 entries without continuation is still incomplete
evidence. The read has a 20-second total deadline; token input has its own
10-second deadline. Neither wait may delay a separate cleanup controller.

Only a bounded summary is printed: query and raw-page SHA-256 digests, times,
entry count and the parser's `reported_*` or `incomplete` observation. Raw logs,
page tokens, credentials and the account email are not emitted or persisted.
The nested parser digest covers the assembled JSON entry array, not the raw
page bytes. These hashes are not signatures; the output can be forged after
collection and cannot independently prove completeness, retention or cleanup.
All existing authority flags remain blocked or false. Tests substitute the
external transport, not the CLI, file/credential readers, collector or parser;
live VM/Logging compatibility is not yet verified.

## Public runner image on managed Batch (non-authorizing)

Render the separate fixed image profile from the same eight-field request as
the engine profile:

```sh
npm run gcp:batch:image:prepare -- --input /absolute/path/batch-request.json
```

This command renders JSON only. It cannot submit a job, accept a custom command,
registry, repository, image, UID, service account or machine override. It retains
the personal-project/zone scope, one `e2-medium`, 30 GB `pd-standard`, one task,
zero retries and 1,800-second maximum. `prepareBatchImage` adds profile
`batch-public-image-phase-smoke-v1` and binds its generated script SHA-256;
`prepareBatch` and old prepared records retain engine-profile behavior.

The guest admits Debian 12 amd64/root and an already working local rootful
Docker/cgroup-v2 daemon. It does not install or replace Docker or Batch-agent
packages. Pinned Node and source downloads precede a lifecycle-disabled install
and package build as a fresh non-login UID with no socket access or credentials.
After killing that UID's remaining processes, it moves and seals the runtime
tree under root ownership. Root then builds only the reviewed public Dockerfile
and creates the synthetic public fixture. This trusted setup is not a customer
isolation boundary. A second dedicated non-root UID owns fixture data only.
Public fixture preparation runs in its own bounded process group; the controller
kills and observes that group before trusting its output, including on failure.

The controller proves root can read the nonsensitive metadata instance-ID
endpoint, then probes both metadata address families inside the exact image as
the fixture UID on host networking. It never requests a token. Metadata denial
rules stay installed even on failure, until the VM is destroyed. Prepare,
migrate and verify use `none`; install uses `host`. The controller retains
containers long enough to verify exact ID/image/UID/labels, removes only owned
containers and independently fetches their absence before deleting the workspace.
A killed CLI or failed cleanup never yields a passing summary.

One bounded canonical image summary binds image ID, ordered phase-state
digests, plan/evidence digests and output identity. The guest's indexed log
chunks and result marker are independently reconstructed by
`classifyBatchResult`; image success never accepts engine TAP. The summary is
explicitly self-attested, with `securityDrill:false`,
`releaseEvidenceEligible:false`, `activationBlocked:true`,
`externalSigningEligible:false` and `productionReady:false`. Its synthetic DNS
lifetime is protocol scaffolding: **not npm-only egress enforcement, live DNS
TTL evidence, a Debian gateway port, or rootless isolation**. The existing
Ubuntu/120-second-DNS-floor joined fixture and production gates are unchanged.

For a supervised live attempt, retain the immutable public source revision and
archive checksum, prepared job/script digest, accepted job UID, fetched terminal
job, complete digest-bound logs, and a separately fetched full-project inventory
of instances/disks/managed groups. Supervise queue and initialization as well as
execution; a task timeout does not bound those earlier stages. Fetch resource
absence independently after terminal state; guest workspace/container cleanup
is not VM/disk/MIG deletion proof. Do not delay cleanup to obtain logs. Missing
runtime capability is a failed preflight, not permission to change the host.

Tests distinguish controlled bootstrap behavior (substituted provisioning,
downloads, metadata, nft and Docker-build boundaries) from actual image builds
and four-phase local container runs. The latter substitute only unavailable GCE
root metadata reachability; neither establishes live GCE nft enforcement.
Hosted dispatch, forced registry gateway, rootless deployment, independent
observer/signing, protected source custody and publication remain separate gates.

## Not implemented yet

The mutation-capable cloud adapter, broader configuration preflight, independently running deadline watchdog,
durable authenticated custody, live log-collection verification and live cleanup
verification remain separate work. Prior to any
cloud execution, verify the personal account (no impersonation), source/runtime
and bootstrap hashes, image/guest environment, network policies, logging
retention, API/quota, and the approved cost/credit boundary. Cloud Logging,
external IP, disk, compute and network usage can incur charges. This module
neither estimates those charges nor guarantees free-credit coverage.

Production dispatch, independent observer/signing and publication remain
blocked. This proposal is not a dedicated-host drill or release evidence.

Sources: [VM lifetime semantics](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime),
[create flags](https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/create),
[IP connectivity](https://docs.cloud.google.com/compute/docs/ip-addresses),
[serial output and retention](https://docs.cloud.google.com/compute/docs/troubleshooting/viewing-serial-port-output),
[Cloud Logging reads](https://docs.cloud.google.com/sdk/gcloud/reference/logging/read),
[instance deletion](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/delete),
[disk deletion](https://docs.cloud.google.com/compute/docs/reference/rest/v1/disks/delete).
