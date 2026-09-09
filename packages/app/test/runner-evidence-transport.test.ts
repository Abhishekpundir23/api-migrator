import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import http from "node:http";
import { Readable } from "node:stream";
import type { PeerCertificate } from "node:tls";
import type https from "node:https";
import { RunnerEvidenceError, type RunnerEvidenceFailureCode } from "../src/runner-evidence-contract.js";
import { createRunnerEvidenceDeadline } from "../src/runner-evidence-deadline.js";
import { createRunnerEvidenceTransport } from "../src/runner-evidence-transport.js";
import { tlsEvidenceFixture, rawTlsEvidenceFixture, type TlsEvidenceFixture } from "./helpers/runner-evidence-io-fixture.js";

const job = `previewjob_${"a".repeat(64)}`;
const budget = (milliseconds = 5_000) => createRunnerEvidenceDeadline({
  wallNow: () => Date.now(), monotonicNow: () => performance.now(),
}, Date.now() + milliseconds);

async function socketsClosed(fixture: TlsEvidenceFixture) {
  const until = Date.now() + 1_000;
  while (fixture.activeSockets() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fixture.activeSockets(), 0, "transport must close sockets before fixture cleanup");
}

async function exchange(fixture: TlsEvidenceFixture, code?: RunnerEvidenceFailureCode, milliseconds = 5_000, expected = "{}") {
  const deadline = budget(milliseconds);
  try {
    const pending = createRunnerEvidenceTransport(fixture.request)(fixture.config, job, deadline);
    if (code) await assert.rejects(pending, (error) => {
      assert.ok(error instanceof RunnerEvidenceError);
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      return true;
    });
    else assert.equal(await pending, expected);
    await socketsClosed(fixture);
    assert.equal(fixture.selectedOptions.length, 1, "no retries or redirect follow-up");
  } finally {
    deadline.close();
    await fixture.close();
  }
}

const wire = (headers: string, body: string | Buffer = "{}", status = "200 OK") => Buffer.concat([
  Buffer.from(`HTTP/1.1 ${status}\r\n${headers}\r\nConnection: close\r\n\r\n`), Buffer.from(body),
]);

test("TLS fixture gets only the exact job request and closes sockets", async () => {
  const fixture = await tlsEvidenceFixture('{"schemaVersion":1}');
  const deadline = budget();
  try {
    const text = await createRunnerEvidenceTransport(fixture.request)(fixture.config, job, deadline);
    assert.equal(text, '{"schemaVersion":1}');
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]!.method, "GET");
    assert.equal(fixture.requests[0]!.path, `/v1/runner-evidence/${job}`);
    assert.equal(fixture.requests[0]!.host, "evidence.example.invalid");
    assert.equal(fixture.requests[0]!.headers.authorization, undefined);
    assert.deepEqual(fixture.servernames, ["evidence.example.invalid"]);
    assert.deepEqual(fixture.requests[0]!.headers, {
      host: "evidence.example.invalid", connection: "close", accept: "application/json", "accept-encoding": "identity",
    });
    await socketsClosed(fixture);
  } finally {
    deadline.close();
    await fixture.close();
  }
  assert.equal(fixture.activeSockets(), 0);
});

test("IPv6 pinned endpoint is selected directly with unchanged SNI and fixed port", async () => {
  const fixture = await tlsEvidenceFixture("{}");
  fixture.config.serviceAddresses = ["2606:4700:4700::1111", "93.184.216.34"];
  await exchange(fixture);
  assert.equal(fixture.selectedOptions[0]!.hostname, "2606:4700:4700::1111");
});

for (const [name, options] of [
  ["untrusted CA", { untrustedCa: true }],
  ["wrong hostname with matching pin", { certificateHost: "wrong.example.invalid" }],
] as const) test(`native TLS rejects ${name} before HTTP`, async () => {
  const fixture = await rawTlsEvidenceFixture((socket) => socket.end(wire("Content-Type: application/json\r\nContent-Length: 2")), options);
  await exchange(fixture, "evidence_unavailable");
  assert.equal(fixture.requests.length, 0);
});

test("SPKI mismatch rejects a trusted hostname-valid certificate before HTTP", async () => {
  const fixture = await tlsEvidenceFixture("{}");
  fixture.config.serviceTlsSpkiDigest = `sha256:${"0".repeat(64)}`;
  await exchange(fixture, "evidence_unavailable");
  assert.equal(fixture.requests.length, 0);
});

test("invalid job identifiers do not construct any request", async () => {
  const fixture = await tlsEvidenceFixture("{}");
  const deadline = budget();
  try {
    for (const invalid of ["", `${job}?token=x`, `${job}/..`, `previewjob_${"A".repeat(64)}`, `${job}\r\nHost: other`, `${job}\n`, `${job}\r`]) {
      await assert.rejects(createRunnerEvidenceTransport(fixture.request)(fixture.config, invalid, deadline), { code: "evidence_invalid" });
    }
    assert.equal(fixture.selectedOptions.length, 0);
  } finally { deadline.close(); await fixture.close(); }
});

