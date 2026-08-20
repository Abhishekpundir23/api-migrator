import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GATEWAY_PROFILE,
  canonicalJson,
  parseCanonicalGatewayReceipt,
  renderGatewayDeployment,
  validateGatewayDeploymentRecord,
  validateGatewayReceipt,
  validateRenderedEnvoyConfig,
  validateRenderedNftablesPolicy,
} from "../gateway-contract.mjs";

const CONTRACT_PATH = new URL("../examples/gateway-contract.example.json", import.meta.url);
const RECEIPT_PATH = new URL("../examples/gateway-receipt.example.json", import.meta.url);
const SCHEMA_PATH = new URL("../schemas/gateway-receipt.schema.json", import.meta.url);

function contractFixture() {
  return JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
}

function receiptFixture() {
  return JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
}

test("renders only static exact-SNI Envoy listeners and numeric upstream endpoints", () => {
  const deployment = renderGatewayDeployment(contractFixture());
  const config = deployment.envoyConfig;
  assert.equal(config.admin, undefined);
  assert.equal(config.dynamic_resources, undefined);
  assert.equal(config.static_resources.listeners.length, 2);
  assert.equal(config.static_resources.clusters.length, 1);

  const cluster = config.static_resources.clusters[0];
  assert.equal(cluster.type, "STATIC");
  assert.equal(cluster.transport_socket, undefined);
  assert.deepEqual(
    cluster.load_assignment.endpoints[0].lb_endpoints.map(
      (endpoint) => endpoint.endpoint.address.socket_address.address
    ),
    ["104.16.1.35", "2606:4700::6810:123"]
  );
  assert(cluster.load_assignment.endpoints[0].lb_endpoints.every(
    (endpoint) => endpoint.endpoint.address.socket_address.port_value === 443
  ));

  for (const listener of config.static_resources.listeners) {
    assert.equal(listener.listener_filters.length, 1);
    assert.equal(listener.listener_filters[0].name, "envoy.filters.listener.tls_inspector");
    assert.equal(listener.filter_chains.length, 1, "there must be no default chain");
    const chain = listener.filter_chains[0];
    assert.deepEqual(chain.filter_chain_match, {
      server_names: ["registry.npmjs.org"],
      transport_protocol: "tls",
    });
    assert.equal(chain.transport_socket, undefined, "TLS must remain end-to-end");
    const proxy = chain.filters[0].typed_config;
    assert.equal(proxy.cluster, cluster.name);
    assert.equal(proxy.upstream_connect_mode, "ON_DOWNSTREAM_DATA");
    assert.equal(proxy.access_log[0].name, "envoy.access_loggers.stdout");
    assert.equal(
      proxy.access_log[0].typed_config["@type"],
      "type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog"
    );
    assert.equal(proxy.access_log[0].typed_config.path, undefined);
  }
  assert.deepEqual(validateRenderedEnvoyConfig(config, deployment), config);
  assert.equal(deployment.contract.profile, GATEWAY_PROFILE);
  assert(Object.isFrozen(deployment.envoyConfig));
});

test("renders a forced two-identity nftables route with no runner direct path", () => {
  const deployment = renderGatewayDeployment(contractFixture());
  const policy = deployment.nftablesPolicy;
  assert.match(
    policy,
    /meta skuid 12001 meta l4proto tcp tcp dport 443 counter redirect to :15443/
  );
  assert.match(policy, /meta skuid 12001 ip daddr 127\.0\.0\.1 tcp dport 15443/);
  assert.match(policy, /meta skuid 12001 ip6 daddr ::1 tcp dport 15443/);
  assert.match(policy, /meta skuid 12001 counter reject/);
  assert.match(policy, /meta skuid 12002 ip daddr @npm_upstream_v4 tcp dport 443/);
  assert.match(policy, /meta skuid 12002 ip6 daddr @npm_upstream_v6 tcp dport 443/);
  assert.match(policy, /meta skuid 12002 counter reject/);
  assert.match(policy, /elements = \{ 104\.16\.1\.35 \}/);
  assert.match(policy, /elements = \{ 2606:4700::6810:123 \}/);
  assert.doesNotMatch(policy, /meta skuid 12001 ip daddr @npm_upstream/);
  assert.equal(validateRenderedNftablesPolicy(policy, deployment), policy);
});

test("renders a valid empty nftables set when DNS returns only one address family", () => {
  for (const [name, addresses, emptyFamily] of [
    ["IPv4 only", ["104.16.1.35"], "v6"],
    ["IPv6 only", ["2606:4700::6810:123"], "v4"],
  ]) {
    const contract = contractFixture();
    contract.origin.addresses = addresses;
    const policy = renderGatewayDeployment(contract).nftablesPolicy;
    assert.doesNotMatch(policy, /elements = \{\s*\}/, name);
    assert.match(
      policy,
      new RegExp(`set npm_upstream_${emptyFamily} \\{[\\s\\S]*?Intentionally empty:[\\s\\S]*?\\n  \\}`),
      name
    );
  }
});

