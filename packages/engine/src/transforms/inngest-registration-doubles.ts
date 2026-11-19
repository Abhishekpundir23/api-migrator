import * as jscodeshift from "jscodeshift";
import { resolveOwnerEmittedTypeScriptModule, resolveScannedLocalModule, type LocalModuleSources } from "./local-modules.js";

const j: any = (jscodeshift as any).default ?? jscodeshift;
const advice = "Update this v3 createFunction test double to accept (options, handler). Read triggers from options.triggers. A v4 call supplies no third argument.";

export function reviewRegistrationDoubles(
  root: any,
  file: string,
  sources: LocalModuleSources | undefined,
  exportsClient: (source: string, file: string, name: string) => boolean,
  report: (message: string, loc: any) => void,
): void {
  if (!/(?:^|\/)(?:__tests__|__mocks__|tests?|spec)\/|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(file)) return;
  const calls = root.find(j.CallExpression).paths();
  const spyFactories = new Set(calls.filter((p: any) => isMockMethod(p.node, "fn", p)).map((p: any) => p.node));
  calls.forEach((path: any) => {
    const call = path.node;
    if (!isMockMethod(call, "mock", path)) return;
    const target = call.arguments[0]?.value;
    if (typeof target !== "string") return;
    const mocked = returnValue(call.arguments[1]);
    if (mocked?.type !== "ObjectExpression") return;
    const local = sources && mockedLocalModule(sources, file, target);
    for (const entry of mocked.properties) {
      const name = key(entry);
      if (!name) continue;
      let instance = entry.value;
      if (target === "inngest" && name === "Inngest") {
        if (spyFactories.has(instance)) instance = instance.arguments[0];
        instance = returnValue(instance) ?? instance;
      } else if (!local || !exportsClient(local.source, local.path, name)) continue;

      const members = instance?.type === "ObjectExpression" ? instance.properties
        : instance?.type === "ClassExpression" ? instance.body.body : [];
      for (const member of members) {
        if (key(member) !== "createFunction" || member.static) continue;
        let implementation = member.value ?? member;
        if (spyFactories.has(implementation)) implementation = implementation.arguments[0];
        if (implementation?.params?.length === 3 && implementation.params[2].type !== "RestElement") {
          report(advice, member.loc);
        }
      }
    }
  });
}

function mockedLocalModule(sources: LocalModuleSources, file: string, target: string) {
  const ext = target.match(/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/)?.[0];
  if (!ext) return resolveScannedLocalModule(sources, file, target);
  const exact = resolveScannedLocalModule(sources, file, target.slice(0, -ext.length));
  if (exact?.path.endsWith(ext) && !/\.d\.[cm]?ts$/.test(exact.path)) return exact;
  return resolveOwnerEmittedTypeScriptModule(sources, file, target);
}

function key(member: any): string | null {
  if (!member?.key || (member.computed && typeof member.key.value !== "string")) return null;
  return member.key.name ?? member.key.value ?? null;
}

function returnValue(fn: any): any {
  if (!["ArrowFunctionExpression", "FunctionExpression", "ObjectMethod"].includes(fn?.type)) return null;
  if (fn.body.type !== "BlockStatement") return fn.body;
  const returns = fn.body.body.filter((node: any) => node.type === "ReturnStatement");
  return returns.length === 1 ? returns[0].argument : null;
}

/** A test's global vi/jest or the actual imported mock API, including named aliases. */
function isMockMethod(call: any, method: string, path: any): boolean {
  const member = call?.callee;
  if (call?.type !== "CallExpression" || member?.type !== "MemberExpression"
    || member.computed || member.property.name !== method || member.object.type !== "Identifier") return false;
  const name = member.object.name;
  const scope = path.scope.lookup(name);
  if (!scope) return name === "vi" || name === "jest";
  const references = scope.getBindings()[name];
  if (references?.length !== 1) return false;
  const spec = references[0].parentPath;
  const imported = spec?.node;
  if (imported?.type !== "ImportSpecifier" || imported.importKind === "type") return false;
  const declaration = spec.parent?.node;
  return declaration?.type === "ImportDeclaration" && declaration.importKind !== "type"
    && ((declaration.source.value === "vitest" && imported.imported.name === "vi")
      || (declaration.source.value === "@jest/globals" && imported.imported.name === "jest"));
}
