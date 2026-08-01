/** Binding-aware Knock Node SDK v0 -> v1 migration. */

import { type API, type FileInfo } from "jscodeshift";
import * as jscodeshift from "jscodeshift";
import { TRANSFORM_ALLOWLIST } from "../manifest.js";
import type { ReportSink } from "../types.js";
import { parseWithParser, toSource } from "./parser.js";

const j: any = (jscodeshift as any).default ?? (jscodeshift as any);
const ALL = new Set<string>(TRANSFORM_ALLOWLIST["knock-v0-to-v1"]);

interface ScopedBinding {
  scopeNode: object;
  declarationNode: object;
}
type ScopedBindings = Map<string, ScopedBinding[]>;

interface LocalImportBinding {
  source: string;
  importedName: string | null;
  scopeNode: object;
  declarationNode: object;
}

interface LocalValueBinding extends ScopedBinding {
  init: any;
  declarationPath: any;
}

interface Bindings {
  constructors: ScopedBindings;
  namespaces: ScopedBindings;
  clients: ScopedBindings;
  tokenSigners: ScopedBindings;
  localImports: Map<string, LocalImportBinding[]>;
  localValues: Map<string, LocalValueBinding[]>;
  unsafeReferences: Array<{ name: string; loc: any; message: string }>;
}

type ReportFn = (code: string, kind: "applied" | "review", message: string, loc: any) => void;

export function applyKnockV0ToV1(
  source: string,
  filePath: string,
  sink: ReportSink,
  enabled: ReadonlySet<string> = ALL
): string | null {
  const root = parseWithParser(filePath, source);
  const bindings = collectBindings(root);
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
  flagTypeOnlyKnockImports(root, blockingReview);
  flagUnsafeReferences(bindings, blockingReview);
  flagLocalWrapperUsage(root, bindings, blockingReview);
  flagComputedImportedCalls(root, bindings, blockingReview);
  flagUnprovenLegacyCalls(root, bindings, blockingReview);

  let applied = 0;
  if (enabled.has("K4")) applied += migrateDefaultImport(root, report);
  if (enabled.has("K5")) applied += migrateClientInit(root, bindings, report);
  if (enabled.has("K1")) applied += migrateNotify(root, bindings, report);
  if (enabled.has("K2")) applied += migrateIdentify(root, bindings, report);
  if (enabled.has("K3")) applied += migrateParameters(root, bindings, report);

  flagPositionalParameters(root, bindings, report);
  flagTypedErrors(root, bindings, report);
  flagTokenSigner(root, bindings, report);
  flagSchedules(root, bindings, report);
  flagBulk(root, bindings, report);
  flagResponseUnwrap(root, bindings, report);

  return applied > 0 ? toSource(root) : null;
}

export default function transform(file: FileInfo, _api: API): string | null | undefined {
  const sink: ReportSink = { push: (entry) => console.log(JSON.stringify(entry)) };
  return applyKnockV0ToV1(file.source, file.path ?? "(unknown)", sink);
}

