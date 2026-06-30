import type {
  AgentTraceStep,
  EvidenceBrief,
  ProductDiagnosisReport,
  ProductAnalysisCalibrationContext,
  ReportEvidenceBinding,
  ReportQualityAudit,
  ReportQualityCategory,
  ReportQualityCheck,
  ReportQualityIssue,
  ReportQualityStatus,
  UploadedMaterial,
  WebResearchSummary
} from "./types";
import { buildReportEvidenceBindings } from "./report-evidence-binding";

type EvaluateReportQualityInput = {
  report: ProductDiagnosisReport;
  evidenceBrief?: EvidenceBrief;
  webResearch?: WebResearchSummary;
  materials?: UploadedMaterial[];
  calibrationContext?: ProductAnalysisCalibrationContext;
  reportEvidenceBindings?: ReportEvidenceBinding[];
};

type CheckResult = {
  check: ReportQualityCheck;
  issues: ReportQualityIssue[];
  strengths: string[];
};

const boundaryPattern = /证据不足|缺少|缺失|未找到|无法|不能|待验证|反证|假设|推断|未知/;
const recencyPattern = /时效|近期|日期|发布时间|更新时间|新鲜|当前市场|最近/;
const experimentPattern = /实验|测试|访谈|样本|指标|点击|留资|转化|等待名单|预约|demo|定价|价格|发布/iu;
const concretePattern =
  /\d|README|landing|Product Hunt|V2EX|即刻|Reddit|Hacker News|GitHub|邮件|demo|URL|截图|CSV|表格|定价|价格|按钮|访谈|用户|渠道|点击|留资|转化|样本|指标|天|小时|周|发布|等待名单|预约/iu;
const vaguePattern = /优化|提升|加强|完善|更清晰|更好|可考虑|建议适当|持续改进|增强|打磨/gu;
const overconfidentPattern = /证明|确定|必然|一定|显然|毫无疑问|高置信/gu;
const evidenceQualityBoundaryPattern =
  /证据质量|搜索质量|网页正文|搜索摘要|无 URL|无URL|低置信|抓取|失败|跳过|未执行|计划状态|日期覆盖|URL 覆盖|URL覆盖|过旧|历史证据|降权/iu;
const calibrationBoundaryPattern =
  /校准|回测|README|GitHub|高估|低估|升权|降权|样本不足|补样本|工具失败|真实采用|开发者采用|反证|低置信|不能直接|不等于/iu;
const currentClaimPattern = /当前|现在|近期|最近|市场|用户已经|明显|证明|高置信|强需求|继续构建|build/iu;
const REPORT_QUALITY_REQUIRED_CHECK_IDS = [
  "evidence-binding-v2",
  "evidence-quality",
  "calibration-action-alignment"
];

export function isCurrentReportQualityAudit(audit?: ReportQualityAudit | null) {
  if (!audit) return false;
  const checkIds = new Set(audit.checks.map((check) => check.id));
  const hasLegacyEvidenceQualityDraft = audit.issues.some(
    (issue) => issue.category === "evidence_quality" && issue.repairDraft?.targetSection === "limitations"
  );
  const hasLegacyCalibrationDraft = audit.issues.some(
    (issue) => issue.category === "calibration_alignment" && !issue.repairDraft?.researchPlan
  );
  return (
    REPORT_QUALITY_REQUIRED_CHECK_IDS.every((id) => checkIds.has(id)) &&
    !hasLegacyEvidenceQualityDraft &&
    !hasLegacyCalibrationDraft
  );
}

export function evaluateReportQuality(
  input: EvaluateReportQualityInput
): ReportQualityAudit {
  const context = makeContext(input);
  const results = [
    checkEvidenceBinding(context),
    checkEvidenceQuality(context),
    checkCalibrationActionAlignment(context),
    checkSpecificity(context),
    checkInferenceBoundary(context),
    checkExperimentReadiness(context),
    checkRecency(context),
    checkSourceCoverage(context)
  ];
  const checks = results.map((result) => result.check);
  const issues = attachRepairDrafts(
    results.flatMap((result) => result.issues).slice(0, 10),
    context
  );
  const strengths = uniqueStrings(results.flatMap((result) => result.strengths)).slice(0, 5);
  const rawScore = Math.round(average(checks.map((check) => check.score)));
  const status = auditStatus(rawScore, checks);
  const score =
    status === "fail"
      ? Math.min(rawScore, 54)
      : status === "warn"
        ? Math.min(rawScore, 82)
        : rawScore;
  const blockingCount = issues.filter((issue) => issue.severity === "blocker").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;

  return {
    generatedAt: new Date().toISOString(),
    score,
    status,
    summary:
      status === "pass"
        ? `质量门通过：报告和证据账本基本一致，还有 ${warningCount} 个小项可继续收紧。`
        : status === "warn"
          ? `质量门提醒：报告可用，但还有 ${warningCount || issues.length} 个证据或表达缺口需要修。`
          : `质量门未通过：发现 ${blockingCount || issues.length} 个会误导判断的关键问题。`,
    checks,
    issues,
    strengths
  };
}

export function attachReportQualityToTrace(
  trace: AgentTraceStep[] = [],
  audit: ReportQualityAudit
): AgentTraceStep[] {
  const failedChecks = audit.checks.filter((check) => check.status === "fail").length;
  const warningChecks = audit.checks.filter((check) => check.status === "warn").length;
  const toolCall = {
    id: crypto.randomUUID(),
    stage: "quality_gate" as const,
    toolName: "evaluate_report_quality",
    status: "completed" as const,
    inputSummary: "检查证据绑定、证据质量、具体性、推断边界、实验闭环、时效和 Source Budget 覆盖",
    outputSummary:
      failedChecks > 0
        ? `${failedChecks} 个检查未通过，${warningChecks} 个检查需注意`
        : `${warningChecks} 个检查需注意，报告可继续使用`,
    latencyMs: 8
  };
  let hasQualityGate = false;
  const nextTrace = trace.map((step) => {
    if (step.stage !== "quality_gate") return step;
    hasQualityGate = true;
    return {
      ...step,
      summary: `报告质量 ${audit.score}/100；${audit.summary}`,
      toolCalls: [
        ...(Array.isArray(step.toolCalls)
          ? step.toolCalls.filter((item) => item.toolName !== "evaluate_report_quality")
          : []),
        toolCall
      ]
    };
  });

  if (hasQualityGate) return nextTrace;

  return [
    ...nextTrace,
    {
      stage: "quality_gate",
      title: "质量检查",
      status: "completed",
      summary: `报告质量 ${audit.score}/100；${audit.summary}`,
      toolCalls: [toolCall]
    }
  ];
}

function makeContext(input: EvaluateReportQualityInput) {
  const report = input.report as ProductDiagnosisReport & {
    market_evidence?: ProductDiagnosisReport["market_evidence"];
    top_issues?: ProductDiagnosisReport["top_issues"];
    actionable_suggestions?: ProductDiagnosisReport["actionable_suggestions"];
    limitations?: ProductDiagnosisReport["limitations"];
  };
  const marketEvidence = Array.isArray(report.market_evidence)
    ? report.market_evidence
    : [];
  const topIssues = Array.isArray(report.top_issues) ? report.top_issues : [];
  const actionableSuggestions = Array.isArray(report.actionable_suggestions)
    ? report.actionable_suggestions
    : [];
  const limitations = Array.isArray(report.limitations) ? report.limitations : [];
  const reportText = [
    report.first_impression,
    report.potential_verdict,
    ...marketEvidence.flatMap((item) => [
      item.signal,
      item.evidence,
      item.interpretation
    ]),
    ...topIssues.flatMap((item) => [
      item.title,
      item.why_it_matters,
      item.how_to_fix
    ]),
    ...actionableSuggestions,
    ...limitations
  ].join("\n");
  const actionTexts = [
    ...topIssues.map((item) => item.how_to_fix),
    ...actionableSuggestions
  ].filter(Boolean);
  const evidenceCards = Array.isArray(input.evidenceBrief?.evidenceCards)
    ? input.evidenceBrief.evidenceCards
    : [];
  const webEvidenceCount =
    evidenceCards.filter((card) => card.sourceType !== "uploaded_material").length ||
    (input.webResearch?.crawled.length ?? 0) + (input.webResearch?.searchResults.length ?? 0);
  const sourceBudgets = Array.isArray(input.evidenceBrief?.sourceBudgets)
    ? input.evidenceBrief.sourceBudgets
    : [];
  const unmetBudgets = sourceBudgets.filter((budget) => budget.status !== "met");
  const evidenceQuality = buildEvidenceQualityProfile(input.webResearch, evidenceCards);
  const reportEvidenceBindings =
    input.reportEvidenceBindings ??
    (input.evidenceBrief
      ? buildReportEvidenceBindings({
          report,
          evidenceBrief: input.evidenceBrief
        })
      : []);

  return {
    ...input,
    reportText,
    actionTexts,
    evidenceCards,
    evidenceQuality,
    reportEvidenceBindings,
    webEvidenceCount,
    unmetBudgets,
    limitations
  };
}

