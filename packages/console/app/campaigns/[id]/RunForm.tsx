"use client";

import { useState } from "react";

/** Client form: paste repo slugs, kick off the campaign (opens real PRs). */
export default function RunForm({ campaignId }: { campaignId: string }) {
  const [slugs, setSlugs] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const repoSlugs = slugs
      .split(/[\n,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (repoSlugs.length === 0) {
      setError("Enter at least one owner/repo slug.");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoSlugs }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "run failed");
        setBusy(false);
        return;
      }
      const lines = data.summary.results.map(
        (r: any) => `${r.slug}: ${r.status}${r.prUrl ? ` → ${r.prUrl}` : ""}${r.error ? ` (${r.error})` : ""}`
      );
      setResult(lines.join("\n"));
      setBusy(false);
      // reload to refresh the runs table
      setTimeout(() => location.reload(), 1500);
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={run}>
      <div className="field">
        <label>Repo slugs (one per line: owner/repo)</label>
        <textarea
          value={slugs}
          onChange={(e) => setSlugs(e.target.value)}
          placeholder={"owner/repo-1\nowner/repo-2"}
          style={{ minHeight: 100 }}
        />
      </div>
      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
      {result && (
        <div className="card">
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{result}</pre>
        </div>
      )}
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "Migrating (this opens real PRs)..." : "Run migration"}
      </button>
    </form>
  );
}
