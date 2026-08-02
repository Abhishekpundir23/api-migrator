# Supervised repository pilot runbook

This runbook governs one repository under one migration campaign. It is an
operational checklist, not legal advice. Stop the run whenever a required item
cannot be evidenced.

## Roles

- **Owner representative:** can authorize access to the exact repository and
  decides whether the migration pull request is accepted or merged.
- **Migration operator:** runs authorized preview operations and records
  evidence. The operator is not authorized to merge. On `v0.1.0-pilot`, the
  operator is also not authorized to publish external-source changes.
- **Technical reviewer:** reviews every changed file, manual-review item, and
  verification result. The operator and reviewer may be the same person only
  during the supervised internal pilot.

## Gate 1 — owner authorization

- [ ] A completed copy of `OWNER-AUTHORIZATION.template.md` is stored in
  restricted storage outside Git.
- [ ] The record names one exact `owner/repo`, GitHub numeric repository ID,
  base branch, campaign, authorization ID, approval evidence, and expiry.
- [ ] The owner representative is authorized to approve repository access.
- [ ] The pre-run record authorizes only screening, clone, isolated execution,
  and preview actions selected in the template. For a private preview, it must
  separately authorize installation of the private App on that one numeric
  repository ID and use of a repository-scoped read token. It does not
  authorize a write token or remote publication.
- [ ] Approved commands require no production secrets and have no destructive
  or external side effects.
- [ ] Retention, deletion, withdrawal, and incident contacts are complete.

No clone, App installation, or preview may begin before this gate passes.

## Gate 2 — technical eligibility

- [ ] The repository is a TypeScript/Node project with npm and a lockfile
  version supported by the verifier (`package-lock.json` or
  `npm-shrinkwrap.json`, lockfile version 2 or 3).
- [ ] The root `tsconfig.json` directly selects every provider-related or
  changed source file; unsupported solution-style project references are not
  present.
- [ ] The repository uses the supported Inngest v3 patterns and does not rely
  on an unimplemented migration rule.
- [ ] Install, type-check, test, and lint commands are known in advance.
- [ ] Required deployment checks are known. A runtime migration must include a
  target-specific image build and default-command smoke test in secret-free CI.
- [ ] The canonical repository slug, GitHub numeric repository ID, default
  branch, and exact starting SHA are recorded from current repository metadata.

An unsupported package manager, source layout, runtime container, or command
fails closed. Do not improvise a broader transform during a live pilot.

## Canonical evidence identifiers

Do not hand-enter or reconstruct evidence digests from reformatted content.

- `manifestJson` means the exact stored UTF-8 byte sequence used for the
  campaign manifest before parsing or reserialization. For a DB-backed
  campaign, it is the exact `campaigns.manifest` text value.
- `manifestDigest` is the lowercase hexadecimal SHA-256 of those exact
  `manifestJson` bytes. The trusted preview wrapper must export the storage
  reference, byte length, and digest into restricted evidence. The current
  built-in CLI does not export that value, which is one reason external
  publication remains blocked on `v0.1.0-pilot`.
- API Migrator canonical JSON v1 serializes arrays in their recorded order,
  serializes object keys in ascending JavaScript UTF-16 code-unit order, uses
  ordinary `JSON.stringify` string and primitive encoding, and emits no
  insignificant whitespace. Its digest is lowercase hexadecimal SHA-256 over
  the UTF-8 canonical JSON bytes.
- `commandScope` uses the fixed `api-migrator-engine-v0.1` profile and mirrors
  the engine path: `npm install --ignore-scripts --no-audit --no-fund` with
  approved-registry-only egress; config/provenance inspection followed by the
  installed TypeScript compiler invoked directly through pinned Node; the
  repository's `test` and `lint` package scripts with no network and read-only
  source; and the manifest-bound runtime-declaration attestation. It contains
  no free-form shell command. Its canonical digest must match runner evidence.
- Target CI is separate from the engine command scope. The authorized
  workflow, check name, and integration ID tuples have their own canonical set
  digest, which the post-preview approval, ruleset snapshot, and observed CI
  evidence must all match.
- `executionAttestationJson` is the exact UTF-8 JSON record exported by the
  trusted runner control plane. It binds the pilot and repository IDs, runner
  profile and image digest, command-scope digest, every check status/evidence
  reference, and observation time. `executionAttestationDigest` is SHA-256 of
  those exact bytes. The referenced trusted runner record is the provenance;
  a matching sidecar digest proves only integrity and consistency, not that a
  command actually ran.
- Preserve duplicate manual-review findings. Sort sanitized review entries by
  `file`, then `line` with `null` before integers, then `code`, then `message`,
  and assign identical tuples an `occurrence` starting at 1.
- `locationDigest` is the canonical digest of
  `{ file, line, occurrence }`; `messageDigest` is the SHA-256 of the exact
  sanitized UTF-8 message bytes.
- `findingId` is `finding_` followed by the canonical digest of
  `{ code, file, locationDigest, messageDigest }`.
- `findingsDigest` is the canonical digest of the complete finding objects
  sorted by `findingId`.
