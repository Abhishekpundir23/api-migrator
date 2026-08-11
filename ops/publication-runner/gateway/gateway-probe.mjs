#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { connect as connectTcp, isIP } from "node:net";
import { resolve } from "node:path";
import { connect as connectTls } from "node:tls";
import { fileURLToPath } from "node:url";

import {
  GATEWAY_PROFILE,
  canonicalJson,
  renderGatewayDeployment,
} from "./gateway-contract.mjs";

export const GATEWAY_PROBE_SCENARIOS = Object.freeze([
  "correct_sni",
  "direct_bypass",
  "wrong_sni",
  "absent_sni",
  "plaintext",
  "non_443",
  "non_npm",
  "offline_network",
]);

const NON_NPM_CANDIDATE_ADDRESSES = Object.freeze([
  "1.1.1.1",
  "8.8.8.8",
  "9.9.9.9",
  "208.67.222.222",
]);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_CONTRACT_BYTES = 128 * 1024;

/**
 * Derive a fixed probe from the exact gateway contract. No hostname is ever
 * resolved by this process; every connection target is a numeric literal.
 */
export function buildGatewayProbeSpecification(contractValue, scenario) {
  if (!GATEWAY_PROBE_SCENARIOS.includes(scenario)) {
    throw new Error("Gateway probe scenario is unsupported");
  }
  const deployment = renderGatewayDeployment(contractValue);
  const contract = deployment.contract;
  const address = preferredAddress(contract.origin.addresses);
  const loopbackAddress = contract.listener.addresses[0];
  const base = {
    schemaVersion: 1,
    kind: "api_migrator_gateway_probe_specification",
    profile: GATEWAY_PROFILE,
    jobId: contract.jobId,
    planDigest: contract.plan.digest,
    planCreatedAt: contract.plan.createdAt,
    planExpiresAt: contract.plan.expiresAt,
    contractDigest: deployment.digest,
    scenario,
    executionUid: contract.runnerUid,
  };

  switch (scenario) {
    case "correct_sni":
      return Object.freeze({
        ...base,
        transport: "tls",
        address: loopbackAddress,
        port: contract.listener.port,
        servername: contract.origin.host,
        expected: "https_ping_passed",
      });
    case "direct_bypass":
      return Object.freeze({
        ...base,
        transport: "tls",
        address,
        port: contract.origin.port,
        servername: contract.origin.host,
        expected: "https_ping_passed",
      });
    case "wrong_sni":
      return Object.freeze({
        ...base,
        transport: "tls",
        address: loopbackAddress,
        port: contract.listener.port,
        servername: "wrong-sni.invalid",
        expected: "connection_denied",
      });
    case "absent_sni":
      return Object.freeze({
        ...base,
        transport: "tls",
        address: loopbackAddress,
        port: contract.listener.port,
        servername: null,
        expected: "connection_denied",
      });
    case "plaintext":
      return Object.freeze({
        ...base,
        transport: "tcp",
        address: loopbackAddress,
        port: contract.listener.port,
        servername: null,
        expected: "plaintext_rejected",
      });
    case "non_443":
      return Object.freeze({
        ...base,
        transport: "tcp",
        address,
        port: 80,
        servername: null,
        expected: "connection_denied",
      });
    case "non_npm":
      return Object.freeze({
        ...base,
        executionUid: contract.gatewayUid,
        transport: "tcp",
        address: nonNpmAddress(contract.origin.addresses),
        port: 443,
        servername: null,
        expected: "connection_denied",
      });
    case "offline_network":
      return Object.freeze({
        ...base,
        transport: "tcp",
        address,
        port: 443,
        servername: null,
        expected: "connection_denied",
      });
  }
  throw new Error("Gateway probe scenario is unsupported");
}

