/**
 * Parser selection — pick a jscodeshift parser based on file extension so that
 * TypeScript type annotations (and JSX) parse correctly.
 *
 * The default `j(source)` uses the babylon parser and chokes on `: type`
 * annotations. Both transform sets route through this helper so the behavior is
 * consistent and correct across .ts/.tsx/.js/.jsx.
 */

import * as jscodeshift from "jscodeshift";

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

/**
 * Get a jscodeshift bound to the right parser for `filePath`, then parse
 * `source`. Throws if the source is invalid for that parser.
 */
export function parseWithParser(filePath: string, source: string): any {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const parser = PARSER_BY_EXT[ext] ?? "ts"; // default to ts (superset-ish)
  const j = jsc.withParser(parser);
  return j(source);
}

/** Render a jscodeshift AST back to source. */
export function toSource(root: any): string {
  return root.toSource({ quote: "double" });
}
