/**
 * Knock Node.js SDK migration: v0.x → v1.0
 *
 * Implements mechanical (deterministic) transforms from the official v0→v1
 * migration guide. This is the SECOND transform set in the engine — it exists
 * to prove the engine is provider-agnostic (manifest-driven dispatch selects
 * which set runs), not hardcoded to Inngest.
 *
 * Transforms applied (deterministic):
 *   K1  knockClient.notify(...)  ->  client.workflows.trigger(...)
 *   K2  client.users.identify(...)  ->  client.users.update(...)
 *   K3  query/body param renames: camelCase -> snake_case for known keys
 *        (cancellationKey -> cancellation_key, pageSize -> page_size)
 *
 * Transforms flagged for review (structural):
 *   KF1  new Knock("sk_...")  ->  new Knock({ apiKey: ... })  (needs an env ref)
 *
 * Reference: https://docs.knock.app/developer-tools/migration-guides/node
 */

import { type API, type FileInfo } from "jscodeshift";
import * as jscodeshift from "jscodeshift";
import type { ReportSink } from "../types.js";
import { parseWithParser, toSource } from "./parser.js";

const j: any = (jscodeshift as any).default ?? (jscodeshift as any);

export function applyKnockV0ToV1(
  source: string,
  filePath: string,
  sink: ReportSink
): string | null {
  const root = parseWithParser(filePath, source);
  const report = (code: string, kind: "applied" | "review", message: string, loc: any) => {
    sink.push({ file: filePath, kind, code, message, line: loc?.start?.line ?? null });
  };

  let applied = 0;
  applied += migrateMethodRename(
    filePath,
    root,
    j,
    report,
    "notify",
    ["workflows", "trigger"],
    "K1",
    "knockClient.notify(...) -> client.workflows.trigger(...)"
  );
  applied += migrateMethodRenameThroughMember(
    filePath,
    root,
    j,
    report,
    "users",
    "identify",
    "update",
    "K2",
    "client.users.identify(...) -> client.users.update(...)"
  );
  applied += migrateParamRenames(filePath, root, j, report);
  flagClientInit(filePath, root, j, report);

  return applied > 0 ? toSource(root) : null;
}

export default function transform(file: FileInfo, api: API): string | null | undefined {
  const sink: ReportSink = { push: (e) => console.log(JSON.stringify(e)) };
  return applyKnockV0ToV1(file.source, file.path ?? "(unknown)", sink);
}

type ReportFn = (code: string, kind: "applied" | "review", message: string, loc: any) => void;

/**
 * K1: `x.notify(args)` -> `x.workflows.trigger(args)`.
 * Renames the method AND nests it under `.workflows`.
 */
function migrateMethodRename(
  _file: string,
  root: any,
  j: any,
  report: ReportFn,
  oldMethod: string,
  newPath: string[],
  code: string,
  message: string
): number {
  let applied = 0;
  root
    .find(j.CallExpression, { callee: { property: { name: oldMethod } } })
    .forEach((path: any) => {
      const callee = path.node.callee;
      // Build: <receiver>.workflows.trigger
      const newObj = j.memberExpression(
        j.memberExpression(callee.object, j.identifier(newPath[0]!)),
        j.identifier(newPath[1]!)
      );
      path.node.callee = newObj;
      report(code, "applied", message, path.node.loc);
      applied++;
    });
  return applied;
}

/**
 * K2: `x.users.identify(args)` -> `x.users.update(args)` (rename only, no nest).
 */
function migrateMethodRenameThroughMember(
  _file: string,
  root: any,
  j: any,
  report: ReportFn,
  mid: string,
  oldMethod: string,
  newMethod: string,
  code: string,
  message: string
): number {
  let applied = 0;
  root
    .find(j.CallExpression, {
      callee: {
        type: "MemberExpression",
        object: { property: { name: mid } },
        property: { name: oldMethod },
      },
    })
    .forEach((path: any) => {
      path.node.callee.property.name = newMethod;
      report(code, "applied", message, path.node.loc);
      applied++;
    });
  return applied;
}

/** camelCase -> snake_case param renames the engine knows about. */
const PARAM_RENAMES: Record<string, string> = {
  cancellationKey: "cancellation_key",
  pageSize: "page_size",
};

/**
 * K3: rename known object-literal keys (params) from camelCase to snake_case.
 *
 * Note: babel-family parsers (ts/tsx/babel — what we always use now via
 * parseWithParser) emit ObjectProperty nodes for object-literal properties,
 * NOT the recast `Property` type. Match ObjectProperty.
 */
function migrateParamRenames(_file: string, root: any, j: any, report: ReportFn): number {
  let applied = 0;
  for (const [from, to] of Object.entries(PARAM_RENAMES)) {
    root.find(j.ObjectProperty, { key: { name: from } }).forEach((path: any) => {
      path.node.key.name = to;
      report("K3", "applied", `param rename: ${from} -> ${to}`, path.node.loc);
      applied++;
    });
  }
  return applied;
}

/**
 * KF1: `new Knock("sk_...")` (string arg) -> flag for review; v1 wants an
 * options object with apiKey. Auto-rewriting would require choosing an env var.
 */
function flagClientInit(_file: string, root: any, j: any, report: ReportFn): void {
  root
    .find(j.NewExpression, { callee: { name: "Knock" } })
    .forEach((path: any) => {
      const arg = path.node.arguments[0];
      // babel parsers use StringLiteral; recast uses Literal. Accept both.
      const isString =
        arg &&
        ((arg.type === "Literal" && typeof arg.value === "string") ||
          arg.type === "StringLiteral");
      if (isString) {
        report(
          "KF1",
          "review",
          'new Knock("...") -> new Knock({ apiKey: process.env.KNOCK_API_KEY }) (v1 requires an options object)',
          path.node.loc
        );
      }
    });
}