function buildEvidenceQualityProfile(
  webResearch: WebResearchSummary | undefined,
  evidenceCards: EvidenceBrief["evidenceCards"]
) {
  const crawled = webResearch?.crawled ?? [];
  const searchResults = webResearch?.searchResults ?? [];
  const queryExecutions = webResearch?.queryExecutions ?? [];
  const queryPlan = webResearch?.queryPlan ?? [];
  const crawledBodyCount = crawled.filter(isCrawledBodyEvidence).length;
  const failedCrawlCount = crawled.filter(isFailedCrawlEvidence).length;
  const searchSummaries = searchResults.filter((item) => item.sourceType === "search_result");
  const urlMissingCount = searchSummaries.filter((item) => !item.url).length;
  const githubMetricCount = searchResults.filter((item) => item.sourceType === "github_repository").length;
  const executedCount = queryExecutions.filter((item) => item.status === "executed").length;
  const skippedCount = queryExecutions.filter((item) => item.status === "skipped").length;
  const failedCount = queryExecutions.filter((item) => item.status === "failed").length;
  const plannedCount = Math.max(0, queryPlan.length - queryExecutions.length);
  const historicalEvidenceCount = evidenceCards.filter((card) => card.recencyBucket === "historical").length;
  const unknownRecencyCount = evidenceCards.filter((card) => card.recencyBucket === "unknown_recency").length;

  return {
    crawledBodyCount,
    failedCrawlCount,
    searchSummaryCount: searchSummaries.length,
    urlMissingCount,
    githubMetricCount,
    executedCount,
    skippedCount,
    failedCount,
    plannedCount,
    failedOrSkippedCount: skippedCount + failedCount + failedCrawlCount,
    historicalEvidenceCount,
    unknownRecencyCount,
    searchQualityScore: webResearch?.searchQuality?.qualityScore ?? null,
    querySuccessRate: webResearch?.searchQuality?.querySuccessRate ?? null,
    urlCoverage: webResearch?.searchQuality?.urlCoverage ?? null,
    dateCoverage: webResearch?.searchQuality?.dateCoverage ?? null,
    warnings: webResearch?.searchQuality?.warnings ?? []
  };
}

function isCrawledBodyEvidence(item: WebResearchSummary["crawled"][number]) {
  return (
    item.sourceType === "crawled_url" &&
    Boolean(item.url) &&
    !isFailedCrawlEvidence(item) &&
    item.snippet.trim().length >= 120
  );
}

function isFailedCrawlEvidence(item: WebResearchSummary["crawled"][number]) {
  return /^(无法读取网页正文|抓取失败)/.test(item.snippet);
}

function checkEvidenceBinding(context: ReturnType<typeof makeContext>): CheckResult {
  const issues: ReportQualityIssue[] = [];
  const strengths: string[] = [];
  let score = 100;

  if (context.evidenceBrief?.evidenceStop && context.report.potential_score >= 70) {
    score -= 45;
    issues.push(
      issue(
        "evidence-binding-strong-decision",
        "evidence_binding",
        "blocker",
        "强结论没有被证据停止规则约束",
        `Evidence Stop 已阻断强决策，但报告潜力分仍为 ${context.report.potential_score}。`,
        context.evidenceBrief.evidenceStop.reason,
        "把结论改成 test_first，并明确哪些证据补齐后才允许 build / stop / reposition。"
      )
    );
  }

  if (context.evidenceBrief && Math.abs(context.report.potential_score - context.evidenceBrief.confidenceScore) > 28) {
    score -= 16;
    issues.push(
      issue(
        "evidence-binding-score-gap",
        "evidence_binding",
        "warning",
        "潜力分和证据置信度差距过大",
        `报告潜力分 ${context.report.potential_score}，证据置信 ${context.evidenceBrief.confidenceScore}。`,
        "两者可以不同，但差距过大时需要解释为什么。",
        "在 potential_verdict 中说明：潜力分高/低于证据置信度的原因。"
      )
    );
  }

  if (context.evidenceBrief) {
    const bindings = context.reportEvidenceBindings as ReportEvidenceBinding[];
    const importantBindings = bindings.filter((binding) =>
      binding.targetSection === "potential_verdict" ||
      binding.targetSection === "market_evidence" ||
      binding.targetSection === "top_issues" ||
      binding.targetSection === "actionable_suggestions"
    );
    const missingBindings = importantBindings.filter((binding) => binding.status === "missing");
    const weakBindings = importantBindings.filter((binding) => binding.status === "weak");
    const potentialBinding = bindings.find((binding) => binding.targetSection === "potential_verdict");

    if (potentialBinding?.status === "missing" && context.report.potential_score >= 60) {
      score -= context.report.potential_score >= 70 ? 34 : 22;
      issues.push(
        issue(
          "evidence-binding-potential-unbound",
          "evidence_binding",
          context.report.potential_score >= 70 ? "blocker" : "warning",
          "潜力判断没有绑定可核验证据",
          "产品潜力段落没有匹配到可复核 Evidence Card。",
          potentialBinding.rationale,
          "把潜力判断绑定到支持证据、反证和证据缺口；没有外部证据时降低语气。"
        )
      );
    }

    if (missingBindings.length >= 2) {
      score -= Math.min(28, missingBindings.length * 7);
      issues.push(
        issue(
          "evidence-binding-section-unbound",
          "evidence_binding",
          "warning",
          "多个报告段落缺少证据引用",
          `${missingBindings.length} 个关键段落没有绑定 Evidence Card：${missingBindings
            .slice(0, 3)
            .map((binding) => binding.targetLabel)
            .join("、")}。`,
          "用户无法核验这些判断来自哪些来源、是否有反证或是否过期。",
          "为潜力判断、市场证据、关键问题和行动建议补充证据引用；无法绑定时写成待验证假设。"
        )
      );
    } else if (weakBindings.length >= 3) {
      score -= 14;
      issues.push(
        issue(
          "evidence-binding-section-weak",
          "evidence_binding",
          "warning",
          "多个报告段落只有弱证据引用",
          `${weakBindings.length} 个关键段落只绑定到少量证据。`,
          "弱绑定适合低/中置信表达，不适合强建议。",
          "补充更直接的网页正文、用户行为证据或反证，再提升结论置信。"
        )
      );
    }
  }

  if (context.webEvidenceCount < 3 && context.report.potential_score > 60) {
    score -= 22;
    issues.push(
      issue(
        "evidence-binding-low-web",
        "evidence_binding",
        "warning",
        "外部证据不足时给分偏乐观",
        `当前外部网页证据 ${context.webEvidenceCount} 条，报告潜力分 ${context.report.potential_score}。`,
        "外部证据不足会让判断更依赖产品方叙事。",
        "降低潜力判断语气，或补充真实用户讨论、付费、替代方案和反证。"
      )
    );
  }

  if (context.evidenceBrief?.evidenceStop && !boundaryPattern.test(context.reportText)) {
    score -= 20;
    issues.push(
      issue(
        "evidence-binding-boundary-missing",
        "evidence_binding",
        "warning",
        "没有把证据边界写进报告",
        "报告文本没有明确提示证据不足、假设、反证或待验证。",
        "证据停止规则已经触发，用户需要知道哪些判断还不能下。",
        "在首段或限制条件中加入证据边界和最低补证清单。"
      )
    );
  }

  if (!issues.length) {
    strengths.push("报告结论和 Evidence Brief 的强弱约束基本一致。");
  }

  return checkResult({
    id: "evidence-binding",
    category: "evidence_binding",
    label: "证据绑定",
    score,
    okReason: "报告分数、结论和证据账本一致。",
    issues,
    strengths,
    minimumFixes: [
      "把每个关键判断绑定到 Evidence Card、Source Budget 或缺口。",
      "证据不足时只给 test_first，不给强 build 结论。"
    ]
  });
}

