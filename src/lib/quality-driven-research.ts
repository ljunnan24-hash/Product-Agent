import {
  applyExperimentResultToEvidenceBrief,
  generateEvidenceBrief
} from "./evidence-agent";
import { runJudgeAgent } from "./agent-judge";
import { buildReportEvidenceBindings } from "./report-evidence-binding";
import { attachReportQualityToTrace, evaluateReportQuality } from "./report-quality";
import {
  completeLatestEvidenceResearchLoop,
  type EvidenceResearchLoopProgressEvent,
  runEvidenceResearchLoop
} from "./web-research";
import type {
  AgentTraceStep,
  AnalysisFollowUpTurn,
  AnalysisRecord,
  EvidenceBrief,
  EvidenceSearchIntent,
  EvidenceSearchQuery,
  EvidenceSearchTarget,
  QualityResearchEvidenceDelta,
  QualityResearchRunSummary,
  ReportQualityIssue,
  UploadedMaterial,
  WebEvidence,
  WebResearchSummary
} from "./types";

export type QualityResearchProgressEvent = {
  stage:
    | "prepare"
    | "audit"
    | "query_plan"
    | "search"
    | "crawl"
    | "evidence_brief"
    | "quality_gate"
    | "save";
  status: "running" | "completed" | "skipped" | "failed";
  title: string;
  summary: string;
  queryCount?: number;
  resultCount?: number;
  crawledCount?: number;
  confidenceBefore?: number;
  confidenceAfter?: number;
  qualityScore?: number;
};

export type QualityIssueResearchResult = {
  record: AnalysisRecord;
  issue: ReportQualityIssue;
  traceStep: AgentTraceStep;
  confidenceBefore: number;
  confidenceAfter: number;
  decisionBefore?: EvidenceBrief["decision"]["decision"];
  decisionAfter: EvidenceBrief["decision"]["decision"];
  queryCount: number;
  resultCount: number;
  summary: QualityResearchRunSummary;
};

