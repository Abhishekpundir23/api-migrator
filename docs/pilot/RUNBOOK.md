# Supervised repository pilot runbook

This runbook governs one repository under one migration campaign. It is an
operational checklist, not legal advice. Stop the run whenever a required item
cannot be evidenced.

## Roles

- **Owner representative:** can authorize access to the exact repository and
  decides whether the migration pull request is accepted or merged.
- **Migration operator:** runs authorized preview operations and records
  evidence. The operator is not authorized to merge. External-source
  publication remains disabled while the unreleased candidate's operational
  release gates are incomplete.
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
Dynamo, Toloka, and every repository designated as professional or client work
are excluded regardless of any other evidence or authorization record.

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

- `manifestJson` means the canonical JSON emitted after the stored campaign
  manifest is parsed, the one explicitly supported legacy runtime declaration
  is upgraded, and the result is validated. The same canonical bytes are passed
  to preview/publication and used by the console approval digest.
- `manifestDigest` is the lowercase hexadecimal SHA-256 of those exact
  canonical `manifestJson` bytes. The trusted preview wrapper must export the
  storage reference, byte length, and digest into restricted evidence. Do not
  hash the legacy database text or a separately reformatted representation.
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
- `resolutionsDigest` is the canonical digest of an empty array. The current
  candidate accepts no resolution or acknowledgement that bypasses a finding.
  An eligible publication therefore has no manual-review findings; apply a
  correction and rerun preview instead.

The owner approval envelope binds both set digests. A rule code alone is not a
finding identity, and neither an operator nor an owner approval can override a
finding.

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

The [publication-runner contract and Linux wrapper](../../ops/publication-runner/README.md)
are reviewable primitives for this gate. They are not a deployed runner and do
not prove that a signed attestation was independently observed or issued. Its
numeric-IP nftables filter also requires a separately deployed L7 gateway to
enforce the registry TLS hostname, certificate, and redirect policy.
External-source publication remains disabled until those controls and the
other Gate 4B prerequisites are evidenced in the supervised drill.

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

- [ ] The console's read-only challenge action reruns the exact candidate with
  the selected-repository App read identity, verifies the unconsumed preview
  receipt, current base, immutable migration branch/PR state, candidate tree,
  and every runtime evidence binding, then emits canonical challenge bytes and
  a digest plus an opaque HMAC receipt that binds that digest to the exact
  preview, without requesting a write token or mutating GitHub.
- [ ] The owner reviews the challenge's numeric repository/App identities,
  base, candidate tree, action sequence, and evidence digests outside the
  operator process. The offline signer requires explicit approval of that exact
  challenge digest and uses only owner-only, non-symlinked files outside the
  workspace. It creates a new `0600` envelope file and never prints raw key,
  payload, signature, or envelope bytes.
- [ ] A separately signed owner approval envelope binds the authorization ID,
  pilot ID, signer/key IDs, approval and pre-run authorization digests, the
  exact server-issued owner-challenge digest,
  canonical slug and numeric owner/repository IDs, App/installation IDs, base
  branch/SHA, engine tag/commit, canonical manifest byte length/digest,
  preflight ID, artifact digest, candidate branch/tree, canonical empty
  findings and resolutions digests, command-scope, runner-attestation, ruleset and
  required-CI digests, exact remote-state-derived allowed actions and PR
  number, preview/issue/validity/expiry times, and a replay-resistant nonce.
- [ ] A trusted verifier authenticates the signature and approver, checks
  that approval occurred after preview completion, that both the pre-run
  authorization and envelope are currently unexpired, and that the nonce has
  not been replayed. It compares every envelope field with the current run,
  re-reads key and authorization revocation state, and durably consumes the
  authorization in the externally anchored replay store before the sole
  write-token broker can mint a token. Live repository/base and owner state are
  rechecked immediately before and after minting.
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