const framingCases: Array<[string, Buffer, RunnerEvidenceFailureCode]> = [
  ["redirect", wire("Content-Type: application/json\r\nContent-Length: 2\r\nLocation: https://other.example.invalid", "{}", "302 Found"), "evidence_invalid"],
  ["server diagnostics", wire("Content-Type: application/json\r\nContent-Length: 2", "{}", "500 Secret diagnostic"), "evidence_invalid"],
  ["missing type", wire("Content-Length: 2"), "evidence_invalid"],
  ["wrong type", wire("Content-Type: text/json\r\nContent-Length: 2"), "evidence_invalid"],
  ["extra type parameter", wire("Content-Type: application/json; charset=utf-8; secret=yes\r\nContent-Length: 2"), "evidence_invalid"],
  ["wrong charset", wire("Content-Type: application/json; charset=latin1\r\nContent-Length: 2"), "evidence_invalid"],
  ["conflicting duplicate type", wire("Content-Type: application/json\r\ncontent-type: text/plain\r\nContent-Length: 2"), "evidence_invalid"],
  ["conflicting duplicate connection", wire("Content-Type: application/json\r\nContent-Length: 2\r\nConnection: keep-alive"), "evidence_invalid"],
  ["conflicting singleton ETag", wire('Content-Type: application/json\r\nContent-Length: 2\r\nETag: "one"\r\nETag: "two"'), "evidence_invalid"],
  ["conflicting singleton Server", wire("Content-Type: application/json\r\nContent-Length: 2\r\nServer: one\r\nServer: two"), "evidence_invalid"],
  ["gzip encoding", wire("Content-Type: application/json\r\nContent-Length: 2\r\nContent-Encoding: gzip"), "evidence_invalid"],
  ["explicit identity encoding", wire("Content-Type: application/json\r\nContent-Length: 2\r\nContent-Encoding: identity"), "evidence_invalid"],
  ["empty encoding header", wire("Content-Type: application/json\r\nContent-Length: 2\r\nContent-Encoding:"), "evidence_invalid"],
  ["declared trailer", wire("Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nTrailer: X-Secret", "2\r\n{}\r\n0\r\n\r\n"), "evidence_invalid"],
  ["undeclared actual trailer", wire("Content-Type: application/json\r\nTransfer-Encoding: chunked", "2\r\n{}\r\n0\r\nX-Secret: yes\r\n\r\n"), "evidence_invalid"],
  ["missing explicit framing", wire("Content-Type: application/json"), "evidence_invalid"],
  ["noncanonical length", wire("Content-Type: application/json\r\nContent-Length: 02"), "evidence_invalid"],
  ["empty body", wire("Content-Type: application/json\r\nContent-Length: 0", ""), "evidence_invalid"],
  ["oversized declared length", wire("Content-Type: application/json\r\nContent-Length: 131073", ""), "evidence_invalid"],
  ["unsafe declared length", wire("Content-Type: application/json\r\nContent-Length: 9007199254740993", ""), "evidence_invalid"],
  ["duplicate length", wire("Content-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2"), "evidence_unavailable"],
  ["conflicting length", wire("Content-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 3"), "evidence_unavailable"],
  ["both framing headers", wire("Content-Type: application/json\r\nContent-Length: 2\r\nTransfer-Encoding: chunked", "2\r\n{}\r\n0\r\n\r\n"), "evidence_unavailable"],
  ["stacked transfer coding", wire("Content-Type: application/json\r\nTransfer-Encoding: gzip, chunked", "2\r\n{}\r\n0\r\n\r\n"), "evidence_invalid"],
  ["duplicate transfer coding", wire("Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked", "2\r\n{}\r\n0\r\n\r\n"), "evidence_invalid"],
  ["oversized headers", wire(`Content-Type: application/json\r\nContent-Length: 2\r\nX-Padding: ${"x".repeat(16 * 1024)}`), "evidence_unavailable"],
  ["invalid UTF-8", wire("Content-Type: application/json\r\nContent-Length: 3", Buffer.from([34, 255, 34])), "evidence_invalid"],
  ["noncanonical JSON", wire("Content-Type: application/json\r\nContent-Length: 3", "{ }"), "evidence_invalid"],
  ["duplicate JSON members", wire("Content-Type: application/json\r\nContent-Length: 13", '{"x":1,"x":2}'), "evidence_invalid"],
  ["truncated content length", wire("Content-Type: application/json\r\nContent-Length: 4"), "evidence_unavailable"],
  ["truncated chunk", wire("Content-Type: application/json\r\nTransfer-Encoding: chunked", "4\r\n{}"), "evidence_unavailable"],
  ["short declared body", wire("Content-Type: application/json\r\nContent-Length: 1"), "evidence_unavailable"],
  ["informational then final", Buffer.concat([Buffer.from("HTTP/1.1 103 Early Hints\r\nLink: secret\r\n\r\n"), wire("Content-Type: application/json\r\nContent-Length: 2")]), "evidence_invalid"],
  ["continue then final", Buffer.concat([Buffer.from("HTTP/1.1 100 Continue\r\n\r\n"), wire("Content-Type: application/json\r\nContent-Length: 2")]), "evidence_invalid"],
  ["protocol upgrade", wire("Connection: Upgrade\r\nUpgrade: websocket", "", "101 Switching Protocols"), "evidence_invalid"],
];

