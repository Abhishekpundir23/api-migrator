import { init, getCampaign, listRunsForCampaign, campaignRollup } from "@api-migrator/db";
import { notFound } from "next/navigation";
import RunForm from "./RunForm";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  init();
  const { id } = await params;
  const campaign = getCampaign(id);
  if (!campaign) notFound();
  const runs = listRunsForCampaign(id);
  const rollup = campaignRollup(id);

  const stats = [
    { num: rollup._total ?? 0, lbl: "Repos" },
    { num: rollup.pr_opened ?? 0, lbl: "PRs opened" },
    { num: rollup.merged ?? 0, lbl: "Merged" },
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

      <h2>Run migration</h2>
      <RunForm campaignId={id} />

      <h2>Repos ({runs.length})</h2>
      {runs.length === 0 ? (
        <div className="card muted">No repos migrated yet. Add repo slugs above and run.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Status</th><th>PR</th><th>Summary</th><th>Started</th></tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                <td>{r.prUrl ? <a href={r.prUrl} target="_blank" rel="noreferrer">#{r.prUrl.split("/").pop()} →</a> : "—"}</td>
                <td className="muted">{r.summary ?? "—"}</td>
                <td className="muted">{r.startedAt ? new Date(r.startedAt).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
