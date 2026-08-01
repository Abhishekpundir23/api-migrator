/** Binding-aware Inngest TypeScript SDK v3 -> v4 migration. */

import { type API, type FileInfo } from "jscodeshift";
import * as jscodeshift from "jscodeshift";
import { posix } from "node:path";
import { TRANSFORM_ALLOWLIST } from "../manifest.js";
import type { ReportEntry, ReportSink } from "../types.js";
import { parseWithParser, toSource } from "./parser.js";

const j: any = (jscodeshift as any).default ?? (jscodeshift as any);
const ALL = new Set<string>(TRANSFORM_ALLOWLIST["inngest-v3-to-v4"]);

interface ScopedBinding {
  scopeNode: object;
  declarationNode: object;
}
type ScopedBindings = Map<string, ScopedBinding[]>;

interface LocalImportBinding {
  source: string;
  importedName: string | null;
  eligibleNamedImport: boolean;
  namespaceLike: boolean;
  provenClient: boolean;
  scopeNode: object;
  declarationNode: object;
}

export interface InngestProvenanceContext {
  /** Original contents of exactly the source files selected by the repository scan. */
  scannedSources: ReadonlyMap<string, string>;
  /** Every supported regular source path, including files that did not match the SDK scan. */
  sourcePaths: ReadonlySet<string>;
}

interface Bindings {
  constructors: ScopedBindings;
  namespaces: ScopedBindings;
  clients: ScopedBindings;
  serve: ScopedBindings;
  connect: ScopedBindings;
  middleware: ScopedBindings;
  eventSchemas: ScopedBindings;
  internalFunction: ScopedBindings;
  localImports: Map<string, LocalImportBinding[]>;
  unsafeClients: Array<{ name: string; loc: any; message: string }>;
}

type ReportFn = (code: string, kind: "applied" | "review", message: string, loc: any) => void;

export function applyInngestV3ToV4(
  source: string,
  filePath: string,
  sink: ReportSink,
  enabled: ReadonlySet<string> = ALL,
  provenance?: InngestProvenanceContext
): string | null {
  const root = parseWithParser(filePath, source);
  const bindings = collectBindings(root, filePath, provenance);
  const emitted = new Set<string>();
  const report: ReportFn = (code, kind, message, loc) => {
    if (!enabled.has(code)) return;
    const key = `${code}:${kind}:${locationKey(loc)}:${message}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    sink.push({ file: filePath, kind, code, message, line: loc?.start?.line ?? null });
  };
  const blockingReview: ReportFn = (code, _kind, message, loc) => {
    const key = `${code}:review:${locationKey(loc)}:${message}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    sink.push({ file: filePath, kind: "review", code, message, line: loc?.start?.line ?? null });
  };

  flagUnsupportedModuleLoading(root, blockingReview);
  flagUntraceableReexports(root, blockingReview);
  flagDynamicCodeEvaluation(root, blockingReview);
  flagUnsafeClientReferences(bindings, blockingReview);
  flagCreateFunctionMutationApis(root, bindings, blockingReview);
  flagDynamicComputedImportedCalls(root, bindings, blockingReview);
  flagUnprovenCreateFunctionUsage(root, bindings, blockingReview);
  flagUnsupportedCreateFunctionReferences(root, blockingReview);

  let applied = 0;
  if (enabled.has("T1")) applied += migrateCreateFunctionTrigger(root, bindings, report);
  if (enabled.has("T2")) applied += migrateServeHost(root, bindings, report);
  if (enabled.has("T3")) applied += migrateStreaming(root, bindings, report);
  if (enabled.has("T4")) applied += migrateGateway(root, bindings, report);

  flagClientMode(root, bindings, report);
  flagHandlerChanges(root, bindings, report);
  flagMiddleware(root, bindings, report);
  flagEventSchemas(root, bindings, report);
  flagServeOptions(root, bindings, report);
  flagLogLevel(root, bindings, report);
  flagConnect(root, bindings, report);
  flagInternalFunctionType(root, bindings, report);
  flagCheckpointRuntime(root, bindings, report);

  return applied > 0 ? toSource(root) : null;
}

export default function transform(file: FileInfo, _api: API): string | null | undefined {
  const sink: ReportSink = { push: (entry) => console.log(JSON.stringify(entry)) };
  return applyInngestV3ToV4(file.source, file.path ?? "(unknown)", sink);
}

/** Review items that are behavioral and cannot be tied reliably to one AST node. */
export function inngestBehavioralReviewEntries(enabled: ReadonlySet<string>): ReportEntry[] {
  const definitions: Array<[string, string]> = [
    ["F11", "Inngest v4 enables optimized parallelism by default; review concurrency/rate-limit assumptions and ordering-sensitive functions."],
    ["F12", "Inngest v4 enables checkpointing by default and changes maxRuntime behavior; review long-running functions, retries, and timeout expectations."],
    ["F13", "Inngest v4 includes edge-runtime execution changes; exercise deployed edge handlers even when static type-checking passes."],
  ];
  return definitions
    .filter(([code]) => enabled.has(code))
    .map(([code, message]) => ({ file: "(migration)", kind: "review", code, message, line: null }));
}

function collectBindings(root: any, filePath: string, provenance?: InngestProvenanceContext): Bindings {
  const bindings: Bindings = {
    constructors: new Map(), namespaces: new Map(), clients: new Map(), serve: new Map(),
    connect: new Map(), middleware: new Map(), eventSchemas: new Map(), internalFunction: new Map(),
    localImports: new Map(),
    unsafeClients: [],
  };
  root.find(j.ImportDeclaration).forEach((path: any) => {
    const source = String(path.node.source.value ?? "");
    if (!isInngestModule(source)) {
      if (source) {
        for (const specifier of path.node.specifiers ?? []) {
          const local = specifier.local?.name;
          if (!local) continue;
          const named = specifier.type === "ImportSpecifier";
          const importedName = named ? identifierName(specifier.imported) : null;
          const typeOnly = path.node.importKind === "type" || specifier.importKind === "type";
          addLocalImport(
            bindings.localImports,
            local,
            source,
            importedName,
            named && !typeOnly && importedName !== "default",
            specifier.type === "ImportNamespaceSpecifier",
            path,
            specifier.local
          );
        }
      }
      return;
    }
    for (const specifier of path.node.specifiers ?? []) {
      if (path.node.importKind === "type" || specifier.importKind === "type") continue;
      if (specifier.type === "ImportNamespaceSpecifier") {
        if (specifier.local?.name) addScopedBinding(bindings.namespaces, specifier.local.name, path, specifier.local);
        continue;
      }
      const imported = specifier.imported?.name;
      const local = specifier.local?.name ?? imported;
      if (!local) continue;
      if (imported === "Inngest") addScopedBinding(bindings.constructors, local, path, specifier.local ?? specifier.imported);
      if (imported === "serve") addScopedBinding(bindings.serve, local, path, specifier.local ?? specifier.imported);
      if (imported === "connect") addScopedBinding(bindings.connect, local, path, specifier.local ?? specifier.imported);
      if (imported === "InngestMiddleware") addScopedBinding(bindings.middleware, local, path, specifier.local ?? specifier.imported);
      if (imported === "EventSchemas") addScopedBinding(bindings.eventSchemas, local, path, specifier.local ?? specifier.imported);
      if (imported === "InngestFunction") addScopedBinding(bindings.internalFunction, local, path, specifier.local ?? specifier.imported);
    }
  });
  root.find(j.Node).forEach((path: any) => {
    if (path.node?.type !== "TSImportEqualsDeclaration" || path.node.id?.type !== "Identifier") return;
    const source = literalString(path.node.moduleReference?.expression);
    if (!source || !isPotentialConfiguredClientModule(source)) return;
    addLocalImport(bindings.localImports, path.node.id.name, source, null, false, true, path, path.node.id);
  });
  root.find(j.VariableDeclarator).forEach((path: any) => {
    const source = staticLocalLoaderSource(path.node.init);
    if (!source) return;
    for (const identifier of patternIdentifiers(path.node.id)) {
      addLocalImport(bindings.localImports, identifier.name, source, null, false, true, path, identifier);
    }
  });
  filterUnsafeConstructorBindings(root, bindings);
  proveDirectLocalClients(root, bindings, filePath, provenance);
  root.find(j.VariableDeclarator).forEach((path: any) => {
    const { id, init } = path.node;
    if (id?.type !== "Identifier" || init?.type !== "NewExpression"
      || !isConstructor(init.callee, bindings, path)) {
      return;
    }
    if (variableDeclarationKind(path) !== "const") {
      bindings.unsafeClients.push({
        name: id.name,
        loc: id.loc ?? path.node.loc,
        message: `Inngest client ${id.name} is mutable; use a const binding and migrate computed or aliased calls manually.`,
      });
      return;
    }
    if (directClientReferencesAreSafe(root, id.name, path, id, bindings)) {
      addScopedBinding(bindings.clients, id.name, path, id);
    } else {
      bindings.unsafeClients.push({
        name: id.name,
        loc: id.loc ?? path.node.loc,
        message: `Inngest client ${id.name} has an alias, mutation, computed access, or indirect reference; migrate its createFunction usage manually.`,
      });
    }
  });
  return bindings;
}

