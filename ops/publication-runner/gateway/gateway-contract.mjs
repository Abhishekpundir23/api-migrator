#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GATEWAY_PROFILE = "static-envoy-sni-passthrough-v1";
export const GATEWAY_RECEIPT_KIND = "api_migrator_l7_gateway_receipt";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const JOB_ID = /^previewjob_[a-f0-9]{64}$/;
const INVOCATION_ID = /^[a-f0-9]{32}$/;
const EVIDENCE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#@+-]{0,499}$/;
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"];
const MAX_CANONICAL_INPUT_BYTES = 128 * 1024;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MIN_PLAN_TTL_MS = 60 * 1_000;
const MAX_PLAN_TTL_MS = 15 * 60 * 1_000;
const MAX_RESOLUTION_AGE_MS = 5 * 60 * 1_000;
const MAX_RESOLUTION_TTL_MS = 30 * 60 * 1_000;
const RECEIPT_EVIDENCE_NAMES = [
  "deploymentDrill",
  "envoyConfigValidation",
  "gatewayAccessLog",
  "nftablesInstalled",
  "offlineNetworkClosure",
  "teardown",
  "tlsClientPolicy",
  "transportCounters",
];

/**
 * Render one immutable gateway deployment contract into exact Envoy and
 * nftables artifacts. The output is configuration, not evidence that either
 * artifact was installed or enforced on Linux.
 */
export function renderGatewayDeployment(value) {
  const contract = validateGatewayContract(value);
  const canonicalContract = canonicalJson(contract);
  const digest = sha256(Buffer.from(canonicalContract, "utf8"));
  const nftablesTable = tableName(contract.jobId);
  const envoyConfig = buildEnvoyConfig(contract);
  const envoyConfigJson = canonicalJson(envoyConfig);
  const nftablesPolicy = buildNftablesPolicy(contract, nftablesTable);

  return deepFreeze({
    contract,
    canonicalJson: canonicalContract,
    digest,
    envoyConfig,
    envoyConfigJson,
    envoyConfigDigest: sha256(Buffer.from(envoyConfigJson, "utf8")),
    nftablesPolicy,
    nftablesPolicyDigest: sha256(Buffer.from(nftablesPolicy, "utf8")),
    nftablesTable,
  });
}

/** Recompute every artifact and reject a substituted record. */
export function validateGatewayDeploymentRecord(value) {
  const root = asRecord(value, "gateway deployment record");
  exactKeys(root, [
    "contract",
    "canonicalJson",
    "digest",
    "envoyConfig",
    "envoyConfigJson",
    "envoyConfigDigest",
    "nftablesPolicy",
    "nftablesPolicyDigest",
    "nftablesTable",
  ], "gateway deployment record");
  const expected = renderGatewayDeployment(root.contract);
  if (
    root.canonicalJson !== expected.canonicalJson ||
    root.digest !== expected.digest ||
    canonicalJson(root.envoyConfig) !== expected.envoyConfigJson ||
    root.envoyConfigJson !== expected.envoyConfigJson ||
    root.envoyConfigDigest !== expected.envoyConfigDigest ||
    root.nftablesPolicy !== expected.nftablesPolicy ||
    root.nftablesPolicyDigest !== expected.nftablesPolicyDigest ||
    root.nftablesTable !== expected.nftablesTable
  ) {
    throw new Error("Gateway deployment record contains substituted artifacts");
  }
  return expected;
}

/** Reject any Envoy object that differs from the fixed static configuration. */
export function validateRenderedEnvoyConfig(value, deployment) {
  const expected = validateGatewayDeploymentRecord(deployment);
  if (canonicalJson(value) !== expected.envoyConfigJson) {
    throw new Error("Envoy configuration contains unsupported or weakened controls");
  }
  return expected.envoyConfig;
}

/** Reject any nftables text that differs byte-for-byte from the forced route. */
export function validateRenderedNftablesPolicy(value, deployment) {
  const expected = validateGatewayDeploymentRecord(deployment);
  if (value !== expected.nftablesPolicy) {
    throw new Error("Gateway nftables policy contains unsupported or weakened controls");
  }
  return expected.nftablesPolicy;
}