function checkEvidenceQuality(context: ReturnType<typeof makeContext>): CheckResult {
  const issues: ReportQualityIssue[] = [];
  const strengths: string[] = [];
  let score = 100;
  const quality = context.evidenceQuality;
  const strongConclusion =
    context.report.potential_score >= 70 ||
    context.evidenceBrief?.decision.decision === "build";
  const optimisticConclusion = context.report.potential_score >= 60;
  const hasQualityBoundary = evidenceQualityBoundaryPattern.test(context.reportText);
  const totalWeakSearchSignals = quality.searchSummaryCount + quality.urlMissingCount;

  if (totalWeakSearchSignals > 0 && quality.crawledBodyCount === 0 && !hasQualityBoundary) {
    score -= strongConclusion ? 32 : 20;
    issues.push(
      issue(
        "evidence-quality-no-body",
        "evidence_quality",
        strongConclusion ? "blocker" : "warning",
        "搜索结果没有网页正文支撑",
        `搜索摘要 ${quality.searchSummaryCount} 条，无 URL 摘要 ${quality.urlMissingCount} 条，可用网页正文 ${quality.crawledBodyCount} 条。`,
        "只有摘要时，证据强度低于已抓取网页正文，不能支撑强 build / stop 判断。",
        "在报告限制条件中说明：本轮外部证据主要来自搜索摘要，需要补抓原网页正文后再提高置信。"
      )
    );
  }

  if (quality.urlMissingCount > 0 && !hasQualityBoundary) {
    score -= strongConclusion ? 24 : 16;
    issues.push(
      issue(
        "evidence-quality-url-missing",
        "evidence_quality",
        strongConclusion ? "blocker" : "warning",
        "无 URL 摘要没有被降权",
        `${quality.urlMissingCount} 条搜索结果缺少原始 URL。`,
        "缺少 URL 的摘要无法复核来源，只能作为低置信线索。",
        "把无 URL 摘要标成低置信方向，不能作为市场存在、付费意愿或反证已经成立的直接证据。"
      )
    );
  }

  if (quality.failedOrSkippedCount > 0 && !hasQualityBoundary) {
    score -= 18;
    issues.push(
      issue(
        "evidence-quality-failed-skipped",
        "evidence_quality",
        "warning",
        "失败/跳过查询没有进入判断边界",
        `跳过查询 ${quality.skippedCount} 条，失败查询 ${quality.failedCount} 条，抓取失败 ${quality.failedCrawlCount} 条。`,
        "失败或跳过只说明工具链路没完成，不能被当成没有市场证据。",
        "在报告中明确：这些查询没有产出证据，需要重试或换 provider，不应计入支持/反证。"
      )
    );
  }

  if (quality.plannedCount > 0 && !hasQualityBoundary) {
    score -= 14;
    issues.push(
      issue(
        "evidence-quality-planned-query",
        "evidence_quality",
        "warning",
        "计划查询容易被误读成已查证",
        `${quality.plannedCount} 条查询仍停留在计划状态。`,
        "Query Plan 是调研意图，不是已获得的证据。",
        "把计划查询写入补证计划，而不是市场证据段落。"
      )
    );
  }

  if (
    quality.searchQualityScore !== null &&
    quality.searchQualityScore < 55 &&
    optimisticConclusion &&
    !hasQualityBoundary
  ) {
    score -= quality.searchQualityScore < 35 || strongConclusion ? 28 : 18;
    issues.push(
      issue(
        "evidence-quality-provider-low",
        "evidence_quality",
        quality.searchQualityScore < 35 || strongConclusion ? "blocker" : "warning",
        "搜索质量低但报告结论偏强",
        `搜索质量分 ${quality.searchQualityScore}，成功率 ${quality.querySuccessRate ?? 0}，URL 覆盖 ${quality.urlCoverage ?? 0}，日期覆盖 ${quality.dateCoverage ?? 0}。`,
        "搜索质量低时，高潜力判断必须降置信或补充可复核证据。",
        "降低潜力判断语气，并优先补带 URL、带日期、可抓正文的公开来源。"
      )
    );
  }

  if (
    quality.historicalEvidenceCount + quality.unknownRecencyCount > 3 &&
    currentClaimPattern.test(context.reportText) &&
    !hasQualityBoundary
  ) {
    score -= 18;
    issues.push(
      issue(
        "evidence-quality-stale-current-claim",
        "evidence_quality",
        "warning",
        "过旧或未知时效证据支撑了当前判断",
        `历史证据 ${quality.historicalEvidenceCount} 张，未知时效证据 ${quality.unknownRecencyCount} 张。`,
        "产品生命周期会变化，旧证据只能作为背景，不能直接支撑当前潜力。",
        "把历史/未知时效证据降权，并补充最近 12-18 个月的采用、负面反馈、定价或维护证据。"
      )
    );
  }

  if (
    quality.githubMetricCount > 0 &&
    /付费|留存|收入|商业化|愿意付费|市场需求/.test(context.reportText) &&
    !/GitHub.*不等于|不等于.*GitHub|开发者采用|不能.*付费|不能.*留存/.test(context.reportText)
  ) {
    score -= 12;
    issues.push(
      issue(
        "evidence-quality-github-metric-boundary",
        "evidence_quality",
        "warning",
        "GitHub 指标边界没有写清",
        `本轮包含 ${quality.githubMetricCount} 条 GitHub 指标证据。`,
        "stars/forks 可以说明开发者关注或采用，但不能直接证明付费、留存或商业需求。",
        "在报告中区分 GitHub 开发者采用、真实用户行为、付费和留存证据。"
      )
    );
  }

  if (!issues.length) {
    strengths.push("报告没有把摘要、失败查询、计划查询或过旧证据当作强证据使用。");
  }

  return checkResult({
    id: "evidence-quality",
    category: "evidence_quality",
    label: "证据质量",
    score,
    okReason: "报告正确区分了网页正文、搜索摘要、无 URL 摘要、失败/跳过查询和时效边界。",
    issues,
    strengths,
    minimumFixes: [
      "把无 URL 摘要、计划查询、失败/跳过查询标成低置信或非证据。",
      "强结论只使用可复核 URL、网页正文、近期证据或用户行为证据支撑。"
    ]
  });
}

function checkCalibrationActionAlignment(context: ReturnType<typeof makeContext>): CheckResult {
  const issues: ReportQualityIssue[] = [];
  const strengths: string[] = [];
  let score = 100;
  const actions = context.calibrationContext?.actions ?? [];
  const reportDecision = context.evidenceBrief?.decision.decision;
  const strongConclusion = context.report.potential_score >= 70 || reportDecision === "build";
  const optimisticConclusion = context.report.potential_score >= 60;
  const lowConclusion =
    context.report.potential_score <= 42 ||
    reportDecision === "stop" ||
    reportDecision === "reposition";
  const hasCalibrationBoundary = calibrationBoundaryPattern.test(context.reportText);
  const actionable = actions.filter((action) => action.confidence !== "low");
  const downweightActions = actionable.filter((action) => action.action === "downweight");
  const upweightActions = actionable.filter((action) => action.action === "upweight");
  const collectMoreActions = actions.filter(
    (action) => action.action === "collect_more" && action.neededSamples > 0
  );
  const toolingActions = actions.filter((action) => action.action === "fix_tooling");
  const holdActions = actionable.filter((action) => action.action === "hold");

  if (downweightActions.length && optimisticConclusion && !hasCalibrationBoundary) {
    score -= strongConclusion ? 38 : 24;
    const action = downweightActions[0];
    issues.push(
      issue(
        "calibration-alignment-downweight-ignored",
        "calibration_alignment",
        strongConclusion ? "blocker" : "warning",
        "报告没有执行 README 回测降权建议",
        `${action.target} 被校准账本标记为「${action.label}」，平均偏差 ${formatDelta(action.averageDelta)}，但报告潜力分为 ${context.report.potential_score}。`,
        action.reason,
        "降低结论语气，或明确说明为什么这次可以覆盖历史高估风险，并补真实采用/付费/反证证据。"
      )
    );
  }

  if (collectMoreActions.length && strongConclusion && !hasCalibrationBoundary) {
    score -= 30;
    const action = collectMoreActions[0];
    issues.push(
      issue(
        "calibration-alignment-sample-gap-ignored",
        "calibration_alignment",
        "blocker",
        "样本不足时给了强结论",
        `${action.target} 仍缺 ${action.neededSamples} 个校准样本，但报告潜力分为 ${context.report.potential_score}。`,
        action.reason,
        "把结论改为 test_first / 低置信，并说明需要继续跑 README 回测或补外部证据。"
      )
    );
  }

  if (upweightActions.length && lowConclusion && !hasCalibrationBoundary) {
    score -= 20;
    const action = upweightActions[0];
    issues.push(
      issue(
        "calibration-alignment-upweight-ignored",
        "calibration_alignment",
        "warning",
        "报告没有解释为什么忽略升权建议",
        `${action.target} 被校准账本标记为「${action.label}」，平均偏差 ${formatDelta(action.averageDelta)}，但报告给了偏低结论。`,
        action.reason,
        "如果仍要判 stop / reposition，需要说明本次证据如何覆盖历史低估风险；否则应转为 test_first。"
      )
    );
  }

  if (toolingActions.length && !hasCalibrationBoundary) {
    score -= optimisticConclusion ? 18 : 12;
    const action = toolingActions[0];
    issues.push(
      issue(
        "calibration-alignment-tooling-boundary",
        "calibration_alignment",
        "warning",
        "工具链失败没有写进校准边界",
        `${action.target} 被标记为需要先修工具链。`,
        action.reason,
        "把工具失败和产品潜力分开，说明失败样本不能作为产品没潜力或有潜力的证据。"
      )
    );
  }

  if (holdActions.length && (context.report.potential_score >= 82 || context.report.potential_score <= 28) && !hasCalibrationBoundary) {
    score -= 12;
    const action = holdActions[0];
    issues.push(
      issue(
        "calibration-alignment-hold-extreme",
        "calibration_alignment",
        "warning",
        "校准建议保持权重，但报告结论过于极端",
        `${action.target} 当前建议「${action.label}」，但报告潜力分为 ${context.report.potential_score}。`,
        action.reason,
        "如果要给极端分数，需要额外说明本次证据为什么足以突破历史校准边界。"
      )
    );
  }

  if (!actions.length) {
    strengths.push("本次分析没有适用的 README 回测校准动作。");
  } else if (!issues.length) {
    strengths.push("报告结论没有违背 README 回测升权、降权、补样本或工具链边界。");
  }

  return checkResult({
    id: "calibration-action-alignment",
    category: "calibration_alignment",
    label: "校准一致性",
    score,
    okReason: actions.length
      ? "报告结论和 README 回测校准动作一致。"
      : "本次没有 README/GitHub 校准动作需要约束报告。",
    issues,
    strengths,
    minimumFixes: [
      "降权动作命中时，不要给强 build，除非有真实采用/付费/反证证据覆盖。",
      "样本不足或工具链失败时，把校准边界写进 potential_verdict 或 limitations。"
    ]
  });
}

