import type {
  ProductDiagnosisReport,
  ProductEvidenceSignal,
  ReportQualityIssue,
  ReportRewriteDiffLine,
  ReportRewriteRevision
} from "./types";

export function applyReportRepairDraft({
  report,
  issue,
  revisionId,
  createdAt
}: {
  report: ProductDiagnosisReport;
  issue: ReportQualityIssue;
  revisionId: string;
  createdAt: string;
}): {
  report: ProductDiagnosisReport;
  revision: ReportRewriteRevision;
} {
  if (!issue.repairDraft) {
    throw new Error("该质检问题没有可应用的修复草案。");
  }

  const draft = issue.repairDraft;
  const nextReport = cloneReport(report);
  const beforeText = sectionText(nextReport, draft.targetSection);

  if (draft.targetSection === "potential_verdict") {
    nextReport.potential_verdict = draft.replacementText;
  } else if (draft.targetSection === "market_evidence") {
    nextReport.market_evidence = prependUniqueMarketEvidence(nextReport, {
      signal: draft.title,
      evidence: draft.replacementText,
      interpretation: draft.whyThisFix
    });
  } else if (draft.targetSection === "top_issues") {
    nextReport.top_issues = prependUniqueIssue(nextReport, {
      title: draft.title,
      why_it_matters: draft.whyThisFix,
      how_to_fix: draft.replacementText
    });
  } else if (draft.targetSection === "actionable_suggestions") {
    nextReport.actionable_suggestions = prependUniqueStrings(
      nextReport.actionable_suggestions,
      splitDraftLines(draft.replacementText)
    );
  } else {
    nextReport.limitations = prependUniqueStrings(nextReport.limitations, [
      draft.replacementText
    ]);
  }

  const afterText = sectionText(nextReport, draft.targetSection);

  return {
    report: nextReport,
    revision: {
      id: revisionId,
      createdAt,
      issueId: issue.id,
      issueTitle: issue.title,
      targetSection: draft.targetSection,
      draftTitle: draft.title,
      beforeText,
      afterText,
      diff: makeReportTextDiff(beforeText, afterText),
      summary: `应用「${draft.title}」到${targetSectionLabel(draft.targetSection)}。`,
      evidenceRefs: draft.evidenceRefs
    }
  };
}

export function rollbackReportRevision({
  report,
  revision,
  rolledBackAt
}: {
  report: ProductDiagnosisReport;
  revision: ReportRewriteRevision;
  rolledBackAt: string;
}): {
  report: ProductDiagnosisReport;
  revision: ReportRewriteRevision;
} {
  const nextReport = cloneReport(report);
  restoreSectionText(nextReport, revision.targetSection, revision.beforeText);

  return {
    report: nextReport,
    revision: {
      ...revision,
      rolledBackAt,
      diff: revision.diff ?? makeReportTextDiff(revision.beforeText, revision.afterText),
      summary: `${revision.summary} 已回滚。`
    }
  };
}

export function hasAppliedRepairDraft(
  revisions: ReportRewriteRevision[] | undefined,
  issue: ReportQualityIssue
) {
  if (!issue.repairDraft) return false;
  return Boolean(
    revisions?.some(
      (revision) =>
        revision.issueId === issue.id &&
        revision.targetSection === issue.repairDraft?.targetSection &&
        revision.afterText.includes(issue.repairDraft.replacementText.slice(0, 80))
    )
  );
}

function cloneReport(report: ProductDiagnosisReport): ProductDiagnosisReport {
  return JSON.parse(JSON.stringify(report)) as ProductDiagnosisReport;
}

function sectionText(
  report: ProductDiagnosisReport,
  targetSection: ReportRewriteRevision["targetSection"]
) {
  if (targetSection === "potential_verdict") return report.potential_verdict || "";
  if (targetSection === "market_evidence") {
    return report.market_evidence
      .map((item) => `${item.signal}\n${item.evidence}\n${item.interpretation}`)
      .join("\n\n");
  }
  if (targetSection === "top_issues") {
    return report.top_issues
      .map((item) => `${item.title}\n${item.why_it_matters}\n${item.how_to_fix}`)
      .join("\n\n");
  }
  if (targetSection === "actionable_suggestions") {
    return report.actionable_suggestions.join("\n");
  }
  return report.limitations.join("\n");
}

function restoreSectionText(
  report: ProductDiagnosisReport,
  targetSection: ReportRewriteRevision["targetSection"],
  text: string
) {
  if (targetSection === "potential_verdict") {
    report.potential_verdict = text;
    return;
  }

  if (targetSection === "market_evidence") {
    report.market_evidence = parseMarketEvidenceSection(text);
    return;
  }

  if (targetSection === "top_issues") {
    report.top_issues = parseIssueSection(text);
    return;
  }

  if (targetSection === "actionable_suggestions") {
    report.actionable_suggestions = splitRestoredLines(text);
    return;
  }

  report.limitations = splitRestoredLines(text);
}

