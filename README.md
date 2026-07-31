# API Migrator

> When an API provider ships a breaking SDK upgrade, find affected customer code and deliver tested, reviewable migration pull requests.

**Status: feasibility prototype.** This repo proves *one* migration end-to-end. It is **not** the product. The full platform is deliberately gated behind a signed pilot (see the plan).

## What works today

- **Target:** Inngest TypeScript SDK, **v3 → v4**
- **Engine:** deterministic AST transforms (jscodeshift / recast) for mechanical changes; structural changes are flagged for human review, not auto-applied.
- **Verified:** migrated `src/inngest/functions.ts` type-checks clean against `inngest@4.14.0`.

This goes beyond what Dependabot does: Dependabot bumps the dependency manifest; this rewrites the **application code** that calls the upgraded API.

## Migration transforms implemented

| Code | Change | Type |
|------|--------|------|
| T1 | `createFunction({id}, {trigger}, fn)` → `createFunction({id, triggers:{...}}, fn)` | deterministic |
| T2 | `serveHost` → `serveOrigin` | deterministic |
| T3 | `streaming: "force"\|"allow"\|false` → `streaming: true\|false` | deterministic |
| F1 | `new Inngest({id})` missing `isDev`/`signingKey` | flagged for review |
| F2 | `event.user` usage (removed in v4) | flagged for review |

## Architecture (in progress)

Monorepo built up phase by phase (see `Build plan`):

```
packages/
├── engine/    # migration engine: manifest -> scanner -> transformer -> verifier -> reporter
├── app/       # GitHub App: clone, transform, open PRs        (Phase 2)
├── console/   # Next.js provider console                      (Phase 4)
└── db/        # campaign/repo/run schema                       (Phase 3)
prototypes/    # the original single-file engine, kept for reference
```

The engine maps to the plan's pipeline (manifest → scanner → transformer → verifier → reporter). `packages/engine` implements the full pipeline as a callable, programmatic TypeScript library:

- **`manifest.ts`** — Zod schema for a migration campaign (provider, package, peer floors, transform set).
- **`scanner.ts`** — finds files using the target SDK (Inngest-specific identifiers, to avoid false positives on `res.send()` etc.).
- **`transforms/inngest-v3-to-v4.ts`** — the deterministic AST transform set.
- **`verifier.ts`** — runs `tsc --noEmit`, diffing post-transform errors against a **pre-transform baseline** so migration-introduced errors are distinguished from pre-existing ones.
- **`reporter.ts`** — assembles a structured `MigrationReport` + a markdown PR body.
- **`pipeline.ts`** — `runMigration(manifest, repoPath)` ties it together; the single entry point the GitHub App calls per repo.

## Run

```bash
npm install

# scan + run the Inngest v3->v4 transform against a repo (dry-run by default)
npx tsx packages/engine/src/cli.ts <repo-path>

# apply the changes in place
npx tsx packages/engine/src/cli.ts <repo-path> --write

# run the full pipeline (manifest-driven) as a programmatic gate test
npx tsx packages/engine/src/gate.ts
```

### Programmatic use

```ts
import { runMigration, reportToMarkdown } from "@api-migrator/engine";

const { report } = await runMigration(manifest, repoPath, { writeChanges: true });
const prBody = reportToMarkdown(report); // post as the PR description
```

## Deliberately not built yet

Dashboard, GitHub App, multi-repo orchestration, multi-language support, auto-rule-generation from docs, auto-merge. These are gated behind a signed pilot per the plan — building them speculatively is the failure mode the plan exists to prevent.

## Reference

- Inngest v3→v4 migration guide: https://www.inngest.com/docs/reference/typescript/v4/migrations/v3-to-v4
