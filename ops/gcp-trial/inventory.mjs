import { validateTrialInventory } from "./cleanup.mjs";

const PROJECT = "project-32bf49a2-bd30-4956-850", ZONE = "us-central1-a";
const BASE = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}`;
const MAX_BYTES = 262_144;
const validToken = (token) => typeof token === "string" && token.length >= 20 && token.length <= 4096
  && /^[A-Za-z0-9._~+/-]+={0,2}$/.test(token);
const validTime = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const fields = (kind) => "kind,selfLink,nextPageToken,warning,items(id,name,zone,selfLink,creationTimestamp,labels,"
  + (kind === "instances" ? "disks(boot,autoDelete,source))" : "users)");
function onlyFields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error();
}
function checkProjection(response, kind) {
  onlyFields(response, ["kind", "selfLink", "nextPageToken", "items"]);
  if (response.items !== undefined && !Array.isArray(response.items)) throw new Error();
  for (const item of response.items ?? []) {
    onlyFields(item, ["id", "name", "zone", "selfLink", "creationTimestamp", "labels", kind === "instances" ? "disks" : "users"]);
    if (item.labels !== undefined && (!item.labels || typeof item.labels !== "object" || Array.isArray(item.labels)
      || Object.values(item.labels).some((value) => typeof value !== "string"))) throw new Error();
    if (kind === "instances" && item.disks !== undefined) {
      if (!Array.isArray(item.disks)) throw new Error();
      for (const disk of item.disks) {
        onlyFields(disk, ["boot", "autoDelete", "source"]);
        if (["boot", "autoDelete"].some((key) => Object.hasOwn(disk, key) && typeof disk[key] !== "boolean")) throw new Error();
        if (disk.source !== undefined && (typeof disk.source !== "string" || !disk.source.startsWith(`${BASE}/disks/`)
          || !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(disk.source.slice(`${BASE}/disks/`.length)))) throw new Error();
      }
    }
  }
}

// The CLI receives a short-lived token through a pipe, never an argument or file.
export async function readAccessToken(stream, { timeoutMs = 10_000 } = {}) {
  let timer;
  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { stream.destroy(); reject(new Error()); }, timeoutMs);
    });
    const read = async () => {
      const chunks = []; let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 4097) { stream.destroy(); throw new Error(); }
        chunks.push(bytes);
      }
      const token = Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
      if (!validToken(token)) throw new Error();
      return token;
    };
    return await Promise.race([read(), timeout]);
  } catch { throw new Error("invalid credential input"); }
  finally { clearTimeout(timer); }
}

// fetchImpl is an injection boundary for offline tests; production uses native
// fetch with only the fixed userinfo and zonal list URLs constructed below.
export async function collectTrialInventory(token, { expectedAccount, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController(); let timer;
  try {
    if (!validToken(token) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new Error();
    if (typeof expectedAccount !== "string" || expectedAccount.length > 254
      || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(expectedAccount)
      || expectedAccount.toLowerCase().endsWith(".gserviceaccount.com")) throw new Error();
    const startedAt = now(); let lastTime = startedAt, totalBytes = 0;
    if (!validTime(startedAt)) throw new Error();
    const checkClock = () => {
      const value = now();
      if (!validTime(value) || value < lastTime || value - startedAt > 20_000 || controller.signal.aborted) throw new Error();
      lastTime = value; return value;
    };
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const getJson = async (url) => {
      checkClock();
      const response = await fetchImpl(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "X-Goog-User-Project": PROJECT, Accept: "application/json" }, signal: controller.signal });
      if (response.status !== 200) { await response.body?.cancel(); throw new Error(); }
      const chunks = [];
      for await (const chunk of response.body) {
        checkClock(); totalBytes += chunk.byteLength;
        if (totalBytes > MAX_BYTES) { controller.abort(); throw new Error(); }
        chunks.push(Buffer.from(chunk));
      }
      checkClock();
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      return data;
    };
    const identity = await getJson("https://openidconnect.googleapis.com/v1/userinfo");
    if (identity.email !== expectedAccount || identity.email_verified !== true) throw new Error();
    const inventory = { projectId: PROJECT, zone: ZONE, observedAt: startedAt, filter: "", instances: [], disks: [] };
    for (const kind of ["instances", "disks"]) {
      let pageToken = ""; const seen = new Set();
      do {
        if (seen.has(pageToken) || inventory[kind].length >= 20) throw new Error();
        seen.add(pageToken);
        const url = new URL(`${BASE}/${kind}`);
        url.searchParams.set("maxResults", "100"); url.searchParams.set("fields", fields(kind));
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await getJson(url.href);
        if (Object.hasOwn(response, "error") || Object.hasOwn(response, "warning")
          || response.kind !== (kind === "instances" ? "compute#instanceList" : "compute#diskList")
          || response.selfLink !== `${BASE}/${kind}`) throw new Error();
        checkProjection(response, kind);
        inventory[kind].push({ pageToken, response });
        pageToken = response.nextPageToken ?? "";
        if (typeof pageToken !== "string" || pageToken.length > 2048) throw new Error();
      } while (pageToken);
    }
    const completedAt = checkClock();
    validateTrialInventory(JSON.stringify(inventory), { nowMs: completedAt });
    return { schemaVersion: 1, kind: "api_migrator_gcp_inventory_observation", account: expectedAccount, completedAt, inventory,
      executionBlocked: true, activationBlocked: true, cloudVerified: false };
  } catch { throw new Error("GCP inventory observation failed"); }
  finally { clearTimeout(timer); controller.abort(); }
}
