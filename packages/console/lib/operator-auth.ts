import { timingSafeEqual } from "node:crypto";

export interface OperatorCredentials {
  username: string;
  password: string;
}

export function credentialsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): OperatorCredentials | null {
  const username = env.OPERATOR_USERNAME?.trim();
  const password = env.OPERATOR_PASSWORD;
  if (!username || !password) return null;
  return { username, password };
}

/** Validate an HTTP Basic header without ever sending credentials to client JS. */
export function isAuthorizedHeader(
  header: string | null,
  credentials: OperatorCredentials
): boolean {
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return safeEqual(username, credentials.username) && safeEqual(password, credentials.password);
  } catch {
    return false;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function safeEqual(actual: string, expected: string): boolean {
  const actualDigest = Buffer.from(actual);
  const expectedDigest = Buffer.from(expected);
  return (
    actualDigest.length === expectedDigest.length && timingSafeEqual(actualDigest, expectedDigest)
  );
}
