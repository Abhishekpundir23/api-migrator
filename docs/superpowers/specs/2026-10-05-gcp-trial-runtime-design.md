# Disposable trial bootstrap and cleanup decisions

## Intent and authority

Continue the offline planner toward a reproducible personal-project GCP smoke
test without browser SSH. The user requested implementation without routine
approval questions; payment and live provisioning remain separate. This slice
ships an executable guest bootstrap artifact and an offline cleanup-decision
controller. It does not authenticate to GCP or execute any cloud commands.
PR #26 remains a dependency, not implicitly approved for merge by this work.

## Bootstrap

`prepareTrial(request, {nowMs})` accepts the planner request without
`startupScriptSha256`, generates deterministic Bash and returns `{plan, script}`.
The final plan binds the actual script SHA-256; no self-referential hash is
embedded inside the script. A render-only CLI accepts the same bounded regular
JSON input as the existing planner. No `--execute` option exists.

The guest is disposable Debian 12 amd64. Root only checks the environment,
installs OS prerequisites, downloads and verifies pinned Node 22.23.2, and
creates a dedicated non-login user. Public repository source is bound to an
immutable revision and archive hash. Source extraction, dependency installation,
engine build and engine tests run unprivileged with a cleared environment.
No GitHub token, service account, application secret, production service, Docker
daemon or publication capability is installed. npm lifecycle install scripts
are disabled. This is `engine-smoke-v1`, not the full runner/container drill.

All downloads require HTTPS, bounded duration/size and matching SHA-256 before
extraction. Work is bounded by the absolute deadline minus a cleanup reserve;
each child phase has a timeout and a forced-kill grace. A root-owned persistent
one-shot directory rejects repeat boots/runs. No restart extends the deadline.
Root emits one bounded terminal JSON marker with run/source identity, profile,
phase, exit code and status; test output is not an attestation. Child output is
kept separate from the root terminal marker. Abrupt kill/boot failure may leave
no marker and must be interpreted as incomplete, never success.

## Cleanup controller

Pure functions consume JSON strings, not caller-owned objects or credentials.
Plans are reconstructed with the original issuedAt and compared canonically,
including all commands and digest. No caller can replace a command while
retaining a valid digest or extend the deadline in a captured ownership record.

Ownership capture requires a completed error-free creation operation whose
targetId matches the observed VM; all uint64 IDs remain decimal strings. Bind
the exact personal project, zone, nonce, VM self-link, creation time, one boot
attachment with autoDelete, its disk self-link and independent disk ID.
Unknown additional attachments or different owners are never adopted.

Inventories are bounded complete unfiltered zonal page chains. Each envelope
binds project, zone, resource kind and observation time. Tokens must chain
exactly and finish with no nextPageToken; errors, missing pages, loops, stale or
future observations, duplicate IDs and malformed resources fail closed.

The decision is independent of log collection: before the deadline it can wait;
deadline, failure, cancellation or completion makes cleanup due. Missing logs
never extend the deadline. Same-name replacement and unexpected run-labelled
resources require attention, never opportunistic deletion. A lingering boot
disk is reported separately; attached disks are not detached or deleted.
Only complete fresh inventories with both captured IDs absent can report
`absence_observed`, with inventory digests, not a live or signed deletion claim.

GCP documents delete by name, without an expected-ID precondition. Fresh
describe/compare followed by delete still has a name-reuse race. Accordingly
this controller returns `generation_safe_delete_unverified` and resource
identities when cleanup is due, not executable mutation commands. A future
live adapter, independent watchdog, durable authenticated custody and approved
cost boundary are still required before provisioning.

## Verification

TDD covers bootstrap hash binding, unknown/unsafe inputs, syntax, expired and
wrong-host refusal, repeat-run refusal, checksum mismatch and unprivileged
execution in a disposable local container. Controller tests cover altered
plans, lossless IDs, operation errors, ownership mismatch, extra disks,
deadline/restart, cancellation/failure, orphan/attached disks, replacement,
stale/partial/error/paginated inventories and absence observations.
Run Node 22 focused tests, Docker-enabled full CI and independent branch review.
No cloud test or production readiness may be inferred from local tests.

## Primary references

- [Startup scripts](https://docs.cloud.google.com/compute/docs/instances/startup-scripts/linux)
- [VM deadlines](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime)
- [Instance deletion](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/delete)
- [Disk deletion](https://docs.cloud.google.com/compute/docs/reference/rest/v1/disks/delete)
- [Instance inventory](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/list)
- [Disk inventory](https://docs.cloud.google.com/compute/docs/reference/rest/v1/disks/list)
