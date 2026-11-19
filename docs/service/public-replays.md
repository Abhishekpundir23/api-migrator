# Public repository migration checks

These checks use local copies of public applications. The blind trial used the packaged 0.1.2 scanner. Version 0.1.3 adds support for an ambient TypeScript declaration discovered in Plinth and corrects advice about sending events from inside a durable step. Version 0.1.4 excludes Yarn’s bundled package manager from the owner assessment. Each static replay uses the complete pinned checkouts. No project owner participated.

| Project and source scope | Evidence before the upgrade | Evidence after the upgrade |
| --- | --- | --- |
| Kira Research, 337 JS/TS files | The dependency-only PR fails on webhook import. The scanner flags the registration at line 65. | Moving the trigger into the first options argument clears that finding and restores both SDK registrations. The scanner proposes no client edit. Two deployment reviews remain. |
| Mako, 1,172 JS/TS files | The scanner proposes changes to all 29 legacy registrations across the 13 function files changed by the maintainer. | The merged app receives zero proposed edits. Static warnings about unresolved imports, deployment configuration and event sends still need interpretation. |
| RXJ, 616 JS/TS files | The scanner locates all eight calls tied to CI’s argument-count errors. Seven receive proposed edits and one receives manual review. It also flags middleware at the location of a separate type error. | The PR changes only dependencies. The source assessment should therefore stay identical. It does not enumerate all downstream publishers, channels and token consumers affected by RXJ’s legacy realtime package. |
| Plinth, 301 JS/TS files | Seven trigger edits match the seven files the maintainer changed. The old event schema receives manual review. Previously the full scan aborted on a valid export alias in a generated worker declaration. | Zero edits. The schema warning clears. Two import reviews and a deployment review remain. |
| Knock JavaScript monorepo, 294 JS/TS files | Sixteen edit suggestions and three manual findings cover all seven source files changed in the upgrade. Six files receive edits. The remaining file needs manual response-type narrowing. | All findings clear. The checkout includes 517 tracked files on each side. Version 0.1.3 stopped at the unchanged 2.7 MB Yarn binary. Version 0.1.4 skips `.yarn/releases` and continues to assess application files and project Yarn plugins. |

The Kira checks used the real v3.54.2 and v4.26.2 SDKs. The repaired v4 webhook registered the same event and failure handler as v3. With client code untouched, the v4 SDK selected dev mode for `1`, `true`, and a Dev Server URL. Unset, `0`, and `false` selected cloud mode. The runtime probes used no live credentials or external services. [Kira PR](https://github.com/henryvn2004-arch/kira-research/pull/177) · [SDK environment settings](https://www.inngest.com/docs/sdk/environment-variables)

RXJ’s base passed type check, core tests and build. The dependency-only head failed all three. An event send in its workflow occurs after a database write inside a step callback. The scanner now asks reviewers to check retry behavior before separating those operations and keeps nested steps out of its recommendation. [RXJ type check](https://github.com/rjumair711/n8n_clone/actions/runs/39056822113/job/117466382030) · [Event-send call site](https://github.com/rjumair711/n8n_clone/blob/adc3c6ba29c37dc3aee4476d8f9fcea1807b213f/src/inngest/functions.ts#L957-L985)

## Blind Mako trial

The participant received an archive of the v3 source tree without Git history, scanner 0.1.2, Node 22 and the target SDK version 4.18.1. It could consult package metadata and official documentation. The maintainer’s diff, another agent’s evaluation criteria and the expected results were withheld. A separate evaluator captured the original v3 registration contracts and ran the same checks on the maintainer’s v4 merge.

The scanner identified 29 trigger edits across 13 files. The participant made its changes on a disposable copy. The second scan proposed zero edits and retained 19 reviews. The maintainer’s merged tree also returned zero proposed edits and 19 reviews. Those counts alone cannot distinguish a working application from one that fails to compile.

The blind migration passed the independent acceptance run. All eight local SDK profiles matched the original v3 registration contracts, including 29 main functions and an SDK-generated failure registration in production. All main handlers and the failure handler kept the same executable syntax trees. Five representative handler executions matched. The production API compiled, six dependency checks passed, and the app’s own development route returned HTTP 200 with 23 registrations. As controls, the untouched source failed under v4 and the maintainer’s upgrade passed.

Compiler and runtime tests found work beyond the scanner’s trigger changes. The participant corrected the registry and notification payload types. The v4 SDK returned HTTP 401 to the preview deployment’s unsigned readiness check. The upstream merge’s workflow retried five times and exited successfully without registering. Replaying the participant’s workflow reached `GET /health` once, then `PUT /api/inngest`, and delivered 23 registrations to a local test receiver.

The participant installed its own frozen lockfile and passed the API production build. The independent compiler also passed using the maintainer’s dependency graph. The participant chose to disable v4 checkpointing to preserve v3 request boundaries on Cloud Run. The effects of that choice under production load, DB-backed handler paths and a live cloud deployment remain unverified. One database test could not start its MongoDB executable. Local probes used the real SDK and synthetic credentials, with test doubles for business services. Both the submitted copy and the maintainer’s merge still contain three Markdown examples of the old function signature. The scanner checks JS/TS sources.

## Reproduce the static checks

Use Node 22, the versioned archive from `website/downloads`, and a local checkout of each revision below. Extract the scanner outside both source trees and choose a fresh report directory. The harness runs the owner CLI twice and asserts the recorded migration signals. It does not need dependencies from the application.

```sh
node scripts/assessment-package/verify-replay.mjs mako \
  /path/to/package/sdk-assessment.cjs /path/to/before /path/to/after /path/to/new-reports
```

| Case | Repository | Before | After |
| --- | --- | --- | --- |
| `mako` | [Mako #889](https://github.com/mako-ai/mako/pull/889) | `ae0db279492d1a00f4c1048fe0e25d0ce17d788e` | `df7688cd61bb341a5dda865334850715c4ace6f2` |
| `rxj` | [RXJ #48](https://github.com/rjumair711/n8n_clone/pull/48) | `8215fe01a2376b85c54d0c6e09dfe12169548b4d` | `adc3c6ba29c37dc3aee4476d8f9fcea1807b213f` |
| `plinth` | [Plinth #90](https://github.com/farulivan/plinth/pull/90) | `66b2fb4a0e74aba784068421fcb09040a86f73d5` | `ae6765ab3ae5567adc62ab28cfe253eca6b58e70` |
| `kira` | [Kira #177](https://github.com/henryvn2004-arch/kira-research/pull/177) | `0fc347a8dfb6adc5d82f3efc8b748b138adb3d1c` | A local repair of the same revision |
| `knock` | [Knock #558](https://github.com/knocklabs/javascript/pull/558) | `0d5bbf9aa3278d4fc75b184da9639bbabcb0b32b` | `81ae9dc738f46842eca5ecf0bb6536055c2e7b57` |

For Kira’s after tree, edit only `studioGen` in `api/_lib/studio-workflow.js`. Move `{ event: 'studio/job.created' }` from the second argument into `triggers` in the first argument. Keep the handler, the failure handler and the client configuration. The official guide permits a trigger object or an array. [Inngest v4 migration guide](https://www.inngest.com/docs/reference/typescript/v4/migrations/v3-to-v4)