function collectBindings(root: any): Bindings {
  const bindings: Bindings = {
    constructors: new Map(), namespaces: new Map(), clients: new Map(), tokenSigners: new Map(),
    localImports: new Map(),
    localValues: new Map(),
    unsafeReferences: [],
  };
  root.find(j.ImportDeclaration).forEach((path: any) => {
    const source = String(path.node.source.value ?? "");
    if (!isKnockModule(source)) {
      if (source) {
        for (const specifier of path.node.specifiers ?? []) {
          const local = specifier.local?.name;
          if (!local) continue;
          const importedName = specifier.type === "ImportSpecifier"
            ? propertyName(specifier.imported)
            : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : null;
          addLocalImport(bindings.localImports, local, source, importedName, path, specifier.local);
        }
      }
      return;
    }
    for (const specifier of path.node.specifiers ?? []) {
      if (path.node.importKind === "type" || specifier.importKind === "type") continue;
      if (specifier.type === "ImportNamespaceSpecifier" && specifier.local?.name) {
        addScopedBinding(bindings.namespaces, specifier.local.name, path, specifier.local);
      } else if (specifier.type === "ImportDefaultSpecifier" && specifier.local?.name) {
        addScopedBinding(bindings.constructors, specifier.local.name, path, specifier.local);
      } else if (specifier.type === "ImportSpecifier") {
        const imported = specifier.imported?.name;
        const local = specifier.local?.name ?? imported;
        if (imported === "Knock" && local) {
          addScopedBinding(bindings.constructors, local, path, specifier.local ?? specifier.imported);
        }
        if ((imported === "TokenSigner" || imported === "tokenSigner") && local) {
          addScopedBinding(bindings.tokenSigners, local, path, specifier.local ?? specifier.imported);
        }
      }
    }
  });
  root.find(j.Node).forEach((path: any) => {
    if (path.node?.type !== "TSImportEqualsDeclaration" || path.node.id?.type !== "Identifier") return;
    const source = literalString(path.node.moduleReference?.expression);
    if (!source || isKnockModule(source)) return;
    addLocalImport(bindings.localImports, path.node.id.name, source, null, path, path.node.id);
  });
  root.find(j.VariableDeclarator).forEach((path: any) => {
    const source = staticModuleLoaderSource(path.node.init);
    if (!source || isKnockModule(source)) return;
    for (const identifier of patternIdentifiers(path.node.id)) {
      addLocalImport(bindings.localImports, identifier.name, source, null, path, identifier);
    }
  });
  root.find(j.VariableDeclarator).forEach((path: any) => {
    if (path.node.id?.type !== "Identifier" || path.node.init == null
      || variableDeclarationKind(path) !== "const") return;
    addLocalValue(bindings.localValues, path.node.id.name, path.node.init, path, path.node.id);
  });
  filterUnsafeConstructorBindings(root, bindings);
  root.find(j.VariableDeclarator).forEach((path: any) => {
    const { id, init } = path.node;
    if (id?.type !== "Identifier" || init?.type !== "NewExpression" || !isConstructor(init.callee, bindings, path)) {
      return;
    }
    if (variableDeclarationKind(path) === "const" && clientReferencesAreSafe(root, id.name, path, id)) {
      addScopedBinding(bindings.clients, id.name, path, id);
    } else {
      bindings.unsafeReferences.push({
        name: id.name,
        loc: id.loc ?? path.node.loc,
        message: `Knock client ${id.name} is mutable, aliased, overwritten, computed, or invoked indirectly; migrate its calls manually.`,
      });
    }
  });
  return bindings;
}

/** CommonJS/dynamic loading is detected but never guessed into an ESM rewrite. */
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
        "KF1",
        "review",
        `Non-literal ${loader} target cannot be proven unrelated to the Knock SDK or a configured client; replace it with a static import or review manually.`,
        node.loc
      );
      return;
    }
    if (!isKnockModule(source)) {
      if (isLikelyConfiguredModuleSource(source)) {
        report(
          "KF1",
          "review",
          `Unsupported ${loader} loading of possible configured-client module ${JSON.stringify(source)}; use a static import or migrate manually.`,
          node.loc
        );
      }
      return;
    }
    report(
      "KF1",
      "review",
      `Unsupported ${node.type} loading of ${source}; convert it to a static SDK import before migration.`,
      node.loc
    );
  });
}

function flagTypeOnlyKnockImports(root: any, report: ReportFn): void {
  root.find(j.ImportDeclaration).forEach((path: any) => {
    const source = String(path.node.source.value ?? "");
    if (!isKnockModule(source)) return;
    const hasTypeOnlyConstructor = path.node.importKind === "type"
      ? (path.node.specifiers ?? []).some((specifier: any) =>
        specifier.type === "ImportDefaultSpecifier" || specifier.type === "ImportNamespaceSpecifier"
          || (specifier.type === "ImportSpecifier" && specifier.imported?.name === "Knock")
      )
      : (path.node.specifiers ?? []).some((specifier: any) =>
        specifier.importKind === "type" && specifier.imported?.name === "Knock"
      );
    if (!hasTypeOnlyConstructor) return;
    report(
      "K4",
      "review",
      "Type-only Knock imports must remain type-only; introduce a separate runtime default import only where a real constructor value is required.",
      path.node.loc
    );
  });
}