/** Unsupported module-loading forms are never rewritten, but must block publication. */
function flagUnsupportedModuleLoading(root: any, report: ReportFn): void {
  root.find(j.Node).forEach((path: any) => {
    const node = path.node as any;
    let source: string | null = null;
    let loader: string | null = null;
    if (node?.type === "CallExpression") {
      loader = node.callee?.type === "Identifier" && node.callee.name === "require"
        ? "require"
        : node.callee?.type === "Import"
          ? "import"
          : null;
      if (loader) source = literalString(node.arguments?.[0]);
    } else if (node?.type === "ImportExpression") {
      loader = "import";
      source = literalString(node.source);
    } else if (node?.type === "TSImportEqualsDeclaration") {
      loader = "import-equals";
      source = literalString(node.moduleReference?.expression);
    }
    if (!loader) return;
    if (!source) {
      report(
        "T1",
        "review",
        `Non-literal ${loader} target cannot be proven unrelated to an Inngest client or wrapper; replace it with a static import or review manually.`,
        node.loc
      );
      return;
    }
    if (!isInngestModule(source)) {
      if (isLikelyConfiguredModuleSource(source)) {
        report(
          "T1",
          "review",
          `Unsupported ${loader} loading of possible configured-client local module ${JSON.stringify(source)}; use a relative static named import or migrate manually.`,
          node.loc
        );
      }
      return;
    }
    report(
      "F1",
      "review",
      `Unsupported ${node.type} loading of ${source}; convert it to a static SDK import before migration.`,
      node.loc
    );
  });
}

function flagUntraceableReexports(root: any, report: ReportFn): void {
  root.find(j.Node).forEach((path: any) => {
    const node = path.node as any;
    if (node?.type !== "ExportNamedDeclaration" && node?.type !== "ExportAllDeclaration") return;
    const source = literalString(node.source);
    if (!source) return;
    const suspiciousSpecifier = node.type === "ExportNamedDeclaration"
      && (node.specifiers ?? []).some((specifier: any) =>
        specifier?.type === "ExportSpecifier" && specifier.exportKind !== "type"
          && (looksLikePotentialClientExportName(identifierName(specifier.local) ?? "")
            || looksLikePotentialClientExportName(identifierName(specifier.exported) ?? ""))
      );
    if (!isStrongInngestModuleSource(source) && !suspiciousSpecifier) return;
    report(
      "T1",
      "review",
      `Re-export from ${JSON.stringify(source)} can create an untraceable configured-client alias; import and export the client directly or migrate manually.`,
      node.loc
    );
  });
}

function flagDynamicCodeEvaluation(root: any, report: ReportFn): void {
  root.find(j.Node).forEach((path: any) => {
    const node = path.node as any;
    const directEval = node?.type === "CallExpression" && (
      (node.callee?.type === "Identifier" && node.callee.name === "eval")
      || (node.callee?.type === "MemberExpression" && propertyName(node.callee.property) === "eval")
    );
    const functionConstructor = (node?.type === "CallExpression" || node?.type === "NewExpression")
      && node.callee?.type === "Identifier" && node.callee.name === "Function";
    if (!directEval && !functionConstructor) return;
    report(
      "T1",
      "review",
      "Dynamic code evaluation prevents reliable Inngest client provenance; remove it or review this migration manually.",
      node.loc
    );
  });
}

function flagUnsafeClientReferences(bindings: Bindings, report: ReportFn): void {
  for (const client of bindings.unsafeClients) {
    report("T1", "review", client.message, client.loc);
  }
}

/** Reflective writes can replace createFunction without a direct member assignment. */
function flagCreateFunctionMutationApis(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.CallExpression).forEach((path: any) => {
    const call = path.node;
    const owner = call.callee?.type === "MemberExpression" && !call.callee.computed
      && call.callee.object?.type === "Identifier"
      ? call.callee.object.name
      : null;
    const method = call.callee?.type === "MemberExpression" && !call.callee.computed
      ? propertyName(call.callee.property)
      : null;
    const target = call.arguments?.[0];
    if (!isTrackedInngestMutationTarget(target, path, bindings)) return;
    let mutatesCreateFunction = false;
    if ((owner === "Object" && method === "defineProperty")
      || (owner === "Reflect" && ["set", "defineProperty"].includes(method ?? ""))) {
      mutatesCreateFunction = staticStringValue(call.arguments?.[1]) === "createFunction";
    } else if (owner === "Object" && method === "assign") {
      mutatesCreateFunction = (call.arguments ?? []).slice(1).some(objectDefinesCreateFunction);
    } else if (owner === "Object" && ["defineProperties", "setPrototypeOf", "create"].includes(method ?? "")) {
      mutatesCreateFunction = objectDefinesCreateFunction(call.arguments?.[1]);
    }
    if (!mutatesCreateFunction) return;
    report(
      "T1",
      "review",
      `${owner}.${method} may replace createFunction; remove the mutation or migrate the affected call manually.`,
      call.loc
    );
  });
}

function objectDefinesCreateFunction(node: any): boolean {
  return node?.type === "ObjectExpression" && (node.properties ?? []).some((property: any) =>
    (isObjectProperty(property) || property?.type === "ObjectMethod")
      && staticMemberKeyName(property) === "createFunction"
  );
}

function isTrackedInngestMutationTarget(node: any, path: any, bindings: Bindings): boolean {
  const receiver = rootReceiverIdentifier(node);
  if (!receiver) return false;
  if (hasScopedBinding(bindings.clients, receiver.name, path)
    || hasScopedBinding(bindings.constructors, receiver.name, path)
    || hasScopedBinding(bindings.namespaces, receiver.name, path)
    || bindings.unsafeClients.some((candidate) => candidate.name === receiver.name)) {
    return true;
  }
  const imported = localImportAt(bindings.localImports, receiver.name, path);
  return imported != null && looksLikeConfiguredClientCandidate(imported, receiver.name);
}

function staticMemberKeyName(property: any): string | null {
  return property?.computed ? staticStringValue(property.key) : propertyName(property?.key);
}

