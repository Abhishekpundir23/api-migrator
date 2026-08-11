"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buildPreviewEvidence, type PreviewResultInput } from "../../../lib/preview";
import { RUNNER_CAPABILITY_PROVIDER_AVAILABLE } from "../../../lib/runner-capability";

type ResultItem = PreviewResultInput;

interface OwnerChallengeReview {
  pilotId: string;
  approvalEvidenceDigest: string;
  preRunAuthorizationDigest: string;
  previewCompletedAt: number;
  authorizationExpiresAt: number;
  repository: { slug: string; id: number; ownerId: number };
  github: { appId: number; installationId: number };
  base: { branch: string; sha: string };
  engine: { tag: string; commit: string };
  manifest: { byteLength: number; digest: string };
  preview: {
    preflightId: string;
    artifactDigest: string;
    candidateBranch: string;
    candidateTreeSha: string;
    findingsDigest: string;
    resolutionsDigest: string;
    commandScopeDigest: string;
    runnerAttestationDigest: string;
    rulesetDigest: string;
    requiredCiDigest: string;
  };
  allowedActions: string[];
  pullRequestNumber: number | null;
}

interface RunResponse {
  mode?: "preview" | "prepare_owner_challenge" | "prepare_publish" | "publish";
  error?: string;
  summary?: { results?: ResultItem[] };
  previewReceipt?: string | null;
  previewReceiptExpiresAt?: number | null;
  operatorApprovalToken?: string | null;
  confirmationPhrase?: string | null;
  approvalExpiresAt?: number | null;
  ownerAuthorizationDigest?: string | null;
  manifestDigest?: string | null;
  challengeJson?: string | null;
  challengeDigest?: string | null;
  challengeExpiresAt?: number | null;
  ownerChallengeReceipt?: string | null;
  ownerChallengeDigest?: string | null;
  review?: OwnerChallengeReview | null;
}

