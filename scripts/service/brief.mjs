import { ASSESSMENT_MAX_SOURCE_FILES, TRANSFORM_ALLOWLIST } from "@api-migrator/engine";

const RECIPES = {
  "inngest-v3-to-v4": "Inngest TypeScript SDK v3 → v4",
  "knock-v0-to-v1": "Knock Node SDK v0 → v1",
};

// Deliberately static. Finding messages and paths can contain customer source.
const GUIDANCE = {
  T1: "Trace the createFunction receiver to its SDK client and check that the legacy trigger belongs in options.triggers.",
  T2: "Check the serveHost to serveOrigin rename against the URL the application serves.",
  T3: "Check the boolean streaming option against the original streaming behavior.",
  T4: "Check the Connect gateway setting after renaming rewriteGatewayEndpoint to gatewayUrl.",
  T5: "Confirm that INNGEST_DEV selects local development and that the production environment supplies the intended signing configuration.",
  F1: "Trace the client configuration and confirm the intended development mode and production signing key.",
  F2: "Find consumers of event.user and update both producers and handlers to carry that information in event.data.",
  F3: "Review configured middleware and map its hooks to the v4 lifecycle.",
  F4: "Replace legacy EventSchemas declarations with the appropriate eventType and staticSchema definitions.",
  F5: "Review options that moved from serve to the Inngest client, including fetch and signing configuration.",
  F6: "Replace the removed logLevel option with the supported logger or middleware setup.",
  F7: "Review step.invoke calls that use a string function ID and supply the intended function reference.",
  F8: "Exercise Connect worker startup, signals and shutdown in the target deployment.",
  F9: "Replace internal InngestFunction types with public inferred function or reference types.",
  F10: "Check each maxRuntime setting against the platform limit and expected retry and checkpoint behavior.",
  F11: "Inspect the handler for Promise.race and confirm how its branches complete under v4 parallel execution.",
  F12: "Confirm how the application is hosted. For serverless deployments, review checkpointing, retries and maxRuntime against the platform timeout.",
  F13: "Exercise the Inngest route in the deployed edge runtime and verify its fetch and client configuration.",
  F14: "Check event sends in and outside handlers. Review step.sendEvent in handlers and confirm the relevant promise is awaited or returned.",
  K1: "Trace the Knock client and compare the legacy notify call to workflows.trigger.",
  K2: "Confirm the recipient update after mapping users.identify to users.update.",
  K3: "Check the v1 parameter names for list pagination and workflow cancellation on the relevant call.",
  K4: "Check the default Knock import and consolidate conflicting named imports.",
  K5: "Verify the client constructor receives a v1 options object with the intended apiKey.",
  KF1: "Trace SDK imports, wrappers and dynamic receivers. Check the argument shape of affected calls against the v1 options-object signature.",
  KF2: "Review error handling against the exported v1 error types and narrow the error before inspecting its fields.",
  KF3: "Verify the token signer import and check the claims in the resulting token.",
  KF4: "Map legacy scheduling methods to the v1 schedules namespace and review both arguments and results.",
  KF5: "Verify the bulk operation's v1 namespace and batch payload.",
  KF6: "Inspect how callers read v1 responses and check whether an extra .data access should be removed.",
};

const SUMMARY_KEYS = ["version", "recipe", "sourceFiles", "matchedFiles", "wouldChangeFiles", "findings"];
const FINDING_KEYS = ["code", "kind", "count"];
const MAX_COUNT = 10_000_000;