function checkSpecificity(context: ReturnType<typeof makeContext>): CheckResult {
  const issues: ReportQualityIssue[] = [];
  const strengths: string[] = [];
  let score = 100;
  const concreteActions = context.actionTexts.filter((text) => concretePattern.test(text));
  const concreteRatio = ratio(concreteActions.length, context.actionTexts.length);
  const vagueHits = context.actionTexts.join("\n").match(vaguePattern)?.length ?? 0;
  const averageActionLength = Math.round(average(context.actionTexts.map((text) => text.length)));

  if (context.actionTexts.length < 5) {
    score -= 18;
    issues.push(
      issue(
        "specificity-action-count",
        "specificity",
        "warning",
        "可执行动作数量不足",
        `当前只有 ${context.actionTexts.length} 条修复或行动建议。`,
        "MVP 阶段用户需要足够明确的下一步，不只是总体方向。",
        "至少给 5 条按优先级排序的具体动作。"
      )
    );
  }

  if (concreteRatio < 0.55) {
    score -= 30;
    issues.push(
      issue(
        "specificity-concrete-ratio",
        "specificity",
        concreteRatio < 0.35 ? "blocker" : "warning",
        "行动建议还不够具体",
        `${concreteActions.length}/${context.actionTexts.length || 1} 条建议包含明确对象、渠道、指标或数量。`,
        "空泛建议会让用户无法马上执行，也无法验证产品是否有潜力。",
        "每条建议补上对象、动作、渠道、样本量、指标或截止时间。"
      )
    );
  }

  if (vagueHits > concreteActions.length) {
    score -= 16;
    issues.push(
      issue(
        "specificity-vague-language",
        "specificity",
        "warning",
        "空泛动词偏多",
        `检测到 ${vagueHits} 个“优化/提升/加强/完善”等泛化表达。`,
        "泛化表达可以保留，但必须跟着具体改法。",
        "把“优化文案”改成“重写 README 首屏：目标用户 + 痛点 + 结果 + CTA”。"
      )
    );
  }

  if (averageActionLength > 0 && averageActionLength < 20) {
    score -= 10;
  }

  if (!issues.length) {
    strengths.push("报告行动项具备较好的对象、动作和验证指标。");
  }

  return checkResult({
    id: "specificity",
    category: "specificity",
    label: "具体性",
    score,
    okReason: "主要建议已经落到具体动作和对象。",
    issues,
    strengths,
    minimumFixes: [
      "减少单独出现的“优化、加强、完善”。",
      "每条行动项至少包含一个具体对象或指标。"
    ]
  });
}

function checkInferenceBoundary(context: ReturnType<typeof makeContext>): CheckResult {
  const issues: ReportQualityIssue[] = [];
  const strengths: string[] = [];
  let score = 100;
  const limitations = context.limitations;
  const overconfidentHits = context.reportText.match(overconfidentPattern)?.length ?? 0;

  if (limitations.length < 3) {
    score -= 25;
    issues.push(
      issue(
        "boundary-limitations-short",
        "inference_boundary",
        "warning",
        "限制条件不足",
        `报告只有 ${limitations.length} 条限制条件。`,
        "用户需要知道哪些结论来自事实，哪些只是推断。",
        "至少列出材料限制、外部证据限制、时效限制和未验证假设。"
      )
    );
  }

  if (limitations.length && !limitations.some((item) => boundaryPattern.test(item))) {
    score -= 20;
    issues.push(
      issue(
        "boundary-limitations-not-critical",
        "inference_boundary",
        "warning",
        "限制条件没有说清判断边界",
        "limitations 没有出现证据不足、缺失、无法、未知或假设等边界词。",
        "限制条件如果太温和，会让用户误以为报告已经查证充分。",
        "把限制条件改成可审计表述：缺什么证据、为什么会影响判断。"
      )
    );
  }

  if (
    context.evidenceBrief &&
    context.evidenceBrief.objectiveEvidenceRatio < 60 &&
    !/推断|假设|不能|不足|缺少/.test(context.reportText)
  ) {
    score -= 28;
    issues.push(
      issue(
        "boundary-objective-low",
        "inference_boundary",
        "blocker",
        "客观证据不足但没有降权说明",
        `客观证据占比 ${context.evidenceBrief.objectiveEvidenceRatio}%。`,
        "低客观证据占比时，报告必须避免把模型判断写成事实。",
        "在相关段落标记“这是推断/假设”，并说明需要哪类客观证据来验证。"
      )
    );
  }

  if (overconfidentHits > 2 && !boundaryPattern.test(context.reportText)) {
    score -= 14;
  }

  if (!issues.length) {
    strengths.push("报告保留了证据边界，没有把推断包装成事实。");
  }

  return checkResult({
    id: "inference-boundary",
    category: "inference_boundary",
    label: "推断边界",
    score,
    okReason: "报告有足够限制条件和证据边界。",
    issues,
    strengths,
    minimumFixes: [
      "明确哪些判断来自材料，哪些来自网页，哪些只是模型推断。",
      "在 limitations 中写出未验证假设。"
    ]
  });
}

function checkExperimentReadiness(context: ReturnType<typeof makeContext>): CheckResult {
  const issues: ReportQualityIssue[] = [];
  const strengths: string[] = [];
  let score = 100;
  const experiment = context.evidenceBrief?.recommendedExperiment;

  if (!experiment) {
    score -= 40;
    issues.push(
      issue(
        "experiment-missing",
        "experiment_readiness",
        "blocker",
        "缺少下一步验证实验",
        "Evidence Brief 没有推荐实验。",
        "没有实验，报告就不能闭环到真实学习。",
        "生成一个低成本实验，包含假设、渠道、样本量、成功指标和失败指标。"
      )
    );
  } else {
    if (!experiment.primaryMetric) score -= 14;
    if (!experiment.resultSchema) score -= 14;
    if (!experiment.decisionRules) score -= 14;
    if (!experiment.evidenceToCollect?.length) score -= 10;

    const missing = [
      !experiment.primaryMetric ? "主指标" : "",
      !experiment.resultSchema ? "回填字段" : "",
      !experiment.decisionRules ? "判定规则" : "",
      !experiment.evidenceToCollect?.length ? "证据采集清单" : ""
    ].filter(Boolean);
    if (missing.length) {
      issues.push(
        issue(
          "experiment-schema-incomplete",
          "experiment_readiness",
          "warning",
          "验证实验结构不完整",
          `缺少：${missing.join("、")}。`,
          "实验没有判定口径，就无法把结果回填成证据。",
          "补齐主指标、通过/失败阈值、样本量、原始证据和回填字段。"
        )
      );
    }

    if (
      context.evidenceBrief?.evidenceStop &&
      !context.reportText.includes(experiment.title) &&
      !experimentPattern.test(context.reportText)
    ) {
      score -= 18;
      issues.push(
        issue(
          "experiment-not-reflected",
          "experiment_readiness",
          "warning",
          "报告没有突出下一步实验",
          `推荐实验是「${experiment.title}」，但报告正文没有清楚承接。`,
          "证据不足时，用户最需要的是下一步如何验证。",
          "把推荐实验放进 potential_verdict 或前三条行动建议。"
        )
      );
    }
  }

  if (experiment && !issues.length) {
    strengths.push("下一步实验具备指标、证据采集和回填结构。");
  }

  return checkResult({
    id: "experiment-readiness",
    category: "experiment_readiness",
    label: "实验闭环",
    score,
    okReason: "报告能落到可回填的下一步实验。",
    issues,
    strengths,
    minimumFixes: [
      "实验必须有成功/失败指标。",
      "报告行动项必须承接推荐实验。"
    ]
  });
}

