# Next milestone: trusted runner connection

Status: first slice approved by the user's request to begin the next stage.
The detailed first-slice specification is
`2026-09-08-preview-source-identity-spec.md`; later deployment slices still
require the approvals and gates below.

Baseline: merged PR #15, main commit
`23e10cbf8f8276a739e984d30e8a59e33232cea6` (2026-09-08).
This document changes no runtime behavior and authorizes no deployment, source
execution, signing, or publication.

## Product outcome

Complete one supervised, long-running Inngest migration from a reviewed preview
to an explicitly owner-approved pull request. The first implementation slice
below does not complete that outcome on its own. Keep the private,
selected-repository App and professional-repository exclusions unchanged.

## What the merged baseline proved

This section describes the baseline above, before the first-slice feature
branch. First-slice implementation and acceptance are tracked in the linked
implementation plan; the later service/deployment gates remain open.

- The engine can generate and verify the supported Inngest migration, including
  the operator-declared deployment choice added by PR #15.
- The console creates campaigns and renders preview evidence. Its
  `runner-capability.ts` server gate unconditionally rejects owner challenge,
  prepare-publication, and publication actions.
- `migrateRepo` still invokes the local Docker verification path. It accepts an
  internal verified-runner capability, but no console provider supplies it.
- `publication-runner.ts` already verifies a signed envelope against an exact
  plan, reviewed output and trusted key, returning an in-process capability.
  This verifier should be reused, not duplicated.
- Source bundles and the four-phase image were tested separately. The console's
  baseline reviewed-preview receipt had artifact/tree/preflight identity but
  no source-bundle or runner-plan identity.
- The host wrapper and deployment kit are non-authorizing. Hosted smoke success
  is not independent execution evidence or permission to deploy.

Evidence pointers: `packages/app/src/github.ts`,
`packages/app/src/publication-runner.ts`,
`packages/app/src/owner-publication-policy.ts`,
`packages/console/lib/approval.ts`,
`packages/console/lib/runner-capability.ts`,
`packages/runner/src/source-bundle.ts`, and
`ops/publication-runner/README.md`.

## Approaches

1. **Phased connection to the existing runner — recommended.** First bind the
   exact input and execution identity, then add protected evidence acquisition,
   then deploy and validate the complete supervised flow. Early work can run
   locally; the service integration remains visible as unfinished work.
2. **Build and deploy the complete control plane at once.** Delivers the full
   flow in one larger project, but requires provider, account, budget, identity,
   network, observation, evidence-storage and teardown decisions immediately.
3. **Owner-hosted execution with a different publication model.** Could reduce
   infrastructure operated by this product, but changes the approved trust and
   approval architecture. It needs its own design and is not this proposal.

## First slice: exact preview input and execution binding

Goal: prepare the existing preview flow to bind real runner evidence without
making a local or synthetic result eligible for publication.

1. Give the orchestration layer access to the existing canonical source-bundle
   implementation without introducing an app-to-runner dependency cycle. The
   runner already depends on app. Proposed placement: move the credential-free
   source-bundle/Git-object helpers to the existing app runner-internal surface
   and preserve runner exports as compatibility re-exports. Keep one canonical
   byte format and prove before/after byte equality with existing fixtures.
2. Build source identity from the exact clean checkout and canonical manifest
   before migration. Obtain repository IDs from trusted repository discovery;
   do not accept IDs, snapshot digests, paths or commands from browser fields.
3. Carry the source identity through preview results and stored run evidence.
   Clearly distinguish local-preview evidence from verified-runner evidence.
   A locally computed digest is an input identity, not execution proof.
4. Define a versioned, server-authenticated receipt binding for future attested
   previews: campaign/manifest, repository/base, source archive, plan/job,
   reviewed output, signer identity and the original expiry. A browser receives
   safe display fields and an opaque receipt, never an in-process capability.
5. Preserve existing local previews. Legacy receipts may remain viewable, but
   cannot be upgraded or inferred to contain attested execution evidence.
   Keep all post-preview actions disabled in this slice.

The detailed implementation spec must settle the complete identity shape and
storage/receipt migration before code changes. This proposal does not invent a
working provider or accept a placeholder attestation to unblock the UI.

## Subsequent slices and dependency gates

### Protected evidence acquisition

- Implement a server-owned provider boundary with no browser-selected service
  URL, signing key, command, plan or filesystem path.
- Reuse `verifyPublicationRunnerAttestation` with the independently expected
  plan, source identity and reviewed output. A container report or a hosted
  smoke result never satisfies this boundary.
- Read a protected runner-key registry at every challenge and write-token
  boundary. Reverify the original signed evidence with the current key state;
  do not cache a capability across requests or serialize one through the API.
- Preserve the exact execution/attestation identity through owner signing.
  A replacement execution or changed signed payload starts a new preview and
  approval cycle. Revalidation must not silently replace what the owner signed.
- Bound requests by the remaining approval window, reject oversized or
  mismatched responses, and fail without consuming approval on acquisition
  failure. Never fall back to the local runner for publication.

### Deployment and supervised publication

Live enablement depends on integrating the forced gateway lifecycle, independent
observation/signing, approved disposable-host execution, revocation/cleanup,
current GitHub ruleset/required-CI evidence and a successful supervised sandbox
drill. The current dedicated-host contracts remain requirements until a separate
architecture decision changes them. They are not satisfied by the local Docker
test or GitHub-hosted smoke.

Provider selection, a personal project/account, a hard spending limit, evidence
storage/retention and external observer/signer identities need user approval
before provisioning. Do not use Dynamo, Toloka or client infrastructure.

Only after these gates are demonstrated may the console enable the owner
challenge and publication ceremony. PR merging remains a maintainer action.

## Acceptance evidence for the first slice

- Existing source-bundle bytes and digests remain compatible after extraction.
- Changes to the source, base, manifest (including deployment kind), job/plan or
  reviewed output cannot reuse the earlier execution identity or receipt.
- Tampered, forged, cross-campaign, expired, legacy or local-only evidence cannot
  enter the future attested path. Verification is behavior-tested at the server
  boundary, not just asserted by searching source text.
- No caller-supplied digest or deserialized object becomes a capability.
- Existing local preview behavior still works, and all three post-preview
  actions still return unavailable without consuming approval or minting tokens.
- Workspace CI, canonical fixture tests and the real image phase integration
  pass. UI testing covers any changed evidence presentation.

## Honest product progress

| Area | Current evidence-backed state |
| --- | --- |
| Narrow migration engine and deployment handling | Implemented and tested; limited SDK/runtime coverage |
| Local campaign console and preview reports | Implemented and tested |
| Credential-free four-phase runner image | Implemented; functional container integration verified |
| Owner approval and publication | Substantial primitives exist; console flow unavailable |
| Trusted deployed execution/control-plane service | Not connected or deployed by this work |
| Customer-ready service | End-to-end pilot acceptance, operations and buyer validation still needed |
| Self-service SaaS | Outside the current supervised-pilot scope; not a launch-ready product |

A file count or number of merged PRs is not a completion percentage. The remaining
integration and pilot validation are substantial. The useful current label is
**working internal prototype, progressing toward a supervised MVP**. The product
repository does not establish how many paying customers or revenue exist.

## Costs and billing

No paid cloud resources are provisioned by this design. Existing GitHub Actions,
AI subscriptions/API usage and other account charges have not been audited, so
this document does not assert a zero bill or a monthly operating price. Billing
integration is not implemented in the inspected application. A service-led paid
pilot can be commercially evaluated separately from a self-service checkout.