export async function runQualityIssueResearch({
  record,
  issueId,
  researchedAt,
  onProgress
}: {
  record: AnalysisRecord;
  issueId: string;
  researchedAt: string;
  onProgress?: (event: QualityResearchProgressEvent) => void;
}): Promise<QualityIssueResearchResult> {
  onProgress?.({
    stage: "prepare",
    status: "running",
    title: "读取当前报告",
    summary: "正在读取报告、证据账本、网页调研和校准上下文。"
  });
  if (!record.report) {
    throw new Error("Report not found.");
  }
  if (!record.evidenceBrief) {
    throw new Error("Evidence Brief not found.");
  }
  onProgress?.({
    stage: "prepare",
    status: "completed",
    title: "当前上下文就绪",
    summary: `证据置信 ${record.evidenceBrief.confidenceScore}，当前决策 ${record.evidenceBrief.decision.decision}。`,
    confidenceBefore: record.evidenceBrief.confidenceScore
  });

  const materials = materialsForQualityResearch(record);
  onProgress?.({
    stage: "audit",
    status: "running",
    title: "定位质检问题",
    summary: "正在用最新版报告质检规则重新计算问题，避免执行过期 issue。"
  });
  const audit = evaluateReportQuality({
    report: record.report,
    evidenceBrief: record.evidenceBrief,
    webResearch: record.webResearch,
    materials,
    calibrationContext: record.calibrationContext,
    reportEvidenceBindings: record.reportEvidenceBindings
  });
  const issue = audit.issues.find((item) => item.id === issueId);
  if (!issue) {
    throw new Error("该质检问题已经不存在或不需要补证。");
  }
  const researchPlan = issue.repairDraft?.researchPlan;
  if (!researchPlan) {
    throw new Error("该质检问题没有可执行的补查计划。");
  }
  onProgress?.({
    stage: "audit",
    status: "completed",
    title: "质检问题已锁定",
    summary: `命中「${issue.title}」，补查计划包含 ${researchPlan.queries.length} 条 query。`,
    queryCount: researchPlan.queries.length
  });

  const beforeEvidenceBrief = record.evidenceBrief;
  let webResearch = record.webResearch ?? emptyWebResearch();
  const beforeWebResearch = webResearch;
  const nextRound = (webResearch.researchLoops?.length ?? 0) + 1;
  const input = {
    brief: qualityResearchBrief(record, issue),
    materials,
    productName: record.productName || "未命名产品",
    runtimeId: record.id
  };
  const customQueries = queriesFromResearchPlan({
    issue,
    researchPlan,
    round: nextRound
  });

  if (!customQueries.length) {
    throw new Error("补查计划没有可执行 query。");
  }

  webResearch = await runEvidenceResearchLoop({
    input,
    webResearch,
    evidenceBrief: beforeEvidenceBrief,
    round: nextRound,
    customQueries,
    trigger: `质检补证：${issue.title}`,
    reason: researchPlan.trigger,
    onProgress: (event) => onProgress?.(qualityProgressFromEvidenceLoop(event))
  });

  onProgress?.({
    stage: "evidence_brief",
    status: "running",
    title: "重算证据账本",
    summary: "正在把新增搜索结果和网页正文归一成 Evidence Card，并重新计算置信度。"
  });
  let evidenceBrief = generateEvidenceBrief({
    brief: input.brief,
    materials,
    webResearch,
    productName: record.productName,
    visibleText: qualityVisibleText(record),
    workType: record.workType
  });
  const previousExperiment = beforeEvidenceBrief.recommendedExperiment;
  if (previousExperiment?.result) {
    evidenceBrief = applyExperimentResultToEvidenceBrief(
      {
        ...evidenceBrief,
        recommendedExperiment: {
          ...previousExperiment,
          result: null
        }
      },
      previousExperiment.result
    );
  }
  webResearch = completeLatestEvidenceResearchLoop(webResearch, evidenceBrief);
  const judged = await runJudgeAgent({
    evidenceBrief,
    webResearch,
    contextLabel: `质检补证：${issue.title}`
  });
  webResearch = judged.webResearch;
  onProgress?.({
    stage: "evidence_brief",
    status: "completed",
    title: "证据账本与 Judge 已更新",
    summary: `证据置信 ${beforeEvidenceBrief.confidenceScore} -> ${evidenceBrief.confidenceScore}，Judge：${judged.verdict.summary}`,
    confidenceBefore: beforeEvidenceBrief.confidenceScore,
    confidenceAfter: evidenceBrief.confidenceScore
  });

  onProgress?.({
    stage: "quality_gate",
    status: "running",
    title: "重跑报告质检",
    summary: "正在用新的证据账本重新检查证据质量、校准一致性和实验可执行性。"
  });
  const reportEvidenceBindings = buildReportEvidenceBindings({
    report: record.report,
    evidenceBrief
  });
  const reportQualityAudit = evaluateReportQuality({
    report: record.report,
    evidenceBrief,
    webResearch,
    materials,
    calibrationContext: record.calibrationContext,
    reportEvidenceBindings
  });
  onProgress?.({
    stage: "quality_gate",
    status: "completed",
    title: "报告质检已更新",
    summary: `质检分 ${reportQualityAudit.score}，剩余问题 ${reportQualityAudit.issues.length} 个。`,
    qualityScore: reportQualityAudit.score
  });
  const latestLoop = webResearch.researchLoops?.[webResearch.researchLoops.length - 1];
  const summary = buildQualityResearchSummary({
    issue,
    researchedAt,
    trigger: researchPlan.trigger,
    queryCount: customQueries.length,
    resultCount: latestLoop?.resultCount ?? 0,
    beforeEvidenceBrief,
    afterEvidenceBrief: evidenceBrief,
    beforeAudit: audit,
    afterAudit: reportQualityAudit,
    beforeWebResearch,
    afterWebResearch: webResearch
  });
  const traceStep = qualityResearchTraceStep({
    issue,
    queryCount: customQueries.length,
    resultCount: latestLoop?.resultCount ?? 0,
    confidenceBefore: beforeEvidenceBrief.confidenceScore,
    confidenceAfter: evidenceBrief.confidenceScore,
    decisionBefore: beforeEvidenceBrief.decision.decision,
    decisionAfter: evidenceBrief.decision.decision
  });
  const updatedRecord: AnalysisRecord = {
    ...record,
    updatedAt: researchedAt,
    webResearch,
    evidenceBrief,
    reportQualityAudit,
    reportEvidenceBindings,
    qualityResearchRuns: [
      summary,
      ...(record.qualityResearchRuns ?? []).filter((item) => item.id !== summary.id)
    ].slice(0, 12),
    agentTrace: attachReportQualityToTrace(
      [...(record.agentTrace ?? []), traceStep].slice(-80),
      reportQualityAudit
    )
  };

  return {
    record: updatedRecord,
    issue,
    traceStep,
    confidenceBefore: beforeEvidenceBrief.confidenceScore,
    confidenceAfter: evidenceBrief.confidenceScore,
    decisionBefore: beforeEvidenceBrief.decision.decision,
    decisionAfter: evidenceBrief.decision.decision,
    queryCount: customQueries.length,
    resultCount: latestLoop?.resultCount ?? 0,
    summary
  };
}

