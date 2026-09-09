import https from "node:https";
import { checkServerIdentity } from "node:tls";
import { X509Certificate, createHash } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import { RunnerEvidenceError, type RunnerEvidenceConfig } from "./runner-evidence-contract.js";
import type { RunnerEvidenceDeadline } from "./runner-evidence-deadline.js";
import { parseCanonicalJson } from "./canonical-json.js";

const MAX_ENVELOPE_BYTES = 128 * 1024;
// Include Node's singleton-header list: its merged headers silently discard
// duplicates, so only rawHeaders can enforce an unambiguous wire response.
const SINGLETON_HEADERS = new Set([
  "age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host",
  "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards",
  "proxy-authorization", "referer", "retry-after", "server", "user-agent",
  "transfer-encoding", "content-encoding", "trailer", "connection", "date", "content-location", "content-range",
]);

function responseLength(response: IncomingMessage): number | undefined {
  if (response.statusCode !== 200) throw new RunnerEvidenceError("evidence_invalid");
  const headers = new Map<string, string>();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index]!.toLowerCase();
    if (!SINGLETON_HEADERS.has(name)) continue;
    if (headers.has(name)) throw new RunnerEvidenceError("evidence_invalid");
    headers.set(name, response.rawHeaders[index + 1]!);
  }
  const type = headers.get("content-type");
  if (type === undefined || !/^[\t ]*application\/json[\t ]*(?:;[\t ]*charset[\t ]*=[\t ]*utf-8[\t ]*)?$/i.test(type)
    || headers.has("content-encoding") || headers.has("trailer")) {
    throw new RunnerEvidenceError("evidence_invalid");
  }
  const length = headers.get("content-length");
  const transfer = headers.get("transfer-encoding");
  if (transfer !== undefined) {
    if (length !== undefined || !/^[\t ]*chunked[\t ]*$/i.test(transfer)) throw new RunnerEvidenceError("evidence_invalid");
    return undefined;
  }
  if (length === undefined || !/^(0|[1-9][0-9]*)$/.test(length)) throw new RunnerEvidenceError("evidence_invalid");
  const declared = Number(length);
  if (!Number.isSafeInteger(declared) || declared > MAX_ENVELOPE_BYTES) throw new RunnerEvidenceError("evidence_invalid");
  return declared;
}

async function readEnvelope(response: IncomingMessage, deadline: RunnerEvidenceDeadline): Promise<string> {
  deadline.check();
  const declared = responseLength(response);
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const part of response) {
    deadline.check();
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    total += chunk.length;
    if (total > MAX_ENVELOPE_BYTES) throw new RunnerEvidenceError("evidence_invalid");
    chunks.push(chunk);
  }
  if (!response.complete || response.rawTrailers.length !== 0 || (declared !== undefined && total !== declared)) {
    throw new RunnerEvidenceError("evidence_invalid");
  }
  const bytes = Buffer.concat(chunks, total);
  try {
    parseCanonicalJson(bytes, MAX_ENVELOPE_BYTES, "runner evidence");
  } catch {
    throw new RunnerEvidenceError("evidence_invalid");
  }
  deadline.check();
  return bytes.toString("utf8");
}

export function createRunnerEvidenceTransport(request: typeof https.request) {
  return async (config: Readonly<RunnerEvidenceConfig>, jobId: string, deadline: RunnerEvidenceDeadline): Promise<string> => {
    if (typeof jobId !== "string" || !/^previewjob_[a-f0-9]{64}$/.test(jobId)) {
      throw new RunnerEvidenceError("evidence_invalid");
    }
    const host = new URL(config.serviceOrigin).hostname;
    const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let finished = false;
    try {
      return await deadline.run(() => new Promise<string>((resolve, reject) => {
        deadline.check();
        req = request({
          protocol: "https:", hostname: config.serviceAddresses[0], port: 443,
          servername: host, method: "GET", path: `/v1/runner-evidence/${jobId}`,
          agent, rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
          insecureHTTPParser: false, signal: deadline.signal,
          headers: { Host: host, Connection: "close", Accept: "application/json", "Accept-Encoding": "identity" },
          checkServerIdentity: (_name, cert) => {
            try {
              if (checkServerIdentity(host, cert)) return new RunnerEvidenceError("evidence_unavailable");
              const der = new X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" });
              const digest = `sha256:${createHash("sha256").update(der).digest("hex")}`;
              return digest === config.serviceTlsSpkiDigest ? undefined : new RunnerEvidenceError("evidence_unavailable");
            } catch {
              return new RunnerEvidenceError("evidence_unavailable");
            }
          },
        }, (res) => {
          if (finished) { res.destroy(); return; }
          response = res;
          void readEnvelope(res, deadline).then(resolve, reject);
        });
        // Native socket/parser attachment is deferred until the next tick.
        // Preserve every raw header for policy checks; maxHeaderSize still
        // bounds their bytes even when there are many tiny header fields.
        req.maxHeadersCount = 0;
        req.on("error", reject);
        req.on("information", () => reject(new RunnerEvidenceError("evidence_invalid")));
        for (const event of ["upgrade", "connect"] as const) {
          req.on(event, (res, socket) => {
            res.destroy();
            socket.destroy();
            reject(new RunnerEvidenceError("evidence_invalid"));
          });
        }
        req.on("close", () => {
          if (!response?.complete) reject(new RunnerEvidenceError("evidence_unavailable"));
        });
        req.end();
      }));
    } catch (error) {
      if (error instanceof RunnerEvidenceError) throw error;
      throw new RunnerEvidenceError("evidence_unavailable");
    } finally {
      finished = true;
      response?.destroy();
      req?.destroy();
      agent.destroy();
    }
  };
}

export const fetchRunnerEvidenceEnvelope = createRunnerEvidenceTransport(https.request);