/** Local operator form: preview, attach owner authorization, then approve. */
export default function RunForm({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [slugs, setSlugs] = useState("");
  const [results, setResults] = useState<ResultItem[]>([]);
  const [previewReceipt, setPreviewReceipt] = useState<string | null>(null);
  const [challengeJson, setChallengeJson] = useState<string | null>(null);
  const [challengeDigest, setChallengeDigest] = useState<string | null>(null);
  const [challengeExpiresAt, setChallengeExpiresAt] = useState<number | null>(null);
  // Opaque server receipt: retained only in memory for prepare_publish and
  // never rendered, downloaded, logged, or placed in a DOM attribute.
  const [ownerChallengeReceipt, setOwnerChallengeReceipt] = useState<string | null>(null);
  const [challengeReview, setChallengeReview] = useState<OwnerChallengeReview | null>(null);
  const [ownerAuthorizationEnvelope, setOwnerAuthorizationEnvelope] = useState("");
  const [operatorApprovalToken, setOperatorApprovalToken] = useState<string | null>(null);
  const [ownerAuthorizationDigest, setOwnerAuthorizationDigest] = useState<string | null>(null);
  const [manifestDigest, setManifestDigest] = useState<string | null>(null);
  const [confirmationPhrase, setConfirmationPhrase] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    "preview" | "prepare_owner_challenge" | "prepare_publish" | "publish" | null
  >(null);
  const publishableCount = results.filter((result) => result.status === "preview_ready").length;

  function clearFinalApproval() {
    setOperatorApprovalToken(null);
    setOwnerAuthorizationDigest(null);
    setManifestDigest(null);
    setConfirmationPhrase(null);
    setConfirmation("");
  }

  function clearOwnerChallenge() {
    setChallengeJson(null);
    setChallengeDigest(null);
    setChallengeExpiresAt(null);
    setOwnerChallengeReceipt(null);
    setChallengeReview(null);
  }

  async function preview(e: React.FormEvent) {
    e.preventDefault();
    setBusy("preview");
    setError(null);
    setResults([]);
    setPreviewReceipt(null);
    clearOwnerChallenge();
    setOwnerAuthorizationEnvelope("");
    clearFinalApproval();
    const repoSlugs = slugs
      .split(/[\n,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (repoSlugs.length === 0) {
      setError("Enter at least one owner/repo slug.");
      setBusy(null);
      return;
    }
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", repoSlugs, concurrency: 1 }),
      });
      const data = (await res.json()) as RunResponse;
      if (!res.ok) {
        setError(data.error ?? "preview failed");
        setBusy(null);
        return;
      }
      setResults(data.summary?.results ?? []);
      setPreviewReceipt(data.previewReceipt ?? null);
      setBusy(null);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  async function prepareOwnerChallenge() {
    if (!RUNNER_CAPABILITY_PROVIDER_AVAILABLE || !previewReceipt || publishableCount !== 1 || operatorApprovalToken !== null) return;
    setBusy("prepare_owner_challenge");
    setError(null);
    clearOwnerChallenge();
    setOwnerAuthorizationEnvelope("");
    clearFinalApproval();
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare_owner_challenge", previewReceipt }),
      });
      const data = (await res.json()) as RunResponse;
      if (!res.ok) {
        setError(data.error ?? "owner challenge preparation failed");
        setBusy(null);
        return;
      }
      if (
        !data.challengeJson ||
        !data.challengeDigest ||
        !data.challengeExpiresAt ||
        !data.ownerChallengeReceipt
      ) {
        clearOwnerChallenge();
        setError("owner challenge response was incomplete; generate a new challenge");
        setBusy(null);
        return;
      }
      setChallengeJson(data.challengeJson);
      setChallengeDigest(data.challengeDigest);
      setChallengeExpiresAt(data.challengeExpiresAt);
      setOwnerChallengeReceipt(data.ownerChallengeReceipt);
      setChallengeReview(data.review ?? null);
      setBusy(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  function downloadOwnerChallenge() {
    if (!challengeJson || !challengeDigest) return;
    const blob = new Blob([challengeJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `api-migrator-owner-challenge-${challengeDigest.slice(7, 19)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function preparePublish() {
    if (
      !RUNNER_CAPABILITY_PROVIDER_AVAILABLE ||
      !previewReceipt ||
      !challengeDigest ||
      !ownerChallengeReceipt ||
      publishableCount !== 1 ||
      ownerAuthorizationEnvelope.length === 0
    ) return;
    setBusy("prepare_publish");
    setError(null);
    clearFinalApproval();
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "prepare_publish",
          previewReceipt,
          ownerChallengeReceipt,
          ownerAuthorizationEnvelope,
        }),
      });
      const data = (await res.json()) as RunResponse;
      if (!res.ok) {
        setError(data.error ?? "publication preparation failed");
        setBusy(null);
        return;
      }
      if (
        data.ownerChallengeDigest !== challengeDigest ||
        !data.operatorApprovalToken ||
        !data.confirmationPhrase ||
        !data.ownerAuthorizationDigest ||
        !data.manifestDigest
      ) {
        setOwnerChallengeReceipt(null);
        clearFinalApproval();
        setError("publication approval response was incomplete or mismatched; run a new preview");
        setBusy(null);
        return;
      }
      setOperatorApprovalToken(data.operatorApprovalToken);
      setOwnerAuthorizationDigest(data.ownerAuthorizationDigest);
      setManifestDigest(data.manifestDigest);
      setConfirmationPhrase(data.confirmationPhrase);
      // The one-use preview is consumed now and the operator token carries the
      // digest; the raw challenge receipt has no further purpose.
      setOwnerChallengeReceipt(null);
      setBusy(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  async function publish() {
    if (!RUNNER_CAPABILITY_PROVIDER_AVAILABLE || !operatorApprovalToken || !confirmationPhrase || publishableCount !== 1) return;
    const dispatchedToken = operatorApprovalToken;
    const dispatchedEnvelope = ownerAuthorizationEnvelope;
    const dispatchedConfirmation = confirmation;
    // Once dispatched, the server may consume the one-use controls or create a
    // PR even if the response is lost. Drop sensitive/stale state immediately;
    // every retry must begin with a fresh preview and owner envelope.
    setPreviewReceipt(null);
    setOwnerAuthorizationEnvelope("");
    clearOwnerChallenge();
    clearFinalApproval();
    setBusy("publish");
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "publish",
          operatorApprovalToken: dispatchedToken,
          ownerAuthorizationEnvelope: dispatchedEnvelope,
          confirmation: dispatchedConfirmation,
        }),
      });
      const data = (await res.json()) as RunResponse;
      if (!res.ok) {
        if (data.summary) {
          setResults(data.summary.results ?? []);
          // The approval was consumed once publication acquired the run lock.
          // Outcome failures require a fresh preview before any retry.
        }
        setError(data.error ?? "publication failed");
        setBusy(null);
        router.refresh();
        return;
      }
      setResults(data.summary?.results ?? []);
      setBusy(null);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <form onSubmit={preview}>
      <div className="field">
        <label>Repository slug (owner/repo; one repository in this milestone)</label>
        <textarea
          value={slugs}
          disabled={operatorApprovalToken !== null}
          onChange={(e) => {
            setSlugs(e.target.value);
            setResults([]);
            setPreviewReceipt(null);
            clearOwnerChallenge();
            setOwnerAuthorizationEnvelope("");
            clearFinalApproval();
          }}
          placeholder="owner/repo"
          style={{ minHeight: 100 }}
        />
      </div>
      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
      {results.length > 0 && (
        <section className="preview-results" aria-label="Migration preview evidence">
          <div className="preview-results-heading">
            <div>
              <h3>{previewReceipt ? "Preview evidence" : "Run evidence"}</h3>
              <p className="muted">Review each repository&apos;s identity, files, checks, and warnings.</p>
            </div>
            {previewReceipt && <span className="badge preview_ready">1 ready</span>}
          </div>
          {results.map((result) => (
            <PreviewEvidenceCard result={result} key={`${result.slug}-${result.status}`} />
          ))}
        </section>
      )}
      <button
        type="submit"
        className="btn"
        disabled={busy !== null || operatorApprovalToken !== null}
      >
        {busy === "preview" ? "Generating safe preview..." : "Preview migration"}
      </button>

      {previewReceipt && publishableCount === 1 && (
        <div className="approval card">
          <h3>Create repository-owner challenge</h3>
          {!RUNNER_CAPABILITY_PROVIDER_AVAILABLE ? (
            <p className="muted">
              Unavailable in this build: the independently verified runner-capability provider has not
              been deployed. Preview remains available and creates no remote changes.
            </p>
          ) : (
            <>
          <p>
            Re-run this exact preview with read-only GitHub App identity and current remote-state checks,
            then download the canonical challenge for offline owner review and signing.
          </p>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || operatorApprovalToken !== null}
            onClick={prepareOwnerChallenge}
          >
            {busy === "prepare_owner_challenge" ? "Rechecking exact preview..." : "Generate owner challenge"}
          </button>
          {challengeJson && challengeDigest ? (
            <div className="evidence-section">
              <p><strong>Challenge digest:</strong> <code>{challengeDigest}</code></p>
              <p>
                <strong>Challenge expires:</strong>{" "}
                {challengeExpiresAt ? new Date(challengeExpiresAt).toISOString() : "Not reported"}
              </p>
              {challengeReview ? (
                <div className="evidence-grid">
                  <EvidenceValue label="Pilot ID" value={challengeReview.pilotId} />
                  <EvidenceValue label="Repository" value={challengeReview.repository.slug} important />
                  <EvidenceValue label="Repository ID" value={String(challengeReview.repository.id)} />
                  <EvidenceValue label="Owner ID" value={String(challengeReview.repository.ownerId)} />
                  <EvidenceValue label="GitHub App ID" value={String(challengeReview.github.appId)} />
                  <EvidenceValue label="Installation ID" value={String(challengeReview.github.installationId)} />
                  <EvidenceValue label="Base branch" value={challengeReview.base.branch} />
                  <EvidenceValue label="Base commit" value={challengeReview.base.sha} important />
                  <EvidenceValue label="Engine tag" value={challengeReview.engine.tag} />
                  <EvidenceValue label="Engine commit" value={challengeReview.engine.commit} />
                  <EvidenceValue
                    label="Manifest bytes"
                    value={String(challengeReview.manifest.byteLength)}
                  />
                  <EvidenceValue label="Manifest digest" value={challengeReview.manifest.digest} important />
                  <EvidenceValue
                    label="Preview completed"
                    value={new Date(challengeReview.previewCompletedAt).toISOString()}
                  />
                  <EvidenceValue
                    label="Authorization expires"
                    value={new Date(challengeReview.authorizationExpiresAt).toISOString()}
                  />
                  <EvidenceValue
                    label="Approval evidence"
                    value={challengeReview.approvalEvidenceDigest}
                  />
                  <EvidenceValue
                    label="Pre-run authorization"
                    value={challengeReview.preRunAuthorizationDigest}
                  />
                  <EvidenceValue label="Preflight ID" value={challengeReview.preview.preflightId} important />
                  <EvidenceValue label="Artifact digest" value={challengeReview.preview.artifactDigest} important />
                  <EvidenceValue label="Candidate branch" value={challengeReview.preview.candidateBranch} />
                  <EvidenceValue label="Candidate tree" value={challengeReview.preview.candidateTreeSha} important />
                  <EvidenceValue label="Findings set" value={challengeReview.preview.findingsDigest} />
                  <EvidenceValue label="Resolutions set" value={challengeReview.preview.resolutionsDigest} />
                  <EvidenceValue label="Command scope" value={challengeReview.preview.commandScopeDigest} />
                  <EvidenceValue label="Allowed actions" value={challengeReview.allowedActions.join(" → ")} />
                  <EvidenceValue
                    label="Pull request"
                    value={challengeReview.pullRequestNumber === null
                      ? "Create new"
                      : String(challengeReview.pullRequestNumber)}
                  />
                  <EvidenceValue
                    label="Runner attestation"
                    value={challengeReview.preview.runnerAttestationDigest}
                  />
                  <EvidenceValue label="Ruleset evidence" value={challengeReview.preview.rulesetDigest} />
                  <EvidenceValue label="Required CI" value={challengeReview.preview.requiredCiDigest} />
                </div>
              ) : null}
              <p className="muted">
                Download outside the project workspace, set the file to owner-only permissions, and
                compare this digest when invoking the offline signer.
              </p>
              <button type="button" className="btn" onClick={downloadOwnerChallenge}>
                Download canonical challenge
              </button>
            </div>
          ) : null}

          <h3>Attach repository-owner authorization</h3>
          <p>
            Select the separately signed owner-envelope file for this exact preview. Its bytes stay only
            in this page&apos;s memory and the current request; the server never returns, logs, or persists it.
          </p>
          <label htmlFor="owner-authorization-envelope">Signed owner authorization envelope file</label>
          <input
            key={`${previewReceipt}:${challengeDigest ?? "no-challenge"}`}
            id="owner-authorization-envelope"
            type="file"
            accept="application/json,.json"
            disabled={ownerChallengeReceipt === null || operatorApprovalToken !== null}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) {
                setOwnerAuthorizationEnvelope("");
                clearFinalApproval();
                return;
              }
              if (file.size <= 0 || file.size > 64 * 1024) {
                setOwnerAuthorizationEnvelope("");
                setError("Owner envelope must be a non-empty file of at most 65536 bytes.");
                clearFinalApproval();
                return;
              }
              try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                // Preserve a leading BOM as data so the strict canonical
                // verifier rejects it instead of silently changing file bytes.
                const exactEnvelope = new TextDecoder("utf-8", {
                  fatal: true,
                  ignoreBOM: true,
                }).decode(bytes);
                const roundTrip = new TextEncoder().encode(exactEnvelope);
                if (
                  roundTrip.length !== bytes.length ||
                  roundTrip.some((value, index) => value !== bytes[index])
                ) {
                  throw new Error("owner envelope bytes changed during UTF-8 decoding");
                }
                setOwnerAuthorizationEnvelope(exactEnvelope);
                setError(null);
              } catch {
                setOwnerAuthorizationEnvelope("");
                setError("Owner envelope must contain valid UTF-8 JSON bytes.");
              }
              clearFinalApproval();
            }}
          />
          {ownerAuthorizationEnvelope.length > 0 ? (
            <p className="muted">Envelope loaded: {new TextEncoder().encode(ownerAuthorizationEnvelope).length} bytes.</p>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={
              busy !== null ||
              challengeDigest === null ||
              ownerChallengeReceipt === null ||
              ownerAuthorizationEnvelope.length === 0 ||
              operatorApprovalToken !== null
            }
            onClick={preparePublish}
          >
            {busy === "prepare_publish" ? "Binding exact authorization..." : "Prepare publication approval"}
          </button>

          {operatorApprovalToken && confirmationPhrase && ownerAuthorizationDigest && (
            <div className="evidence-section warning">
              <p><strong>Exact envelope digest:</strong> <code>{ownerAuthorizationDigest}</code></p>
              {manifestDigest ? <p><strong>Canonical manifest digest:</strong> <code>{manifestDigest}</code></p> : null}
              <p>Re-check the preflight, artifact, candidate tree, and envelope digest before publishing.</p>
              <label htmlFor="confirmation">Type {confirmationPhrase} to confirm</label>
              <input
                id="confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
              />
              <button
                type="button"
                className="btn danger"
                disabled={busy !== null || confirmation !== confirmationPhrase}
                onClick={publish}
              >
                {busy === "publish" ? "Publishing approved PR..." : "Publish approved PR"}
              </button>
            </div>
          )}
            </>
          )}
        </div>
      )}
    </form>
  );
}

function PreviewEvidenceCard({ result }: { result: ResultItem }) {
  const evidence = buildPreviewEvidence(result);
  const summary = result.report?.summary;
  return (
    <article className={`preview-card ${evidence.publishable ? "ready" : "not-ready"}`}>
      <header className="preview-card-header">
        <div>
          <strong><code>{evidence.slug}</code></strong>
          {summary ? <div className="muted preview-summary">{summaryText(summary)}</div> : null}
        </div>
        <span className={`badge ${evidence.status}`}>{friendlyStatus(evidence.status)}</span>
      </header>

      <div className="evidence-grid">
        <EvidenceValue label="Preflight ID" value={evidence.identity.preflightId} important />
        <EvidenceValue label="Artifact fingerprint" value={evidence.identity.artifactDigest} important />
        <EvidenceValue label="Candidate tree" value={evidence.identity.candidateTreeSha} important />
        <EvidenceValue label="Base branch" value={evidence.identity.baseBranch} />
        <EvidenceValue label="Base commit" value={evidence.identity.baseSha} />
        <EvidenceValue label="Approved PR head" value={evidence.identity.headSha} />
        <EvidenceValue label="Proposed branch" value={evidence.identity.targetBranch} />
        <EvidenceValue
          label="Preview completed"
          value={evidence.identity.previewCompletedAt === null
            ? null
            : new Date(evidence.identity.previewCompletedAt).toISOString()}
        />
      </div>

      <details className="evidence-section" open>
        <summary>Changed files ({evidence.changedFiles.length})</summary>
        {evidence.changedFiles.length > 0 ? (
          <ul className="file-list">
            {evidence.changedFiles.map((file, index) => <li key={`${file}-${index}`}><code>{file}</code></li>)}
          </ul>
        ) : (
          <p className="muted">No changed files were reported.</p>
        )}
      </details>

      <details className="evidence-section" open>
        <summary>
          Verification: <span className={`check-status ${evidence.verification.outcome}`}>{evidence.verification.outcome}</span>
        </summary>
        <p className="muted">
          Runner: <code>{evidence.verification.runner ?? "not reported"}</code>
          {" · "}Reason: {evidence.verification.reason ?? "not reported"}
        </p>
        {evidence.verification.checks.length > 0 ? (
          <div className="check-list">
            {evidence.verification.checks.map((check) => (
              <div className="check-row" key={check.key}>
                <div className="check-name">
                  <strong>{check.label}</strong>
                  <span className={`check-status ${check.status}`}>{check.status}</span>
                </div>
                <div className="check-command">Command: <code>{check.command ?? "not reported"}</code></div>
                <div className="muted">Reason: {check.reason ?? "not reported"}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">No individual verification checks were reported.</p>
        )}
      </details>

      {evidence.reviewItems.length > 0 && (
        <details className="evidence-section warning" open>
          <summary>Manual review required ({evidence.reviewItems.length})</summary>
          <ul className="review-list">
            {evidence.reviewItems.map((item, index) => (
              <li key={`${item.file}-${item.line ?? 0}-${item.code}-${index}`}>
                <code>{item.code}</code>{" "}
                <strong>{item.file}{item.line ? `:${item.line}` : ""}</strong>
                <div>{item.message}</div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {evidence.blockers.length > 0 && (
        <div className="blocker-panel" role="alert">
          <strong>Publication blockers</strong>
          <ul>
            {evidence.blockers.map((blocker, index) => (
              <li key={`${blocker.code}-${index}`}><code>{blocker.code}</code> — {blocker.message}</li>
            ))}
          </ul>
        </div>
      )}

      {evidence.error ? <div className="error-detail">Run error: {evidence.error}</div> : null}
      {evidence.prUrl ? <p><a href={evidence.prUrl} target="_blank" rel="noreferrer">Open published PR →</a></p> : null}
      {evidence.publishable && !evidence.identity.artifactDigest ? (
        <p className="evidence-missing">Artifact fingerprint was not supplied by this API version.</p>
      ) : null}
    </article>
  );
}

function EvidenceValue({ label, value, important = false }: { label: string; value: string | null; important?: boolean }) {
  return (
    <div className={`evidence-value ${important ? "important" : ""}`}>
      <span>{label}</span>
      <code title={value ?? undefined}>{value ?? "Not reported"}</code>
    </div>
  );
}

function summaryText(summary: NonNullable<ResultItem["report"]>["summary"]): string {
  if (!summary) return "";
  const verified =
    summary.verified === "skipped" ? "verification skipped" : summary.verified ? "verified" : "verification failed";
  return `${summary.applied ?? 0} applied · ${summary.review ?? 0} review · ${summary.changedFiles ?? 0} files · ${verified}`;
}

function friendlyStatus(status: string): string {
  switch (status) {
    case "preview_ready": return "Preview ready";
    case "pr_opened": return "PR opened";
    case "no_changes": return "No changes";
    case "blocked": return "Blocked";
    case "failed": return "Failed";
    default: return status.replace(/_/g, " ");
  }
}