/**
 * Validate an observer-produced receipt against the exact rendered contract.
 * A valid receipt remains unsigned raw evidence and cannot authorize a run.
 */
export function validateGatewayReceipt(value, deployment) {
  const expected = validateGatewayDeploymentRecord(deployment);
  const contract = expected.contract;
  const root = asRecord(value, "gateway receipt");
  exactKeys(root, [
    "schemaVersion",
    "kind",
    "profile",
    "jobId",
    "planDigest",
    "contractDigest",
    "envoyConfigDigest",
    "nftablesPolicyDigest",
    "gatewayRuntimeDigest",
    "nftablesTable",
    "runnerUid",
    "gatewayUid",
    "listener",
    "origin",
    "execution",
    "evidence",
    "teardown",
    "observedAt",
    "status",
  ], "gateway receipt");
  if (
    root.schemaVersion !== 1 ||
    root.kind !== GATEWAY_RECEIPT_KIND ||
    root.profile !== GATEWAY_PROFILE ||
    root.status !== "passed"
  ) {
    throw new Error("Gateway receipt version, profile, kind, or status is unsupported");
  }
  if (
    root.jobId !== contract.jobId ||
    root.planDigest !== contract.plan.digest ||
    root.contractDigest !== expected.digest ||
    root.envoyConfigDigest !== expected.envoyConfigDigest ||
    root.nftablesPolicyDigest !== expected.nftablesPolicyDigest ||
    root.gatewayRuntimeDigest !== contract.gatewayRuntimeDigest ||
    root.nftablesTable !== expected.nftablesTable ||
    root.runnerUid !== contract.runnerUid ||
    root.gatewayUid !== contract.gatewayUid
  ) {
    throw new Error("Gateway receipt does not bind the exact deployment contract");
  }

  const listener = validateListener(root.listener);
  const origin = validateOrigin(root.origin, contract.plan);
  if (
    canonicalJson(listener) !== canonicalJson(contract.listener) ||
    canonicalJson(origin) !== canonicalJson(contract.origin)
  ) {
    throw new Error("Gateway receipt listener or origin does not match the contract");
  }

  const executionRoot = asRecord(root.execution, "gateway receipt execution");
  exactKeys(executionRoot, [
    "systemdInvocationId",
    "gatewayInstanceDigest",
    "startedAt",
    "gatewayReadyAt",
    "installStartedAt",
    "installFinishedAt",
    "offlineEnforcedAt",
    "gatewayStoppedAt",
  ], "gateway receipt execution");
  const execution = {
    systemdInvocationId: exactPattern(
      executionRoot.systemdInvocationId,
      INVOCATION_ID,
      "systemd invocation id"
    ),
    gatewayInstanceDigest: digest(executionRoot.gatewayInstanceDigest, "gateway instance digest"),
    startedAt: timestamp(executionRoot.startedAt, "gateway start time"),
    gatewayReadyAt: timestamp(executionRoot.gatewayReadyAt, "gateway ready time"),
    installStartedAt: timestamp(executionRoot.installStartedAt, "install start time"),
    installFinishedAt: timestamp(executionRoot.installFinishedAt, "install finish time"),
    offlineEnforcedAt: timestamp(executionRoot.offlineEnforcedAt, "offline enforcement time"),
    gatewayStoppedAt: timestamp(executionRoot.gatewayStoppedAt, "gateway stop time"),
  };

  const evidenceRoot = asRecord(root.evidence, "gateway receipt evidence");
  exactKeys(evidenceRoot, RECEIPT_EVIDENCE_NAMES, "gateway receipt evidence");
  const evidence = Object.fromEntries(
    RECEIPT_EVIDENCE_NAMES.map((name) => [name, validateEvidence(evidenceRoot[name], name)])
  );

  const teardownRoot = asRecord(root.teardown, "gateway receipt teardown");
  exactKeys(teardownRoot, [
    "runnerUidIdleAt",
    "gatewayUidIdleAt",
    "nftablesPolicyRemovedAt",
    "complete",
  ], "gateway receipt teardown");
  if (teardownRoot.complete !== true) throw new Error("Gateway receipt teardown is incomplete");
  const teardown = {
    runnerUidIdleAt: timestamp(teardownRoot.runnerUidIdleAt, "runner UID idle time"),
    gatewayUidIdleAt: timestamp(teardownRoot.gatewayUidIdleAt, "gateway UID idle time"),
    nftablesPolicyRemovedAt: timestamp(
      teardownRoot.nftablesPolicyRemovedAt,
      "nftables removal time"
    ),
    complete: true,
  };
  const observedAt = timestamp(root.observedAt, "gateway receipt observation time");

  if (
    execution.startedAt < contract.plan.createdAt ||
    execution.gatewayReadyAt < execution.startedAt ||
    execution.installStartedAt < execution.gatewayReadyAt ||
    execution.installFinishedAt < execution.installStartedAt ||
    execution.offlineEnforcedAt < execution.installFinishedAt ||
    execution.gatewayStoppedAt < execution.offlineEnforcedAt ||
    teardown.runnerUidIdleAt < execution.gatewayStoppedAt ||
    teardown.gatewayUidIdleAt < execution.gatewayStoppedAt ||
    teardown.nftablesPolicyRemovedAt < teardown.runnerUidIdleAt ||
    teardown.nftablesPolicyRemovedAt < teardown.gatewayUidIdleAt ||
    observedAt < teardown.nftablesPolicyRemovedAt ||
    observedAt >= contract.plan.expiresAt
  ) {
    throw new Error("Gateway receipt lifecycle is incomplete, unordered, or expired");
  }

  return deepFreeze({
    schemaVersion: 1,
    kind: GATEWAY_RECEIPT_KIND,
    profile: GATEWAY_PROFILE,
    jobId: contract.jobId,
    planDigest: contract.plan.digest,
    contractDigest: expected.digest,
    envoyConfigDigest: expected.envoyConfigDigest,
    nftablesPolicyDigest: expected.nftablesPolicyDigest,
    gatewayRuntimeDigest: contract.gatewayRuntimeDigest,
    nftablesTable: expected.nftablesTable,
    runnerUid: contract.runnerUid,
    gatewayUid: contract.gatewayUid,
    listener,
    origin,
    execution,
    evidence,
    teardown,
    observedAt,
    status: "passed",
  });
}

