// Internal, non-authorizing diagnostics. Raw errors remain private; only fixed
// stages/categories and observed bounded primitives can cross the CLI boundary.
const stages = new Set([
  "unspecified", "cleanup", "installPolicy", "prepare", "startGateway", "probeOnline", "install", "install.cancel", "stopGateway", "assertOffline", "migrate", "verify",
  ...["cli", "environment", "platform", "accounts", "tools", "docker", "context", "image", "resources", "output", "workspace", "dns", "plan", "collision", "ownership", "evidence", "permissions", "gateway", "report"]
    .map((name) => `setup.${name}`),
  ...["prepare", "install", "migrate", "verify"].flatMap((phase) =>
    ["launch", "complete", "execute", "inspect", "uid", "evidence", "validate"].map((step) => `${phase}.${step}`)),
  ...["wrong_sni", "absent_sni", "wrong_sni_ipv6", "absent_sni_ipv6", "non_443", "non_npm", "correct_sni", "correct_sni_ipv6", "direct_bypass", "offline_network"]
    .map((name) => `probe.${name}`),
]);
const categories = new Set(["deadline", "spawn", "subprocess_exit", "inspection", "identity", "uid_evidence", "output_limit", "protocol", "evidence", "host_operation", "cleanup", "unexpected", "freshness", "dns_admission"]);
const signals = new Set(["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGABRT", "SIGFPE", "SIGKILL", "SIGSEGV", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGUSR1", "SIGUSR2", "SIGXCPU", "SIGXFSZ"]);
const dnsReasons = new Set(["ttl_floor_exhausted", "resolver_timeout", "resolver_error", "missing_or_excessive_answer", "invalid_answer", "diagnostic_or_internal_failure"]);
const details = new WeakMap(), cleanupFailures = new WeakSet();
const integer = (value) => Number.isSafeInteger(value) ? value : null;

export function assertFixtureDiagnosticStage(stage) {
  if (!stages.has(stage)) throw new Error("fixture freshness stage invalid");
}

export function annotateFixtureFailure(error, input) {
  if (!error || typeof error !== "object") return error; // Preserve primitive rejection identity.
  // A surrounding setup/operation catch must not hide the original diagnostic
  // already carried by a lifecycle-plus-cleanup aggregate.
  const pending = [error];
  for (let visited = 0; pending.length && visited < 16; visited += 1) {
    const item = pending.shift();
    if (!item || typeof item !== "object") continue;
    if (item !== error && details.has(item)) return error;
    if (item instanceof AggregateError) {
      const errors = Object.getOwnPropertyDescriptor(item, "errors")?.value;
      if (Array.isArray(errors)) for (let index = 0; index < Math.min(errors.length, 8); index += 1) {
        pending.push(Object.getOwnPropertyDescriptor(errors, String(index))?.value);
      }
    }
  }
  const safe = {};
  if (input.stage !== undefined) { assertFixtureDiagnosticStage(input.stage); safe.stage = input.stage; }
  if (input.category !== undefined) {
    if (!categories.has(input.category)) throw new Error("fixture diagnostic category invalid");
    safe.category = input.category;
  }
  if (Number.isInteger(input.exitStatus) && input.exitStatus >= 0 && input.exitStatus <= 255) safe.exitStatus = input.exitStatus;
  if (signals.has(input.signal)) safe.signal = input.signal;
  if (typeof input.timedOut === "boolean") safe.timedOut = input.timedOut;
  if (Number.isSafeInteger(input.commandBudgetMs) && input.commandBudgetMs >= 1 && input.commandBudgetMs <= 1200000) safe.commandBudgetMs = input.commandBudgetMs;
  if (safe.category === "freshness") {
    for (const key of ["planAgeMs", "planRemainingMs", "dnsRemainingMs", "commandBudgetMs", "cleanupReserveMs"]) safe[key] = integer(input[key]);
  }
  if (safe.category === "dns_admission") {
    safe.reason = dnsReasons.has(input.reason) ? input.reason : "diagnostic_or_internal_failure";
    for (const key of ["attempts", "elapsedMs", "requiredMinimumTtlSeconds"]) safe[key] = integer(input[key]);
  }
  details.set(error, { ...safe, ...details.get(error) }); // Preserve the originating boundary.
  return error;
}

export function atFixtureStage(stage, category, action, facts = {}) {
  try {
    const result = action();
    return result instanceof Promise ? result.catch((error) => { throw annotateFixtureFailure(error, { stage, category, ...facts }); }) : result;
  } catch (error) { throw annotateFixtureFailure(error, { stage, category, ...facts }); }
}

export function markFixtureCleanupFailure(error) {
  if (error && typeof error === "object") cleanupFailures.add(error);
}

export function formatFixtureFailure(error) {
  const pending = [error];
  let diagnostic, cleanupFailed = false;
  for (let visited = 0; pending.length && visited < 16; visited += 1) {
    const item = pending.shift();
    if (!item || typeof item !== "object") continue;
    cleanupFailed ||= cleanupFailures.has(item);
    diagnostic ??= details.get(item);
    if (item instanceof AggregateError) {
      const errors = Object.getOwnPropertyDescriptor(item, "errors")?.value;
      if (Array.isArray(errors)) for (let index = 0; index < Math.min(errors.length, 8); index += 1) {
        pending.push(Object.getOwnPropertyDescriptor(errors, String(index))?.value);
      }
    }
  }
  if (!diagnostic) return "fixture execution failed";
  let prefix = "fixture execution failed", fields;
  if (diagnostic.category === "freshness") {
    prefix = "fixture plan or DNS expired or lacks command lifetime";
    fields = ["stage", "planAgeMs", "planRemainingMs", "dnsRemainingMs", "commandBudgetMs", "cleanupReserveMs"];
  } else if (diagnostic.category === "dns_admission") {
    prefix = "fixture DNS admission failed";
    fields = ["reason", "attempts", "elapsedMs", "requiredMinimumTtlSeconds"];
  } else fields = ["stage", "category", "exitStatus", "signal", "timedOut", "commandBudgetMs"];
  const values = fields.filter((key) => Object.hasOwn(diagnostic, key)).map((key) => `${key}=${diagnostic[key]}`);
  return `${prefix} (${[...values, `cleanupFailed=${cleanupFailed}`].join(", ")})`.slice(0, 512);
}