test("rejects gateway contracts that broaden identity, origin, address, or lifetime", () => {
  const cases = [
    ["same identity", (value) => { value.gatewayUid = value.runnerUid; }],
    ["wrong host", (value) => { value.origin.host = "evil.example"; }],
    ["wildcard host", (value) => { value.origin.host = "*.npmjs.org"; }],
    ["private IP", (value) => { value.origin.addresses = ["10.0.0.1"]; }],
    ["loopback IP", (value) => { value.origin.addresses = ["127.0.0.1"]; }],
    ["link-local IP", (value) => { value.origin.addresses = ["169.254.169.254"]; }],
    ["noncanonical IPv6", (value) => {
      value.origin.addresses = ["2606:4700:0:0:0:0:6810:123"];
    }],
    ["duplicate IP", (value) => {
      value.origin.addresses = ["104.16.1.35", "104.16.1.35"];
    }],
    ["listener broadened", (value) => { value.listener.addresses = ["0.0.0.0", "::"]; }],
    ["plan too short", (value) => { value.plan.expiresAt = value.plan.createdAt + 59_999; }],
    ["plan too long", (value) => { value.plan.expiresAt = value.plan.createdAt + 900_001; }],
    ["stale resolution", (value) => {
      value.origin.resolutionObservedAt = value.plan.createdAt - 300_001;
    }],
    ["unknown field", (value) => { value.allowDirectFallback = true; }],
  ];
  for (const [name, mutate] of cases) {
    const value = contractFixture();
    mutate(value);
    assert.throws(() => renderGatewayDeployment(value), undefined, name);
  }
});

test("rejects substituted Envoy, nftables, and deployment-record artifacts", () => {
  const deployment = renderGatewayDeployment(contractFixture());

  const dynamic = structuredClone(deployment.envoyConfig);
  dynamic.dynamic_resources = {};
  assert.throws(
    () => validateRenderedEnvoyConfig(dynamic, deployment),
    /unsupported or weakened/
  );

  const defaultChain = structuredClone(deployment.envoyConfig);
  defaultChain.static_resources.listeners[0].filter_chains.push({ filters: [] });
  assert.throws(
    () => validateRenderedEnvoyConfig(defaultChain, deployment),
    /unsupported or weakened/
  );

  const dns = structuredClone(deployment.envoyConfig);
  dns.static_resources.clusters[0].type = "STRICT_DNS";
  assert.throws(() => validateRenderedEnvoyConfig(dns, deployment), /unsupported or weakened/);

  assert.throws(
    () => validateRenderedNftablesPolicy(
      deployment.nftablesPolicy.replace("meta skuid 12001 counter reject", "meta skuid 12001 counter accept"),
      deployment
    ),
    /unsupported or weakened/
  );

  const substituted = structuredClone(deployment);
  substituted.envoyConfigDigest = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => validateGatewayDeploymentRecord(substituted),
    /substituted artifacts/
  );
});

test("validates the example receipt and exact canonical receipt bytes", () => {
  const deployment = renderGatewayDeployment(contractFixture());
  const receipt = validateGatewayReceipt(receiptFixture(), deployment);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.contractDigest, deployment.digest);
  assert(Object.isFrozen(receipt.evidence));

  const canonical = canonicalJson(receipt);
  const parsed = parseCanonicalGatewayReceipt(canonical, deployment);
  assert.deepEqual(parsed.receipt, receipt);
  assert.match(parsed.digest, /^sha256:[a-f0-9]{64}$/);
  assert.throws(
    () => parseCanonicalGatewayReceipt(`${canonical}\n`, deployment),
    /not exact canonical JSON/
  );
});

test("rejects self-asserted, drifted, failed, stale, and incomplete receipts", () => {
  const deployment = renderGatewayDeployment(contractFixture());
  const cases = [
    ["wrong contract", (value) => { value.contractDigest = `sha256:${"0".repeat(64)}`; }],
    ["wrong config", (value) => { value.envoyConfigDigest = `sha256:${"0".repeat(64)}`; }],
    ["wrong origin", (value) => { value.origin.addresses = ["104.16.1.36"]; }],
    ["failed evidence", (value) => { value.evidence.transportCounters.status = "failed"; }],
    ["missing drill", (value) => { delete value.evidence.deploymentDrill; }],
    ["early gateway stop", (value) => {
      value.execution.gatewayStoppedAt = value.execution.installFinishedAt - 1;
    }],
    ["runner still active", (value) => {
      value.teardown.runnerUidIdleAt = value.execution.gatewayStoppedAt - 1;
    }],
    ["incomplete teardown", (value) => { value.teardown.complete = false; }],
    ["observed after plan expiry", (value) => {
      value.observedAt = deployment.contract.plan.expiresAt;
    }],
    ["extra authorization", (value) => { value.signature = "self-asserted"; }],
  ];
  for (const [name, mutate] of cases) {
    const value = receiptFixture();
    mutate(value);
    assert.throws(() => validateGatewayReceipt(value, deployment), undefined, name);
  }
});

test("receipt schema is strict at the root, evidence, and teardown boundaries", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const validator = new Ajv2020({ allErrors: true, strict: true });
  const validate = validator.compile(schema);
  assert.equal(validate(receiptFixture()), true, validator.errorsText(validate.errors));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.evidence.additionalProperties, false);
  assert.equal(schema.properties.teardown.additionalProperties, false);
  assert.equal(schema.$defs.evidence.additionalProperties, false);
  assert.equal(schema.properties.kind.const, "api_migrator_l7_gateway_receipt");
  assert.equal(schema.properties.profile.const, GATEWAY_PROFILE);
});
