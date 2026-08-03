# Pilot revocation and offboarding

Revocation may be requested by the owner representative or initiated by the
operator after a scope, credential, security, or execution incident.

## Immediate actions

1. Block new work, then terminate the entire per-pilot disposable runner/job.
   The current in-process queue has no durable remote cancellation guarantee;
   do not treat a UI state change as proof that execution stopped.
2. Revoke any current installation token on a best-effort basis.
3. Remove the repository from the App installation or uninstall the App as the
   owner directs.
4. Disable operator access to the pilot record and rotate credentials when
   compromise is suspected.
5. Preserve only the minimum incident evidence authorized for investigation.

Do not delete or modify a branch, pull request, comment, or other GitHub audit
artifact unless the owner gives recorded direction. Closing a PR and deleting
a branch are separate decisions.

## Data cleanup

Use the authorization record to identify every exact in-scope location:

- disposable source and verification storage;
- deletable run records in the isolated pilot database, or the entire matched
  replay-store/database and external-anchor unit only under an explicit owner
  security decision (never a shared database and never individual replay rows);
- logs, reports, exports, and temporary files;
- backups and synced copies;
- completed authorization and feedback records;
- pilot-specific credentials. A shared App private key is rotated or deleted
  only for suspected compromise or an explicitly approved App-wide shutdown.

The owner-authorization consumption ledger has no ordinary deletion path and
survives database reset. Never delete, replace, move, or recreate its external
anchor as routine offboarding. Loss or deliberate whole-unit decommission is a
security event because prior one-use consumption can no longer be proven.

Resolve and validate every target before deletion. Do not use globs, unresolved
environment variables, broad recursive targets, workspace roots, home
directories, or a shared database. Record a per-location dry-run inventory,
the exact action, time, operator, and result. Delete by the authorized deadline
and state any system where deletion cannot be independently verified. Verify
that the entire disposable runner and its temporary disks were destroyed; a
cleanup callback alone is not proof. Do not claim secure erasure from GitHub
history, caches, backups, or reused temporary storage.

## Branch and PR disposition

Record one owner instruction:

- leave open for review;
- close without merge and retain the branch;
- close without merge, after which the repository owner deletes the branch
  through GitHub if desired;
- use a separately implemented and audited exact-ref deletion procedure only
  when a new signed owner instruction binds the numeric repository ID, full
  ref, expected head SHA, action, and expiry. The unreleased
  owner-authorization candidate has no such procedure;
- owner merges after current-head and CI verification;
- no branch or PR was created.

The operator verifies the resulting PR state and ref identity. API Migrator
never merges as part of offboarding.

The confirmation status is `pending` while any location is unresolved. It is
`complete` only when every in-scope location is verified `deleted`. Use
`complete_with_exceptions` when all locations are resolved but owner-authorized
retention or an unverifiable third-party copy remains; record each exception
and never describe it as deletion.

## Credential incident

If the App private key may be exposed:

1. suspend or remove installations as appropriate;
2. revoke/delete the affected private key in GitHub;
3. rotate local operator and approval secrets that may share the incident;
4. inspect audit evidence for repositories and refs accessed;
5. notify affected owner contacts with known scope and remediation;
6. resume only with a new key and a fresh installation-policy attestation.

## Confirmation record

Store outside Git:

- authorization and pilot IDs;
- revocation requester and evidence reference;
- stop time;
- token/App action;
- branch/PR instruction and observed result;
- each data location and deletion result;
- replay-store and external-anchor retention or whole-unit decommission result;
- credential rotations;
- unresolved third-party retention;
- owner confirmation reference and completion time.
