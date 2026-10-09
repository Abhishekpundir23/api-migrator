# Managed Batch runtime: internal trial

## Outcome

Run the public API Migrator engine smoke in a disposable Google Cloud Batch job. The accepted job owns VM creation and teardown before any VM exists, replacing the operator-created VM followed by a separately armed cleanup workflow. This is an internal infrastructure milestone, not permission to run customer code or enable publication.

## Scope and constraints

- Personal project `project-32bf49a2-bd30-4956-850`, region `us-central1`, zone `us-central1-a` only.
- One task, one `e2-medium`, 30 GB standard boot disk, zero task retries, maximum task runtime 1,800 seconds. No GPUs, reservations, attached disks, secrets, public services, or billing upgrade.
- Dedicated custom VPC/subnet with no ingress allow rules; ephemeral external IPv4 for public dependency downloads. Do not alter the default network.
- Dedicated `api-migrator-batch-worker` account with only Batch agent reporting and log writing. Google-managed Batch service agent needs its documented project-level service-agent role. These are new permissions and require action-time confirmation before cloud setup.
- Public repository `Abhishekpundir23/api-migrator` at a full commit hash; SHA-256 checked source archive and Node 22.23.2 archive. Pinned dated Batch Debian 12 boot image. No arbitrary script input.
- Root performs trusted bootstrap only. Repository/npm execution uses a dedicated unprivileged account. Worker metadata HTTP access must be blocked before executing repository code; this is not a complete hostile-code isolation proof.
- Absolute startup deadline refuses stale queued work. Batch task timeout is not a queue deadline or financial cap. Initial runs remain supervised until terminal state and independent VM/disk absence are verified.
- Logs remain in Cloud Logging after VM deletion. Job status alone does not establish smoke success, complete log retention, exact VM identity, or absence of disks.
- Existing console/publication fail-closed gates stay unchanged.

## Deliverable

A strict job renderer and CLI, executable bootstrap tests, and a read-only outcome classifier. The classifier distinguishes smoke result, managed job status, and complete resource inventory; partial/mismatched observations must not produce success. Live setup/run is a separate authorized operation with recorded job UID and observed Compute IDs.

## Acceptance

Local tests cover rejected project/image/network/deadline/source inputs, fixed resource bounds, non-root execution, stale-start refusal, metadata denial, timeout/failure outcome handling, and incomplete or mismatched cleanup evidence. Full existing CI remains green. A live run is complete only after a matching successful smoke marker, Batch terminal state, retained logs, and independently read empty owned-resource inventory. A forced timeout is a separate check, not simulated success.

## Known remaining production work

Rootless hosted image adapter with forced gateway, independent trusted observation and signing, console dispatch, publication identity policy, and an explicitly authorized real pilot. Batch solves lifecycle ownership, not those isolation or authorization gates.