/** Unknown computed calls on configured-client imports cannot be classified safely. */
function flagDynamicComputedImportedCalls(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.Node).forEach((path: any) => {
    const call = path.node as any;
    if (call?.type !== "CallExpression" && call?.type !== "OptionalCallExpression") return;
    const member = call.callee;
    if ((member?.type !== "MemberExpression" && member?.type !== "OptionalMemberExpression")
      || !member.computed || staticMemberPropertyName(member) != null) {
      return;
    }
    const receiver = rootReceiverIdentifier(member.object);
    if (!receiver || !localImportAt(bindings.localImports, receiver.name, path)) return;
    report(
      "T1",
      "review",
      `Computed method call on imported binding ${receiver.name} cannot be proven unrelated to createFunction; migrate or exclude it manually.`,
      call.loc
    );
  });
}

/** Every createFunction call not tied to an immutable proven client blocks publication. */
function flagUnprovenCreateFunctionUsage(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.Node).forEach((path: any) => {
    const member = createFunctionMember(path.node);
    if (!member) return;
    if (member.type === "MemberExpression" && isClientMethod(member, bindings, "createFunction", path)) {
      if (![2, 3].includes(path.node.arguments?.length ?? -1)) {
        report(
          "T1",
          "review",
          "Proven Inngest client uses an unexpected createFunction arity; migrate this call manually.",
          path.node.loc
        );
      }
      return;
    }
    const inlineSource = staticLocalLoaderSource(member.object);
    if (inlineSource) {
      report(
        "T1",
        "review",
        `Configured client is accessed through an unsupported loader for local module or path alias ${JSON.stringify(inlineSource)}; use a static named import or migrate this call manually.`,
        path.node.loc
      );
      return;
    }
    const receiver = rootReceiverIdentifier(member.object);
    if (!receiver) {
      report(
        "T1",
        "review",
        "Unproved createFunction receiver could not be traced to an immutable Inngest client; migrate or exclude this call manually.",
        path.node.loc
      );
      return;
    }
    const local = localImportAt(bindings.localImports, receiver.name, path);
    if (local) {
      report(
        "T1",
        "review",
        `Configured client receiver rooted at ${receiver.name} comes from local module or path alias ${JSON.stringify(local.source)}; trace its SDK construction and migrate this call manually.`,
        path.node.loc
      );
      return;
    }
    report(
      "T1",
      "review",
      `Unproved createFunction receiver ${receiver.name} is not an immutable client constructed from a static Inngest import; migrate or exclude this call manually.`,
      path.node.loc
    );
  });
}

/** A createFunction member that is not the direct callee can be rebound or invoked indirectly. */
function flagUnsupportedCreateFunctionReferences(root: any, report: ReportFn): void {
  root.find(j.Node).forEach((path: any) => {
    const node = path.node as any;
    if (node?.type !== "MemberExpression" && node?.type !== "OptionalMemberExpression") return;
    if (staticMemberPropertyName(node) !== "createFunction" || isDirectMemberCall(path)) return;
    report(
      "T1",
      "review",
      "createFunction is referenced outside a direct method call; do not rebind, overwrite, or invoke it through call/bind before migrating manually.",
      node.loc
    );
  });
}

function migrateCreateFunctionTrigger(root: any, bindings: Bindings, report: ReportFn): number {
  let applied = 0;
  root.find(j.CallExpression).forEach((path: any) => {
    if (!isClientMethod(path.node.callee, bindings, "createFunction", path)) return;
    const args = path.node.arguments;
    if (args.length !== 3) return;
    const [options, trigger, handler] = args;
    const handlerIsFunction = handler && ["FunctionExpression", "ArrowFunctionExpression"].includes(handler.type);
    const triggerIsObject = trigger?.type === "ObjectExpression";
    const looksLikeTrigger = triggerIsObject && trigger.properties.some((property: any) =>
      isObjectProperty(property) && ["event", "cron"].includes(propertyName(property.key) ?? "")
    );
    if (options?.type !== "ObjectExpression" || !looksLikeTrigger || !handlerIsFunction) {
      report("T1", "review", "Three-argument createFunction call could not be migrated safely; move its trigger into options.triggers manually.", path.node.loc);
      return;
    }
    if (directProperty(options, "triggers")) {
      report("T1", "review", "createFunction already has options.triggers as well as a legacy trigger argument; merge them manually.", path.node.loc);
      return;
    }
    options.properties.push(j.objectProperty(j.identifier("triggers"), j.objectExpression(trigger.properties)));
    path.node.arguments = [options, handler];
    report("T1", "applied", "createFunction trigger moved into options.triggers", path.node.loc);
    applied++;
  });
  return applied;
}

function migrateServeHost(root: any, bindings: Bindings, report: ReportFn): number {
  let applied = 0;
  root.find(j.ObjectProperty).forEach((path: any) => {
    if (propertyName(path.node.key) !== "serveHost" || !belongsToConfig(path, bindings, ["client", "serve"])) return;
    replacePropertyName(path.node, "serveOrigin");
    report("T2", "applied", "serveHost renamed to serveOrigin", path.node.loc);
    applied++;
  });
  return applied;
}

function migrateStreaming(root: any, bindings: Bindings, report: ReportFn): number {
  let applied = 0;
  root.find(j.ObjectProperty).forEach((path: any) => {
    if (propertyName(path.node.key) !== "streaming" || !belongsToConfig(path, bindings, ["client", "serve"])) return;
    const value = path.node.value;
    if ((value?.type === "StringLiteral" || value?.type === "Literal") && typeof value.value === "string") {
      const normalized = value.value.toLowerCase();
      const mapped = normalized === "force" || normalized === "true"
        ? true
        : normalized === "false" || normalized === "off" || normalized === "disabled"
          ? false
          : null;
      if (mapped == null) {
        report(
          "T3",
          "review",
          `Unknown legacy streaming mode ${JSON.stringify(value.value)} cannot be mapped safely to a v4 boolean.`,
          path.node.loc
        );
        return;
      }
      path.node.value = j.booleanLiteral(mapped);
      report("T3", "applied", `streaming: ${JSON.stringify(value.value)} converted to the v4 boolean option`, path.node.loc);
      applied++;
    } else if (value?.type !== "BooleanLiteral" && !(value?.type === "Literal" && typeof value.value === "boolean")) {
      report("T3", "review", "Dynamic streaming option must resolve to a boolean in v4.", path.node.loc);
    }
  });
  return applied;
}

function migrateGateway(root: any, bindings: Bindings, report: ReportFn): number {
  let applied = 0;
  root.find(j.ObjectProperty).forEach((path: any) => {
    if (propertyName(path.node.key) !== "rewriteGatewayEndpoint" || !belongsToConfig(path, bindings, ["connect"])) return;
    replacePropertyName(path.node, "gatewayUrl");
    report("T4", "applied", "Connect rewriteGatewayEndpoint renamed to gatewayUrl", path.node.loc);
    applied++;
  });
  return applied;
}

function flagClientMode(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.NewExpression).forEach((path: any) => {
    if (!isConstructor(path.node.callee, bindings, path)) return;
    const options = path.node.arguments[0];
    if (options?.type !== "ObjectExpression") {
      report("F1", "review", "Inngest client configuration is dynamic; confirm v4 cloud mode, isDev, and signingKey behavior.", path.node.loc);
      return;
    }
    if (!["isDev", "signingKey"].some((name) => directProperty(options, name))) {
      report("F1", "review", "v4 defaults to cloud mode; explicitly choose isDev for development or provide a signingKey.", path.node.loc);
    }
  });
}