function flagUnsafeReferences(bindings: Bindings, report: ReportFn): void {
  for (const reference of bindings.unsafeReferences) {
    report("KF1", "review", reference.message, reference.loc);
  }
}

/** Configured clients imported from a local wrapper require provenance tracing. */
function flagLocalWrapperUsage(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.CallExpression).forEach((path: any) => {
    const rootReceiver = memberRoot(path.node.callee);
    if (rootReceiver?.type !== "Identifier") return;
    const local = localImportAt(bindings.localImports, rootReceiver.name, path);
    if (!local || !looksLikeKnockMethod(path.node.callee)) return;
    report(
      "KF1",
      "review",
      `Configured client candidate ${rootReceiver.name} comes from module ${JSON.stringify(local.source)}; trace its SDK construction and migrate this call manually.`,
      path.node.loc
    );
  });
}

function flagComputedImportedCalls(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.Node).forEach((path: any) => {
    const call = path.node as any;
    if (call?.type !== "CallExpression" && call?.type !== "OptionalCallExpression") return;
    const callee = call.callee;
    if ((callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression")
      || !callee.computed || literalString(callee.property) != null) {
      return;
    }
    const receiver = memberRoot(callee);
    if (receiver?.type !== "Identifier" || !localImportAt(bindings.localImports, receiver.name, path)) return;
    report(
      "KF1",
      "review",
      `Computed method call on imported binding ${receiver.name} cannot be proven unrelated to a legacy Knock method; migrate or exclude it manually.`,
      call.loc
    );
  });
}

interface TracedKnockTarget {
  chain: Array<string | null>;
  origin: "local-import" | "hint";
  strongHint: boolean;
}

/**
 * Exact legacy calls on factory results and aliases must not disappear merely
 * because the receiver was not constructed inline. This traces only immutable,
 * local aliases and requires either a local-import origin or a Knock/client
 * naming hint, keeping unrelated receivers such as mailer.notify untouched.
 */
function flagUnprovenLegacyCalls(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.Node).forEach((path: any) => {
    const call = path.node as any;
    if (call?.type !== "CallExpression" && call?.type !== "OptionalCallExpression") return;
    if (isClientCall(call.callee, bindings, path) || directImportedCallAlreadyReported(call, path, bindings)) {
      return;
    }

    const traced = traceKnockTarget(call.callee, path, bindings, new Set());
    if (!traced) return;
    const chain = [...traced.chain];
    if (["call", "apply", "bind"].includes(chain.at(-1) ?? "")) chain.pop();

    if (chain.some((part) => part == null)) {
      if (traced.strongHint) {
        report(
          "KF1",
          "review",
          "A computed method extracted from a possible configured Knock client cannot be classified safely; migrate it manually.",
          call.loc
        );
      }
      return;
    }
    if (traced.origin === "local-import" && !traced.strongHint) return;

    const method = normalizedLegacyChain(chain as string[], traced.origin);
    if (method === "notify") {
      report("K1", "review", "Unproven Knock receiver uses legacy notify; trace the client and migrate it manually.", call.loc);
    }
    if (method === "users.identify") {
      report("K2", "review", "Unproven Knock receiver uses legacy users.identify; trace the client and migrate it manually.", call.loc);
    }
    if (method === "users.list" && callHasObjectProperty(call, "pageSize")) {
      report("K3", "review", "Unproven Knock receiver uses legacy pageSize; migrate it to page_size manually.", call.loc);
    }
    if (["notify", "workflows.trigger", "workflows.cancel", "cancel"].includes(method ?? "")
      && callHasObjectProperty(call, "cancellationKey")) {
      report("K3", "review", "Unproven Knock receiver uses legacy cancellationKey; migrate it to cancellation_key manually.", call.loc);
    }
  });
}

function directImportedCallAlreadyReported(call: any, path: any, bindings: Bindings): boolean {
  const receiver = memberRoot(call.callee);
  if (receiver?.type !== "Identifier" || !localImportAt(bindings.localImports, receiver.name, path)) return false;
  if (looksLikeKnockMethod(call.callee)) return true;
  return (call.callee?.type === "MemberExpression" || call.callee?.type === "OptionalMemberExpression")
    && call.callee.computed && literalString(call.callee.property) == null;
}

