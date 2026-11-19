# Knock Node v0 to v1 replay

The 0.1.1 offline assessment was checked against Knock’s own merged migration of two example applications from Node SDK v0 to v1. The test used the seven changed TS/TSX files from the Next.js and Slack examples, then all 36 supported source files in both applications. The two versions were pinned to the first parent, `0d5bbf9aa3278d4fc75b184da9639bbabcb0b32b`, and the merge, `81ae9dc738f46842eca5ecf0bb6536055c2e7b57`. [Upstream migration diff](https://github.com/knocklabs/javascript/pull/558/files)

| Scanner and revision | Source files checked | Files with proposed edits | Proposed edit occurrences | Manual findings |
| --- | ---: | ---: | ---: | ---: |
| 0.1.0, before | 7 | 6 | 8 | 5 |
| 0.1.1, before | 7 | 6 | 16 | 3 |
| 0.1.0, after | 7 | 0 | 0 | 2 |
| 0.1.1, after | 7 | 0 | 0 | 0 |

The 0.1.1 findings pointed to all seven changed files. Scanning the full applications added 29 files and produced the same findings. The scanner returned the following actions on the pre-upgrade code.

| Changed source | Assessment |
| --- | --- |
| Next.js API auth | Import the standalone token signer and migrate its call. |
| Next.js API identify | Migrate the client import and constructor, map the host to `baseURL`, update `users.identify`, and import the standalone signer. |
| Next.js API notify | Migrate the client import and convert the two constructor arguments to v1 client options, including the host. |
| Slack user lookup | Migrate the client import and constructor and wrap the channel update payload in `{ data }`. |
| Slack channel-data page | Two manual findings identify the calls whose provider-specific response fields require type narrowing. |
| Slack layout | Move the signer, both grant-builder calls, and the legacy `Grants` import to the v1 exports. |
| Slack SDK wrapper | Migrate the client import and constructor. A manual finding directs the reviewer to replace the two legacy recipient types with the v1 workflow input type. |

A TypeScript compiler check used the actual published `@knocklabs/node@1.2.0` declarations for a transformed example covering custom-host construction, user updates, channel data, token signing and grants. A second transform pass on that example was clean. The historical replay performed static analysis. Application runtime behavior, provider-specific business logic and customer acceptance require separate verification.

## Reproduce locally

Check out both revisions of `knocklabs/javascript` in separate directories. With Node 22, extract the 0.1.1 scanner archive outside those directories. Run the following command on each revision for each of `examples/nextjs-example` and `examples/slack-kit-example`, choosing fresh output paths for each run.

```sh
node package/sdk-assessment.cjs assess --recipe knock-v0-to-v1 \
  --repo /path/to/revision/examples/nextjs-example \
  --out /path/to/results/before-next-summary.json \
  --local-report /path/to/results/before-next-findings.json
```

Before the upgrade, the Next.js example has seven edit occurrences across three files. The Slack example has nine edit occurrences across three files and three manual findings across two files. After the upgrade, both applications have zero proposed edits and zero review findings. Run type checks and tests on any resulting migration before releasing it.
