# Kira Research pilot invitation

Prepared November 19, 2026. Unsent draft for the Kira Research maintainer, `henryvn2004-arch`, on the existing upgrade PR. Dependabot opened the upgrade. The maintainer has yet to express interest in a pilot. [Inngest upgrade PR #177](https://github.com/henryvn2004-arch/kira-research/pull/177)

## Draft PR comment

> Hi! I saw your note on #170 about checking SDK calls by hand. I’m building API Migrator and tried it on two public files from the base of this PR. It flagged your `studioGen` report job because the `studio/job.created` trigger is still the second argument to `createFunction`. In v4 it moves into `options.triggers`.
>
> Would you try the scanner on your v3 checkout before merging and tell me one thing it caught or missed that mattered to your review? It runs locally with Node 22, leaves your files alone, and needs no API key. Your code stays on your machine. If you share the aggregate counts, I’ll send back a short checklist for this PR. [Scanner and quickstart](https://api-migrator.loyalhobby2.chatgpt.site/#quickstart)
>
> — Abhishek

## Basis for the invitation

PR #177 proposes Inngest 3.54.2 to 4.26.2 and changes only the manifest and lockfile. In a separate dependency upgrade, the maintainer documented inspecting each affected SDK call against the new types. [Upgrade diff](https://github.com/henryvn2004-arch/kira-research/pull/177/files) · [Maintainer’s review on PR #170](https://github.com/henryvn2004-arch/kira-research/pull/170)

Scanner 0.1.1 ran against the two public files at PR base `3e4e29607d24832e714731b50a9f7346a47f5875`. It proposed a development-mode change in the client and flagged the workflow’s three-argument call for manual review because the client is imported from a local module. It also asked for the deployment type. The sample covered only those two files. [Client](https://github.com/henryvn2004-arch/kira-research/blob/3e4e29607d24832e714731b50a9f7346a47f5875/api/_lib/inngest-client.js) · [Studio workflow](https://github.com/henryvn2004-arch/kira-research/blob/3e4e29607d24832e714731b50a9f7346a47f5875/api/_lib/studio-workflow.js#L65-L108)
