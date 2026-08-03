# Owner-authorization replay store

Publishing is disabled until the replay store has an external activation anchor.
The anchor is security state: it must live in a durable, owner-controlled directory
outside the SQLite database directory and outside ordinary application cleanup.

Provision once, from a single operator process while other instances are stopped:

1. Choose a stable 16-128 character `API_MIGRATOR_REPLAY_STORE_ID`.
2. Create a separate persistent directory owned by the service account, mode
   `0700`. Do not place it under the database directory.
3. Set `API_MIGRATOR_REPLAY_ANCHOR_PATH` to an absolute, previously unused file
   path in that directory.
4. Ensure `API_MIGRATOR_DB_PATH` points to the intended persistent database.
   The database file and its directory must be owned by the service account,
   must not be group/world-writable, and the database must not be hard-linked.
5. Run:

   ```sh
   npm run init:owner-store --workspace @api-migrator/db -- --activate
   ```

Initialization creates the anchor atomically with mode `0600`, syncs it to disk,
and binds its path, inode, digest, store ID, and the physical database identity in
SQLite. The store uses SQLite's `DELETE` journal with `synchronous=FULL` and syncs
the main database file before an activation or replay-consumption call reports
success; security state is never allowed to exist only in a removable WAL file.
Normal migration does not activate publication.

Never delete, replace, copy, move, or roll back the anchor or database. Never
change the configured anchor path or store ID. A backup is incident-recovery
material, not a safe way to rewind the live store: restoring an older pair could
erase proof of a consumed authorization. Keep the live anchor outside the
database cleanup domain and require an explicit owner security decision for any
restore or reprovisioning operation.

If the database is missing or replaced while the anchor remains, initialization
fails closed. If the anchor is missing, has weak permissions, or no longer matches
the database, or if the database/file-directory ownership or write permissions
become unsafe, consumption fails closed. Restore the original matched pair; do
not create a new anchor merely to clear the error. Deliberate reprovisioning
after loss of either component is a security incident and requires an explicit
owner decision because prior one-use authorizations can no longer be proven
consumed.
