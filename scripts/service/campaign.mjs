import { TRANSFORM_ALLOWLIST } from "@api-migrator/engine";
import { ruleGuidance, validateSummary } from "./brief.mjs";

function quantity(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Count each rule once per assessment while retaining all occurrences. */
export function renderCampaign(summaries) {
  if (!Array.isArray(summaries) || summaries.length === 0 || summaries.length > 100) {
    throw new Error("Supply between 1 and 100 assessments for one SDK recipe.");
  }
  const reports = summaries.map(validateSummary);
  return formatCampaign(reports, reports[0].recipe);
}

/** Operator aliases stay in this local report. Summary files are read from the intake directory only. */
export function renderTrackedCampaign(submissions, roster) {
  if (!roster || Object.keys(roster).length !== 2 || typeof roster.recipe !== "string" ||
      !Object.hasOwn(TRANSFORM_ALLOWLIST, roster.recipe) || !Array.isArray(roster.repositories) ||
      !roster.repositories.length || roster.repositories.length > 100) {
    throw new Error("A roster requires a supported recipe and 1 to 100 repositories.");
  }
  const names = new Set();
  const aliases = new Set();
  const reports = new Map();
  for (const [name, input] of submissions) reports.set(name, validateSummary(input));
  const rows = [];
  for (const item of roster.repositories) {
    if (!item || Object.keys(item).length !== 2 || typeof item.alias !== "string" ||
        !/^[a-z0-9][a-z0-9 -]{0,47}$/i.test(item.alias) || item.alias !== item.alias.trim() ||
        typeof item.summary !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}\.json$/i.test(item.summary) ||
        !item.summary.endsWith(".json")) {
      throw new Error("Each roster entry requires a short plain-text alias and a .json filename.");
    }
    const alias = item.alias.toLowerCase();
    const name = item.summary.toLowerCase();
    if (aliases.has(alias) || names.has(name)) throw new Error("Roster aliases and filenames must be unique.");
    aliases.add(alias);
    names.add(name);
    const report = reports.get(item.summary);
    if (!report) {
      rows.push(`| ${item.alias} | Awaiting assessment | — | — |`);
      continue;
    }
    const rules = report.findings.filter(f => f.kind === "review").map(f => f.code);
    const status = report.sourceFiles === 0 ? "Received, no supported files" : "Received";
    rows.push(`| ${item.alias} | ${status} | ${report.wouldChangeFiles} | ${rules.join(", ") || "None reported"} |`);
  }
  const expected = new Set(roster.repositories.map(item => item.summary));
  if ([...reports.keys()].some(name => !expected.has(name))) {
    throw new Error("An intake filename does not match any roster entry. Check the roster and filename casing.");
  }
  const coverage = [
    "## Participation", "",
    `${reports.size} of ${rows.length} invited repositories submitted an assessment. Pending repositories have unknown migration impact.`, "",
    "| Repository alias | Submission | Files with proposed edits | Manual review rules |",
    "| --- | --- | ---: | --- |", ...rows, "",
    "This report includes operator-assigned repository aliases. Keep it with the campaign team.", "",
  ];
  return formatCampaign([...reports.values()], roster.recipe, coverage);
}

function formatCampaign(reports, recipe, coverage = []) {
  if (reports.some(report => report.recipe !== recipe)) {
    throw new Error("A campaign must use the same SDK migration recipe for every assessment.");
  }

  const groups = { review: new Map(), applied: new Map() };
  let sourceFiles = 0, matchedFiles = 0, wouldChangeFiles = 0;
  let matchedReports = 0, editReports = 0, reviewReports = 0;
  for (const report of reports) {
    sourceFiles += report.sourceFiles;
    matchedFiles += report.matchedFiles;
    wouldChangeFiles += report.wouldChangeFiles;
    if (report.matchedFiles > 0) matchedReports++;
    if (report.wouldChangeFiles > 0) editReports++;
    if (report.findings.some(finding => finding.kind === "review")) reviewReports++;
    for (const finding of report.findings) {
      const byCode = groups[finding.kind];
      const row = byCode.get(finding.code) ?? { code: finding.code, assessments: 0, occurrences: 0 };
      row.assessments++;
      row.occurrences += finding.count;
      byCode.set(finding.code, row);
    }
  }

  const lines = [
    `# SDK migration campaign · ${recipe}`,
    "",
    ...coverage,
    `Across ${quantity(reports.length, "assessment")} covering ${quantity(sourceFiles, "source file")}, the recipe matched ${quantity(matchedFiles, "file")} and proposed edits to ${quantity(wouldChangeFiles, "file")}.`,
    "",
    "| Scope | Assessments |",
    "| --- | ---: |",
    `| Any match or recipe finding | ${matchedReports} |`,
    `| At least one proposed edit | ${editReports} |`,
    `| At least one manual review finding | ${reviewReports} |`,
    "",
  ];
  for (const [kind, title] of [["review", "Manual review across repositories"], ["applied", "Proposed edits across repositories"]]) {
    lines.push("## " + title, "");
    const rows = [...groups[kind].values()].sort((a, b) => b.assessments - a.assessments ||
      b.occurrences - a.occurrences || a.code.localeCompare(b.code, "en", { numeric: true }));
    if (rows.length === 0) {
      lines.push("No findings of this kind were reported.", "");
      continue;
    }
    lines.push("| Rule | Assessments | Occurrences | Reviewer action |", "| --- | ---: | ---: | --- |");
    for (const row of rows) {
      lines.push(`| ${row.code} | ${row.assessments} | ${row.occurrences} | ${ruleGuidance(recipe, row.code)} |`);
    }
    lines.push("");
  }

  lines.push("## Reading the counts", "",
    "Each assessment contributes at most once to a rule’s assessment count. One assessment can have both edit and review findings. Use review rules shared by several repositories to plan a common verification step or document the decision for maintainers.",
    "",
    "The operator must supply one current summary per distinct repository. The aggregate format omits repository identities, so this report cannot detect duplicate submissions.",
    "",
    "These source-only simulations estimate the scope of the upgrade. Type checks, application tests and maintainer review are still needed to verify behavior. Measuring time saved requires observing actual migrations.",
    "");
  return lines.join("\n");
}
