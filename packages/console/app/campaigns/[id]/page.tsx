import { init, getCampaign, listRunsWithReposForCampaign, campaignRollup } from "@api-migrator/db";
import { notFound } from "next/navigation";
import RunForm from "./RunForm";
import Link from "next/link";
import { formatRunSummary, parseRunSummary } from "../../../lib/summary";
import {
  buildHistoricalRunEvidence,
  shortAuditValue,
  type HistoricalRunInput,
} from "../../../lib/run-history";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  init();
  const { id } = await params;
  const campaign = getCampaign(id);
  if (!campaign) notFound();
  const runs = listRunsWithReposForCampaign(id);
  const rollup = campaignRollup(id);

  const stats = [
    { num: rollup._total ?? 0, lbl: "Runs" },
    { num: rollup.preview_ready ?? 0, lbl: "Previews ready" },
    { num: rollup.pr_opened ?? 0, lbl: "PRs opened" },
    { num: rollup.blocked ?? 0, lbl: "Blocked" },
    { num: rollup.failed ?? 0, lbl: "Failed" },
    { num: rollup.no_changes ?? 0, lbl: "No changes" },
  ];

  return (
    <>
      <Link href="/campaigns" className="muted">← All campaigns</Link>
      <h1>{campaign.name}</h1>
      <p className="muted">Status: <span className={`badge ${campaign.status}`}>{campaign.status}</span></p>

      <h2>Summary</h2>
      <div className="grid">
        {stats.map((s) => (
          <div className="stat" key={s.lbl}>
            <div className="num">{s.num}</div>
            <div className="lbl">{s.lbl}</div>
          </div>
        ))}
      </div>

      <h2>Preview and approve</h2>
      <RunForm campaignId={id} />

      <h2>Run history ({runs.length})</h2>
      {runs.length === 0 ? (
        <div className="card muted">No runs yet. Preview an approved repository above.</div>
      ) : (
        <div className="history-table-wrap">
          <table>
            <thead>
              <tr><th>Repository</th><th>Status</th><th>PR</th><th>Summary</th><th>Audit evidence</th><th>Started</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.repoSlug}</code></td>
                  <td>
                    <span className={`badge ${r.status}`}>
                      {r.status === "merged" ? "legacy merged (unverified)" : r.status}
                    </span>
                  </td>
                  <td>{r.prUrl ? <a href={r.prUrl} target="_blank" rel="noreferrer">#{r.prUrl.split("/").pop()} →</a> : "—"}</td>
                  <td className="muted">{formatRunSummary(parseRunSummary(r.summary))}</td>
                  <td><StoredRunEvidence run={r} /></td>
                  <td className="muted">{r.startedAt ? new Date(r.startedAt).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function StoredRunEvidence({ run }: { run: HistoricalRunInput }) {
  const evidence = buildHistoricalRunEvidence(run);
  if (!evidence.hasIdentity && evidence.blockerEvidence === "legacy") {
    return <span className="muted">Exact identity not recorded</span>;
  }
  return (
    <details className="history-evidence">
      <summary>
        {evidence.artifactDigest
          ? `Artifact ${shortAuditValue(evidence.artifactDigest)}`
          : "Partial audit evidence"}
        {evidence.blockers.length > 0 ? ` · ${evidence.blockers.length} blocker${evidence.blockers.length === 1 ? "" : "s"}` : ""}
      </summary>
      <dl>
        <AuditValue label="Artifact fingerprint" value={evidence.artifactDigest} />
        <AuditValue label="Base branch" value={evidence.baseBranch} />
        <AuditValue label="Base commit" value={evidence.baseSha} />
        <AuditValue label="Approved PR head" value={evidence.headSha} />
        <AuditValue label="Target branch" value={evidence.targetBranch} />
      </dl>
      {evidence.blockerEvidence === "invalid" ? (
        <p className="error-detail">Stored blocker evidence is invalid.</p>
      ) : evidence.blockerEvidence === "legacy" ? (
        <p className="muted">Structured blocker evidence was not recorded for this run.</p>
      ) : evidence.blockers.length === 0 ? (
        <p className="muted">No publication blockers recorded.</p>
      ) : (
        <ul className="history-blockers">
          {evidence.blockers.map((blocker, index) => (
            <li key={`${blocker.code}-${index}`}><code>{blocker.code}</code> — {blocker.message}</li>
          ))}
        </ul>
      )}
    </details>
  );
}

function AuditValue({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd><code title={value ?? undefined}>{value ?? "Not recorded"}</code></dd>
    </div>
  );
}
