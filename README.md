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

## Architecture

Maps to the plan's "internal migration engine" (manifest → scanner → transformer → verifier → reporter):

- `engine/inngest-v3-to-v4.js` — **Transformer** (the codemod)
- `engine/run-migration.js` — **Scanner** + driver + report

## Run

```bash
# clone a target repo into targets/, then:
node engine/run-migration.js targets/<repo>
```

## Deliberately not built yet

Dashboard, GitHub App, multi-repo orchestration, multi-language support, auto-rule-generation from docs, auto-merge. These are gated behind a signed pilot per the plan — building them speculatively is the failure mode the plan exists to prevent.

## Reference

- Inngest v3→v4 migration guide: https://www.inngest.com/docs/reference/typescript/v4/migrations/v3-to-v4
