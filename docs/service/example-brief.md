# Migration assessment · Inngest TypeScript SDK v3 → v4

| Local scan | Files |
| --- | ---: |
| Source files inspected | 1 |
| Files matching a recipe pattern or reporting a finding | 1 |
| Files with proposed edits | 1 |

## Manual review

| Rule | Occurrences | Reviewer action |
| --- | ---: | --- |
| F2 | 1 | Find consumers of event.user and update both producers and handlers to carry that information in event.data. |
| F12 | 1 | Confirm how the application is hosted. For serverless deployments, review checkpointing, retries and maxRuntime against the platform timeout. |

## Proposed edits

| Rule | Occurrences | Reviewer action |
| --- | ---: | --- |
| T1 | 1 | Trace the createFunction receiver to its SDK client and check that the legacy trigger belongs in options.triggers. |
| T5 | 1 | Confirm that INNGEST_DEV selects local development and that the production environment supplies the intended signing configuration. |

## Scope

This source-only assessment simulated rule matches and edits in memory. Counts describe occurrences of individual rules. One file may contribute several occurrences. The scan leaves the working tree untouched.

SDK version eligibility, dependency compatibility and runtime behavior require separate verification. Before applying a migration, confirm the installed SDK version and review the patch, type checks and application tests in an authorized environment.