function traceKnockTarget(
  node: any,
  path: any,
  bindings: Bindings,
  seen: Set<object>
): TracedKnockTarget | null {
  if (!node) return null;
  if (["ChainExpression", "TSAsExpression", "TSTypeAssertion", "TypeCastExpression", "ParenthesizedExpression"].includes(node.type)) {
    return traceKnockTarget(node.expression, path, bindings, seen);
  }
  if (node.type === "Identifier") {
    const imported = localImportAt(bindings.localImports, node.name, path);
    if (imported) {
      return {
        chain: [],
        origin: "local-import",
        strongHint: hasKnockClientHint(node.name) || hasKnockClientHint(imported.importedName)
          || hasKnockClientHint(imported.source),
      };
    }
    const value = localValueAt(bindings.localValues, node.name, path);
    if (value && !seen.has(value.declarationNode)) {
      seen.add(value.declarationNode);
      const traced = traceKnockTarget(value.init, value.declarationPath, bindings, seen);
      if (traced) return traced;
      return hasKnockClientHint(node.name) && isFactoryResultExpression(value.init)
        ? { chain: [], origin: "hint", strongHint: true }
        : null;
    }
    if (bindingScopeNode(node.name, path)) return null;
    return hasKnockClientHint(node.name)
      ? { chain: [], origin: "hint", strongHint: true }
      : null;
  }
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    const base = traceKnockTarget(node.object, path, bindings, seen);
    const member = resolvedMemberName(node, path, bindings, seen);
    if (base) return { ...base, chain: [...base.chain, member] };
    return member && hasKnockClientHint(member)
      ? { chain: [], origin: "hint", strongHint: true }
      : null;
  }
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
    const calleeTrace = traceKnockTarget(node.callee, path, bindings, seen);
    if (calleeTrace?.chain.at(-1) === "bind") {
      return { ...calleeTrace, chain: calleeTrace.chain.slice(0, -1) };
    }
    if (calleeTrace?.strongHint) {
      // Calling a Knock-named imported factory returns a possible client. The
      // local alias may hide that name, so retain the traced origin/hint while
      // resetting the factory member chain for the returned value.
      return { ...calleeTrace, chain: [] };
    }
    return expressionHasKnockClientHint(node.callee)
      ? { chain: [], origin: "hint", strongHint: true }
      : null;
  }
  return null;
}

function isFactoryResultExpression(node: any): boolean {
  let current = node;
  while (current && ["AwaitExpression", "ChainExpression", "TSAsExpression", "TSTypeAssertion", "TypeCastExpression", "ParenthesizedExpression"].includes(current.type)) {
    current = current.argument ?? current.expression;
  }
  return current?.type === "CallExpression" || current?.type === "OptionalCallExpression";
}

function resolvedMemberName(node: any, path: any, bindings: Bindings, seen: Set<object>): string | null {
  if (!node.computed) return propertyName(node.property);
  const literal = literalString(node.property);
  if (literal != null) return literal;
  if (node.property?.type !== "Identifier") return null;
  const value = localValueAt(bindings.localValues, node.property.name, path);
  if (!value || seen.has(value.declarationNode)) return null;
  return literalString(value.init);
}

function normalizedLegacyChain(chain: string[], origin: TracedKnockTarget["origin"]): string | null {
  const exact = new Set(["notify", "users.identify", "users.list", "workflows.trigger", "workflows.cancel", "cancel"]);
  const joined = chain.join(".");
  if (exact.has(joined)) return joined;
  if (origin !== "local-import") return null;
  for (const candidate of exact) {
    if (joined.endsWith(`.${candidate}`)) return candidate;
  }
  return null;
}

function callHasObjectProperty(call: any, name: string): boolean {
  return (call.arguments ?? []).some((argument: any) => argument?.type === "ObjectExpression"
    && (argument.properties ?? []).some((property: any) => isObjectProperty(property)
      && propertyName(property.key) === name));
}

function expressionHasKnockClientHint(node: any): boolean {
  if (!node) return false;
  if (node.type === "Identifier") return hasKnockClientHint(node.name);
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    return hasKnockClientHint(propertyName(node.property)) || expressionHasKnockClientHint(node.object);
  }
  return false;
}

