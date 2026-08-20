import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HOSTED_SMOKE_GATEWAY_UID,
  HOSTED_SMOKE_LISTENER_PORT,
  HOSTED_SMOKE_RUNNER_UID,
  HOSTED_SMOKE_SCENARIOS,
  buildHostedSmokeOwnershipMarker,
  deriveHostedSmokeResources,
  deriveHostedSmokeSuiteId,
  validateHostedSmokeOwnershipMarker,
  validateHostedSmokeResources,
} from "../hosted-smoke-runtime.mjs";
import {
  cleanupHostedSmoke,
  inspectHostedSmokeAbsence,
  parseHostedSmokeCleanupCli,
  parseHostedSmokeCleanupEnvironment,
} from "../cleanup-hosted-smoke.mjs";
import { renderGatewayDeployment } from "../../gateway/gateway-contract.mjs";

const OUTPUT_DIR = "/var/lib/api-migrator-hosted-smoke-evidence/run-123";

function resources(scenario = "success") {
  return deriveHostedSmokeResources({ runId: "12345678901234567890", runAttempt: 7, scenario });
}

function absentPath() {
  return { exists: false, kind: null, symlink: false, uid: null, gid: null, mode: null, realPath: null };
}

function ownedDirectory(path, mode = 0o700) {
  return { exists: true, kind: "directory", symlink: false, uid: 0, gid: 0, mode, realPath: path };
}

function absentUnit() {
  return { exists: false, active: false, controlGroup: null, cgroupEmpty: true };
}

function lifecycleHarness(options = {}) {
  const value = resources(options.scenario);
  const prePolicyFailure = options.prePolicyFailure === true;
  const state = {
    table: options.absent === true || options.tableAbsent === true || prePolicyFailure ? false : true,
    runtime: options.absent === true ? false : true,
    workspace: options.absent === true ? false : true,
    runnerIdle: options.absent === true || prePolicyFailure ? true : false,
    gatewayIdle: options.absent === true || prePolicyFailure ? true : false,
    units: new Map([
      [value.canaryUnit, options.absent === true || prePolicyFailure ? absentUnit() : {
        exists: true, active: true, controlGroup: `/system.slice/${value.canaryUnit}`, cgroupEmpty: false,
      }],
      [value.gatewayUnit, options.absent === true || prePolicyFailure ? absentUnit() : {
        exists: true, active: true, controlGroup: `/system.slice/${value.gatewayUnit}`, cgroupEmpty: false,
      }],
    ]),
  };
  const calls = [];
  let time = 2_000_000_000_000;
  const deps = {
    platform: "linux",
    getuid: () => 0,
    now: () => time++,
    wait: () => {},
    inspectUnit: (unit) => structuredClone(state.units.get(unit)),
    inspectPath: (path) => {
      if (path === value.runtimeRoot) return state.runtime ? ownedDirectory(path) : absentPath();
      if (path === value.workspacePath) return state.workspace ? ownedDirectory(path, options.workspaceMode ?? 0o555) : absentPath();
      throw new Error(`unexpected path inspection: ${path}`);
    },
    uidIsIdle: (uid) => uid === value.runnerUid ? state.runnerIdle : state.gatewayIdle,
    tableExists: (table) => {
      assert.equal(table, value.nftTable);
      return state.table;
    },
    stopUnit: (unit) => {
      calls.push(["stop", unit]);
      state.units.get(unit).active = false;
    },
    killUnit: (unit) => {
      calls.push(["kill", unit]);
      if (options.cgroupSurvives !== true) state.units.get(unit).cgroupEmpty = true;
    },
    collectUnit: (unit) => {
      calls.push(["collect", unit]);
      state.units.set(unit, absentUnit());
      if (unit === value.canaryUnit && options.runnerRemainsLive !== true) state.runnerIdle = true;
      if (unit === value.gatewayUnit && options.gatewayRemainsLive !== true) state.gatewayIdle = true;
    },
    removeExactTree: (path) => {
      calls.push(["remove", path]);
      if (path === value.runtimeRoot) {
        state.runtime = false;
        if (options.tableDisappearsDuringCleanup === true) state.table = false;
        if (options.tableAppearsDuringCleanup === true) state.table = true;
      }
      else if (path === value.workspacePath) state.workspace = false;
      else throw new Error("broad cleanup target");
    },
    deleteTable: (table) => {
      calls.push(["delete-table", table]);
      state.table = false;
    },
    readOwnershipMarker: () => Object.hasOwn(options, "markerText")
      ? options.markerText
      : buildHostedSmokeOwnershipMarker(value).canonicalJson,
    validateOutputDirectory: (path) => assert.equal(path, OUTPUT_DIR),
    writeReport: (path, name, text) => {
      calls.push(["write-report", `${path}/${name}`]);
      assert.equal(JSON.stringify(JSON.parse(text)), text);
      return `${path}/${name}`;
    },
  };
  return { resources: value, state, calls, deps };
}

