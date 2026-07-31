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
 *   F1  new Inngest({ id }) without isDev/signingKey  ->  requires a runtime/env decision
 *   F2  event.user removed  ->  migrate to event.data
 *
 * This is the "Transformer" module of the migration engine. Unlike the prototype,
 * it is callable programmatically: `applyInngestV3ToV4(source, filePath, sink)`
 * returns the transformed source and pushes report entries to `sink` in-process —
 * no global state, no process boundary (fixing the prototype's report bug).
 */

import { type API, type FileInfo } from "jscodeshift";
import * as jscodeshift from "jscodeshift";
import type { ReportSink } from "../types.js";
import { parseWithParser, toSource } from "./parser.js";

// Builders/j helpers (the parser-specific root comes from parseWithParser).
const j: any = (jscodeshift as any).default ?? (jscodeshift as any);

/**
 * Apply the v3→v4 transform to a single file's source.
 *
 * @returns the new source if any transform applied, otherwise `null`.
 */
export function applyInngestV3ToV4(
  source: string,
  filePath: string,
  sink: ReportSink
): string | null {
  const root = parseWithParser(filePath, source);

  const report = (code: string, kind: "applied" | "review", message: string, loc: any) => {
    sink.push({ file: filePath, kind, code, message, line: loc?.start?.line ?? null });
  };

  let applied = 0;
  applied += migrateCreateFunctionTrigger(filePath, root, j, report);
  applied += migrateServeHost(filePath, root, j, report);
  applied += migrateStreaming(filePath, root, j, report);
  flagMissingIsDev(filePath, root, j, report);
  flagEventUser(filePath, root, j, report);

  return applied > 0 ? toSource(root) : null;
}

/** The same transform exported in jscodeshift's expected signature, for CLI use. */
export default function transform(file: FileInfo, api: API): string | null | undefined {
  const sink: ReportSink = {
    // jscodeshift runs each file in isolation; the CLI driver collects stdout.
    push: (e) => console.log(JSON.stringify(e)),
  };
  return applyInngestV3ToV4(file.source, file.path ?? "(unknown)", sink);
}

type J = any;
type Loc = any;
type ReportFn = (code: string, kind: "applied" | "review", message: string, loc: Loc) => void;

/**
 * T1: createFunction({ id }, { trigger }, fn)  ->  createFunction({ id, triggers: {...} }, fn)
 */
function migrateCreateFunctionTrigger(file: string, root: any, j: J, report: ReportFn): number {
  let applied = 0;
  root
    .find(j.CallExpression, { callee: { property: { name: "createFunction" } } })
    .forEach((path: any) => {
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

      // Only treat the 2nd arg as a trigger if it looks like one. babel parsers
      // emit ObjectProperty for object-literal members.
      const isTrigger = triggerArg.properties.some(
        (p: any) =>
          (p.type === "Property" || p.type === "ObjectProperty") &&
          ["event", "cron"].includes(p.key.name)
      );
      if (!isTrigger) return;

      // Merge trigger -> opts.triggers
      optsArg.properties.push(
        j.property("init", j.identifier("triggers"), j.objectExpression(triggerArg.properties))
      );
      // Drop the now-merged trigger argument.
      path.node.arguments = [optsArg, fnArg];

      report("T1", "applied", "createFunction trigger moved into options object", optsArg.loc);
      applied++;
    });
  return applied;
}

/**
 * T2: serveHost -> serveOrigin rename inside object literals.
 *
 * Note: babel-family parsers (ts/tsx/babel — used via parseWithParser) emit
 * ObjectProperty nodes for object-literal members, not the recast `Property`
 * type. Match ObjectProperty.
 */
function migrateServeHost(_file: string, root: any, j: J, report: ReportFn): number {
  let applied = 0;
  root.find(j.ObjectProperty, { key: { name: "serveHost" } }).forEach((path: any) => {
    path.node.key.name = "serveOrigin";
    report("T2", "applied", "serveHost renamed to serveOrigin", path.node.loc);
    applied++;
  });
  return applied;
}

/**
 * T3: streaming: "force"|"allow" -> streaming: true.  streaming: false stays false.
 */
function migrateStreaming(_file: string, root: any, j: J, report: ReportFn): number {
  let applied = 0;
  root.find(j.ObjectProperty, { key: { name: "streaming" } }).forEach((path: any) => {
    const v = path.node.value;
    // babel parsers use StringLiteral, not Literal.
    if ((v.type === "Literal" || v.type === "StringLiteral") && typeof v.value === "string") {
      path.node.value = j.booleanLiteral(true);
      report(
        "T3",
        "applied",
        `streaming: "${v.value}" -> streaming: true (v4 requires a boolean)`,
        path.node.loc
      );
      applied++;
    }
  });
  return applied;
}

/**
 * F1: new Inngest({ id }) with no isDev and no signingKey. v4 defaults to cloud
 * mode and requires a signing key, so flag for review.
 */
function flagMissingIsDev(_file: string, root: any, j: J, report: ReportFn): void {
  root.find(j.NewExpression, { callee: { name: "Inngest" } }).forEach((path: any) => {
    const arg = path.node.arguments[0];
    if (!arg || arg.type !== "ObjectExpression") return;
    const names = arg.properties
      .filter((p: any) => p.type === "Property" || p.type === "ObjectProperty")
      .map((p: any) => p.key.name);
    if (names.includes("isDev") || names.includes("signingKey")) return;
    report(
      "F1",
      "review",
      "new Inngest({...}) has no isDev/signingKey — v4 cloud mode requires a signing key (decide isDev:true for dev or supply signingKey)",
      path.node.loc
    );
  });
}

/**
 * F2: usage of event.user (removed in v4).
 */
function flagEventUser(_file: string, root: any, j: J, report: ReportFn): void {
  root
    .find(j.MemberExpression, { object: { name: "event" }, property: { name: "user" } })
    .forEach((path: any) => {
      report(
        "F2",
        "review",
        "event.user was removed in v4 — move this into event.data and update event sends accordingly",
        path.node.loc
      );
    });
}