function checkRecency(context: ReturnType<typeof makeContext>): CheckResult {
  const issues: ReportQualityIssue[] = [];
  const strengths: string[] = [];
  let score = 100;
  const currentRatio = context.evidenceBrief?.currentEvidenceRatio ?? 100;
  const temporalScore = context.evidenceBrief?.temporalValidityScore ?? 100;
  const dateCoverage = context.webResearch?.searchQuality?.dateCoverage ?? 100;
  const hasRecencyBoundary = recencyPattern.test(context.reportText);

  if ((currentRatio < 50 || temporalScore < 55 || dateCoverage < 50) && !hasRecencyBoundary) {
    score -= 34;
    issues.push(
      issue(
        "recency-boundary-missing",
        "recency",
        "warning",
        "证据时效没有被显式处理",
        `当前证据 ${currentRatio}%，时效有效 ${temporalScore}，日期覆盖 ${dateCoverage}。`,
        "产品生命周期不同，过期证据对判断的价值不同。",
        "在报告中说明证据发布时间、更新时间和是否仍适用于当前生命周期。"
      )
    );
  }

  if (context.evidenceBrief?.staleEvidenceCount && context.evidenceBrief.staleEvidenceCount > 2) {
    score -= 12;
  }

  if (!issues.length) {
    strengths.push("报告已经考虑证据时效和产品生命周期。");
  }

  return checkResult({
    id: "recency",
    category: "recency",
    label: "时效性",
    score,
    okReason: "报告对证据时效有明确处理。",
    issues,
    strengths,
    minimumFixes: [
      "补充近期证据，或把旧证据降权。",
      "写清证据适用于哪个生命周期阶段。"
    ]
  });
}

function checkSourceCoverage(context: ReturnType<typeof makeContext>): CheckResult {
  const issues: ReportQualityIssue[] = [];
  const strengths: string[] = [];
  let score = 100;
  const sourceBudgetScore = context.evidenceBrief?.sourceBudgetScore ?? 100;
  const unmetLabels = context.unmetBudgets.map((budget) => budget.label);
  const missingLabels = unmetLabels.filter((label) => !context.reportText.includes(label));

  if (sourceBudgetScore < 50) {
    score -= 24;
    if (missingLabels.length) {
      score -= Math.min(22, missingLabels.length * 5);
    }
    issues.push(
      issue(
        "source-coverage-budget-low",
        "source_coverage",
        sourceBudgetScore < 25 ? "blocker" : "warning",
        "Source Budget 覆盖不足",
        `Source Budget 得分 ${sourceBudgetScore}，未达标：${unmetLabels.slice(0, 4).join("、") || "未知"}。`,
        "关键假设缺证据时，报告不能只给总体判断。",
        "把未达标预算逐项写入市场证据或行动建议，并说明优先补哪一项。"
      )
    );
  }

  if (
    context.unmetBudgets.some((budget) => budget.assumptionId === "opposition") &&
    !/反证|风险|失败|关闭|无需求|替代/.test(context.reportText)
  ) {
    score -= 18;
    issues.push(
      issue(
        "source-coverage-opposition-missing",
        "source_coverage",
        "warning",
        "反证覆盖不足没有被写清",
        "反证预算未达标，但报告没有明显提示反证、失败案例或主要风险。",
        "没有反证覆盖时，高潜力判断容易变成确认偏误。",
        "增加一段反证搜索结果：失败案例、价格抗拒、低频、强替代或分发风险。"
      )
    );
  }

  if (!issues.length) {
    strengths.push("关键假设覆盖和反证缺口已经进入报告。");
  }

  return checkResult({
    id: "source-coverage",
    category: "source_coverage",
    label: "证据覆盖",
    score,
    okReason: "报告覆盖了关键假设和反证缺口。",
    issues,
    strengths,
    minimumFixes: [
      "把 Source Budget 未达标项写入报告。",
      "至少列出一条反证或说明反证缺失。"
    ]
  });
}

function checkResult({
  id,
  category,
  label,
  score,
  okReason,
  issues,
  strengths,
  minimumFixes
}: {
  id: string;
  category: ReportQualityCategory;
  label: string;
  score: number;
  okReason: string;
  issues: ReportQualityIssue[];
  strengths: string[];
  minimumFixes: string[];
}): CheckResult {
  const normalizedScore = clampScore(score);
  const cappedScore = issues.some((item) => item.severity === "blocker")
    ? Math.min(normalizedScore, 54)
    : normalizedScore;
  const status = checkStatus(cappedScore, issues);
  return {
    check: {
      id,
      category,
      label,
      status,
      score: cappedScore,
      reason: issues[0]?.finding || okReason,
      minimumFixes: status === "pass" ? [] : minimumFixes
    },
    issues,
    strengths
  };
}

function issue(
  id: string,
  category: ReportQualityCategory,
  severity: ReportQualityIssue["severity"],
  title: string,
  finding: string,
  evidence: string,
  fix: string
): ReportQualityIssue {
  return {
    id,
    category,
    severity,
    title,
    finding,
    evidence,
    fix
  };
}

function attachRepairDrafts(
  issues: ReportQualityIssue[],
  context: ReturnType<typeof makeContext>
): ReportQualityIssue[] {
  return issues.map((item) => ({
    ...item,
    repairDraft: repairDraftForIssue(item, context)
  }));
}

function repairDraftForIssue(
  issue: ReportQualityIssue,
  context: ReturnType<typeof makeContext>
): ReportQualityIssue["repairDraft"] {
  if (issue.category === "evidence_binding") {
    return evidenceBindingDraft(issue, context);
  }
  if (issue.category === "evidence_quality") {
    return evidenceQualityDraft(issue, context);
  }
  if (issue.category === "calibration_alignment") {
    return calibrationAlignmentDraft(issue, context);
  }
  if (issue.category === "specificity") {
    return specificityDraft(issue, context);
  }
  if (issue.category === "inference_boundary") {
    return inferenceBoundaryDraft(issue, context);
  }
  if (issue.category === "experiment_readiness") {
    return experimentReadinessDraft(issue, context);
  }
  if (issue.category === "recency") {
    return recencyDraft(issue, context);
  }
  return sourceCoverageDraft(issue, context);
}

function evidenceBindingDraft(
  issue: ReportQualityIssue,
  context: ReturnType<typeof makeContext>
) {
  const evidenceBrief = context.evidenceBrief;
  const decision = evidenceBrief?.decision.decision ?? "test_first";
  const stage = evidenceBrief?.lifecycleEvidenceStandard;
  const experiment = evidenceBrief?.recommendedExperiment;
  const stopReason = evidenceBrief?.evidenceStop?.reason;
  const replacementText = [
    `当前更稳妥的结论是「${decisionLabel(decision)}」，而不是直接给强 build / stop 判断。`,
    evidenceBrief
      ? `证据置信为 ${evidenceBrief.confidenceScore}/100；${stage ? `${stage.label}最低要求是外部证据 ${stage.requiredExternalEvidence} 条、总证据 ${stage.requiredTotalEvidence} 张、反证 ${stage.requiredOpposition} 条、强行为证据 ${stage.requiredStrongBehaviorCards} 条。` : ""}`
      : "",
    stopReason ? `强决策被阻断的原因是：${shorten(stopReason, 180)}` : "",
    experiment
      ? `下一步应先做「${experiment.title}」，用「${experiment.primaryMetric?.name || experiment.successMetric}」验证关键假设；通过/失败后再更新潜力判断。`
      : "下一步应先补齐用户行为、外部市场和反证证据，再更新潜力判断。"
  ]
    .filter(Boolean)
    .join("");

  return {
    targetSection: "potential_verdict" as const,
    title: "替换潜力判断为证据约束版",
    replacementText,
    whyThisFix: "把结论锚定到 Evidence Brief、生命周期标准和推荐实验，避免报告分数脱离证据强度。",
    evidenceRefs: evidenceRefs(context),
    confidence: draftConfidence(issue, context)
  };
}

