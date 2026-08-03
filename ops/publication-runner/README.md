# Credential-free disposable preview runner

This directory contains an **operator primitive**, not a deployment, complete
trusted runner service, or signed-attestation proof. It executes the
pre-publication migration and verification phase only. It cannot mint a GitHub
token, publish a branch, create a pull request, or produce an owner
authorization envelope. External-source publication remains disabled until a
real control plane deploys this boundary, independently observes and signs its
evidence, and the remaining pilot gates pass.

The separation is intentional:

1. A trusted control plane creates and validates a canonical
   `PublicationRunnerPlan`.
2. `run-credential-free-preview.sh` runs a digest-pinned image as a dedicated
   non-root OS identity. A trusted, lifecycle-disabled dependency-fetch phase
   is the only online phase. The numeric-IP transport filter is then emptied;
   migration and all repository-controlled checks run with `--network=none`
   and read-only source.
3. The control plane independently observes the container set, nftables
   policy, output digests, and teardown. It signs the canonical attestation
   with a pinned Ed25519 key outside the job.
4. Only the verified signed payload digest may become
   `API_MIGRATOR_RUNNER_ATTESTATION_DIGEST` in the later owner challenge.

Raw wrapper events are not an attestation. A container cannot authorize itself,
and a matching sidecar digest proves consistency rather than execution.

## Required host profile

The wrapper refuses to run unless all of these are true:

- Linux with systemd and a transient disposable unit (`INVOCATION_ID` present);
- the wrapper is installed at one absolute canonical root-owned path and is
  executed directly through its `/bin/bash -p` shebang; invoking it through
  `bash`, `env`, a shell profile, or another interpreter is prohibited;
- the systemd launcher supplies an allowlisted environment before `execve`, a
  fixed system path, `WorkingDirectory=/`, `RuntimeMaxSec` no later than the
  plan deadline, and
  explicitly removes `BASH_ENV`, `ENV`, loader/library variables, language
  preload paths, proxy/credential variables, and container-engine overrides;
- the wrapper is the root control-plane process, while Podman runs as a
  dedicated, otherwise-idle non-root UID/GID with a dedicated owner-only
  preloaded storage root;
- rootless Podman, `nft`, `jq`, `setpriv`, Python 3, GNU coreutils, and `timeout`
  are installed;
- the digest-pinned runner image was preloaded into that UID's local Podman
  store by trusted provisioning (`--pull=never` is mandatory);
- the chosen rootless storage driver and absolute root-owned OCI runtime and
  `conmon` executables are pinned by trusted provisioning;
- the plan and source archive are root-owned, one-link, owner-only files; their
  output/evidence parents and runner storage root pass the documented ownership
  and permission checks;
- no proxy, GitHub, App, cloud, Git, Node preload, npm-user-config, Bash startup,
  dynamic-loader, language-preload, or remote-container variable is present;
- the control-plane job identity exactly matches the plan job identity.

`INVOCATION_ID` alone is not proof of a hardened transient unit. The deployer
must attest the unit definition, cgroup membership, subordinate-ID ranges,
`RuntimeMaxSec`, `KillMode=control-group`, and `ExecStopPost` cleanup. In
particular, hostile `LD_PRELOAD` can execute before any shell statement, so the
launcher—not this script—must remove startup and loader variables before the
kernel starts Bash. The wrapper independently changes to `/` before any Python
helper and invokes Python with isolated, no-site import resolution.

Ordinary Docker/Podman bridge or slirp networking is **not** accepted as egress
enforcement. During install, slirp is only transport: a host nftables output
chain matches the dedicated job UID and rejects every destination except the
plan's exact global-unicast TCP/443 set. DNS is not available inside the job;
the trusted control plane must resolve and bind the exact address set before
plan creation. Alternate ports, rebinding to another address, direct
non-allowlisted IPs, private/link-local/loopback ranges, and wildcard networks
therefore fail at the host policy.

That L3/L4 filter does **not** authenticate a hostname, TLS certificate, SNI,
or redirect target, especially when a registry uses shared CDN addresses. A
separately provisioned and independently attested L7 egress gateway must enforce
the exact `registry.npmjs.org` TLS origin and reject redirects. This wrapper
does not implement that gateway, so it must not be treated as satisfying the
external-source egress gate by itself.

