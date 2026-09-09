# Preview source identity: approved first-slice specification

Baseline: `23e10cbf8f8276a739e984d30e8a59e33232cea6`.
Scope: implement the first slice of the trusted-runner connection proposal.
This is input provenance for local previews, not independent execution proof.

## Runtime contract

The credential-free canonical source-bundle and Git-object implementations move
from runner to app. Runner keeps its existing exports by re-exporting from
`@api-migrator/app/runner-internal`. There is one implementation and no new
package dependency. A fixed, deterministic Git fixture pins the pre-move bundle
bytes/digest and the compatibility paths must produce identical bytes.

A browser-safe app subpath `@api-migrator/app/preview-evidence` defines strict,
bounded JSON validation and these types. It imports no Node, auth, DB or runner
code. These are descriptive records, never capabilities:

```ts
interface PreviewSourceIdentity {
  repository: { slug: string; id: number; ownerId: number };
  base: { branch: string; sha: string; treeSha: string };
  manifestDigest: string;
  sourceArchiveDigest: string;
}
type LocalPreviewExecution = {
  schemaVersion: 1;
  kind: "local-preview";
} & (
  | { source: PreviewSourceIdentity; unavailableReason?: never }
  | { source: null; unavailableReason:
      "repository_identity_unavailable" | "source_bundle_unavailable" }
);
```

Slugs and branch names use the existing repository contracts; IDs are positive
safe integers; Git OIDs are lowercase 40/64 hex and both OIDs use the same
format; digests are `sha256:` plus 64 lowercase hex. Reject unknown fields,
wrong versions/kinds and malformed discriminants. Validation returns a detached
copy. Missing legacy metadata remains missing, not an inferred local or
verified execution. Invalid history metadata is displayed as invalid/unknown.

`AppMigrationReport extends MigrationReport` adds optional `previewExecution`.
The engine report stays provider-neutral. The existing report JSON DB column
stores this field; no schema migration and no source bytes in DB/logs/API.
Sanitization preserves only a valid detached record, rejects invalid metadata,
and continues removing raw output. Preflight hashing includes valid metadata
when present; metadata-absent legacy hashes stay compatible.

## Capture and failure behavior

After clone/base resolution and before copying/running repository code,
`migrateRepo` captures the source identity from the exact clean checkout and
canonical manifest. Repository ID and owner ID come from a fixed GitHub API
`repos.get` request for the normalized slug. Authenticated clones reuse their
existing read client; public clones use an explicitly anonymous client, never
ambient credentials or an auth fallback triggered merely by metadata failure.
The response must match the exact normalized full name and, for an App read
session, its pinned repository/owner IDs. The request has a bounded timeout.
No URL, command, path or numeric repository identity is taken from a browser.

To preserve public previews when GitHub metadata is unavailable, capture returns
the explicit `repository_identity_unavailable` local record, without inventing
IDs. Unsupported/oversized/noncanonical source bundles return the explicit
`source_bundle_unavailable` local record. Errors are not silently promoted to
success: the reason is persisted and visible, and the preview is never attested.
These capture failures do not newly prohibit the existing local migration path.
The source bundle itself is discarded after deriving its bounded identity.
Actual migration or artifact failures keep their existing failure behavior.

## Receipts and future attested protocol

Current local previews use `preview-v2`, HMAC domain
`api-migrator:console-preview-receipt:v2\0`. The payload is the existing strict
v1 payload with `version: 2` and one extra root field `execution`, whose value is
the strict `LocalPreviewExecution` above. It binds campaign, canonical manifest,
repository/output/preflight/completion time, source identity (or explicit
unavailability), original expiry and nonce. Source slug and manifest digest must
match the enclosing receipt. Creation and verification reject future completion
times and expiry beyond the original completion time plus ten minutes. New v2
local receipts cannot enter the owner-challenge bridge. Existing v1 tokens can
be verified for legacy compatibility, but cannot acquire v2 source evidence or
any attested designation. The production preview route creates v2 only from the
server's returned report; caller-supplied execution metadata is ignored.

Reserved future protocol (documented, NOT accepted or emitted in this slice):
`preview-v3`, HMAC domain `api-migrator:console-preview-receipt:v3\0`, existing
campaign/manifest/repository/output fields plus `execution` with exact keys:
`schemaVersion: 1`, `kind: "verified-runner"`, `source: PreviewSourceIdentity`,
`runner: { pilotId, planDigest, jobId, jobCreatedAt, jobExpiresAt,
attestationPayloadDigest, attestationEnvelopeDigest, signerKeyId,
signerFingerprint, signerValidUntil }`. Expiry is the minimum of original
preview completion plus ten minutes, original plan expiry and signer validity.
All digests, subject, base, output and signer fields must cross-bind to the
original plan and genuinely verified in-process attestation. Receipt HMAC
verification does not recreate that capability. Each challenge/write boundary
must reacquire the original envelope, reread protected key state, reverify it,
and compare every bound field. Replacement job/plan/evidence requires a new
preview/approval cycle; no expiry renewal or evidence substitution. There is no
v1/v2-to-v3 converter. This protocol requires its own implementation/review with
the protected provider; defining it here does not provide that provider.

## Presentation and gates

Both fresh preview and stored run views show `Local preview — not independently
attested`, the source digest/base tree/repository IDs when captured, and a clear
unavailability reason otherwise. Legacy reports show `Not recorded (legacy)`;
malformed metadata is never rendered as verified. No full source, raw logs or
secret-bearing error strings enter these views.

All `prepare_owner_challenge`, `prepare_publish`, and `publish` actions remain
unconditionally unavailable. Real HTTP handler tests must demonstrate 503 for
legacy, local, forged and future-shaped payloads without creating migration
runs, consuming approval, acquiring a lock or reaching GitHub. No deployment,
signing service, cloud bill or professional repository access is authorized.

## Verification and completion

TDD for new behavior, deterministic pre-move compatibility fixture, strict
validation and mutation tests, durable report round trip, v2 HMAC tamper/campaign/
manifest/source/output/expiry tests, actual HTTP gate tests, browser evidence
presentation checks, workspace CI and real runner image build/verification/phase
integration. Submit a reviewed feature PR; do not merge it in this stage.
