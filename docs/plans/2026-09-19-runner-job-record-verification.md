# Runner job record verification — 2026-09-19

Status: local implementation and independent review are complete. The whole-branch review's successful-review CAS race and missing intent assertions were fixed and accepted in the scoped re-review; no new Critical/Important breakage was found. The non-blocking NFT diagnostic remains explicitly deferred. This is not deployed protected custody, a security drill, or pilot completion. Original Task 5 evidence is preserved below as historical evidence, not represented as testing the later fix.

## Original Task 5 tested state

- Code and tests: `3d007cf02d4d84d52793a2646f8a52acb89d207f` — `Verify runner job recovery and isolation`.
- Task 5 base: `5a02dd59fc91737ab566d112ed56ea5e5bef2622`.
- Local branch: `codex/protected-runner-job-records`; no push, merge, or history rewrite.
- Runtime: Node **v22.23.2**, macOS host; Docker server **29.6.1**. No host dependency or tool installation.
- Every Node/npm command below prepended `/Users/abhi/.npm/_npx/5dad66f2cb301fc2/node_modules/node/bin` to `PATH`.
- Focused tests and `npm test` ran before the code commit against precisely the code/test bytes subsequently committed in `3d007cf`. CI, image build, and image verification ran on that commit. During image integration, only README and plan/spec documentation edits were added; no implementation, test, image input, lockfile, or dependency changed. The report is delivered in a later documentation-only commit.

Both author and committer of the code commit were checked before and after committing as `Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>`. Disposable Git fixtures use the existing exact-identity pre/post guards too. No attribution trailers were added.

## Commands and actual results

All commands exited **0** unless explicitly identified as RED below. TAP counts were summed from the captured `# tests`, `# fail`, and `# skipped` lines, not copied from prior reports.

| Command | Result |
| --- | --- |
| `npm run build:packages` | All four package builds passed |
| `node --import tsx --test packages/app/test/runner-job-*.test.ts packages/db/test/runner-job-store.test.ts` | **111/111**, no failures, cancellations, or skips |
| `node --import tsx --test packages/app/test/package-surface.test.ts packages/console/test/runner-capability.test.ts packages/console/test/runs-route-runtime.test.ts` | **9/9**, no failures, cancellations, or skips |
| `API_MIGRATOR_DOCKER_TEST=1 npm test` | **734/734**: app 469, console 42, DB 65, engine 137, runner 21; no failures, cancellations, or skips |
| `API_MIGRATOR_DOCKER_TEST=1 npm run ci` | **947/947**: workspace 734 + pilot 26 + gateway 16 + deployment 169 + image 2; typechecks, shell checks, example validation, and console production build passed; no test failures, cancellations, or skips |
| `npm run runner:image:build` | Real local Docker image built |
| `npm run runner:image:verify` | Real container configuration and module/dependency absence assertions passed |
| `npm run runner:image:integration` | Real prepare/install/migrate/verify fixture passed; `securityDrill: false` |
| `git diff --check` | Passed before code commit and after documentation edits |

The Docker-dependent install/offline-typecheck test executed in both full suite runs. No job-record test was skipped. CI did emit the non-fatal console warning quoted below; test success does not mean warning-free build output. The image build printed an npm update notice; no update was performed.

Captured local logs (ephemeral, not deliverable authority):

- Focused: `/tmp/runner-job-task5-focused.y0BKrV`
- Full workspace suite: `/tmp/runner-job-task5-npm-test.ljW8Ph`
- Full CI: `/tmp/runner-job-task5-ci.1Zuh1F`
- Image build: `/tmp/runner-job-task5-image-build.v4dQdf`
- Image verification: `/tmp/runner-job-task5-image-verify.1JBB8Q`
- Image integration: `/tmp/runner-job-task5-image-integration.dR8GiZ`

### Real image identity

Tag: `api-migrator-runner:local`; platform: `linux/arm64`.

Verified Docker image ID: `sha256:beaa9f60b08ea74e6f9c87a56d783eef843256735a4343ea0650cecea5baae37`.

The container itself was checked for absence of all six job-record app modules, `@api-migrator/db`, and `better-sqlite3`. The existing runtime module/dependency allowlist was not changed.

The integration command returned:

- `phaseIntegration: passed`
- `securityDrill: false`
- Plan digest: `sha256:91b8179909521ad1a7852e486d46f526f6c46bfcb5276665af346d5f3cea9ec4`
- Evidence digest: `sha256:f73a9e33d5c1e28c9c8eef2f49d5276385178c2b5d1086ce2f9e1d20b88e481c`

These identify disposable functional fixtures, not attested live execution or publication permission.

## Recovery and isolation evidence

