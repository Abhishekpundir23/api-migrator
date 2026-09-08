"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_INNGEST_MANIFEST_JSON } from "../../../lib/default-manifest";

export default function NewCampaignPage() {
  const router = useRouter();
  const [manifest, setManifest] = useState(DEFAULT_INNGEST_MANIFEST_JSON);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The JSON is the single source of truth, including pasted declarations.
  let draft: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(manifest);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      draft = parsed as Record<string, unknown>;
    }
  } catch { /* Keep malformed JSON editable; submit displays the parse error. */ }
  const inngest = draft?.transformSet === "inngest-v3-to-v4";
  const deployment = draft?.deployment as { kind?: unknown } | null | undefined;
  const deploymentKind = deployment?.kind === "long-running" || deployment?.kind === "serverless"
    ? deployment.kind : "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(manifest);
      if (parsed?.transformSet === "inngest-v3-to-v4" && !deploymentKind) {
        throw new Error("Choose the deployment kind before creating an Inngest campaign.");
      }
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
        {inngest && (
          <div className="field">
            <label htmlFor="deployment-kind">Operator-declared deployment</label>
            <select id="deployment-kind" value={deploymentKind} required disabled={busy}
              aria-describedby="deployment-help"
              onChange={(e) => {
                if (!draft) return;
                const next = { ...draft };
                if (e.target.value) next.deployment = { kind: e.target.value };
                else delete next.deployment;
                setManifest(JSON.stringify(next, null, 2));
                setError(null);
              }}>
              <option value="">Choose deployment type</option>
              <option value="long-running">Long-running / always-on server</option>
              <option value="serverless">Serverless / platform runtime limit</option>
            </select>
            <p id="deployment-help" className="muted">
              This choice is not independently verified. Long-running clears only the F12 checkpointing review;
              serverless still requires review of maxRuntime below the platform limit. Use separate campaigns for different hosting models.
            </p>
          </div>
        )}
        <div className="field">
          <label htmlFor="manifest">Manifest</label>
          <textarea id="manifest" value={manifest} disabled={busy} onChange={(e) => {
            setManifest(e.target.value);
            setError(null);
          }} />
        </div>
        {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
        <button type="submit" className="btn" disabled={busy}>{busy ? "Creating..." : "Create campaign"}</button>
      </form>
    </>
  );
}