- A resolution object is
  `{ findingId, code, decision, reason, evidenceReference, evidenceDigest }`.
  `resolutionsDigest` is the canonical digest of the complete resolution
  objects sorted by `findingId`. `evidenceDigest` is the lowercase SHA-256 of
  the exact immutable evidence bytes named by `evidenceReference`.

The owner approval envelope must bind both set digests. A rule code alone is
not a finding identity, and a reference without a content digest is not proof
of the approved resolution.

Exact App permission/event snapshots and ruleset configuration snapshots use
their captured JSON byte strings and lowercase SHA-256 byte digests. The audit
validator recomputes those digests; it also checks the structured repository,
token, policy, and required-CI bindings rather than trusting a digest alone.

## Gate 3 — isolated execution

- [ ] External source will run only in a dedicated disposable runner, not the
  operator's everyday workstation.
- [ ] Installation egress is restricted to the approved package registries and
  destinations. Ordinary Docker bridge networking is not an egress control.
- [ ] The runner starts without GitHub App, database, cloud, production, or
  personal credentials in repository-controlled subprocesses.
- [ ] Repository tests, type-check, and lint execute without network access and
  with a read-only source mount.
- [ ] The trusted runner emits an immutable execution attestation after every
  recorded check; its evidence reference is independently retrievable.
- [ ] Runner logs, temporary disks, and cleanup behavior meet the authorized
  retention period.

The current local Docker verifier is useful engineering evidence but does not,
by itself, satisfy this external-source gate.

## Gate 4A — preview access

For a public repository:

- [ ] Preview uses anonymous, credential-free clone access.
- [ ] No App installation or GitHub token is configured for the run.

For a private repository:

- [ ] The pre-run owner authorization explicitly permits the private App to be
  installed with **Only select repositories** on the exact canonical slug and
  numeric repository ID.
- [ ] The App remains private and event-free, and preview requests only the
  single-repository Contents-read and Metadata-read capability.
- [ ] App ID, installation ID, canonical slug, numeric repository ID, token
  repository IDs/capabilities, and timestamp are captured in preview-access
  evidence. A boolean such as `selectedRepositoryOnly` is insufficient.

For both modes:

- [ ] The exact preview repository identity, base branch/SHA, engine
  tag/commit, manifest storage reference/digest, approved commands, runner
  template digest, and evidence timestamp are bound in one preview record.
- [ ] No write token is requested and no remote mutation is attempted.

The existing private App is not to be made public for an external account. A
public preview does not require an App. A private preview is blocked unless its
pre-run authorization expressly permits the exact selected-repository read
installation.

## Gate 4B — post-preview publication controls

This gate applies only after the owner reviews the exact sanitized preview.

- [ ] A separately signed owner approval envelope binds the authorization ID,
  pilot ID, approver and authority reference, canonical slug and numeric
  repository ID, base branch/SHA, engine tag/commit, manifest digest, preflight
  ID, artifact digest, candidate branch, `findingsDigest`,
  `resolutionsDigest`, authorized required-CI set digest, allowed publication
  actions, issue/expiry times, and a replay-resistant nonce.
- [ ] A trusted verifier authenticates the signature and approver, checks
  that approval occurred after preview completion, that both the pre-run
  authorization and envelope are currently unexpired, and that the nonce has
  not been replayed. It compares every envelope field with the current run in
  the same process immediately before write-token minting.
- [ ] App evidence separately records the publish invocation's read-access and
  write-access phases. Each binds App/installation IDs, canonical slug, numeric
  repository and selected-repository IDs, exact policy/event snapshots, token
  capability and permission bytes, observation/issue/expiry/revocation times,
  and evidence references. The read phase precedes migration execution; the
  write phase exists only after approval, ruleset observation, and verification.
- [ ] Migration-ref and default-branch evidence binds the same numeric
  repository ID, ruleset IDs, exact normalized ruleset JSON/configuration
  digests, active enforcement, exact target patterns, every restriction,
  required-check names, the sole allowed migration-ref App bypass, an empty
  default-branch bypass list, and evidence timestamp.
- [ ] Required-CI evidence binds the same numeric repository ID, exact
  workflow/check/integration tuples authorized by the owner, approved PR head
  SHA, run/check URLs, conclusions, and observation timestamp.

`v0.1.0-pilot` does not enforce the signed owner envelope before minting its
write token. Therefore Gate 4B cannot pass for external source, even when a
sidecar result validates. External publication remains disabled until that
enforcement and its adversarial tests are implemented.

## Phase 1 — preview

1. Confirm Gates 1–3 and Gate 4A, then record their evidence references and
   exact repository bindings.
2. Start a new disposable runner from the tagged engine baseline.
3. Run the non-publishing command:

   ```bash
   npm run migrate -- owner/repo
   ```

4. Record the canonical slug and numeric repository ID, exact base branch/SHA,
   engine tag/commit, exported manifest storage reference/byte length/digest,
   preflight ID, artifact digest, candidate branch, scanned and changed files,
   transforms, review items, blockers, and every verification check in a new
   preview evidence record.
