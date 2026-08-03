# GitHub permissions and repository controls

The pilot uses least-privilege, phase-specific GitHub App tokens. The product
does not implement merge and is never authorized to merge. Because GitHub write
permissions can be powerful, mandatory default-branch rulesets with no App
bypass are the technical enforcement boundary; documentation alone is not.

## App registration

| Repository permission | Registration access | Runtime use |
|---|---|---|
| Metadata | Read-only | Resolve repository and installation identity |
| Contents | Read and write | Read for private preview; create one migration branch only after approval |
| Pull requests | Read and write | Inspect and create/update the approved migration PR |

Do not grant Administration, Actions, Workflows, Issues, Checks, Deployments,
Secrets, Environments, Members, or organization permissions. Disable webhooks,
subscribe to no events, and do not enable OAuth or Device Flow.

The runtime rejects an App or installation whose identity, permissions, events,
suspension state, or selected-repository scope differs from policy.

## Installation scope

- Keep the current App private.
- Install with **Only select repositories**, choosing the exact authorized
  canonical slug and numeric repository ID and nothing else.
- Never select **All repositories**.
- Record App ID, installation ID, canonical slug, numeric repository ID,
  selected repository IDs returned for the token, exact token capabilities,
  evidence timestamp, and authorization reference outside Git.
- Do not make the App public to reach an external account. Public installation
  requires a separate onboarding, isolation, privacy, support, and incident
  design that is outside this pilot.

Public owner-authorized preview uses anonymous clone and no App. Private preview
requires explicit pre-run owner approval for the exact selected-repository App
installation and a read-only repository token with Contents, Metadata, and Pull
requests read. If a repository cannot use that path, private preview is
blocked. Publication is a later, separate gate.

## Token phases

1. Public preview metadata/clone uses no credential when possible.
2. A private preview may request a single-repository token with Contents read
   and Metadata and Pull requests read when the pre-run authorization expressly
   permits it.
3. A publish invocation has a separately evidenced single-repository read
   phase for repository discovery, clone, migration, and verification.
4. The unreleased candidate's sole write-token broker may then request a
   distinct single-repository token with Contents write, Pull requests write,
   and Metadata read only after successful verification, zero blockers,
   current evidence bindings, exact canonical Ed25519 owner-envelope
   verification, and durable one-use consumption in the externally anchored
   replay store. It rechecks live repository/base identity and owner
   revocation/time immediately before and after token minting. Operator
   approval and a post-run sidecar are not substitutes.
5. Each phase records policy observation, exact capabilities, issue/expiry,
   and revocation evidence. Tokens are not cached or placed in URLs/arguments.

The App private key remains outside the workspace in an owner-only regular,
non-symlink file or an approved secret manager.

The direct CLI and package-root API are preview-only and cannot enter step 4.
The local operator console is the candidate's only supported operator
publication route. It accepts one exact repository, consumes a one-use preview
receipt when it binds the exact owner-envelope bytes, and requires the resulting
one-use operator token plus typed confirmation. Its write-capable executor is an
explicitly internal console-integration subpath and must not be exposed or
invoked as a separate route. This operator control is separate from, and cannot
replace, the owner signature.

## Publication rulesets and CI evidence

These are not preview prerequisites for an anonymous public repository. Before
any sandbox publication drill, and again before any later external
publication, the repository operator configures them without granting the App
Administration permission:

- `codex/api-migrator/*`: active enforcement on that exact target; restrict
  creation, update, deletion, and force-push/non-fast-forward changes; the sole
  bypass is the exact migrator App integration ID in `always` mode.
- Default branch: active enforcement on the exact approved base ref; require a
  pull request, block deletion and force-push/non-fast-forward changes, require
  the exact authorized target-CI workflow/check/integration tuples, and allow
  no bypass actor.

Before publication, capture the canonical slug and numeric repository ID,
ruleset IDs, exact ruleset JSON/configuration digests, targets and bypass
actors, required-check and workflow identities, default branch/base SHA,
selected-repository evidence, and App identity. After the PR exists, CI
evidence must bind each run/check URL, conclusion, and observation time to the
same numeric repository ID and exact approved head SHA. Immediately before
merge, repeat the repository/head comparison and required-check observation.

## Prohibited actions

The pilot never uses App credentials to merge, write directly to the default
branch, modify workflow files, change rulesets, install itself elsewhere,
access another repository, approve reviews, bypass failed verification, or
perform organization administration.

All failed, skipped, or unresolved verification and review findings are
publication blockers; there is no override path. External-source write-token
minting and publication remain prohibited until owner challenge/signing
tooling, the disposable egress-filtered runner, current ruleset and required-CI
evidence, and the supervised sandbox drill are complete. The private App stays
installed only on the disposable sandbox. Dynamo, Toloka, and every designated
professional or client-work repository remain categorically excluded from App
access, clone, preview, and publication.