Child processes use `fork` with `execArgv: ["--import", "tsx"]`, explicit IPC barriers, and 10-second test timeouts. Before-commit barriers occur after tentative writes inside the transaction; after-commit barriers occur before result delivery. The parent registers listeners before dispatch/termination, kills only its own child PID, awaits exit before reopening, and terminates/awaits remaining owned children during cleanup. No timing sleeps guess commit state.

| Interrupted operation | Before commit | After commit |
| --- | --- | --- |
| Initialize | Partial store fails closed; normal reopen and reinitialization do not invent or repair it | Committed schema/store UUID reopens |
| Prepare | No job row exposed | Exactly one revision-one job; retry returns that same job and nonce identity |
| Review | Original revision one remains byte-equivalent | Complete revision two strictly decodes |
| Retain evidence | Original reviewed revision two remains byte-equivalent | Revision three reopens and the genuine verifier reacquires exactly the retained signed identity without renewal |
| Observe trusted time | Original high-water 1000 remains | High-water 2000 survives; 1999 is rejected |

Two freshly started, explicitly opened processes prepare concurrently after a shared readiness boundary. Identical intent returns the same winning record from both processes. Conflicting intent yields one record and the fixed `job_conflict` failure with no loser identity. A held write transaction preserves committed reads and makes its contender fail with fixed `store_unavailable` within the 250 ms busy budget plus 1000 ms scheduling allowance; no row is changed.

A reopened fixture contains an expired job and a newer current job prepared at distinct trusted times with fresh DNS observation metadata. The expired row remains strictly decodable and inspectable but fails `assertJobCurrent` with `job_expired`; the current row passes. Neither row acquires evidence from reopening.

Built package surfaces expose only the documented internal APIs. Root, console, preview, and runner surfaces cannot expose job service/storage/test hooks. Built import/factory tests trap network entry points before import, retain module-loader filesystem access during import, and install filesystem traps before constructing the factory. Import and construction leave the missing store path absent; invalid configuration and explicit opening of a missing store return fixed failures. A null-evidence service prepares/reviews validated records but fails evidence acquisition closed.

Actual route tests continue to return 503 for all three protected actions, including caller-supplied retained-job/config claims. No run is added, no evidence network call occurs, and challenge/approval inputs remain unconsumed at the gate. Existing source import guards were extended; the runtime route, built exports, runtime-root, and actual-container assertions provide the behavioral isolation evidence.

## RED/GREEN and the macOS correction

The initial recovery test was written before its worker. Running:

```sh
node --import tsx --test --test-name-pattern='review interrupted before_commit' packages/app/test/runner-job-recovery.test.ts
```

failed **0/1**, exit 1, with `worker exited before review/ready`. This was a missing test-harness failure, not a claimed product defect. Adding the worker made the six prepare/review/retain crash cases pass.

The initial complete recovery run passed **7/9**. The two failures were a same-intent process loser returning `store_unsafe`, and an invalid mixed-age fixture that reused an old DNS observation. The fixture was corrected to provide fresh bounded DNS observations; no DNS policy or plan lifetime was weakened. An explicit post-open barrier isolated concurrent preparation from opening, but `store_unsafe` still reproduced (a subsequent full recovery run remained **7/9**). Diagnostic runs showed the directory inode and mode unchanged while its macOS link count changed from **3 to 4** as SQLite created its allowed rollback journal. All temporary diagnostic logging was removed.

A deterministic regression was then added before the production fix:

```sh
node --import tsx --test --test-name-pattern='held rollback journal' packages/db/test/runner-job-store.test.ts
```

RED: **0/1**, exit 1, `JobStoreError: store_unsafe` at the pinned-directory check, reached by reading committed rows while the child was held after tentative insertion.

The minimal correction separates directory identity from regular-file link count. Directory device/inode/owner/mode remain pinned. Database and journal files still require a single link, and database link-count comparisons remain. The directory-entry allowlist, modes, ownership, symlink checks, journal policy, sync settings, and busy timeout are unchanged. The accepted tradeoff is that a directory link-count anomaly alone no longer causes rejection; the remaining identity and entry checks still apply.

GREEN:

```sh
node --import tsx --test packages/app/test/runner-job-recovery.test.ts packages/db/test/runner-job-store.test.ts
```

passed **48/48**, exit 0, with no skips, including the deterministic held-journal regression and both process-preparation cases. The final focused **111/111** and complete suite/CI results above cover the committed version. No other feature implementation was changed for Task 5.

## Console build warning

Full CI logged one warning:

```text
Turbopack build encountered 1 warnings:
./packages/console/next.config.mjs
Encountered unexpected file in NFT list
A file was traced that indicates that the whole project was traced unintentionally.
```