function flagHandlerChanges(root: any, bindings: Bindings, report: ReportFn): void {
  for (const { handler, eventNames, stepNames, contextNames } of functionHandlers(root, bindings)) {
    j(handler).find(j.MemberExpression).forEach((path: any) => {
      if (propertyName(path.node.property) === "user" && isContextMember(path.node.object, eventNames, contextNames, "event")) {
        report("F2", "review", "event.user was removed in v4; move this data into event.data and update event producers.", path.node.loc);
      }
      if (propertyName(path.node.property) === "invoke" && isContextMember(path.node.object, stepNames, contextNames, "step")) {
        const call = path.parentPath?.node;
        const first = call?.type === "CallExpression" ? call.arguments[0] : null;
        if (first && (first.type === "StringLiteral" || first.type === "Literal") && typeof first.value === "string") {
          report("F7", "review", "step.invoke no longer accepts a string function id; import/reference the target function and pass it directly.", call.loc);
        }
      }
    });
  }
}

function flagMiddleware(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.Identifier).forEach((path: any) => {
    if (!hasScopedBinding(bindings.middleware, path.node.name, path)) return;
    if (path.parentPath?.node?.type === "ImportSpecifier") return;
    report("F3", "review", "InngestMiddleware hooks were redesigned in v4; rewrite this middleware using the v4 middleware lifecycle.", path.node.loc);
  });
  root.find(j.ObjectProperty).forEach((path: any) => {
    if (propertyName(path.node.key) === "middleware" && belongsToConfig(path, bindings, ["client"])) {
      report("F3", "review", "Review all configured middleware against the v4 middleware hook contract.", path.node.loc);
    }
  });
}

function flagEventSchemas(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.Identifier).forEach((path: any) => {
    if (!hasScopedBinding(bindings.eventSchemas, path.node.name, path) || path.parentPath?.node?.type === "ImportSpecifier") return;
    report("F4", "review", "EventSchemas was removed; replace schema declarations with eventType/staticSchema entries.", path.node.loc);
  });
}

function flagServeOptions(root: any, bindings: Bindings, report: ReportFn): void {
  const moved = new Set(["baseUrl", "fetch", "signingKey", "signingKeyFallback"]);
  root.find(j.CallExpression).forEach((path: any) => {
    if (!isServeCall(path.node.callee, bindings, path)) return;
    const options = path.node.arguments[0];
    if (options?.type !== "ObjectExpression") return;
    for (const property of options.properties) {
      const name = isObjectProperty(property) ? propertyName(property.key) : null;
      if (name && moved.has(name)) {
        report("F5", "review", `serve option ${name} moved to the Inngest client configuration in v4.`, property.loc);
      }
    }
  });
}

function flagLogLevel(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.ObjectProperty).forEach((path: any) => {
    if (propertyName(path.node.key) === "logLevel" && belongsToConfig(path, bindings, ["client", "serve"])) {
      report("F6", "review", "logLevel was removed in v4; remove it and configure logging through the supported logger/middleware path.", path.node.loc);
    }
  });
}

function flagConnect(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.CallExpression).forEach((path: any) => {
    if (isConnectCall(path.node.callee, bindings, path)) {
      report("F8", "review", "Inngest Connect v4 changes worker-thread behavior; exercise shutdown, signals, and worker startup in staging.", path.node.loc);
    }
  });
}

function flagInternalFunctionType(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.Identifier).forEach((path: any) => {
    if (!hasScopedBinding(bindings.internalFunction, path.node.name, path) || path.parentPath?.node?.type === "ImportSpecifier") return;
    report("F9", "review", "InngestFunction is an internal helper affected by v4 typing changes; replace it with public inferred function/reference types.", path.node.loc);
  });
}

function flagCheckpointRuntime(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.ObjectProperty).forEach((path: any) => {
    if (propertyName(path.node.key) === "maxRuntime" && belongsToConfig(path, bindings, ["createFunction"])) {
      report("F10", "review", "Review maxRuntime with v4 checkpointing defaults; long-running/retry behavior may change.", path.node.loc);
    }
  });
}

function functionHandlers(root: any, bindings: Bindings): Array<{
  handler: any; eventNames: Set<string>; stepNames: Set<string>; contextNames: Set<string>;
}> {
  const handlers: Array<{ handler: any; eventNames: Set<string>; stepNames: Set<string>; contextNames: Set<string> }> = [];
  root.find(j.CallExpression).forEach((path: any) => {
    if (!isClientMethod(path.node.callee, bindings, "createFunction", path)) return;
    const args = path.node.arguments;
    const handler = args.length === 3 ? args[2] : args[1];
    if (!handler || !["ArrowFunctionExpression", "FunctionExpression"].includes(handler.type)) return;
    const eventNames = new Set<string>();
    const stepNames = new Set<string>();
    const contextNames = new Set<string>();
    const context = handler.params?.[0];
    if (context?.type === "Identifier") contextNames.add(context.name);
    if (context?.type === "ObjectPattern") {
      for (const property of context.properties ?? []) {
        if (!isObjectProperty(property)) continue;
        const key = propertyName(property.key);
        const local = property.value?.type === "Identifier" ? property.value.name : key;
        if (key === "event" && local) eventNames.add(local);
        if (key === "step" && local) stepNames.add(local);
      }
    }
    handlers.push({ handler, eventNames, stepNames, contextNames });
  });
  return handlers;
}

function belongsToConfig(path: any, bindings: Bindings, owners: string[]): boolean {
  let objectPath = path.parentPath;
  while (objectPath && objectPath.node?.type !== "ObjectExpression") {
    if (["CallExpression", "NewExpression", "FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"].includes(objectPath.node?.type)) {
      return false;
    }
    objectPath = objectPath.parentPath;
  }
  if (!objectPath) return false;

  let cursor = objectPath.parentPath;
  while (cursor) {
    const node = cursor.node;
    // ast-types exposes virtual list paths whose node is the same owning node.
    if (node === objectPath.node) {
      cursor = cursor.parentPath;
      continue;
    }
    if (node?.type === "ObjectExpression") return false;
    if (node?.type === "CallExpression") {
      if (!node.arguments?.includes(objectPath.node)) return false;
      return (owners.includes("serve") && isServeCall(node.callee, bindings, cursor))
        || (owners.includes("connect") && isConnectCall(node.callee, bindings, cursor))
        || (owners.includes("createFunction") && isClientMethod(node.callee, bindings, "createFunction", cursor));
    }
    if (node?.type === "NewExpression") {
      return node.arguments?.includes(objectPath.node)
        && owners.includes("client")
        && isConstructor(node.callee, bindings, cursor);
    }
    if (["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"].includes(node?.type)) return false;
    cursor = cursor.parentPath;
  }
  return false;
}

function isConstructor(callee: any, bindings: Bindings, path: any): boolean {
  return (callee?.type === "Identifier" && hasScopedBinding(bindings.constructors, callee.name, path))
    || (callee?.type === "MemberExpression" && callee.object?.type === "Identifier"
      && hasScopedBinding(bindings.namespaces, callee.object.name, path) && propertyName(callee.property) === "Inngest");
}

function isClientMethod(callee: any, bindings: Bindings, method: string, path: any): boolean {
  return callee?.type === "MemberExpression" && callee.optional !== true
    && path?.node?.optional !== true && propertyName(callee.property) === method
    && callee.object?.type === "Identifier" && hasScopedBinding(bindings.clients, callee.object.name, path);
}

function isServeCall(callee: any, bindings: Bindings, path: any): boolean {
  return (callee?.type === "Identifier" && hasScopedBinding(bindings.serve, callee.name, path))
    || (callee?.type === "MemberExpression" && callee.object?.type === "Identifier"
      && hasScopedBinding(bindings.namespaces, callee.object.name, path) && propertyName(callee.property) === "serve");
}

function isConnectCall(callee: any, bindings: Bindings, path: any): boolean {
  return (callee?.type === "Identifier" && hasScopedBinding(bindings.connect, callee.name, path))
    || (callee?.type === "MemberExpression" && callee.object?.type === "Identifier"
      && hasScopedBinding(bindings.namespaces, callee.object.name, path) && propertyName(callee.property) === "connect");
}