function evidenceQualityDraft(
  issue: ReportQualityIssue,
  context: ReturnType<typeof makeContext>
) {
  const quality = context.evidenceQuality;
  const qualityScore =
    quality.searchQualityScore === null ? "未评估" : `${quality.searchQualityScore}/100`;
  const targetSection = evidenceQualityDraftTarget(issue);
  const repairQueries = buildEvidenceRepairQueries(issue, context);
  const experimentActions = buildEvidenceQualityExperimentActions(context);
  const qualityLedger = [
    `证据质量：可复核网页正文 ${quality.crawledBodyCount} 条，搜索摘要 ${quality.searchSummaryCount} 条，无 URL 摘要 ${quality.urlMissingCount} 条，GitHub 指标 ${quality.githubMetricCount} 条。`,
    `查询状态：已执行 ${quality.executedCount} 条，计划未执行 ${quality.plannedCount} 条，跳过 ${quality.skippedCount} 条，失败 ${quality.failedCount} 条，抓取失败 ${quality.failedCrawlCount} 条。`,
    `搜索质量：${qualityScore}；URL 覆盖 ${quality.urlCoverage ?? 0}，日期覆盖 ${quality.dateCoverage ?? 0}，成功率 ${quality.querySuccessRate ?? 0}。`
  ];
  const boundary =
    "判断边界：无 URL 摘要、计划查询、失败/跳过查询不能作为支持或反证；历史或未知时效证据必须降权。";
  const replacementText =
    targetSection === "actionable_suggestions"
      ? [
          ...repairQueries.map((query) => `补证查询：${query}`),
          ...experimentActions.map((action) => `实验动作：${action}`),
          boundary
        ].join("\n")
      : [
          ...qualityLedger,
          "下一轮补证查询：",
          ...repairQueries.map((query) => `- ${query}`),
          "下一步实验动作：",
          ...experimentActions.map((action) => `- ${action}`),
          boundary,
          "在补到带 URL、带日期、可抓网页正文或真实用户行为证据之前，报告结论应保持 test_first 或低置信表达。"
        ].join("\n");

  return {
    targetSection,
    title:
      targetSection === "actionable_suggestions"
        ? "生成补证查询和实验动作"
        : "补上证据质量和补证计划",
    replacementText,
    whyThisFix:
      targetSection === "actionable_suggestions"
        ? "把低质量证据问题转成可执行查询、重试任务和实验动作，让用户知道下一步怎么补证。"
        : "把搜索摘要、无 URL 摘要、计划查询、失败/跳过和时效问题写进市场证据边界，避免把工具过程误当成市场事实。",
    evidenceRefs: evidenceRefs(context),
    confidence: draftConfidence(issue, context),
    researchPlan: {
      title: `证据质量补查：${issue.title}`,
      trigger: `${issue.title}：${issue.finding}`,
      queries: repairQueries,
      backtestSuggestions: [],
      experimentActions
    }
  };
}

function evidenceQualityDraftTarget(issue: ReportQualityIssue) {
  if (
    [
      "evidence-quality-failed-skipped",
      "evidence-quality-planned-query",
      "evidence-quality-no-body",
      "evidence-quality-url-missing"
    ].includes(issue.id)
  ) {
    return "actionable_suggestions" as const;
  }
  return "market_evidence" as const;
}

function buildEvidenceRepairQueries(
  issue: ReportQualityIssue,
  context: ReturnType<typeof makeContext>
) {
  const webResearch = context.webResearch;
  const queryPlan = webResearch?.queryPlan ?? [];
  const queryExecutions = webResearch?.queryExecutions ?? [];
  const executionById = new Map(queryExecutions.map((execution) => [execution.queryId, execution]));
  const queryById = new Map(queryPlan.map((query) => [query.id, query]));
  const plannedQueries = queryPlan
    .filter((query) => !executionById.has(query.id) || executionById.get(query.id)?.status === "planned")
    .sort((a, b) => a.priority - b.priority)
    .map((query) => `执行「${queryIntentLabel(query.intent)}」查询：${query.query}`);
  const failedOrSkippedQueries = queryExecutions
    .filter((execution) => execution.status === "failed" || execution.status === "skipped")
    .map((execution) => {
      const query = queryById.get(execution.queryId);
      return query
        ? `重试「${queryIntentLabel(query.intent)}」查询：${query.query}；原状态 ${execution.status}${execution.reason ? `，原因：${execution.reason}` : ""}`
        : `重试查询 ${execution.queryId}；原状态 ${execution.status}${execution.reason ? `，原因：${execution.reason}` : ""}`;
    });
  const crawlTargets =
    webResearch?.searchResults
      .filter((item) => item.sourceType === "search_result" && Boolean(item.url))
      .slice(0, 3)
      .map((item) => `抓取网页正文并记录日期：${item.url || item.title}`) ?? [];
  const noUrlSummaries =
    webResearch?.searchResults
      .filter((item) => item.sourceType === "search_result" && !item.url)
      .slice(0, 3)
      .map((item) => `用摘要标题重新搜索并要求返回原始 URL：${shorten(item.title || item.snippet, 90)}`) ?? [];
  const recencyQueries = queryPlan
    .filter((query) => query.intent === "recency")
    .slice(0, 2)
    .map((query) => `补近期证据：${query.query}`);
  const unmetBudgetQueries = context.unmetBudgets.slice(0, 3).map(
    (budget) =>
      `围绕「${budget.label}」补证：${budget.missingEvidence[0] || "补支持证据和直接反证"}`
  );
  const defaultQueries = [
    "搜索目标用户过去 12 个月的真实问题帖、抱怨、workaround 和替代方案讨论。",
    "搜索定价页、付费竞品、采购预算、退款/太贵抱怨和免费替代方案。",
    "搜索失败案例、关闭项目、迁移成本、低频使用和强竞品反证。"
  ];

  if (issue.id === "evidence-quality-failed-skipped") {
    return uniqueStrings([
      ...failedOrSkippedQueries,
      ...plannedQueries,
      ...unmetBudgetQueries,
      ...defaultQueries
    ]).slice(0, 6);
  }

  if (issue.id === "evidence-quality-planned-query") {
    return uniqueStrings([...plannedQueries, ...unmetBudgetQueries, ...defaultQueries]).slice(0, 6);
  }

  if (issue.id === "evidence-quality-no-body") {
    return uniqueStrings([...crawlTargets, ...plannedQueries, ...unmetBudgetQueries, ...defaultQueries]).slice(0, 6);
  }

  if (issue.id === "evidence-quality-url-missing") {
    return uniqueStrings([...noUrlSummaries, ...plannedQueries, ...defaultQueries]).slice(0, 6);
  }

  if (issue.id === "evidence-quality-stale-current-claim") {
    return uniqueStrings([...recencyQueries, ...defaultQueries]).slice(0, 5);
  }

  if (issue.id === "evidence-quality-github-metric-boundary") {
    return uniqueStrings([
      "搜索真实用户案例、生产环境使用、客户页面、集成教程和 issue/discussion 中的复用证据。",
      "搜索付费、赞助、商业支持、定价页、采购预算和留存相关证据，不能只看 stars/forks。",
      ...recencyQueries,
      ...defaultQueries
    ]).slice(0, 5);
  }

  return uniqueStrings([
    ...failedOrSkippedQueries,
    ...plannedQueries,
    ...crawlTargets,
    ...noUrlSummaries,
    ...unmetBudgetQueries,
    ...defaultQueries
  ]).slice(0, 6);
}

function buildEvidenceQualityExperimentActions(context: ReturnType<typeof makeContext>) {
  const experiment = context.evidenceBrief?.recommendedExperiment;
  const actions = [];

  if (experiment) {
    actions.push(
      `执行「${experiment.title}」：渠道 ${experiment.channel}，样本 ${experiment.sampleSize}，主指标 ${experiment.primaryMetric?.name || experiment.successMetric}。`
    );
    actions.push(
      `回填原始证据：${experiment.evidenceToCollect?.join("、") || "访谈摘录、点击/留资截图、原始链接和指标快照"}。`
    );
    if (experiment.decisionRules) {
      actions.push(
        `按判定规则更新结论：通过=${experiment.decisionRules.validated}；失败=${experiment.decisionRules.invalidated}。`
      );
    }
  } else {
    actions.push("本周完成 8-10 个 story-based 访谈，只记录过去 30 天真实行为、替代方案和付费/预算线索。");
    actions.push("做一个 fake-door 定价或留资页，收集访问、点击、留资、价格点击和退出原因。");
  }

  for (const budget of context.unmetBudgets.slice(0, 2)) {
    actions.push(
      `补齐「${budget.label}」证据预算：支持 ${budget.currentSupport}/${budget.requiredSupport}，反证 ${budget.currentOpposition}/${budget.requiredOpposition}，优先补 ${budget.missingEvidence[0] || "直接证据"}。`
    );
  }

  return uniqueStrings(actions).slice(0, 5);
}