test("derives one bounded exact namespace and gateway-compatible table per scenario", () => {
  assert.equal(HOSTED_SMOKE_SCENARIOS.length, 15);
  assert.equal(new Set(HOSTED_SMOKE_SCENARIOS).size, 15);
  const suiteId = deriveHostedSmokeSuiteId({ runId: "12345678901234567890", runAttempt: "7" });
  const identities = HOSTED_SMOKE_SCENARIOS.map((scenario) => resources(scenario));
  assert(identities.every((entry) => entry.suiteId === suiteId));
  assert.equal(new Set(identities.map(({ jobId }) => jobId)).size, 15);
  assert.equal(new Set(identities.map(({ suffix }) => suffix)).size, 15);
  for (const value of identities) {
    assert.match(value.jobId, /^previewjob_[a-f0-9]{64}$/);
    assert.equal(value.suffix, value.jobId.slice("previewjob_".length, "previewjob_".length + 16));
    assert.equal(value.nftTable, `api_migrator_gw_${value.suffix}`);
    assert.match(value.gatewayUnit, /^api-migrator-hosted-gateway-[a-f0-9]{16}\.service$/);
    assert.match(value.canaryUnit, /^api-migrator-hosted-canary-[a-f0-9]{16}\.service$/);
    assert.equal(value.runtimeRoot, `/run/api-migrator-hosted-smoke/${value.suffix}`);
    assert.equal(value.workspacePath, `/run/api-migrator-hosted-smoke-workspace/${value.suffix}`);
    assert.equal(value.runnerUid, HOSTED_SMOKE_RUNNER_UID);
    assert.equal(value.gatewayUid, HOSTED_SMOKE_GATEWAY_UID);
    assert.equal(value.listenerPort, HOSTED_SMOKE_LISTENER_PORT);
    assert.deepEqual(deriveHostedSmokeResources({
      runId: value.runId,
      runAttempt: value.runAttempt,
      scenario: value.scenario,
    }), value);
  }

  const contract = JSON.parse(readFileSync(
    new URL("../../gateway/examples/gateway-contract.example.json", import.meta.url),
    "utf8"
  ));
  contract.jobId = identities[0].jobId;
  contract.runnerUid = HOSTED_SMOKE_RUNNER_UID;
  contract.gatewayUid = HOSTED_SMOKE_GATEWAY_UID;
  contract.listener.port = HOSTED_SMOKE_LISTENER_PORT;
  assert.equal(renderGatewayDeployment(contract).nftablesTable, identities[0].nftTable);
});

test("rejects unsupported coordinates and every resource or marker substitution", () => {
  for (const input of [
    { runId: "0", runAttempt: 1, scenario: "success" },
    { runId: "12", runAttempt: 0, scenario: "success" },
    { runId: "12", runAttempt: 1, scenario: "oom" },
    { runId: "12", runAttempt: 1, scenario: "reboot" },
    { runId: "12", runAttempt: 1, scenario: "success", extra: true },
  ]) assert.throws(() => deriveHostedSmokeResources(input), /invalid|unsupported|fields/);

  const value = resources();
  for (const mutate of [
    (entry) => { entry.jobId = `previewjob_${"f".repeat(64)}`; },
    (entry) => { entry.nftTable = "api_migrator_gw_ffffffffffffffff"; },
    (entry) => { entry.gatewayUnit = "api-migrator-runner.service"; },
    (entry) => { entry.runtimeRoot = "/run"; },
    (entry) => { entry.workspacePath = "/var/tmp"; },
    (entry) => { entry.runnerUid = 0; },
  ]) {
    const changed = structuredClone(value);
    mutate(changed);
    assert.throws(() => validateHostedSmokeResources(changed), /substituted/);
  }

  const built = buildHostedSmokeOwnershipMarker(value);
  assert.equal(JSON.stringify(JSON.parse(built.canonicalJson)), built.canonicalJson);
  assert.deepEqual(validateHostedSmokeOwnershipMarker(built.marker, value), built.marker);
  for (const mutate of [
    (marker) => { marker.nftTable = "api_migrator_gw_ffffffffffffffff"; },
    (marker) => { marker.releaseEvidenceEligible = true; },
    (marker) => { marker.externalSigningEligible = true; },
    (marker) => { marker.authorizationStatus = "authorized"; },
  ]) {
    const marker = structuredClone(built.marker);
    mutate(marker);
    assert.throws(() => validateHostedSmokeOwnershipMarker(marker, value), /substitutes|authorizing/);
  }
});

