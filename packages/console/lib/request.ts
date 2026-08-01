export const MAX_JSON_BYTES = 32 * 1024;
export const MAX_REPOS_PER_RUN = 10;
export const MAX_RUN_CONCURRENCY = 2;

const OWNER = /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class HttpInputError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = "HttpInputError";
  }
}

export async function readLimitedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new HttpInputError("content-type must be application/json", 415);
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new HttpInputError(`request body exceeds ${MAX_JSON_BYTES} bytes`, 413);
  }
  if (!request.body) throw new HttpInputError("JSON body required");

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new HttpInputError(`request body exceeds ${MAX_JSON_BYTES} bytes`, 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpInputError("request body must be valid JSON");
  }
}

export function normalizeRepoSlugs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpInputError("repoSlugs must be a non-empty array");
  }
  if (value.length > MAX_REPOS_PER_RUN) {
    throw new HttpInputError(`at most ${MAX_REPOS_PER_RUN} repositories may be run at once`);
  }

  const deduplicated = new Map<string, string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") throw new HttpInputError("each repo slug must be a string");
    const slug = candidate.trim();
    const [owner, repo, extra] = slug.split("/");
    if (extra !== undefined || !owner || !repo || !OWNER.test(owner) || !REPO.test(repo)) {
      throw new HttpInputError(`invalid GitHub repository slug: ${slug || "(empty)"}`);
    }
    deduplicated.set(slug.toLowerCase(), slug);
  }
  return [...deduplicated.values()];
}

export function normalizeConcurrency(value: unknown): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_RUN_CONCURRENCY) {
    throw new HttpInputError(`concurrency must be an integer from 1 to ${MAX_RUN_CONCURRENCY}`);
  }
  return value as number;
}

export function requireUuid(value: string, label = "id"): string {
  if (!UUID.test(value)) throw new HttpInputError(`invalid ${label}`);
  return value;
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpInputError("JSON body must be an object");
  }
  return value as Record<string, unknown>;
}