function queryIntentLabel(intent: string) {
  if (intent === "problem") return "痛点";
  if (intent === "payment") return "付费";
  if (intent === "alternative") return "替代";
  if (intent === "competitor_review") return "竞品";
  if (intent === "distribution") return "分发";
  if (intent === "opposition") return "反证";
  if (intent === "recency") return "时效";
  return "AI 优势";
}

function calibrationAlignmentDraft(
  issue: ReportQualityIssue,
  context: ReturnType<typeof makeContext>
) {
  const calibrationContext = context.calibrationContext;
  const actions = calibrationContext?.actions ?? [];
  const researchPlan = buildCalibrationResearchPlan(issue, context);
  const keyActions = actions
    .filter((action) => action.confidence !== "low" || action.action === "collect_more")
    .slice(0, 4);
  const actionLines = keyActions.length
    ? keyActions.map(
        (action) =>
          `- ${action.target}：${action.label}，样本 ${action.sampleCount}，缺口 ${action.neededSamples}，平均偏差 ${formatDelta(action.averageDelta)}；${action.recommendedAdjustment}`
      )
    : ["- 当前没有足够动态样本支撑自动调权，只能使用静态 README 校准规则。"];
  const decision = context.evidenceBrief?.decision.decision ?? "test_first";
  const replacementText = [
    `当前结论应保持「${decisionLabel(decision)}」和低/中置信表达，不能只凭 README 表达或 GitHub 指标给强 build / stop。`,
    calibrationContext
      ? `README 回测校准样本：静态 ${calibrationContext.staticSampleCount}，动态 ${calibrationContext.dynamicSampleCount}，对齐率 ${calibrationContext.alignedRate ?? "待样本"}。`
      : "本次没有完整 README 回测校准上下文。",
    "本次必须显式应用的校准动作：",
    ...actionLines,
    "如果报告仍要突破这些校准边界，必须提供可复核 URL、网页正文、近期外部采用、付费/留存或直接反证；否则下一步应先补证或继续回测。"
  ].join("\n");

  return {
    targetSection: "potential_verdict" as const,
    title: "替换为校准一致的潜力判断",
    replacementText,
    whyThisFix: "把 README 回测得到的升权、降权、补样本和工具链边界写进最终结论，防止报告绕过校准账本。",
    evidenceRefs: evidenceRefs(context),
    confidence: draftConfidence(issue, context),
    researchPlan
  };
}

function buildCalibrationResearchPlan(
  issue: ReportQualityIssue,
  context: ReturnType<typeof makeContext>
) {
  const actions = context.calibrationContext?.actions ?? [];
  const matched = matchedCalibrationAction(issue, actions);
  const productTerm = productSearchTerm(context);
  const target = matched?.target || "README 回测校准";
  const action = matched?.action || "collect_more";
  const queries = calibrationRepairQueries({
    action,
    target,
    productTerm
  });
  const backtestSuggestions = calibrationBacktestSuggestions({
    action,
    target,
    neededSamples: matched?.neededSamples ?? 3
  });
  const experimentActions = calibrationExperimentActions({
    action,
    target,
    context
  });

  return {
    title: `校准补查：${target}`,
    trigger: `${issue.title}：${issue.finding}`,
    queries,
    backtestSuggestions,
    experimentActions
  };
}

function matchedCalibrationAction(
  issue: ReportQualityIssue,
  actions: NonNullable<ReturnType<typeof makeContext>["calibrationContext"]>["actions"]
) {
  const actionType =
    issue.id === "calibration-alignment-downweight-ignored"
      ? "downweight"
      : issue.id === "calibration-alignment-upweight-ignored"
        ? "upweight"
        : issue.id === "calibration-alignment-sample-gap-ignored"
          ? "collect_more"
          : issue.id === "calibration-alignment-tooling-boundary"
            ? "fix_tooling"
            : issue.id === "calibration-alignment-hold-extreme"
              ? "hold"
              : undefined;
  return (
    actions.find((action) => action.action === actionType) ??
    actions.find((action) => action.confidence !== "low") ??
    actions[0]
  );
}

function calibrationRepairQueries({
  action,
  target,
  productTerm
}: {
  action: string;
  target: string;
  productTerm: string;
}) {
  const baseTerm = [productTerm, target].filter(Boolean).join(" ");
  if (action === "downweight") {
    return [
      `${baseTerm} real adoption production users case study`,
      `${baseTerm} failed abandoned no demand too expensive alternative`,
      `${baseTerm} complaints issues discussion migration churn`,
      `${baseTerm} pricing paid customers retention`
    ];
  }
  if (action === "upweight") {
    return [
      `${baseTerm} ecosystem integration tutorial adoption`,
      `${baseTerm} GitHub issues discussions active community`,
      `${baseTerm} release changelog roadmap recent activity`,
      `${baseTerm} users production case study`
    ];
  }
  if (action === "fix_tooling") {
    return [
      `${productTerm} GitHub README raw main branch`,
      `${productTerm} releases changelog issues discussions`,
      `${productTerm} official docs examples quickstart`
    ];
  }
  if (action === "hold") {
    return [
      `${baseTerm} recent users case study`,
      `${baseTerm} recent negative feedback alternative`,
      `${baseTerm} pricing adoption retention`
    ];
  }
  return [
    `${baseTerm} similar GitHub project README adoption outcome`,
    `${baseTerm} successful open source product case study`,
    `${baseTerm} failed open source product shutdown abandoned`,
    `${baseTerm} developer tool pricing users production`
  ];
}

function calibrationBacktestSuggestions({
  action,
  target,
  neededSamples
}: {
  action: string;
  target: string;
  neededSamples: number;
}) {
  const minimum = Math.max(1, neededSamples || 3);
  if (action === "downweight") {
    return [
      `补跑 ${minimum} 个 README 表达很强但后验弱的 repo，验证「${target}」是否持续高估。`,
      "样本要覆盖：已停更/社区弱/强竞品替代/商业化失败，避免只选成功项目。"
    ];
  }
  if (action === "upweight") {
    return [
      `补跑 ${minimum} 个 README 表达一般但生态后验强的 repo，验证「${target}」是否持续低估。`,
      "样本要覆盖：高 stars、活跃 issues、第三方教程、生产环境引用和近期 release。"
    ];
  }
  if (action === "fix_tooling") {
    return [
      "先重跑失败 repo，确认 GitHub/README 读取、搜索 provider、网页抓取和校准 delta 是否完整。",
      "失败样本只进入工具改进，不进入产品潜力正负样本。"
    ];
  }
  if (action === "hold") {
    return [
      `继续补跑 ${minimum} 个命中「${target}」的正反样本，只有连续偏差超过阈值再改权重。`
    ];
  }
  return [
    `再补 ${minimum} 个不同类型 README 回测样本，覆盖强成功、混合、弱后验和工具失败样本。`,
    `优先选择命中「${target}」的 repo，避免总体样本变多但该信号仍不足。`
  ];
}

function calibrationExperimentActions({
  action,
  target,
  context
}: {
  action: string;
  target: string;
  context: ReturnType<typeof makeContext>;
}) {
  const experiment = context.evidenceBrief?.recommendedExperiment;
  const actions = [
    experiment
      ? `执行「${experiment.title}」，并把结果按 ${experiment.primaryMetric?.name || experiment.successMetric} 回填，验证校准动作是否改变结论。`
      : "执行 8-10 个目标用户访谈，只记录过去行为、替代方案、预算和真实使用证据。"
  ];

  if (action === "downweight") {
    actions.push(`针对「${target}」补真实采用证据：生产使用、付费、留存、复用或直接用户反馈。`);
    actions.push("同时补反证：用户为什么不用、免费替代是否足够、是否只是 README 表达强。");
  } else if (action === "upweight") {
    actions.push(`针对「${target}」补生态补偿证据：第三方教程、issue/discussion、集成、近期 release。`);
    actions.push("如果生态证据强但付费未知，结论应转为 test_first，而不是 stop。");
  } else if (action === "fix_tooling") {
    actions.push("先修读取/搜索链路，再重新生成 Evidence Brief；工具失败前不要改产品结论。");
  } else {
    actions.push(`围绕「${target}」补支持和反证各 1 条，避免只按 README 表达更新判断。`);
  }

  return uniqueStrings(actions).slice(0, 4);
}

function productSearchTerm(context: ReturnType<typeof makeContext>) {
  const name =
    context.report.share_summary?.current_style ||
    context.report.references?.[0]?.name ||
    context.materials?.[0]?.name ||
    "product";
  return name.replace(/\.[a-z0-9]+$/i, "").slice(0, 60);
}