function buildQualityResearchSummary({
  issue,
  researchedAt,
  trigger,
  queryCount,
  resultCount,
  beforeEvidenceBrief,
  afterEvidenceBrief,
  beforeAudit,
  afterAudit,
  beforeWebResearch,
  afterWebResearch
}: {
  issue: ReportQualityIssue;
  researchedAt: string;
  trigger: string;
  queryCount: number;
  resultCount: number;
  beforeEvidenceBrief: EvidenceBrief;
  afterEvidenceBrief: EvidenceBrief;
  beforeAudit: NonNullable<ReturnType<typeof evaluateReportQuality>>;
  afterAudit: NonNullable<ReturnType<typeof evaluateReportQuality>>;
  beforeWebResearch: WebResearchSummary;
  afterWebResearch: WebResearchSummary;
}): QualityResearchRunSummary {
  const afterIssue = afterAudit.issues.find((item) => item.id === issue.id);
  const newEvidence = qualityResearchEvidenceDelta({
    beforeEvidenceBrief,
    afterEvidenceBrief,
    beforeWebResearch,
    afterWebResearch
  });
  const crawledCount = newEvidence.filter((item) => item.sourceType === "crawled_url").length;
  const remainingGaps = qualityResearchRemainingGaps(afterEvidenceBrief, afterAudit);
  const stillOpen = Boolean(afterIssue);
  const shouldApplyRepairDraft = Boolean(afterIssue?.repairDraft);

  return {
    id: crypto.randomUUID(),
    createdAt: researchedAt,
    issueId: issue.id,
    issueTitle: issue.title,
    trigger,
    queryCount,
    resultCount,
    crawledCount,
    confidenceBefore: beforeEvidenceBrief.confidenceScore,
    confidenceAfter: afterEvidenceBrief.confidenceScore,
    decisionBefore: beforeEvidenceBrief.decision.decision,
    decisionAfter: afterEvidenceBrief.decision.decision,
    qualityScoreBefore: beforeAudit.score,
    qualityScoreAfter: afterAudit.score,
    newEvidence,
    remainingGaps,
    stillOpen,
    stillOpenIssueTitles: afterAudit.issues.slice(0, 5).map((item) => item.title),
    shouldApplyRepairDraft,
    applyRecommendation: qualityResearchApplyRecommendation({
      stillOpen,
      shouldApplyRepairDraft,
      evidenceAdded: newEvidence.length,
      confidenceBefore: beforeEvidenceBrief.confidenceScore,
      confidenceAfter: afterEvidenceBrief.confidenceScore
    })
  };
}