for (const [name, bytes, code] of framingCases) test(`raw TLS rejects ${name}`, async () => {
  await exchange(await rawTlsEvidenceFixture((socket) => socket.end(bytes)), code);
});

for (const delivery of ["single write", "fragmented writes"] as const) {
  for (const [name, hiddenHeader] of [
    ["forbidden encoding", "Content-Encoding: gzip"],
    ["conflicting content type", "Content-Type: text/plain"],
  ] as const) {
    test(`raw TLS rejects ${name} beyond the default header-count limit (${delivery})`, async () => {
      const prefix = Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n" + "X:\r\n".repeat(1_100));
      const suffix = Buffer.from(`${hiddenHeader}\r\nConnection: close\r\n\r\n{}`);
      assert.ok(prefix.length + suffix.length < 16 * 1024, "regression must fit within the production byte cap");
      const fixture = await rawTlsEvidenceFixture((socket) => {
        if (delivery === "single write") socket.end(Buffer.concat([prefix, suffix]));
        else {
          socket.write(prefix.subarray(0, 2_048));
          setImmediate(() => {
            socket.write(prefix.subarray(2_048));
            setImmediate(() => socket.end(suffix));
          });
        }
      });
      await exchange(fixture, "evidence_invalid");
    });
  }
}

for (const type of ["application/json", "Application/JSON ; Charset=UTF-8", "application/json;\tcharset=utf-8"]) {
  test(`accepted content type: ${type}`, async () => {
    await exchange(await rawTlsEvidenceFixture((socket) => socket.end(wire(`Content-Type: ${type}\r\nContent-Length: 2`))));
  });
}

for (const framing of ["length", "chunked"]) for (const size of [128 * 1024 - 1, 128 * 1024, 128 * 1024 + 1]) {
  test(`${framing} canonical envelope boundary ${size} bytes`, async () => {
    const body = `"${"x".repeat(size - 2)}"`;
    const bytes = framing === "length"
      ? wire(`Content-Type: application/json\r\nContent-Length: ${size}`, body)
      : wire("Content-Type: application/json\r\nTransfer-Encoding: chunked", `${size.toString(16)}\r\n${body}\r\n0\r\n\r\n`);
    await exchange(await rawTlsEvidenceFixture((socket) => socket.end(bytes)), size > 128 * 1024 ? "evidence_invalid" : undefined, 5_000, body);
  });
}

for (const stage of ["headers", "body"]) test(`${stage} stall expires and destroys the real TLS socket`, async () => {
  const fixture = await rawTlsEvidenceFixture((socket) => {
    if (stage === "body") socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{");
  });
  await exchange(fixture, "expired", 100);
  assert.equal(fixture.requests.length, 1);
});

test("uncompleted connect is cancelled and its owned agent is destroyed (injected request)", async () => {
  const fixture = await tlsEvidenceFixture("{}");
  let destroyed = false;
  let agentDestroyed = false;
  const request = ((options: https.RequestOptions) => {
    const agent = options.agent as https.Agent;
    const original = agent.destroy.bind(agent);
    agent.destroy = () => { agentDestroyed = true; original(); };
    return Object.assign(new EventEmitter(), { end() {}, destroy() { destroyed = true; } });
  }) as typeof https.request;
  const deadline = budget(50);
  try {
    await assert.rejects(createRunnerEvidenceTransport(request)(fixture.config, job, deadline), { code: "expired" });
    assert.equal(destroyed, true);
    assert.equal(agentDestroyed, true);
  } finally { deadline.close(); await fixture.close(); }
});

test("poisoned proxy and token environment cannot route or credential the request (isolated process)", async () => {
  let hits = 0;
  const proxy = http.createServer((_req, res) => { hits++; res.end("poison"); });
  proxy.on("connect", (_req, socket) => { hits++; socket.destroy(); });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const script = `
    import assert from 'node:assert/strict';
    const { tlsEvidenceFixture } = await import(${JSON.stringify(new URL("./helpers/runner-evidence-io-fixture.ts", import.meta.url).href)});
    const { createRunnerEvidenceDeadline } = await import(${JSON.stringify(new URL("../src/runner-evidence-deadline.ts", import.meta.url).href)});
    const { createRunnerEvidenceTransport } = await import(${JSON.stringify(new URL("../src/runner-evidence-transport.ts", import.meta.url).href)});
    const fixture = await tlsEvidenceFixture('{}');
    const deadline = createRunnerEvidenceDeadline({ wallNow: () => Date.now(), monotonicNow: () => performance.now() }, Date.now() + 5000);
    try {
      assert.equal(await createRunnerEvidenceTransport(fixture.request)(fixture.config, ${JSON.stringify(job)}, deadline), '{}');
      assert.deepEqual(fixture.requests[0].headers, { host: 'evidence.example.invalid', connection: 'close', accept: 'application/json', 'accept-encoding': 'identity' });
    } finally { deadline.close(); await fixture.close(); }
  `;
  try {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      timeout: 10_000,
      env: { ...process.env, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
        https_proxy: proxyUrl, http_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: "", no_proxy: "",
        NODE_USE_ENV_PROXY: "1", GH_TOKEN: "fake-never-real-gh-token", GITHUB_TOKEN: "fake-never-real-github-token" },
    });
    assert.equal(result.stderr, "");
    assert.equal(hits, 0);
  } finally { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); }
});

