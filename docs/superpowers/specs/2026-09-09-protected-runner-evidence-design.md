# Protected runner evidence: software-only acquisition design

Status: written specification approved in chat on 2026-09-09. Implementation
planning is authorized; no runtime changes are implemented by this document.

Baseline: merged PR #16, `c1a6a6ea78de177ae6ceda07bcda1551f5c18948`.
Working branch: `codex/protected-runner-evidence`.
Predecessor: [trusted-runner connection proposal](../../plans/2026-09-08-trusted-runner-connection-proposal.md)
and [local-preview source specification](../../plans/2026-09-08-preview-source-identity-spec.md).

## 1. Outcome and limits

Build the read-only, server-side client that will acquire and verify a specific
runner's signed execution evidence. It must reuse the existing
`verifyPublicationRunnerAttestation` verifier, not create another signature
format or accept a report merely because a container produced it.

This slice delivers a working acquisition client with real local TLS and
signature tests. It does not deliver a hosted evidence service, independent
signer, job scheduler, production connection, or completed publication ceremony.
The client remains unwired from the console's post-preview routes.

Non-negotiable boundaries:

- No cloud provisioning, paid-service activation, real signing keys, or changes
  to the GitHub App's installation scope. No Dynamo, Toloka, or client assets.
- No remote job creation, source upload, migration execution, write-token
  request, owner challenge, approval consumption, publication, or merge.
- No browser-selected URL, IP address, key, registry path, command, plan, or
  expected output. Nothing in downloaded evidence establishes its own expected
  identity or trust configuration.
- Local `preview-v1`/`preview-v2` receipts do not become attested receipts.
  Reserved `preview-v3` remains unimplemented and rejected in this slice.
- Keep `RUNNER_CAPABILITY_PROVIDER_AVAILABLE = false` and the unconditional
  three-action server gate. No environment-variable bypass is introduced.
- Do not package acquisition, network configuration, or registry reading into
  the credential-free runner image or its `runner-internal` export.

## 2. Approach selected

Use a small acquisition client, protected public-key registry reader, and one
orchestrator around the existing verifier. It can be exercised with controlled
local fixtures without pretending those fixtures are independent attestations.

A complete cloud control plane would additionally require provider/account,
budget, ingress authentication, source transport, durable job/evidence storage,
observer/signer separation, and teardown decisions now. That larger approach
is deferred. An owner-hosted replacement would change the approved trust model
and is not part of this design.

No new application framework, database table, queue, UI, or runtime dependency
is required for this client slice. Node 22 compatibility remains mandatory.

## 3. Components and ownership

| Component | Responsibility | Forbidden responsibility |
| --- | --- | --- |
| Evidence contract | Validate and detach trusted expected-run context; compare retained identity | Inferring expected values from received evidence |
| HTTPS transport | Read one bounded envelope from the configured service | Redirects, discovery, job submission, credential fallback |
| Runner-key registry | Read and strictly validate current protected public-key state | Generating keys, downloading trust, changing owner-key policy |
| Acquisition orchestrator | Match context, fetch, refresh trust, invoke the existing verifier, retain exact identity | Minting owner approval, storing authority in JSON, opening the console gate |

Place implementation in focused app modules such as
`runner-evidence-contract.ts`, `runner-evidence-transport.ts`,
`runner-key-registry.ts`, and `runner-evidence.ts`. Expose only the server API
through a new `@api-migrator/app/runner-evidence-internal` subpath. Do not export
it through the browser-safe preview subpath, package root, CLI, or
credential-free runner subpath.

Reuse canonical JSON, source-identity validation, plan validation, output types,
and signature verification. If a small pure validator must be extracted from
`publication-runner.ts`, preserve all existing acceptance/rejection behavior
and wire bytes. Do not refactor owner authorization or its file reader as part
of this slice. New registry policy is distinct from owner-signing policy.

## 4. Trusted expected context and retained identity

The internal acquisition API receives a strict detached context containing:

- `campaignId` and `runId`: nonempty ASCII identifiers, at most 128 bytes each;
  only letters, digits, hyphen, and underscore.
- `plan`: the existing `PublicationRunnerPlanRecord`, including exact canonical
  JSON and its digest, validated by `assertPublicationRunnerPlanCurrent`.
- `source`: a complete `PreviewSourceIdentity`, using canonical GitHub casing
  and unchanged case-sensitive branch/OID/digest contracts.
- `reviewedOutput`: the existing `PublicationRunnerOutput`.
- `previewCompletedAt`: the original server-recorded completion timestamp.

