import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GIT_TOKEN_ENV = "API_MIGRATOR_GIT_TOKEN";

const SAFE_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "XDG_RUNTIME_DIR",
] as const;

/** Environment for code controlled by a target repository. Secrets are never inherited. */
export function sanitizedExecutionEnv(
  isolatedHome: string,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  for (const key of SAFE_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

/** Create a static askpass helper; the token remains in a child-only env var. */
export function createAskPassScript(directory: string): string {
  const path = join(directory, "git-askpass.sh");
  writeFileSync(
    path,
    `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' 'x-access-token' ;;\n  *Password*) printf '%s\\n' "$${GIT_TOKEN_ENV}" ;;\n  *) exit 1 ;;\nesac\n`,
    { encoding: "utf8", mode: 0o700 }
  );
  chmodSync(path, 0o700);
  return path;
}

/** Add credentials only to a git child's environment, never its URL or argv. */
export function gitAuthenticationEnv(
  token: string,
  askPassPath: string,
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  if (!token) throw new Error("GitHub authentication returned an empty token");
  return {
    ...base,
    GIT_ASKPASS: askPassPath,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    [GIT_TOKEN_ENV]: token,
  };
}

export function redactText(value: unknown, secrets: readonly string[] = []): string {
  let text = typeof value === "string" ? value : String(value ?? "");
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }

  return text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /(\b(?:api[_-]?key|access[_-]?key|client[_-]?secret|password|passwd|secret|token)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1[REDACTED]"
    )
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED ACCESS KEY]")
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/(https:\/\/)[^/@\s]+@github\.com/gi, "$1[REDACTED]@github.com");
}

/** Convert unknown/subprocess/API failures to bounded, secret-safe text. */
export function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  const candidate = error as {
    message?: unknown;
    stderr?: unknown;
    stdout?: unknown;
    response?: { data?: { message?: unknown } };
  };
  const pieces = [
    candidate?.message,
    candidate?.response?.data?.message,
    bufferText(candidate?.stderr),
    bufferText(candidate?.stdout),
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  const combined = pieces.join("\n").trim() || "Unexpected operation failure";
  return redactText(combined, secrets).slice(0, 2_000);
}

function bufferText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}