test("accepts only the exact CLI and exact sudo env-i environment", () => {
  assert.deepEqual(
    parseHostedSmokeCleanupCli(["--scenario", "success", "--output-dir", OUTPUT_DIR]),
    { scenario: "success", outputDir: OUTPUT_DIR, auditOnly: false }
  );
  assert.deepEqual(
    parseHostedSmokeCleanupCli(["--scenario", "offline_network", "--output-dir", OUTPUT_DIR, "--audit-only"]),
    { scenario: "offline_network", outputDir: OUTPUT_DIR, auditOnly: true }
  );
  for (const argv of [
    [],
    ["--scenario", "oom", "--output-dir", OUTPUT_DIR],
    ["--output-dir", OUTPUT_DIR, "--scenario", "success"],
    ["--scenario", "success", "--output-dir", "/var/tmp"],
    ["--scenario", "success", "--output-dir", `${OUTPUT_DIR}/`],
    ["--scenario", "success", "--output-dir", `${OUTPUT_DIR}/../forged`],
    ["--scenario", "success", "--output-dir", OUTPUT_DIR, "--publish"],
  ]) assert.throws(() => parseHostedSmokeCleanupCli(argv), /usage|unsupported|canonical|broad/);

  const env = {
    API_MIGRATOR_SMOKE_RUN_ATTEMPT: "7",
    API_MIGRATOR_SMOKE_RUN_ID: "12345678901234567890",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    TZ: "UTC",
  };
  assert.deepEqual(parseHostedSmokeCleanupEnvironment(env), {
    runId: "12345678901234567890",
    runAttempt: 7,
  });
  assert.throws(
    () => parseHostedSmokeCleanupEnvironment({ ...env, GITHUB_TOKEN: "secret" }),
    /exact sanitized allowlist/
  );
  assert.throws(
    () => parseHostedSmokeCleanupEnvironment({ ...env, PATH: "/tmp/bin" }),
    /not sanitized/
  );

  const cleanupSource = readFileSync(new URL("../cleanup-hosted-smoke.mjs", import.meta.url), "utf8");
  assert.match(cleanupSource, /\["kill", "--kill-whom=all", "--signal=KILL", unit\]/);
  assert.doesNotMatch(cleanupSource, /--kill-who=/);
});

test("removes exact units and trees before deleting the owned table last", () => {
  const harness = lifecycleHarness();
  const result = cleanupHostedSmoke({
    resources: harness.resources,
    outputDir: OUTPUT_DIR,
    auditOnly: false,
  }, harness.deps);

  assert.equal(result.report.status, "passed");
  assert.equal(result.report.releaseEvidenceEligible, false);
  assert.equal(result.report.activationBlocked, true);
  assert.equal(result.report.externalSigningEligible, false);
  assert.equal(result.report.authorizationStatus, "non_authorizing_github_hosted_smoke_only");
  assert.equal(result.afterSnapshot.completeAbsence, true);
  assert.equal(result.reportPath, `${OUTPUT_DIR}/${harness.resources.cleanupReportName}`);
  const operations = harness.calls.map(([operation]) => operation);
  assert.deepEqual(operations, [
    "stop", "kill", "collect",
    "stop", "kill", "collect",
    "remove", "remove", "delete-table", "write-report",
  ]);
  const deleteIndex = operations.indexOf("delete-table");
  assert(deleteIndex > operations.lastIndexOf("remove"));
  assert.equal(harness.calls[deleteIndex][1], harness.resources.nftTable);
  assert(harness.calls.slice(0, deleteIndex).every(([, target]) => target !== harness.resources.nftTable));
  assert.deepEqual(result.commandTrace.map(({ operation }) => operation), [
    "stop_unit", "kill_unit_cgroup", "collect_unit",
    "stop_unit", "kill_unit_cgroup", "collect_unit",
    "remove_workspace", "remove_runtime", "delete_nft_table",
  ]);
  const times = Object.values(result.observations).map(({ observedAt }) => observedAt);
  assert(times.every((value, index) => index === 0 || value > times[index - 1]));
  assert(Object.values(result.observations).every(({ evidenceDigest }) => /^sha256:[a-f0-9]{64}$/.test(evidenceDigest)));
});

