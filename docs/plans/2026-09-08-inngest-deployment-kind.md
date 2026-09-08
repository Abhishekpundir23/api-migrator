# Inngest deployment declaration

## Approved design

The campaign manifest carries an optional strict `deployment` object with
`kind: "long-running" | "serverless"`. This is an operator declaration, not
proof of hosting. The Node runtime profile remains a separate requirement.

- New Inngest campaigns require an explicit choice in the console/API.
- CLI previews accept `--deployment-kind`; omission remains unknown.
- Stored legacy campaigns are never assigned a deployment kind automatically.
- Long-running clears F12 only. Other review findings and verification failures
  remain publication blockers. Serverless and unknown remain F12-blocked.
- F12 is mandatory for Inngest pipeline runs even with a transform subset.
- Reports, previews and campaign details show the operator declaration.
- Canonical manifests bind the choice to previews, receipts and runner replay;
  changing the declaration requires a new preview and owner authorization.
- One campaign covers one hosting model. Mixed deployments need separate
  campaigns. No serverless configuration rewrites or publication enablement.

Inngest documents no checkpointing configuration for always-on servers and a
`maxRuntime` below the platform limit for serverless:
https://www.inngest.com/docs/setup/checkpointing

## Implementation and verification

1. Add failing tests for strict schema, F12 propagation/bypass, report evidence,
   new-campaign validation, CLI arguments and declaration-bound receipts.
2. Implement the engine contract and carry it through app/console boundaries.
3. Replace the runner image fixture's T1-T5 workaround with the complete
   transform set and an explicit long-running declaration.
4. Verify focused tests, full CI, rendered console and actual runner image.
5. Prepare a reviewable PR. Do not merge or access professional repositories.

The live campaign gate resets its database and is not part of local validation.
Local fixtures must not touch the operator's existing campaign database.
