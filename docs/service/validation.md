# Historical Inngest upgrade check

On November 19, 2026, we ran the extracted Node 22 owner scanner against both sides of a public, merged Inngest v3 to v4 upgrade. Plinth's maintainer reported that a dependency-only update broke startup and type-checking. The subsequent migration changed seven function declarations, the event schema, event sending and tests. [Plinth pull request #90](https://github.com/farulivan/plinth/pull/90)

| Inngest assessment of `apps/api/src` | Before | After |
| --- | ---: | ---: |
| Supported source files inspected | 55 | 55 |
| Files with a recipe match or finding | 10 | 10 |
| Files with proposed edits | 7 | 0 |
| Event schema review findings | 1 | 0 |
| Other manual review findings | 3 | 3 |

All seven proposed edits named function files the maintainer changed. The scanner separately flagged the old event schema for human review. Both revisions produced two conservative client-reference warnings and one deployment review. Those three findings persisted in the migrated version. A review flag alone does not establish that a change is necessary.

The test covered static analysis of the API source directory. It did not execute Plinth, validate the resulting patches, or measure time saved. The maintainer's pull request documents additional work, including event sends and test mocks. Counting the seven function declarations captures one part of the migration.

## Repeat the comparison

Use the parent revision `66b2fb4a0e74aba784068421fcb09040a86f73d5` and the merged revision `ae6765ab3ae5567adc62ab28cfe253eca6b58e70` from the public Plinth repository. Run the same scanner archive against `apps/api/src` in each local checkout. Supply a new aggregate output and a separate local findings file per revision.

```sh
node package/sdk-assessment.cjs assess --recipe inngest-v3-to-v4 \
  --repo /path/to/plinth/apps/api/src \
  --out /path/to/results/before.json --local-report /path/to/results/before-private.json
```

Repeat with the merged revision and fresh output paths. Compare the local entries with rule `T1` and kind `applied` against the seven changed files under `apps/api/src/inngest/functions/`. The target application requires no dependency installation for this check.
