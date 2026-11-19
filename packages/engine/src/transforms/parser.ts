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
export function parseWithParser(filePath: string, source: string): { root: any; print: () => string } {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const parser = /\.d\.(?:ts|mts|cts)$/.test(filePath) ? declarationParser : PARSER_BY_EXT[ext] ?? "ts";
  const j = jsc.withParser(parser);
  const root = j(source);
  // ast-types 0.16 requires an identifier to scan a bare catch and its body.
  // Rewrites can move a handler and create new scope paths, so keep the stand-in
  // on the node throughout analysis. Its name cannot occur in a JS binding.
  const catches = source.includes("catch") ? root.find(jsc.CatchClause, { param: null }).nodes() : [];
  for (const node of catches) node.param = jsc.identifier("(omitted catch binding)");
  return {
    root,
    print() {
      for (const node of catches) node.param = null;
      return root.toSource({ quote: "double" });
    },
  };
}
