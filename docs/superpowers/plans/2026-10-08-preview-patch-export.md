# Local Preview Patch Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export an inspectable local preview patch bound to its candidate tree.

**Architecture:** Capture raw staged Git diff bytes after artifact validation in
the existing disposable preview clone. Write a private, new-only external bundle
through a focused helper; leave reports, console storage and publication gates unchanged.

**Tech Stack:** TypeScript, Node 22, Git, node:test; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-08-preview-patch-export.md`

## Global Constraints

- Node 22; no new dependency or cloud mutation.
- Exact author and committer: `Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>`.
- No assistant attribution; load and follow github-commit-identity before any commit.
- Local preview only; never enable or weaken the publication/runner gates.
- Patch output limit: 8 MiB. Directory mode: 0700. File mode: 0600.
- Do not retain source bytes in logs, reports, database records or console responses.
- Reject Windows until equivalent ACL enforcement exists.

## Review Focus

- Non-UTF-8 and binary changes reconstruct the exact staged candidate, not a lossy rendering.
- Existing or symlinked output paths are rejected without replacing user data.
- Invalid export options fail before clone, credential acquisition or remote operations.
- Blocked and empty previews retain honest status and deterministic receipt bindings.
- Failed or oversized exports never leave a receipt claiming successful completion.

---

### Task 1: Private exact-patch bundle and preview CLI integration

**Files:**
- Create: `packages/app/src/preview-bundle.ts`, `packages/app/test/preview-bundle.test.ts`.
- Modify: `packages/app/src/github.ts`, `packages/app/src/cli-args.ts`, `packages/app/src/cli.ts`.
- Test: `packages/app/test/cli-args.test.ts`, `packages/app/test/github-preview-source.test.ts`.
- Documentation: controller updates `README.md` after the interface is verified.

**Interfaces:**
- Consumes: staged candidate clone and existing `PublicationOutcome` metadata from `migrateRepo`.
- Produces: `PreviewArgs.previewBundlePath?: string`, `MigrateRepoInput.previewBundlePath?: string`.
- Produces: optional `MigrateRepoResult.previewBundle` containing bundle path and receipt metadata only.
- Helper signatures: `validatePreviewBundlePath(path: string): string` returns canonical validated path;
  `writePreviewBundle(input: PreviewBundleInput): PreviewBundleResult` captures and writes the bundle.
  Define these focused types in `preview-bundle.ts`; do not export the helper as a publication API.

- [x] Write CLI tests asserting `--preview-bundle` parses once, requires a value,
  rejects relative paths and preserves existing flags. Run
  `node --import tsx --test packages/app/test/cli-args.test.ts`; observe expected RED.
- [x] Add the minimal strict parser support. Rerun that command; expect PASS.
- [x] Write real-Git export tests: apply patch to a second checkout of base and
  assert `git write-tree === receipt.candidateTreeSha`; assert SHA-256/byte length,
  binary/non-UTF-8 preservation, mode/add/delete handling, 0700/0600 permissions,
  new-only destination, rejected symlinks and workspace paths, 8 MiB limit and
  incomplete-output cleanup. Reuse the fixture identity verification helper.
  Observe expected failures before implementing the writer.
- [x] Implement bounded raw-buffer diff capture and exclusive private output in
  `preview-bundle.ts`. Receipt is written last; errors must not disclose source.
  Run `node --import tsx --test packages/app/test/preview-bundle.test.ts`; expect PASS.
- [x] Add integration tests to the existing real-Git preview seam: default export
  absent, explicit export bound to actual candidate, blocked and no-change results,
  and privileged/invalid-path rejection before external callbacks. Observe RED.
- [x] Wire export into `github.ts` before preview returns and final cleanup, and
  CLI opt-in/output summary into `cli.ts`. No raw patch output. Rerun all three
  focused test files; expect PASS.
- [x] Run the complete test suite and typechecks under Node 22. Controller's
  Docker-enabled `npm run ci` covered these plus operations/build/packaging checks:
  1,615 passed, zero failures/skips. Independent review and scoped fixes complete.
- [x] Self-review and report TDD evidence, changed files and remaining concerns.
  Do not commit yet; controller commits the reviewed, fully verified increment.
