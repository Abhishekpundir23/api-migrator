# Offline GCP trial planning

The local CLIs are **proposal renderers**, not deployment commands. They make
no network calls and never invoke `gcloud`. They cannot create, approve, or delete resources,
authorize payment, or enable production. `--execute` and unknown flags fail.

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
Google documents name-based deletion without an expected-ID precondition.
Fresh ID checks do not eliminate name-reuse races, so cleanup due returns
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

## Not implemented yet

The mutation-capable cloud adapter, broader configuration preflight, independently running deadline watchdog,
durable authenticated custody, strict result/evidence parser and live cleanup
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
