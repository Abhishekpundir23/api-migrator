# Repository pilot authorization — template

> Store completed copies in restricted pilot storage outside Git. Never commit
> owner identities, approval evidence, installation IDs, or contact details.
> This operational record is not legal advice.

## Identity and validity

- Authorization ID:
- Pilot ID:
- Approval evidence reference:
- Approved at (UTC):
- Expires at (UTC):
- Owner organization/account:
- Owner representative:
- Representative's authority to approve repository access:
- Migration operator:
- Incident/withdrawal contact:

## Exact repository scope

- Repository (`owner/repo`):
- GitHub numeric repository ID:
- Base branch:
- Campaign/provider:
- Transform set:
- Exact `manifestJson` storage reference:
- Exact `manifestJson` UTF-8 byte length:
- Manifest digest (lowercase SHA-256 of those exact bytes):
- Engine baseline/tag:
- Engine commit:
- Expected source SDK range:
- Expected target SDK range:

No authorization applies to another repository slug or numeric ID, fork,
organization, branch, campaign, or later engine/manifest version.

## Authorized actions

Check each action independently:

- [ ] Read public repository metadata for compatibility screening.
- [ ] Clone this public repository anonymously into disposable working storage.
- [ ] For a private preview only: install the private App with **Only select
  repositories** on the exact slug and numeric repository ID above, and mint a
  single-repository Contents-read/Metadata-read token.
- [ ] Install dependencies in the approved isolated runner.
- [ ] Use the fixed `api-migrator-engine-v0.1` command profile:
  - Install: `npm install --ignore-scripts --no-audit --no-fund`, with egress only
    to the registries approved below.
  - Trusted type-check: inspect configuration/compiler provenance, then invoke
    `./node_modules/typescript/bin/tsc` directly through pinned Node with
    `--noEmit`, no network, read-only source, and runner-temporary build info.
  - Test package-script name (no network; read-only source):
  - Lint package-script name (no network; read-only source):
  - Manifest runtime-declaration attestation/profile:
- Canonical `commandScope` record reference and digest:
- Trusted runner execution-attestation reference, exact-byte digest, and
  observation timestamp:
- Authorized target-CI workflow/check/integration-ID tuples and canonical set
  digest (target image/runtime checks are separate from command scope):
- [ ] Generate and share a non-publishing preview/patch.

Record the selected preview mode and evidence:

- Preview access mode (`public_anonymous` or `private_app_read`):
- App ID/installation ID, if private:
- App-selected numeric repository IDs, if private:
- Read-access policy/token/revocation evidence references and timestamps:

This pre-run section never authorizes a write token, migration branch, pull
request, or merge.

API Migrator is never authorized to merge, write directly to the default
branch, modify Actions/workflow files, administer repository settings, access
another repository, or run a command with production secrets.

## Command and environment confirmation

- [ ] Approved commands require no production credentials.
- [ ] Approved commands do not send email, charge money, deploy, publish,
  mutate production data, or call an external service with side effects.
- [ ] Required package registries and network destinations are listed:
- [ ] Disposable runner template/image digest and egress-policy evidence are
  listed:
- [ ] Required target CI checks are listed:
- [ ] Repository-specific hazards or forbidden paths are listed:

## Data handling and retention

- Authorized persistent evidence fields:
- GitHub App/repository-access removal deadline:
- Disposable runner and source-storage deletion deadline:
- Deletable pilot run-record deadline:
- Replay-store/anchor retention or explicit whole-unit decommission decision:
- Logs, exports, and backups deletion deadline:
- Authorization and feedback deletion deadline:
- Whether de-identified aggregate metrics may be retained:
- Additional owner restrictions:

Cleanup status is `pending` until every location is resolved, `complete` only
when every location is verified deleted, and `complete_with_exceptions` when
all locations are resolved but owner-retained or unverifiable data remains.
List the authority, target, reason, deadline, and evidence for every exception.

- [ ] The owner reviewed `DATA-HANDLING.md`.
- [ ] The owner reviewed `PERMISSIONS.md`.
- [ ] The owner reviewed the withdrawal and deletion process in
  `REVOCATION.md`.