Before any network request, require equality of source and plan repository
slug/ID/owner ID, base branch/commit, source-archive digest, and manifest digest.
Require valid output fields and a current plan. Completion must not be in the
future or before plan creation. Validate canonical JSON before reading caller
fields, reject unknown/accessor/hidden fields, then deep-freeze a detached copy.

This context is an expectation supplied by trusted server orchestration, not
an authorization capability. Future integration must load it from protected
server state: the plan created before execution, its validated source bundle,
and separately reviewed output. That producer and durable store are not built
here. Existing local preview report JSON is not an acceptable substitute.

The signed plan binds the source-archive digest and base commit; it has no
separate base-tree field. The producer must establish the tree against the
canonical source bundle. This client preserves that tree in its context but
does not invent a new independently signed tree assertion.

The factory has two explicit operations:

1. `acquireInitial(context)`: obtain the first verified envelope for that exact
   expected job and output; return its retained identity and in-process result.
2. `reacquire(context, retainedIdentity)`: fetch again, read trust again, and
   reject any change from the original retained identity.

The retained identity is strict, detached JSON with exactly these fields:
`schemaVersion: 1`, `contextDigest`, `jobId`, `planDigest`,
`attestationPayloadDigest`, `attestationEnvelopeDigest`, `signerKeyId`,
`signerFingerprint`, `signerTrustDigest`, and `expiresAt`.

Compute `contextDigest` as SHA-256 of the canonical complete context above.
Compute `signerTrustDigest` from the canonical complete selected registry entry,
including scope, key, validity, and revocation fields. Retain and compare it on
every reacquisition so a validity change is detected even when preview expiry
was already shorter than key validity. Other fields come from the validated
plan, genuinely verified result, or the expiry calculation in section 8.
This record is safe identity metadata, never a serialized capability. A future
receipt/store must protect its integrity before supplying it to `reacquire`.
The client does not write it into current reports or receipts.

The exact same still-valid evidence may be reacquired repeatedly: owner review
and later authorization checks need that. A different signed envelope, payload,
job, context, or signer is not a retry; it requires a fresh preview/approval
cycle. There is no automatic selection of the latest job and no expiry renewal.

## 5. Server-owned transport configuration

Construction requires an explicit, strictly validated server-only configuration:

- `serviceOrigin`: canonical ASCII HTTPS DNS origin on port 443, with no user
  information, path other than `/`, query, fragment, trailing dot, or wildcard.
- `serviceAddresses`: 1-32 unique canonical global-unicast IP literals pinned
  by the operator. Reuse the existing conservative IP policy; reject private,
  loopback, link-local, metadata, multicast, and other reserved destinations.
- `serviceTlsSpkiDigest`: pinned SHA-256 of the TLS certificate's SPKI DER key.
  This transport pin is separate from the Ed25519 evidence-signing key.
- `registryDirectory`: absolute canonical path to a protected directory outside
  the application checkout and all migration workspaces.

Implementation clarification: the internal factory also requires a server-owned
workspace-exclusion policy to enforce the final rule. Always include the
application checkout independently of that policy. The caller must supply all
migration workspace roots; do not infer them from evidence, browser fields, or
an environment-variable override. This policy is not a new console setting.

Construction does not perform I/O and is not automatically invoked by module
import. Missing or invalid configuration fails closed. No new `.env` activation
flag or route-level configuration fields are added. No live values are selected
or installed during this slice.

The request is exactly `GET /v1/runner-evidence/<jobId>`, with `jobId` taken from
the validated expected plan, not from response data or a generic URL parameter.
Require the existing `previewjob_` plus 64 lowercase hexadecimal format. Send
only `Accept: application/json` and `Accept-Encoding: identity` in addition to
the normal fixed Host/connection headers. No request body, cookies, GitHub
credentials, bearer tokens, user-provided headers, or client signing key.

Connect directly to the first configured IP, retaining the configured hostname
for SNI, Host, and normal TLS hostname validation. Require trusted TLS and the
additional SPKI pin; never disable certificate verification. Use a dedicated
agent, not ambient proxy/global-agent routing. No DNS lookup, redirect following,
alternate-address retry, proxy fallback, certificate auto-learning, or mutation
request is allowed. Failure may be retried only by a new bounded acquisition
of the same still-valid identity.

This client is not yet suitable for a private production evidence endpoint:
ingress authentication and private evidence access/retention need a later
deployment design. The absence of credentials here is not permission to expose
evidence publicly. Do not contact any real service in this implementation stage.

## 6. Bounded response and lifetime

Accept HTTP 200 only, a single `application/json` content type (optionally
`charset=utf-8`), an absent `Content-Encoding` header (even an explicit
`identity` value is rejected), and at most 16 KiB of response headers.
Reject ambiguous duplicate singleton headers, malformed lengths, 3xx responses,
non-200 statuses, truncated streams, trailers, and invalid UTF-8. The body is
the existing canonical signed-envelope JSON, not a wrapper carrying alternative
plans, keys, output, commands, or URLs.

