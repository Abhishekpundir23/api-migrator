#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "./lib.mjs";
import {
  HOSTED_SMOKE_AUTHORIZATION_STATUS,
  HOSTED_SMOKE_SCENARIOS,
  buildHostedSmokeOwnershipMarker,
  deriveHostedSmokeResources,
  validateHostedSmokeOwnershipMarker,
  validateHostedSmokeResources,
} from "./hosted-smoke-runtime.mjs";

export const HOSTED_SMOKE_CLEANUP_REPORT_KIND = "api_migrator_github_hosted_l7_smoke_cleanup_report";

const USAGE = "usage: cleanup-hosted-smoke.mjs --scenario NAME --output-dir ABSOLUTE_PATH [--audit-only]";
const TRUSTED_ENVIRONMENT = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  TZ: "UTC",
});
const EXACT_ENVIRONMENT_NAMES = Object.freeze([
  "API_MIGRATOR_SMOKE_RUN_ATTEMPT",
  "API_MIGRATOR_SMOKE_RUN_ID",
  "LANG",
  "LC_ALL",
  "PATH",
  "TZ",
]);
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const MAX_MARKER_BYTES = 32 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 128 * 1024;
const MAX_CGROUP_DIRECTORIES = 128;
const SYSTEMCTL = "/usr/bin/systemctl";
const NFT = "/usr/sbin/nft";

export function parseHostedSmokeCleanupCli(argv) {
  if (!Array.isArray(argv) || (argv.length !== 4 && argv.length !== 5) ||
      argv[0] !== "--scenario" || argv[2] !== "--output-dir" ||
      (argv.length === 5 && argv[4] !== "--audit-only")) {
    throw new Error(USAGE);
  }
  const outputDir = canonicalAbsolutePath(argv[3], "hosted smoke cleanup output directory");
  if (new Set(["/", "/tmp", "/var", "/var/tmp", "/run", "/run/api-migrator-hosted-smoke"]).has(outputDir)) {
    throw new Error("hosted smoke cleanup output directory is broad");
  }
  if (!HOSTED_SMOKE_SCENARIOS.includes(argv[1])) throw new Error("hosted smoke cleanup scenario is unsupported");
  return Object.freeze({
    scenario: argv[1],
    outputDir,
    auditOnly: argv.length === 5,
  });
}

/** Accept only the exact env emitted by `sudo env -i` in the hosted workflow. */
export function parseHostedSmokeCleanupEnvironment(env) {
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("hosted smoke cleanup environment is invalid");
  }
  const names = Object.keys(env).sort();
  if (names.length !== EXACT_ENVIRONMENT_NAMES.length ||
      names.some((name, index) => name !== EXACT_ENVIRONMENT_NAMES[index])) {
    throw new Error("hosted smoke cleanup environment is not the exact sanitized allowlist");
  }
  for (const [name, expected] of Object.entries(TRUSTED_ENVIRONMENT)) {
    if (env[name] !== expected) throw new Error(`hosted smoke cleanup ${name} is not sanitized`);
  }
  const resources = deriveHostedSmokeResources({
    runId: env.API_MIGRATOR_SMOKE_RUN_ID,
    runAttempt: env.API_MIGRATOR_SMOKE_RUN_ATTEMPT,
    scenario: "success",
  });
  return Object.freeze({
    runId: resources.runId,
    runAttempt: resources.runAttempt,
  });
}