function hasKnockClientHint(value: string | null | undefined): boolean {
  if (!value) return false;
  return /knock/i.test(value)
    || /(?:^|[/_.-])client(?:$|[/_.-])/i.test(value)
    || /Client$/.test(value);
}

function migrateDefaultImport(root: any, report: ReportFn): number {
  let applied = 0;
  root.find(j.ImportDeclaration).forEach((path: any) => {
    if (String(path.node.source.value ?? "") !== "@knocklabs/node") return;
    if (path.node.importKind === "type") return;
    const specifiers = path.node.specifiers ?? [];
    const named = specifiers.find((specifier: any) =>
      specifier.type === "ImportSpecifier" && specifier.importKind !== "type"
        && specifier.imported?.name === "Knock"
    );
    if (!named) return;
    const hasDefault = specifiers.some((specifier: any) => specifier.type === "ImportDefaultSpecifier");
    if (hasDefault) {
      report("K4", "review", "Both default and named Knock imports are present; consolidate the import manually.", path.node.loc);
      return;
    }
    const local = named.local?.name ?? "Knock";
    const localIdentifier = named.local ?? named.imported ?? j.identifier(local);
    path.node.specifiers = [
      j.importDefaultSpecifier(localIdentifier),
      ...specifiers.filter((specifier: any) => specifier !== named),
    ];
    report("K4", "applied", "Knock named import converted to the v1 default import", path.node.loc);
    applied++;
  });
  return applied;
}

function migrateClientInit(root: any, bindings: Bindings, report: ReportFn): number {
  let applied = 0;
  root.find(j.NewExpression).forEach((path: any) => {
    if (!isConstructor(path.node.callee, bindings, path)) return;
    const args = path.node.arguments;
    if (args.length !== 1 || args[0]?.type === "ObjectExpression") return;
    if (args[0]?.type === "SpreadElement") {
      report("K5", "review", "Knock constructor spread argument must be converted to a v1 options object manually.", path.node.loc);
      return;
    }
    path.node.arguments = [j.objectExpression([
      j.objectProperty(j.identifier("apiKey"), args[0]),
    ])];
    report("K5", "applied", "Knock constructor converted to new Knock({ apiKey })", path.node.loc);
    applied++;
  });
  return applied;
}

function migrateNotify(root: any, bindings: Bindings, report: ReportFn): number {
  let applied = 0;
  root.find(j.CallExpression).forEach((path: any) => {
    const callee = path.node.callee;
    if (!isClientCall(callee, bindings, path) || memberChain(callee).join(".") !== "notify") return;
    const receiver = callee.object;
    path.node.callee = j.memberExpression(
      j.memberExpression(receiver, j.identifier("workflows")),
      j.identifier("trigger")
    );
    report("K1", "applied", "Knock notify call moved to workflows.trigger", path.node.loc);
    applied++;
  });
  return applied;
}

function migrateIdentify(root: any, bindings: Bindings, report: ReportFn): number {
  let applied = 0;
  root.find(j.CallExpression).forEach((path: any) => {
    const chain = memberChain(path.node.callee);
    if (!isClientCall(path.node.callee, bindings, path) || chain.join(".") !== "users.identify") return;
    replaceLastMember(path.node.callee, "update");
    report("K2", "applied", "users.identify renamed to users.update", path.node.loc);
    applied++;
  });
  return applied;
}

function migrateParameters(root: any, bindings: Bindings, report: ReportFn): number {
  let applied = 0;
  root.find(j.CallExpression).forEach((path: any) => {
    if (!isClientCall(path.node.callee, bindings, path)) return;
    const chain = memberChain(path.node.callee).join(".");
    const renames = chain === "users.list"
      ? { pageSize: "page_size" }
      : ["notify", "workflows.trigger", "workflows.cancel", "cancel"].includes(chain)
        ? { cancellationKey: "cancellation_key" }
        : {};
    for (const argument of path.node.arguments ?? []) {
      if (argument?.type !== "ObjectExpression") continue;
      for (const property of argument.properties ?? []) {
        if (!isObjectProperty(property)) continue;
        const from = propertyName(property.key);
        const to = from ? (renames as Record<string, string>)[from] : undefined;
        if (!to) continue;
        replacePropertyName(property, to);
        report("K3", "applied", `Knock parameter renamed ${from} -> ${to}`, property.loc);
        applied++;
      }
    }
  });
  return applied;
}