Offline checks use both Podman's `--network=none` and an emptied nftables set.
The source/output mount is read-only for that phase; only runner tmpfs paths are
writable. Every Podman call uses a root-sealed per-job configuration and empty
automatic-mounts/hooks files, an explicit persistent storage root plus ephemeral
runroot, an allowlisted image configuration, no inherited image environment,
entrypoint, command, or volumes, `--image-volume=ignore`,
`--read-only-tmpfs=false`, and `--log-driver=none`. Attached output is the only
container log stream and is bounded inside the job tmpfs.

## Invocation

Run this only by direct absolute-path execution from the disposable systemd
control-plane unit. The following illustrates required values; it is not a
complete or attested unit definition:

```text
API_MIGRATOR_RUNNER_IMAGE=registry.example/runner@sha256:<64-hex> \
API_MIGRATOR_RUNNER_UID=<dedicated-uid> \
API_MIGRATOR_RUNNER_GID=<dedicated-gid> \
API_MIGRATOR_RUNNER_STORAGE_ROOT=/var/lib/api-migrator-job/storage \
API_MIGRATOR_RUNNER_STORAGE_DRIVER=overlay \
API_MIGRATOR_OCI_RUNTIME_PATH=/usr/bin/crun \
API_MIGRATOR_CONMON_PATH=/usr/bin/conmon \
API_MIGRATOR_CONTROL_PLANE_JOB_ID=previewjob_<64-hex> \
/usr/local/libexec/api-migrator/run-credential-free-preview.sh \
  /secure/plan.json \
  sha256:<plan-digest> \
  /secure/source.tar \
  /secure-output/job-result \
  /secure-evidence/job-events.ndjson
```

The plan and source archive are copied into a fresh root-owned, 1 GiB tmpfs
workspace that only the dedicated runner group can traverse. Staged immutable
inputs are readable only by root and that group; workspace inodes, phase logs,
and runner evidence are bounded. The output and raw event file must not already
exist, and their parents must be root-owned and non-writable by group/other.
The wrapper never accepts a free-form command. After the runner identity is
idle, output ownership is revoked to root, special/extended metadata is
rejected, modes are normalized, the tree is copied without ownership,
timestamps, links, ACL/xattr, or security-context preservation, and the sealed
tree is rescanned and content-compared. The bounded runner result is preserved
beside the event file as `<RAW_EVIDENCE_PATH>.runner.json` for independent
control-plane inspection.

The trusted runner image must implement these fixed entrypoints:

```text
/usr/local/bin/api-migrator-runner install --plan ... --source ... --dependencies ...
/usr/local/bin/api-migrator-runner migrate --plan ... --source ... --dependencies ... --output ...
/usr/local/bin/api-migrator-runner verify --plan ... --input ... --dependencies ... --result ...
```

`install` must be trusted image code that never invokes lifecycle scripts or
repository commands. Only it receives transport egress. `migrate` and `verify`
run offline. `verify` writes `runner-evidence.json` containing the observed
preflight, artifact, and candidate-tree identities. Those outputs do not exist
in the pre-run plan: the wrapper syntax-checks and preserves them, the control
plane independently recomputes them, and the owner reviews them before the
signed attestation is accepted against the explicit reviewed output.

## Teardown and failure semantics

`EXIT`, `INT`, `TERM`, and `HUP` trigger best-effort container removal, nftables
policy removal, evidence synchronization, and private-workspace deletion. The
wrapper reports only that Podman cleanup was requested and the dedicated UID was
observed idle; it does **not** claim that the unit cgroup, subordinate-UID
processes, or network namespaces were destroyed. SIGKILL, a blocked filesystem
operation, kernel failure, or host loss cannot be bounded or proven by a shell
trap/watchdog. The systemd unit must enforce `RuntimeMaxSec` and
`KillMode=control-group`, destroy the complete job boundary in
`ExecStopPost`/provider cleanup, and let an independent observer record that
outcome. It must not sign an attestation unless every teardown time and evidence
digest is independently present and ordered; raw wrapper events and retained
output from a failed cleanup are non-authorizing.

Publisher-token minting, token revocation, GitHub egress, and PR reconciliation
belong to a later, separately designed completion gate. Adding them to this
pre-publication attestation would create a circular owner-authorization digest.
