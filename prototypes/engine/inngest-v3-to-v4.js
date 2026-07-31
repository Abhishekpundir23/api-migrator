/**
 * Inngest TypeScript SDK migration: v3 → v4
 *
 * Implements the mechanical (deterministic) breaking-change transforms from the
 * official v3→v4 migration guide. Structural changes are reported but not
 * auto-applied, so a human can review them.
 *
 * Transforms applied (deterministic):
 *   T1  createFunction trigger moved into the options object
 *        createFunction({ id }, { event|cron }, fn)  ->  createFunction({ id, triggers: { event|cron } }, fn)
 *   T2  serveHost -> serveOrigin (option rename)
 *   T3  streaming: "force"|"allow"|false  ->  streaming: true|false
 *
 * Transforms flagged for review (structural):
 *   F1  new Inngest({ id })  without isDev  ->  requires isDev: true or signingKey (runtime/env decision)
 *   F2  event.user removed  ->  migrate to event.data (data-shape decision)
 *
 * Usage (jscodeshift):
 *   npx jscodeshift -t engine/inngest-v3-to-v4.js <path> --extensions=ts,tsx,js,jsx --dry --print
 *
 * This is the "Transformer" module of the migration engine described in the plan.
 */

const REVIEW_TAG = "REVIEW"; // flagged for human review, not auto-applied

function report(file, kind, code, message, loc) {
  // Collected by the transform driver; jscodeshift has no return channel for
  // metadata, so we stash reports on the global so a wrapper can read them.
  global.__MIGRATION_REPORT__ = global.__MIGRATION_REPORT__ || [];
  global.__MIGRATION_REPORT__.push({
    file,
    kind, // "applied" | "review"
    code,
    line: loc ? loc.start.line : null,
    message,
  });
}

/**
 * T1: createFunction({ id }, { trigger }, fn)  ->  createFunction({ id, triggers: {...} }, fn)
 *
 * Detection: a CallExpression to *.createFunction whose args are exactly
 *   [ ObjectExpression /* options *​/, ObjectExpression /* trigger *​/, FunctionExpression ]
 * and the second ObjectExpression contains an `event` or `cron` key.
 */
function migrateCreateFunctionTrigger(file, api, root, j) {
  let applied = 0;
  root.find(j.CallExpression, { callee: { property: { name: "createFunction" } } }).forEach((path) => {
    const args = path.node.arguments;
    if (args.length !== 3) return;
    const [optsArg, triggerArg, fnArg] = args;
    if (
      optsArg.type !== "ObjectExpression" ||
      triggerArg.type !== "ObjectExpression" ||
      !["FunctionExpression", "ArrowFunctionExpression"].includes(fnArg.type)
    ) {
      return;
    }

    // Only treat the 2nd arg as a trigger if it looks like one.
    const isTrigger = triggerArg.properties.some(
      (p) => p.type === "Property" && ["event", "cron"].includes(p.key.name)
    );
    if (!isTrigger) return;

    // Merge trigger -> opts.triggers
    optsArg.properties.push(
      j.property("init", j.identifier("triggers"), j.objectExpression(triggerArg.properties))
    );
    // Drop the now-merged trigger argument.
    path.node.arguments = [optsArg, fnArg];

    report(file, "applied", "T1", "createFunction trigger moved into options object", optsArg.loc);
    applied++;
  });
  return applied;
}

/**
 * T2: serveHost -> serveOrigin rename inside object literals / identifiers.
 */
function migrateServeHost(file, api, root, j) {
  let applied = 0;
  root.find(j.Property, { key: { name: "serveHost" } }).forEach((path) => {
    path.node.key.name = "serveOrigin";
    report(file, "applied", "T2", "serveHost renamed to serveOrigin", path.node.loc);
    applied++;
  });
  return applied;
}

/**
 * T3: streaming: "force"|"allow" -> streaming: true.  streaming: false stays false.
 */
function migrateStreaming(file, api, root, j) {
  let applied = 0;
  root.find(j.Property, { key: { name: "streaming" } }).forEach((path) => {
    const v = path.node.value;
    if (v.type === "Literal" && typeof v.value === "string") {
      path.node.value = j.literal(true);
      report(
        file,
        "applied",
        "T3",
        `streaming: "${v.value}" -> streaming: true (v4 requires a boolean)`,
        path.node.loc
      );
      applied++;
    }
  });
  return applied;
}

/**
 * F1: new Inngest({ id: "..." }) with no isDev and no signingKey.
 * v4 defaults to cloud mode and requires a signing key, so flag for review.
 */
function flagMissingIsDev(file, api, root, j) {
  root.find(j.NewExpression, { callee: { name: "Inngest" } }).forEach((path) => {
    const arg = path.node.arguments[0];
    if (!arg || arg.type !== "ObjectExpression") return;
    const names = arg.properties.filter((p) => p.type === "Property").map((p) => p.key.name);
    if (names.includes("isDev") || names.includes("signingKey")) return;
    report(
      file,
      "review",
      "F1",
      "new Inngest({...}) has no isDev/signingKey — v4 cloud mode requires a signing key (decide isDev:true for dev or supply signingKey)",
      path.node.loc
    );
  });
}

/**
 * F2: usage of event.user (removed in v4).
 */
function flagEventUser(file, api, root, j) {
  root.find(j.MemberExpression, { object: { name: "event" }, property: { name: "user" } }).forEach(
    (path) => {
      report(
        file,
        "review",
        "F2",
        "event.user was removed in v4 — move this into event.data and update event sends accordingly",
        path.node.loc
      );
    }
  );
}

module.exports = function transform(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);
  if (!file.path) file.path = "(unknown)";
  const f = file.path;

  let applied = 0;
  applied += migrateCreateFunctionTrigger(f, api, root, j);
  applied += migrateServeHost(f, api, root, j);
  applied += migrateStreaming(f, api, root, j);
  flagMissingIsDev(f, api, root, j);
  flagEventUser(f, api, root, j);

  return applied > 0 ? root.toSource({ quote: "double" }) : null;
};

module.exports.report = report;
