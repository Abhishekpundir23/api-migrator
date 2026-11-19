import { sep } from "node:path";
import j from "jscodeshift";
import { readRepositoryFile } from "./repository-files.js";
import { parseWithParser } from "./transforms/parser.js";
import type { ReportSink } from "./types.js";

const MAX_GUIDES = 2000;
const MAX_GUIDE_BYTES = 1024 * 1024;
const MAX_GUIDE_TOTAL = 16 * 1024 * 1024;
const GUIDE_PATH = /^(?:README\.md|AGENTS\.md|(?:docs|\.cursor\/(?:rules|skills))\/.+\.(?:md|mdc))$/i;
const LANGUAGE: Record<string, string> = { js: "js", javascript: "js", jsx: "jsx", ts: "ts", typescript: "ts", tsx: "tsx" };

function checkExample(file: string, language: string, lines: string[], firstLine: number, sink: ReportSink) {
  const source = lines.join("\n");
  if (!source.includes("createFunction")) return;
  let root;
  try {
    root = parseWithParser("example." + language, source).root;
  } catch {
    // Documentation may deliberately contain placeholders or incomplete pseudocode.
    return;
  }
  root.find(j.CallExpression).forEach((path: any) => {
    const call = path.node;
    const receiver = call.callee;
    if (receiver.type !== "MemberExpression" || receiver.computed ||
        receiver.object.type !== "Identifier" || receiver.object.name !== "inngest" ||
        receiver.property.name !== "createFunction" || call.arguments.length !== 3) return;
    const binding = path.scope.lookup("inngest")?.getBindings().inngest;
    if (binding && !binding.some((p: any) => {
      const declaration = p.parent.node;
      return declaration.type === "ImportSpecifier" || declaration.type === "ImportDefaultSpecifier" ||
        (declaration.type === "VariableDeclarator" && declaration.init?.type === "NewExpression" &&
         declaration.init.callee.name === "Inngest");
    })) return;
    const [options, trigger] = call.arguments;
    const triggers = trigger.type === "ArrayExpression" ? trigger.elements : [trigger];
    if (options.type !== "ObjectExpression" || !triggers.some((t: any) =>
      t?.type === "ObjectExpression" && t.properties.some((p: any) =>
        !p.computed && ["event", "cron"].includes(p.key?.name ?? p.key?.value)))) return;
    sink.push({ code: "F17", kind: "review", file, line: firstLine + trigger.loc.start.line - 1,
      message: "This example passes a trigger as a separate argument to inngest.createFunction. Move it into options.triggers for v4 or label the example as v3." });
  });
}

function checkFences(file: string, text: string, sink: ReportSink) {
  if (!text.includes("createFunction")) return;
  const lines = text.split(/\r?\n/);
  let fence: { marker: string; language: string | undefined; start: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]);
    if (!match) continue;
    const [, marker, info] = match;
    if (!fence) {
      if (marker[0] === "`" && info.includes("`")) continue;
      const tag = info.trim().split(/\s+/)[0].toLowerCase();
      fence = { marker, language: Object.hasOwn(LANGUAGE, tag) ? LANGUAGE[tag] : undefined, start: index + 1 };
    } else if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length && !info.trim()) {
      if (fence.language) checkExample(file, fence.language, lines.slice(fence.start, index), fence.start + 1, sink);
      fence = undefined;
    }
  }
}

/** Collect regular guide paths during the source walk. Read them only for a matching Inngest project. */
export class InngestGuides {
  private readonly paths: string[] = [];
  private overflow = false;

  collect(relativePath: string): void {
    const path = relativePath.split(sep).join("/");
    if (!GUIDE_PATH.test(path)) return;
    if (this.paths.length >= MAX_GUIDES) this.overflow = true;
    else this.paths.push(path);
  }

  review(root: string, sink: ReportSink): void {
    if (this.overflow) {
      sink.push({ code: "F17", kind: "review", file: "(repository)", line: null,
        message: "Guide inventory exceeds 2,000 files. Review SDK examples in the authoring guides separately." });
      return;
    }
    let total = 0;
    for (const file of this.paths.sort()) {
      if (total >= MAX_GUIDE_TOTAL) {
        sink.push({ code: "F17", kind: "review", file: "(repository)", line: null,
          message: "Guide inventory reached the 16 MiB reading limit. Check the remaining authoring guides locally." });
        break;
      }
      let bytes: Buffer;
      try {
        bytes = readRepositoryFile(root, file, { label: "SDK authoring guide", maxBytes: Math.min(MAX_GUIDE_BYTES, MAX_GUIDE_TOTAL - total) });
      } catch {
        sink.push({ code: "F17", kind: "review", file, line: null,
          message: "This guide could not be read within the assessment limits. Check its SDK examples locally." });
        continue;
      }
      total += bytes.length;
      checkFences(file, bytes.toString("utf8"), sink);
    }
  }
}
