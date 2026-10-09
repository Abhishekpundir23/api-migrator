# Client-pilot release gates

Review date: 2026-10-09. This checklist does not authorize cloud access,
customer source processing, publication, or spending.

The current release is an internal pilot, not a client-ready hosted service.
The first external deliverable should be one supervised migration preview:
an exact source revision, a reviewable patch, verification results, and a human
handoff. Automated PR publication is a separate release gate.

## Required before an external preview

| Gate | Current evidence or blocker | Acceptance evidence |
| --- | --- | --- |
| Release validation | Package builds, tests, container fixtures and console packaging have executable checks. A separate dependency-audit CI job rejects high/critical advisories. | Fresh Node 22 CI, actual runner-image build/integration, and dependency audit for the exact candidate SHA. Audit success is not proof of exploit absence. |
| Safe hosted execution | The production host wrapper exits before reading inputs; the local preview still uses workstation Docker. Hosted fixtures are non-authorizing. | One integrated disposable Linux runner: forced registry gateway during install; no network during migration/checks; independently observed output and teardown. |
| Failure recovery | A disposable blank-disk experiment demonstrated delayed cleanup after the creator exited, once cleanup was armed. Its operational evidence is held outside Git; this checkout alone cannot verify it. Creation-to-arming failure and VM cleanup remain unproven. | Reviewed independent cleanup authority, armed before resource creation, plus failure-injection tests and live resource-absence evidence. A timer, an offline fixture, or a stopped VM is not deletion proof. |
| Source permission and custody | Current pilot policy excludes professional and client-work repositories. No new source scope is authorized by this document. | Explicit policy/owner approval for one new pilot repository, recorded eligibility and retention terms, protected input/output storage, withdrawal and deletion verification. Dynamo, Toloka and other existing professional assets remain excluded. |

The cleanup experiment used exact numeric-ID deletion grants installed after
creation. The provider assigns that ID at creation, leaving a period in which
the exact grant and cleanup execution do not yet exist. Closing this gap needs
a separately reviewed authority design; do not substitute name-based deletion,
wildcard roles, or an unapproved IAM-changing process.

The managed Batch trial now has a separate strict job renderer, public-source
bootstrap, metadata-access checks, bounded off-host log records, and an
operator-side result classifier. Its accepted job owns VM creation and teardown;
the worker is not given disk deletion privileges. This is still an internal
engine smoke, not the production hosted runner. Local tests cannot establish
that a real Batch job ran or that its resources were deleted. Operational
receipts must be checked separately, and Batch's task timeout does not bound
queue or VM-initialization time.

## Additional gates before automated publication

1. Connect the durable runner job/source handoff to actual hosted dispatch,
   independent observation and protected signing. Acquire and reverify a fresh
   opaque runner capability at every privileged boundary; do not replace the
   console's unconditional refusal with a boolean switch.
2. Capture and validate live migration-ref rulesets, default-branch protection
   and exact required-CI identities. Static environment digests are not live
   policy observations.
3. Resolve commit identity before a publication drill. The existing publisher
   derives an App bot identity; commits made from this account must instead
   satisfy the owner's exact author/committer policy. Do not bypass either
   policy or silently rewrite history.
4. Complete one supervised end-to-end sandbox drill: preview, independent
   evidence, owner challenge/signature, one-use authorization, scoped PR
   creation, current-head verification, revocation and retained cleanup proof.
   A repository maintainer decides whether to merge. Never auto-merge.

## Execution order

Finish release validation first. Next, review one cloud authority/lifecycle
design covering pre-creation recovery, isolated execution and off-host evidence,
then implement and drill that complete path. Only after hosted execution works
should a newly authorized external preview run. Complete capability and live
GitHub-policy integration before the sandbox publication drill.

Keep each gate open until its evidence exists for the candidate revision. Do
not count schemas, example reports or successful subcomponent tests as a
completed hosted workflow. The operational details remain in [RUNBOOK.md](RUNBOOK.md)
and the [runner deployment contract](../../ops/publication-runner/deployment/README.md).