export async function runGatewayProbe(contractValue, scenario, options = {}) {
  const spec = validateSpecification(buildGatewayProbeSpecification(contractValue, scenario));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("Gateway probe timeout is unsupported");
  }
  const startedAt = Date.now();
  if (startedAt < spec.planCreatedAt || startedAt >= spec.planExpiresAt) {
    throw new Error("Gateway probe contract is outside its active plan lifetime");
  }
  const remainingMs = spec.planExpiresAt - startedAt;
  if (remainingMs < 100) {
    throw new Error("Gateway probe has insufficient remaining plan lifetime");
  }
  if (typeof process.getuid !== "function" || process.getuid() !== spec.executionUid) {
    throw new Error("Gateway probe is running under the wrong dedicated identity");
  }
  const boundedTimeoutMs = Math.min(timeoutMs, remainingMs);

  if (spec.expected === "https_ping_passed") {
    await expectHttpsPing(spec, boundedTimeoutMs);
  } else if (spec.expected === "plaintext_rejected") {
    await expectPlaintextRejection(spec, boundedTimeoutMs);
  } else {
    await expectConnectionDenied(spec, boundedTimeoutMs);
  }
  const observedAt = Date.now();
  if (observedAt < startedAt || observedAt >= spec.planExpiresAt) {
    throw new Error("Gateway probe did not finish inside the active plan lifetime");
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: "api_migrator_gateway_probe_result",
    profile: GATEWAY_PROFILE,
    jobId: spec.jobId,
    planDigest: spec.planDigest,
    contractDigest: spec.contractDigest,
    scenario: spec.scenario,
    status: "passed",
    observedAt,
  });
}

function nonNpmAddress(originAddresses) {
  const origin = new Set(originAddresses);
  const candidate = NON_NPM_CANDIDATE_ADDRESSES.find((address) => !origin.has(address));
  if (!candidate) {
    throw new Error("Gateway probe has no independent non-npm destination");
  }
  return candidate;
}

function preferredAddress(addresses) {
  const address = addresses.find((value) => isIP(value) === 4) ?? addresses[0];
  if (typeof address !== "string" || isIP(address) === 0) {
    throw new Error("Gateway probe requires an exact numeric origin address");
  }
  return address;
}

function validateSpecification(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gateway probe specification must be an object");
  }
  const expectedKeys = [
    "schemaVersion", "kind", "profile", "jobId", "planDigest", "contractDigest",
    "planCreatedAt", "planExpiresAt", "scenario", "executionUid", "transport", "address", "port", "servername", "expected",
  ];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0") ||
      value.schemaVersion !== 1 || value.kind !== "api_migrator_gateway_probe_specification" ||
      value.profile !== GATEWAY_PROFILE || !GATEWAY_PROBE_SCENARIOS.includes(value.scenario) ||
      !/^previewjob_[a-f0-9]{64}$/.test(value.jobId) ||
      !/^sha256:[a-f0-9]{64}$/.test(value.planDigest) ||
      !/^sha256:[a-f0-9]{64}$/.test(value.contractDigest) ||
      !Number.isSafeInteger(value.planCreatedAt) || value.planCreatedAt <= 0 ||
      !Number.isSafeInteger(value.planExpiresAt) || value.planExpiresAt <= value.planCreatedAt ||
      !Number.isSafeInteger(value.executionUid) || value.executionUid < 1 ||
      !new Set(["tls", "tcp"]).has(value.transport) || isIP(value.address) === 0 ||
      !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 ||
      !(value.servername === null || value.servername === "registry.npmjs.org" ||
        value.servername === "wrong-sni.invalid") ||
      !new Set(["https_ping_passed", "connection_denied", "plaintext_rejected"]).has(value.expected)) {
    throw new Error("Gateway probe specification is invalid or weakened");
  }
  return value;
}

