# Preview Source Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Bind and display exact local-preview input identity without enabling publication.
**Architecture:** Move pure bundle helpers into app, add app-owned preview evidence to stored report JSON, then issue a source-bound local receipt and display honest provenance.
**Tech Stack:** TypeScript, Node test runner/tsx, Git, existing SQLite storage, Next.js, existing Docker runner image.
**Spec:** `docs/plans/2026-09-08-preview-source-identity-spec.md`.

## Global Constraints

- One canonical bundle implementation; preserve runner compatibility and existing bytes.
- No app-to-runner dependency, new infrastructure, paid services, signing activation or professional repositories.
- Local input identity is not independently verified execution evidence and never grants publication authority.
- No source bytes or raw command output in durable reports, receipts or browser responses.
- Missing legacy evidence remains unclassified; malformed evidence is not promoted.
- All three post-preview console actions remain unconditionally unavailable.
- No browser-selected repository IDs, digests, paths, commands, signer keys or provider URLs.
- Implement in the existing isolated feature worktree; preserve unrelated work; do not merge the resulting PR.

## Task 1: Share canonical source bundle helpers without changing bytes

**Files:** move `packages/runner/src/source-bundle.ts` to `packages/app/src/runner-source-bundle.ts`; move `packages/runner/src/git-tree.ts` to `packages/app/src/runner-git-tree.ts`; create compatibility re-exports at both old paths; modify `packages/app/src/runner-internal.ts`; add compatibility coverage in `packages/runner/test/source-bundle.test.ts` (a separate fixture helper/file is allowed).

- [x] Read the full source spec and relevant existing source-bundle/Git-tree code. No subagents. Work only on this task's files, and use apply_patch for edits.
- [x] Before the move, add a deterministic Git fixture (fixed commit author/committer/timestamp, explicit SHA-1 repo, fixed modes and bytes) and capture its baseline literal bundle digest and exact bytes (a small base64 fixture is acceptable). Prove the pinned fixture passes against the ORIGINAL implementation.
- [x] Add a compatibility import/test targeting the new app internal surface and observe the expected RED missing export failure.
- [x] Move the implementations, changing only the relative Git-tree import. Explicitly re-export all existing symbols from runner's old paths using app/runner-internal. Add the moved symbols to app's runner-internal exports; keep this surface credential-free.
- [x] Rebuild dependencies in existing order; assert pre-move fixture bytes/digest match app and runner APIs, parse/extraction round trip and Git-object results are compatible. Existing source-bundle rejection tests remain unchanged and pass.
- [x] Run `npm run build:packages` and the runner test suite once (check package scripts for the exact build alias). Self-review diff for byte-format changes or new dependencies, then commit only task files.
- [x] Report RED/GREEN commands and key output, fixture baseline digest, moved/exported symbols, commit and concerns to the assigned report file.

## Task 2: Capture and persist honest local-preview identity

**Files:** create `packages/app/src/preview-evidence.ts` (browser-safe types/strict validator), `packages/app/src/preview-source.ts` (trusted server discovery and bundle capture), tests `packages/app/test/preview-evidence.test.ts` and `preview-source.test.ts`; modify app `package.json`, `src/report.ts`, `src/github.ts`, `src/publication.ts`, `src/campaign/runner.ts`, `src/index.ts` and relevant report/publication/campaign tests. Existing DB API tests may be extended for report JSON round trip; do not add a DB column or engine dependency back to app.