/** Read-only exact-state inspection shared by cleanup and the final audit. */
export function inspectHostedSmokeAbsence(resourcesInput, dependencies = {}) {
  const resources = validateHostedSmokeResources(resourcesInput);
  const deps = resolvedDependencies(dependencies);
  const gatewayUnit = normalizeUnitState(deps.inspectUnit(resources.gatewayUnit), resources.gatewayUnit);
  const canaryUnit = normalizeUnitState(deps.inspectUnit(resources.canaryUnit), resources.canaryUnit);
  const runtime = normalizePathState(deps.inspectPath(resources.runtimeRoot), resources.runtimeRoot);
  const workspace = normalizePathState(deps.inspectPath(resources.workspacePath), resources.workspacePath);
  const runnerUidIdle = booleanResult(deps.uidIsIdle(resources.runnerUid), "runner UID idle observation");
  const gatewayUidIdle = booleanResult(deps.uidIsIdle(resources.gatewayUid), "gateway UID idle observation");
  const nftTableAbsent = !booleanResult(deps.tableExists(resources.nftTable), "nftables table observation");
  const snapshot = {
    gatewayUnit,
    canaryUnit,
    runtime,
    workspace,
    runnerUidIdle,
    gatewayUidIdle,
    nftTableAbsent,
  };
  snapshot.completeAbsence =
    !gatewayUnit.exists && gatewayUnit.cgroupEmpty &&
    !canaryUnit.exists && canaryUnit.cgroupEmpty &&
    !runtime.exists && !workspace.exists && runnerUidIdle && gatewayUidIdle && nftTableAbsent;
  return deepFreeze(snapshot);
}

/**
 * Stop only the two derived units, prove their cgroups and UIDs idle, remove
 * only the two derived trees, and delete the owned nft table as the final host
 * mutation. Every operation is injectable for Linux-independent tests.
 */
