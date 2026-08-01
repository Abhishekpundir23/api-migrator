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
read. The write permissions are requested only after verification, blocker
handling, and exact operator approval. App installation tokens are revoked on
best-effort cleanup when the job ends and are never cached across jobs.

## Preview before publishing

Every invocation defaults to a non-publishing preview:

```bash
npm run migrate --workspace @api-migrator/app -- owner/repo
```

Preview first attempts a credential-free clone, so public repositories need no authentication configuration. If that clone fails, a private repository is retried only when `API_MIGRATOR_AUTH_MODE` was explicitly configured; the app never guesses or silently invokes `gh`.

The preview returns a `pf_...` preflight ID bound to the repository slug, exact base commit, manifest, and migration report. It also reports any verification or manual-review blockers.

Publishing requires the exact preflight ID and a named operator:

```bash
npm run migrate --workspace @api-migrator/app -- owner/repo \
  --publish \
  --preflight pf_REPLACE_WITH_EXACT_PREVIEW_ID \
  --approved-by operator@example.com
```

If the base commit or generated report changed, publication refuses the stale approval and requires a new preview. Failed or skipped verification is an absolute publication blocker. Unresolved manual-review entries also block publication by default.

An operator may acknowledge manual-review entries only with a separate flag and an audit reason; this flag cannot override failed or skipped verification:

```bash
npm run migrate --workspace @api-migrator/app -- owner/repo \
  --publish \
  --preflight pf_REPLACE_WITH_EXACT_PREVIEW_ID \
  --approved-by operator@example.com \
  --override-unsafe \
  --override-reason "Manually reviewed the flagged call site and accepted the risk"
```

The app never auto-merges. Its branch name is content-addressed from the manifest, base branch, exact base commit, and verified artifact. An existing ref is never overwritten: it is reused only when its Git tree and sole parent exactly match the approved artifact and base commit, allowing safe recovery if the first PR-creation attempt failed.

## Protect migration refs

GitHub refs remain externally mutable after the app validates them. For stronger ongoing immutability in GitHub App mode, configure a repository ruleset targeting `codex/api-migrator/*` that restricts creation, updates, deletion, and non-fast-forward changes, with only the migrator App as a bypass actor. Protect `main` separately with a pull-request rule plus deletion and non-fast-forward protection, and give the App no bypass on `main`. Configure both rulesets out of band as a repository operator; do not grant the App Administration permission. The local `gh-cli` pilot remains weaker unless its explicitly selected identity receives equivalent narrowly scoped ruleset access.

The app checks that GitHub's create/update PR response still points at the exact expected migration commit and approved base branch. This closes the publication race at that API response, but it cannot prevent a later collaborator or integration from changing the ref. The approved head is recorded in the publication result and PR audit footer. Immediately before merge, the operator must confirm that the PR's current head SHA still matches it.

## Credential and execution boundaries

- Clone URLs and git arguments never contain a token. Git receives the token through a temporary askpass environment that is removed after the run.
- Repository-controlled install, type-check, test, and lint commands receive an allowlisted environment with an isolated home directory; GitHub/App/database secrets are excluded.
- Verification requests the Docker runner and fails closed if isolation or required checks are unavailable.
- Trusted compiler provenance currently requires npm and a version 2/3 `package-lock.json` or `npm-shrinkwrap.json`; other package managers fail closed.
- Installation has ordinary Docker bridge networking after source-policy checks. It is not an egress filter and remains limited to approved repositories.
- Stored and returned operation errors are redacted and bounded.