The reported import trace was:

```text
App Route:
  ./packages/console/next.config.mjs
  ./packages/app/dist/owner-authorization.js
  ./packages/app/dist/campaign/runner.js
  ./packages/console/app/api/campaigns/[id]/runs/route.ts
```

The complete text is in `/tmp/runner-job-task5-ci.1Zuh1F`. These source paths are unchanged by Task 5, but the warning was **not reproduced on the baseline**, so it is not claimed to be proved pre-existing. The build completed successfully. Whole-branch review found no demonstrated local feature leak or runtime failure and recommended a separate focused diagnostic; the controller explicitly deferred that follow-up. No warning suppression or unrelated build/config change was added. Baseline provenance remains unestablished.

## Remaining gates and limits

- The original Task 5 handoff preceded independent review. Task reviews, whole-branch review and the scoped fix re-review are now complete. The race and intent-coverage findings are addressed by the combined fix below; the NFT diagnostic remains explicitly deferred. Integration and deployment remain separate decisions.
- Store recovery was exercised locally on macOS. SIGKILL recovery with SQLite FULL/fullfsync and file/directory synchronization is not a physical power-loss durability proof or a portability certification.
- Hashes detect inconsistent records, not a malicious same-UID coherent rewrite. A coherent full snapshot restore remains outside the local trust boundary; it is not represented as a passing anti-rollback test. Trusted time during downtime and protected live custody remain unsolved deployment gates.
- Failures after a committed write retain immutable historical metadata; no deletion, backup restore, resubmission, expiry extension, renewal, or automatic repair was added.
- `RUNNER_CAPABILITY_PROVIDER_AVAILABLE` remains false. `prepare_owner_challenge`, `prepare_publish`, and `publish` remain unconditionally blocked before challenge, approval, token, and publication ceremonies. Reserved `preview-v3` remains rejected.
- The job feature does not execute/dispatch source, request credentials, sign externally, upload bundles, consume owner approval, initialize live stores, or mutate accounts/cloud/services. Only the already-existing, explicitly authorized image integration executes its disposable fixture.
- No route/UI/CLI/activation switch, image allowlist, runtime dependency, lockfile, account permission, live custody, push, or merge changed. No fixture keys, bundles, databases, or real credentials are included in this report.

## Final-review combined fix and current evidence

Fix code and tests: **`ff86166d422cbbf034246bb0de49edf8bff3e7fe` — `Accept retained descendants after successful review CAS`**, based on `7abbe204fdcf197f1a3af0e7cff27ad555bd4c3b`. The later evidence commit changes only this document. No implementation, test, image input, lockfile, or dependency changed after the tested code commit. Scoped re-review subsequently accepted both code/test fixes; see the final handoff below.

### Finding and bounded correction

The review CAS commits before the adapter synchronizes and reads the result. A concurrent genuine acquisition can advance revision two to revision three before that readback. The successful-review path incorrectly required byte-identical revision two and reported `store_corrupt` for this legitimate descendant.

The fix accepts only a strictly validated `evidence_retained` descendant with exactly matching immutable preparation fields and reviewed context. The existing original-expiry and durable time-observation checks still run before success. Changed fields/structural corruption remain rejected; retained expiry is never renewed; CAS-loss handling is unchanged.

Four deterministic regressions use the real SQLite adapter and its after-commit hook. A bounded child opens the disposable store, acquires genuinely signed fixture evidence through the real verifier (two registry reads and one envelope fetch), commits revision three, and exits before the parent's readback. The cases cover an identical descendant, exact retained expiry, changed preparation, and changed review. Changed-field cases deliberately substitute a coherent reviewed fixture before genuine child verification; these are operation-relative rejection tests, not claims to prevent malicious same-UID rewrites. No fake successful verifier, fabricated retained identity, timing sleep, or production test export was introduced. All cases assert that the retained historical row remains byte-equivalent after parent success/failure.

Valid egress and absolute-expiry variations now independently prove intent binding, alongside the existing image variation. Valid changed egress/expiry also produce preparation conflicts while preserving the original row and successful identical retry.

### Fresh execution evidence

Commands below used the same pinned Node **v22.23.2** PATH as above and Docker **29.6.1**. All exited **0** except the explicit TDD RED. Focused suites, package build and `npm test` ran against the exact code/test bytes then committed as `ff86166`; full CI and real image checks ran on that commit. Documentation edits only began during image integration.