function isContextMember(node: any, direct: Set<string>, contexts: Set<string>, property: string): boolean {
  if (node?.type === "Identifier") return direct.has(node.name);
  return node?.type === "MemberExpression" && propertyName(node.property) === property
    && node.object?.type === "Identifier" && contexts.has(node.object.name);
}

function directProperty(object: any, name: string): any | null {
  return object.properties?.find((property: any) => isObjectProperty(property) && propertyName(property.key) === name) ?? null;
}

function propertyName(node: any): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral" || node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  return null;
}

function staticStringValue(node: any): string | null {
  const literal = propertyName(node);
  if (literal != null && node?.type !== "Identifier") return literal;
  if (node?.type === "TemplateLiteral" && (node.expressions?.length ?? 0) === 0
    && (node.quasis?.length ?? 0) === 1) {
    return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? null;
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left == null || right == null ? null : left + right;
  }
  return null;
}

function staticMemberPropertyName(member: any): string | null {
  if (!member || (member.type !== "MemberExpression" && member.type !== "OptionalMemberExpression")) {
    return null;
  }
  return member.computed ? staticStringValue(member.property) : propertyName(member.property);
}

function locationKey(loc: any): string {
  return [
    loc?.start?.line ?? "?",
    loc?.start?.column ?? "?",
    loc?.end?.line ?? "?",
    loc?.end?.column ?? "?",
  ].join(":");
}

function variableDeclarationKind(path: any): string | null {
  let cursor = path?.parentPath;
  while (cursor) {
    if (cursor.node?.type === "VariableDeclaration") return cursor.node.kind ?? null;
    if (["Program", "BlockStatement", "Statement"].includes(cursor.node?.type)) return null;
    cursor = cursor.parentPath;
  }
  return null;
}

function createFunctionMember(call: any): any | null {
  if (call?.type !== "CallExpression" && call?.type !== "OptionalCallExpression") return null;
  let callee = call.callee;
  while (["ChainExpression", "TSNonNullExpression"].includes(callee?.type)) {
    callee = callee.expression;
  }
  if (callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression") return null;
  return staticMemberPropertyName(callee) === "createFunction" ? callee : null;
}

function isDirectMemberCall(path: any): boolean {
  const parent = path?.parentPath?.node;
  return parent?.type === "CallExpression" && parent.optional !== true
    && path.node?.optional !== true && parent.callee === path.node;
}

function identifierName(node: any): string | null {
  return node?.type === "Identifier" ? node.name : null;
}

function replacePropertyName(property: any, name: string): void {
  if (property.key.type === "Identifier") property.key.name = name;
  else property.key.value = name;
}

function isObjectProperty(node: any): boolean {
  return node?.type === "ObjectProperty" || node?.type === "Property";
}

function addScopedBinding(bindings: ScopedBindings, name: string, path: any, declarationNode: object): void {
  const scopeNode = bindingScopeNode(name, path);
  if (!scopeNode) return;
  const values = bindings.get(name) ?? [];
  values.push({ scopeNode, declarationNode });
  bindings.set(name, values);
}

function hasScopedBinding(bindings: ScopedBindings, name: string, path: any): boolean {
  const scopeNode = bindingScopeNode(name, path);
  const candidates = scopeNode
    ? bindings.get(name)?.filter((binding) => binding.scopeNode === scopeNode) ?? []
    : [];
  if (candidates.length === 0) return false;
  const nearestBlock = nearestBlockDeclaration(name, path);
  return !nearestBlock || candidates.some((binding) => binding.declarationNode === nearestBlock);
}

function bindingScopeNode(name: string, path: any): object | null {
  const scope = path?.scope?.lookup?.(name);
  return scope?.path?.node && typeof scope.path.node === "object" ? scope.path.node : null;
}

function addLocalImport(
  imports: Bindings["localImports"],
  name: string,
  source: string,
  importedName: string | null,
  eligibleNamedImport: boolean,
  namespaceLike: boolean,
  path: any,
  declarationNode: object
): void {
  const scopeNode = bindingScopeNode(name, path) ?? nearestProgramNode(path);
  if (!scopeNode) return;
  const values = imports.get(name) ?? [];
  values.push({
    source,
    importedName,
    eligibleNamedImport,
    namespaceLike,
    provenClient: false,
    scopeNode,
    declarationNode,
  });
  imports.set(name, values);
}

function filterUnsafeConstructorBindings(root: any, bindings: Bindings): void {
  bindings.constructors = retainSafeConstructorBindings(
    root,
    bindings.constructors,
    false,
    bindings.unsafeClients
  );
  bindings.namespaces = retainSafeConstructorBindings(
    root,
    bindings.namespaces,
    true,
    bindings.unsafeClients
  );
}

function retainSafeConstructorBindings(
  root: any,
  source: ScopedBindings,
  namespace: boolean,
  unsafe: Bindings["unsafeClients"]
): ScopedBindings {
  const retained: ScopedBindings = new Map();
  for (const [name, candidates] of source) {
    for (const candidate of candidates) {
      if (constructorReferencesAreSafe(root, name, candidate, namespace)) {
        const values = retained.get(name) ?? [];
        values.push(candidate);
        retained.set(name, values);
      } else {
        unsafe.push({
          name,
          loc: (candidate.declarationNode as any).loc,
          message: `${namespace ? "Inngest namespace" : "Inngest constructor"} ${name} is aliased, mutated, or accessed outside an approved direct call; automatic client proof is disabled.`,
        });
      }
    }
  }
  return retained;
}

function constructorReferencesAreSafe(
  root: any,
  name: string,
  binding: ScopedBinding,
  namespace: boolean
): boolean {
  let safe = true;
  let sawDeclaration = false;
  root.find(j.Identifier, { name }).forEach((path: any) => {
    if (!safe) return;
    const referenceScope = bindingScopeNode(name, path) ?? nearestProgramNode(path);
    if (referenceScope !== binding.scopeNode) return;
    const nearestDeclaration = nearestBlockDeclaration(name, path);
    if (nearestDeclaration && nearestDeclaration !== binding.declarationNode) return;
    if (path.node === binding.declarationNode) {
      sawDeclaration = true;
      return;
    }
    if (isMatchingImportBindingIdentifier(path, binding.declarationNode)
      || isClearlyNonReferenceIdentifier(path)) {
      return;
    }
    const parentPath = path.parentPath;
    if (!namespace) {
      if (parentPath?.node?.type === "NewExpression" && parentPath.node.callee === path.node) return;
      safe = false;
      return;
    }
    const member = parentPath?.node;
    if (member?.type !== "MemberExpression" || member.object !== path.node || member.computed) {
      safe = false;
      return;
    }
    const memberName = propertyName(member.property);
    const owner = parentPath.parentPath?.node;
    if (memberName === "Inngest" && owner?.type === "NewExpression" && owner.callee === member) return;
    if (["serve", "connect"].includes(memberName ?? "") && isDirectMemberCall(parentPath)) return;
    safe = false;
  });
  return safe && sawDeclaration;
}

function directClientReferencesAreSafe(
  root: any,
  name: string,
  declarationPath: any,
  declarationNode: object,
  bindings: Bindings
): boolean {
  const scopeNode = bindingScopeNode(name, declarationPath) ?? nearestProgramNode(declarationPath);
  return scopeNode != null
    && clientReferencesAreSafe(root, name, scopeNode, declarationNode, bindings, true);
}

/**
 * A proven client may only remain at its declaration/import, be called through
 * an allowlisted direct non-computed method, or be supplied as serve({ client }).
 * Any other reference can alias, replace, or otherwise obscure createFunction.
 */
function clientReferencesAreSafe(
  root: any,
  name: string,
  scopeNode: object,
  declarationNode: object,
  bindings: Bindings,
  allowDirectValueExport = false
): boolean {
  let safe = true;
  let sawDeclaration = false;
  const exportSummary = valueExportSummary(root, name, declarationNode);
  const allowValueExport = allowDirectValueExport
    && exportSummary.count === 1 && !exportSummary.hasDefault;
  root.find(j.Identifier, { name }).forEach((path: any) => {
    if (!safe) return;
    const referenceScope = bindingScopeNode(name, path) ?? nearestProgramNode(path);
    if (referenceScope !== scopeNode) return;
    const nearestDeclaration = nearestBlockDeclaration(name, path);
    if (nearestDeclaration && nearestDeclaration !== declarationNode) return;

    if (path.node === declarationNode) {
      sawDeclaration = true;
      return;
    }
    if (isMatchingImportBindingIdentifier(path, declarationNode)
      || (allowValueExport && isLocalValueExportIdentifier(path, name))
      || isClearlyNonReferenceIdentifier(path)) {
      return;
    }
    if (isDirectClientMethodCallReference(path) || isServeClientReference(path, bindings)) {
      return;
    }
    safe = false;
  });
  return safe && sawDeclaration;
}

function isMatchingImportBindingIdentifier(path: any, declarationNode: object): boolean {
  const parent = path.parentPath?.node;
  return parent?.type === "ImportSpecifier" && parent.local === declarationNode
    && (parent.local === path.node || parent.imported === path.node);
}

function isClearlyNonReferenceIdentifier(path: any): boolean {
  const parent = path.parentPath?.node;
  if (!parent) return false;
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression")
    && parent.property === path.node && !parent.computed) {
    return true;
  }
  if ((parent.type === "ObjectProperty" || parent.type === "Property")
    && parent.key === path.node && !parent.computed && !parent.shorthand) {
    return true;
  }
  if ([
    "ObjectMethod", "ClassMethod", "ClassProperty", "ClassPrivateMethod", "ClassPrivateProperty",
    "TSPropertySignature", "TSMethodSignature", "TSEnumMember",
  ].includes(parent.type) && parent.key === path.node && !parent.computed) {
    return true;
  }
  if (parent.type === "ImportSpecifier" && parent.imported === path.node && parent.local !== path.node) {
    return true;
  }
  if (parent.type === "ExportSpecifier" && parent.exported === path.node && parent.local !== path.node) {
    return true;
  }
  return (parent.type === "LabeledStatement" && parent.label === path.node)
    || ((parent.type === "BreakStatement" || parent.type === "ContinueStatement") && parent.label === path.node);
}

