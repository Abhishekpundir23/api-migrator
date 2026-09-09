# Protected runner evidence: software verification

Date: 2026-09-09. Scope: a read-only evidence client, not publication activation.

## Tested identity and execution environment

The latest locally tested software commit is
`58e5db205144e15267b858d1772b304e511641c1`
(`fix: classify evidence service status failures`), on
`codex/protected-runner-evidence`. The execution record is committed afterward
as documentation only; its later commit is not represented as the tested code
SHA. The working tree was clean when the single final full-CI command started.

Host verification used Node **v26.5.0**, not Node 22. Docker Engine **29.6.1**,
the existing `desktop-linux` context, its local socket, and an existing isolated
anonymous client configuration were checked before use. No global Docker
configuration, credentials, runtimes, or daemon settings were changed.

The retained earlier image is `api-migrator-runner:local`, with inspected ID
`sha256:f683f75d6ad01bb3ddc4f6480d36ab3e74db58ef0b000b351b3bdd8638df4598`.
It was built and verified on software commit
`cddeab3184811620e46db7a49e1649db944a90be`, before the final transport-only
status fix. A read-only, network-disabled container reported **v22.23.2**, seven
excluded evidence modules, and no app test-helper tree. The transport module is
one of those exclusions, so this fix required no rebuild or retag. The earlier
image remains Node 22 compatibility and exclusion evidence, not proof that the
latest code commit was included in an image. The Dockerfile retains its pinned
Node 22 base digest and unchanged runtime-module allowlist; a current-head
GitHub image build remains a controller gate.

## Fresh commands and results