/** Parse exact canonical receipt bytes and return a safe digest receipt. */
export function parseCanonicalGatewayReceipt(text, deployment) {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > MAX_CANONICAL_INPUT_BYTES
  ) {
    throw new Error("Gateway receipt bytes are missing or excessive");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Gateway receipt is not JSON");
  }
  const receipt = validateGatewayReceipt(value, deployment);
  const canonical = canonicalJson(receipt);
  if (canonical !== text) throw new Error("Gateway receipt is not exact canonical JSON");
  return deepFreeze({
    receipt,
    canonicalJson: canonical,
    digest: sha256(Buffer.from(canonical, "utf8")),
  });
}

export function canonicalJson(value) {
  const seen = new Set();
  return canonicalValue(value, seen);
}

function validateGatewayContract(value) {
  const root = asRecord(value, "gateway contract");
  exactKeys(root, [
    "schemaVersion",
    "profile",
    "jobId",
    "plan",
    "egressPolicyDigest",
    "gatewayRuntimeDigest",
    "runnerUid",
    "gatewayUid",
    "listener",
    "origin",
  ], "gateway contract");
  if (root.schemaVersion !== 1 || root.profile !== GATEWAY_PROFILE) {
    throw new Error("Gateway contract version or profile is unsupported");
  }
  const jobId = exactPattern(root.jobId, JOB_ID, "gateway job id");
  const runnerUid = uid(root.runnerUid, "runner UID");
  const gatewayUid = uid(root.gatewayUid, "gateway UID");
  if (runnerUid === gatewayUid) throw new Error("Runner and gateway UIDs must be different");

  const planRoot = asRecord(root.plan, "gateway plan binding");
  exactKeys(planRoot, ["digest", "createdAt", "expiresAt"], "gateway plan binding");
  const plan = {
    digest: digest(planRoot.digest, "plan digest"),
    createdAt: timestamp(planRoot.createdAt, "plan creation time"),
    expiresAt: timestamp(planRoot.expiresAt, "plan expiry"),
  };
  if (
    plan.expiresAt - plan.createdAt < MIN_PLAN_TTL_MS ||
    plan.expiresAt - plan.createdAt > MAX_PLAN_TTL_MS
  ) {
    throw new Error("Gateway contract plan lifetime is invalid");
  }

  return deepFreeze({
    schemaVersion: 1,
    profile: GATEWAY_PROFILE,
    jobId,
    plan,
    egressPolicyDigest: digest(root.egressPolicyDigest, "egress policy digest"),
    gatewayRuntimeDigest: digest(root.gatewayRuntimeDigest, "gateway runtime digest"),
    runnerUid,
    gatewayUid,
    listener: validateListener(root.listener),
    origin: validateOrigin(root.origin, plan),
  });
}

