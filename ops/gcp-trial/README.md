# Offline GCP trial planning

This is a **proposal renderer**, not a deployment command. It makes no network
calls and never invokes `gcloud`. It cannot create, approve, or delete resources,
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
are not post-deletion retention proof. Download and hash evidence before
deletion, then verify it remains retrievable afterward.

## Not implemented yet

The bootstrap script, live preflight/controller, strict result/evidence parser,
and exact-ID cleanup verification remain separate work. No `startup.sh` ships
in this directory; its supplied hash is only a proposed binding. Prior to any
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
[Cloud Logging reads](https://docs.cloud.google.com/sdk/gcloud/reference/logging/read).
