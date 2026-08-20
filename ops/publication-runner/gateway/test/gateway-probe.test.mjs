import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  GATEWAY_PROBE_SCENARIOS,
  buildGatewayProbeSpecification,
  expectConnectionDenied,
  expectPlaintextRejection,
  runGatewayProbe,
} from "../gateway-probe.mjs";

const CONTRACT_PATH = new URL("../examples/gateway-contract.example.json", import.meta.url);
const PROBE_PATH = new URL("../gateway-probe.mjs", import.meta.url);

function contractFixture() {
  return JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
}

function activeContractFixture() {
  const contract = contractFixture();
  const now = Date.now();
  contract.plan.createdAt = now - 1_000;
  contract.plan.expiresAt = now + 60_000;
  contract.origin.resolutionObservedAt = now - 2_000;
  contract.origin.resolutionExpiresAt = now + 120_000;
  return contract;
}

test("derives only fixed numeric-address gateway probes", () => {
  const expected = {
    correct_sni: [12001, "tls", "127.0.0.1", 15443, "registry.npmjs.org", "https_ping_passed"],
    correct_sni_ipv6: [12001, "tls", "::1", 15443, "registry.npmjs.org", "https_ping_passed"],
    direct_bypass: [12001, "tls", "104.16.1.35", 443, "registry.npmjs.org", "https_ping_passed"],
    wrong_sni: [12001, "tls", "127.0.0.1", 15443, "wrong-sni.invalid", "connection_denied"],
    absent_sni: [12001, "tls", "127.0.0.1", 15443, null, "connection_denied"],
    plaintext: [12001, "tcp", "127.0.0.1", 15443, null, "plaintext_rejected"],
    non_443: [12001, "tcp", "104.16.1.35", 80, null, "connection_denied"],
    non_npm: [12002, "tcp", "1.1.1.1", 443, null, "connection_denied"],
    offline_network: [12001, "tcp", "104.16.1.35", 443, null, "connection_denied"],
  };
  assert.deepEqual(GATEWAY_PROBE_SCENARIOS, Object.keys(expected));
  for (const scenario of GATEWAY_PROBE_SCENARIOS) {
    const spec = buildGatewayProbeSpecification(contractFixture(), scenario);
    assert.deepEqual(
      [spec.transport, spec.address, spec.port, spec.servername, spec.expected],
      expected[scenario].slice(1)
    );
    assert.equal(spec.executionUid, expected[scenario][0]);
    assert.match(spec.contractDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(spec.jobId, contractFixture().jobId);
    assert.equal(spec.planCreatedAt, contractFixture().plan.createdAt);
    assert.equal(spec.planExpiresAt, contractFixture().plan.expiresAt);
    assert(Object.isFrozen(spec));
  }
});

test("wrong and absent SNI denial proves the exact listener was reached", async () => {
  const closedServer = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    closedServer.once("error", rejectPromise);
    closedServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const closedAddress = closedServer.address();
  assert(closedAddress && typeof closedAddress === "object");
  await new Promise((resolvePromise) => closedServer.close(resolvePromise));
  await assert.rejects(
    expectConnectionDenied({
      scenario: "wrong_sni",
      transport: "tls",
      address: "127.0.0.1",
      port: closedAddress.port,
      servername: "wrong-sni.invalid",
    }, 500),
    /before reaching|never reached/
  );

  const sockets = new Set();
  const rejectingServer = createServer((socket) => {
    sockets.add(socket);
    socket.end();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    rejectingServer.once("error", rejectPromise);
    rejectingServer.listen(0, "127.0.0.1", resolvePromise);
  });
  try {
    const address = rejectingServer.address();
    assert(address && typeof address === "object");
    await assert.doesNotReject(() => expectConnectionDenied({
      scenario: "absent_sni",
      transport: "tls",
      address: "127.0.0.1",
      port: address.port,
      servername: null,
    }, 500));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolvePromise) => rejectingServer.close(resolvePromise));
  }
});

