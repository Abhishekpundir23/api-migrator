import { resultFixture } from "./result-fixture.mjs";

export const ACCOUNT = "owner@example.com", TOKEN = "fixture-not-a-real-access-token";
export const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
export const BASE = "https://www.googleapis.com/compute/v1/projects/project-32bf49a2-bd30-4956-850/zones/us-central1-a";
export const OPERATION = "operation-2000000000000-abcdef0123456-abcd0123-1234abcd";

// Only the external HTTPS boundary is substituted. Plans, capture validation,
// uint64 binding and the downstream ownership validator remain real.
export function ownershipReadFixture(now = 2_000_000_000_000) {
  const { plan } = resultFixture(now), name = plan.instanceName;
  const operation = { kind: "compute#operation", name: OPERATION, selfLink: `${BASE}/operations/${OPERATION}`,
    id: "123", status: "DONE", operationType: "insert", zone: BASE,
    targetId: "18446744073709551614", targetLink: `${BASE}/instances/${name}` };
  const instance = { kind: "compute#instance", id: "18446744073709551614", name, zone: BASE,
    selfLink: `${BASE}/instances/${name}`, creationTimestamp: new Date(now + 500).toISOString(),
    labels: { "api-migrator-trial": "abcdef0123456789abcdef0123456789" },
    disks: [{ boot: true, autoDelete: true, source: `${BASE}/disks/${name}` }] };
  const disk = { kind: "compute#disk", id: "18446744073709551613", name, zone: BASE,
    selfLink: `${BASE}/disks/${name}`, creationTimestamp: new Date(now + 500).toISOString(), users: [`${BASE}/instances/${name}`] };
  const f = { plan, operationName: OPERATION, operation, instance, disk, nowMs: now + 1000, calls: [],
    identity: { sub: "fixture-user", email: ACCOUNT, email_verified: true } };
  f.fetchImpl = async (url, options) => {
    f.calls.push({ url, options });
    if (url === USERINFO) return Response.json(f.identity);
    const path = new URL(url).pathname;
    if (path === new URL(`${BASE}/operations/${OPERATION}`).pathname) return Response.json(f.operation);
    if (path === new URL(`${BASE}/instances/${name}`).pathname) return Response.json(f.instance);
    if (path === new URL(`${BASE}/disks/${name}`).pathname) return Response.json(f.disk);
    throw new Error("unexpected endpoint");
  };
  return f;
}
