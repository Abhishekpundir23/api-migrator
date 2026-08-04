# API Migrator

API Migrator is an operator-reviewed pilot for upgrading application code when an API provider ships a breaking TypeScript SDK release.

**Current status:** sandbox-validated internal pilot. The owner-challenge, offline-signing, exact-authorization, and durable replay primitives exist, but the console cannot currently generate an owner challenge or publish: both paths require an opaque verified-runner capability, and no trusted control-plane provider is wired yet. A minimal Node 22 runner image now exercises offline preparation, lifecycle-disabled dependency installation, offline migration, and offline verification, while the host and L7 gateway directories define non-authorizing deployment contracts. Live host activation, external-source execution, owner-challenge generation, and publication remain disabled until the gateway lifecycle is integrated and drilled on a disposable Linux host, a control plane independently verifies and supplies the runner capability, repository ruleset and required-CI evidence are validated, and a supervised sandbox drill passes. It is not a hosted multi-tenant product, it does not track merged PRs, and it should not be exposed directly to the internet.

The first product goal is deliberately narrow: create a complete, verified migration preview for one repository, let a human review it, and publish a PR only after explicit approval. It never auto-merges.

## Safety model

The publication flow below is a security boundary under active pilot validation. Steps 4–7 describe the intended ceremony after a trusted control plane can verify runner evidence and supply the resulting opaque capability. The current console fails closed before creating a challenge. Do not use this flow for external source until every remaining gate above has evidence.

Publishing is a separate action from analysis:

1. An authenticated local operator enters one approved `owner/repo` slug.
2. **Preview** clones and analyzes each repository without pushing a branch or opening a PR.
3. Unsafe or incomplete results are blocked. A publishable result receives a preflight ID bound to the repository, base commit, target branch, candidate Git tree, manifest, verification report, and exact changed-file bytes and modes.
4. **Prepare owner challenge** reruns that exact preview using only a single-repository read token, rechecks current base/branch/PR and App identities, and emits canonical challenge bytes, their digest, and an opaque server-authenticated challenge receipt binding that digest to the preview. It consumes no preview receipt and performs no remote mutation.
5. The repository owner reviews the displayed repository, App, base, tree, action, and evidence bindings, then operates the offline signer with an explicit approval of that exact challenge digest. The signed payload binds the digest; the signer writes a new owner-only envelope file and prints only a safe receipt.
6. **Prepare publication** requires the exact challenge receipt, independently reruns the exact preview with GitHub App read identity, and verifies that the owner-signed challenge digest and every fresh binding match without consuming either receipt. Only after that succeeds does the console consume the one-use preview receipt, bind the challenge and exact envelope bytes into a separate short-lived operator token, and ask for an exact confirmation phrase. Missing, forged, cross-preview, stale, expired, or revoked material leaves the preview receipt unused.
7. **Publish** independently reruns the repository and recomputes every binding, verifies the owner signature against an owner-only out-of-workspace registry, atomically consumes the envelope in the durable replay ledger, and only then requests a single-repository write token. Any stale base, remote-state drift, changed artifact, expired/revoked/replayed authorization, failed/skipped verification, or manual-review item fails closed. No blocker is overrideable.

The console adds several guardrails around that flow:

- server-side HTTP Basic authentication; credentials are not included in client JavaScript;
- localhost-only access by default;
- 192 KiB JSON request limit (including an exact owner envelope capped at 64 KiB), strict GitHub slug validation, and one repository per owner-authorized run;
- one active migration batch per console process;
- domain-separated preview and operator tokens that expire after 10 minutes, plus durable cross-process owner-envelope replay rejection;
- no unsafe override exposed in the web UI.

HTTP Basic authentication is only appropriate on loopback or behind TLS. Do not enable remote access over plain HTTP.

## What is implemented

The repository is a TypeScript workspace with five packages:

```text
packages/
├── engine/    # manifest, scanner, deterministic transforms, verifier, report
├── app/       # safe preview/publish orchestration and GitHub integration
├── db/        # SQLite campaign, repository, and run records
├── console/   # local Next.js operator console
└── runner/    # fixed four-phase, credential-free OCI runner entrypoints
```

The engine includes experimental Inngest TypeScript SDK v3→v4 and Knock Node SDK v0→v1 transform sets. These demonstrate the workflow; they are not a claim that arbitrary SDK migrations are supported. Each transform must prove that a matched call belongs to the target SDK, and every provider migration needs its own fixtures and change inventory.

The Inngest v4 campaign also migrates the deployment floor to Node 20+, pins its audited Node 22.23.2 Docker profile and Dockerfile frontend by digest, and verifies the post-edit package and Dockerfile declarations. This pilot accepts only the exact audited three-stage Fly/Next.js Docker recipe; it is not a general Dockerfile rewriter. A complete repository Docker build and default-command smoke test still belong in a disposable, secret-free CI worker; the local verifier does not execute repository Dockerfiles on the host daemon.

SQLite is for local pilot state. Foreign keys are enabled, migrations are idempotent, and the console stores structured reports and run metadata. Source trees are processed in disposable working directories rather than stored in the database.

