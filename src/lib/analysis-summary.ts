import { evaluateReportQuality, isCurrentReportQualityAudit } from "./report-quality";
import type {
  AnalysisRecord,
  ProductDecision,
  ProductLifecycleStage,
  ReportQualityAudit
} from "./types";

export type AnalysisSummary = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: AnalysisRecord["status"];
  productName: string;
  workType: AnalysisRecord["workType"];
  productVariant: AnalysisRecord["productVariant"];
  oneLineDiagnosis: string;
  potentialScore: number | null;
  diagnosisScore: number | null;
  evidenceConfidence: number | null;
  decision: ProductDecision["decision"] | null;
  lifecycleStage: ProductLifecycleStage | null;
  reportQualityScore: number | null;
  reportQualityStatus: ReportQualityAudit["status"] | null;
  materialCount: number;
  webEvidenceCount: number;
  evidenceCardCount: number;
  sourceBudgetScore: number | null;
  unmetBudgetCount: number;
  topEvidenceGap: string;
  topIssueTitle: string;
  nextExperimentTitle: string;
  hasExperimentResult: boolean;
  hasRevisions: boolean;
  revisionCount: number;
  searchProvider: string;
  model: string;
  errorMessage: string | null;
};

export function summarizeAnalysis(record: AnalysisRecord): AnalysisSummary {
  const audit = getAudit(record);
  const report = record.report;
  const evidenceBrief = record.evidenceBrief;
  const sourceBudgets = Array.isArray(evidenceBrief?.sourceBudgets)
    ? evidenceBrief.sourceBudgets
    : [];
  const evidenceCards = Array.isArray(evidenceBrief?.evidenceCards)
    ? evidenceBrief.evidenceCards
    : [];
  const unmetBudgets = sourceBudgets.filter((budget) => budget.status !== "met");
  const webEvidenceCount =
    (record.webResearch?.crawled.length ?? 0) +
    (record.webResearch?.searchResults.length ?? 0);
  const topBudgetGap = unmetBudgets[0]
    ? `${unmetBudgets[0].label}：${unmetBudgets[0].missingEvidence[0] || "证据未达标"}`
    : "";

  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt || record.createdAt,
    status: record.status,
    productName:
      record.productName ||
      report?.share_summary?.current_style ||
      record.brief ||
      "未命名产品",
    workType: record.workType,
    productVariant: record.productVariant,
    oneLineDiagnosis:
      report?.share_summary?.one_line_diagnosis ||
      report?.potential_verdict ||
      record.errorMessage ||
      "分析记录",
    potentialScore: report?.potential_score ?? null,
    diagnosisScore: report?.diagnosis_score ?? null,
    evidenceConfidence: evidenceBrief?.confidenceScore ?? null,
    decision: evidenceBrief?.decision.decision ?? null,
    lifecycleStage: evidenceBrief?.productLifecycleStage ?? null,
    reportQualityScore: audit?.score ?? null,
    reportQualityStatus: audit?.status ?? null,
    materialCount: record.materials?.length ?? 0,
    webEvidenceCount,
    evidenceCardCount: evidenceCards.length,
    sourceBudgetScore: evidenceBrief?.sourceBudgetScore ?? null,
    unmetBudgetCount: unmetBudgets.length,
    topEvidenceGap:
      topBudgetGap ||
      evidenceBrief?.evidenceGaps?.[0]?.missingEvidence ||
      audit?.issues?.[0]?.title ||
      "",
    topIssueTitle: audit?.issues?.[0]?.title || "",
    nextExperimentTitle: evidenceBrief?.recommendedExperiment?.title || "",
    hasExperimentResult: Boolean(evidenceBrief?.recommendedExperiment?.result),
    hasRevisions: Boolean(record.reportRevisions?.length),
    revisionCount: record.reportRevisions?.length ?? 0,
    searchProvider: record.webResearch?.searchProvider || "none",
    model: record.model,
    errorMessage: record.errorMessage
  };
}

function getAudit(record: AnalysisRecord) {
  if (isCurrentReportQualityAudit(record.reportQualityAudit)) return record.reportQualityAudit;
  if (!record.report) return null;
  return evaluateReportQuality({
    report: record.report,
    evidenceBrief: record.evidenceBrief,
    webResearch: record.webResearch,
    materials: record.materials ?? [],
    calibrationContext: record.calibrationContext
  });
}