test("probe specifications cannot broaden the gateway contract", async () => {
  const wrongOrigin = contractFixture();
  wrongOrigin.origin.host = "example.com";
  assert.throws(
    () => buildGatewayProbeSpecification(wrongOrigin, "correct_sni"),
    /origin must be exactly/
  );
  assert.throws(
    () => buildGatewayProbeSpecification(contractFixture(), "arbitrary"),
    /unsupported/
  );

  const forgedJob = contractFixture();
  forgedJob.jobId = `forgedjob_${"1".repeat(64)}`;
  await assert.rejects(
    runGatewayProbe(forgedJob, "correct_sni", { timeoutMs: 1_000 }),
    /job id is invalid/
  );
  await assert.rejects(
    runGatewayProbe(contractFixture(), "correct_sni", { timeoutMs: 99 }),
    /timeout is unsupported/
  );
  const wrongIdentity = activeContractFixture();
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 0;
  wrongIdentity.runnerUid = currentUid + 1 === wrongIdentity.gatewayUid
    ? currentUid + 2
    : currentUid + 1;
  await assert.rejects(
    runGatewayProbe(wrongIdentity, "correct_sni", { timeoutMs: 1_000 }),
    /wrong dedicated identity/
  );
});

test("non-npm probes always use a bounded destination outside the exact origin set", () => {
  const oneCollision = contractFixture();
  oneCollision.origin.addresses.push("1.1.1.1");
  assert.equal(buildGatewayProbeSpecification(oneCollision, "non_npm").address, "8.8.8.8");

  const allCollide = contractFixture();
  allCollide.origin.addresses = ["1.1.1.1", "8.8.8.8", "9.9.9.9", "208.67.222.222"];
  assert.throws(
    () => buildGatewayProbeSpecification(allCollide, "non_npm"),
    /no independent non-npm destination/
  );
});

test("probes refuse contracts before creation and at or after expiry", async () => {
  const now = Date.now();
  for (const contract of [
    Object.assign(activeContractFixture(), {
      plan: { ...activeContractFixture().plan, createdAt: now - 120_000, expiresAt: now - 60_000 },
      origin: {
        ...activeContractFixture().origin,
        resolutionObservedAt: now - 121_000,
        resolutionExpiresAt: now - 60_000,
      },
    }),
    Object.assign(activeContractFixture(), {
      plan: { ...activeContractFixture().plan, createdAt: now + 60_000, expiresAt: now + 120_000 },
      origin: {
        ...activeContractFixture().origin,
        resolutionObservedAt: now,
        resolutionExpiresAt: now + 180_000,
      },
    }),
  ]) {
    await assert.rejects(
      runGatewayProbe(contract, "correct_sni", { timeoutMs: 1_000 }),
      /outside its active plan lifetime/
    );
  }
});

test("a silent plaintext peer cannot convert the fixed deadline into a pass", async () => {
  const sockets = new Set();
  const server = createServer((socket) => sockets.add(socket));
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    await assert.rejects(
      expectPlaintextRejection({ address: "127.0.0.1", port: address.port }, 100),
      /did not close before its fixed deadline/
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("CLI refuses noncanonical contract bytes before opening a probe socket", () => {
  const result = spawnSync(process.execPath, [
    PROBE_PATH.pathname,
    "--scenario",
    "correct_sni",
    CONTRACT_PATH.pathname,
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contract is not exact canonical JSON/);
  assert.equal(result.stdout, "");
});

test("the positive probe uses a fixed wall-clock deadline, not a refreshable socket timeout", () => {
  const source = readFileSync(PROBE_PATH, "utf8");
  const positive = source.slice(
    source.indexOf("function expectHttpsPing"),
    source.indexOf("function expectConnectionDenied")
  );
  assert.match(positive, /const deadline = setTimeout/);
  assert.match(positive, /clearTimeout\(deadline\)/);
  assert.doesNotMatch(positive, /socket\.setTimeout/);
});