| Command | Current result |
| --- | --- |
| `node --import tsx --test --test-name-pattern='successful review CAS readback' packages/app/test/runner-job-review.test.ts` before production fix | RED: **4 tests, 2 passed, 2 failed**, no skips/cancellations; valid descendant incorrectly raised `store_corrupt`, expired descendant raised `store_corrupt` instead of `job_expired`; changed-field negatives passed |
| `node --import tsx --test packages/app/test/runner-job-review.test.ts packages/app/test/runner-job-record-contract.test.ts packages/app/test/runner-job-preparation.test.ts` after fix | GREEN: **35/35**, no failures/skips/cancellations |
| `npm run build:packages` | Four package builds passed |
| `node --import tsx --test packages/app/test/runner-job-*.test.ts packages/db/test/runner-job-store.test.ts` | **117/117**, no failures/skips/cancellations |
| `API_MIGRATOR_DOCKER_TEST=1 npm test` | **740/740**: app 475, console 42, DB 65, engine 137, runner 21; no failures/skips/cancellations |
| `API_MIGRATOR_DOCKER_TEST=1 npm run ci` | **953/953**: workspace 740 + pilot 26 + gateway 16 + deployment 169 + image 2; package builds, workspace typechecks, shell checks, example validation and console production build passed; no failures/skips/cancellations |
| `npm run runner:image:build` | Real local Docker image built |
| `npm run runner:image:verify` | Real configuration and job-module/native-dependency absence checks passed |
| `npm run runner:image:integration` | Real disposable prepare/install/migrate/verify fixture passed; `securityDrill: false` |
| `git diff --check` | Passed before code commit and after evidence documentation edits |

Both full workspace runs executed the Docker install/offline-typecheck test; none of the job-record tests was skipped. Counts were checked from current TAP summaries, not carried forward from Task 5. The console build emitted the same one nonfatal NFT warning and import trace quoted above. The image build emitted an npm update notice (`10.9.8 -> 12.0.2`); no update was performed. The explicitly deferred NFT diagnostic remains a follow-up, without baseline provenance or warning suppression.

Verified tag: `api-migrator-runner:local`, platform `linux/arm64`, image ID **`sha256:94b7625318de8912c8a7c07e72d4295d98e1d400666299ff730db340934584d5`**.

Real integration returned `phaseIntegration: passed`, `securityDrill: false`, plan digest `sha256:3b57dc3c7ee3fcf25ccfab4925e83e031a1e43a5eb2459370627897444f2bac0`, and evidence digest `sha256:ad123d5a8471f702115ce7bd822a001d209e4439aefa5198806ff1e6e91ee28d`. These identify only the disposable functional fixture, not attested live execution, publication permission, a security drill, or pilot completion.

Current captured logs (ephemeral local evidence):

- `/tmp/runner-job-final-fix-focused.log`
- `/tmp/runner-job-final-fix-npm-test.log`
- `/tmp/runner-job-final-fix-ci.log`
- `/tmp/runner-job-final-fix-image-build.log`
- `/tmp/runner-job-final-fix-image-verify.log`
- `/tmp/runner-job-final-fix-image-integration.log`

The code commit's author and committer were verified before and after commit as **`Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>`**. The same exact pre/post identity guards apply to disposable fixture commits. No amend, push, merge, external issue/task, progress-ledger edit, new dependency, build configuration change, or live service/store/account/cloud mutation occurred. All remaining gates and trust limits above continue to apply.

## Final independent review and local handoff

The whole-branch review covered the original complete change against `36bab9c85cd6c95bd0ac27ded0da0d3e44faa293`. The scoped re-review then covered `7abbe204fdcf197f1a3af0e7cff27ad555bd4c3b..e6ee133c7af4264d68c953257ca6bca04dc165bb`: the concurrent retained-descendant fix and independent intent assertions were both **ADDRESSED**, with no new breakage. The NFT warning was **not technically repaired** and remains the explicitly deferred, non-blocking diagnostic above. No unresolved Critical/Important finding remains from these reviews.

The controller independently reran `API_MIGRATOR_DOCKER_TEST=1 npm run ci` under pinned Node v22.23.2 on `e6ee133c7af4264d68c953257ca6bca04dc165bb`: exit **0**, **953 passed**, **0 failed/skipped/cancelled**. Raw TAP subtotals were 475 + 42 + 65 + 137 + 21 + 26 + 16 + 169 + 2. Package builds, typechecks, shell checks, example validation and console build passed; the same NFT warning remained visible. Ephemeral log: `/tmp/runner-job-final-controller-ci.oLm4jW`.

The controller also read the actual image integration result and independently inspected the current image ID, matching `sha256:94b7625318de8912c8a7c07e72d4295d98e1d400666299ff730db340934584d5 linux/arm64`. This final closeout changes documentation only. The branch remains local and unmerged, with publication blocked and all deployment/trust limits above unchanged. No cloud resources, professional accounts, GitHub App permissions or live stores were changed.