function specificityDraft(
  issue: ReportQualityIssue,
  context: ReturnType<typeof makeContext>
) {
  const experiment = context.evidenceBrief?.recommendedExperiment;
  const unmetBudgets = context.unmetBudgets.slice(0, 3);
  const actions = [
    experiment
      ? `先执行「${experiment.title}」：样本 ${experiment.sampleSize}，渠道 ${experiment.channel}，主指标 ${experiment.primaryMetric?.name || experiment.successMetric}，失败阈值 ${experiment.primaryMetric?.failureThreshold || experiment.failureMetric}。`
      : "先做 10 个目标用户访谈，只问过去 30 天内的真实行为、替代方案和付费/预算线索。",
    ...unmetBudgets.map(
      (budget) =>
        `补齐「${budget.label}」：当前支持 ${budget.currentSupport}/${budget.requiredSupport}，反证 ${budget.currentOpposition}/${budget.requiredOpposition}；优先收集 ${budget.missingEvidence.join("、")}。`
    ),
    "把每条建议改成「对象 + 动作 + 渠道 + 样本量/指标 + 截止时间」格式，删除单独出现的“优化、提升、完善”。"
  ];

  return {
    targetSection: "actionable_suggestions" as const,
    title: "替换行动建议为可执行清单",
    replacementText: actions.slice(0, 5).join("\n"),
    whyThisFix: "把空泛建议改成可以马上执行、可以回填证据的任务。",
    evidenceRefs: evidenceRefs(context),
    confidence: draftConfidence(issue, context)
  };
}

function inferenceBoundaryDraft(
  issue: ReportQualityIssue,
  context: ReturnType<typeof makeContext>
) {
  const evidenceBrief = context.evidenceBrief;
  const replacementText = [
    evidenceBrief
      ? `本报告中的机会判断仍是「证据解释」，不是市场事实：当前客观证据占比 ${evidenceBrief.objectiveEvidenceRatio}%，外部网页证据 ${context.webEvidenceCount} 条。`
      : "本报告中的机会判断仍是证据解释，不应被当成市场事实。",
    context.unmetBudgets.length
      ? `未达标假设包括：${context.unmetBudgets
          .slice(0, 4)
          .map((budget) => budget.label)
          .join("、")}。`
      : "",
    "在补齐用户行为、付费/预算、替代方案和反证之前，只能建议继续验证，不能高置信建议扩大开发。"
  ]
    .filter(Boolean)
    .join("");

  return {
    targetSection: "limitations" as const,
    title: "补上推断边界和未验证假设",
    replacementText,
    whyThisFix: "让用户知道哪些结论来自事实，哪些只是当前材料下的推断。",
    evidenceRefs: evidenceRefs(context),
    confidence: draftConfidence(issue, context)
  };
}

function experimentReadinessDraft(
  issue: ReportQualityIssue,
  context: ReturnType<typeof makeContext>
) {
  const experiment = context.evidenceBrief?.recommendedExperiment;
  const replacementText = experiment
    ? [
        `下一步实验：${experiment.title}。`,
        `假设：${experiment.hypothesis}`,
        `执行：${experiment.steps.slice(0, 3).join("；")}`,
        `主指标：${experiment.primaryMetric?.name || experiment.successMetric}；成功：${experiment.primaryMetric?.target || experiment.successMetric}；失败：${experiment.primaryMetric?.failureThreshold || experiment.failureMetric}。`,
        `需要回填的原始证据：${experiment.evidenceToCollect?.join("、") || "访问、点击、留资、访谈摘录和原始链接"}。`
      ].join("\n")
    : "下一步实验：用 10 个 story-based 用户访谈验证痛点。成功标准：10 人中至少 4 人过去 30 天遇到该问题，且 2 人已有明确 workaround；失败标准：少于 2 人有近期行为或明确代价。";

  return {
    targetSection: "actionable_suggestions" as const,
    title: "补上可回填的下一步实验",
    replacementText,
    whyThisFix: "把报告从建议文推进到可学习闭环，实验结果能直接回填 Evidence Brief。",
    evidenceRefs: evidenceRefs(context),
    confidence: draftConfidence(issue, context)
  };
}

function recencyDraft(
  issue: ReportQualityIssue,
  context: ReturnType<typeof makeContext>
) {
  const evidenceBrief = context.evidenceBrief;
  const searchQuality = context.webResearch?.searchQuality;
  const replacementText = [
    `时效性处理：当前证据有效比例 ${evidenceBrief?.currentEvidenceRatio ?? 0}%，时效有效分 ${evidenceBrief?.temporalValidityScore ?? 0}，搜索日期覆盖 ${searchQuality?.dateCoverage ?? 0}%。`,
    "无日期或历史证据只能作为低权重背景，不能单独支撑当前生命周期判断。",
    "下一轮应优先补充带发布时间/更新时间的近期用户讨论、产品更新、定价页、评论或失败案例。"
  ].join("");

  return {
    targetSection: "limitations" as const,
    title: "补上证据时效说明",
    replacementText,
    whyThisFix: "产品机会会随生命周期变化，时效不明的证据必须降权。",
    evidenceRefs: evidenceRefs(context),
    confidence: draftConfidence(issue, context)
  };
}

function sourceCoverageDraft(
  issue: ReportQualityIssue,
  context: ReturnType<typeof makeContext>
) {
  const unmet = context.unmetBudgets.slice(0, 5);
  const replacementText = unmet.length
    ? [
        "当前最需要补的不是更多主观判断，而是以下证据预算：",
        ...unmet.map(
          (budget) =>
            `- ${budget.label}：支持 ${budget.currentSupport}/${budget.requiredSupport}，反证 ${budget.currentOpposition}/${budget.requiredOpposition}；缺口：${budget.missingEvidence.join("、") || "需要更多可验证证据"}。`
        ),
        "在这些预算达标前，报告结论应保持 test_first，并把补证优先级写进下一步计划。"
      ].join("\n")
    : "Source Budget 当前没有明显缺口；报告可保留现有证据覆盖说明。";

  return {
    targetSection: "market_evidence" as const,
    title: "补上 Source Budget 缺口段落",
    replacementText,
    whyThisFix: "把缺证据的地方明示出来，避免总体判断掩盖关键假设未验证。",
    evidenceRefs: evidenceRefs(context),
    confidence: draftConfidence(issue, context)
  };
}

function evidenceRefs(context: ReturnType<typeof makeContext>) {
  const refs = [
    ...(context.evidenceBrief
      ? [
          `Evidence Brief confidence ${context.evidenceBrief.confidenceScore}`,
          `Decision ${context.evidenceBrief.decision.decision}`
        ]
      : []),
    ...(context.evidenceBrief?.lifecycleEvidenceStandard
      ? [`${context.evidenceBrief.lifecycleEvidenceStandard.label} standard`]
      : []),
    `Evidence quality: body ${context.evidenceQuality.crawledBodyCount}, summaries ${context.evidenceQuality.searchSummaryCount}, no-url ${context.evidenceQuality.urlMissingCount}`,
    context.evidenceQuality.searchQualityScore === null
      ? ""
      : `Search quality ${context.evidenceQuality.searchQualityScore}`,
    ...(context.calibrationContext
      ? [
          `README calibration dynamic ${context.calibrationContext.dynamicSampleCount}`,
          ...context.calibrationContext.actions
            .slice(0, 3)
            .map((action) => `Calibration action: ${action.target} ${action.action}`)
        ]
      : []),
    ...context.unmetBudgets.slice(0, 3).map((budget) => `Source Budget: ${budget.label}`),
    ...context.evidenceCards.slice(0, 3).map((card) => `Evidence Card: ${card.id}`)
  ];
  return uniqueStrings(refs).slice(0, 6);
}

function draftConfidence(issue: ReportQualityIssue, context: ReturnType<typeof makeContext>) {
  let confidence = issue.severity === "blocker" ? 86 : 74;
  if (context.evidenceBrief) confidence += 6;
  if (context.evidenceBrief?.recommendedExperiment) confidence += 4;
  if (context.unmetBudgets.length) confidence += 3;
  return clampScore(confidence);
}

function decisionLabel(decision: string) {
  if (decision === "build") return "继续构建";
  if (decision === "test_first") return "先验证";
  if (decision === "reposition") return "重定位";
  return "停止";
}

function formatDelta(delta: number | null) {
  if (delta === null) return "待样本";
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function shorten(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function checkStatus(
  score: number,
  issues: ReportQualityIssue[]
): ReportQualityStatus {
  if (issues.some((item) => item.severity === "blocker") || score < 55) return "fail";
  if (issues.length || score < 78) return "warn";
  return "pass";
}

function auditStatus(
  score: number,
  checks: ReportQualityCheck[]
): ReportQualityStatus {
  if (checks.some((check) => check.status === "fail") || score < 55) return "fail";
  if (checks.some((check) => check.status === "warn") || score < 78) return "warn";
  return "pass";
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function ratio(value: number, total: number) {
  if (!total) return 0;
  return value / total;
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
