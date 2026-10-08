import { resultFixture } from "./result-fixture.mjs";

export const ACCOUNT = "owner@example.com", TOKEN = "fixture-not-a-real-access-token";
export const BASE = "https://www.googleapis.com/compute/v1/projects/project-32bf49a2-bd30-4956-850/zones/us-central1-a";
export const page = (kind, items = [], extra = {}) => ({ kind: kind === "instances" ? "compute#instanceList" : "compute#diskList",
  selfLink: `${BASE}/${kind}`, items, ...extra });
export function cleanupReadFixture(now = 2_000_000_000_000) {
  const f = resultFixture(now), name = f.plan.instanceName;
  const vm = { id: f.ownership.instanceId, name, selfLink: `${BASE}/instances/${name}`, zone: BASE,
    creationTimestamp: new Date(now + 500).toISOString(), labels: { "api-migrator-trial": f.plan.runId },
    disks: [{ boot: true, autoDelete: true, source: `${BASE}/disks/${name}` }] };
  const disk = { id: f.ownership.diskId, name, selfLink: `${BASE}/disks/${name}`, zone: BASE,
    creationTimestamp: new Date(now + 500).toISOString(), users: [vm.selfLink] };
  return { ...f, vm, disk };
}
export function transport({ identity = { email: ACCOUNT, email_verified: true }, instances = [page("instances")],
  disks = [page("disks")], alter } = {}) {
  const calls = [], queues = { instances: [...instances], disks: [...disks] };
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const replacement = alter?.(url, options); if (replacement) return replacement;
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json(identity);
    const kind = new URL(url).pathname.split("/").at(-1), data = queues[kind]?.shift();
    if (!data) throw new Error("unexpected API or page");
    return Response.json(data);
  } };
}
