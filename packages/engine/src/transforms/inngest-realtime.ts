import * as jscodeshift from "jscodeshift";
import { isLocalModule, resolveScannedLocalModule, type LocalModuleSources } from "./local-modules.js";
import { parseWithParser } from "./parser.js";

const j: any = (jscodeshift as any).default ?? jscodeshift;
const legacy = "@inngest/realtime";
const publisherReview = "Review the v3 realtime publisher and its topic payload. In v4, pass the topic reference and data separately. Use inngest.realtime.publish for immediate delivery or step.realtime.publish with a stable step ID for durable delivery outside step callbacks.";
const channelReview = "Replace the legacy channel/topic builders with realtime.channel from inngest. Preserve channel names, topic names and payload schemas.";
const middlewareReview = "Remove the legacy realtime middleware from the Inngest client when migrating to built-in v4 realtime. Trace the publish helper it injected into function handlers.";
const subscriptionReview = "Migrate the legacy subscription or token helper to the built-in inngest/realtime API for your target SDK. Preserve authorization, channel scope, topics and token refresh.";
const hookReview = "Review the legacy realtime subscription hook against the v4 React API for your SDK version. Check token refresh, reconnection and message delivery.";

type Role = "channel" | "client";
type ValueImport = { source: string; imported: string; id: any };
type LocalValue = { role: Role; id: any };
type Report = (message: string, location: any) => void;
type Visible = (path: any, identifier: any) => boolean;
const exportsCache = new WeakMap<LocalModuleSources, Map<string, Map<string, LocalValue>>>();

function legacyModule(source: unknown): source is string {
  return typeof source === "string" && (source === legacy || source.startsWith(`${legacy}/`));
}

function reportImport(source: string, names: string[], location: any, report: Report) {
  const matches = (...values: string[]) => names.some((name: string) => values.includes(name));
  const messages: string[] = [];
  if (source === `${legacy}/middleware` || matches("realtimeMiddleware")) messages.push(middlewareReview);
  if (matches("channel", "topic")) messages.push(channelReview);
  if (matches("getSubscriptionToken", "subscribe")) messages.push(subscriptionReview);
  if (source === `${legacy}/hooks` || matches("useInngestSubscription")) messages.push(hookReview);
  if (!messages.length) messages.push("Review this dependency on the standalone @inngest/realtime package. Migrate the imported types or runtime APIs to the realtime surface supported by the target v4 SDK.");
  for (const message of messages) report(message, location);
}

function method(node: any, name: string): boolean {
  return node?.type === "MemberExpression" && !node.computed && node.property?.name === name;
}

function importedCall(node: any, imports: Map<string, ValueImport>, source: string, name: string): boolean {
  const binding = node?.type === "Identifier" ? imports.get(node.name) : undefined;
  return binding?.source === source && binding.imported === name;
}

function roleOf(initial: any, imports: Map<string, ValueImport>): Role | null {
  let node = initial;
  while (node?.type === "CallExpression" && method(node.callee, "addTopic")) node = node.callee.object;
  if (node?.type === "CallExpression" && importedCall(node.callee, imports, legacy, "channel")) return "channel";
  if (node?.type !== "NewExpression" || !importedCall(node.callee, imports, "inngest", "Inngest")) return null;
  const options = node.arguments[0];
  if (options?.type !== "ObjectExpression") return null;
  const middleware = options.properties.find((p: any) => !p.computed && p.key?.name === "middleware")?.value;
  return middleware?.type === "ArrayExpression" && middleware.elements.some((e: any) => e?.type === "CallExpression"
    && (importedCall(e.callee, imports, `${legacy}/middleware`, "realtimeMiddleware")
      || importedCall(e.callee, imports, legacy, "realtimeMiddleware"))) ? "client" : null;
}

function moduleValues(root: any, report?: Report) {
  const program = root.nodes()[0].program ?? root.nodes()[0];
  const imports = new Map<string, ValueImport>();
  const local = new Map<string, LocalValue>();
  const exported = new Map<string, LocalValue>();
  for (const statement of program.body) {
    const source = statement.source?.value;
    if (report && legacyModule(source)) {
      const names = (statement.specifiers ?? []).map((spec: any) => spec.imported?.name ?? spec.local?.name);
      reportImport(source, names, statement.loc, report);
    }
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    for (const spec of statement.specifiers) {
      if (spec.type === "ImportSpecifier" && spec.importKind !== "type") {
        imports.set(spec.local.name, { source, imported: spec.imported.name, id: spec.local });
      }
    }
  }
  for (const statement of program.body) {
    const decl = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (decl?.type !== "VariableDeclaration" || decl.kind !== "const") continue;
    for (const { id, init } of decl.declarations) {
      const role = roleOf(init, imports);
      if (!role || id.type !== "Identifier") continue;
      const value = { role, id };
      local.set(id.name, value);
      if (statement.type === "ExportNamedDeclaration") exported.set(id.name, value);
    }
  }
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.source || statement.exportKind === "type") continue;
    for (const s of statement.specifiers ?? []) {
      const value = local.get(s.local?.name);
      if (value && s.exportKind !== "type") exported.set(s.exported.name, value);
    }
  }
  return { imports, local, exported };
}