- [x] Read the full spec. No subagents. Write new behavior tests and observe RED before production edits. Use only this task's files and apply_patch.
- [x] Export `PreviewSourceIdentity`, `LocalPreviewExecution`, and `validateLocalPreviewExecution(value: unknown): LocalPreviewExecution` from a Node-free `@api-migrator/app/preview-evidence` subpath. Implement exact shape/discriminant validation per spec and detached results. Match existing slug/branch contracts without importing Node-backed repository code; bounded pure validation may be factored if necessary.
- [x] Define/export `AppMigrationReport extends MigrationReport` with optional `previewExecution`. Update app result/campaign/audit typing without modifying the engine report. Sanitizer preserves a validated copy only when provided, rejects malformed values, leaves missing legacy fields absent and keeps raw logs stripped.
- [x] Implement `captureLocalPreviewExecution` as a server-only helper. Inputs are checkoutPath, trusted normalized slug, base branch/sha/treeSha, exact canonical manifestJson and an existing read AuthResult or null. Its narrow GitHub read transport may be injected only internally for tests, never through migrateRepo/browser input. Use fixed repos.get with a 10-second timeout; anonymous means explicitly no token. Check normalized full_name and safe numeric IDs, matching pinned App IDs when available. Metadata failure/mismatch gives only `repository_identity_unavailable`; bundle rejection gives only `source_bundle_unavailable`; never reflect raw errors.
- [x] On valid discovery create the canonical bundle using Task 1's app helper, return only repository/base/digests, discard bytes. Test exact captured digest against the actual bundle for a clean local Git fixture; source/base/manifest/deployment changes change identity; dirty/symlink/oversized failure is explicit; wrong slug/IDs and API failure never fabricate identity or select credentials.
- [x] Call capture from migrateRepo after clone/base resolution and BEFORE copy/migration; attach its result to sanitized report. No new GitHub actions beyond scoped read discovery. Local preview migration proceeds when capture is explicitly unavailable.
- [x] Bind valid previewExecution into createPreflightId only when present. Tests show differing source/base/manifest/IDs/kind-discriminant evidence cannot retain a preflight; legacy missing-field hashes keep prior behavior; sanitation and actual SQLite createRun/updateRun/get round-trip preserve evidence.
- [x] Build app/dependencies; run focused tests during iteration, app suite/typecheck once before commit. Self-review, commit task files and report TDD evidence, commands/output, behavior and any concerns.

## Task 3: Bind local receipts, display provenance, prove the server remains closed

**Files:** `packages/console/lib/approval.ts`, `lib/preview.ts`, `lib/run-history.ts`, `app/api/campaigns/[id]/runs/route.ts`, `app/campaigns/[id]/RunForm.tsx`, `app/campaigns/[id]/page.tsx`, related console tests/new runtime-route test; README/docs as needed to describe this slice. Keep runner-capability.ts unconditionally closed. Extract focused helper/component if needed rather than duplicating validation or growing unrelated UI.

- [x] Read full spec and preceding task interfaces. Use React best-practices and frontend-testing-debugging skills before UI edits. No subagents. TDD new receipt/view/server behavior; apply_patch for edits.
- [x] Keep v1 receipt verifier compatibility. Extend createPreviewReceipt with optional server-supplied `execution`; provided evidence emits v2 with exact extra root field, `preview-v2` prefix and `api-migrator:console-preview-receipt:v2\0` HMAC domain. Validate the strict local evidence with app/preview-evidence. Enforce captured source slug/manifest matches enclosing receipt; reject future completion and cap expiry to original completion + 10 minutes. V1 paths stay compatible; v2 verification rejects impossible/overlong lifetime and malformed metadata. Reject any v2 receipt at the owner-challenge bridge, and reject reserved v3/verified-runner kinds entirely. Do not create a fake capability or implement the future provider.
- [x] Actual preview route passes only ready.report.previewExecution from server to receipt creation. Never use request execution/IDs/digests. New normal runs produce v2; absent legacy report evidence does not get invented. Test HMAC tamper (source/base/IDs/manifest/output), wrong campaign, deployment change, expiry/future/lifetime, v1 shape injection and local-to-attested promotion rejection.
- [x] Add source evidence view to fresh and stored runs with safe browser-only validation. Valid local evidence always says `Local preview — not independently attested`; captured values show source digest, base tree and repository/owner IDs. Null source shows a human-readable reason. Missing legacy shows `Not recorded (legacy)`; invalid shows invalid/unavailable, never trusted. Parse stored report JSON with a size bound. No raw error strings/source/envelopes in UI. Keep buttons disabled.
- [x] Add runtime tests invoking the actual POST route with NextRequest, a temporary real DB/campaign and legacy/local/forged/future-shaped inputs for each of prepare_owner_challenge, prepare_publish, publish. Assert 503, zero new runs, no consumed valid receipt/approval, and available run lock afterward. No GitHub/source execution. Exercise malformed and missing evidence as well; tests must not only search source text. Use trusted test fixtures for receipts/approvals where needed.
- [x] Run focused console tests during iteration, then console suite/typecheck/build. Check fresh/history view-model tests (captured/unavailable/legacy/invalid). Root will do rendered browser and full image validation separately. Self-review, commit task files and report RED/GREEN evidence, commands, results and concerns.