The package root also exposes a fail-closed pre-publication runner plan and
signed-attestation verifier. The accompanying
[runner image and Linux contracts](ops/publication-runner/README.md) are
reviewable implementation artifacts, not proof of a live hardened deployment
or independently observed and signed execution. External-source publication
remains disabled until the L7 gateway lifecycle is provisioned, drilled, and
attested and every remaining pilot gate is completed.

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

The command prints the preflight ID, exact base commit, blockers, artifact fingerprint, and candidate tree. The direct CLI and package-root API are preview-only. The local console contains distinct preview, read-only challenge, offline owner-envelope, and operator-confirmation stages, but only preview is currently usable: challenge and publish fail closed because the trusted runner-capability provider is not wired. Its write-capable campaign executor is isolated behind an explicitly internal package subpath for console integration and must not be exposed as an API or invoked outside the completed ceremony. External publication remains disabled until the runner-capability, ruleset/CI-evidence, and supervised-drill gates are completed.

### Owner challenge and offline signing

The console's **Generate owner challenge** action is currently unavailable. It reruns the exact preview but then requires an opaque capability returned by `verifyPublicationRunnerAttestation`; because no trusted control-plane provider supplies that capability, the action fails closed and downloads no challenge. Once that provider is integrated and drilled, the action is designed to require the selected-repository GitHub App identity, recheck current remote state, and download canonical challenge JSON.

Only after that gate is operational should an operator store the downloaded challenge, Ed25519 private key, public-key registry, and signer output in a restrictive owner-controlled directory outside this workspace. On Unix-like systems, set files and the directory to owner-only permissions before signing.

After independently reviewing a challenge produced by that future trusted flow, run:

```bash
npm run owner:sign -- \
  --challenge /absolute/owner-only/challenge.json \
  --registry /absolute/owner-only/owner-keys.json \
  --key /absolute/owner-only/owner-key.pem \
  --out /absolute/owner-only/new-envelope.json \
  --approve-challenge-digest sha256:REVIEWED_DIGEST \
  --authorization-id authorization-id \
  --signer-id owner-signer-id \
  --key-id owner-key-id
```

The signer accepts only canonical, blocker-free challenges less than ten minutes old, binds the exact reviewed challenge digest into the signed payload, limits the challenge and envelope window to 30 minutes and the underlying authorization expiry, verifies exact Ed25519 registry/key/repository correspondence, refuses symlinks, hard links, weak permissions, workspace-contained inputs, and existing output paths, then round-trips the new envelope through the runtime verifier. It fsyncs a new `0600` output file and its restrictive parent directory. Standard output contains only a safe receipt; it never contains private-key, payload, signature, or envelope bytes. Attach the resulting file through the console file selector before the opaque challenge receipt expires.

When challenge generation is enabled, its receipt will never extend the original ten-minute preview receipt. The ceremony will therefore be limited to small repositories whose challenge rerun, human signing step, and prepare-publication rerun all fit inside the displayed deadline. Expiry requires a completely new preview; do not lengthen or bypass the receipt locally.

## Commands and automated checks

| Command | What it proves |
|---|---|
| `npm run build` | Builds engine, DB, app, and runner before the Next.js console |
| `npm run typecheck` | Builds package declarations, then type-checks every workspace |
| `npm test` | Runs the workspace unit and migration-fixture tests that exist in this checkout |
| `npm run ci` | Runs ordered package builds, type-checks, workspace, pilot-evidence, and runner-script checks, example sidecar validation, and the console production build |
| `npm run test:ops` | Checks the shell, gateway, host-deployment, and runner-image contracts without claiming a live Linux security drill |
| `npm run runner:image:build` | Builds the minimal local Node 22 runner image |
| `npm run runner:image:verify` | Verifies the image configuration and fixed entrypoint surface |
| `npm run runner:image:integration` | Exercises prepare/install/migrate/verify in real containers; this is functional evidence, not a host egress drill |
| `npm run db:migrate` | Creates/updates the local SQLite bootstrap schema and indexes |
| `npm run db:init-owner-store -- --activate` | One-time creation of the externally anchored owner-authorization replay store |
| `npm run migrate -- owner/repo` | Generates a non-publishing Inngest migration preview for one approved repository |
| `npm run owner:sign -- ...` | Signs an exact canonical challenge without GitHub access; the console does not currently issue such a challenge |

GitHub Actions runs `npm run ci` on pushes and pull requests. CI uses only its read-only checkout token, does not persist that credential, does not configure application GitHub credentials, push branches, open real PRs, or prove customer-repository compatibility. A real pilot still requires operator review and evidence from approved repositories.

## Pilot acceptance criteria

The [supervised pilot package](docs/pilot/README.md) defines the authorization,
execution, data-handling, revocation, and evidence requirements for every real
repository trial. Do not clone or install the App on a candidate repository
until the runbook's authorization and isolation gates are satisfied.

The sidecar result validator is a post-run audit aid. It is not consulted by the
GitHub write-token path and cannot authorize preview, publication, or merge.

Before charging for a provider campaign, independently deploy and attest the egress-filtered runner, validate ruleset and required-CI evidence, pass a supervised disposable-sandbox publication drill, then run owner-authorized previews on 5–10 repositories and record the evidence below. Do not publish external source merely because the challenge, signature, and replay primitives exist.

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