export function reviewLegacyRealtime(root: any, file: string, provenance: LocalModuleSources | undefined,
  report: Report, visible: Visible) {
  const { imports, local } = moduleValues(root, report);
  function resolvedRole(id: any, path: any): Role | undefined {
    if (id?.type !== "Identifier") return;
    const value = local.get(id.name);
    if (value && visible(path, value.id)) return value.role;
    const binding = imports.get(id.name);
    if (!provenance || !binding || !visible(path, binding.id)) return;
    const relative = isLocalModule(binding.source) ? binding.source : provenance.resolveRealtimeAlias?.(file, binding.source);
    if (!relative) return;
    const target = resolveScannedLocalModule(provenance, file, relative);
    if (!target || !target.source.includes(legacy)) return;
    let known = exportsCache.get(provenance);
    if (!known) { known = new Map(); exportsCache.set(provenance, known); }
    let exported = known.get(target.path);
    if (!exported) {
      exported = moduleValues(parseWithParser(target.path, target.source).root).exported;
      known.set(target.path, exported);
    }
    return exported.get(binding.imported)?.role;
  }
  root.find(j.CallExpression).forEach((path: any) => {
    const call = path.node;
    const dependency = call.arguments[0]?.value;
    if (legacyModule(dependency) && (call.callee.type === "Import"
      || (call.callee.type === "Identifier" && call.callee.name === "require" && !path.scope.lookup("require")))) {
      const binding = path.parent?.node;
      const properties = binding?.type === "VariableDeclarator" && binding.id.type === "ObjectPattern" ? binding.id.properties : [];
      reportImport(dependency, properties.map((prop: any) => prop.key?.name), call.loc, report);
    }
    if (method(call.callee, "createFunction")) {
      const context = call.arguments.at(-1)?.params?.[0];
      const publisher = context?.type === "ObjectPattern" && context.properties.find((p: any) => !p.computed && p.key?.name === "publish");
      if (publisher && resolvedRole(call.callee.object, path) === "client") report(publisherReview, publisher.loc);
    }
    if (!(call.callee.type === "Identifier" && call.callee.name === "publish") && !method(call.callee, "publish")) return;
    const topic = call.arguments[0];
    if (topic?.type !== "CallExpression" || topic.callee?.type !== "MemberExpression") return;
    const channel = topic.callee.object;
    if (channel?.type === "CallExpression" && resolvedRole(channel.callee, path) === "channel") report(publisherReview, call.loc);
  });
}

const tokenEndpoint = "https://inn.gs/e/";
function isRealtimeTokenUrl(node: any): boolean {
  if (!node) return false;
  let literal = node.value;
  if (node.type === "TemplateLiteral") {
    if (node.expressions.length === 0) literal = node.quasis[0]?.value.cooked;
    else return node.expressions.length === 1 && node.quasis[0]?.value.cooked === tokenEndpoint
      && node.quasis[1]?.value.cooked === "" && isTokenReference(node.expressions[0]);
  }
  if (node.type === "BinaryExpression" && node.operator === "+" && node.left?.value === tokenEndpoint) {
    return isTokenReference(node.right);
  }
  return typeof literal === "string" && literal.startsWith(tokenEndpoint)
    && /^[\w.~-]+$/.test(literal.slice(tokenEndpoint.length));
}

function isTokenReference(node: any): boolean {
  return node?.type === "Identifier" || node?.type === "MemberExpression";
}

function hasNativeBinding(name: string, path: any, noLexicalDeclaration: (name: string, path: any) => boolean) {
  if (!noLexicalDeclaration(name, path)) return false;
  const scope = path.scope.lookup(name);
  if (!scope) return true;
  // ast-types includes sibling blocks' let/const bindings in the enclosing scope.
  const ancestors = new Set();
  for (let p = path; p; p = p.parentPath) ancestors.add(p.node);
  return scope.getBindings()[name].every((binding: any) => {
    const declaration = binding.parent?.parent?.node;
    const block = binding.parent?.parent?.parent?.node;
    return declaration?.type === "VariableDeclaration" && declaration.kind !== "var"
      && block?.type === "BlockStatement" && !ancestors.has(block);
  });
}

export function reviewNativeRealtimeSubscribers(root: any, report: Report, noLexicalDeclaration: (name: string, path: any) => boolean) {
  root.find(j.NewExpression).forEach((path: any) => {
    const { callee, arguments: args } = path.node;
    if (!isRealtimeTokenUrl(args[0])) return;
    const native = callee.type === "Identifier" && callee.name === "EventSource" && hasNativeBinding("EventSource", path, noLexicalDeclaration);
    const global = method(callee, "EventSource") && callee.object?.type === "Identifier"
      && ["window", "globalThis"].includes(callee.object.name) && hasNativeBinding(callee.object.name, path, noLexicalDeclaration);
    if (native || global) report("Review this native EventSource subscription to the Inngest token endpoint. Use the target SDK subscription API with its scoped token object. In 4.24.0 this object includes key, channel, topics and apiBaseUrl. Verify authorized topics, reconnection and delivery with a real subscriber.", path.node.loc);
  });
}
