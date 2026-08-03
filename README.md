# API Migrator

API Migrator is an operator-reviewed pilot for upgrading application code when an API provider ships a breaking TypeScript SDK release.

**Current status:** sandbox-validated internal pilot. This checkout now enforces a separately signed, exact-preview owner authorization before the only GitHub App write-token broker can mint a token. It also durably consumes that authorization in an externally anchored replay ledger. External-source execution and publication nevertheless remain disabled until the owner challenge/signing workflow, disposable egress-filtered runner, repository ruleset evidence, required-CI evidence, and a supervised sandbox drill are complete. It is not a hosted multi-tenant product, it does not track merged PRs, and it should not be exposed directly to the internet.

The first product goal is deliberately narrow: create a complete, verified migration preview for one repository, let a human review it, and publish a PR only after explicit approval. It never auto-merges.

## Safety model

The publication flow below is a security boundary under active pilot validation. Do not use it for external source until every remaining gate above has evidence.

Publishing is a separate action from analysis:

1. An authenticated local operator enters one approved `owner/repo` slug.
2. **Preview** clones and analyzes each repository without pushing a branch or opening a PR.
3. Unsafe or incomplete results are blocked. A publishable result receives a preflight ID bound to the repository, base commit, target branch, candidate Git tree, manifest, verification report, and exact changed-file bytes and modes.
4. The repository owner separately signs a canonical, short-lived Ed25519 envelope covering that exact preview, App/repository identities, policy evidence, current remote action, and a replay-resistant nonce.
5. The console binds the exact envelope bytes into a separate short-lived operator token and asks for an exact confirmation phrase.
6. **Publish** reruns the repository, verifies the owner signature against an owner-only out-of-workspace registry, atomically consumes the envelope in the durable replay ledger, and only then requests a single-repository write token. Any stale base, remote-state drift, changed artifact, expired/revoked/replayed authorization, failed/skipped verification, or manual-review item fails closed. No blocker is overrideable.

The console adds several guardrails around that flow:

- server-side HTTP Basic authentication; credentials are not included in client JavaScript;
- localhost-only access by default;
- 192 KiB JSON request limit (including an exact owner envelope capped at 64 KiB), strict GitHub slug validation, and one repository per owner-authorized run;
- one active migration batch per console process;
- domain-separated preview and operator tokens that expire after 10 minutes, plus durable cross-process owner-envelope replay rejection;
- no unsafe override exposed in the web UI.

HTTP Basic authentication is only appropriate on loopback or behind TLS. Do not enable remote access over plain HTTP.

## What is implemented

The repository is a TypeScript workspace with four packages:

```text
packages/
├── engine/    # manifest, scanner, deterministic transforms, verifier, report
├── app/       # safe preview/publish orchestration and GitHub integration
├── db/        # SQLite campaign, repository, and run records
└── console/   # local Next.js operator console
```

The engine includes experimental Inngest TypeScript SDK v3→v4 and Knock Node SDK v0→v1 transform sets. These demonstrate the workflow; they are not a claim that arbitrary SDK migrations are supported. Each transform must prove that a matched call belongs to the target SDK, and every provider migration needs its own fixtures and change inventory.

The Inngest v4 campaign also migrates the deployment floor to Node 20+, pins its audited Node 22.23.2 Docker profile and Dockerfile frontend by digest, and verifies the post-edit package and Dockerfile declarations. This pilot accepts only the exact audited three-stage Fly/Next.js Docker recipe; it is not a general Dockerfile rewriter. A complete repository Docker build and default-command smoke test still belong in a disposable, secret-free CI worker; the local verifier does not execute repository Dockerfiles on the host daemon.

SQLite is for local pilot state. Foreign keys are enabled, migrations are idempotent, and the console stores structured reports and run metadata. Source trees are processed in disposable working directories rather than stored in the database.

## Local setup

Requirements: Node.js 22+, npm, Git, Docker for isolated verification, and access to repositories you are authorized to test.

```bash
npm ci
cp .env.example .env
```

