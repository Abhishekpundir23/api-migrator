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
  const recipe = reports[0].recipe;
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