export function cleanupHostedSmoke(input, dependencies = {}) {
  const root = plainRecord(input, "hosted smoke cleanup input");
  exactKeys(root, ["resources", "outputDir", "auditOnly"], "hosted smoke cleanup input");
  const resources = validateHostedSmokeResources(root.resources);
  const outputDir = validateOutputDirectoryPath(root.outputDir, resources);
  if (typeof root.auditOnly !== "boolean") throw new Error("hosted smoke cleanup audit mode is invalid");
  const deps = resolvedDependencies(dependencies);
  assertLinuxRoot(deps);
  deps.validateOutputDirectory(outputDir);
  const clock = monotonicClock(deps.now);
  const commandTrace = [];
  const beforeSnapshot = inspectHostedSmokeAbsence(resources, deps);

  if (root.auditOnly) {
    if (!beforeSnapshot.completeAbsence) {
      throw new Error("hosted smoke audit requires complete exact resource absence");
    }
    const observations = absenceObservations(resources, beforeSnapshot, clock);
    return cleanupResult(resources, true, "audit_only", observations, commandTrace, beforeSnapshot, beforeSnapshot, null);
  }

  let cleanupMode = "already_absent";
  if (!beforeSnapshot.completeAbsence) {
    cleanupMode = "owned_resources_removed";
    assertOwnedPreMutationState(resources, beforeSnapshot, deps);
    const tableWasInitiallyPresent = !beforeSnapshot.nftTableAbsent;

    if (tableWasInitiallyPresent) {
      settleExactUnit(resources.canaryUnit, deps, commandTrace);
      settleExactUnit(resources.gatewayUnit, deps, commandTrace);
    }
    const unitsSettled = inspectHostedSmokeAbsence(resources, deps);
    const gatewayStopped = stageEvidence("gatewayStopped", clock, {
      unit: resources.gatewayUnit,
      unitAbsent: !unitsSettled.gatewayUnit.exists,
      cgroupEmpty: unitsSettled.gatewayUnit.cgroupEmpty,
    });
    if (unitsSettled.gatewayUnit.exists || unitsSettled.canaryUnit.exists ||
        !unitsSettled.gatewayUnit.cgroupEmpty || !unitsSettled.canaryUnit.cgroupEmpty) {
      throw new Error("hosted smoke exact systemd units or cgroups survived cleanup");
    }

    const runnerUidIdle = stageEvidence("runnerUidIdle", clock, {
      uid: resources.runnerUid,
      idle: unitsSettled.runnerUidIdle,
    });
    const gatewayUidIdle = stageEvidence("gatewayUidIdle", clock, {
      uid: resources.gatewayUid,
      idle: unitsSettled.gatewayUidIdle,
    });
    if (!unitsSettled.runnerUidIdle || !unitsSettled.gatewayUidIdle) {
      // Containment deliberately remains installed when either identity lives.
      throw new Error("hosted smoke dedicated identities remain live; containment retained");
    }
    if (tableWasInitiallyPresent === unitsSettled.nftTableAbsent) {
      throw new Error(
        tableWasInitiallyPresent
          ? "hosted smoke owned containment disappeared before filesystem cleanup"
          : "hosted smoke containment appeared during pre-policy cleanup"
      );
    }
    const cgroupCleanup = stageEvidence("cgroupCleanup", clock, {
      gatewayUnitAbsent: !unitsSettled.gatewayUnit.exists,
      canaryUnitAbsent: !unitsSettled.canaryUnit.exists,
      gatewayCgroupEmpty: unitsSettled.gatewayUnit.cgroupEmpty,
      canaryCgroupEmpty: unitsSettled.canaryUnit.cgroupEmpty,
    });

    if (unitsSettled.workspace.exists) {
      assertOwnedWorkspaceState(unitsSettled.workspace, resources.workspacePath);
      commandTrace.push(traceEntry("remove_workspace", resources.workspacePath));
      deps.removeExactTree(resources.workspacePath);
    }
    if (unitsSettled.runtime.exists) {
      assertOwnedDirectoryState(unitsSettled.runtime, resources.runtimeRoot, "hosted smoke runtime root");
      commandTrace.push(traceEntry("remove_runtime", resources.runtimeRoot));
      deps.removeExactTree(resources.runtimeRoot);
    }

    const beforeTableRemoval = inspectHostedSmokeAbsence(resources, deps);
    if (beforeTableRemoval.runtime.exists || beforeTableRemoval.workspace.exists ||
        beforeTableRemoval.gatewayUnit.exists || beforeTableRemoval.canaryUnit.exists ||
        !beforeTableRemoval.gatewayUnit.cgroupEmpty || !beforeTableRemoval.canaryUnit.cgroupEmpty ||
        !beforeTableRemoval.runnerUidIdle || !beforeTableRemoval.gatewayUidIdle) {
      throw new Error("hosted smoke resources are not quiescent before nftables removal");
    }
    if (tableWasInitiallyPresent === beforeTableRemoval.nftTableAbsent) {
      throw new Error(
        tableWasInitiallyPresent
          ? "hosted smoke owned containment disappeared before exact removal"
          : "hosted smoke containment appeared during pre-policy cleanup"
      );
    }
    const workspaceCleanup = stageEvidence("workspaceCleanup", clock, {
      workspaceAbsent: !beforeTableRemoval.workspace.exists,
      runtimeRootAbsent: !beforeTableRemoval.runtime.exists,
    });

    const tableWasPresent = tableWasInitiallyPresent;
    if (tableWasPresent) {
      commandTrace.push(traceEntry("delete_nft_table", resources.nftTable));
      deps.deleteTable(resources.nftTable);
    }
    if (deps.tableExists(resources.nftTable)) {
      throw new Error("hosted smoke exact nftables table survived cleanup");
    }
    const nftRemoval = stageEvidence("nftRemoval", clock, {
      table: resources.nftTable,
      tableWasPresent,
      tableAbsent: true,
    });
    const afterSnapshot = inspectHostedSmokeAbsence(resources, deps);
    if (!afterSnapshot.completeAbsence) {
      throw new Error("hosted smoke resources reappeared after containment removal");
    }
    const finalAbsence = stageEvidence("finalAbsence", clock, {
      completeAbsence: true,
      snapshotDigest: sha256(Buffer.from(canonicalJson(afterSnapshot), "utf8")),
    });
    const observations = deepFreeze({
      gatewayStopped,
      runnerUidIdle,
      gatewayUidIdle,
      cgroupCleanup,
      workspaceCleanup,
      nftRemoval,
      finalAbsence,
    });
    const result = cleanupResult(
      resources, false, cleanupMode, observations, commandTrace, beforeSnapshot, afterSnapshot, null
    );
    const reportPath = writeCleanupReport(deps, outputDir, resources.cleanupReportName, result.canonicalJson);
    return deepFreeze({ ...result, reportPath });
  }

  const observations = absenceObservations(resources, beforeSnapshot, clock);
  const result = cleanupResult(
    resources, false, cleanupMode, observations, commandTrace, beforeSnapshot, beforeSnapshot, null
  );
  const reportPath = writeCleanupReport(deps, outputDir, resources.cleanupReportName, result.canonicalJson);
  return deepFreeze({ ...result, reportPath });
}