function flagPositionalParameters(root: any, bindings: Bindings, report: ReportFn): void {
  const parameterChanged = new Set(["setPreferences", "getPreferences", "addChannelData", "setChannelData"]);
  root.find(j.CallExpression).forEach((path: any) => {
    if (!isClientCall(path.node.callee, bindings, path)) return;
    const method = lastMember(path.node.callee);
    if (method && parameterChanged.has(method)) {
      report("KF1", "review", `Review ${method} arguments against the v1 options-object signature.`, path.node.loc);
    }
  });
}

function flagTypedErrors(root: any, bindings: Bindings, report: ReportFn): void {
  if (bindings.clients.size === 0) return;
  const oldErrorFields = new Set(["statusCode", "response", "body"]);
  root.find(j.CatchClause).forEach((catchPath: any) => {
    j(catchPath.node.body).find(j.MemberExpression).forEach((path: any) => {
      const name = propertyName(path.node.property);
      if (name && oldErrorFields.has(name)) {
        report("KF2", "review", `Knock v1 uses typed API errors; replace ad-hoc error.${name} access with the exported error type/narrowing.`, path.node.loc);
      }
    });
  });
}

function flagTokenSigner(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.Identifier).forEach((path: any) => {
    if (!hasScopedBinding(bindings.tokenSigners, path.node.name, path) || path.parentPath?.node?.type === "ImportSpecifier") return;
    report("KF3", "review", "Token signer exports changed in v1; verify the TokenSigner import and generated token claims.", path.node.loc);
  });
}

function flagSchedules(root: any, bindings: Bindings, report: ReportFn): void {
  const legacy = new Set(["createSchedules", "listSchedules", "updateSchedules", "deleteSchedules"]);
  root.find(j.CallExpression).forEach((path: any) => {
    if (!isClientCall(path.node.callee, bindings, path)) return;
    const method = lastMember(path.node.callee);
    if (method && legacy.has(method)) {
      report("KF4", "review", `Legacy ${method} moved to the v1 schedules namespace; map its arguments and response manually.`, path.node.loc);
    }
  });
}

function flagBulk(root: any, bindings: Bindings, report: ReportFn): void {
  root.find(j.CallExpression).forEach((path: any) => {
    if (isClientCall(path.node.callee, bindings, path) && memberChain(path.node.callee).includes("bulk")) {
      report("KF5", "review", "Bulk operations were reorganized into v1 namespaces; verify this method path and batch payload.", path.node.loc);
    }
  });
}

function flagResponseUnwrap(root: any, bindings: Bindings, report: ReportFn): void {
  const results = new Set<string>();
  root.find(j.VariableDeclarator).forEach((path: any) => {
    if (path.node.id?.type !== "Identifier") return;
    const call = unwrapCall(path.node.init);
    if (call && isClientCall(call.callee, bindings, path)) results.add(path.node.id.name);
  });
  root.find(j.MemberExpression).forEach((path: any) => {
    if (propertyName(path.node.property) !== "data") return;
    const direct = unwrapCall(path.node.object);
    const variable = path.node.object?.type === "Identifier" && results.has(path.node.object.name);
    if ((direct && isClientCall(direct.callee, bindings, path)) || variable) {
      report("KF6", "review", "Knock v1 response shapes are unwrapped; verify whether this .data access should be removed.", path.node.loc);
    }
  });
}

function unwrapCall(node: any): any | null {
  let current = node;
  while (current && ["AwaitExpression", "TSAsExpression", "ParenthesizedExpression"].includes(current.type)) {
    current = current.argument ?? current.expression;
  }
  return current?.type === "CallExpression" ? current : null;
}

function filterUnsafeConstructorBindings(root: any, bindings: Bindings): void {
  bindings.constructors = retainSafeConstructorBindings(
    root,
    bindings.constructors,
    false,
    bindings.unsafeReferences
  );
  bindings.namespaces = retainSafeConstructorBindings(
    root,
    bindings.namespaces,
    true,
    bindings.unsafeReferences
  );
}