5. Export the trusted runner attestation, preserve its exact bytes outside Git,
   and record its byte digest and evidence reference. A sidecar assembled by the
   operator is not a substitute for this runner record.
6. Confirm that preview created no remote branch, pull request, issue, comment,
   release, workflow change, or default-branch mutation.

`npm run pilot:validate` may audit a completed sidecar after the run. It neither
validates runtime authorization nor grants permission for a later action.

## Phase 2 — technical and owner review

1. Review every changed file and compare each edit with the provider-authored
   migration inventory.
2. Build an independent manual inventory of affected sites. A **site** is one
   unique provider-related call, constructor, serve/config occurrence, or
   dependency/runtime declaration covered by the migration inventory. Classify
   detected candidate sites as true or false positives, and record affected
   sites missing from the candidate set separately as known false negatives.
   The raw counts must satisfy `candidateSites = truePositives +
   falsePositives`.
3. Assign every manual-review occurrence its canonical `findingId`; resolve
   each occurrence separately and calculate the canonical finding- and
   resolution-set digests. A verification failure or skipped check is not
   overridable.
4. Show the sanitized preview and patch to the owner representative.
5. For future publication-capable versions, obtain the separately signed owner
   envelope described in Gate 4B. A general pre-run approval, rule-code list,
   sidecar record, or operator approval is not a substitute.
6. Record requested corrections and operator time separately from automatic
   execution time.
7. If any artifact, base SHA, manifest, branch, or decision changes, rerun preview and
   obtain approval for the new preflight.

## Phase 3 — publication

Do not run `--publish` against external source on `v0.1.0-pilot`. Its operator
approval and post-run sidecar validation are not an enforced owner signature in
the write-token path. The current publication command remains restricted to a
disposable sandbox owned and explicitly approved by the operator.

A future version may publish externally only after Gate 4B is enforced before
write-token minting. If manual-review findings are accepted, the envelope and
reasoned override must cover the exact finding/resolution-set digests; neither
may bypass failed or skipped verification. After publication, record the PR
URL, repository slug and numeric ID, content-addressed branch, approved head
SHA, base SHA, and required-check conclusions bound to that head. Do not merge.

## Phase 4 — owner-controlled merge decision

- [ ] The owner confirms the PR is still wanted.
- [ ] The PR repository slug and numeric repository ID equal the approved
  repository identity.
- [ ] The current PR head equals the approved head recorded by publication.
- [ ] The current base is the approved branch and has not invalidated the
  migration evidence.
- [ ] All required target CI and runtime checks are green.
- [ ] The owner, not API Migrator, performs or explicitly directs the merge.

Record the final disposition independently from the automated run:
`pending`, `accepted`, `changes_requested`, `rejected`, or `withdrawn`; and PR
state `not_opened`, `open`, `merged`, or `closed_unmerged`.

## Phase 5 — closeout

1. Record raw quality counts, review/correction time, owner-estimated manual
   migration time, feedback, and the final PR state.
2. Use an isolated per-pilot database and runner, then follow `REVOCATION.md`
   for repository access, tokens, branch/PR disposition,
   temporary storage, local records, logs, backups, and key handling.
3. Bind GitHub access, runner storage, pilot database, logs/exports/backups,
   and authorization/feedback to their exact authorization deadlines and
   deterministic per-pilot targets. Access may be removed after its final
   token use/revocation and the runner may be destroyed after its final run or
   publication action; neither waits for a later owner merge decision. Records
   needed for final disposition use the outcome observation as their lower
   bound. Supply per-location evidence by each authorized deadline.
4. Retain only the fields allowed by the authorization record. De-identify any
   aggregate metrics used for product decisions or sales evidence.

Cleanup status is `pending` while any location is unresolved. It is `complete`
only when every in-scope location is verified `deleted`. Use
`complete_with_exceptions` when every location is resolved but one or more is
owner-retained or unverifiable; record the authority, reason, and evidence for
each exception. Never label retained or unverifiable data as deleted.

Every sidecar records a trusted audit observation reference and digest. A
pending location is invalid once that audit time reaches its authorized
deadline; moving the sidecar's timestamp without corresponding trusted audit
evidence is not a valid closeout.

## Immediate stop conditions

Stop without publication when any of these occurs:

- authorization is missing, expired, withdrawn, or does not match the repo;
- the canonical slug or numeric repository ID differs across authorization,
  App, ruleset, CI, preview, or PR evidence;
- the App or token can access an unexpected repository;
- a secret or production credential is requested or observed;
- a command may mutate production data or call an external service;
- runner isolation or egress controls are unavailable;
- verification fails, is skipped, or produces unclassified output;
- an unresolved migration behavior is outside the supported inventory;
- the base, preflight, artifact, branch, or PR head identity drifts;
- required CI cannot validate the migrated application;
- external publication is requested on `v0.1.0-pilot`, or the signed owner
  envelope is missing, invalid, expired, replayed, or not enforced before
  write-token minting;
- the owner requests a pause or revocation.
