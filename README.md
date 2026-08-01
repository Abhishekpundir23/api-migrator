# API Migrator

API Migrator is an operator-reviewed pilot for upgrading application code when an API provider ships a breaking TypeScript SDK release.

**Current status:** internal pilot prototype. It is suitable for approved test repositories and carefully supervised pilots. It is not a hosted multi-tenant product, it does not track merged PRs, and it should not be exposed directly to the internet.

The first product goal is deliberately narrow: create a complete, verified migration preview for one repository, let a human review it, and publish a PR only after explicit approval. It never auto-merges.

## Safety model

Publishing is a separate action from analysis:

1. An authenticated local operator enters up to 10 approved `owner/repo` slugs.
2. **Preview** clones and analyzes each repository without pushing a branch or opening a PR.
3. Unsafe or incomplete results are blocked. A publishable result receives a preflight ID bound to the repository, base commit, target branch, manifest, verification report, and the exact changed-file bytes and modes.
4. The console issues a signed, short-lived approval token and asks the operator to type an exact confirmation phrase.
5. **Publish** reruns the repository and opens a PR only if the exact artifact fingerprint still matches. A stale base, changed output, failed/skipped verification, or unresolved manual-review item fails closed. Verification failures cannot be overridden; the CLI can record a reasoned operator acknowledgment for manual-review items only.

The console adds several guardrails around that flow:

- server-side HTTP Basic authentication; credentials are not included in client JavaScript;
- localhost-only access by default;
- 32 KiB JSON request limit, strict GitHub slug validation, a 10-repository batch limit, and a concurrency cap;
- one active migration batch per console process;
- signed approval tokens that expire after 10 minutes and reject replay within the running console process;
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

SQLite is for local pilot state. Foreign keys are enabled, migrations are idempotent, and the console stores structured reports and run metadata. Source trees are processed in disposable working directories rather than stored in the database.

## Local setup

Requirements: Node.js 22+, npm, Git, Docker for isolated verification, and access to repositories you are authorized to test.

```bash
npm ci
cp .env.example .env
```

Replace all operator secrets in `.env`. `OPERATOR_APPROVAL_SECRET` must contain at least 32 bytes and should be independent of the password. Relative `API_MIGRATOR_DB_PATH` values are resolved from the repository root so the database command, CLI, and console use the same file.

Initialize the local database and validate the checkout:

```bash
npm run db:migrate
npm run ci
```

Start the loopback operator console:

```bash
npm run console
```

Open [http://localhost:3000](http://localhost:3000) and enter the configured operator username and password when the browser prompts.

### GitHub credentials

Public-repository previews first use anonymous, credential-free cloning. For private-repository previews and all publishing, set `API_MIGRATOR_AUTH_MODE=github-app`, configure a GitHub App with access only to approved repositories, then set `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, and (optionally) `GH_APP_INSTALLATION_ID`. Private previews fall back to those credentials only when that mode was explicitly configured. Preview does not grant permission to publish; the signed preflight and typed approval are still required.

For a local pilot on repositories you control, `API_MIGRATOR_AUTH_MODE=gh-cli` explicitly opts into the current `gh` CLI identity. That mode is rejected when `NODE_ENV=production`; there is no implicit credential fallback.

Do not place a personal token in repository URLs, command arguments, reports, or database errors. GitHub credentials are absent from verification subprocesses. Verification uses a Git-free working tree and a digest-pinned Docker image; compiler, test, and lint checks have no network and a read-only repository mount. Dependency installation uses ordinary Docker bridge networking after rejecting custom registry configuration and non-registry lock sources, with lifecycle scripts disabled. This is policy validation, not network-level egress filtering, so the pilot remains limited to operator-approved repositories. Before accepting hostile multi-tenant input, move installation and checks to a dedicated, egress-filtered disposable VM or job runner.

Trusted compiler provenance is deliberately npm-only in this pilot: verification requires npm with `package-lock.json` or `npm-shrinkwrap.json` lockfile version 2 or 3. Repositories selected for pnpm, Yarn, or Bun fail closed until equivalent provenance checks are implemented.

Content-addressed migration branch names and PR head/base checks do not make GitHub refs permanently immutable: collaborators or other integrations may still change or delete a ref after the app checks it. For stronger ongoing protection in GitHub App mode, each pilot repository must have a GitHub ruleset targeting `codex/api-migrator/*` that restricts branch creation, updates, and deletions, with only the migrator App configured as a bypass actor. This ruleset is configured by the repository operator; the App does not need Administration permission. The local `gh-cli` pilot remains a weaker operator-controlled mode unless its explicitly selected identity is granted equivalent narrowly scoped access. Immediately before merge, the operator must confirm that the PR's current head commit still equals the approved head recorded in the PR audit footer and publication result.

Preview the built-in Inngest campaign from the CLI without publishing anything:

```bash
npm run migrate -- owner/repo
```

The command prints the preflight ID, exact base commit, blockers, and artifact fingerprint. Publishing requires rerunning it with explicit `--publish`, `--preflight`, and `--approved-by` arguments.

## Commands and automated checks

| Command | What it proves |
|---|---|
| `npm run build` | Builds engine, DB, and app before the Next.js console |
| `npm run typecheck` | Builds package declarations, then type-checks every workspace |
| `npm test` | Runs the workspace unit and migration-fixture tests that exist in this checkout |
| `npm run ci` | Runs ordered package builds, type-checks, tests, and the console production build |
| `npm run db:migrate` | Creates/updates the local SQLite bootstrap schema and indexes |
| `npm run migrate -- owner/repo` | Generates a non-publishing Inngest migration preview for one approved repository |

GitHub Actions runs `npm run ci` on pushes and pull requests. CI uses only its read-only checkout token, does not persist that credential, does not configure application GitHub credentials, push branches, open real PRs, or prove customer-repository compatibility. A real pilot still requires operator review and evidence from approved repositories.

## Pilot acceptance criteria

Before charging for a provider campaign, test 5–10 authorized repositories and record:

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
