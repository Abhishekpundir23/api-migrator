# Supervised pilot package

This directory defines the evidence and operating controls for the first 5–10
API Migrator trials. The working checkout is an unreleased owner-authorization
candidate derived from `v0.1.0-pilot`.

The current system is proven on a disposable sandbox. It is not approved for a
public, self-service, or multi-tenant GitHub App. A repository may enter an
external preview only after the owner-authorization, runner-isolation, and
preview-access gates in the runbook have evidence. External publication has a
separate gate and remains disabled while the candidate is completed and
drilled.

## Documents

- [RUNBOOK.md](RUNBOOK.md) — eligibility, go/no-go gates, preview, publication,
  merge handoff, evidence capture, and stop conditions.
- [OWNER-AUTHORIZATION.template.md](OWNER-AUTHORIZATION.template.md) — blank
  operational authorization record. Completed records must stay outside Git.
- [DATA-HANDLING.md](DATA-HANDLING.md) — transient and persistent data,
  retention, deletion, incident handling, and known limits.
- [PERMISSIONS.md](PERMISSIONS.md) — exact GitHub permissions, installation
  scope, token phases, and ruleset evidence.
- [REVOCATION.md](REVOCATION.md) — access removal, run cancellation, data
  deletion, key rotation, and owner confirmation.
- [CANDIDATE-SCREENING.md](CANDIDATE-SCREENING.md) — read-only research and
  technical eligibility criteria before owner outreach.
- [pilot-result.schema.json](pilot-result.schema.json) — strict versioned
  sidecar record for automatic evidence and manually observed outcomes.
- `npm run pilot:validate -- path/to/result.json` — post-run audit helper that
  applies strict Draft 2020-12 shape/format validation and safety-critical
  cross-field checks. It is not part of the preview, write-token, publication,
  or merge authorization path. Do not treat a passing result as permission to
  mutate GitHub.

The v1 sidecar is a post-run audit record, not the separately signed owner
envelope consumed by the runtime publication path. The candidate verifies an
exact canonical Ed25519 envelope and durably consumes its authorization in an
externally anchored replay store before the sole write-token broker can mint a
token. Do not install an App for a public preview or falsify evidence to satisfy
a record shape. If a truthful preview state cannot be represented, keep the
operational record in restricted pilot storage and treat the schema change as
a blocker rather than inventing values.

## Current gate

Candidate discovery may use public repository metadata only. Cloning,
dependency installation, App installation, preview execution, publication, or
owner contact are separate actions.

Every repository designated as professional or client work is
categorically outside this pilot. Do not contact their owners, clone them,
install the App, run a preview, or publish any change there.

Before processing external source, use a dedicated disposable runner with
enforced egress controls. The existing private App must remain private and
selected-repository-only. Public App expansion is outside this pilot.

`v0.1.0-pilot` remains external-preview-only. For the unreleased candidate,
external-source publication may be enabled only after all of the following are
complete:

- owner challenge and signing tooling produces the exact canonical envelope;
- external source runs in a disposable, egress-filtered runner;
- current migration-ref ruleset, default-branch ruleset, and required-CI
  evidence are captured and bound;
- a supervised end-to-end publication drill succeeds on the disposable
  sandbox.

The direct CLI and package-root API are preview-only. The local operator console
is the candidate's only supported operator publication route. It binds a one-use
preview receipt, the exact owner-envelope bytes, a one-use operator token, and a
typed confirmation to one repository. The write-capable executor exists only on
an explicitly internal console-integration subpath; it is not a separate operator
route and must never be exposed to requests or invoked before the console
ceremony. Every blocker is non-overrideable. Missing publication policy,
replay-store activation, or any binding fails closed before write capability. A
sidecar record or post-run validator cannot authorize publication.

Completed authorization forms, result records, owner feedback, and deletion
confirmations belong in restricted pilot storage outside this repository.
