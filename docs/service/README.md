# Run an SDK migration assessment

An SDK maintainer can use this service to find common review work before a breaking release. An application owner runs a source scan on their own machine. The operator receives the exported counts and returns a Markdown review brief. The hosted migration pilot and its [client-source release gates](../pilot/RELEASE-GATES.md) govern any later request to process a customer checkout or publish a PR.

## Owner handoff

1. Confirm which SDK and version the application currently uses. Choose `inngest-v3-to-v4` or `knock-v0-to-v1`. The owner selects the recipe. The scanner does not establish the installed version.
2. Use a separate checkout of API Migrator with Node 22. Run `npm ci --ignore-scripts --no-audit --no-fund` and `npm run build --workspace @api-migrator/engine` in that checkout. Only the tool needs dependencies.
3. Point the scanner at an authorized local application. Pick new files in an existing directory outside the application. Run against a stable working tree.

```bash
handoff=$(mktemp -d)
npm run service -- assess --recipe inngest-v3-to-v4 --repo /path/to/application \
  --out "$handoff/summary.json" --local-report "$handoff/private-findings.json"
```

The scanner parses supported JS and TS files and simulates source rewrites in memory. It does not execute the application, install its dependencies or apply patches. Source inventories are limited to 10,000 files, 1 MiB per file and 32 MiB total. An unreadable or unsupported source file can stop the assessment. Inspect the local diagnostic before rerunning. A clean scan applies only to the selected recipe and files it recognizes.

Open both outputs locally. **Share only `summary.json`** with the SDK team's designated operator by an agreed channel. It contains a schema version, recipe ID, file counts, and per-rule IDs, kinds and counts. The counts still describe application characteristics. Keep the optional private findings file with the owner: it contains paths, line numbers and review details. No data is sent by the scan.

## Operator delivery

Agree on one SDK release and one current assessment per participating repository. Ask the owner for the aggregate summary. For the first handoff, return the brief to the owner and ask which findings required real work, what it took to review them and whether the results helped plan the upgrade.

```bash
npm run service -- brief --summary /intake/one/summary.json --out /delivery/brief.md
npm run service -- campaign --summaries /intake/this-release --out /delivery/campaign.md
```

Create the destination directories beforehand. The campaign command takes 1–100 regular `.json` files directly inside one directory. Put one current summary per different repository there, using the same recipe. Identical counts can come from different repositories. The operator maintains the roster and resolves duplicates. Malformed summaries, private files and mixed recipes cause an error. Use a new output name for each run.

The individual brief lists candidate edits and manual review actions. The campaign brief shows how many assessments contain each issue and the total number of occurrences. The outputs are self-reported static estimates. They do not establish repository identity, build success, compatibility, acceptance of edits or time saved. Use separate authorized verification to answer those questions.

## Optional OpenAI review questions

Configure an OpenAI **project** key on the operator’s machine. The operator can set `OPENAI_API_KEY` in the environment or save the key alone in `~/.config/api-migrator/openai-project.key` (mode 0600 on Unix). If `XDG_CONFIG_HOME` is an absolute path, the file belongs under its `api-migrator/` directory instead. The environment value takes precedence. Only an explicit AI review with manual findings reads the key. Rotate it by replacing its local value. Customer-side scans require no key.

Then run:

```bash
npm run service -- brief --summary /intake/one/summary.json --out /delivery/reviewer-brief.md --ai
```

GPT-6.2 Sol at low reasoning effort drafts one question per manual-review rule and suggests an order. To select GPT-6.1 Sol, set `API_MIGRATOR_AI_MODEL=gpt-6.1-sol`. The only project-derived input sent to the Responses API is the recipe ID and observed review rule IDs/counts, alongside the tool's static descriptions. Results can vary. The deterministic findings remain the basis of the brief.

A review plan uses one request with a 30-second timeout, a 12 KiB request limit, and at most 1,600 output tokens. An assessment with zero review rules skips the API. Requests use `store: false`; the operator's OpenAI project data controls still apply. If the request fails or the response is invalid, the command writes the deterministic brief, marks the AI section unavailable, and exits with status 2. Ordinary input/output errors exit with status 1.

A local quota limits attempts to 100 per UTC month. Lower it via `API_MIGRATOR_AI_MAX_CALLS` (0–100). A failed or interrupted request consumes one slot. The ledger lives under `$XDG_STATE_HOME/api-migrator/review-plan-attempts` or defaults to `~/.local/state/api-migrator/review-plan-attempts`. Keep it on persistent storage and use a single operator account or a shared ledger for this pilot. This cap covers that ledger only. Check the API project's usage and billing for actual credit consumption. [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-6.2-sol)

## Acceptance for a first assessment

- The owner selects a supported release, runs the scan locally, and inspects what they share.
- The operator returns the complete rule counts and review actions. The owner checks at least one actionable finding against the private local report.
- The SDK maintainer records whether the brief changed their plan, reviewer time, and whether they want a second assessment.
- For hosted execution or publication, use the existing pilot release process. Local assessment results cannot authorize either action.
