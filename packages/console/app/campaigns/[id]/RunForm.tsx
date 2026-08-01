"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buildPreviewEvidence, type PreviewResultInput } from "../../../lib/preview";

type ResultItem = PreviewResultInput;

interface RunResponse {
  mode?: "preview" | "publish";
  error?: string;
  summary?: { results?: ResultItem[] };
  approvalToken?: string | null;
  confirmationPhrase?: string | null;
  approvalExpiresAt?: number | null;
}

/** Local operator form: preview first, then explicitly approve publication. */
export default function RunForm({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [slugs, setSlugs] = useState("");
  const [results, setResults] = useState<ResultItem[]>([]);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [confirmationPhrase, setConfirmationPhrase] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "publish" | null>(null);
  const publishableCount = results.filter((result) => result.status === "preview_ready").length;

  async function preview(e: React.FormEvent) {
    e.preventDefault();
    setBusy("preview");
    setError(null);
    setResults([]);
    setApprovalToken(null);
    setConfirmationPhrase(null);
    setConfirmation("");
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
      setApprovalToken(data.approvalToken ?? null);
      setConfirmationPhrase(data.confirmationPhrase ?? null);
      setBusy(null);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  async function publish() {
    if (!approvalToken || !confirmationPhrase || publishableCount === 0) return;
    setBusy("publish");
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "publish",
          approvalToken,
          confirmation,
        }),
      });
      const data = (await res.json()) as RunResponse;
      if (!res.ok) {
        if (data.summary) {
          setResults(data.summary.results ?? []);
          // The approval was consumed once publication acquired the run lock.
          // Outcome failures require a fresh preview before any retry.
          setApprovalToken(null);
          setConfirmationPhrase(null);
          setConfirmation("");
        }
        setError(data.error ?? "publication failed");
        setBusy(null);
        router.refresh();
        return;
      }
      setResults(data.summary?.results ?? []);
      setApprovalToken(null);
      setConfirmationPhrase(null);
      setConfirmation("");
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
        <label>Repo slugs (one per line: owner/repo)</label>
        <textarea
          value={slugs}
          onChange={(e) => {
            setSlugs(e.target.value);
            setApprovalToken(null);
            setConfirmationPhrase(null);
            setConfirmation("");
          }}
          placeholder={"owner/repo-1\nowner/repo-2"}
          style={{ minHeight: 100 }}
        />
      </div>
      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
      {results.length > 0 && (
        <section className="preview-results" aria-label="Migration preview evidence">
          <div className="preview-results-heading">
            <div>
              <h3>{approvalToken ? "Preview evidence" : "Run evidence"}</h3>
              <p className="muted">Review each repository&apos;s identity, files, checks, and warnings.</p>
            </div>
            {approvalToken && <span className="badge preview_ready">{publishableCount} ready</span>}
          </div>
          {results.map((result) => (
            <PreviewEvidenceCard result={result} key={`${result.slug}-${result.status}`} />
          ))}
        </section>
      )}
      <button type="submit" className="btn" disabled={busy !== null}>
        {busy === "preview" ? "Generating safe preview..." : "Preview migration"}
      </button>

      {approvalToken && confirmationPhrase && publishableCount > 0 && (
        <div className="approval card">
          <h3>Publish reviewed previews</h3>
          <p>
            This approval covers {publishableCount} {publishableCount === 1 ? "repository" : "repositories"}
            {" "}marked <code>preview_ready</code>. Re-check the artifact fingerprint, commit, files,
            and verification evidence above before continuing.
          </p>
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
            {busy === "publish" ? "Publishing approved PRs..." : "Publish approved PRs"}
          </button>
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
        <EvidenceValue label="Artifact fingerprint" value={evidence.identity.artifactDigest} important />
        <EvidenceValue label="Base branch" value={evidence.identity.baseBranch} />
        <EvidenceValue label="Base commit" value={evidence.identity.baseSha} />
        <EvidenceValue label="Approved PR head" value={evidence.identity.headSha} />
        <EvidenceValue label="Proposed branch" value={evidence.identity.targetBranch} />
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
