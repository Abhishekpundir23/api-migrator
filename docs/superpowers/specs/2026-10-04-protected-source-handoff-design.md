# Protected source handoff

## Outcome

Retain the exact canonical source bundle used to prepare a job and return it,
with the original durable plan, to a future server-owned dispatcher. Reopening
the service must not need the checkout, invent a new plan, or renew expiry.
This is a local input handoff, not execution, dispatch, review, or attestation.

The current producer discards the bundle after deriving its digest. Extend that
producer without rebuilding the source twice: an internal preparation operation
returns the committed winning job and its original bytes. The existing metadata
`prepare` operation retains its behavior.

## Interface and custody

Add optional server-only `handoffDirectory` to `RunnerJobConfig`. With no value,
existing metadata callers continue to work and handoff operations fail closed.
Add `prepareHandoff(input)` and `readHandoff(jobKey)` to `RunnerJobSession`.
Their successful value is `{ job, sourceBundle: Buffer }`, not a capability.
The caller receives detached bytes. No arbitrary archive, plan, URL, command,
evidence, or handoff-specific path/time override is accepted. Preparation still
uses the existing server-owned checkoutPath and absolute expiresAt inputs.

The job database is committed before retaining source. Source goes into a
separate, pre-existing dedicated 0700 directory, outside the checkout, migration
workspaces, temporary roots, and job database directory. The service adds the
configured job database directory to source-store exclusions, rejecting equal,
ancestor, descendant, and aliased overlap. Use the same protected
path policy as the job store. Store one 0600 `source.bundle` in a 0700 directory
named from the store ID and validated job ID. The canonical plan stays in the
job database, not a second mutable manifest. No source goes into SQLite.

Use a fresh private staging directory, exclusive file creation, file fsync,
and directory rename to publish a complete nonempty entry without replacing an
existing entry. Synchronize the directory before returning success. A duplicate
writer reads and compares the winner; differing bytes are a conflict. Validate
directory/file identities, ownership, modes, symlinks, hardlinks, and inventory
before and after I/O. Never chmod, overwrite, or silently repair unsafe data.

Limit a bundle to 8 MiB and an observed inventory to 100 directories / 64 MiB,
including abandoned staging directories. These conservative local pilot limits
are not a production quota or a disk-reservation guarantee across concurrent
processes. Recheck the inventory before returning; an overfull inventory refuses
handoff. No automatic pruning. Normal failures clean only their own staging
entry; process death may leave a bounded staging entry for operator inspection.
An incomplete stage is never readable as a job. A crash after job commit but
before source publication can be retried using the same clean checkout and
original job. A completed source entry works after service/process restart.

The assumed boundary remains an uncompromised control-plane OS account. File
permissions and hashes do not protect against that account, root, or coherent
snapshot rollback. Production principal separation is still required.

## Binding and time

On every handoff, read and validate the current durable job, enforce the store's
clock high-water mark and original expiry, parse the entire retained bundle,
and compare repository IDs, base branch/commit/tree, manifest digest, and archive
digest to the stored source and plan. Re-read the job and recheck time after I/O.
Handoff is only for revision 1 (`prepared`); a reviewed/completed job must not be
redispatched. A handoff is NOT a claim/lease or exactly-once execution protocol.

Oversized source must be refused before a new job is persisted. Dirty source,
changed intent, wrong job/store, corruption, missing source, unsafe paths, closed
sessions, expiry, or rollback return fixed existing job failure codes. Never
return source content or paths inside errors. No fallback to a preview report.

## Unchanged boundaries

`RUNNER_CAPABILITY_PROVIDER_AVAILABLE = false`; all three privileged console
actions remain blocked. No routes, UI, public CLI, credentials, GitHub App scope
changes, write-token requests, owner approval consumption, cloud resources,
spending, external transport, signing, or migration execution are added.
Dynamo, Toloka, Mindrift, professional and client assets remain excluded.
Reserved preview-v3 is not enabled. The runner image must not import storage.

## Verification and next dependency

Use real temporary protected directories, SQLite stores, canonical bundles,
and fresh processes. Prove byte identity; original plan/expiry on retry; recovery
without checkout; missing/altered/link-replaced/unsafe files; overfull/oversized
refusal; source/job interruption recovery; concurrent duplicate publication;
revision/time refusal; detached outputs; and unchanged console/image isolation.
Run Node 22 focused tests and the full existing CI with Docker enabled.

Live dispatch still requires an approved execution environment, repository
allowlist, authenticated private transport, independent output review and
observer/signer custody, Linux lifecycle drill, and fresh evidence acquisition
at approval and token boundaries. This change does not satisfy those gates.