function expectHttpsPing(spec, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let response = Buffer.alloc(0);
    const socket = connectTls({
      host: spec.address,
      port: spec.port,
      servername: spec.servername,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) rejectPromise(error); else resolvePromise();
    };
    // A socket idle timeout can be extended indefinitely by a trickle peer.
    // Use a wall-clock deadline that cannot be refreshed by network activity.
    const deadline = setTimeout(
      () => finish(new Error("Gateway positive probe exceeded its fixed deadline")),
      timeoutMs
    );
    socket.once("error", () => finish(new Error("Gateway positive probe was denied")));
    socket.once("secureConnect", () => {
      if (!socket.authorized || socket.alpnProtocol !== "http/1.1") {
        finish(new Error("Gateway positive probe did not establish the pinned TLS policy"));
        return;
      }
      socket.write(
        "GET /-/ping HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n"
      );
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 16 * 1024) finish(new Error("Gateway positive probe response is excessive"));
    });
    socket.once("end", () => {
      const line = response.toString("latin1").split("\r\n", 1)[0] ?? "";
      finish(/^HTTP\/1\.[01] 200(?: |$)/.test(line)
        ? undefined
        : new Error("Gateway positive probe returned an unexpected response"));
    });
    socket.once("close", () => {
      if (!settled) finish(new Error("Gateway positive probe closed before a complete response"));
    });
  });
}

function expectConnectionDenied(spec, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let connected = false;
    const socket = spec.transport === "tls"
      ? connectTls({
          host: spec.address,
          port: spec.port,
          ...(spec.servername === null ? {} : { servername: spec.servername }),
          rejectUnauthorized: false,
        })
      : connectTcp({ host: spec.address, port: spec.port });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (connected) rejectPromise(new Error("Gateway negative probe remained connected"));
      else resolvePromise();
    }, timeoutMs);
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error); else resolvePromise();
    };
    socket.once(spec.transport === "tls" ? "secureConnect" : "connect", () => {
      connected = true;
      done(new Error("Gateway negative probe unexpectedly connected"));
    });
    socket.once("error", () => done());
    socket.once("close", () => {
      if (!connected) done();
    });
  });
}

// Exported for deterministic loopback transport tests. This raw helper does
// not construct a probe result and is never authorization evidence by itself.
export function expectPlaintextRejection(spec, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let connected = false;
    let received = false;
    const socket = connectTcp({ host: spec.address, port: spec.port });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectPromise(new Error("Gateway plaintext probe did not close before its fixed deadline"));
    }, timeoutMs);
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error); else resolvePromise();
    };
    socket.once("connect", () => {
      connected = true;
      socket.write("GET / HTTP/1.0\r\n\r\n");
    });
    socket.once("data", () => {
      received = true;
      done(new Error("Gateway plaintext probe unexpectedly received data"));
    });
    socket.once("error", () => done(
      connected && !received
        ? undefined
        : new Error("Gateway plaintext probe was denied before reaching the exact listener")
    ));
    socket.once("close", () => done(
      connected && !received
        ? undefined
        : new Error("Gateway plaintext probe closed without proving listener rejection")
    ));
  });
}

function parseArguments(argv) {
  if (argv.length !== 3 || argv[0] !== "--scenario" || argv[2] === undefined) {
    throw new Error("usage: gateway-probe.mjs --scenario NAME CONTRACT.json");
  }
  const scenario = argv[1];
  if (!GATEWAY_PROBE_SCENARIOS.includes(scenario)) {
    throw new Error("Gateway probe scenario is unsupported");
  }
  return { scenario, contractPath: resolve(argv[2]) };
}

async function main() {
  const { scenario, contractPath } = parseArguments(process.argv.slice(2));
  const text = readFileSync(contractPath, "utf8");
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_CONTRACT_BYTES) {
    throw new Error("Gateway probe contract bytes are missing or excessive");
  }
  const value = JSON.parse(text);
  if (canonicalJson(value) !== text) {
    throw new Error("Gateway probe contract is not exact canonical JSON");
  }
  const result = await runGatewayProbe(value, scenario);
  process.stdout.write(`${canonicalJson(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`gateway probe refused: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
