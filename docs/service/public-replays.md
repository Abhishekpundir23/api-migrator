# Public repository migration checks

These checks use local copies of public applications. No project owner participated. The blind trial used the packaged 0.1.2 scanner. Version 0.1.3 adds support for a TypeScript declaration discovered in the full Plinth checkout and corrects the guidance for sending an event from inside a durable step.

| Project and source scope | Evidence before the upgrade | Evidence after the upgrade |
| --- | --- | --- |
| Kira Research, 337 JS/TS files | The dependency-only PR fails on webhook import. The scanner flags the registration at line 65. | Moving the trigger into the first options argument clears that finding and restores both SDK registrations. The scanner proposes no client edit. Two deployment reviews remain. |
| Mako, 1,172 JS/TS files | The scanner proposes changes to all 29 legacy registrations across the 13 function files changed by the maintainer. | The merged app receives zero proposed edits. Static warnings about unresolved imports, deployment configuration and event sends still need interpretation. |
| RXJ, 616 JS/TS files | The scanner locates all eight calls tied to CI’s argument-count errors. Seven receive proposed edits and one receives manual review. It also flags middleware at the location of a separate type error. | The PR changes only dependencies. The source assessment should therefore stay identical. It does not enumerate all downstream publishers, channels and token consumers affected by RXJ’s legacy realtime package. |
| Plinth, 301 JS/TS files | Seven trigger edits match the seven files the maintainer changed. The old event schema receives manual review. Previously the full scan aborted on a valid export alias in a generated worker declaration. | Zero edits. The schema warning clears. Two import reviews and a deployment review remain. |

The Kira checks used the real v3.54.2 and v4.26.2 SDKs. The repaired v4 webhook registered the same event and failure handler as v3. With client code untouched, the v4 SDK selected dev mode for `1`, `true`, and a Dev Server URL. Unset, `0`, and `false` selected cloud mode. The runtime probes used no live credentials or external services. [Kira PR](https://github.com/henryvn2004-arch/kira-research/pull/177) · [SDK environment settings](https://www.inngest.com/docs/sdk/environment-variables)

RXJ’s base passed type check, core tests and build. The dependency-only head failed all three. An event send in its workflow occurs after a database write inside a step callback. The scanner now asks reviewers to check retry behavior before separating those operations and keeps nested steps out of its recommendation. [RXJ type check](https://github.com/rjumair711/n8n_clone/actions/runs/39056822113/job/117466382030) · [Event-send call site](https://github.com/rjumair711/n8n_clone/blob/adc3c6ba29c37dc3aee4476d8f9fcea1807b213f/src/inngest/functions.ts#L957-L985)

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

For Kira’s after tree, edit only `studioGen` in `api/_lib/studio-workflow.js`. Move `{ event: 'studio/job.created' }` from the second argument into `triggers` in the first argument. Keep the handler, the failure handler and the client configuration. The official guide permits a trigger object or an array. [Inngest v4 migration guide](https://www.inngest.com/docs/reference/typescript/v4/migrations/v3-to-v4)
