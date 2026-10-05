import { createHash } from "node:crypto";
import { canonicalJson } from "../publication-runner/deployment/lib.mjs";
import { renderTrialPlan } from "./plan.mjs";

const PROJECT = "project-32bf49a2-bd30-4956-850";
const ZONE = "us-central1-a";
const BASE = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}`;
const jsonDigest = (value) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const time = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
function id(value) {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
}
function parse(text, max = 262_144) {
  if (typeof text !== "string" || Buffer.byteLength(text) > max) throw new Error("invalid JSON size");
  try {
    const value = JSON.parse(text);
    if (!object(value)) throw new Error();
    canonicalJson(value);
    return value;
  } catch { throw new Error("invalid JSON object"); }
}
function fields(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("invalid fields");
  }
}
function scope(value) {
  if (value.projectId !== PROJECT || value.zone !== ZONE) throw new Error("invalid scope");
}
function fresh(value, nowMs) {
  if (!time(nowMs) || !time(value) || value > nowMs || nowMs - value > 30_000) throw new Error("stale or invalid observation");
}
function validatedPlan(text) {
  try {
    const p = parse(text, 65_536);
    const expected = renderTrialPlan({ projectId: p.projectId, runId: p.runId, sourceRevision: p.source.revision,
      sourceArchiveSha256: p.source.sha256, bootImage: p.bootImage.name, network: p.network, subnetwork: p.subnetwork,
      egress: p.egress, startupScriptSha256: p.startup.sha256, deleteAt: p.deleteAt }, { nowMs: p.issuedAt });
    if (canonicalJson(p) !== canonicalJson(expected)) throw new Error();
    return expected;
  } catch { throw new Error("invalid trial plan"); }
}
function resource(value, kind) {
  if (!object(value) || !id(value.id) || typeof value.name !== "string"
    || !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.name)
    || value.zone !== BASE || value.selfLink !== `${BASE}/${kind}/${value.name}`
    || typeof value.creationTimestamp !== "string" || !time(Date.parse(value.creationTimestamp))
    || (value.labels !== undefined && !object(value.labels))) throw new Error("invalid resource identity or scope");
  if (kind === "disks" && value.users !== undefined
    && (!Array.isArray(value.users) || value.users.some((u) => typeof u !== "string"))) throw new Error("invalid disk users");
}
function expectedAttachment(instance, diskName) {
  return Array.isArray(instance.disks) && instance.disks.length === 1 && object(instance.disks[0])
    && instance.disks[0].boot === true && instance.disks[0].autoDelete === true
    && instance.disks[0].source === `${BASE}/disks/${diskName}`;
}

export function captureOwnership(planJson, observationJson, { nowMs = Date.now() } = {}) {
  const p = validatedPlan(planJson);
  const o = parse(observationJson);
  fields(o, ["projectId", "zone", "observedAt", "operation", "instance", "disk"]);
  scope(o); fresh(o.observedAt, nowMs);
  if (o.observedAt < p.issuedAt || nowMs >= p.deleteAt) throw new Error("invalid ownership capture time");
  const op = o.operation, vm = o.instance, disk = o.disk;
  resource(vm, "instances"); resource(disk, "disks");
  if (!object(op) || !id(op.id) || op.status !== "DONE" || op.operationType !== "insert" || op.zone !== BASE
    || Object.hasOwn(op, "error") || op.httpErrorStatusCode || op.targetId !== vm.id || op.targetLink !== vm.selfLink
    || vm.name !== p.instanceName || vm.labels?.["api-migrator-trial"] !== p.runId
    || !expectedAttachment(vm, disk.name) || disk.name !== p.instanceName
    || !Array.isArray(disk.users) || disk.users.length !== 1 || disk.users[0] !== vm.selfLink
    || [vm, disk].some((r) => Date.parse(r.creationTimestamp) < p.issuedAt || Date.parse(r.creationTimestamp) > o.observedAt)) {
    throw new Error("ownership or creation operation mismatch");
  }
  const body = { schemaVersion: 1, projectId: PROJECT, zone: ZONE, planDigest: p.planDigest, runId: p.runId,
    instanceName: vm.name, instanceId: vm.id, diskName: disk.name, diskId: disk.id, operationId: op.id,
    capturedAt: o.observedAt, deleteAt: p.deleteAt, activationBlocked: true };
  return { ...body, ownershipDigest: jsonDigest(body) };
}

function validatedOwnership(text, p, nowMs) {
  const r = parse(text, 16_384);
  fields(r, ["schemaVersion", "projectId", "zone", "planDigest", "runId", "instanceName", "instanceId",
    "diskName", "diskId", "operationId", "capturedAt", "deleteAt", "activationBlocked", "ownershipDigest"]);
  const { ownershipDigest, ...body } = r;
  if (r.schemaVersion !== 1 || r.projectId !== PROJECT || r.zone !== ZONE || r.planDigest !== p.planDigest
    || r.runId !== p.runId || r.instanceName !== p.instanceName || r.diskName !== p.instanceName
    || r.deleteAt !== p.deleteAt || r.activationBlocked !== true || !id(r.instanceId) || !id(r.diskId) || !id(r.operationId)
    || !time(r.capturedAt) || r.capturedAt < p.issuedAt || r.capturedAt >= p.deleteAt || r.capturedAt > nowMs
    || ownershipDigest !== jsonDigest(body)) throw new Error("invalid ownership record");
  return r;
}

function pages(chain, kind) {
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > 20) throw new Error("invalid inventory pages");
  let token = "";
  const seenTokens = new Set(), seenIds = new Set(), seenNames = new Set(), items = [];
  for (let i = 0; i < chain.length; i++) {
    const page = chain[i];
    fields(page, ["pageToken", "response"]);
    if (page.pageToken !== token || seenTokens.has(token)) throw new Error("invalid pagination token");
    seenTokens.add(token);
    const response = page.response;
    if (!object(response) || Object.hasOwn(response, "error") || Object.hasOwn(response, "warning")
      || response.kind !== (kind === "instances" ? "compute#instanceList" : "compute#diskList")
      || response.selfLink !== `${BASE}/${kind}`
      || (response.items !== undefined && !Array.isArray(response.items))) throw new Error("invalid inventory response");
    for (const item of response.items ?? []) {
      resource(item, kind);
      if (seenIds.has(item.id) || seenNames.has(item.name)) throw new Error("duplicate inventory resource");
      seenIds.add(item.id); seenNames.add(item.name); items.push(item);
      if (items.length > 1000) throw new Error("inventory size exceeded");
    }
    token = response.nextPageToken ?? "";
    if (typeof token !== "string" || token.length > 2048 || (token === "" && i !== chain.length - 1)) throw new Error("invalid pagination");
  }
  if (token !== "") throw new Error("incomplete inventory pagination");
  return items;
}

export function validateTrialInventory(inventoryJson, { nowMs = Date.now() } = {}) {
  const inventory = parse(inventoryJson);
  fields(inventory, ["projectId", "zone", "observedAt", "filter", "instances", "disks"]);
  scope(inventory); fresh(inventory.observedAt, nowMs);
  if (inventory.filter !== "") throw new Error("invalid inventory scope or time");
  return { inventory, instances: pages(inventory.instances, "instances"), disks: pages(inventory.disks, "disks") };
}

export function decideCleanup(planJson, recordJson, inventoryJson, { nowMs = Date.now(), reason = "deadline" } = {}) {
  if (!time(nowMs) || !["deadline", "completed", "failed", "cancelled", "controller_failure"].includes(reason)) {
    throw new Error("invalid cleanup clock or reason");
  }
  const p = validatedPlan(planJson), r = validatedOwnership(recordJson, p, nowMs);
  const { inventory: inv, instances, disks } = validateTrialInventory(inventoryJson, { nowMs });
  if (inv.observedAt < r.capturedAt) throw new Error("invalid inventory scope or time");
  const common = { projectId: PROJECT, zone: ZONE, runId: p.runId, planDigest: p.planDigest, deleteAt: p.deleteAt,
    instanceId: r.instanceId, diskId: r.diskId, observedAt: inv.observedAt, inventoryDigest: jsonDigest(inv),
    executionBlocked: true, activationBlocked: true, cloudVerified: false };
  const blocked = (why, kind) => ({ ...common, status: "blocked", reason: why, ...(kind ? { resource: kind } : {}) });
  if ([...instances.map((v) => [v, r.instanceId, r.instanceName]), ...disks.map((v) => [v, r.diskId, r.diskName])]
    .some(([v, ownedId, name]) => v.id !== ownedId && (v.name === name || v.labels?.["api-migrator-trial"] === p.runId))) {
    return blocked("replacement_or_unowned_resource");
  }
  const vm = instances.find((v) => v.id === r.instanceId), disk = disks.find((v) => v.id === r.diskId);
  if (!vm && !disk) return { ...common, status: "absence_observed" };
  if ((vm && (vm.name !== r.instanceName || vm.labels?.["api-migrator-trial"] !== p.runId || !expectedAttachment(vm, r.diskName)))
    || (disk && disk.name !== r.diskName) || (vm && !disk)) return blocked("ownership_changed");
  if (reason === "deadline" && nowMs < p.deleteAt) return { ...common, status: "waiting" };
  if (disk && (disk.users ?? []).some((user) => !vm || user !== vm.selfLink)) return blocked("disk_attached_elsewhere", "disk");
  return blocked("generation_safe_delete_unverified", vm ? "instance" : "disk");
}