function validateListener(value) {
  const root = asRecord(value, "gateway listener");
  exactKeys(root, ["addresses", "port"], "gateway listener");
  if (
    !Array.isArray(root.addresses) ||
    root.addresses.length !== LOOPBACK_ADDRESSES.length ||
    root.addresses.some((address, index) => address !== LOOPBACK_ADDRESSES[index])
  ) {
    throw new Error("Gateway listener must use the fixed IPv4 and IPv6 loopback addresses");
  }
  return {
    addresses: [...LOOPBACK_ADDRESSES],
    port: integerInRange(root.port, 1024, 65_535, "gateway listener port"),
  };
}

function validateOrigin(value, plan) {
  const root = asRecord(value, "gateway origin");
  exactKeys(root, [
    "host",
    "port",
    "addresses",
    "resolutionEvidenceDigest",
    "resolutionObservedAt",
    "resolutionExpiresAt",
  ], "gateway origin");
  if (root.host !== "registry.npmjs.org" || root.port !== 443) {
    throw new Error("Gateway origin must be exactly registry.npmjs.org:443");
  }
  if (!Array.isArray(root.addresses) || root.addresses.length < 1 || root.addresses.length > 32) {
    throw new Error("Gateway origin requires one to 32 exact IP addresses");
  }
  const addresses = root.addresses.map((address) => globalIp(address)).sort();
  if (new Set(addresses).size !== addresses.length) {
    throw new Error("Gateway origin address set contains duplicates");
  }
  const resolutionObservedAt = timestamp(root.resolutionObservedAt, "resolution observation time");
  const resolutionExpiresAt = timestamp(root.resolutionExpiresAt, "resolution expiry");
  if (
    resolutionObservedAt > plan.createdAt ||
    plan.createdAt - resolutionObservedAt > MAX_RESOLUTION_AGE_MS ||
    resolutionExpiresAt < plan.expiresAt ||
    resolutionExpiresAt <= resolutionObservedAt ||
    resolutionExpiresAt - resolutionObservedAt > MAX_RESOLUTION_TTL_MS
  ) {
    throw new Error("Gateway origin resolution evidence is stale or unbounded");
  }
  return {
    host: "registry.npmjs.org",
    port: 443,
    addresses,
    resolutionEvidenceDigest: digest(
      root.resolutionEvidenceDigest,
      "resolution evidence digest"
    ),
    resolutionObservedAt,
    resolutionExpiresAt,
  };
}