function absenceObservations(resources, snapshot, clock) {
  return deepFreeze({
    gatewayStopped: stageEvidence("gatewayStopped", clock, {
      unit: resources.gatewayUnit,
      unitAbsent: true,
      cgroupEmpty: true,
    }),
    runnerUidIdle: stageEvidence("runnerUidIdle", clock, { uid: resources.runnerUid, idle: true }),
    gatewayUidIdle: stageEvidence("gatewayUidIdle", clock, { uid: resources.gatewayUid, idle: true }),
    cgroupCleanup: stageEvidence("cgroupCleanup", clock, {
      gatewayUnitAbsent: true,
      canaryUnitAbsent: true,
      gatewayCgroupEmpty: true,
      canaryCgroupEmpty: true,
    }),
    workspaceCleanup: stageEvidence("workspaceCleanup", clock, {
      workspaceAbsent: true,
      runtimeRootAbsent: true,
    }),
    nftRemoval: stageEvidence("nftRemoval", clock, {
      table: resources.nftTable,
      tableWasPresent: false,
      tableAbsent: snapshot.nftTableAbsent,
    }),
    finalAbsence: stageEvidence("finalAbsence", clock, {
      completeAbsence: snapshot.completeAbsence,
      snapshotDigest: sha256(Buffer.from(canonicalJson(snapshot), "utf8")),
    }),
  });
}

function cleanupResult(resources, auditOnly, cleanupMode, observations, commandTrace, beforeSnapshot, afterSnapshot, reportPath) {
  const report = deepFreeze({
    schemaVersion: 1,
    kind: HOSTED_SMOKE_CLEANUP_REPORT_KIND,
    suiteId: resources.suiteId,
    jobId: resources.jobId,
    scenario: resources.scenario,
    resourceSuffix: resources.suffix,
    nftTable: resources.nftTable,
    gatewayUnit: resources.gatewayUnit,
    canaryUnit: resources.canaryUnit,
    runtimeRoot: resources.runtimeRoot,
    workspacePath: resources.workspacePath,
    runnerUid: resources.runnerUid,
    gatewayUid: resources.gatewayUid,
    listenerPort: resources.listenerPort,
    auditOnly,
    cleanupMode,
    observations,
    commandTrace: deepFreeze([...commandTrace]),
    beforeSnapshotDigest: sha256(Buffer.from(canonicalJson(beforeSnapshot), "utf8")),
    afterSnapshotDigest: sha256(Buffer.from(canonicalJson(afterSnapshot), "utf8")),
    status: "passed",
    selfAttested: true,
    authoritativeDrill: false,
    releaseEvidenceEligible: false,
    activationBlocked: true,
    externalSigningEligible: false,
    authorizationStatus: HOSTED_SMOKE_AUTHORIZATION_STATUS,
  });
  const wire = canonicalJson(report);
  if (Buffer.byteLength(wire, "utf8") > MAX_REPORT_BYTES) throw new Error("hosted smoke cleanup report is excessive");
  return deepFreeze({
    report,
    canonicalJson: wire,
    digest: sha256(Buffer.from(wire, "utf8")),
    observations,
    commandTrace: report.commandTrace,
    beforeSnapshot,
    afterSnapshot,
    reportPath,
  });
}