- [ ] The owner understands that temporary-storage secure erasure and deletion
  from GitHub audit history cannot be guaranteed.

## Post-preview publication decision

This section records the inputs to the unreleased candidate's exact canonical
Ed25519 owner envelope. Complete it only after the owner has reviewed the
sanitized preview and patch. Do not hand-build or hand-edit the envelope:
owner challenge/signing tooling is still a release gate. A change to any bound
field requires a new preview and envelope.

The outer envelope contains exactly `version`, `keyId`, canonical unpadded
base64url `payload`, and `signature`. The payload contains exactly the runtime
fields below. Store the raw envelope only in restricted transient handling; do
not commit, log, echo, or place it in the sidecar.

- Envelope version (`1`) and unique `envelopeId`:
- Authorization ID and digest of this pre-run authorization:
- Pilot ID:
- Owner signer ID and key ID:
- Publication approval evidence digest:
- Exact preview completion time (Unix epoch milliseconds):
- Issued-at, not-before, envelope expiry, and authorization expiry (Unix epoch
  milliseconds):
- Replay-resistant nonce:
- Canonical repository slug, GitHub numeric repository ID, and numeric owner
  ID:
- GitHub App ID and installation ID:
- Base branch and exact base SHA:
- Engine tag and exact commit:
- Exact canonical manifest byte length and digest:
- Exact preflight ID and artifact digest:
- Candidate content-addressed branch and exact candidate tree SHA:
- Canonical empty findings and resolutions digests:
- Canonical command-scope digest:
- Trusted runner-attestation digest:
- Current ruleset-evidence digest:
- Authorized required-CI set digest:
- Exact allowed-action sequence:
- Existing pull-request number, or `null`:

Allowed actions are derived from the observed remote state, not selected
freely: create branch plus create pull request, create pull request for an
already matching immutable branch, or update the one already matching pull
request. A pull-request number is bound only for the update action.

- [ ] The owner key registry is an owner-only regular file outside the
  workspace and contains the exact Ed25519 public key, signer/repository scope,
  validity interval, fingerprint, and current key/authorization revocations.
- [ ] Approval occurred after the exact preview completed; this pre-run
  authorization and the envelope will both be unexpired at write-token
  minting.
- [ ] App evidence binds App ID, installation ID, exact slug, numeric owner and
  repository IDs, selected repository IDs, and separate read/write policy,
  token, capability, issue/expiry/revocation evidence.
- [ ] Ruleset evidence binds the same numeric repository ID, ruleset IDs,
  exact configuration digests, targets, bypass actors, and timestamp.
- [ ] Required-CI evidence binds the same numeric repository ID, required
  workflow/check/integration identities, approved head SHA, URLs, conclusions,
  and timestamp.
- [ ] The externally anchored replay store is explicitly initialized, and its
  stable store identity, owner-only anchor, and database/anchor backup unit are
  recorded outside Git.
- [ ] I understand that all failed, skipped, and unresolved verification or
  review findings block publication and cannot be overridden. Owner-requested
  corrections require a new preview and signed envelope.

The candidate verifies every signed binding, current key/authorization state,
repository/base state, time, and allowed action; durably consumes the one-use
authorization; and rechecks live state immediately before and after the sole
write-token broker mints a token. A safe consumption receipt contains digests
and identifiers only, never the raw payload or signature.

External-source publication remains disabled until owner challenge/signing
tooling, the disposable egress-filtered runner, current ruleset and required-CI
evidence, and a supervised sandbox publication drill are complete. Completing
this record does not waive those gates.

The approved head SHA is recorded after publication. Before any merge decision,
the owner must verify that the PR still belongs to the exact numeric repository
ID, the current PR head equals that recorded SHA, and all required CI checks
bound to that head are green.

## Approval and withdrawal

- Owner approval identity and timestamp:
- Operator acceptance identity and timestamp:
- Evidence-system record/reference:
- Trusted audit observation timestamp, evidence reference, and exact-byte
  digest:
- Withdrawal method:

Authorization may be withdrawn at any time. On withdrawal, the operator stops
new work immediately and follows `REVOCATION.md`; branch or PR changes occur
only on the owner's recorded direction.
