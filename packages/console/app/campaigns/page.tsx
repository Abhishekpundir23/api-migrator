import { init, listCampaigns } from "@api-migrator/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function CampaignsPage() {
  init();
  const campaigns = listCampaigns();
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>Campaigns</h1>
        <Link href="/campaigns/new" className="btn">+ New campaign</Link>
      </div>
      <p className="muted">A campaign migrates your customers&apos; repos for one breaking SDK change.</p>

      {campaigns.length === 0 ? (
        <div className="card muted">No campaigns yet. Create one to start migrating customer repos.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Name</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td><span className={`badge ${c.status}`}>{c.status}</span></td>
                <td><Link href={`/campaigns/${c.id}`}>View →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