function retainSafeConstructorBindings(
  root: any,
  source: ScopedBindings,
  namespace: boolean,
  unsafe: Bindings["unsafeReferences"]
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
          message: `${namespace ? "Knock namespace" : "Knock constructor"} ${name} is aliased, mutated, or accessed outside a direct new expression; automatic receiver proof is disabled.`,
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
    if (bindingScopeNode(name, path) !== binding.scopeNode) return;
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
    const owner = parentPath?.parentPath?.node;
    if (member?.type === "MemberExpression" && member.object === path.node && !member.computed
      && propertyName(member.property) === "Knock"
      && owner?.type === "NewExpression" && owner.callee === member) {
      return;
    }
    safe = false;
  });
  return safe && sawDeclaration;
}

function clientReferencesAreSafe(
  root: any,
  name: string,
  declarationPath: any,
  declarationNode: object
): boolean {
  const scopeNode = bindingScopeNode(name, declarationPath);
  if (!scopeNode) return false;
  let safe = true;
  let sawDeclaration = false;
  root.find(j.Identifier, { name }).forEach((path: any) => {
    if (!safe || bindingScopeNode(name, path) !== scopeNode) return;
    const nearestDeclaration = nearestBlockDeclaration(name, path);
    if (nearestDeclaration && nearestDeclaration !== declarationNode) return;
    if (path.node === declarationNode) {
      sawDeclaration = true;
      return;
    }
    if (isClearlyNonReferenceIdentifier(path) || isDirectApprovedClientCallReference(path)) return;
    safe = false;
  });
  return safe && sawDeclaration;
}

function isDirectApprovedClientCallReference(path: any): boolean {
  let memberPath = path.parentPath;
  let member = memberPath?.node;
  if (member?.type !== "MemberExpression" || member.object !== path.node
    || member.computed || member.optional === true) {
    return false;
  }
  while (memberPath.parentPath?.node?.type === "MemberExpression"
    && memberPath.parentPath.node.object === member) {
    memberPath = memberPath.parentPath;
    member = memberPath.node;
    if (member.computed || member.optional === true) return false;
  }
  const call = memberPath.parentPath?.node;
  return call?.type === "CallExpression" && call.optional !== true && call.callee === member
    && isApprovedKnockCallChain(memberChain(member));
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

function variableDeclarationKind(path: any): string | null {
  let cursor = path?.parentPath;
  while (cursor) {
    if (cursor.node?.type === "VariableDeclaration") return cursor.node.kind ?? null;
    if (["Program", "BlockStatement", "Statement"].includes(cursor.node?.type)) return null;
    cursor = cursor.parentPath;
  }
  return null;
}

function isConstructor(callee: any, bindings: Bindings, path: any): boolean {
  return (callee?.type === "Identifier" && hasScopedBinding(bindings.constructors, callee.name, path))
    || (callee?.type === "MemberExpression" && callee.object?.type === "Identifier"
      && hasScopedBinding(bindings.namespaces, callee.object.name, path) && propertyName(callee.property) === "Knock");
}

function isClientCall(callee: any, bindings: Bindings, path: any): boolean {
  const root = memberRoot(callee);
  return root?.type === "Identifier" && hasScopedBinding(bindings.clients, root.name, path);
}

function memberRoot(node: any): any {
  let current = node;
  while (current?.type === "MemberExpression" || current?.type === "OptionalMemberExpression") current = current.object;
  return current;
}

function memberChain(node: any): string[] {
  const names: string[] = [];
  let current = node;
  while (current?.type === "MemberExpression" || current?.type === "OptionalMemberExpression") {
    const name = propertyName(current.property);
    if (name) names.unshift(name);
    current = current.object;
  }
  return names;
}

function lastMember(node: any): string | null {
  return node?.type === "MemberExpression" || node?.type === "OptionalMemberExpression"
    ? propertyName(node.property)
    : null;
}

function replaceLastMember(node: any, name: string): void {
  if (node.property.type === "Identifier") node.property.name = name;
  else node.property.value = name;
}

function propertyName(node: any): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral" || node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  return null;
}

