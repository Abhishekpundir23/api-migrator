# API Migrator

> When an API provider ships a breaking SDK upgrade, find affected customer code and deliver tested, reviewable migration pull requests.

**Status:** working platform prototype. The engine, GitHub integration, campaign DB, and provider console are all built and gated. See the gates table below.

This goes beyond what Dependabot does: Dependabot bumps the dependency manifest; this rewrites the **application code** that calls the upgraded API, then opens a reviewable PR per customer repo.

## What works today

- **Two providers, one engine:** Inngest TypeScript SDK **v3 → v4** and Knock Node.js SDK **v0.x → v1.0** run through the same manifest-driven pipeline — proving the engine is provider-agnostic, not Inngest-specific. A new provider is just a new transform file + a manifest entry.
- **Engine:** deterministic AST transforms (jscodeshift / recast, with a per-extension parser so TypeScript type annotations parse) for mechanical changes; structural changes are flagged for human review, not auto-applied.
- **Verified:** Inngest-migrated code type-checks clean against `inngest@4.14.0`.
- **Full flow:** create a campaign in the web console → run it across repos → real migration PRs open.

## Architecture

```
packages/
├── engine/    # migration engine: manifest -> scanner -> transformer -> verifier -> reporter
├── app/       # GitHub integration + campaign runner
├── console/   # Next.js provider console
└── db/        # campaign/repo/run schema + repository layer
prototypes/    # the original single-file engine, kept for reference
```

The workspace packages (`engine`, `db`, `app`) ship **compiled `dist/` JS** — build them once, then the console consumes them as normal packages.

### Engine (`packages/engine`)

Maps to the plan's pipeline (manifest → scanner → transformer → verifier → reporter), implemented as a callable, programmatic TypeScript library:

- **`manifest.ts`** — Zod schema for a migration campaign (provider, package, peer floors, transform set).
- **`scanner.ts`** — finds files using the target SDK, with **per-provider usage patterns** selected by the manifest's `transformSet` (provider-specific identifiers, to avoid false positives on `res.send()` etc.).
- **`transforms/inngest-v3-to-v4.ts`** — the Inngest deterministic AST transform set.
- **`transforms/knock-v0-to-v1.ts`** — the Knock deterministic AST transform set (second provider).
- **`transforms/parser.ts`** — picks the babel parser (`ts`/`tsx`/`babel`) per file extension, so TypeScript type annotations parse correctly.
- **`verifier.ts`** — runs `tsc --noEmit`, diffing post-transform errors against a **pre-transform baseline** so migration-introduced errors are distinguished from pre-existing ones.
- **`reporter.ts`** — assembles a structured `MigrationReport` + a markdown PR body.
- **`pipeline.ts`** — `runMigration(manifest, repoPath)` ties it together; the single entry point the campaign runner calls per repo.

### Console (`packages/console`, Next.js)

The provider-facing product surface:
- `/campaigns` — list of campaigns
- `/campaigns/new` — create a campaign from a manifest JSON (validated against the engine schema)
- `/campaigns/[id]` — dashboard: summary stats (PRs opened / merged / failed), a "run migration" form (paste repo slugs → opens real PRs), and the per-repo run table with PR links
- API: `POST /api/campaigns`, `GET /api/campaigns/[id]`, `POST /api/campaigns/[id]/runs`

## Run

```bash
npm install
npm run build:packages      # build engine, db, app -> dist/

# CLI: migrate one repo (opens a real PR via gh)
npx tsx packages/app/src/cli.ts <owner/repo>

# Console: full web UI to create campaigns and run them across repos
npm run console             # http://localhost:3000
```

### Programmatic use

```ts
import { runMigration, reportToMarkdown } from "@api-migrator/engine";

const { report } = await runMigration(manifest, repoPath, { writeChanges: true });
const prBody = reportToMarkdown(report); // post as the PR description
```

## Gates passed

| Phase | Gate |
|-------|------|
| 0 — Foundation | monorepo type-checks clean; reproduces prototype result |
| 1 — Engine | full pipeline; report + markdown |
| 2 — GitHub | real PR opened from code (correct diff + report body) |
| 3 — Campaigns + DB | DB-backed campaign persists run rows |
| 4 — Console | campaign created + run + PR opened through the web UI |
| 5 — Second provider | Knock v0→v1 runs through the same pipeline as Inngest (provider-agnostic) |

## Not built yet

- Registered GitHub App auth (today uses `gh` for pilot auth; the Octokit `auth-app` path is documented inline — only the auth wrapper differs).
- Auto-merge (always human review), multi-language support beyond TS, auto-generating manifests from docs alone.

## Reference

- Inngest v3→v4 migration guide: https://www.inngest.com/docs/reference/typescript/v4/migrations/v3-to-v4