export function makeReportTextDiff(
  beforeText: string,
  afterText: string
): ReportRewriteDiffLine[] {
  const beforeLines = splitDiffLines(beforeText);
  const afterLines = splitDiffLines(afterText);
  if (!beforeLines.length && !afterLines.length) return [];

  const dp = Array.from({ length: beforeLines.length + 1 }, () =>
    Array(afterLines.length + 1).fill(0) as number[]
  );

  for (let row = beforeLines.length - 1; row >= 0; row -= 1) {
    for (let col = afterLines.length - 1; col >= 0; col -= 1) {
      dp[row][col] =
        beforeLines[row] === afterLines[col]
          ? dp[row + 1][col + 1] + 1
          : Math.max(dp[row + 1][col], dp[row][col + 1]);
    }
  }

  const diff: ReportRewriteDiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      diff.push({ type: "unchanged", text: beforeLines[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (dp[beforeIndex + 1][afterIndex] >= dp[beforeIndex][afterIndex + 1]) {
      diff.push({ type: "removed", text: beforeLines[beforeIndex] });
      beforeIndex += 1;
    } else {
      diff.push({ type: "added", text: afterLines[afterIndex] });
      afterIndex += 1;
    }
  }

  while (beforeIndex < beforeLines.length) {
    diff.push({ type: "removed", text: beforeLines[beforeIndex] });
    beforeIndex += 1;
  }

  while (afterIndex < afterLines.length) {
    diff.push({ type: "added", text: afterLines[afterIndex] });
    afterIndex += 1;
  }

  return compressUnchangedDiff(diff).slice(0, 80);
}

function prependUniqueMarketEvidence(
  report: ProductDiagnosisReport,
  item: ProductDiagnosisReport["market_evidence"][number]
) {
  return [
    item,
    ...report.market_evidence.filter(
      (existing) => normalize(existing.signal) !== normalize(item.signal)
    )
  ];
}

function prependUniqueIssue(
  report: ProductDiagnosisReport,
  item: ProductDiagnosisReport["top_issues"][number]
) {
  return [
    item,
    ...report.top_issues.filter(
      (existing) => normalize(existing.title) !== normalize(item.title)
    )
  ];
}

function prependUniqueStrings(existing: string[], additions: string[]) {
  const seen = new Set<string>();
  return [...additions, ...existing].filter((item) => {
    const key = normalize(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseMarketEvidenceSection(text: string): ProductDiagnosisReport["market_evidence"] {
  return splitSectionBlocks(text).map((block): ProductEvidenceSignal => {
    const [signal = "", evidence = "", ...rest] = block.split("\n");
    return {
      signal: signal.trim() || "市场证据",
      evidence: evidence.trim() || signal.trim(),
      interpretation: rest.join("\n").trim() || evidence.trim() || signal.trim()
    };
  });
}

function parseIssueSection(text: string): ProductDiagnosisReport["top_issues"] {
  return splitSectionBlocks(text).map((block) => {
    const [title = "", why = "", ...rest] = block.split("\n");
    return {
      title: title.trim() || "问题",
      why_it_matters: why.trim() || title.trim(),
      how_to_fix: rest.join("\n").trim() || why.trim() || title.trim()
    };
  });
}

function splitSectionBlocks(text: string) {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function splitRestoredLines(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function splitDiffLines(text: string) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines : text.trim() ? [text.trim()] : [];
}

function compressUnchangedDiff(diff: ReportRewriteDiffLine[]) {
  const compact: ReportRewriteDiffLine[] = [];
  let unchangedCount = 0;

  diff.forEach((line) => {
    if (line.type !== "unchanged") {
      if (unchangedCount > 2) {
        compact.push({ type: "unchanged", text: `... ${unchangedCount - 2} 行未变化 ...` });
      }
      unchangedCount = 0;
      compact.push(line);
      return;
    }

    unchangedCount += 1;
    if (unchangedCount <= 2) {
      compact.push(line);
    }
  });

  if (unchangedCount > 2) {
    compact.push({ type: "unchanged", text: `... ${unchangedCount - 2} 行未变化 ...` });
  }

  return compact;
}

function splitDraftLines(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function targetSectionLabel(targetSection: ReportRewriteRevision["targetSection"]) {
  if (targetSection === "potential_verdict") return "潜力判断";
  if (targetSection === "market_evidence") return "市场证据";
  if (targetSection === "top_issues") return "问题段落";
  if (targetSection === "actionable_suggestions") return "行动建议";
  return "限制条件";
}
