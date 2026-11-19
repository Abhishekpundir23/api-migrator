/**
 * Parser selection — pick a jscodeshift parser based on file extension so that
 * TypeScript type annotations (and JSX) parse correctly.
 *
 * The default `j(source)` uses the babylon parser and chokes on `: type`
 * annotations. Both transform sets route through this helper so the behavior is
 * consistent and correct across .ts/.tsx/.js/.jsx.
 */

import * as jscodeshift from "jscodeshift";
import { parse } from "@babel/parser";

const jsc: any = (jscodeshift as any).default ?? (jscodeshift as any);

const PARSER_BY_EXT: Record<string, string> = {
  ".ts": "ts",
  ".cts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
  ".js": "babel",
  ".cjs": "babel",
  ".mjs": "babel",
  ".jsx": "babel",
};

// Declaration files are ambient modules, where e.g. an exported const can
// declare a type without an initializer. Ordinary TypeScript mode rejects it.
const declarationParser = {
  parse(source: string) {
    return parse(source, {
      sourceType: "module",
      tokens: true,
      plugins: [["typescript", { dts: true }], "decorators-legacy", "importAttributes"],
    });
  },
};

/**
 * Get a jscodeshift bound to the right parser for `filePath`, then parse
 * `source`. Throws if the source is invalid for that parser.
 */
export function parseWithParser(filePath: string, source: string): any {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const parser = /\.d\.(?:ts|mts|cts)$/.test(filePath) ? declarationParser : PARSER_BY_EXT[ext] ?? "ts";
  const j = jsc.withParser(parser);
  const root = j(source);
  if (source.includes("catch")) prepareCatchScopes(root);
  return root;
}

// ast-types 0.16 expects a pattern when it scans a catch scope and only
// collects declarations from the body into the enclosing scope for a named
// catch. Prime its scope tables with a name no JS identifier can have, then
// restore the source AST before a transform sees or prints it.
function prepareCatchScopes(root: any): void {
  const handlers = root.find(jsc.CatchClause, { param: null }).paths();
  if (handlers.length === 0) return;
  const placeholder = "(omitted catch binding)";
  for (const path of handlers) path.get("param").replace(jsc.identifier(placeholder));
  try {
    for (const path of handlers) {
      const handler = path.scope;
      delete handler.getBindings()[placeholder];
      let enclosing = handler.parent;
      while (enclosing?.node.type === "CatchClause") enclosing = enclosing.parent;
      enclosing?.scan();
    }
  } finally {
    for (const path of handlers) path.get("param").replace(null);
  }
}

/** Render a jscodeshift AST back to source. */
export function toSource(root: any): string {
  return root.toSource({ quote: "double" });
}