const SAFE_DIRECT_CLIENT_METHODS = new Set(["createFunction", "send"]);

function isDirectClientMethodCallReference(path: any): boolean {
  const memberPath = path.parentPath;
  const member = memberPath?.node;
  return member?.type === "MemberExpression" && member.object === path.node && !member.computed
    && SAFE_DIRECT_CLIENT_METHODS.has(propertyName(member.property) ?? "") && isDirectMemberCall(memberPath);
}

function isServeClientReference(path: any, bindings: Bindings): boolean {
  const propertyPath = path.parentPath;
  const property = propertyPath?.node;
  return isObjectProperty(property) && propertyName(property.key) === "client"
    && (property.value === path.node || (property.shorthand && property.key === path.node))
    && belongsToConfig(propertyPath, bindings, ["serve"]);
}

function proveDirectLocalClients(
  root: any,
  bindings: Bindings,
  importerPath: string,
  provenance?: InngestProvenanceContext
): void {
  for (const [localName, imports] of bindings.localImports) {
    for (const candidate of imports) {
      const sameScope = imports.filter((item) => item.scopeNode === candidate.scopeNode);
      if (sameScope.length !== 1) continue;
      const referencesAreSafe = (candidate.eligibleNamedImport
        || candidate.namespaceLike || candidate.importedName == null)
        ? clientReferencesAreSafe(
            root,
            localName,
            candidate.scopeNode,
            candidate.declarationNode,
            bindings
          )
        : false;
      const suspiciousCandidate = looksLikeConfiguredClientCandidate(candidate, localName);
      const specificallyInngestCandidate = looksLikeInngestClientBindingName(localName)
        || looksLikeInngestClientBindingName(candidate.importedName ?? "")
        || isStrongInngestModuleSource(candidate.source);
      const hasSpecificReference = importHasInngestSpecificReference(
        root,
        localName,
        candidate.scopeNode,
        candidate.declarationNode
      );
      const unsafeCandidate = specificallyInngestCandidate || hasSpecificReference;
      if (!isLocalModule(candidate.source)) {
        if (isLikelyPathAlias(candidate.source) && suspiciousCandidate
          && unsafeCandidate && !referencesAreSafe) {
          bindings.unsafeClients.push({
            name: localName,
            loc: (candidate.declarationNode as any).loc,
            message: `Path-alias import ${JSON.stringify(candidate.source)} can expose or mutate an untraceable configured client; use a relative static named import or migrate manually.`,
          });
        }
        continue;
      }
      if (!provenance) continue;
      const target = resolveScannedLocalModule(provenance, importerPath, candidate.source);
      if (!target) {
        if (suspiciousCandidate && unsafeCandidate && !referencesAreSafe) {
          bindings.unsafeClients.push({
            name: localName,
            loc: (candidate.declarationNode as any).loc,
            message: `Unresolved local client candidate ${JSON.stringify(candidate.source)} has a mutation, alias, computed access, or unsupported reference; migrate manually.`,
          });
        }
        continue;
      }
      if (candidate.namespaceLike && directlyExportsAnyInngestClient(target.source, target.path)) {
        bindings.unsafeClients.push({
          name: localName,
          loc: (candidate.declarationNode as any).loc,
          message: `Namespace or dynamic loading of local module ${JSON.stringify(candidate.source)} can expose its configured Inngest client; use a direct named import or migrate manually.`,
        });
        continue;
      }
      if (suspiciousCandidate && unsafeCandidate
        && !referencesAreSafe && !candidate.eligibleNamedImport) {
        bindings.unsafeClients.push({
          name: localName,
          loc: (candidate.declarationNode as any).loc,
          message: `Unsupported import form for configured-client candidate ${JSON.stringify(candidate.source)} is mutated, aliased, computed, or otherwise untraceable; migrate manually.`,
        });
        continue;
      }
      if (!candidate.eligibleNamedImport || !candidate.importedName
        || !directlyExportsInngestClient(target.source, target.path, candidate.importedName)) {
        continue;
      }
      if (!referencesAreSafe) {
        bindings.unsafeClients.push({
          name: localName,
          loc: (candidate.declarationNode as any).loc,
          message: `Configured Inngest client ${localName} imported from ${JSON.stringify(candidate.source)} has an alias, mutation, computed access, re-export, or indirect reference; migrate it manually.`,
        });
        continue;
      }
      candidate.provenClient = true;
      const scoped = bindings.clients.get(localName) ?? [];
      scoped.push({ scopeNode: candidate.scopeNode, declarationNode: candidate.declarationNode });
      bindings.clients.set(localName, scoped);
    }
  }
}

function looksLikeConfiguredClientCandidate(candidate: LocalImportBinding, localName: string): boolean {
  return looksLikeInngestClientBindingName(localName)
    || looksLikeInngestClientBindingName(candidate.importedName ?? "")
    || isLikelyConfiguredModuleSource(candidate.source);
}

/**
 * Generic modules named `client` are common. Only treat their imported value
 * as an Inngest hazard when its own reference chain is computed or explicitly
 * touches createFunction; ordinary db/http/prisma method calls stay unrelated.
 */
