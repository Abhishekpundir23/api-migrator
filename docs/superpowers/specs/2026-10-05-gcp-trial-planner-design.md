# Offline GCP trial planner

## Intent and boundary

The next hosting milestone is a repeatable disposable Google Cloud smoke test
without relying on browser SSH. This first slice prepares a reviewable plan;
it does not provision a VM, run a bootstrap, capture live evidence, or authorize
production. The owner requested autonomous preparation but payment approval
remains separate. Professional projects must never be selected implicitly.

## Design

Add an import-safe planner and read-only CLI under `ops/gcp-trial/`. It accepts
an exact personal project ID, run nonce, immutable source revision/checksum,
versioned Debian 12 image, dedicated network/subnet names, explicit egress mode,
startup-script checksum, and absolute deletion time. All unknown fields fail.
The current allowed project is `project-32bf49a2-bd30-4956-850`; changing scope
requires review. No gcloud invocation, authentication, API enablement, network
creation, IAM mutation, or execution flag is supported.

Output is canonical JSON containing a bound intent, plan digest, command
argument arrays for review, and unmet execution gates. Each cloud command
specifies the project; zonal commands fix `us-central1-a`. Creation specifies
`e2-medium`, a 30 GB automatically deleted standard boot disk, no service
account/scopes, no automatic restart, and a fixed termination timestamp within
one hour. It never uses a relative duration that resets on restart. A plan
must have 15-60 minutes of remaining time and be regenerated before execution
if its five-minute creation window expires.

Only declared existing private NAT or an ephemeral external IP is supported.
Private Google Access is not general internet access. Dedicated network/subnet
names and omitted HTTP tags do not prove isolation: effective ingress-policy
review remains an unmet gate. The planner never creates NAT or firewall rules.

Per-instance serial logging is requested from creation; interactive serial
access is disabled. A second pure renderer prepares a bounded Cloud Logging
read command using the captured numeric instance ID and an explicit time
window, not the reusable VM name. Evidence is not considered retained until
downloaded, hashed, and retrieved again after deletion. Missing/truncated
terminal evidence or missing VM/disk deletion proof means incomplete.

## Explicit remaining work

The startup script itself, runtime preflight/controller, exact-ID cleanup
coordination, log/result parser, and supervised cloud trial are subsequent
slices. The `startup.sh` reference is not a shipped bootstrap and its supplied
hash is only a binding, not validation of its contents. The plan always reports
execution blocked and cannot satisfy runner capability, attestation, signing,
or publication contracts. No cost estimate or free-credit coverage is asserted.

## Verification

Tests must cover wrong/professional projects, mutable sources, unknown fields,
injection strings, expiry/bounds, explicit egress, exact command scope, runtime
and evidence bindings, and CLI refusal of execution flags. CLI execution with
an empty PATH must still render successfully: no cloud tool is needed/called.

## Sources checked 2026-10-05

- [VM time limits](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime)
- [Create flags](https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/create)
- [IP connectivity](https://docs.cloud.google.com/compute/docs/ip-addresses)
- [Serial output and logging](https://docs.cloud.google.com/compute/docs/troubleshooting/viewing-serial-port-output)

Automatic deletion can begin late and stopped VMs need explicit cleanup;
off-host deletion/read-back remains mandatory, never inferred from a timer.