test("accepts only the owned workspace writing or sealed lifecycle modes", () => {
  for (const workspaceMode of [0o700, 0o555]) {
    const harness = lifecycleHarness({ workspaceMode });
    const result = cleanupHostedSmoke({
      resources: harness.resources,
      outputDir: OUTPUT_DIR,
      auditOnly: false,
    }, harness.deps);
    assert.equal(result.afterSnapshot.completeAbsence, true);
  }

  for (const workspaceMode of [0o777, 0o755, 0o500]) {
    const harness = lifecycleHarness({ workspaceMode });
    assert.throws(
      () => cleanupHostedSmoke({ resources: harness.resources, outputDir: OUTPUT_DIR, auditOnly: false }, harness.deps),
      /workspace is not the exact root-owned/
    );
    assert.deepEqual(harness.calls, []);
    assert.equal(harness.state.table, true);
  }
});

test("a live identity or populated cgroup fails before paths or containment are removed", () => {
  for (const options of [{ runnerRemainsLive: true }, { gatewayRemainsLive: true }, { cgroupSurvives: true }]) {
    const harness = lifecycleHarness(options);
    assert.throws(
      () => cleanupHostedSmoke({ resources: harness.resources, outputDir: OUTPUT_DIR, auditOnly: false }, harness.deps),
      /remain live|quiescent/
    );
    assert.equal(harness.state.table, true);
    assert.equal(harness.state.runtime, true);
    assert.equal(harness.state.workspace, true);
    assert.equal(harness.calls.some(([operation]) => operation === "delete-table"), false);
    assert.equal(harness.calls.some(([operation]) => operation === "remove"), false);
  }
});

test("removes exact owned paths after a failure before containment installation", () => {
  const harness = lifecycleHarness({ prePolicyFailure: true });
  const result = cleanupHostedSmoke({
    resources: harness.resources,
    outputDir: OUTPUT_DIR,
    auditOnly: false,
  }, harness.deps);

  assert.equal(result.report.status, "passed");
  assert.equal(result.report.cleanupMode, "owned_resources_removed");
  assert.equal(result.beforeSnapshot.nftTableAbsent, true);
  assert.equal(result.afterSnapshot.completeAbsence, true);
  assert.deepEqual(harness.calls.map(([operation]) => operation), [
    "remove", "remove", "write-report",
  ]);
  assert.equal(result.commandTrace.some(({ operation }) => operation === "delete_nft_table"), false);
  assert.equal(result.observations.nftRemoval.detail.tableWasPresent, false);
});

test("pre-policy cleanup refuses every live unit, cgroup, or dedicated identity before mutation", () => {
  const cases = [
    (harness) => { harness.state.runnerIdle = false; },
    (harness) => { harness.state.gatewayIdle = false; },
    (harness) => {
      harness.state.units.set(harness.resources.gatewayUnit, {
        exists: true,
        active: true,
        controlGroup: `/system.slice/${harness.resources.gatewayUnit}`,
        cgroupEmpty: false,
      });
    },
    (harness) => {
      harness.state.units.set(harness.resources.canaryUnit, {
        ...absentUnit(),
        cgroupEmpty: false,
      });
    },
  ];
  for (const mutate of cases) {
    const harness = lifecycleHarness({ prePolicyFailure: true });
    mutate(harness);
    assert.throws(
      () => cleanupHostedSmoke({ resources: harness.resources, outputDir: OUTPUT_DIR, auditOnly: false }, harness.deps),
      /containment is absent while an exact unit, cgroup, or dedicated identity may be live/
    );
    assert.deepEqual(harness.calls, []);
    assert.equal(harness.state.runtime, true);
    assert.equal(harness.state.workspace, true);
  }
});