function locationKey(loc: any): string {
  return [
    loc?.start?.line ?? "?",
    loc?.start?.column ?? "?",
    loc?.end?.line ?? "?",
    loc?.end?.column ?? "?",
  ].join(":");
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
  path: any,
  declarationNode: object
): void {
  const scopeNode = bindingScopeNode(name, path);
  if (!scopeNode) return;
  const values = imports.get(name) ?? [];
  values.push({ source, importedName, scopeNode, declarationNode });
  imports.set(name, values);
}

function addLocalValue(
  values: Bindings["localValues"],
  name: string,
  init: any,
  path: any,
  declarationNode: object
): void {
  const scopeNode = bindingScopeNode(name, path);
  if (!scopeNode) return;
  const candidates = values.get(name) ?? [];
  candidates.push({ scopeNode, declarationNode, init, declarationPath: path });
  values.set(name, candidates);
}

function localImportAt(imports: Bindings["localImports"], name: string, path: any): LocalImportBinding | null {
  const scopeNode = bindingScopeNode(name, path);
  const candidates = imports.get(name)?.filter((item) => item.scopeNode === scopeNode) ?? [];
  const nearestBlock = nearestBlockDeclaration(name, path);
  return candidates.find((item) => !nearestBlock || item.declarationNode === nearestBlock) ?? null;
}

function localValueAt(values: Bindings["localValues"], name: string, path: any): LocalValueBinding | null {
  const scopeNode = bindingScopeNode(name, path);
  const candidates = values.get(name)?.filter((item) => item.scopeNode === scopeNode) ?? [];
  const nearestBlock = nearestBlockDeclaration(name, path);
  return candidates.find((item) => !nearestBlock || item.declarationNode === nearestBlock) ?? null;
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

function staticModuleLoaderSource(node: any): string | null {
  if (!node) return null;
  if (["AwaitExpression", "TSAsExpression", "TSTypeAssertion", "TypeCastExpression", "ChainExpression"].includes(node.type)) {
    return staticModuleLoaderSource(node.argument ?? node.expression);
  }
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    return staticModuleLoaderSource(node.object);
  }
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
    if (node.callee?.type === "Identifier" && node.callee.name === "require") {
      return literalString(node.arguments?.[0]);
    }
    if (node.callee?.type === "Import") return literalString(node.arguments?.[0]);
  }
  if (node.type === "ImportExpression") return literalString(node.source);
  return null;
}

function literalString(node: any): string | null {
  if (node?.type === "StringLiteral" || node?.type === "Literal") {
    return typeof node.value === "string" ? node.value : null;
  }
  return null;
}

function looksLikeKnockMethod(callee: any): boolean {
  const chain = memberChain(callee);
  const method = chain.at(-1);
  return Boolean(method && new Set([
    "notify", "identify", "update", "list", "trigger", "cancel",
    "setPreferences", "getPreferences", "addChannelData", "setChannelData",
    "createSchedules", "listSchedules", "updateSchedules", "deleteSchedules",
  ]).has(method));
}

function isApprovedKnockCallChain(chain: string[]): boolean {
  return new Set([
    "notify",
    "users.identify", "users.update", "users.list",
    "workflows.trigger", "workflows.cancel", "cancel",
    "users.setPreferences", "users.getPreferences",
    "users.addChannelData", "users.setChannelData",
    "setPreferences", "getPreferences", "addChannelData", "setChannelData",
    "createSchedules", "listSchedules", "updateSchedules", "deleteSchedules",
    "schedules.create", "schedules.list", "schedules.update", "schedules.delete",
  ]).has(chain.join("."));
}

function isLocalModule(source: string): boolean {
  return source === "." || source === ".." || source.startsWith("./") || source.startsWith("../");
}

function isLikelyConfiguredModuleSource(source: string): boolean {
  return isLocalModule(source) || source.startsWith("@/") || source.startsWith("~/")
    || source.startsWith("#") || source.startsWith("$") || source.startsWith("src/")
    || /(?:^|[/_.-])(client|knock)(?:$|[/_.-])/i.test(source);
}

function isKnockModule(source: string): boolean {
  return source === "@knocklabs/node" || source.startsWith("@knocklabs/node/");
}