test("success destroys a socket even when the peer keeps its response connection open", async () => {
  await exchange(await rawTlsEvidenceFixture((socket) => socket.write(wire("Content-Type: application/json\r\nContent-Length: 2"))));
});

test("invalid headers destroy a socket without waiting for the advertised body", async () => {
  await exchange(await rawTlsEvidenceFixture((socket) => socket.write(wire("Content-Type: text/plain\r\nContent-Length: 100", ""))), "evidence_invalid");
});

test("certificate parsing exceptions return only the safe TLS error (injected malformed certificate)", async () => {
  const fixture = await tlsEvidenceFixture("{}");
  let callbackError: Error | undefined;
  const request = ((options: https.RequestOptions) => {
    callbackError = options.checkServerIdentity!("ignored.invalid", {
      subjectaltname: "DNS:evidence.example.invalid", raw: Buffer.from("not a certificate"),
    } as PeerCertificate);
    const req = Object.assign(new EventEmitter(), {
      end() { queueMicrotask(() => req.emit("error", callbackError)); }, destroy() {},
    });
    return req;
  }) as typeof https.request;
  const deadline = budget();
  try {
    await assert.rejects(createRunnerEvidenceTransport(request)(fixture.config, job, deadline), { code: "evidence_unavailable", message: "evidence_unavailable" });
    assert.ok(callbackError instanceof RunnerEvidenceError);
  } finally { deadline.close(); await fixture.close(); }
});

for (const event of ["connect", "close"] as const) test(`unexpected ${event} event rejects immediately (injected request event)`, async () => {
  const fixture = await tlsEvidenceFixture("{}");
  let responseDestroyed = false;
  let socketDestroyed = false;
  const request = ((_options: https.RequestOptions) => {
    const req = Object.assign(new EventEmitter(), {
      end() { queueMicrotask(() => req.emit(event,
        { destroy() { responseDestroyed = true; } }, { destroy() { socketDestroyed = true; } })); }, destroy() {},
    });
    return req;
  }) as typeof https.request;
  const deadline = budget();
  try {
    await assert.rejects(createRunnerEvidenceTransport(request)(fixture.config, job, deadline), { code: event === "connect" ? "evidence_invalid" : "evidence_unavailable" });
    if (event === "connect") { assert.equal(responseDestroyed, true); assert.equal(socketDestroyed, true); }
  } finally { deadline.close(); await fixture.close(); }
});

for (const complete of [true, false]) test(`response final state rejects ${complete ? "actual length mismatch" : "incomplete stream"} (injected response)`, async () => {
  const fixture = await tlsEvidenceFixture("{}");
  const response = Object.assign(Readable.from([Buffer.from("{}")]), {
    statusCode: 200, complete, rawHeaders: ["Content-Type", "application/json", "Content-Length", complete ? "3" : "2"], rawTrailers: [],
  });
  const request = ((_options: https.RequestOptions, callback: (response: unknown) => void) => {
    const req = Object.assign(new EventEmitter(), { end() { queueMicrotask(() => callback(response)); }, destroy() {} });
    return req;
  }) as typeof https.request;
  const deadline = budget();
  try {
    await assert.rejects(createRunnerEvidenceTransport(request)(fixture.config, job, deadline), { code: "evidence_invalid" });
    assert.equal(response.destroyed, true);
  } finally { deadline.close(); await fixture.close(); }
});