function importHasInngestSpecificReference(
  root: any,
  name: string,
  scopeNode: object,
  declarationNode: object
): boolean {
  let hazardous = false;
  root.find(j.Identifier, { name }).forEach((path: any) => {
    if (hazardous) return;
    const referenceScope = bindingScopeNode(name, path) ?? nearestProgramNode(path);
    if (referenceScope !== scopeNode) return;
    const nearestDeclaration = nearestBlockDeclaration(name, path);
    if (nearestDeclaration && nearestDeclaration !== declarationNode) return;
    if (path.node === declarationNode
      || isMatchingImportBindingIdentifier(path, declarationNode)
      || isClearlyNonReferenceIdentifier(path)) {
      return;
    }

    let cursor = path;
    while (cursor.parentPath) {
      const member = cursor.parentPath.node;
      if ((member?.type !== "MemberExpression" && member?.type !== "OptionalMemberExpression")
        || member.object !== cursor.node) {
        break;
      }
      if (member.computed || staticMemberPropertyName(member) === "createFunction") {
        hazardous = true;
        return;
      }
      cursor = cursor.parentPath;
    }
  });
  return hazardous;
}

const PROVENANCE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;

function resolveScannedLocalModule(
  provenance: InngestProvenanceContext,
  importerPath: string,
  source: string
): { path: string; source: string } | null {
  if (!isLocalModule(source) || source.includes("\\") || source.includes("\0") || /[?#]/.test(source)) return null;
  const importer = normalizeScannedPath(importerPath);
  if (!importer) return null;
  const targetBase = posix.normalize(posix.join(posix.dirname(importer), source)).replace(/^\.\//, "");
  if (targetBase === ".." || targetBase.startsWith("../") || posix.isAbsolute(targetBase) || targetBase === importer) {
    return null;
  }

  // Explicit extensions participate in TypeScript extension substitution and
  // are intentionally unsupported until that resolution algorithm is modeled.
  if (targetBase === "." || posix.extname(targetBase)) return null;
  const standardCandidates = new Set(PROVENANCE_EXTENSIONS.map((suffix) => `${targetBase}${suffix}`));
  const siblingPrefix = `${targetBase}.`;
  const existingCandidates = [...provenance.sourcePaths]
    .map(normalizeScannedPath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => standardCandidates.has(path) || path.startsWith(siblingPrefix));
  if (existingCandidates.length !== 1 || !standardCandidates.has(existingCandidates[0]!)) return null;

  const resolvedPath = existingCandidates[0]!;
  const scanned = [...provenance.scannedSources].find(([path]) => normalizeScannedPath(path) === resolvedPath);
  return scanned ? { path: resolvedPath, source: scanned[1] } : null;
}

function normalizeScannedPath(value: string): string | null {
  if (!value || value.includes("\0") || value.includes("\\") || posix.isAbsolute(value)) return null;
  const normalized = posix.normalize(value).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function directlyExportsAnyInngestClient(source: string, filePath: string): boolean {
  let root: any;
  try {
    root = parseWithParser(filePath, source);
  } catch {
    return false;
  }
  const program = root.find(j.Program).nodes()[0];
  if (!program) return false;
  const exportedNames = new Set<string>();
  for (const statement of program.body ?? []) {
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
    if (statement.declaration?.type === "VariableDeclaration") {
      for (const declarator of statement.declaration.declarations ?? []) {
        if (declarator.id?.type === "Identifier") exportedNames.add(declarator.id.name);
      }
    }
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.type === "ExportSpecifier" && specifier.exportKind !== "type") {
        const name = identifierName(specifier.exported);
        if (name) exportedNames.add(name);
      }
    }
  }
  return [...exportedNames].some((name) => directlyExportsInngestClient(source, filePath, name));
}

function directlyExportsInngestClient(source: string, filePath: string, exportedName: string): boolean {
  let root: any;
  try {
    root = parseWithParser(filePath, source);
  } catch {
    return false;
  }
  const program = root.find(j.Program).nodes()[0];
  if (!program) return false;

  const constructorImports = new Map<string, object[]>();
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type"
      || literalString(statement.source) !== "inngest") continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type"
        || identifierName(specifier.imported) !== "Inngest" || specifier.local?.type !== "Identifier") continue;
      const declarations = constructorImports.get(specifier.local.name) ?? [];
      declarations.push(specifier.local);
      constructorImports.set(specifier.local.name, declarations);
    }
  }

  const directClients = new Map<string, object[]>();
  const collectClientDeclarations = (declaration: any): void => {
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") return;
    for (const declarator of declaration.declarations ?? []) {
      const constructor = declarator.init?.type === "NewExpression" && declarator.init.callee?.type === "Identifier"
        ? declarator.init.callee.name
        : null;
      const constructorDeclarations = constructor ? constructorImports.get(constructor) ?? [] : [];
      if (declarator.id?.type !== "Identifier" || !constructor || constructorDeclarations.length !== 1
        || !wrapperConstructorReferencesAreSafe(root, constructor, constructorDeclarations[0]!)) continue;
      const declarations = directClients.get(declarator.id.name) ?? [];
      declarations.push(declarator.id);
      directClients.set(declarator.id.name, declarations);
    }
  };
  for (const statement of program.body ?? []) {
    collectClientDeclarations(statement.type === "ExportNamedDeclaration" ? statement.declaration : statement);
  }

  if ((program.body ?? []).some((statement: any) => statement.type === "ExportAllDeclaration")) return false;
  const matches: boolean[] = [];
  for (const statement of program.body ?? []) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.exportKind === "type") continue;
    if (statement.declaration) {
      const declaration = statement.declaration;
      if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations ?? []) {
          if (declarator.id?.type === "Identifier" && declarator.id.name === exportedName) {
            const declarations = directClients.get(declarator.id.name) ?? [];
            matches.push(declarations.length === 1
              && wrapperClientReferencesAreSafe(root, declarator.id.name, declarations[0]!));
          }
        }
      } else if (declaration.id?.name === exportedName) {
        matches.push(false);
      }
    }
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type"
        || identifierName(specifier.exported) !== exportedName) continue;
      const localName = identifierName(specifier.local);
      const declarations = localName == null ? [] : directClients.get(localName) ?? [];
      matches.push(statement.source == null && localName != null && declarations.length === 1
        && wrapperClientReferencesAreSafe(root, localName, declarations[0]!));
    }
  }
  return matches.length === 1 && matches[0] === true;
}

/** A one-hop wrapper may construct and export the client, but may not use or mutate it. */
function wrapperClientReferencesAreSafe(root: any, name: string, declarationNode: object): boolean {
  const exportSummary = valueExportSummary(root, name, declarationNode);
  if (exportSummary.count !== 1 || exportSummary.hasDefault) return false;
  let safe = true;
  let sawDeclaration = false;
  root.find(j.Identifier, { name }).forEach((path: any) => {
    if (!safe) return;
    if (path.node === declarationNode) {
      sawDeclaration = true;
      return;
    }
    if (isClearlyNonReferenceIdentifier(path) || isLocalValueExportIdentifier(path, name)) return;
    safe = false;
  });
  return safe && sawDeclaration;
}

function valueExportSummary(
  root: any,
  localName: string,
  declarationNode: object
): { count: number; hasDefault: boolean } {
  let count = 0;
  let hasDefault = false;
  root.find(j.ExportNamedDeclaration).forEach((path: any) => {
    if (path.node.exportKind === "type") return;
    const declaration = path.node.declaration;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations ?? []) {
        if (declarator.id === declarationNode) count++;
      }
    }
    if (path.node.source != null) return;
    for (const specifier of path.node.specifiers ?? []) {
      if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type"
        || identifierName(specifier.local) !== localName) continue;
      count++;
      if (identifierName(specifier.exported) === "default") hasDefault = true;
    }
  });
  root.find(j.ExportDefaultDeclaration).forEach((path: any) => {
    if (path.node.declaration?.type === "Identifier" && path.node.declaration.name === localName) {
      count++;
      hasDefault = true;
    }
  });
  return { count, hasDefault };
}