All commands ran from the repository root unless noted. Docker commands used
`DOCKER_CONFIG=<verified anonymous client directory>` and
`DOCKER_HOST=<verified local socket>`; these private values are deliberately
redacted, not new deployment configuration.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run build:packages` | 0 | Engine, DB, app, runner builds passed |
| `npm run typecheck:workspaces` | 0 | App, console, DB, engine and runner typechecks passed |
| `node --import tsx --test --test-name-pattern='raw TLS rejects (redirect\|missing evidence\|rate limited\|server diagnostics\|service unavailable)' packages/app/test/runner-evidence-transport.test.ts` | 0 | 5 passed, 0 failed/skipped after the source fix |
| `node --import tsx --test packages/app/test/runner-evidence-*.test.ts packages/app/test/package-surface.test.ts` | 0 | 279 passed, 0 failed/skipped |
| `env API_MIGRATOR_DOCKER_TEST=1 DOCKER_CONFIG=<verified> DOCKER_HOST=<verified> npm run ci` | 0 | 810 passed, 0 failed/skipped; builds, workspace types, pilot validation and console build passed on the exact code SHA above |
| `git diff --check` | 0 | No whitespace errors |

Full CI totals (nested tests included, not added again to the focused totals):

| Suite | Passed | Failed / skipped |
| --- | ---: | ---: |
| App | 391 | 0 / 0 |
| Console | 42 | 0 / 0 |
| DB | 26 | 0 / 0 |
| Engine, including Docker install/offline typecheck | 137 | 0 / 0 |
| Runner | 21 | 0 / 0 |
| Pilot validator | 26 | 0 / 0 |
| Ops gateway | 16 | 0 / 0 |
| Ops deployment | 149 | 0 / 0 |
| Ops assembled image | 2 | 0 / 0 |
| Total | **810** | **0 / 0** |

The evidence-focused 279 comprise acquisition 164, contract 9, deadline 11,
registry 24, transport 68, and package surface 3.

The earlier image configuration verification and phase integration were
serialized after overlapping runs had finished. Prepare, install, migrate, and
verify passed on the earlier code commit; the resulting
install/typecheck/test/lint/runtime checks passed with zero blockers or review
entries. The recorded evidence digest was
`sha256:8721687c70e4c75aadc5293383c2c5dc36165616b7ab17a722ea55a781cf65c7`.
The integration explicitly reports `securityDrill: false`; it is neither
latest-code image proof nor evidence of deployed ingress isolation.

The console production build still reports the pre-existing Next/Turbopack
warning **“Encountered unexpected file in NFT list”** in `next.config.mjs`,
through owner-authorization/campaign route tracing. It exits successfully;
this warning was not repaired or represented as clean output.

## Boundary evidence and limits

The built `@api-migrator/app/runner-evidence-internal` namespace exposes exactly
`createRunnerEvidenceClient` at runtime plus the approved consumer types.
Other public namespaces expose no acquisition factory. Package resolution
rejects implementation/readers/test-helper subpaths. A disposable subprocess
installs asynchronous filesystem and HTTPS traps before the built import, then
synchronous traps after module loading. Valid construction and invalid
configuration/policy/clock/CA/port/extra positional arguments cause no observed
I/O. With real filesystem calls restored, valid-context acquisition against
nonexistent protected paths returns only `trust_unavailable`, without network.
The loader's own synchronous source reads are intentionally not trapped.

The actual POST route executes **21 requests**: all three post-preview actions
against seven control shapes, including forged claimed runner evidence and a
client-supplied availability flag. Every request returns the exact existing
503 body, creates zero run rows, and leaves the run lock reusable. Existing
valid preview/operator controls remain usable afterward; the deliberate
second consumption of an operator token still fails. A real production client
is constructed but never acquired. The HTTPS spy is installed before dynamic
factory/route imports in the isolated test process, and records zero calls.
No production route import, hook, flag, or gate was added or temporarily enabled.

The real assembled-runtime test preserves CLI loading, fixed source-bundle
digest and Git blob assertions. It excludes all seven new privileged modules
and the entire app test tree, alongside the old privileged paths. An additional
actual-image read-only check confirms the same exclusions. No allowlist change
was used to make the image load.

The component suite includes real disposable POSIX files, links, FIFOs, aliases,
atomic replacement/revocation, local TLS sockets, genuine disposable signatures,
and raw HTTP framing. Deterministic clocks, inaccessible OS/metadata races,
source-internal dependency seams, malformed request events, and test-only local
CA/loopback transport injection cover otherwise nondeterministic states. The
production factory has no injection interface. IPv6 coverage is endpoint-option
selection, not a live IPv6 connection. Local self-signed trust is not evidence
of a deployed public-PKI service or protected production registry.

Acquisition tests contact no real evidence service, provider, GitHub, npm, or
cloud. Separately, the existing Docker image build/install integration uses
public package/image downloads and disposable migration fixtures; that is not
a live evidence acquisition or publication. No real signing key, client asset,
write-token request, owner approval, remote job, source upload, paid activation,
App scope, merge, or production deployment was introduced.

## RED/GREEN and integration correction

For the final-review status classification fix, the five genuine TLS wire
responses 302, 404, 429, 500, and 503 first failed **0/5** because the transport
returned `evidence_invalid` where the approved contract requires
`evidence_unavailable`. After changing only the final non-200 branch, the same
focused cases passed **5/5** and the full evidence component suite passed
**279/279**. Existing locally detected malformed framing, headers, canonical
JSON, job identifiers, and forbidden information/upgrade/CONNECT responses
remain `evidence_invalid`; native TLS/parser/network failures remain
`evidence_unavailable`; deadline expiry, cleanup, and the no-retry assertion
remain covered.

Before the export existed, package-resolution tests failed. That alone was not
counted as behavioral TDD: a linked no-op factory then produced a genuine
assertion failure (`false !== true` for valid construction; 2/3 passed), followed
by 3/3 passing with the real production re-export. Temporarily leaking the
dependency-injected factory through the new subpath made the exact namespace
test fail (0/1 passed); the mutation was immediately removed and the suite
rebuilt. Existing closed route/image behavior remained green; it was never
activated to manufacture a failure.

The first full CI run exited 1: two acquisition subprocess tests used the shell
cwd, so npm workspace execution duplicated `packages/app` in their imports.
Only the two child cwd options were changed to a repository-root URL derived
from `import.meta.url`. The focused tests failed 0/2 from the app workspace
before the fix, then passed 2/2 from both root and workspace. Fresh full CI passed
before the original Task 6 code commit. The final classification fix did not
repeat pre-commit full CI; one complete full CI run was made on the latest code
SHA above.

## Durable implementation rulings

| Ruling | Decision and reason | Cost if wrong |
| --- | --- | --- |
| R1 | Extract shared signing/attestation fixtures rather than duplicate them; preserve old assertions and clock behavior. | Wider test-only refactor/rework to restore independent fixtures. |
| R2 | Require linked behavioral RED or a focused mutation, not missing-module errors alone. | Additional test iteration, no production expansion. |
| R3 | Apply a recursive descriptor guard inside the digest helper before canonicalization, preventing array getters from executing. | Extra validation pass and rejection of non-plain internal input; valid JSON signed bytes unchanged. |
| R4 | Separate mandatory migration roots from optional code-owned platform exclusions; only optional ENOENT retains lexical checks. | Small internal policy/test adjustment; no public bypass of mandatory roots. |
| R5 | `deadline.check()` returns validated wall-clock time; scheduling keeps remaining time private. | Narrow internal contract/test correction; no timeout extension or new clock override. |
| R6 | Derive the two acquisition-test subprocess cwd values from their module URL, not the invoking shell. | Subprocess fixture-path rework; production code/assertions unchanged. |
| R7 | Keep the final-review-confirmed callback Minor deferred rather than widening the classification fix. The transport rechecks before request construction, expired success is blocked, and late filesystem handles are disposed. | Unnecessary read-only filesystem work can still start on an already-aborted budget; a later callback recheck and regression are needed, with no known authority bypass. |

## Remaining gates

The prior Task 2 **Minor** remains deferred after final review:
`runner-evidence-deadline.ts` queues an operation callback without an immediate
cancellation recheck. If `cap()` expires between `run()` and its microtask,
unnecessary I/O may start with an already-aborted signal; the returned expired
failure and late cleanup remain correct. The final-review classification fix
does not widen into this non-blocking callback change.

Task 6 and whole-branch independent review are complete; their only Important
finding is fixed on the latest code commit above. The single scoped fix
re-review remains controller-owned, as do the feature push, one PR without
merge, and current-head GitHub Node 22 CI/runner-image/hosted-smoke evidence.
No remote Git mutation was performed by this fix wave. Deployment policy
completeness, producer/store/auth integration, independently operated signer,
live trust/configuration, attested `preview-v3` receipts, and publication
activation require separate work and authority. `preview-v1`/`preview-v2`
remain local, `preview-v3` rejected, and the server's three-action gate stays
unconditionally closed.