function hasExactFields(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isCount(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum && value <= MAX_COUNT;
}

function ruleIds(recipe) {
  if (typeof recipe !== "string" || !Object.hasOwn(TRANSFORM_ALLOWLIST, recipe)) {
    throw new Error("Unsupported migration recipe.");
  }
  return TRANSFORM_ALLOWLIST[recipe];
}

export function ruleGuidance(recipe, code) {
  if (!ruleIds(recipe).includes(code) || !Object.hasOwn(GUIDANCE, code)) {
    throw new Error("Unsupported migration rule.");
  }
  return GUIDANCE[code];
}

/** Accept only the bounded v1 aggregate wire format. Never echo input on failure. */
export function validateSummary(value) {
  if (!hasExactFields(value, SUMMARY_KEYS) || value.version !== 1) {
    throw new Error("Expected a version 1 assessment with exactly the documented fields.");
  }
  const { recipe, sourceFiles, matchedFiles, wouldChangeFiles } = value;
  const allowed = ruleIds(recipe);
  if (![sourceFiles, matchedFiles, wouldChangeFiles].every(n => isCount(n)) ||
      sourceFiles > ASSESSMENT_MAX_SOURCE_FILES || matchedFiles > sourceFiles || wouldChangeFiles > matchedFiles) {
    throw new Error("Invalid assessment file counts.");
  }
  if (!Array.isArray(value.findings) || value.findings.length > 2 * allowed.length ||
      (matchedFiles === 0 && value.findings.length !== 0)) {
    throw new Error("Invalid assessment findings.");
  }

  const seen = new Set();
  let applied = 0;
  const findings = [];
  for (const entry of value.findings) {
    if (!hasExactFields(entry, FINDING_KEYS) || !allowed.includes(entry.code) ||
        !["applied", "review"].includes(entry.kind) || !isCount(entry.count, 1)) {
      throw new Error("Invalid assessment finding.");
    }
    const { code, kind, count } = entry;
    const key = kind + "/" + code;
    if (seen.has(key)) throw new Error("Duplicate assessment finding group.");
    seen.add(key);
    if (kind === "applied") {
      if (/^(?:F|KF)/.test(code)) throw new Error("A review-only rule cannot describe an edit.");
      applied += count;
    }
    findings.push({ code, kind, count });
  }
  if (applied < wouldChangeFiles || (wouldChangeFiles === 0 && applied > 0)) {
    throw new Error("Candidate edit counts disagree with the changed-file count.");
  }
  if (recipe === "inngest-v3-to-v4" && matchedFiles > 0 &&
      !findings.some(f => f.kind === "review" && f.code === "F12" && f.count === 1)) {
    throw new Error("An Inngest assessment with matches requires exactly one repository-level deployment review (F12).");
  }
  findings.sort((a, b) => allowed.indexOf(a.code) - allowed.indexOf(b.code) ||
    a.kind.localeCompare(b.kind));
  return { version: 1, recipe, sourceFiles, matchedFiles, wouldChangeFiles, findings };
}

/** Render all reported findings. A suggested order can only move existing review rules. */
export function renderBrief(value, reviewOrder = []) {
  const summary = validateSummary(value);
  const { recipe, findings, sourceFiles, matchedFiles, wouldChangeFiles } = summary;
  const reviews = findings.filter(f => f.kind === "review");
  const edits = findings.filter(f => f.kind === "applied");
  if (!Array.isArray(reviewOrder) || reviewOrder.length > reviews.length ||
      new Set(reviewOrder).size !== reviewOrder.length ||
      reviewOrder.some(code => !reviews.some(f => f.code === code))) {
    throw new Error("Suggested review order must contain distinct observed review rule IDs.");
  }
  const ranked = new Map(reviewOrder.map((code, index) => [code, index]));
  reviews.sort((a, b) => (ranked.get(a.code) ?? reviews.length) - (ranked.get(b.code) ?? reviews.length));
  const lines = [
    `# Migration assessment · ${RECIPES[recipe]}`,
    "",
    "| Local scan | Files |",
    "| --- | ---: |",
    `| Source files inspected | ${sourceFiles} |`,
    `| Files matching a recipe pattern or reporting a finding | ${matchedFiles} |`,
    `| Files with proposed edits | ${wouldChangeFiles} |`,
    "",
  ];
  for (const [title, group, empty] of [
    ["Manual review", reviews, "The selected recipe reported zero manual-review findings."],
    ["Proposed edits", edits, "The selected recipe proposed zero source edits."],
  ]) {
    lines.push("## " + title, "");
    if (group.length === 0) lines.push(empty);
    else {
      lines.push("| Rule | Occurrences | Reviewer action |", "| --- | ---: | --- |");
      for (const { code, count } of group) {
        lines.push(`| ${code} | ${count} | ${ruleGuidance(recipe, code)} |`);
      }
    }
    lines.push("");
  }
  lines.push("## Scope", "",
    "This source-only assessment simulated rule matches and edits in memory. Counts describe occurrences of individual rules. One file may contribute several occurrences. The scan leaves the working tree untouched.",
    "",
    "SDK version eligibility, dependency compatibility and runtime behavior require separate verification. Before applying a migration, confirm the installed SDK version and review the patch, type checks and application tests in an authorized environment.",
    "");
  return lines.join("\n");
}
