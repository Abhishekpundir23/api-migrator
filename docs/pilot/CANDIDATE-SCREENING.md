# Candidate repository screening

Candidate discovery is read-only research. It does not authorize cloning,
running code, installing the App, opening a pull request, or contacting an
owner.

Every repository designated as professional or client work is
excluded without further screening. Do not contact, clone, install, preview, or
publish against those accounts or repositories even when their metadata or
source is public.

## Metadata screen

Prefer repositories that are:

- public and independently maintained rather than official provider fixtures;
- TypeScript/Node applications with visible Inngest v3 usage;
- npm projects with lockfile version 2 or 3;
- actively maintained, with recent commits and a clear owner contact path;
- covered by type-check, test, lint, and CI commands;
- licensed in a way that permits inspection and contribution;
- deployed using a runtime profile the migration inventory can classify.

Reject or defer repositories that:

- belong to an account or organization explicitly outside the pilot scope;
- have no clear owner authorization path;
- use pnpm, Yarn, Bun, unsupported project references, or an unsupported
  runtime unless that support is deliberately implemented first;
- require production secrets, external side effects, or destructive tests;
- contain generated/vendored copies that make affected-usage ownership
  ambiguous;
- already completed the target migration or are abandoned.

## Research record

For each candidate, record only public metadata:

- repository URL and license;
- owner/contact path;
- evidence and observation date for Inngest version and import/call patterns;
- package manager and lockfile version;
- TypeScript configuration shape;
- visible test/lint/type-check/CI commands;
- deployment/runtime clues;
- last meaningful activity date;
- compatibility uncertainties and rejection reasons.

Do not copy source excerpts, personal contact details, or vulnerability claims
into the product repository. Recheck every fact immediately before outreach.

## Owner-approval transition

Outreach and owner authorization are separate from research. Once outreach is
authorized, explain that the first step is a non-publishing preview, state the
exact data and command boundaries, and provide the authorization, permissions,
data-handling, and revocation documents. A positive reply is not publication
approval; complete the authorization record before any clone or App action.
