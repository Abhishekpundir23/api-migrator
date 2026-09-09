import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunnerRegistryIo, RunnerRegistryPolicy } from "../../src/runner-key-registry.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { createServer, type TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import type { RunnerEvidenceConfig } from "../../src/runner-evidence-contract.js";

export interface TlsEvidenceFixture {
  request: typeof https.request;
  config: RunnerEvidenceConfig;
  requests: Array<{ method: string; path: string; host: string; headers: Record<string, string | string[] | undefined> }>;
  selectedOptions: https.RequestOptions[];
  servernames: string[];
  activeSockets(): number;
  close(): Promise<void>;
}

export function tlsEvidenceFixture(body: string): Promise<TlsEvidenceFixture> {
  return rawTlsEvidenceFixture((socket) => socket.end(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  ));
}

// The only network redirection/CA seam is here, never in production configuration.
// Both well-formed HTTP and adversarial raw wire bytes traverse native TLS/HTTP.
export async function rawTlsEvidenceFixture(
  respond: (socket: TLSSocket) => void,
  options: { certificateHost?: string; untrustedCa?: boolean } = {},
): Promise<TlsEvidenceFixture> {
  const root = mkdtempSync(join(tmpdir(), "runner-tls-test-"));
  chmodSync(root, 0o700);
  const sockets = new Set<Socket>();
  const requests: TlsEvidenceFixture["requests"] = [];
  const selectedOptions: https.RequestOptions[] = [];
  const servernames: string[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const keyPath = join(root, "key.pem");
    const certPath = join(root, "cert.pem");
    await promisify(execFile)("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
      "-subj", "/CN=Disposable runner evidence test CA", "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", `subjectAltName=DNS:${options.certificateHost ?? "evidence.example.invalid"}`,
      "-keyout", keyPath, "-out", certPath,
    ]);
    chmodSync(keyPath, 0o600);
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    const der = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
    const config: RunnerEvidenceConfig = {
      serviceOrigin: "https://evidence.example.invalid", serviceAddresses: ["93.184.216.34"],
      serviceTlsSpkiDigest: `sha256:${createHash("sha256").update(der).digest("hex")}`,
      registryDirectory: "/protected-test-registry",
    };
    server = createServer({ key, cert }, (socket) => {
      servernames.push((socket as TLSSocket & { servername: string }).servername);
      let input = "";
      const onData = (chunk: Buffer) => {
        input += chunk.toString("latin1");
        const end = input.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.removeListener("data", onData);
        const [first, ...lines] = input.slice(0, end).split("\r\n");
        const [method, path] = first!.split(" ");
        const headers: Record<string, string> = {};
        for (const line of lines) {
          const colon = line.indexOf(":");
          headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
        }
        requests.push({ method: method!, path: path!, host: headers.host!, headers });
        respond(socket);
      };
      socket.on("data", onData);
      socket.on("error", () => undefined);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
    });
    server.on("tlsClientError", () => undefined);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const request = ((input: https.RequestOptions, callback?: (response: IncomingMessage) => void) => {
      selectedOptions.push(input);
      assert.equal(input.protocol, "https:");
      assert.equal(input.hostname, config.serviceAddresses[0]);
      assert.equal(input.port, 443);
      assert.equal(input.servername, "evidence.example.invalid");
      assert.equal(input.rejectUnauthorized, true);
      assert.equal(input.insecureHTTPParser, false);
      assert.equal(input.maxHeaderSize, 16 * 1024);
      assert.ok(input.agent instanceof https.Agent);
      assert.notEqual(input.agent, https.globalAgent);
      assert.equal(input.agent.options.keepAlive, false);
      assert.equal(input.agent.options.maxCachedSessions, 0);
      assert.equal(typeof input.checkServerIdentity, "function");
      for (const field of ["proxyEnv", "lookup", "auth", "ca", "cert", "key", "pfx", "keylog"]) {
        assert.equal(Object.hasOwn(input, field), false, `unexpected ${field}`);
      }
      return https.request({ ...input, hostname: "127.0.0.1", port: address.port,
        ca: options.untrustedCa ? [] : [cert] }, callback);
    }) as typeof https.request;
    return { request, config, requests, selectedOptions, servernames,
      activeSockets: () => sockets.size,
      close: async () => {
        const closed = [...sockets].map((socket) => new Promise<void>((resolve) => socket.once("close", resolve)));
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
        await Promise.all(closed);
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    server?.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function registryFixture(bytes: Buffer): {
  directory: string;
  file: string;
  policy: RunnerRegistryPolicy;
  replace(bytes: Buffer): void;
  close(): void;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-registry-test-")));
  try {
    chmodSync(root, 0o700);
    const directory = join(root, "registry");
    const applicationCheckout = join(root, "checkout");
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(applicationCheckout, { mode: 0o700 });
    const file = join(directory, "runner-keys.json");
    writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    let replacement = 0;
    return {
      directory, file, policy: { applicationCheckout, excludedRoots: [] },
      replace: (next) => {
        const sibling = join(directory, `replacement-${replacement++}.json`);
        writeFileSync(sibling, next, { flag: "wx", mode: 0o600 });
        renameSync(sibling, file);
      },
      close: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

// Only external OS-temp ancestors with sticky/write bits are synthesized.
// All created fixture directories, files, links and their metadata remain real.
export function registryFixtureIo(): RunnerRegistryIo {
  const stickyAncestors = new Set<string>();
  for (let path = realpathSync(tmpdir()); ; path = dirname(path)) {
    if ((lstatSync(path).mode & 0o1022) === 0o1022) stickyAncestors.add(path);
    if (path === dirname(path)) break;
  }
  return {
    open, realpath,
    lstat: (async (path, options) => {
      const snapshot = await lstat(path, options);
      if (!stickyAncestors.has(String(path))) return snapshot;
      return Object.assign(Object.create(Object.getPrototypeOf(snapshot)), snapshot, {
        mode: typeof snapshot.mode === "bigint"
          ? (snapshot.mode & ~0o7777n) | 0o755n
          : (snapshot.mode & ~0o7777) | 0o755,
      });
    }) as RunnerRegistryIo["lstat"],
  };
}