function buildEnvoyConfig(contract) {
  const suffix = jobSuffix(contract.jobId);
  const clusterName = `npm_registry_static_${suffix}`;
  const filterChain = () => ({
    name: `npm_registry_exact_sni_${suffix}`,
    filter_chain_match: {
      server_names: ["registry.npmjs.org"],
      transport_protocol: "tls",
    },
    filters: [{
      name: "envoy.filters.network.tcp_proxy",
      typed_config: {
        "@type": "type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy",
        access_log: [{
          name: "envoy.access_loggers.file",
          typed_config: {
            "@type": "type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog",
            path: "/dev/stdout",
            log_format: {
              json_format: {
                bytes_received: "%BYTES_RECEIVED%",
                bytes_sent: "%BYTES_SENT%",
                connection_termination_details: "%CONNECTION_TERMINATION_DETAILS%",
                job_id: contract.jobId,
                requested_server_name: "%REQUESTED_SERVER_NAME%",
                response_flags: "%RESPONSE_FLAGS%",
                start_time: "%START_TIME%",
                upstream_host: "%UPSTREAM_HOST%",
              },
            },
          },
        }],
        cluster: clusterName,
        max_early_data_bytes: 65_536,
        stat_prefix: `api_migrator_npm_${suffix}`,
        upstream_connect_mode: "ON_DOWNSTREAM_DATA",
      },
    }],
  });

  return deepFreeze({
    static_resources: {
      clusters: [{
        name: clusterName,
        type: "STATIC",
        connect_timeout: "10s",
        lb_policy: "ROUND_ROBIN",
        load_assignment: {
          cluster_name: clusterName,
          endpoints: [{
            lb_endpoints: contract.origin.addresses.map((address) => ({
              endpoint: {
                address: {
                  socket_address: {
                    address,
                    port_value: 443,
                    protocol: "TCP",
                  },
                },
              },
            })),
          }],
        },
      }],
      listeners: contract.listener.addresses.map((address, index) => ({
        name: `api_migrator_gateway_${index === 0 ? "v4" : "v6"}_${suffix}`,
        address: {
          socket_address: {
            address,
            port_value: contract.listener.port,
            protocol: "TCP",
          },
        },
        listener_filters: [{
          name: "envoy.filters.listener.tls_inspector",
          typed_config: {
            "@type": "type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector",
          },
        }],
        // Intentionally no default filter chain: plaintext, missing SNI, and
        // every non-exact SNI are closed without an upstream connection.
        filter_chains: [filterChain()],
      })),
    },
  });
}

function buildNftablesPolicy(contract, table) {
  const template = readFileSync(
    new URL("./templates/forced-gateway-egress.nft.in", import.meta.url),
    "utf8"
  );
  const ipv4 = contract.origin.addresses.filter((address) => isIP(address) === 4);
  const ipv6 = contract.origin.addresses.filter((address) => isIP(address) === 6);
  const replacements = new Map([
    ["@TABLE@", table],
    ["@RUNNER_UID@", String(contract.runnerUid)],
    ["@GATEWAY_UID@", String(contract.gatewayUid)],
    ["@GATEWAY_PORT@", String(contract.listener.port)],
    ["@UPSTREAM_V4_ELEMENTS@", renderSetElements(ipv4)],
    ["@UPSTREAM_V6_ELEMENTS@", renderSetElements(ipv6)],
  ]);
  let rendered = template;
  for (const [placeholder, replacement] of replacements) {
    rendered = rendered.replaceAll(placeholder, replacement);
  }
  if (/@[A-Z0-9_]+@/.test(rendered)) {
    throw new Error("Gateway nftables template contains an unresolved placeholder");
  }
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

function renderSetElements(addresses) {
  return addresses.length === 0
    ? "    # Intentionally empty: this address family was not present in the bound DNS answer."
    : `    elements = { ${addresses.join(", ")} }`;
}

function validateEvidence(value, name) {
  const root = asRecord(value, `${name} evidence`);
  exactKeys(root, ["status", "reference", "digest"], `${name} evidence`);
  if (root.status !== "passed") throw new Error(`Gateway ${name} evidence did not pass`);
  return {
    status: "passed",
    reference: exactPattern(root.reference, EVIDENCE_REFERENCE, `${name} evidence reference`),
    digest: digest(root.digest, `${name} evidence digest`),
  };
}

function tableName(jobId) {
  return `api_migrator_gw_${jobSuffix(jobId)}`;
}

function jobSuffix(jobId) {
  return jobId.slice("previewjob_".length, "previewjob_".length + 16);
}

function globalIp(value) {
  if (typeof value !== "string" || value.length > 64 || value.includes("%") || value.includes("/")) {
    throw new Error("Gateway origin address is not an exact IP literal");
  }
  const version = isIP(value);
  if (version === 0 || canonicalIp(value) !== value || !isGlobalUnicast(value)) {
    throw new Error("Gateway origin address must be canonical global unicast");
  }
  return value;
}

function canonicalIp(value) {
  if (isIP(value) === 4) return value.split(".").map((part) => String(Number(part))).join(".");
  if (isIP(value) !== 6) return "";
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : "";
  } catch {
    return "";
  }
}

