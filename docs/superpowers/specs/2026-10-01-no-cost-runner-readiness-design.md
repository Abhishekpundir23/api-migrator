# No-cost runner readiness design

Date: 2026-10-01. Baseline: bdb1e8c542cab951f6dda9fcec4e9556cc68e99e.

The user authorized implementation, tests, API Migrator commits/PRs/merges without routine approvals. Mindrift, Claude APIs, paid services, production deployment, persistent system-security changes and unrelated repositories are excluded.

## Outcome and scope

Complete a bounded local readiness pass of the existing runner/evidence boundaries. Fix demonstrated lifetime and teardown defects, preserve permanent activation/publication refusals, verify the supported Node 22 toolchain and exact-commit hosted checks, and leave an honest acceptance record. The deliverable is stronger existing implementation, not a fabricated deployed provider or a claim of perfection.

## Accepted changes

1. Revalidate the evidence budget immediately before its queued callback starts. Closing, shortening, wall expiry, monotonic expiry or clock rollback between scheduling and execution must prevent the callback and leak no listeners/resources.
2. Bound every hosted gateway process by the earliest canonical plan/DNS expiry using systemd RuntimeMaxSec. Invalid/exhausted windows must refuse startup; setup delay consumes the existing budget. Preserve existing DNS floors, complete-answer minimum, resolver/cadence and admission deadline.
3. Harden production cleanup. A failed quiescence observation is not absence. The wrapper must never delete containment before teardown; the sealed ExecStopPost helper owns final policy removal after runner/gateway/subordinate identities and workspace are proven absent. All activation refusals remain intact. Behavioral tests use harmless injected command fixtures, never local network/system changes.
4. Review and verify the integration boundary: retained job/evidence objects never become authority, the three console actions remain closed, and existing runner revocation/replacement/expiry regressions pass. Document missing producer/dispatch, native rootless-Podman execution, independent observer/signing/custody and publication ceremony requirements instead of opening the gate.

## Verification and limits

Every behavior change gets an observed failing regression and focused green run. Run npm run ci with Node 22, then independent whole-change review. Use only public API Migrator's existing standard GitHub-hosted Ubuntu workflows, inspected for prohibited API calls, deployment and paid runner use. Exact PR-head checks and post-merge checks must be distinguished; a DNS failure is reported, not bypassed. Existing repo cache is 123,074,764 bytes and artifacts 1,331,729 bytes across all 66 artifacts at audit; no account billing setting is changed.

Native production rootless Linux enforcement and independent trust-domain execution cannot be established on the operator's macOS by unit tests or by the co-resident hosted fixture. Those require suitable independently operated Linux hosts and protected evidence/signing identities; paid infrastructure is optional if those resources already exist. No such environment is provisioned here.