function wrapperConstructorReferencesAreSafe(
  root: any,
  name: string,
  declarationNode: object
): boolean {
  let declarationPath: any = null;
  root.find(j.Identifier, { name }).forEach((path: any) => {
    if (path.node === declarationNode) declarationPath = path;
  });
  const scopeNode = declarationPath
    ? bindingScopeNode(name, declarationPath) ?? nearestProgramNode(declarationPath)
    : null;
  return scopeNode != null && constructorReferencesAreSafe(
    root,
    name,
    { scopeNode, declarationNode },
    false
  );
}

function isLocalValueExportIdentifier(path: any, localName: string): boolean {
  const specifier = path.parentPath?.node;
  if (specifier?.type !== "ExportSpecifier" || specifier.exportKind === "type"
    || identifierName(specifier.local) !== localName
    || (specifier.local !== path.node && specifier.exported !== path.node)) {
    return false;
  }
  let cursor = path.parentPath;
  while (cursor && cursor.node?.type !== "ExportNamedDeclaration") cursor = cursor.parentPath;
  return cursor?.node?.type === "ExportNamedDeclaration"
    && cursor.node.source == null && cursor.node.exportKind !== "type";
}

function localImportAt(imports: Bindings["localImports"], name: string, path: any): LocalImportBinding | null {
  const scopeNode = bindingScopeNode(name, path) ?? nearestProgramNode(path);
  const candidates = imports.get(name)?.filter((item) => item.scopeNode === scopeNode) ?? [];
  const nearestBlock = nearestBlockDeclaration(name, path);
  return candidates.find((item) => !nearestBlock || item.declarationNode === nearestBlock) ?? null;
}

function nearestProgramNode(path: any): object | null {
  let cursor = path;
  while (cursor) {
    if (cursor.node?.type === "Program") return cursor.node;
    cursor = cursor.parentPath;
  }
  return null;
}

function nearestBlockDeclaration(name: string, path: any): object | null {
  let cursor = path;
  while (cursor) {
    const node = cursor.node as any;
    if (node?.type === "ForStatement") {
      const found = declarationIdentifier(node.init, name);
      if (found) return found;
    }
    if (node?.type === "ForInStatement" || node?.type === "ForOfStatement") {
      const found = declarationIdentifier(node.left, name);
      if (found) return found;
    }
    if (node?.type === "SwitchStatement") {
      for (const branch of node.cases ?? []) {
        for (const statement of branch.consequent ?? []) {
          const found = statementBindingIdentifier(statement, name);
          if (found) return found;
        }
      }
    }
    if (node?.type === "BlockStatement" || node?.type === "Program") {
      for (const statement of node.body ?? []) {
        const found = statementBindingIdentifier(statement, name);
        if (found) return found;
      }
    }
    cursor = cursor.parentPath;
  }
  return null;
}

function statementBindingIdentifier(statement: any, name: string): object | null {
  if (statement?.type === "VariableDeclaration" && statement.kind !== "var") {
    return declarationIdentifier(statement, name);
  }
  if ((statement?.type === "FunctionDeclaration" || statement?.type === "ClassDeclaration")
    && statement.id?.name === name) {
    return statement.id;
  }
  if (statement?.type === "ImportDeclaration") {
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.name === name) return specifier.local;
    }
  }
  return null;
}

function declarationIdentifier(declaration: any, name: string): object | null {
  if (declaration?.type !== "VariableDeclaration" || declaration.kind === "var") return null;
  for (const declarator of declaration.declarations ?? []) {
    const found = patternIdentifier(declarator.id, name);
    if (found) return found;
  }
  return null;
}

function patternIdentifier(pattern: any, name: string): object | null {
  if (!pattern) return null;
  if (pattern.type === "Identifier") return pattern.name === name ? pattern : null;
  if (pattern.type === "AssignmentPattern") return patternIdentifier(pattern.left, name);
  if (pattern.type === "RestElement") return patternIdentifier(pattern.argument, name);
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements ?? []) {
      const found = patternIdentifier(element, name);
      if (found) return found;
    }
  }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties ?? []) {
      const found = patternIdentifier(property.value ?? property.argument, name);
      if (found) return found;
    }
  }
  return null;
}

function patternIdentifiers(pattern: any): Array<{ type: "Identifier"; name: string }> {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern];
  if (pattern.type === "AssignmentPattern") return patternIdentifiers(pattern.left);
  if (pattern.type === "RestElement") return patternIdentifiers(pattern.argument);
  if (pattern.type === "ArrayPattern") {
    return (pattern.elements ?? []).flatMap((element: any) => patternIdentifiers(element));
  }
  if (pattern.type === "ObjectPattern") {
    return (pattern.properties ?? []).flatMap((property: any) =>
      patternIdentifiers(property.value ?? property.argument)
    );
  }
  return [];
}

function staticLocalLoaderSource(node: any): string | null {
  if (!node) return null;
  if (["AwaitExpression", "TSAsExpression", "TSTypeAssertion", "TypeCastExpression", "ChainExpression"].includes(node.type)) {
    return staticLocalLoaderSource(node.argument ?? node.expression);
  }
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    return staticLocalLoaderSource(node.object);
  }
  let source: string | null = null;
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
    if (node.callee?.type === "Identifier" && node.callee.name === "require") {
      source = literalString(node.arguments?.[0]);
    } else if (node.callee?.type === "Import") {
      source = literalString(node.arguments?.[0]);
    }
  } else if (node.type === "ImportExpression") {
    source = literalString(node.source);
  }
  return source && isPotentialConfiguredClientModule(source) ? source : null;
}

function rootReceiverIdentifier(node: any): { type: "Identifier"; name: string } | null {
  let current = node;
  while (current?.type === "MemberExpression" || current?.type === "OptionalMemberExpression") {
    current = current.object;
  }
  return current?.type === "Identifier" ? current : null;
}

function literalString(node: any): string | null {
  if (node?.type === "StringLiteral" || node?.type === "Literal") {
    return typeof node.value === "string" ? node.value : null;
  }
  return null;
}

function isLocalModule(source: string): boolean {
  return source === "." || source === ".." || source.startsWith("./") || source.startsWith("../");
}

function isPotentialConfiguredClientModule(source: string): boolean {
  return isLocalModule(source) || isLikelyPathAlias(source);
}

function isLikelyPathAlias(source: string): boolean {
  return source.startsWith("@/") || source.startsWith("~/") || source.startsWith("#")
    || source.startsWith("src/") || source.startsWith("$");
}

function isLikelyConfiguredModuleSource(source: string): boolean {
  const basename = source.split("/").filter(Boolean).at(-1) ?? source;
  const normalized = basename.replace(/\.(?:[cm]?[jt]sx?)$/i, "").toLowerCase();
  return normalized === "client" || normalized === "inngest"
    || (normalized.includes("inngest") && normalized.includes("client"));
}

function isStrongInngestModuleSource(source: string): boolean {
  const segments = source.split("/").filter(Boolean)
    .map((segment) => segment.replace(/\.(?:[cm]?[jt]sx?)$/i, "").toLowerCase());
  const basename = segments.at(-1) ?? "";
  return basename === "inngest"
    || basename.includes("inngestclient")
    || basename.includes("inngest-client")
    || basename.includes("inngest_client")
    || (segments.includes("inngest") && basename === "client");
}

function looksLikeInngestClientBindingName(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "inngest"
    || (normalized.includes("inngest") && normalized.includes("client"));
}

function looksLikePotentialClientExportName(value: string): boolean {
  return value.toLowerCase() === "client" || looksLikeInngestClientBindingName(value);
}

function isInngestModule(source: string): boolean {
  return source === "inngest" || source.startsWith("inngest/") || source.startsWith("@inngest/");
}