function assertOwnedPreMutationState(resources, snapshot, deps) {
  if (snapshot.nftTableAbsent &&
      (snapshot.gatewayUnit.exists || snapshot.canaryUnit.exists ||
       !snapshot.gatewayUnit.cgroupEmpty || !snapshot.canaryUnit.cgroupEmpty ||
       !snapshot.runnerUidIdle || !snapshot.gatewayUidIdle)) {
    throw new Error(
      "hosted smoke containment is absent while an exact unit, cgroup, or dedicated identity may be live"
    );
  }
  if (!snapshot.runtime.exists) {
    throw new Error("hosted smoke state exists without its exact ownership marker root");
  }
  assertOwnedDirectoryState(snapshot.runtime, resources.runtimeRoot, "hosted smoke runtime root");
  if (snapshot.workspace.exists) {
    assertOwnedWorkspaceState(snapshot.workspace, resources.workspacePath);
  }
  const markerText = deps.readOwnershipMarker(resources.ownershipMarkerPath);
  if (typeof markerText !== "string" || Buffer.byteLength(markerText, "utf8") === 0 ||
      Buffer.byteLength(markerText, "utf8") > MAX_MARKER_BYTES) {
    throw new Error("hosted smoke ownership marker is missing or excessive");
  }
  let value;
  try {
    value = JSON.parse(markerText);
  } catch {
    throw new Error("hosted smoke ownership marker is not JSON");
  }
  const marker = validateHostedSmokeOwnershipMarker(value, resources);
  const expectedText = buildHostedSmokeOwnershipMarker(resources).canonicalJson;
  if (markerText !== expectedText || canonicalJson(marker) !== expectedText) {
    throw new Error("hosted smoke ownership marker is not exact canonical JSON");
  }
}

function settleExactUnit(unit, deps, trace) {
  let state = normalizeUnitState(deps.inspectUnit(unit), unit);
  if (!state.exists) {
    if (!state.cgroupEmpty) throw new Error(`hosted smoke ${unit} absent unit retains a populated cgroup`);
    return;
  }
  trace.push(traceEntry("stop_unit", unit));
  deps.stopUnit(unit);
  state = pollUnitState(unit, deps, (value) => !value.active && value.cgroupEmpty);
  if (state.active || !state.cgroupEmpty) {
    trace.push(traceEntry("kill_unit_cgroup", unit));
    deps.killUnit(unit);
    state = pollUnitState(unit, deps, (value) => !value.active && value.cgroupEmpty);
  }
  if (state.active || !state.cgroupEmpty) {
    throw new Error(`hosted smoke ${unit} did not become quiescent`);
  }
  if (!state.exists) return;
  trace.push(traceEntry("collect_unit", unit));
  deps.collectUnit(unit);
  state = pollUnitState(unit, deps, (value) => !value.exists && value.cgroupEmpty);
  if (state.exists || !state.cgroupEmpty) {
    throw new Error(`hosted smoke ${unit} survived exact collection`);
  }
}

function pollUnitState(unit, deps, predicate) {
  let state;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    state = normalizeUnitState(deps.inspectUnit(unit), unit);
    if (predicate(state)) return state;
    if (attempt < 49) deps.wait(100);
  }
  return state;
}

function stageEvidence(stage, clock, detail) {
  const observedAt = clock();
  const payload = { stage, observedAt, detail: deepFreeze(structuredClone(detail)) };
  return deepFreeze({
    ...payload,
    evidenceDigest: sha256(Buffer.from(canonicalJson(payload), "utf8")),
  });
}

function traceEntry(operation, target) {
  return deepFreeze({ operation, target });
}

function monotonicClock(now) {
  let previous = 0;
  return () => {
    const observed = now();
    if (!Number.isSafeInteger(observed) || observed <= 0) throw new Error("hosted smoke cleanup clock is invalid");
    const next = Math.max(observed, previous + 1);
    previous = next;
    return next;
  };
}