function qualityResearchEvidenceDelta({
  beforeEvidenceBrief,
  afterEvidenceBrief,
  beforeWebResearch,
  afterWebResearch
}: {
  beforeEvidenceBrief: EvidenceBrief;
  afterEvidenceBrief: EvidenceBrief;
  beforeWebResearch: WebResearchSummary;
  afterWebResearch: WebResearchSummary;
}): QualityResearchEvidenceDelta[] {
  const beforeKeys = new Set([
    ...beforeEvidenceBrief.evidenceCards.map(evidenceCardKey),
    ...webResearchSources(beforeWebResearch).map(webEvidenceKey)
  ]);
  const deltas: QualityResearchEvidenceDelta[] = [];

  for (const card of afterEvidenceBrief.evidenceCards) {
    if (card.sourceType === "uploaded_material" || beforeKeys.has(evidenceCardKey(card))) continue;
    deltas.push({
      title: card.sourceTitle,
      url: card.sourceUrl,
      sourceType: card.sourceType,
      snippet: card.quoteOrSnippet,
      publishedAt: card.publishedAt,
      updatedAt: card.updatedAt,
      capturedAt: card.capturedAt,
      recencyBucket: card.recencyBucket,
      assumptionId: card.assumptionId,
      signalType: card.signalType,
      direction: card.direction,
      objectiveLevel: card.objectiveLevel,
      behaviorStrength: card.behaviorStrength,
      credibilityScore: card.credibilityScore,
      confidence: card.confidence,
      interpretation: card.interpretation,
      caveat: card.caveat,
      whyIncluded: whyEvidenceDeltaIncluded(card.direction, card.interpretation, card.caveat)
    });
  }

  if (deltas.length >= 6) return dedupeEvidenceDeltas(deltas).slice(0, 6);

  for (const source of webResearchSources(afterWebResearch)) {
    if (beforeKeys.has(webEvidenceKey(source))) continue;
    deltas.push({
      title: source.title,
      url: source.url,
      sourceType: source.sourceType,
      sourceName: source.sourceName,
      snippet: source.snippet,
      publishedAt: source.publishedAt,
      updatedAt: source.updatedAt,
      dateSource: source.dateSource,
      recencyBucket: source.recencyBucket,
      assumptionId: source.assumptionId,
      signalType: source.searchIntent,
      whyIncluded: whyWebEvidenceDeltaIncluded(source)
    });
  }

  return dedupeEvidenceDeltas(deltas).slice(0, 6);
}

function whyEvidenceDeltaIncluded(
  direction: "support" | "oppose" | "neutral",
  interpretation: string,
  caveat: string
) {
  const directionText =
    direction === "support"
      ? "它补强了某个关键假设。"
      : direction === "oppose"
        ? "它提供了反证或风险信号。"
        : "它提供了上下文，但不能单独支持强结论。";
  return [directionText, interpretation, caveat].filter(Boolean).join(" ");
}

function whyWebEvidenceDeltaIncluded(source: WebEvidence) {
  const directionText =
    source.searchTarget === "opposition" || source.searchIntent === "opposition"
      ? "它来自反证查询，可用于降低过度乐观判断。"
      : source.searchTarget === "freshness" || source.searchIntent === "recency"
        ? "它来自时效查询，可用于判断证据是否仍然成立。"
        : "它来自补证查询，可用于补齐 Source Budget。";
  const sourceText =
    source.sourceType === "crawled_url"
      ? "系统已抓取网页正文，比搜索摘要更适合进入证据判断。"
      : "它是搜索结果候选，需要结合 URL、日期和后续正文抓取谨慎使用。";
  return [directionText, sourceText].join(" ");
}

function qualityResearchRemainingGaps(
  evidenceBrief: EvidenceBrief,
  audit: ReturnType<typeof evaluateReportQuality>
) {
  const stopGaps = evidenceBrief.evidenceStop?.minimumEvidenceNeeded ?? [];
  const budgetGaps = evidenceBrief.sourceBudgets
    .filter((budget) => budget.status !== "met")
    .flatMap((budget) =>
      budget.missingEvidence.map((item) => `${budget.label}：${item}`)
    );
  const evidenceGaps = evidenceBrief.evidenceGaps.map(
    (gap) => `${gap.assumptionId}：${gap.missingEvidence}`
  );
  const qualityGaps = audit.issues
    .slice(0, 3)
    .map((issue) => `${issue.title}：${issue.fix}`);

  return uniqueStrings([...stopGaps, ...budgetGaps, ...evidenceGaps, ...qualityGaps]).slice(0, 6);
}

