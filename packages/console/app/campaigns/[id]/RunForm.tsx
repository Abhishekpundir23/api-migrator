"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buildPreviewEvidence, type PreviewResultInput } from "../../../lib/preview";

type ResultItem = PreviewResultInput;

interface RunResponse {
  mode?: "preview" | "prepare_publish" | "publish";
  error?: string;
  summary?: { results?: ResultItem[] };
  previewReceipt?: string | null;
  previewReceiptExpiresAt?: number | null;
  operatorApprovalToken?: string | null;
  confirmationPhrase?: string | null;
  approvalExpiresAt?: number | null;
  ownerAuthorizationDigest?: string | null;
  manifestDigest?: string | null;
}

/** Local operator form: preview, attach owner authorization, then approve. */
export default function RunForm({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [slugs, setSlugs] = useState("");
  const [results, setResults] = useState<ResultItem[]>([]);
  const [previewReceipt, setPreviewReceipt] = useState<string | null>(null);
  const [ownerAuthorizationEnvelope, setOwnerAuthorizationEnvelope] = useState("");
  const [operatorApprovalToken, setOperatorApprovalToken] = useState<string | null>(null);
  const [ownerAuthorizationDigest, setOwnerAuthorizationDigest] = useState<string | null>(null);
  const [manifestDigest, setManifestDigest] = useState<string | null>(null);
  const [confirmationPhrase, setConfirmationPhrase] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "prepare_publish" | "publish" | null>(null);
  const publishableCount = results.filter((result) => result.status === "preview_ready").length;

  function clearFinalApproval() {
    setOperatorApprovalToken(null);
    setOwnerAuthorizationDigest(null);
    setManifestDigest(null);
    setConfirmationPhrase(null);
    setConfirmation("");
  }

  async function preview(e: React.FormEvent) {
    e.preventDefault();
    setBusy("preview");
    setError(null);
    setResults([]);
    setPreviewReceipt(null);
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

  async function preparePublish() {
    if (!previewReceipt || publishableCount !== 1 || ownerAuthorizationEnvelope.length === 0) return;
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
          ownerAuthorizationEnvelope,
        }),
      });
      const data = (await res.json()) as RunResponse;
      if (!res.ok) {
        setError(data.error ?? "publication preparation failed");
        setBusy(null);
        return;
      }
      setOperatorApprovalToken(data.operatorApprovalToken ?? null);
      setOwnerAuthorizationDigest(data.ownerAuthorizationDigest ?? null);
      setManifestDigest(data.manifestDigest ?? null);
      setConfirmationPhrase(data.confirmationPhrase ?? null);
      setBusy(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  async function publish() {
    if (!operatorApprovalToken || !confirmationPhrase || publishableCount !== 1) return;
    const dispatchedToken = operatorApprovalToken;
    const dispatchedEnvelope = ownerAuthorizationEnvelope;
    const dispatchedConfirmation = confirmation;
    // Once dispatched, the server may consume the one-use controls or create a
    // PR even if the response is lost. Drop sensitive/stale state immediately;
    // every retry must begin with a fresh preview and owner envelope.
    setPreviewReceipt(null);
    setOwnerAuthorizationEnvelope("");
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
          onChange={(e) => {
            setSlugs(e.target.value);
            setResults([]);
            setPreviewReceipt(null);
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
      <button type="submit" className="btn" disabled={busy !== null}>
        {busy === "preview" ? "Generating safe preview..." : "Preview migration"}
      </button>

      {previewReceipt && publishableCount === 1 && (
        <div className="approval card">
          <h3>Attach repository-owner authorization</h3>
          <p>
            Paste the separately signed owner envelope for this exact preview. It stays only in this
            page&apos;s memory and the current request; the server never returns, logs, or persists it.
          </p>
          <label htmlFor="owner-authorization-envelope">Signed owner authorization envelope</label>
          <textarea
            id="owner-authorization-envelope"
            value={ownerAuthorizationEnvelope}
            onChange={(event) => {
              setOwnerAuthorizationEnvelope(event.target.value);
              clearFinalApproval();
            }}
            autoComplete="off"
            spellCheck={false}
            style={{ minHeight: 150 }}
          />
          <button
            type="button"
            className="btn"
            disabled={busy !== null || ownerAuthorizationEnvelope.length === 0 || operatorApprovalToken !== null}
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
    case "preview_ready": return "Ready to publish";
    case "pr_opened": return "PR opened";
    case "no_changes": return "No changes";
    case "blocked": return "Blocked";
    case "failed": return "Failed";
    default: return status.replace(/_/g, " ");
  }
}
