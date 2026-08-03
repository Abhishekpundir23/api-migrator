# GitHub authentication and safe publication

The app has two explicit authentication modes. There is no automatic fallback between them.

- `github-app` is required in production and is the correct mode for customer repositories.
- `gh-cli` is available only for local pilot work on repositories you control.

Set exactly one mode:

```dotenv
API_MIGRATOR_AUTH_MODE=github-app
```

or, for a local pilot only:

```dotenv
API_MIGRATOR_AUTH_MODE=gh-cli
```

`gh-cli` is rejected when `NODE_ENV=production`. Partial GitHub App configuration is also rejected; it never silently falls back to a broader local token.

## Create the GitHub App

Create an App at `https://github.com/settings/apps/new` (or in the corresponding organization settings) with only these repository permissions:

| Permission | Access | Purpose |
|---|---|---|
| Contents | Read and write | Clone and push a migration branch |
| Pull requests | Read and write | Create or update a migration PR |
| Metadata | Read-only | Required repository metadata |

Do not grant Administration, Actions, or Workflows permissions.

Disable the webhook entirely and subscribe to no events. Do not enable OAuth
user authorization, request authorization during installation, or configure a
callback flow; this operator-driven application uses none of those surfaces.

Generate a private key and install the App using **Only select repositories**.
For the first pilot, select only the disposable sandbox repository. Never use
the **All repositories** installation option. Keep the App itself private so
other accounts cannot install it until customer onboarding and authorization
records are ready. Then configure:

```dotenv
API_MIGRATOR_AUTH_MODE=github-app
GH_APP_ID=123456
GH_APP_PRIVATE_KEY_PATH=/absolute/owner-only/path/api-migrator.pem

# Optional. Omit this to resolve the installation separately for each repo.
GH_APP_INSTALLATION_ID=42
```

The key file must be outside the workspace and be a regular, non-symlink RSA
private key of at least 2048 bits, owned by the current user, and mode `0400` or
`0600`. The `.env` file is also owner-only and is loaded only from the trusted
workspace root. As an
alternative for a secret manager, inject the PEM directly without setting a
path:

```bash
export API_MIGRATOR_AUTH_MODE=github-app
export GH_APP_ID=123456
export GH_APP_PRIVATE_KEY="$(command cat /secure/path/api-migrator.pem)"
```

Never set `GH_APP_PRIVATE_KEY` and `GH_APP_PRIVATE_KEY_PATH` together. GitHub's
REST response does not expose the webhook `Active` flag, so verify that control
in the App settings; the runtime independently requires an empty event list. At
runtime the App metadata and repository installation must exactly match the
permission/event policy above, the installation must be selected-repository
only and unsuspended, and every installation token is narrowed to one target
repository. Private preview tokens receive only Contents read plus Metadata
read and Pull requests read. The sole write-token broker can request Contents
write, Pull requests write, and Metadata read only after verification, exact
owner authorization, and durable one-use consumption. App installation tokens
are revoked on best-effort cleanup when the job ends and are never cached
across jobs.

## Preview before publishing

Every invocation defaults to a non-publishing preview:

```bash
npm run migrate --workspace @api-migrator/app -- owner/repo
```

Preview first attempts a credential-free clone, so public repositories need no authentication configuration. If that clone fails, a private repository is retried only when `API_MIGRATOR_AUTH_MODE` was explicitly configured; the app never guesses or silently invokes `gh`.

The preview returns a `pf_...` preflight ID and binds the repository identity,
exact base commit, canonical manifest bytes, candidate branch and tree,
artifact, migration report, blockers, and completion time.

The direct CLI and package-root API are preview-only. The CLI rejects publication
and override flags. The local operator console is the only supported operator
publication route and uses a one-repository three-stage flow. A write-capable
executor is exported only from an explicitly internal console-integration
subpath; it must not be exposed or called before this ceremony:

1. Run a non-publishing preview and receive a short-lived one-use preview
   receipt.
2. Supply the exact canonical Ed25519 owner envelope. Preparing publication
   consumes the preview receipt and binds the SHA-256 digest of those exact
   envelope bytes into a short-lived operator token and typed confirmation
   phrase.
3. Submit the same exact envelope bytes, operator token, and confirmation
   phrase. Before any write token is minted, the app rejects every blocker,
   verifies the owner signature and every current repository/run binding,
   rechecks key and authorization revocation and time, and consumes the
   authorization in the durable externally anchored replay store. It then
   rechecks repository/base identity and owner authorization immediately before
   and after minting the one-repository write token.

There is no unsafe or manual-review override. Failed, skipped, or unresolved
verification and review findings all block publication. Any drift in the base,
manifest, report, preflight, candidate tree, remote branch/PR state, evidence,
or allowed action requires a new preview and a newly signed owner envelope.

The replay store must be explicitly initialized with its owner-only external
anchor before this path can run; ordinary database migration does not activate
publication. The raw owner envelope is bounded, passed byte-for-byte, kept only
in process/UI memory for the attempt, and never returned in a receipt.

The app never auto-merges. Its branch name is content-addressed from the manifest, base branch, exact base commit, and verified artifact. An existing ref is never overwritten: it is reused only when its Git tree and sole parent exactly match the approved artifact and base commit, allowing safe recovery if the first PR-creation attempt failed.

## Protect migration refs

GitHub refs remain externally mutable after the app validates them. Configure a
repository ruleset targeting `codex/api-migrator/*` that restricts creation,
updates, deletion, and non-fast-forward changes, with only the migrator App as
a bypass actor. Protect `main` separately with a pull-request rule plus
deletion and non-fast-forward protection, and give the App no bypass on
`main`. Configure both rulesets out of band as a repository operator; do not
grant the App Administration permission. The publication policy must bind the
current ruleset and required-CI evidence digests. `gh-cli` remains preview-only
and cannot enter the write-token broker.

The app checks that GitHub's create/update PR response still points at the exact expected migration commit and approved base branch. This closes the publication race at that API response, but it cannot prevent a later collaborator or integration from changing the ref. The approved head is recorded in the publication result and PR audit footer. Immediately before merge, the operator must confirm that the PR's current head SHA still matches it.

## Credential and execution boundaries

- Clone URLs and git arguments never contain a token. Git receives the token through a temporary askpass environment that is removed after the run.
- Repository-controlled install, type-check, test, and lint commands receive an allowlisted environment with an isolated home directory; GitHub/App/database secrets are excluded.
- Verification requests the Docker runner and fails closed if isolation or required checks are unavailable.
- Trusted compiler provenance currently requires npm and a version 2/3 `package-lock.json` or `npm-shrinkwrap.json`; other package managers fail closed.
- Installation has ordinary Docker bridge networking after source-policy checks. It is not an egress filter and remains limited to approved repositories.
- Stored and returned operation errors are redacted and bounded.

## Current release gate

The owner-signature and replay boundary above is an unreleased candidate. Keep
the App private and installed only on the disposable sandbox. External-source
publication remains disabled until owner challenge/signing tooling, a
disposable egress-filtered runner, current ruleset and required-CI evidence,
and a supervised sandbox publication drill are complete. Dynamo, Toloka, and
every repository designated as professional or client work are categorically
outside this pilot: do not install, clone, preview, or publish against them.