test("cleanup never false-passes if exact containment presence changes during teardown", () => {
  const disappeared = lifecycleHarness({ tableDisappearsDuringCleanup: true });
  assert.throws(
    () => cleanupHostedSmoke({
      resources: disappeared.resources,
      outputDir: OUTPUT_DIR,
      auditOnly: false,
    }, disappeared.deps),
    /containment disappeared before exact removal/
  );
  assert.equal(disappeared.calls.some(([operation]) => operation === "delete-table"), false);
  assert.equal(disappeared.calls.some(([operation]) => operation === "write-report"), false);

  const appeared = lifecycleHarness({ prePolicyFailure: true, tableAppearsDuringCleanup: true });
  assert.throws(
    () => cleanupHostedSmoke({
      resources: appeared.resources,
      outputDir: OUTPUT_DIR,
      auditOnly: false,
    }, appeared.deps),
    /containment appeared during pre-policy cleanup/
  );
  assert.equal(appeared.calls.some(([operation]) => operation === "delete-table"), false);
  assert.equal(appeared.calls.some(([operation]) => operation === "write-report"), false);
});

test("rejects missing ownership, symlink state, broad output, and substituted resources before mutation", () => {
  const uncontained = lifecycleHarness({ tableAbsent: true });
  assert.throws(
    () => cleanupHostedSmoke({ resources: uncontained.resources, outputDir: OUTPUT_DIR, auditOnly: false }, uncontained.deps),
    /containment is absent while an exact unit, cgroup, or dedicated identity may be live/
  );
  assert.deepEqual(uncontained.calls, []);

  const missing = lifecycleHarness({ markerText: null });
  assert.throws(
    () => cleanupHostedSmoke({ resources: missing.resources, outputDir: OUTPUT_DIR, auditOnly: false }, missing.deps),
    /ownership marker/
  );
  assert.equal(missing.calls.length, 0);
  assert.equal(missing.state.table, true);

  const symlink = lifecycleHarness();
  const originalInspectPath = symlink.deps.inspectPath;
  symlink.deps.inspectPath = (path) => path === symlink.resources.runtimeRoot
    ? { ...ownedDirectory(path), symlink: true, realPath: "/tmp/forged" }
    : originalInspectPath(path);
  assert.throws(
    () => cleanupHostedSmoke({ resources: symlink.resources, outputDir: OUTPUT_DIR, auditOnly: false }, symlink.deps),
    /root-owned/
  );
  assert.equal(symlink.calls.length, 0);

  const broad = lifecycleHarness();
  assert.throws(
    () => cleanupHostedSmoke({ resources: broad.resources, outputDir: "/var/tmp", auditOnly: false }, broad.deps),
    /broad/
  );
  assert.equal(broad.calls.length, 0);

  const substituted = lifecycleHarness();
  const forged = structuredClone(substituted.resources);
  forged.nftTable = "api_migrator_gw_ffffffffffffffff";
  assert.throws(
    () => cleanupHostedSmoke({ resources: forged, outputDir: OUTPUT_DIR, auditOnly: false }, substituted.deps),
    /substituted/
  );
  assert.equal(substituted.calls.length, 0);

  const cgroupSubstitution = lifecycleHarness();
  cgroupSubstitution.state.units.get(cgroupSubstitution.resources.gatewayUnit).controlGroup =
    "/system.slice/substituted.service";
  assert.throws(
    () => cleanupHostedSmoke({
      resources: cgroupSubstitution.resources,
      outputDir: OUTPUT_DIR,
      auditOnly: false,
    }, cgroupSubstitution.deps),
    /state is invalid/
  );
  assert.deepEqual(cgroupSubstitution.calls, []);
});

test("audit-only is strictly read-only and requires complete exact absence", () => {
  const absent = lifecycleHarness({ absent: true });
  const snapshot = inspectHostedSmokeAbsence(absent.resources, absent.deps);
  assert.equal(snapshot.completeAbsence, true);
  const result = cleanupHostedSmoke({ resources: absent.resources, outputDir: OUTPUT_DIR, auditOnly: true }, absent.deps);
  assert.equal(result.report.auditOnly, true);
  assert.equal(result.report.cleanupMode, "audit_only");
  assert.equal(result.reportPath, null);
  assert.deepEqual(absent.calls, []);

  const present = lifecycleHarness();
  assert.throws(
    () => cleanupHostedSmoke({ resources: present.resources, outputDir: OUTPUT_DIR, auditOnly: true }, present.deps),
    /complete exact resource absence/
  );
  assert.deepEqual(present.calls, []);
  assert.equal(present.state.table, true);
});
