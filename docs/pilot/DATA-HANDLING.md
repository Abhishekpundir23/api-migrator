# Pilot data handling

This document describes the current implementation and the additional
operational controls required for supervised repository pilots. It does not
claim multi-tenant or public-service readiness.

## Data inventory

| Data | Location | Persistence | Control |
|---|---|---:|---|
| Full repository source | Disposable working directory; writable during dependency installation, then mounted read-only for no-network checks | Transient | Attempt cleanup when the run finishes or stops; verify whole-runner teardown |
| Git metadata needed for cloning | Disposable clone only | Transient | The verifier receives a Git-free copy |
| File paths and structured diagnostics | Sanitized migration report / local SQLite | Persistent until authorized deletion | Bounded and redacted; raw subprocess output is discarded |
| Exact `manifestJson` bytes, byte length, storage reference, and digest | Restricted campaign/pilot evidence | Persistent until authorized deletion | Never reconstruct the digest from reformatted JSON |
| Canonical command scope and trusted runner execution attestation | Restricted runner/pilot evidence | Persistent until authorized deletion | Fixed safe profile; bind exact bytes, digest, pilot/repository identity, image, checks, and observation time |
| Repository slug, branch, SHAs, preflight ID, artifact digest, PR URL | Local SQLite and GitHub PR audit text | Persistent until authorized deletion; GitHub follows owner policy | Required for provenance and review |
| Operator decision and override reason | Local SQLite / PR audit text | Persistent until authorized deletion | Named, bounded, and sanitized |
| Completed owner authorization and feedback | Restricted pilot record store outside Git | Per authorization record | Never commit to this repository |
| GitHub App private key | Owner-only path or secret manager outside workspace | Until rotation/revocation | Never expose to repository processes or reports |
| Read/write installation-token phases | Process memory and temporary Git askpass environments | Temporary | Separate one-repository capabilities; independently evidenced and revoked on best-effort cleanup; never cached |

The application database does not store full source bytes. It does store enough
repository identity and migration evidence to be customer-confidential.

Every repository-scoped evidence record must include the canonical slug and
GitHub numeric repository ID. App, installation, ruleset, CI, preview, PR, and
owner-approval evidence that omits or disagrees on that identity is invalid.

## Execution boundary

- Dependency installation uses lifecycle scripts disabled and rejects custom
  registry configuration and unsupported lock sources.
- Installation currently has ordinary Docker bridge networking. This is not
  network-level egress filtering.
- Type-check, test, and lint run with no network, a read-only repository mount,
  resource limits, isolated temporary storage, and no App/database secrets.
- Repository Dockerfiles are not executed by the local verifier. Required image
  builds belong in a disposable, secret-free target CI job.
- External source must run in a dedicated disposable, egress-filtered runner;
  owner approval does not make arbitrary code trustworthy.

## Persistent records

SQLite may contain repository slugs, paths, structured diagnostics, run status,
branch and PR URLs, SHAs, blockers, operator identity, and override reasons. It
is local pilot storage, not a tenant-isolated service.

For every pilot:

1. Configure a separate `API_MIGRATOR_DB_PATH` for the exact pilot in restricted
   storage outside the workspace. Do not reuse or delete a shared database.
2. Record the exact database, runner, log, export, backup, authorization, and
   feedback targets plus their access lists outside Git.
3. Set separate deletion deadlines for GitHub access, runner storage, the
   pilot database, logs/exports/backups, and authorization/feedback in the
   authorization record. A blank deadline blocks the run.
4. Do not copy raw command output, secrets, source excerpts, or unnecessary
   owner personal data into metrics or feedback records.
5. Keep backups and exported reports within the same retention and deletion
   scope as the primary record.
6. Record normal cleanup and whole-runner teardown separately. A crashed or
   lost runner is not proof that transient data was deleted.
7. Record deletion completion and any systems where deletion cannot be
   independently verified.
8. Record the trusted closeout-audit observation outside Git. Pending cleanup
   cannot remain valid at or after its per-location authorization deadline.

Use cleanup status `pending` while any target is unresolved. Use `complete`
only when every in-scope target is verified `deleted`. Use
`complete_with_exceptions` when all targets are resolved but at least one is
owner-retained or unverifiable, and bind every exception to its authority and
authority digest, reason, deterministic target, authorization deadline,
timestamp, evidence reference, and evidence digest. Never report retained or
unverifiable data as deleted.

Aggregated metrics may be retained only when the owner authorized it and the
data is de-identified. Preserve raw counts and durations; do not publish owner,
repository, code, or PR identity without separate permission.

## Deletion and withdrawal

Follow `REVOCATION.md`. Deletion covers disposable source, local database rows
or isolated pilot database, logs, exports, backups, authorization records, and
feedback. GitHub branches, pull requests, audit logs, caches, and backups are
controlled by GitHub and the repository owner; do not promise secure erasure.

## Incident handling

Stop work and notify the recorded owner contact when source, credentials, or
repository access crosses the authorized boundary; when a secret appears in
output; or when a repository command has an unexpected external side effect.
Preserve only the minimum evidence needed to investigate, rotate affected keys,
remove App access, and document the scope and remediation.

## Current limitations

- no hosted tenant isolation or encrypted customer record service;
- no enforced per-customer retention or purge job;
- no durable public onboarding, support, or incident-response system;
- no network egress enforcement in the local Docker installation phase;
- best-effort token revocation rather than proof that every copy was erased;
- no guarantee of secure erasure from temporary disks or third-party systems.

These limits prohibit public App expansion. They do not override the exact
authorization, selected-repository, disposable-runner, or stop conditions in
the runbook.

The sidecar result validator is a post-run audit aid and is not invoked before
GitHub write-token minting. External-source publication remains blocked on
`v0.1.0-pilot` until separately signed owner approval is validated and bound to
the current run before any write capability is issued.