function qualityResearchApplyRecommendation({
  stillOpen,
  shouldApplyRepairDraft,
  evidenceAdded,
  confidenceBefore,
  confidenceAfter
}: {
  stillOpen: boolean;
  shouldApplyRepairDraft: boolean;
  evidenceAdded: number;
  confidenceBefore: number;
  confidenceAfter: number;
}) {
  if (!stillOpen) {
    return "补证后该质检问题已解除，暂不需要应用这条修复草案。";
  }
  if (shouldApplyRepairDraft && evidenceAdded > 0) {
    return "补证后问题仍存在，建议先阅读新增证据，再应用更新后的修复草案。";
  }
  if (shouldApplyRepairDraft && confidenceAfter > confidenceBefore) {
    return "证据置信有所提升但问题仍存在，建议应用草案时继续保留证据边界。";
  }
  return "补证后问题仍存在且新增证据有限，优先补充原始实验或更具体材料，再考虑应用草案。";
}

function webResearchSources(webResearch: WebResearchSummary) {
  return [...(webResearch.crawled ?? []), ...(webResearch.searchResults ?? [])];
}

function evidenceCardKey(card: EvidenceBrief["evidenceCards"][number]) {
  return `${card.sourceType}:${normalizeEvidenceKey(card.sourceUrl || card.sourceTitle)}`;
}

function webEvidenceKey(source: WebEvidence) {
  return `${source.sourceType}:${normalizeEvidenceKey(source.url || source.title)}`;
}

function normalizeEvidenceKey(value: string) {
  return value.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").trim();
}

