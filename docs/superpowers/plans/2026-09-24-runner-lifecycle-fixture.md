# Runner lifecycle fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing four-phase fixture with real forced-gateway lifecycle controls on disposable Linux, without enabling publication.

**Architecture:** Extract one reusable image-fixture protocol, coordinate its phases through explicit gateway hooks, and bind it to a fixture-only Linux adapter. Retain the existing image integration and hosted-smoke contracts. Production activation is unchanged.

**Tech Stack:** Node 22.23.2 ESM, node:test, Docker, native Envoy/nftables/systemd on Ubuntu 24.04.

**Spec:** `docs/superpowers/specs/2026-09-24-runner-lifecycle-fixture-design.md`

## Global Constraints

- Node 22.23.2; existing dependencies only.
- Fixture-only input; no external repository, arbitrary command, signing, App scope, cloud account, or paid-resource activation.
- Existing live wrapper/observer and console publication remain disabled.
- Results carry `securityDrill: false`, `selfAttested: true`, `releaseEvidenceEligible: false`, `activationBlocked: true`, `externalSigningEligible: false`.
- Preparation/migration/verification use network none. Linux test-only installation uses host networking with dedicated non-root UID under the forced-gateway policy; never claim this is the production rootless-Podman profile.
- All Git author and committer identities are `Abhishekpundir23 <74260202+Abhishekpundir23@users.noreply.github.com>`; verify before and after every commit.
- Use apply_patch for file edits; no edits to private files, protected stores, or other repositories.

## Review Focus

1. Partial policy/gateway setup must still trigger bounded cleanup; no later phase after any error.
2. Malformed or swapped phase digests cannot advance the protocol.
3. Host-network sockets must actually belong to the constrained UID, with counters attributable to installation.
4. DNS/plan expiry cannot be extended or ignored during a slow fixture run.
5. A cleanup or evidence-write failure cannot produce a passing artifact or weaken permanent publication blocks.

### Task 1: Shared fixture protocol and fail-closed lifecycle

**Files:**
- Create: `ops/publication-runner/image/fixture-phases.mjs`
- Create: `ops/publication-runner/deployment/fixture-lifecycle.mjs`
- Modify: `ops/publication-runner/image/run-phase-integration.mjs`
- Test: `ops/publication-runner/image/test/fixture-phases.test.mjs`
- Test: `ops/publication-runner/deployment/test/fixture-lifecycle.test.mjs`

**Interfaces:**
- Consumes existing source-bundle and plan builders, the fixed generated Inngest fixture, and a container command executor.
- Produces `runFixtureLifecycle(operations)` with named async functions `installPolicy`, `prepare`, `startGateway`, `probeOnline`, `install`, `stopGateway`, `assertOffline`, `migrate`, `verify`, `cleanup`. It returns the verified phase value with permanent non-authorizing fields only after cleanup succeeds.
- Produces import-safe fixture preparation and phase functions. Exact exported signatures must be recorded in the task report for Task 2; preserve current standalone image CLI behavior and all current assertions. Phase functions carry the actual previous digest into the next command and reject malformed/extra output.

- [ ] Write behavior tests first. The coordinator test uses an external-boundary recorder and independent literal ordering:

```js
const expected = ['installPolicy', 'prepare', 'startGateway', 'probeOnline',
  'install', 'stopGateway', 'assertOffline', 'migrate', 'verify', 'cleanup'];
const calls = [];
const operations = Object.fromEntries(expected.map(name => [name, async () => {
  calls.push(name);
  return name === 'cleanup' ? { complete: true } : { fixture: true };
}]));
const result = await runFixtureLifecycle(operations);
assert.deepEqual(calls, expected);
assert.equal(result.activationBlocked, true);
assert.equal(result.releaseEvidenceEligible, false);
```

- [ ] Add table-driven failure tests at every operation: rejected preparation prevents install, failed stop/offline proof prevents migrate, cleanup runs after every partial failure, cleanup rejection/incomplete result rejects success, and original plus cleanup errors remain observable. Assert malformed operations fail before side effects.
- [ ] Run the new tests and record RED before implementation. Use a temporary missing-export assertion/dynamic import if needed so absence is a clear expected feature failure.
- [ ] Implement the fixed coordinator with `try`/`finally` and aggregate cleanup failure; validate the operation surface before any work. No fallback or resumable-success path:

