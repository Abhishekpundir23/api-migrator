# Supervised pilot package

This directory defines the evidence and operating controls for the first 5–10
API Migrator trials. The software baseline is `v0.1.0-pilot`.

The current system is proven on a disposable sandbox. It is not approved for a
public, self-service, or multi-tenant GitHub App. A repository may enter an
external preview only after the owner-authorization, runner-isolation, and
preview-access gates in the runbook have evidence. External publication has a
separate gate and remains disabled on this baseline.

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
envelope consumed by a runtime authorization path. Do not install an App for a
public preview or falsify evidence to satisfy a record shape. If a truthful
preview state cannot be represented, keep the operational record in restricted
pilot storage and treat the schema change as a blocker rather than inventing
values.

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

External-source publication is disabled on `v0.1.0-pilot`. It may be enabled
only after the product verifies a separately signed owner approval envelope,
bound to the exact preview and repository identity, before minting any write
token. A sidecar record or post-run validator cannot supply that enforcement.

Completed authorization forms, result records, owner feedback, and deletion
confirmations belong in restricted pilot storage outside this repository.