The unreleased candidate enforces this challenge/signature boundary before
write-token minting, and its direct migration CLI is preview-only. Gate 4B still
cannot pass for external source until the disposable egress-filtered runner is
independently provisioned and attested, current ruleset and required-CI evidence
are validated, and the supervised sandbox publication drill is complete. A
validating sidecar cannot replace any of these controls.

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
3. Assign every manual-review occurrence its canonical `findingId` and record
   the finding-set digest. Every occurrence is a blocker: correct it and rerun
   preview until the finding list is empty. The resolution-set digest remains
   the canonical digest of an empty array. Failed or skipped checks are equally
   non-overrideable.
4. Show the sanitized preview and patch to the owner representative.
5. Stop after preview in the current build. **Generate owner challenge** is
   disabled until the verified runner-capability provider is deployed, so no
   challenge can currently be downloaded. After that separate gate is reviewed
   and enabled, use it to rerun and bind the exact preview, preserve the
   canonical challenge outside Git with owner-only permissions, and compare its
   displayed digest with the downloaded bytes.
6. For the candidate sandbox drill, use `npm run owner:sign -- ...` with
   `--approve-challenge-digest` equal to the independently reviewed digest to
   create the separately signed envelope described in Gate 4B. Do not
   hand-assemble it. A general pre-run approval, rule-code list, sidecar record,
   or operator approval is not a substitute.
7. Record requested corrections and operator time separately from automatic
   execution time.
8. If any artifact, base SHA, manifest, branch, or decision changes, rerun preview and
   obtain approval for the new preflight.

## Phase 3 — publication

The direct CLI and package-root API have no publication mode. The CLI rejects
publication or override flags. The local operator console is the only supported
operator publication route and remains restricted to the disposable sandbox
until every external release gate passes. Its write-capable executor is an
explicitly internal console-integration subpath, not an alternate ceremony; do
not expose or invoke it directly.

The following supervised sandbox drill is a future procedure and is not
currently executable: the console fails closed before challenge generation
because the verified runner-capability provider is absent.

After that gate is implemented and separately reviewed:

1. Run console preview for exactly one repository and review the candidate
   tree, report, and zero-blocker result.
2. Generate the read-only owner challenge, review its exact digest and summary,
   sign it offline, and attach the new envelope file without printing or
   hand-editing its bytes. The opaque challenge receipt does not extend the
   original ten-minute preview deadline; this drill is limited to small
   repositories whose reruns and human signing step fit inside that window.
   Expiry requires a completely new preview.
3. Preparing publication requires the opaque challenge receipt, first reruns
   the exact candidate with GitHub App read identity, and verifies the
   owner-signed challenge digest and every fresh live binding without consuming
   either receipt. Only after that succeeds does it consume the short-lived
   preview receipt and bind the challenge digest plus SHA-256 digest of those
   exact envelope bytes into a one-use operator token and typed confirmation
   phrase. Rejected or cross-preview material leaves the preview receipt unused.
4. Submit the unchanged envelope bytes, token, and phrase. The runtime verifies
   both operator control and owner authorization, consumes the owner envelope
   in the durable externally anchored replay store, then permits the sole
   write-token broker to act only on the exact observed remote state.
5. Record the safe owner-authorization receipt, PR URL, repository slug and
   numeric ID, content-addressed branch, candidate tree, approved head SHA,
   base SHA, and required-check conclusions bound to that head. Never record
   or echo the raw envelope, payload, signature, or private key.

Every failed, skipped, or unresolved verification or review finding blocks
publication. There is no operator or owner override. Apply corrections, rerun
preview, and obtain a new signed envelope. Do not merge.

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
2. Use an isolated per-pilot database/replay anchor and runner, then follow
   `REVOCATION.md` for repository access, tokens, branch/PR disposition,
   temporary storage, local records, logs, backups, and key handling.
3. Bind GitHub access, runner storage, deletable run records or explicit
   whole-store decommission, logs/exports/backups, and authorization/feedback
   to their exact authorization deadlines and deterministic per-pilot targets.
   Preserve replay consumption evidence and its anchor as a matched security
   unit unless an explicit owner decision decommissions the whole unit. Access
   may be removed after its final
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
- the repository is Dynamo, Toloka, or designated professional/client work;
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
- external publication is requested before every release gate passes, or the
  signed owner envelope is missing, invalid, expired, replayed, mismatched, or
  cannot be durably consumed before write-token minting;
- the owner requests a pause or revocation.