## Acceptance-driven packaging correction

Actual Docker verification at `5258902` found that the explicit image runtime
allowlist had not followed the canonical-helper relocation and new pure report
dependencies. The original task file lists omitted this packaging dependency.
The same acceptance fix round as the receipt-verifier correction therefore
updates `ops/publication-runner/image/prepare-runtime-root.mjs` and its test:
include only the required credential-free modules, execute an assembled real
runtime in regression coverage, and preserve privileged-module exclusions.
No Docker pins, execution permissions, infrastructure or publication gates may
be weakened to make the image pass.

## Controller acceptance and handoff

- [ ] Review each task (spec and quality), then whole-branch review with concrete findings resolved.
- [x] Run fresh `npm run ci` and actual runner image build, verify and phase integration.
- [x] Use a disposable local console DB and browser to inspect captured, unavailable and legacy history/provenance and verify unavailable API behavior. Do not run campaigns against professional repositories.
- [x] Update documentation with completed first slice vs remaining protected service/deployment gates and verification evidence. No completion percentage or billing claim.
- [ ] Commit docs, open a feature PR against personal `Abhishekpundir23/api-migrator`, verify its head and checks; keep it open for the user's merge decision.

## Verification record — 2026-09-09

Implementation source head: `1261caf`. All three task reviews and their scoped
fix reviews passed. Whole-branch review and GitHub handoff are subsequent gates.

`API_MIGRATOR_DOCKER_TEST=1 npm run ci` passed on macOS with host Node 26.5.0:

| Suite | Passed | Failed / skipped |
| --- | ---: | ---: |
| App | 112 | 0 / 0 |
| Console | 41 | 0 / 0 |
| Database | 26 | 0 / 0 |
| Engine, including real Docker verification | 137 | 0 / 0 |
| Runner | 21 | 0 / 0 |
| Pilot validation | 26 | 0 / 0 |
| Gateway | 16 | 0 / 0 |
| Deployment contracts | 149 | 0 / 0 |
| Runtime image assembly | 2 | 0 / 0 |
| Total | 530 | 0 / 0 |

Package builds, all workspace typechecks, shell checks, pilot example validation
and production console build also passed. The pre-existing Next/Turbopack NFT
trace warning remains; build output is not warning-free.

`runner:image:build`, `runner:image:verify` and `runner:image:integration` passed
for the actual pinned Node 22 image (Node 22.23.2). Verified image identity:
`sha256:d2bfa872655bbfc037dbb9d7c974fd8ca935920f5d6b0bfcbb55591dac8e6895`.
All four phases ran successfully with the full Inngest transform fixture:

- Plan: `sha256:30c61e6c0c272b25c2437a2b575a9645442bd7c0e2335bc174d27c4fb538f3ca`
- Evidence: `sha256:100c11d98fa3ebf9d0fd53a9d681196bdb855a04a9988bbf96bce88ad4c93d3a`
- Artifact: `sha256:b68fd1359e25c24bdee267e0a55460fe884dde5a6b93484cda96beca50dca08b`

Docker Desktop's credential helper stalled public image lookup. A temporary
anonymous Docker client configuration against the same local daemon resolved
the fetch; image pins and user configuration were not changed. This is a local
functional integration test, with `securityDrill: false`, not an independent
execution attestation or authorization to activate a host.

Rendered Chromium QA used a disposable SQLite database and localhost production
server at 1440x1050 and 390x844. Captured, unavailable, legacy and invalid history
states rendered correctly; the fresh-preview renderer fixture displayed source
identity, and editing the repository cleared prior preview state. There was no
document-level mobile overflow or browser console/page error. Twelve real HTTP
post-preview requests returned 503 with no new runs. The separate automated
route test executes 18 real POST-handler cases and checks receipt/approval and
lock non-consumption. The fresh browser response is a renderer fixture, not a
real migration or attestation.

An intermittent Next server `aborted`/`ECONNRESET` diagnostic was observed during
QA navigation/refresh. Browser request events identify canceled local `_rsc`
page-data fetches, not failed migration API calls; the server remained alive and
all assertions passed. Its baseline origin is not established, so it is retained
as a final-review observation rather than described as resolved.

No cloud resources, signing provider, professional repository access or
publication capability were enabled. The protected service, independent trust
boundary, deployment drill and supervised end-to-end paid pilot remain open.
