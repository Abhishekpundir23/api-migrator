import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { readRepositoryFile } from "./repository-files.js";
import type { ReportEntry } from "./types.js";

const WORKFLOWS = ".github/workflows";
const MAX_DIRECTORY_ENTRIES = 1024;
const MAX_WORKFLOW_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * MAX_WORKFLOW_BYTES;
const MAX_COMMAND_CHARS = 16 * 1024;
const action = "Inngest v4 Cloud requires a signed GET for SDK introspection. Poll the application's public health endpoint for readiness and keep registration on PUT /api/inngest.";

interface Line { text: string; line: number }

/** Read only GitHub's direct workflow files. YAML stays outside the JS/TS inventory. */
export function inngestWorkflowReviewEntries(root: string): ReportEntry[] {
  for (const part of [".github", WORKFLOWS]) {
    // The checkout is supplied to the offline owner CLI at runtime. It is not part of the console bundle.
    const stat = lstatSync(join(/* turbopackIgnore: true */ root, part), { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Assessment workflow directory must not be a symlink: ${part}`);
    if (!stat?.isDirectory()) return [];
  }
  const names: string[] = [];
  const dir = opendirSync(join(root, WORKFLOWS));
  try {
    let count = 0;
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++count > MAX_DIRECTORY_ENTRIES) throw new Error("Assessment workflow inventory exceeds 1024 directory entries");
      if (!/\.ya?ml$/i.test(entry.name) || entry.isDirectory()) continue;
      if (entry.name.includes("\\")) throw new Error("Unsupported backslash in local workflow path");
      names.push(entry.name);
    }
  } finally {
    dir.closeSync();
  }
  let remaining = MAX_TOTAL_BYTES;
  const findings: ReportEntry[] = [];
  for (const name of names.sort()) {
    const file = `${WORKFLOWS}/${name}`;
    const bytes = readRepositoryFile(root, file, { label: "Assessment workflow file", maxBytes: Math.min(MAX_WORKFLOW_BYTES, remaining) });
    remaining -= bytes.length;
    for (const line of unsignedReadinessChecks(bytes.toString("utf8"))) {
      findings.push({ code: "F16", kind: "review", file, line, message: action });
    }
  }
  return findings;
}

/** Locate literal shell steps by YAML indentation. Skip folded, templated or indirect actions. */
function* shellSteps(lines: string[]): Generator<Line[]> {
  const indent = (s: string) => s.length - s.trimStart().length;
  const meaningful = (s: string) => !!s.trim() && !s.trimStart().startsWith("#");
  const parents: { key: string; indent: number }[] = [];
  let stepsIndent: number | undefined;
  let itemIndent: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!meaningful(raw)) continue;
    const offset = indent(raw);
    const value = raw.trim();
    if (stepsIndent !== undefined && (offset < stepsIndent || (offset === stepsIndent && !value.startsWith("- ")))) {
      stepsIndent = itemIndent = undefined;
    }
    if (stepsIndent !== undefined) {
      if (value.startsWith("- ") && (itemIndent === undefined || offset <= itemIndent)) itemIndent = offset;
      const direct = itemIndent !== undefined && ((offset === itemIndent && value.startsWith("- ")) || offset === itemIndent + 2);
      const run = direct && /^(?:-\s+)?run:\s*(.*)$/.exec(value);
      if (!run) continue;
      if (/^\|[+-]?\s*(?:#.*)?$/.test(run[1])) {
        const block: Line[] = [];
        const keyIndent = itemIndent! + 2;
        while (i + 1 < lines.length && (!lines[i + 1].trim() || indent(lines[i + 1]) > keyIndent)) {
          i++;
          block.push({ text: lines[i].trim(), line: i + 1 });
        }
        yield block;
      } else if (!/^[>|*&]/.test(run[1])) {
        yield [{ text: run[1], line: i + 1 }];
      }
      continue;
    }
    while (parents.length && parents[parents.length - 1].indent >= offset) parents.pop();
    const mapping = /^([\w.-]+):\s*(?:#.*)?$/.exec(value);
    if (!mapping) continue;
    if (parents.length === 2 && parents[0].key === "jobs" && parents[0].indent === 0 && mapping[1] === "steps") {
      stepsIndent = offset;
    } else {
      parents.push({ key: mapping[1], indent: offset });
    }
  }
}

/** Parse shell words without evaluating a command substitution, expression, or variable. */
function words(input: string): string[] {
  const tokens: string[] = [];
  let word = "", quote = "";
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "\\" && quote !== "'") { word += input[++i] ?? ""; continue; }
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "#" && !word) break;
    else if (c === ">") {
      const redirect = /^>(?:\s*\/dev\/null|&[12])(?=\s|[|&;)]|$)/.exec(input.slice(i));
      if (!redirect || (word && !/^[12]$/.test(word))) return [];
      word = "";
      i += redirect[0].length - 1;
    } else if ("|&;)".includes(c)) break;
    else if (/\s/.test(c)) { if (word) tokens.push(word); word = ""; }
    else word += c;
  }
  if (quote) return [];
  if (word) tokens.push(word);
  return tokens;
}

function expand(input: string, vars: Map<string, string>): string {
  let result = "", offset = 0;
  for (const match of input.matchAll(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g)) {
    result += input.slice(offset, match.index) + (vars.get(match[1] ?? match[2]) ?? match[0]);
    if (result.length > MAX_COMMAND_CHARS) return "";
    offset = match.index! + match[0].length;
  }
  return result + input.slice(offset);
}

function curlGet(input: string, vars: Map<string, string>) {
  const args = words(input);
  const publicHeader = (header: string) => /^(?:accept|content-type|user-agent):/i.test(header);
  let url = "", statusFormat = false, fail = false, retry = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("-")) {
      if (url) return;
      url = expand(token, vars);
      continue;
    }
    if (token.startsWith("--")) {
      const split = token.indexOf("=");
      const option = split < 0 ? token : token.slice(0, split);
      const argument = () => split < 0 ? args[++i] ?? "" : token.slice(split + 1);
      if (option === "--request") { if (argument().toUpperCase() !== "GET") return; }
      else if (option === "--header") { if (!publicHeader(argument())) return; }
      else if (option === "--url") { if (url) return; url = expand(argument(), vars); }
      else if (option === "--write-out") statusFormat ||= /%\{(?:http_code|response_code)\}/.test(argument());
      else if (option === "--fail" || option === "--fail-with-body") fail = true;
      else if (option === "--retry") { retry = true; argument(); }
      else if (["--output", "--retry-delay", "--max-time", "--connect-timeout"].includes(option)) argument();
      else if (!["--silent", "--show-error", "--location", "--retry-all-errors", "--insecure", "--get"].includes(option)) return;
      continue;
    }
    for (let j = 1; j < token.length; j++) {
      const flag = token[j];
      if ("sSLkG".includes(flag)) continue;
      if (flag === "f") { fail = true; continue; }
      if (!"HXwom".includes(flag)) return; // includes credentials, config, data, HEAD
      const arg = token.slice(j + 1) || args[++i] || "";
      if (flag === "H" && !publicHeader(arg)) return;
      if (flag === "X" && arg.toUpperCase() !== "GET") return;
      if (flag === "w") statusFormat ||= /%\{(?:http_code|response_code)\}/.test(arg);
      break;
    }
  }
  if (/(?:^|\/\/)(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?=[:/]|$)/i.test(url)) return;
  if (!/\/api\/inngest\/?(?:[?#].*)?$/.test(url)) return;
  return { statusFormat, fail, retry };
}

function unsignedReadinessChecks(source: string): number[] {
  const findings: number[] = [];
  for (const step of shellSteps(source.split(/\r?\n/))) {
    // A heredoc can contain apparent commands as data. Leave these steps to a human.
    if (step.some(({ text }) => /(?:^|\s)\d*<<-?\s*[^<]/.test(text))) continue;
    const commands: Line[] = [];
    for (let i = 0; i < step.length; i++) {
      const line = step[i].line;
      let text = step[i].text;
      while (text.endsWith("\\") && i + 1 < step.length) {
        const next = step[++i].text;
        if (text.length <= MAX_COMMAND_CHARS) text = text.slice(0, -1) + " " + next;
        else if (!next.endsWith("\\")) break;
      }
      if (text && text.length <= MAX_COMMAND_CHARS && !text.startsWith("#")) commands.push({ text, line });
    }
    const vars = new Map<string, string>();
    for (let i = 0; i < commands.length; i++) {
      const { text, line } = commands[i];
      const invocation = /^(?:(if|while|until)\s+(?:!\s*)?)?(?:([A-Za-z_]\w*)=["']?\$\(\s*)?(?:command\s+)?curl\s+(.+)$/.exec(text);
      if (!invocation) {
        const assignment = /^(?:export\s+)?([A-Za-z_]\w*)=(.*)$/.exec(text);
        if (assignment) {
          const value = words(assignment[2]);
          if (value.length === 1) vars.set(assignment[1], expand(value[0], vars));
          else vars.delete(assignment[1]);
        }
        continue;
      }
      if (invocation[2]) vars.delete(invocation[2]);
      const probe = curlGet(invocation[3], vars);
      if (!probe) continue;
      const ignoredFailure = /\|\|\s*(?:true|:)(?:\s*[;#)]|\s*$)/.test(text);
      if (probe.fail && (invocation[1] || probe.retry) && !ignoredFailure) {
        findings.push(line);
        continue;
      }
      if (!invocation[2] || !probe.statusFormat) continue;
      const key = invocation[2];
      const accepts200 = new RegExp('^(?:if|while|until)\\s+\\[{1,2}\\s+["\']?\\$(?:\\{' + key + '\\}|' + key + ')["\']?\\s+(?:==?|!=|-eq|-ne)\\s+["\']?200["\']?\\s+\\]{1,2}\\s*(?:;\\s*(?:then|do))?\\s*$');
      if (commands.slice(i + 1, i + 5).some(follow => accepts200.test(follow.text))) findings.push(line);
    }
  }
  return findings;
}