Replace all operator secrets in `.env`. `OPERATOR_APPROVAL_SECRET` must contain at least 32 bytes and should be independent of the password. Relative `API_MIGRATOR_DB_PATH` values are resolved from the repository root so the database command, CLI, and console use the same file.

Initialize preview-only local state and validate the checkout:

```bash
npm run db:migrate
npm run ci
```

The write path additionally requires a one-time [replay-store ceremony](packages/db/OWNER_AUTHORIZATION_STORE.md). Configure `API_MIGRATOR_REPLAY_STORE_ID` and an absolute `API_MIGRATOR_REPLAY_ANCHOR_PATH` in a separate owner-controlled persistent directory, then run `npm run db:init-owner-store -- --activate`. The command exclusively creates an owner-only anchor and will not overwrite or silently adopt an existing anchor. A missing, replaced, or orphaned database/anchor is an incident and keeps publication disabled.

Start the loopback operator console:

```bash
npm run console
```

Open [http://localhost:3000](http://localhost:3000) and enter the configured operator username and password when the browser prompts.

### GitHub credentials

Public-repository previews first use anonymous, credential-free cloning. For an explicitly owner-authorized private preview—or a future supervised sandbox publication—set `API_MIGRATOR_AUTH_MODE=github-app`, keep the first-pilot App private, configure access only to the exact selected sandbox repository, then set `GH_APP_ID` and exactly one of `GH_APP_PRIVATE_KEY_PATH` (preferred for a local pilot) or `GH_APP_PRIVATE_KEY`; `GH_APP_INSTALLATION_ID` is optional and is checked against the requested repository. Private previews fall back to those credentials only when that mode was explicitly configured. They receive a single-repository read token. A write token is available only through the internal owner-authorized broker after live signature, policy, remote-state, and durable replay checks. App tokens are revoked on best-effort cleanup and are never cached across jobs. Preview never grants permission to publish.

A GitHub App publication invocation uses two separately scoped installation
tokens: read access for repository discovery/clone and a later write token for
the approved branch and PR. Pilot evidence must record both phases separately,
including exact repository scope, policy snapshots, issuance, expiry, and
best-effort revocation.

For a local preview on repositories you control, `API_MIGRATOR_AUTH_MODE=gh-cli` explicitly opts into the current `gh` CLI identity. That mode is rejected for publication and when `NODE_ENV=production`; there is no implicit credential fallback.

Do not place a personal token in repository URLs, command arguments, reports, or database errors. The App identity, installation, repository selection, permissions, events, and returned token scope are checked before use. GitHub's REST response does not expose the App webhook's `Active` flag, so disabling it remains an operator-verified registration control; the runtime independently requires an empty event subscription. The local PEM path must be absolute, owner-only, regular, non-symlinked, and outside the workspace. Every root env file loaded by the CLI or console must also be owner-only, regular, and non-symlinked. GitHub credentials are absent from verification subprocesses. Credentialed Git commands do not inherit ambient proxy, custom-CA, Git, or Node preload settings. Verification uses a Git-free working tree and a digest-pinned Docker image; compiler, test, and lint checks have no network and a read-only repository mount. The trusted compiler redirects incremental build metadata to container-temporary storage, and any non-file compiler diagnostic or unclassified process output makes verification incomplete rather than becoming a baseline exception. Dependency installation uses ordinary Docker bridge networking after rejecting custom registry configuration and non-registry lock sources, with lifecycle scripts disabled. This is policy validation, not network-level egress filtering, so the pilot remains limited to operator-approved repositories. Before accepting hostile multi-tenant input, move installation and checks to a dedicated, egress-filtered disposable VM or job runner.

Trusted compiler provenance is deliberately npm-only in this pilot: verification requires npm with `package-lock.json` or `npm-shrinkwrap.json` lockfile version 2 or 3. Repositories selected for pnpm, Yarn, or Bun fail closed until equivalent provenance checks are implemented.

The trusted no-emit verifier currently requires the root `tsconfig.json` to select source files directly, including every provider-related or changed source file in the migration. Solution-style roots with TypeScript project references fail closed until each referenced project can be verified independently without writing build artifacts.

Alternative `VerificationRunner` implementations must provide isolated writable temporary-file storage in the runner namespace and clean it up, or dispose of the entire runner after each command. Temporary paths are normalized out of verification reports so repeated preflights remain deterministic.

Content-addressed migration branch names and PR head/base checks do not make GitHub refs permanently immutable: collaborators or other integrations may still change or delete a ref after the app checks it. Before any future external publication in GitHub App mode, the target repository must have a GitHub ruleset targeting `codex/api-migrator/*` that restricts branch creation, updates, deletion, and non-fast-forward changes, with only the migrator App configured as a bypass actor. Protect the default branch separately with PR-only, deletion, and non-fast-forward rules and no App bypass. These publication rulesets are not prerequisites for an anonymous, non-publishing public preview. They are configured by the repository operator; the App does not need Administration permission. The local `gh-cli` pilot remains a weaker operator-controlled mode and is not authorized for external publication. Immediately before any future merge, an authorized repository maintainer must confirm that the PR's current head commit still equals the approved head recorded in the PR audit footer and publication result.

Preview the built-in Inngest campaign from the CLI without publishing anything:

```bash
npm run migrate -- owner/repo
```

The command prints the preflight ID, exact base commit, blockers, artifact fingerprint, and candidate tree. The direct CLI and package-root API are preview-only. The local console is the only supported operator publication route and uses distinct preview, owner-envelope, and operator-confirmation stages. Its write-capable campaign executor is isolated behind an explicitly internal package subpath for console integration and must not be exposed as an API or invoked outside that ceremony. External publication remains disabled until the missing challenge/signing and runner gates are completed and drilled.

## Commands and automated checks

| Command | What it proves |
|---|---|
| `npm run build` | Builds engine, DB, and app before the Next.js console |
| `npm run typecheck` | Builds package declarations, then type-checks every workspace |
| `npm test` | Runs the workspace unit and migration-fixture tests that exist in this checkout |
| `npm run ci` | Runs ordered package builds, type-checks, workspace and pilot-evidence tests, example sidecar validation, and the console production build |
| `npm run db:migrate` | Creates/updates the local SQLite bootstrap schema and indexes |
| `npm run db:init-owner-store -- --activate` | One-time creation of the externally anchored owner-authorization replay store |
| `npm run migrate -- owner/repo` | Generates a non-publishing Inngest migration preview for one approved repository |

GitHub Actions runs `npm run ci` on pushes and pull requests. CI uses only its read-only checkout token, does not persist that credential, does not configure application GitHub credentials, push branches, open real PRs, or prove customer-repository compatibility. A real pilot still requires operator review and evidence from approved repositories.

## Pilot acceptance criteria

The [supervised pilot package](docs/pilot/README.md) defines the authorization,
execution, data-handling, revocation, and evidence requirements for every real
repository trial. Do not clone or install the App on a candidate repository
until the runbook's authorization and isolation gates are satisfied.

The sidecar result validator is a post-run audit aid. It is not consulted by the
GitHub write-token path and cannot authorize preview, publication, or merge.

Before charging for a provider campaign, complete the owner-challenge tooling and egress-filtered runner, pass a supervised disposable-sandbox publication drill, then run owner-authorized previews on 5–10 repositories and record the evidence below. Do not publish external source merely because the signature and replay primitives exist.

- affected-usage precision and false positives;
- dependency and lockfile updates;
- verification/test pass rate;
- unresolved review items;
- operator correction time;
- accepted PR rate and engineering time saved.

The next commercial milestone is one API provider paying for successful, reviewable migration PRs—not adding more providers or expanding the dashboard.

## Deliberately out of scope

- automatic merge;
- public or multi-tenant console hosting;
- merge-state tracking (the UI reports only what this service actually observes);
- universal languages, SDKs, or behavior-changing migrations;
- generating trustworthy migration rules from documentation alone;
- claiming a GitHub App installation or a passing unit suite proves production safety.

Reference migration guide: [Inngest TypeScript v3 to v4](https://www.inngest.com/docs/reference/typescript/v4/migrations/v3-to-v4).
