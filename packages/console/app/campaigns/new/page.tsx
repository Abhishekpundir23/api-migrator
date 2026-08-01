"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_MANIFEST = JSON.stringify(
  {
    name: "Inngest TypeScript SDK v3 -> v4",
    provider: "inngest",
    transformSet: "inngest-v3-to-v4",
    package: { name: "inngest", from: "^3.0.0", to: "^4.0.0" },
    peerFloors: [{ name: "typescript", range: "^5.8.0" }],
  },
  null,
  2
);

export default function NewCampaignPage() {
  const router = useRouter();
  const [manifest, setManifest] = useState(DEFAULT_MANIFEST);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(manifest);
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest: parsed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error + (data.details ? ": " + JSON.stringify(data.details) : ""));
        setBusy(false);
        return;
      }
      router.push(`/campaigns/${data.campaign.id}`);
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <h1>New campaign</h1>
      <p className="muted">Paste a migration manifest (JSON). Creating it does not access a repository or publish a PR.</p>
      <form onSubmit={submit}>
        <div className="field">
          <label>Manifest</label>
          <textarea value={manifest} onChange={(e) => setManifest(e.target.value)} />
        </div>
        {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
        <button type="submit" className="btn" disabled={busy}>{busy ? "Creating..." : "Create campaign"}</button>
      </form>
    </>
  );
}