function resolvedDependencies(overrides) {
  return {
    platform: overrides.platform ?? process.platform,
    getuid: overrides.getuid ?? process.getuid,
    now: overrides.now ?? Date.now,
    wait: overrides.wait ?? ((milliseconds) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    }),
    inspectUnit: overrides.inspectUnit ?? defaultInspectUnit,
    inspectPath: overrides.inspectPath ?? defaultInspectPath,
    uidIsIdle: overrides.uidIsIdle ?? defaultUidIsIdle,
    tableExists: overrides.tableExists ?? defaultTableExists,
    stopUnit: overrides.stopUnit ?? ((unit) => runChecked(SYSTEMCTL, ["stop", unit])),
    killUnit: overrides.killUnit ?? ((unit) => runChecked(SYSTEMCTL, ["kill", "--kill-whom=all", "--signal=KILL", unit])),
    collectUnit: overrides.collectUnit ?? ((unit) => runChecked(SYSTEMCTL, ["reset-failed", unit])),
    removeExactTree: overrides.removeExactTree ?? defaultRemoveExactTree,
    deleteTable: overrides.deleteTable ?? ((table) => runChecked(NFT, ["delete", "table", "inet", table])),
    readOwnershipMarker: overrides.readOwnershipMarker ?? defaultReadOwnershipMarker,
    validateOutputDirectory: overrides.validateOutputDirectory ?? defaultValidateOutputDirectory,
    writeReport: overrides.writeReport ?? defaultWriteReport,
  };
}

function assertLinuxRoot(deps) {
  const uid = typeof deps.getuid === "function" ? deps.getuid() : undefined;
  if (deps.platform !== "linux" || uid !== 0) throw new Error("hosted smoke cleanup requires Linux root");
}

function normalizeUnitState(value, unit) {
  const root = plainRecord(value, `${unit} state`);
  exactKeys(root, ["exists", "active", "controlGroup", "cgroupEmpty"], `${unit} state`);
  const expectedControlGroup = `/system.slice/${unit}`;
  if (typeof root.exists !== "boolean" || typeof root.active !== "boolean" ||
      typeof root.cgroupEmpty !== "boolean" ||
      !(root.controlGroup === null || root.controlGroup === expectedControlGroup)) {
    throw new Error(`${unit} state is invalid`);
  }
  if (!root.exists && root.active) throw new Error(`${unit} absent unit cannot be active`);
  return deepFreeze({ ...root });
}

function normalizePathState(value, expectedPath) {
  const root = plainRecord(value, `${expectedPath} state`);
  exactKeys(root, ["exists", "kind", "symlink", "uid", "gid", "mode", "realPath"], `${expectedPath} state`);
  if (typeof root.exists !== "boolean") throw new Error(`${expectedPath} state is invalid`);
  if (!root.exists) {
    if (root.kind !== null || root.symlink !== false || root.uid !== null || root.gid !== null ||
        root.mode !== null || root.realPath !== null) throw new Error(`${expectedPath} absent state is invalid`);
  } else if (
    !new Set(["directory", "file", "other"]).has(root.kind) || typeof root.symlink !== "boolean" ||
    !Number.isSafeInteger(root.uid) || root.uid < 0 || !Number.isSafeInteger(root.gid) || root.gid < 0 ||
    !Number.isSafeInteger(root.mode) || root.mode < 0 || root.mode > 0o7777 ||
    typeof root.realPath !== "string"
  ) throw new Error(`${expectedPath} present state is invalid`);
  return deepFreeze({ ...root });
}

function assertOwnedDirectoryState(state, expectedPath, label) {
  if (!state.exists || state.kind !== "directory" || state.symlink || state.uid !== 0 || state.gid !== 0 ||
      state.mode !== 0o700 || state.realPath !== expectedPath) {
    throw new Error(`${label} is not the exact root-owned 0700 directory`);
  }
}

function assertOwnedWorkspaceState(state, expectedPath) {
  if (!state.exists || state.kind !== "directory" || state.symlink || state.uid !== 0 || state.gid !== 0 ||
      !new Set([0o700, 0o555]).has(state.mode) || state.realPath !== expectedPath) {
    throw new Error("hosted smoke workspace is not the exact root-owned 0700 or sealed 0555 directory");
  }
}

function validateOutputDirectoryPath(value, resources) {
  const path = canonicalAbsolutePath(value, "hosted smoke cleanup output directory");
  const broad = new Set(["/", "/tmp", "/var", "/var/tmp", "/run", "/run/api-migrator-hosted-smoke"]);
  if (broad.has(path) || path === resources.runtimeRoot || path === resources.workspacePath ||
      path.startsWith(`${resources.runtimeRoot}/`) || path.startsWith(`${resources.workspacePath}/`) ||
      resources.runtimeRoot.startsWith(`${path}/`) || resources.workspacePath.startsWith(`${path}/`)) {
    throw new Error("hosted smoke cleanup output directory is broad or crosses a cleanup boundary");
  }
  return path;
}

function canonicalAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || !ABSOLUTE_PATH.test(value) ||
      value.includes("//") ||
      value.includes("/../") || value.endsWith("/..") || value.includes("/./") || value.endsWith("/.")) {
    throw new Error(`${label} is not a canonical absolute path`);
  }
  return value;
}

function defaultInspectPath(path) {
  try {
    const info = lstatSync(path);
    return {
      exists: true,
      kind: info.isDirectory() ? "directory" : (info.isFile() ? "file" : "other"),
      symlink: info.isSymbolicLink(),
      uid: info.uid,
      gid: info.gid,
      mode: info.mode & 0o7777,
      realPath: realpathSync(path),
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { exists: false, kind: null, symlink: false, uid: null, gid: null, mode: null, realPath: null };
    }
    throw error;
  }
}

function defaultInspectUnit(unit) {
  const output = runChecked(SYSTEMCTL, [
    "show", unit,
    "--property=LoadState", "--property=ActiveState", "--property=ControlGroup",
  ]);
  const expectedNames = new Set(["LoadState", "ActiveState", "ControlGroup"]);
  const properties = {};
  for (const line of output.trim().split("\n").filter(Boolean)) {
    const index = line.indexOf("=");
    if (index <= 0) throw new Error("systemd unit observation is malformed");
    const name = line.slice(0, index);
    if (!expectedNames.has(name) || Object.hasOwn(properties, name)) {
      throw new Error("systemd unit observation is duplicated or substituted");
    }
    properties[name] = line.slice(index + 1);
  }
  if (Object.keys(properties).length !== expectedNames.size ||
      !new Set(["loaded", "not-found"]).has(properties.LoadState) ||
      !new Set(["active", "activating", "deactivating", "failed", "inactive", "maintenance", "refreshing", "reloading"])
        .has(properties.ActiveState)) {
    throw new Error("systemd unit observation is incomplete or unsupported");
  }
  const exists = properties.LoadState !== "not-found";
  const active = new Set(["active", "activating", "reloading", "deactivating"]).has(properties.ActiveState);
  const expectedControlGroup = `/system.slice/${unit}`;
  if (properties.ControlGroup !== "" && properties.ControlGroup !== expectedControlGroup) {
    throw new Error("systemd unit control group is substituted");
  }
  const controlGroup = properties.ControlGroup || (cgroupPathExists(expectedControlGroup) ? expectedControlGroup : null);
  return { exists, active, controlGroup, cgroupEmpty: controlGroup === null || defaultCgroupEmpty(controlGroup) };
}

function cgroupPathExists(controlGroup) {
  try {
    return lstatSync(`/sys/fs/cgroup${controlGroup}`).isDirectory();
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function defaultCgroupEmpty(controlGroup) {
  const root = `/sys/fs/cgroup${controlGroup}`;
  if (!cgroupPathExists(controlGroup)) return true;
  let seen = 0;
  const visit = (path) => {
    seen += 1;
    if (seen > MAX_CGROUP_DIRECTORIES) throw new Error("hosted smoke cgroup subtree is excessive");
    const procs = readFileSync(join(path, "cgroup.procs"), "utf8").trim();
    if (procs !== "") return false;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!visit(join(path, entry.name))) return false;
    }
    return true;
  };
  return visit(root);
}

function defaultUidIsIdle(uid) {
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue;
    try {
      const status = readFileSync(`/proc/${entry.name}/status`, "utf8");
      const match = /(?:^|\n)Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)(?:\n|$)/.exec(status);
      if (!match) throw new Error("process UID status is malformed");
      if (match.slice(1).some((value) => Number(value) === uid)) return false;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return true;
}