```js
let result, failure;
try {
  for (const step of executionSteps) result = await operations[step]();
} catch (error) { failure = error; }
try {
  const cleanup = await operations.cleanup();
  if (cleanup?.complete !== true) throw new Error('fixture cleanup incomplete');
} catch (error) {
  failure = failure ? new AggregateError([failure, error], 'fixture execution and cleanup failed') : error;
}
if (failure) throw failure;
```

- [ ] Extract the existing phase implementation and fixed fixture without duplicating it. Add process-boundary tests that return literal prepare/install/migrate/verify status lines; assert exact digest propagation, none/online/none/none network choice, rejected invalid status, and bounded execution options. Preserve genuine report/file validation in actual integration.
- [ ] Run `node --test ops/publication-runner/image/test/*.test.mjs ops/publication-runner/deployment/test/fixture-lifecycle.test.mjs` and actual `npm run runner:image:integration`. Expected: all pass, no changed protocol/report semantics.
- [ ] Self-review, verify identity, commit only owned files. Report RED/GREEN commands, exact exports, commit SHA and limitations.

### Task 2: Disposable Linux adapter, fixture CI, and closeout

**Files:**
- Create: `ops/publication-runner/deployment/run-image-lifecycle-fixture.mjs`
- Create: `ops/publication-runner/deployment/test/image-lifecycle-fixture.test.mjs`
- Create: `.github/workflows/runner-lifecycle-fixture.yml`
- Modify as needed for narrow shared primitives: `ops/publication-runner/deployment/run-hosted-smoke.mjs`, `ops/publication-runner/image/fixture-phases.mjs`
- Modify: `ops/publication-runner/deployment/README.md`, `README.md`

**Interfaces:**
- Consumes Task 1's coordinator/fixture/phase exports (the report records exact names).
- Uses existing gateway renderer, pinned native tool inventory, UID validation, DNS acquisition/window, resource ownership, probes/counters, exact-unit stop and table-last cleanup. A shared extraction is permitted; existing smoke behavior and its CLI must remain unchanged.
- Produces a fixture-only CLI and separate workflow; no live entrypoint or console route change.

- [ ] First write failing parser/adapter tests. Accept only image plus narrow absolute output directory and a fixed failure scenario; reject arbitrary repo/source/command inputs, broad paths, ambient secrets, malformed image identity, and repeated output directories. Example negative boundary:

```js
for (const forbidden of ['--publish', '--live', '--repo', '--source', '--command']) {
  assert.throws(() => parseImageLifecycleFixtureCli(['--image', image,
    '--output-dir', output, forbidden, 'value']));
}
```

- [ ] Implement Linux/root/systemd/cgroup and sanitized-environment guards before resource mutations. Bind exact fixture, image, plan and gateway identity. Use a fixed dedicated UID for all workload sockets, including install; Docker host mode only for installation, not bridge. Bind both IPv4/IPv6 static npm destinations within actual DNS lifetime.
- [ ] Implement coordinator operations with existing native primitives: exact policy installed before phases, offline prepare, pinned Envoy + listener proof, denied wrong/absent SNI/direct bypass, install-specific forced-route counter increase, stop/idle/offline proof, offline migrate/verify, bounded output validation and table-last cleanup. Use bounded command timeouts and named-container cleanup; on failed teardown preserve containment and fail.
- [ ] Exercise wrong operation order, failed gateway readiness, expired DNS/plan before phase, missing UID/counter evidence, incomplete cleanup, and evidence-write failure through adapter-level tests. Use real parser/config/command construction; doubles only for native processes unavailable on macOS.
- [ ] Add a separate read-only-permission Ubuntu 24.04 workflow. Pin actions to existing repo SHAs and Envoy to existing audited image/config/binary digests. Build packages/image, install exact test identities with collision refusal, seal native tools, run success and install-failure fixture jobs, always perform exact owned-resource cleanup, and upload bounded sanitized results. No application GitHub credentials, OIDC, arbitrary dispatch input, cloud provisioning, source checkout from other repos, or production units.
- [ ] Update docs to distinguish joined fixture coverage from still-disabled production rootless runner, console bridge and independent deployment drill. Do not claim hosted execution passed until its current-head result exists.
- [ ] Run focused tests, existing full `API_MIGRATOR_DOCKER_TEST=1 npm run ci`, Docker image build/config/integration and check `git diff --check`. Expected: green with no skipped local tests. Review the complete diff independently before publishing a feature PR; leave it unmerged.
- [ ] Verify commit identity, commit owned changes, report exact test evidence and any Linux-only pending validation. After PR CI, resolve real failures without weakening policy or expiry floors.