function dedupeEvidenceDeltas(items: QualityResearchEvidenceDelta[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.sourceType}:${normalizeEvidenceKey(item.url || item.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function qualityProgressFromEvidenceLoop(
  event: EvidenceResearchLoopProgressEvent
): QualityResearchProgressEvent {
  return {
    stage: event.stage,
    status: event.status,
    title: event.title,
    summary: event.summary,
    queryCount: event.queryCount,
    resultCount: event.resultCount,
    crawledCount: event.crawledCount
  };
}

function queriesFromResearchPlan({
  issue,
  researchPlan,
  round
}: {
  issue: ReportQualityIssue;
  researchPlan: NonNullable<NonNullable<ReportQualityIssue["repairDraft"]>["researchPlan"]>;
  round: number;
}): EvidenceSearchQuery[] {
  return researchPlan.queries
    .map(cleanResearchQuery)
    .filter(Boolean)
    .slice(0, 6)
    .map((query, index) => {
      const intent = inferSearchIntent(query, issue);
      return {
        id: `quality-${round}-${slug(issue.id)}-${index + 1}`,
        assumptionId: assumptionIdForIntent(intent, issue),
        intent,
        phase: "evidence_loop",
        targetDirection: targetForIntent(intent),
        query,
        rationale: researchPlan.trigger,
        expectedEvidence: `质检补证：${issue.title}`,
        priority: index < 3 ? 1 : 2
      };
    });
}

function cleanResearchQuery(value: string) {
  return value
    .replace(/^补证查询[:：]\s*/, "")
    .replace(/^执行「[^」]+」查询[:：]\s*/, "")
    .replace(/^重试「[^」]+」查询[:：]\s*/, "")
    .replace(/^补近期证据[:：]\s*/, "")
    .replace(/^用摘要标题重新搜索并要求返回原始 URL[:：]\s*/, "")
    .replace(/^抓取网页正文并记录日期[:：]\s*/, "")
    .split("；")[0]
    .trim();
}

function inferSearchIntent(
  query: string,
  issue: ReportQualityIssue
): EvidenceSearchIntent {
  const text = `${query} ${issue.title} ${issue.finding}`.toLowerCase();
  if (/price|pricing|paid|pay|revenue|customer|付费|定价|收入|预算/.test(text)) return "payment";
  if (/alternative|competitor|compare|替代|竞品|对比/.test(text)) return "alternative";
  if (/fail|failed|abandoned|shutdown|complaint|negative|反证|失败|关闭|负面|太贵|不用/.test(text)) {
    return "opposition";
  }
  if (/recent|release|changelog|roadmap|updated|最近|近期|时效|更新/.test(text)) return "recency";
  if (/channel|distribution|product hunt|hacker news|社区|分发|渠道/.test(text)) return "distribution";
  if (/ai|agent|llm|模型/.test(text)) return "ai_advantage";
  return "problem";
}

function assumptionIdForIntent(intent: EvidenceSearchIntent, issue: ReportQualityIssue) {
  if (intent === "payment") return "payment";
  if (intent === "alternative") return "alternative";
  if (intent === "opposition") return "opposition";
  if (intent === "recency") return "recency";
  if (intent === "distribution") return "distribution";
  if (intent === "ai_advantage") return "ai_advantage";
  return issue.category === "calibration_alignment" ? "calibration_alignment" : "problem";
}

function targetForIntent(intent: EvidenceSearchIntent): EvidenceSearchTarget {
  if (intent === "opposition") return "opposition";
  if (intent === "recency") return "freshness";
  return "support";
}

function qualityResearchBrief(record: AnalysisRecord, issue: ReportQualityIssue) {
  const plan = issue.repairDraft?.researchPlan;
  return [
    record.brief,
    `Quality issue: ${issue.title}`,
    issue.finding,
    plan?.trigger,
    ...(plan?.queries ?? [])
  ]
    .filter(Boolean)
    .join("\n\n");
}

function qualityVisibleText(record: AnalysisRecord) {
  const followUps = record.followUps?.filter((turn) => turn.evidenceAppliedAt) ?? [];
  return [
    record.visibleText,
    ...followUps.map((turn) => `${turn.userMessage}\n${turn.materials.map((material) => material.extractedText || material.textPreview || "").join("\n")}`)
  ]
    .filter(Boolean)
    .join("\n\n");
}

function materialsForQualityResearch(record: AnalysisRecord) {
  const appliedTurns = record.followUps?.filter((turn) => turn.evidenceAppliedAt) ?? [];
  const followUpMaterials = appliedTurns.flatMap((turn) => prefixedFollowUpMaterials(turn));
  return dedupeMaterials([...(record.materials ?? []), ...followUpMaterials]);
}

function prefixedFollowUpMaterials(turn: AnalysisFollowUpTurn) {
  return turn.materials.map((material) => ({
    ...material,
    id: `followup-${turn.id}-${material.id}`,
    name: `追问补充 · ${material.name}`
  }));
}

function qualityResearchTraceStep({
  issue,
  queryCount,
  resultCount,
  confidenceBefore,
  confidenceAfter,
  decisionBefore,
  decisionAfter
}: {
  issue: ReportQualityIssue;
  queryCount: number;
  resultCount: number;
  confidenceBefore: number;
  confidenceAfter: number;
  decisionBefore: EvidenceBrief["decision"]["decision"];
  decisionAfter: EvidenceBrief["decision"]["decision"];
}): AgentTraceStep {
  return {
    stage: "evidence_agent",
    title: "质检驱动补证",
    status: "completed",
    summary: `针对「${issue.title}」执行 ${queryCount} 条补查 query，新增候选结果 ${resultCount} 条；证据置信 ${confidenceBefore} -> ${confidenceAfter}。`,
    toolCalls: [
      {
        id: crypto.randomUUID(),
        stage: "evidence_agent",
        toolName: "run_quality_issue_research",
        status: "completed",
        inputSummary: issue.repairDraft?.researchPlan?.trigger || issue.finding,
        outputSummary: `决策 ${decisionBefore} -> ${decisionAfter}；新增结果 ${resultCount} 条。`,
        latencyMs: 8
      }
    ]
  };
}

function emptyWebResearch(): WebResearchSummary {
  return {
    extractedUrls: [],
    crawled: [],
    searchResults: [],
    skippedReasons: [],
    queries: []
  };
}

function dedupeMaterials(materials: UploadedMaterial[]) {
  const seen = new Set<string>();
  return materials.filter((material) => {
    const key = material.url || material.id || material.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
}
