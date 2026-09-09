# Task 2 report: capture and persist honest local-preview identity

## Status and provenance

Completed Task 2 on base commit `02fa113`, resuming an interrupted implementer.
The interrupted work already contained the shared browser-safe repository
validation extraction, `preview-evidence.ts`, its validator tests, and the
initial `preview-source.test.ts`. I preserved those uncommitted changes and did
not redo Task 1's runner-helper relocation.

At resume time, the strict validator tests were already reported GREEN 2/2. I
confirmed that state locally. The capture tests had been written but no capture
helper existed; this supplied a fresh, observable RED for the resumed work.

## Implemented behavior and interfaces

- Added the Node-free `@api-migrator/app/preview-evidence` package subpath.
- Exported `PreviewSourceIdentity`, `LocalPreviewExecution`, and
  `validateLocalPreviewExecution(value: unknown): LocalPreviewExecution`.
- Kept slug and branch behavior aligned by moving the pure validation contracts
  into `repository-validation.ts` and delegating the existing repository API to
  them.
- Validation is exact and detached: it rejects unknown/missing fields, invalid
  version/kind/discriminants, unsafe repository IDs, invalid slugs/branches,
  mixed Git object formats, and malformed digests.
- Added `captureLocalPreviewExecution(input, internalDependencies?)` as a
  server-only helper. Its production input contains the checkout, trusted slug,
  base branch/commit/tree, exact canonical manifest JSON, and existing read auth
  or null. The optional narrow repository transport exists only for internal
  tests and is not part of browser or migration input.
- Capture performs one `repos.get` with `request.timeout = 10_000`, reuses the
  existing authenticated read client when present, and otherwise constructs an
  anonymous Octokit client with no token. It checks normalized `full_name`,
  positive safe repository/owner IDs, and pinned GitHub App repository IDs when
  available.
- Metadata errors or mismatches produce only
  `repository_identity_unavailable`. Canonical bundle rejection produces only
  `source_bundle_unavailable`. Raw errors and source bytes are discarded.
- Successful capture uses the canonical Task 1 app source-bundle helper and
  returns only repository/base identity plus manifest and archive digests.
- `migrateRepo` now resolves both base commit and tree, captures evidence before
  copying or executing repository code, and attaches the record to the
  sanitized report. Capture unavailability remains non-authorizing and does not
  block the existing preview path.
- Added `AppMigrationReport extends MigrationReport` with optional
  `previewExecution`; the engine report and database schema remain unchanged.
- Sanitization validates and detaches supplied evidence, rejects malformed
  evidence, preserves absent legacy metadata as absent, and continues stripping
  raw output.
- App result, campaign result, queue fallback, and publication-attempt audit
  types now use `AppMigrationReport`.
- Preflight hashing validates and binds present execution evidence. Omitting the
  field retains the pinned legacy preflight hash.
- Existing report JSON persistence was exercised through real SQLite
  `createRun`/`updateRun`/`getRun`; no column or engine dependency was added.

## TDD evidence

### Inherited validator cycle

The validator production and test files predated this resumed turn. I did not
claim a new RED for them. Resume confirmation showed both validator tests GREEN.

Command:

```text
npm run test --workspace @api-migrator/app -- --test-name-pattern='local preview evidence'
```

Relevant result before further production edits:

```text
✔ validates captured and explicitly unavailable local preview evidence as detached data
✔ rejects malformed versions, kinds, discriminants, identities, and unknown fields
```

### Capture RED

Command:

```text
npm run test --workspace @api-migrator/app -- --test-name-pattern='local preview evidence'
```

Expected failure:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/app/src/preview-source.js'
✖ test/preview-source.test.ts
tests 104; pass 103; fail 1
```

The failure was expected because the behavior tests imported the required
capture helper before that production module existed.

### Capture GREEN

Command:

```text
node --import tsx --test packages/app/test/preview-source.test.ts
```

Result:

```text
✔ captures exact canonical bundle identity with one bounded repository metadata read
✔ source, base, canonical manifest, and deployment changes produce different identities
✔ metadata failures, mismatches, unsafe IDs, and pinned App identity drift never fabricate identity
✔ dirty, symlinked, and oversized source bundles remain explicit unavailable local previews
tests 4; pass 4; fail 0
```

### Report and preflight RED

Command:

```text
node --import tsx --test packages/app/test/report.test.ts packages/app/test/publication.test.ts
```

Expected failures:

```text
✖ preflight ids bind valid local preview source identity and explicit unavailability
  Expected 1 unique digest; expected 11
✖ app-boundary reports preserve only detached valid local preview evidence
  actual undefined; expected captured evidence
tests 20; pass 18; fail 2
```

The failures demonstrated that evidence was neither preserved by sanitization
nor included in preflight identity before implementation.

### Report and preflight GREEN

Command:

```text
node --import tsx --test packages/app/test/report.test.ts packages/app/test/publication.test.ts
```

Result:

```text
tests 20; pass 20; fail 0
```

### SQLite round trip

Command:

```text
node --import tsx --test packages/db/test/repo.test.ts
```

Result:

```text
tests 2; pass 2; fail 0
```

This is a characterization of the existing report JSON column: the execution
record survives real create/update/get persistence without a schema change.

## Final verification

Command:

```text
npm run build:packages && npm run test --workspace @api-migrator/app && npm run typecheck --workspace @api-migrator/app
```

Result:

```text
engine, db, app, and runner builds: exit 0
app tests: 109 passed, 0 failed
app typecheck: exit 0
```

The browser-safe package export was then imported successfully from built
output. The capture suite was also rerun under hostile inherited
`commit.gpgSign=true` and an invalid `gpg.program`; all 4 tests passed because
the fixture now allowlists its environment, disables global/system Git config,
and forces signing off.

## Files changed

- `.superpowers/sdd/2026-09-08-preview-source-identity-plan/task-2-report.md`
- `packages/app/package.json`
- `packages/app/src/campaign/runner.ts`
- `packages/app/src/github.ts`
- `packages/app/src/index.ts`
- `packages/app/src/preview-evidence.ts`
- `packages/app/src/preview-source.ts`
- `packages/app/src/publication.ts`
- `packages/app/src/queue.ts`
- `packages/app/src/report.ts`
- `packages/app/src/repository-validation.ts`
- `packages/app/src/repository.ts`
- `packages/app/test/preview-evidence.test.ts`
- `packages/app/test/preview-source.test.ts`
- `packages/app/test/publication.test.ts`
- `packages/app/test/report.test.ts`
- `packages/db/test/repo.test.ts`

## Self-review and concerns

I reviewed the complete scoped diff against the Task 2 brief and full
specification. The browser-safe module imports only the pure repository
validator; the server-only capture module owns Octokit, auth typing, and bundle
creation. No raw API error, source byte, token, browser-supplied identity, new
database column, GitHub mutation, credential change, external repository run,
push, or merge was introduced.

No correctness concerns remain within Task 2. Browser presentation, receipts,
HTTP publication gates, and final anonymous live acceptance belong to later
tasks/the controller and were intentionally not implemented here.
