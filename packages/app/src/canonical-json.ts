/** Strict canonical JSON shared by owner challenge, signing, and verification. */

/**
 * Serialize the JSON-safe subset used by authorization records. Object keys
 * use JavaScript's UTF-16 code-unit order, matching Array.prototype.sort().
 */
export function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error("Canonical JSON rejected: unsafe JSON number");
    }
    return String(value);
  }
  if (typeof value !== "object") {
    throw new Error("Canonical JSON rejected: unsupported JSON value");
  }
  if (ancestors.has(value)) throw new Error("Canonical JSON rejected: cyclic JSON value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      const ownKeys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index)) ||
        ownKeys.length !== value.length + 1 ||
        ownKeys.some((key) =>
          typeof key !== "string" ||
          (key !== "length" && !keys.includes(key))
        )
      ) {
        throw new Error("Canonical JSON rejected: sparse or extended JSON array");
      }
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical JSON rejected: non-plain JSON object");
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    const ownKeys = Reflect.ownKeys(object);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      throw new Error("Canonical JSON rejected: hidden or symbolic JSON member");
    }
    for (const key of keys) {
      assertValidUnicode(key);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("Canonical JSON rejected: accessor or hidden JSON member");
      }
      if (descriptor.value === undefined) {
        throw new Error("Canonical JSON rejected: undefined JSON member");
      }
    }
    return `{${keys
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Parse only exact canonical UTF-8 JSON bytes within the supplied bound. */
export function parseCanonicalJson(input: unknown, maxBytes: number, label: string): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Canonical JSON rejected: invalid parser byte limit");
  }
  const text = decodeInput(input, maxBytes, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Canonical JSON rejected: ${label} is not valid JSON`);
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    throw new Error(`Canonical JSON rejected: ${label} contains unsupported JSON values`);
  }
  if (canonical !== text) {
    throw new Error(`Canonical JSON rejected: ${label} is not canonical JSON (including duplicate keys)`);
  }
  return parsed;
}

function decodeInput(input: unknown, maxBytes: number, label: string): string {
  let text: string;
  if (Buffer.isBuffer(input)) {
    if (input.length === 0 || input.length > maxBytes) {
      throw new Error(`Canonical JSON rejected: ${label} is missing or exceeds the supported size`);
    }
    text = input.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(input)) {
      throw new Error(`Canonical JSON rejected: ${label} is not valid UTF-8`);
    }
  } else if (typeof input === "string") {
    if (input.length === 0 || Buffer.byteLength(input, "utf8") > maxBytes) {
      throw new Error(`Canonical JSON rejected: ${label} is missing or exceeds the supported size`);
    }
    text = input;
  } else {
    throw new Error(`Canonical JSON rejected: ${label} is missing or exceeds the supported size`);
  }
  try {
    assertValidUnicode(text);
  } catch {
    throw new Error(`Canonical JSON rejected: ${label} contains invalid Unicode`);
  }
  return text;
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("Canonical JSON rejected: unpaired high surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Canonical JSON rejected: unpaired low surrogate");
    }
  }
}