function defaultTableExists(table) {
  const text = runChecked(NFT, ["-j", "list", "tables"]);
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error("nftables table observation is not JSON");
  }
  if (!root || typeof root !== "object" || !Array.isArray(root.nftables)) {
    throw new Error("nftables table observation is malformed");
  }
  let matches = 0;
  for (const entry of root.nftables) {
    if (!entry || typeof entry !== "object" || !entry.table || typeof entry.table !== "object") continue;
    if (entry.table.family === "inet" && entry.table.name === table) matches += 1;
  }
  if (matches > 1) throw new Error("nftables table observation contains duplicate exact tables");
  return matches === 1;
}

function defaultReadOwnershipMarker(path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || before.gid !== 0 ||
        (before.mode & 0o7777) !== 0o600 || before.size < 1 || before.size > MAX_MARKER_BYTES) {
      throw new Error("hosted smoke ownership marker file is insecure");
    }
    const text = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs) throw new Error("hosted smoke ownership marker changed while read");
    return text;
  } finally {
    closeSync(fd);
  }
}

function defaultRemoveExactTree(path) {
  const state = normalizePathState(defaultInspectPath(path), path);
  if (/^\/run\/api-migrator-hosted-smoke-workspace\/[a-f0-9]{16}$/.test(path)) {
    assertOwnedWorkspaceState(state, path);
  } else if (/^\/run\/api-migrator-hosted-smoke\/[a-f0-9]{16}$/.test(path)) {
    assertOwnedDirectoryState(state, path, "hosted smoke runtime cleanup target");
  } else {
    throw new Error("hosted smoke cleanup target is outside the exact resource namespace");
  }
  rmSync(path, { recursive: true, force: false, maxRetries: 0 });
  if (defaultInspectPath(path).exists) throw new Error("hosted smoke exact cleanup target survived removal");
}

function defaultValidateOutputDirectory(path) {
  const state = normalizePathState(defaultInspectPath(path), path);
  assertOwnedDirectoryState(state, path, "hosted smoke cleanup output directory");
}

function defaultWriteReport(outputDir, name, text) {
  if (typeof name !== "string" || !/^hosted-smoke-cleanup-[a-z0-9_]+-[a-f0-9]{16}\.json$/.test(name) ||
      typeof text !== "string" || Buffer.byteLength(text, "utf8") < 1 || Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("hosted smoke cleanup report output is invalid");
  }
  defaultValidateOutputDirectory(outputDir);
  const path = join(outputDir, name);
  let fd;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, text, { encoding: "utf8" });
    fsyncSync(fd);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0 ||
        (info.mode & 0o7777) !== 0o600 || info.size !== Buffer.byteLength(text, "utf8")) {
      throw new Error("hosted smoke cleanup report file is insecure");
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const directoryFd = openSync(outputDir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
  return path;
}

function writeCleanupReport(deps, outputDir, name, text) {
  const expected = join(outputDir, name);
  const written = deps.writeReport(outputDir, name, text);
  if (written !== expected) throw new Error("hosted smoke cleanup report path is substituted");
  return written;
}

function runChecked(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: "/",
    env: TRUSTED_ENVIRONMENT,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: MAX_COMMAND_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.signal !== null || result.status !== 0 ||
      Buffer.byteLength(result.stdout ?? "", "utf8") > MAX_COMMAND_BYTES ||
      Buffer.byteLength(result.stderr ?? "", "utf8") > MAX_COMMAND_BYTES) {
    throw new Error(`hosted smoke command failed: ${executable}`);
  }
  return result.stdout;
}

function booleanResult(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
  return value;
}

function plainRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, names, label) {
  const actual = Object.keys(value).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function main() {
  const cli = parseHostedSmokeCleanupCli(process.argv.slice(2));
  const run = parseHostedSmokeCleanupEnvironment(process.env);
  const resources = deriveHostedSmokeResources({ ...run, scenario: cli.scenario });
  const result = cleanupHostedSmoke({ resources, outputDir: cli.outputDir, auditOnly: cli.auditOnly });
  process.stdout.write(`${result.canonicalJson}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`hosted smoke cleanup refused: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