Enforce the verifier's 128 KiB envelope maximum while streaming, not after an
unbounded `text()`/buffer read. Honor a smaller valid Content-Length but do not
trust it as a size limit; reject a declared length over the cap before reading
the body. Close the response/request/agent on every early failure.

The complete acquisition budget is at most 10 seconds and never outlives the
original preview completion plus ten minutes, the plan expiry, or the selected
key validity. On reacquisition it also cannot exceed retained `expiresAt`.
Use a monotonic elapsed-time deadline plus wall-clock freshness checks. Reject
clock rollback within an acquisition. Cover connect, TLS, headers, body, and
validation with the same budget; abort/destroy pending transport on expiry.
Recheck current time after each awaited operation and before returning success.
Filesystem operations that cannot be cancelled must never publish late success;
dispose any late-opened descriptor and discard late data after the deadline.

Node documents that a request timeout alone does not abort the request; explicit
cancellation is required. It also documents proxy-enabled global agents, which
this dedicated transport must not inherit. These are implementation constraints,
not a reason to alter runtime flags or install another HTTP library.
See [Node HTTP documentation](https://nodejs.org/api/http.html) and
[Node 22 HTTPS documentation](https://nodejs.org/download/release/latest-jod/docs/api/https.html).

## 7. Fresh protected runner-key registry

Read `<registryDirectory>/runner-keys.json`; the filename is fixed. The JSON
contract is exact canonical UTF-8, with root keys `schemaVersion: 1` and `keys`.
Bound the file to 256 KiB and 1-128 entries. Each entry has exactly:

`pilotId`, `repository: { slug, id, ownerId }`, `keyId`, `algorithm: "Ed25519"`,
`publicKeyPem`, `fingerprint`, `validFrom`, `validUntil`, `revokedAt`.

Apply existing pilot/repository/key/timestamp contracts and canonical public
Ed25519 SPKI PEM/fingerprint validation. Reject private keys, certificates,
extra PEM blocks, malformed inactive entries, unknown fields, and duplicate key
IDs or fingerprints. At most one non-revoked entry per pilot/repository scope
may be current; rotation retains old entries explicitly revoked. Select solely
by expected plan pilot/repository and current validity, never by an untrusted
envelope's requested key ID. Missing or ambiguous scope fails closed.

For this POSIX-only reader, require a real owner-controlled directory with no
group/other permissions and a regular single-link file with mode `0400` or
`0600`, owned by the effective control-plane user. Reject unsupported platforms,
symlink components, workspace containment, FIFOs/devices, and hard links.
Validate protected directory ancestry down to the file, open with no-follow
semantics, and compare descriptor/path identity. Read at most the cap plus one
byte, check metadata again after reading, and close descriptors in `finally`.
Require an unchanged directory identity throughout the read. Never create,
chmod, repair, or replace trust configuration automatically.

Deployment must place this directory beneath a trusted, non-attacker-writable
parent. File checks do not establish isolation from a compromised control-plane
user or administrator. No rollback-proof registry history is claimed here.

Read/select once before transport, then read/select again after receiving the
envelope. Key identity, scope, and validity fields must remain identical; a
revocation or concurrent change to the selected entry fails this acquisition.
Use that fresh selection with the existing verifier and the finish-time clock.
Never reuse a cached registry, public-key decision, or verified capability on
the next call.

Atomic registry replacement between acquisitions is supported when the parent
remains protected. Removing a key, revoking it, changing its fingerprint/scope,
or shortening validity prevents reusing previously retained evidence. An
unrelated valid registry entry need not invalidate the selected proof.

## 8. Result, failures, and future integration boundary

Success returns the exact `VerifiedPublicationRunnerAttestation` object created
by the existing verifier, plus the retained identity. Do not spread, clone, or
deserialize the capability. Its WeakMap brand must remain recognizable by
`assertVerifiedPublicationRunnerAttestation` inside that process. This result
is short-lived; a future challenge/write boundary must reacquire immediately
before use. This client alone cannot enforce a later caller's authorization
ordering, and the console stays closed until that integration is reviewed.
The existing capability's private expiry covers plan/key validity, not the
preview's shorter deadline. Do not alter or relabel that capability: future
integration must check the retained preview expiry as well as the existing
capability assertion at each challenge/write boundary.

The initial retained expiry is the minimum of original preview completion plus
ten minutes, plan expiry, and signer validity. Reacquisition preserves the exact
retained expiry; it never recomputes a later one. Shorter current validity is
rejection, not silent substitution of the retained record.

Expose only bounded safe failure codes:
`configuration_invalid`, `expected_context_invalid`, `trust_unavailable`,
`evidence_unavailable`, `evidence_invalid`, `identity_changed`, `expired`.
If remaining lifetime or the operation budget is exhausted, return `expired`;
transport non-200/failure is `evidence_unavailable`; malformed or unverified
evidence is `evidence_invalid`. A verified envelope that differs from retained
identity is `identity_changed`. Invalid caller context or configuration is
rejected before I/O. Do not return or log raw paths, URLs, response bodies,
envelopes, signatures, registry contents, or native exception messages.

There is no DB write, lock acquisition, owner/preview-token consumption, key
mutation, fallback to local verification, or GitHub call on success or failure.
Repeated reads are distinct from one-use publication authorizations. The owner
authorization replay ledger remains unchanged and authoritative at its existing
future publication boundary.

## 9. Acceptance tests

Use real canonical plans, source bundles, output identities, and Ed25519-signed
fixture envelopes. Test keys are disposable test material, never production
trust. These new acquisition fixture tests do not contact GitHub, npm, a cloud
account, or an external signer. Existing Docker CI retains its normal dependency
installation checks.

1. Initial acquisition accepts exactly matching evidence; returned capability
   passes the existing runtime assertion. Clones/deserialized copies fail it.
2. Reacquisition performs a new transport read and registry read. The same proof
   remains usable inside its original window; no authority is consumed.
3. Mutate every context/identity dimension independently: campaign/run, plan/job,
   repository slug/IDs, branch/commit/tree, manifest/source digest, all output
   fields, completion/expiry, payload/envelope digest, key ID/fingerprint/trust
   digest. Reject mismatches; retain canonical GitHub casing and case-sensitive
   branch behavior.
4. A valid replacement signature/job cannot silently replace retained evidence.
   Local/legacy/future-shaped receipts and container self-reports are rejected.
5. Revocation, removal, expiry, changed scope/fingerprint/validity, malformed
   inactive key, and ambiguous registry all fail. Simulate rotation/revocation
   during fetch and between calls; preserve no cached authorization.
6. Filesystem tests cover oversize/growing/truncated files, symlinks, hard links,
   wrong permissions/owner where the platform permits, workspace containment,
   descriptor/path/directory swaps, and cleanup after read errors. Distinguish
   injected ownership/race tests from real filesystem observations in reports.
7. Transport tests cover exact path/method/headers/IP/Host/SNI; certificate and
   SPKI mismatch; redirect refusal; non-200, compressed/oversized/truncated or
   invalid-UTF-8 responses; duplicate headers/trailers; stalled connect/headers/
   body; caller mutation; poisoned proxy/GitHub-token environment; and socket
   cleanup. Use a real loopback TLS fixture plus narrow internal test seams.
   Loopback/port/test-CA overrides must not be accepted by production config,
   environment variables, browser input, or the exported production factory.
8. Exercise a short valid remaining window, exact expiry, clock rollback, and
   delayed registry/transport reads. Prove active cancellation and rejection of
   late results, rather than merely checking a timer constant in source text.
9. Keep real POST-handler tests for all three blocked console actions, zero new
   runs, reusable controls/lock, and consumed-token negative control. Prove
   neither configured nor forged acquisition fields bypass the gate or reach
   the transport. No UI changes are needed.
10. Preserve runner compatibility and prove its assembled runtime excludes the
    new network/registry modules. Run workspace CI and actual image
    build/verify/phase integration after implementation. Record GitHub checks on
    the final PR head; submit the feature PR without automatically merging it.

## 10. What follows this slice

Before any live connection, separately approve and implement: the expected-run
producer and protected durable store; private service authentication; job and
source transport; independent observer/signer deployment and registry lifecycle;
evidence access/retention; a concrete personal account and spending cap; and a
supervised deployment/cleanup drill. Then implement the reserved attested-receipt
protocol and bind fresh acquisition into every challenge/write boundary before
replacing the unconditional console gate.

Green client tests prove the client contract. They do not prove an independent
service observed a real migration, that a deployed host is hardened, or that the
product is customer-ready. Existing local preview labels remain honest.

## Design verification record

- Inspected the merged source/plan contracts, signature verifier, in-process
  capability assertions, owner registry patterns, package exports, and closed
  console gate.
- Fresh Docker-enabled `npm run ci` on baseline `c1a6a6e`: 532 passed, zero
  failed/skipped; builds/typechecks and console production build passed. The
  existing Next NFT tracing warning remains.
- This change is documentation only. Feature tests and implementation completion
  are not claimed. Main remains unchanged and no service is configured.