function isGlobalUnicast(value) {
  if (isIP(value) === 4) {
    const [first, second, third] = value.split(".").map(Number);
    return !(
      first === 0 || first === 10 || first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  if (isIP(value) !== 6 || value.includes(".")) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":").map((part) => Number.parseInt(part, 16)) : [];
  const right = halves[1] ? halves[1].split(":").map((part) => Number.parseInt(part, 16)) : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) return false;
  const words = halves.length === 2
    ? [...left, ...Array(omitted).fill(0), ...right]
    : left;
  if (words.length !== 8) return false;
  const [first, second, third] = words;
  return (
    first >= 0x2000 && first <= 0x3ffe &&
    !(first === 0x2001 && second <= 0x01ff) &&
    !(first === 0x2001 && second === 0x0db8) &&
    !(first === 0x2001 && second === 0x0002 && third === 0) &&
    first !== 0x2002
  );
}

function canonicalValue(value, seen) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicode(value, "canonical string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Canonical JSON permits only safe integers");
    return String(value);
  }
  if (typeof value !== "object") throw new Error("Canonical JSON contains an unsupported value");
  if (seen.has(value)) throw new Error("Canonical JSON contains a cycle");
  seen.add(value);
  let rendered;
  if (Array.isArray(value)) {
    rendered = `[${value.map((entry) => canonicalValue(entry, seen)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical JSON object has an unsupported prototype");
    }
    rendered = `{${Object.keys(value).sort().map((key) => {
      assertUnicode(key, "canonical key");
      return `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`;
    }).join(",")}}`;
  }
  seen.delete(value);
  return rendered;
}

function asRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an unsupported prototype`);
  }
  return value;
}

function exactKeys(root, expected, label) {
  const actual = Object.keys(root).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} contains missing or unexpected fields`);
  }
}

function exactPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function digest(value, label) {
  return exactPattern(value, SHA256, label);
}

function uid(value, label) {
  return integerInRange(value, 1, 4_294_967_294, label);
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  return integerInRange(value, 1, MAX_TIMESTAMP, label);
}

function assertUnicode(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${label} has invalid Unicode`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} has invalid Unicode`);
    }
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function readCanonicalInput(path, label) {
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_CANONICAL_INPUT_BYTES) {
    throw new Error(`${label} exceeds the supported size`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  if (canonicalJson(value) !== text) throw new Error(`${label} is not exact canonical JSON`);
  return { text, value };
}

function usage() {
  throw new Error(
    "usage: gateway-contract.mjs <render-envoy|render-nft|render-record> CONTRACT.json " +
    "or gateway-contract.mjs validate-receipt CONTRACT.json RECEIPT.json"
  );
}

function cli(argv) {
  const [command, contractPath, receiptPath] = argv;
  if (!command || !contractPath) usage();
  const parsed = readCanonicalInput(contractPath, "gateway contract");
  const deployment = renderGatewayDeployment(parsed.value);
  if (deployment.canonicalJson !== parsed.text) {
    throw new Error("Gateway contract is not normalized canonical JSON");
  }
  if (command === "render-envoy" && receiptPath === undefined) {
    process.stdout.write(deployment.envoyConfigJson);
    return;
  }
  if (command === "render-nft" && receiptPath === undefined) {
    process.stdout.write(deployment.nftablesPolicy);
    return;
  }
  if (command === "render-record" && receiptPath === undefined) {
    process.stdout.write(canonicalJson({
      contractDigest: deployment.digest,
      envoyConfigDigest: deployment.envoyConfigDigest,
      jobId: deployment.contract.jobId,
      nftablesPolicyDigest: deployment.nftablesPolicyDigest,
      nftablesTable: deployment.nftablesTable,
      profile: GATEWAY_PROFILE,
      schemaVersion: 1,
    }));
    return;
  }
  if (command === "validate-receipt" && receiptPath !== undefined) {
    const receiptText = readFileSync(receiptPath, "utf8");
    const verified = parseCanonicalGatewayReceipt(receiptText, deployment);
    process.stdout.write(canonicalJson({
      gatewayReceiptDigest: verified.digest,
      jobId: verified.receipt.jobId,
      observedAt: verified.receipt.observedAt,
      status: "passed",
    }));
    return;
  }
  usage();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`gateway contract refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
