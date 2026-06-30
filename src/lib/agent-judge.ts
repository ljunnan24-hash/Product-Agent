import { AgentRuntimeHarness } from "./agent-runtime";
import { isTaskNodeDependencySatisfied } from "./graph-executor";
import { SubagentRunner } from "./subagent-runner";
import { getRegisteredWorkerDefinition } from "./subagent-registry";
import { toolPolicies } from "./tool-policy";
import type {
  AgentJudgeReason,
  AgentJudgeVerdict,
  AgentToolGuardrailResult,
  EvidenceBrief,
  ProductDecision,
  WebResearchSummary
} from "./types";

type JudgeInput = {
  evidenceBrief: EvidenceBrief;
  webResearch: WebResearchSummary;
  contextLabel?: string;
};

const judgeWorkerDefinition = getRegisteredWorkerDefinition("judge-agent");

export async function runJudgeAgent({
  evidenceBrief,
  webResearch,
  contextLabel = "主分析"
}: JudgeInput): Promise<{
  verdict: AgentJudgeVerdict;
  webResearch: WebResearchSummary;
}> {
  const runtime = webResearch.runtimeTrace
    ? AgentRuntimeHarness.fromTrace(webResearch.runtimeTrace)
    : new AgentRuntimeHarness(`Judge Agent：审计 ${evidenceBrief.productName} 的证据边界。`);
  runtime.upsertTaskNode({
    id: "judge",
    kind: "judge",
    label: "Judge Agent",
    dependsOn: runtime.getTrace().taskGraph?.nodes.some((node) => node.id === "evidence_extract")
      ? ["evidence_extract"]
      : [],
    inputSummary: "独立检查 Evidence Stop、Source Budget、反证覆盖、时效、客观性和搜索质量。",
    resumeHint: "复用 Evidence Brief 和 WebResearchSummary 重新运行 Judge，不重查网页。",
    metrics: {
      confidenceScore: evidenceBrief.confidenceScore,
      evidenceCards: evidenceBrief.evidenceCards.length
    }
  });
  const dependencyBlockers = graphDependencyBlockersFor(runtime, "judge");
  if (dependencyBlockers.length) {
    const verdict = blockedJudgeVerdict(evidenceBrief, webResearch, dependencyBlockers);
    const artifact = await runtime.addArtifact({
      kind: "judge_report",
      owner: "judge_agent",
      title: "Judge Agent Blocked",
      summary: verdict.summary,
      payload: {
        verdict,
        dependencyBlockers
      },
      itemCount: dependencyBlockers.length,
      preview: dependencyBlockers.join("；")
    });
    const handoff = runtime.createHandoff({
      from: "judge_agent",
      to: "main_agent",
      goal: "阻止下游报告在证据抽取未完成时继续生成强结论。",
      contextSummary: verdict.summary,
      artifactIds: [artifact.id],
      evidenceRefs: evidenceBrief.evidenceCards.slice(0, 4).map((card) => card.id),
      acceptedInputSummary: "接收 GraphExecutor task node 状态；上游 evidence_extract 未满足，Judge 不运行常规规则。",
      keyFindings: [`上游依赖未满足：${dependencyBlockers.join(" / ")}`],
      uncertainties: ["证据抽取未完成，不能确认外部证据覆盖、反证覆盖或时效覆盖。"],
      forbiddenClaims: judgeForbiddenClaims(verdict),
      nextActions: verdict.requiredResearchActions
    });
    runtime.skipTaskNode("judge", verdict.summary, {
      artifactIds: [artifact.id],
      handoffIds: [handoff.id],
      blockedBy: dependencyBlockers,
      metrics: {
        graphExecutorBlocked: true,
        graphExecutorBlockedBy: dependencyBlockers.join(","),
        confidenceCap: verdict.confidenceCap
      }
    });
    addJudgeInterrupt(runtime, verdict, artifact.id);
    runtime.completeTrace();
    return {
      verdict,
      webResearch: {
        ...webResearch,
        judgeVerdict: verdict,
        runtimeTrace: runtime.getTrace()
      }
    };
  }
  const spanId = runtime.startSpan({
    taskNodeId: "judge",
    subagent: "judge_agent",
    title: "审判证据边界",
    inputSummary: `${contextLabel}：检查 Evidence Stop、Source Budget、反证覆盖、时效、客观性和搜索质量。`,
    metrics: {
      confidenceScore: evidenceBrief.confidenceScore,
      sourceBudgetScore: evidenceBrief.sourceBudgetScore,
      evidenceCards: evidenceBrief.evidenceCards.length
    }
  });
  const runner = new SubagentRunner(runtime);
  const run = await runner.run<{
    verdict: AgentJudgeVerdict;
    artifactId: string;
    handoffId: string;
  }>({
    definition: judgeWorkerDefinition,
    parentSpanId: spanId,
    taskNodeId: "judge",
    inputSummary: `${contextLabel}：Evidence ${evidenceBrief.evidenceCards.length} 张，Source Budget ${evidenceBrief.sourceBudgetScore}/100，搜索质量 ${webResearch.searchQuality?.qualityScore ?? "unknown"}。`,
    idempotencyKey: [
      "judge",
      evidenceBrief.productName || "unknown",
      evidenceBrief.confidenceScore,
      evidenceBrief.evidenceCards.length,
      webResearch.queryExecutions?.length ?? 0,
      webResearch.searchResults.length
    ].join(":"),
    boundary: {
      inputArtifactIds: latestRuntimeArtifactIds(webResearch),
      acceptedInputSummary:
        "接收 Evidence Brief、Source Budget、搜索质量摘要和最近 handoff；不接收网页全文或搜索噪音。",
      inputCharCount: judgeInputCharCount(evidenceBrief, webResearch),
      modelProvider: "deterministic",
      payload: {
        contextLabel,
        productName: evidenceBrief.productName,
        evidenceCards: evidenceBrief.evidenceCards.length,
        sourceBudgetScore: evidenceBrief.sourceBudgetScore,
        confidenceScore: evidenceBrief.confidenceScore,
        searchQualityScore: webResearch.searchQuality?.qualityScore ?? null,
        latestHandoffIds: webResearch.runtimeTrace?.handoffs.slice(-4).map((handoff) => handoff.id) ?? []
      },
      forbiddenInputs: [
        "不得读取网页全文或搜索结果原始噪音。",
        "不得用模型主观判断补足缺失证据。",
        "不得放宽 Evidence Stop、Source Budget 或反证要求。"
      ],
      isolationNotes: [
        "Judge 是确定性审计 worker，只按 Evidence Brief 和 WebResearchSummary 规则计算。",
        "输出必须包含置信上限、允许决策、forbidden claims 和下一步补证要求。"
      ]
    },
    execute: async (context) => {
      const inputGuardrails = judgeInputGuardrails(evidenceBrief, webResearch);
      const toolCallId = runtime.startToolCall({
        policy: toolPolicies.judge,
        parentSpanId: spanId,
        workerRunId: context.workerRunId,
        provider: "local",
        inputSummary: "检查 Evidence Stop、Source Budget、反证覆盖、时效、客观性和搜索质量。",
        costEstimate: 0,
        guardrails: inputGuardrails
      });
      context.recordEvent({
        type: "tool_call",
        summary: "启动 Judge deterministic rule check。",
        metadata: {
          toolCallId,
          evidenceCards: evidenceBrief.evidenceCards.length,
          sourceBudgetScore: evidenceBrief.sourceBudgetScore
        }
      });

      const verdict = buildJudgeVerdict(evidenceBrief, webResearch);
      const artifact = await runtime.addArtifact({
        kind: "judge_report",
        owner: "judge_agent",
        title: "Judge Agent Verdict",
        summary: verdict.summary,
        payload: verdict,
        itemCount: verdict.reasons.length,
        preview: verdict.reasons.map((reason) => reason.finding).join("；")
      });
      const handoff = runtime.createHandoff({
        from: "judge_agent",
        to: "main_agent",
        goal: "把证据边界交给主 Agent，约束报告强度和下一步调研。",
        contextSummary: verdict.summary,
        artifactIds: [artifact.id],
        evidenceRefs: evidenceBrief.evidenceCards.slice(0, 8).map((card) => card.id),
        acceptedInputSummary: `接收 Evidence Brief、Source Budget、搜索质量和 Judge verdict artifact；输出报告强度、置信上限、允许决策和必须补证的边界。`,
        keyFindings: [
          `Judge 状态 ${verdict.status}，报告强度上限 ${verdict.allowedReportStrength}。`,
          `置信上限 ${verdict.confidenceCap}，允许决策 ${verdict.allowedDecisions.join("、")}。`,
          `发现 ${verdict.reasons.filter((reason) => reason.severity === "blocker").length} 个 blocker、${verdict.reasons.filter((reason) => reason.severity === "warning").length} 个 warning。`
        ],
        openQuestions: verdict.reasons
          .filter((reason) => reason.severity !== "info")
          .slice(0, 4)
          .map((reason) => reason.finding),
        uncertainties: verdict.reasons
          .filter((reason) => reason.severity !== "info")
          .slice(0, 6)
          .map((reason) => `${reason.category}：${reason.evidence}`),
        forbiddenClaims: judgeForbiddenClaims(verdict),
        nextActions: verdict.requiredResearchActions.slice(0, 5)
      });
      addJudgeInterrupt(runtime, verdict, artifact.id, {
        workerRunId: context.workerRunId,
        toolCallId
      });
      const outputGuardrails = judgeOutputGuardrails(verdict);
      runtime.completeToolCall(toolCallId, verdict.summary, {
        artifactIds: [artifact.id],
        costEstimate: 0,
        guardrails: outputGuardrails
      });
      context.recordEvent({
        type: "artifact",
        summary: `Judge verdict artifact 已写入：${verdict.status}。`,
        refs: [artifact.id],
        metadata: {
          reasons: verdict.reasons.length,
          confidenceCap: verdict.confidenceCap
        }
      });
      context.recordEvent({
        type: "handoff",
        summary: `Judge handoff 已生成，报告强度上限 ${verdict.allowedReportStrength}。`,
        refs: [handoff.id],
        metadata: {
          allowedDecisions: verdict.allowedDecisions.length,
          requiredActions: verdict.requiredResearchActions.length
        }
      });

      return {
        value: {
          verdict,
          artifactId: artifact.id,
          handoffId: handoff.id
        },
        outputSummary: verdict.summary,
        artifactIds: [artifact.id],
        handoffId: handoff.id,
        budgetUsed: {
          toolCalls: 1,
          artifacts: 1,
          outputChars: JSON.stringify(verdict).length
        }
      };
    }
  });
  if (run.status !== "completed" || !run.value) {
    const message = `Judge Agent 未完成：${run.failureCode ?? "unknown"}`;
    runtime.failSpan(spanId, message, { artifactIds: run.artifactIds });
    runtime.completeTrace();
    throw new Error(message);
  }

  const { verdict, artifactId, handoffId } = run.value;
  runtime.completeSpan(spanId, verdict.summary, {
    artifactIds: [...new Set([artifactId, ...run.artifactIds])],
    handoffId,
    metrics: {
      confidenceCap: verdict.confidenceCap,
      reasonCount: verdict.reasons.length,
      blockerCount: verdict.reasons.filter((reason) => reason.severity === "blocker").length
    }
  });
  runtime.completeTrace();

  return {
    verdict,
    webResearch: {
      ...webResearch,
      judgeVerdict: verdict,
      runtimeTrace: runtime.getTrace()
    }
  };
}

function addJudgeInterrupt(
  runtime: AgentRuntimeHarness,
  verdict: AgentJudgeVerdict,
  artifactId: string,
  refs: {
    workerRunId?: string;
    toolCallId?: string;
  } = {}
) {
  if (verdict.decision === "proceed_to_report") return;
  const type =
    verdict.decision === "needs_user_evidence"
      ? "needs_material"
      : verdict.decision === "continue_research"
        ? "approve_deep_research"
        : "evidence_too_weak_for_report";
  const blockerReasons = verdict.reasons.filter((reason) => reason.severity === "blocker");
  const requiredActions = [
    ...verdict.requiredResearchActions,
    ...blockerReasons.map((reason) => reason.requiredAction)
  ].slice(0, 8);
  runtime.addInterrupt({
    type,
    mode: verdict.status === "block" ? "hard" : "soft",
    blockedUntil:
      verdict.decision === "needs_user_evidence"
        ? "material"
        : verdict.decision === "continue_research"
          ? "approval"
          : "user_action",
    severity: verdict.status === "block" ? "blocker" : "warning",
    title: judgeInterruptTitle(verdict),
    summary: verdict.summary,
    requestedBy: "judge",
    requiredActions,
    resumeTargetId: "task:judge",
    taskNodeId: "judge",
    blockTaskNode: verdict.status === "block",
    workerRunId: refs.workerRunId,
    toolCallId: refs.toolCallId,
    artifactIds: [artifactId],
    resumeCheckpoint: {
      targetId: "task:judge",
      taskNodeId: "judge",
      workerRunId: refs.workerRunId,
      toolCallId: refs.toolCallId,
      sourceArtifactIds: [artifactId],
      inputSummary: `Judge verdict ${verdict.status}/${verdict.decision}，报告强度上限 ${verdict.allowedReportStrength}。`,
      resumeStrategy:
        "用户补材料、批准深查或接受降级报告边界后，从 Judge task node 重放 Judge/Report 末端节点。"
    },
    source: {
      label: "Judge Agent",
      reason: verdict.decision
    },
    resultSummary: `Judge 要求 ${verdict.decision}，报告强度上限 ${verdict.allowedReportStrength}。`
  });
}

function judgeInterruptTitle(verdict: AgentJudgeVerdict) {
  if (verdict.decision === "needs_user_evidence") return "需要用户补充原始证据";
  if (verdict.decision === "continue_research") return "需要批准继续深查";
  return "当前证据不足以支撑强报告";
}

function latestRuntimeArtifactIds(webResearch: WebResearchSummary) {
  return [
    ...(webResearch.runtimeTrace?.handoffs.slice(-4).flatMap((handoff) => handoff.artifactIds) ?? []),
    ...(webResearch.runtimeTrace?.artifacts
      .filter((artifact) => artifact.kind === "evidence_cards" || artifact.kind === "search_results")
      .slice(-4)
      .map((artifact) => artifact.id) ?? [])
  ]
    .filter(Boolean)
    .filter((id, index, values) => values.indexOf(id) === index)
    .slice(-8);
}

function judgeInputCharCount(evidenceBrief: EvidenceBrief, webResearch: WebResearchSummary) {
  return JSON.stringify({
    evidenceCards: evidenceBrief.evidenceCards.length,
    sourceBudgets: evidenceBrief.sourceBudgets.length,
    confidenceScore: evidenceBrief.confidenceScore,
    searchQuality: webResearch.searchQuality,
    queryExecutions: webResearch.queryExecutions?.length ?? 0,
    searchResults: webResearch.searchResults.length,
    crawled: webResearch.crawled.length
  }).length;
}

function judgeInputGuardrails(
  evidenceBrief: EvidenceBrief,
  webResearch: WebResearchSummary
): AgentToolGuardrailResult[] {
  return [
    {
      id: "judge-input-evidence",
      label: "Evidence Brief",
      status: evidenceBrief.evidenceCards.length ? "pass" : "warn",
      message: `${evidenceBrief.evidenceCards.length} evidence cards available.`
    },
    {
      id: "judge-input-source-budget",
      label: "Source Budget",
      status: evidenceBrief.sourceBudgets.length ? "pass" : "warn",
      message: `${evidenceBrief.sourceBudgets.length} source budgets; score ${evidenceBrief.sourceBudgetScore}/100.`
    },
    {
      id: "judge-input-search-quality",
      label: "Search Quality",
      status: webResearch.searchQuality ? "pass" : "warn",
      message: webResearch.searchQuality
        ? `Search quality score ${webResearch.searchQuality.qualityScore}/100.`
        : "Search quality unavailable; Judge must cap confidence if external evidence is sparse."
    }
  ];
}

function graphDependencyBlockersFor(runtime: AgentRuntimeHarness, taskNodeId: string) {
  const graph = runtime.getTrace().taskGraph;
  const node = graph?.nodes.find((item) => item.id === taskNodeId);
  if (!graph || !node) return [];
  const nodeById = new Map(graph.nodes.map((item) => [item.id, item]));
  return node.dependsOn
    .filter((dependencyId) => !isTaskNodeDependencySatisfied(nodeById.get(dependencyId)))
    .map((dependencyId) => {
      const dependency = nodeById.get(dependencyId);
      const blocked = dependency?.metrics?.graphExecutorBlocked ? ":graph_blocked" : "";
      return `${dependencyId}:${dependency?.status ?? "missing"}${blocked}`;
    });
}

function blockedJudgeVerdict(
  evidenceBrief: EvidenceBrief,
  webResearch: WebResearchSummary,
  dependencyBlockers: string[]
): AgentJudgeVerdict {
  const reason: AgentJudgeReason = {
    id: "graph-executor-dependency-blocked",
    category: "artifact_integrity",
    severity: "blocker",
    finding: "上游证据抽取节点未满足，Judge 不能审计完整证据链。",
    evidence: dependencyBlockers.join(" / "),
    requiredAction: "先恢复 evidence_extract 及其上游 search/fetch 节点，再重放 Judge。"
  };
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "block",
    decision: "continue_research",
    allowedReportStrength: "exploratory",
    confidenceCap: Math.min(25, evidenceBrief.confidenceScore),
    summary: `Judge 被 GraphExecutor 阻断：${dependencyBlockers.join(" / ")}。需先恢复上游证据抽取。`,
    reasons: [reason],
    requiredResearchActions: [reason.requiredAction],
    allowedDecisions: ["test_first"],
    metrics: judgeMetrics(evidenceBrief, webResearch)
  };
}

function judgeOutputGuardrails(verdict: AgentJudgeVerdict): AgentToolGuardrailResult[] {
  const blockerCount = verdict.reasons.filter((reason) => reason.severity === "blocker").length;
  const warningCount = verdict.reasons.filter((reason) => reason.severity === "warning").length;
  return [
    {
      id: "judge-confidence-cap",
      label: "Confidence Cap",
      status: verdict.confidenceCap <= 100 ? "pass" : "block",
      message: `Confidence cap ${verdict.confidenceCap}; allowed report strength ${verdict.allowedReportStrength}.`
    },
    {
      id: "judge-allowed-decisions",
      label: "Allowed Decisions",
      status: verdict.allowedDecisions.length ? "pass" : "block",
      message: `Allowed decisions: ${verdict.allowedDecisions.join(", ") || "none"}.`
    },
    {
      id: "judge-blocker-handling",
      label: "Blocker Handling",
      status: blockerCount ? "warn" : "pass",
      message: `${blockerCount} blockers and ${warningCount} warnings must constrain the report.`
    }
  ];
}

function buildJudgeVerdict(
  evidenceBrief: EvidenceBrief,
  webResearch: WebResearchSummary
): AgentJudgeVerdict {
  const reasons = [
    ...judgeEvidenceStop(evidenceBrief),
    ...judgeSourceBudgets(evidenceBrief),
    ...judgeOpposition(evidenceBrief),
    ...judgeRecency(evidenceBrief, webResearch),
    ...judgeObjectivity(evidenceBrief),
    ...judgeSearchQuality(webResearch),
    ...judgeConfidenceAlignment(evidenceBrief)
  ];
  const blockerCount = reasons.filter((reason) => reason.severity === "blocker").length;
  const warningCount = reasons.filter((reason) => reason.severity === "warning").length;
  const status: AgentJudgeVerdict["status"] = blockerCount ? "block" : warningCount ? "warn" : "pass";
  const decision = judgeDecision(status, evidenceBrief, webResearch, reasons);
  const confidenceCap = confidenceCapFor(status, evidenceBrief, reasons);
  const allowedReportStrength = reportStrengthFor(status, confidenceCap);
  const allowedDecisions = allowedDecisionsFor(evidenceBrief, status, decision);
  const requiredResearchActions = [
    ...new Set(
      reasons
        .filter((reason) => reason.severity !== "info")
        .map((reason) => reason.requiredAction)
        .filter(Boolean)
    )
  ];
  const metrics = judgeMetrics(evidenceBrief, webResearch);

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status,
    decision,
    allowedReportStrength,
    confidenceCap,
    summary: judgeSummary(status, decision, confidenceCap, reasons),
    reasons,
    requiredResearchActions,
    allowedDecisions,
    metrics
  };
}

function judgeForbiddenClaims(verdict: AgentJudgeVerdict) {
  const claims = [
    `报告潜力分不得超过 Judge 置信上限 ${verdict.confidenceCap}。`,
    `报告结论不得强于 ${verdict.allowedReportStrength}。`,
    `最终建议只能在允许决策内选择：${verdict.allowedDecisions.join("、")}。`,
    verdict.status === "block" ? "Judge block 时不得推荐直接 build 或写成强市场验证。" : "",
    verdict.decision === "needs_user_evidence" ? "需要用户证据时，不得用模型推断补足缺失事实。" : "",
    verdict.decision === "continue_research" ? "需要继续补查时，不得把当前报告写成最终判断。" : ""
  ];
  return [...new Set(claims.filter(Boolean))];
}

function judgeEvidenceStop(evidenceBrief: EvidenceBrief): AgentJudgeReason[] {
  const stop = evidenceBrief.evidenceStop;
  if (!stop) return [];
  return [
    {
      id: "judge-evidence-stop",
      category: "evidence_stop",
      severity: stop.severity === "blocked" ? "blocker" : "warning",
      finding: "Evidence Stop 已限制强决策。",
      evidence: stop.reason,
      requiredAction: stop.minimumEvidenceNeeded.slice(0, 3).join("；") || "补足 Evidence Stop 要求的最低证据。"
    }
  ];
}

function judgeSourceBudgets(evidenceBrief: EvidenceBrief): AgentJudgeReason[] {
  const unmet = evidenceBrief.sourceBudgets.filter((budget) => budget.status !== "met");
  if (!unmet.length) return [];
  const blocker = evidenceBrief.sourceBudgetScore < 50 || unmet.some((budget) => budget.status === "missing");
  return [
    {
      id: "judge-source-budget",
      category: "source_budget",
      severity: blocker ? "blocker" : "warning",
      finding: `Source Budget 未达标：${unmet.slice(0, 4).map((budget) => budget.label).join("、")}。`,
      evidence: `Source Budget 得分 ${evidenceBrief.sourceBudgetScore}/100，未达标 ${unmet.length}/${evidenceBrief.sourceBudgets.length}。`,
      requiredAction: unmet
        .slice(0, 3)
        .map((budget) => `${budget.label}：${budget.missingEvidence.slice(0, 2).join("、")}`)
        .join("；")
    }
  ];
}

function judgeOpposition(evidenceBrief: EvidenceBrief): AgentJudgeReason[] {
  const oppositionBudget = evidenceBrief.sourceBudgets.find((budget) => budget.assumptionId === "opposition");
  const oppositionCount =
    oppositionBudget?.currentOpposition ??
    evidenceBrief.evidenceCards.filter((card) => card.direction === "oppose").length;
  if (oppositionCount > 0) return [];
  return [
    {
      id: "judge-opposition",
      category: "opposition",
      severity: evidenceBrief.confidenceScore >= 60 ? "blocker" : "warning",
      finding: "缺少可用反证。",
      evidence: "当前 Evidence Brief 没有记录反向证据，容易形成确认偏误。",
      requiredAction: "启动 Opposition Scout，搜索失败、停更、替代方案、低优先级和价格抗拒证据。"
    }
  ];
}

function judgeRecency(
  evidenceBrief: EvidenceBrief,
  webResearch: WebResearchSummary
): AgentJudgeReason[] {
  const reasons: AgentJudgeReason[] = [];
  if (evidenceBrief.temporalValidityScore < 55 || evidenceBrief.currentEvidenceRatio < 45) {
    reasons.push({
      id: "judge-recency",
      category: "recency",
      severity: evidenceBrief.temporalValidityScore < 35 ? "blocker" : "warning",
      finding: "证据时效不足。",
      evidence: `当前证据比例 ${evidenceBrief.currentEvidenceRatio}%，时效有效分 ${evidenceBrief.temporalValidityScore}/100，过旧证据 ${evidenceBrief.staleEvidenceCount} 条。`,
      requiredAction: "补查最近 12-24 个月的发布、用户采用、停更、竞品变化和商业化证据。"
    });
  }
  const dateCoverage = webResearch.searchQuality?.dateCoverage ?? 100;
  if (dateCoverage < 35 && (webResearch.queryExecutions?.some((execution) => execution.status === "executed") ?? false)) {
    reasons.push({
      id: "judge-date-coverage",
      category: "recency",
      severity: "warning",
      finding: "搜索结果日期覆盖偏低。",
      evidence: `搜索日期覆盖 ${dateCoverage}%，时效判断需要更多可校验来源。`,
      requiredAction: "优先抓取带 publishedAt/updatedAt/Last-Modified 的来源。"
    });
  }
  return reasons;
}

function judgeObjectivity(evidenceBrief: EvidenceBrief): AgentJudgeReason[] {
  if (evidenceBrief.objectiveEvidenceRatio >= 50) return [];
  return [
    {
      id: "judge-objectivity",
      category: "objectivity",
      severity: evidenceBrief.confidenceScore >= 58 ? "blocker" : "warning",
      finding: "客观证据占比偏低。",
      evidence: `客观证据占比 ${evidenceBrief.objectiveEvidenceRatio}%，模型推断和假设仍然占较大比例。`,
      requiredAction: "补充行为证据：真实使用、付费、留资、复用、迁移、issue/discussion 或访谈原始材料。"
    }
  ];
}

function judgeSearchQuality(webResearch: WebResearchSummary): AgentJudgeReason[] {
  const quality = webResearch.searchQuality;
  if (!quality) return [];
  const reasons: AgentJudgeReason[] = [];
  if (quality.qualityScore < 45) {
    reasons.push({
      id: "judge-search-quality",
      category: "search_quality",
      severity: quality.qualityScore < 25 ? "blocker" : "warning",
      finding: "搜索质量不足。",
      evidence: `搜索质量 ${quality.qualityScore}/100，执行 ${quality.executedQueries}/${quality.plannedQueries} 条，URL 覆盖 ${quality.urlCoverage}%。`,
      requiredAction: "换 query、换 provider 或要求用户补充可核验材料，不能用低质量搜索支撑强结论。"
    });
  }
  const skippedOrFailed = quality.skippedQueries + quality.failedQueries;
  if (skippedOrFailed > 0 && skippedOrFailed >= Math.max(2, Math.ceil(quality.plannedQueries / 2))) {
    reasons.push({
      id: "judge-query-failures",
      category: "search_quality",
      severity: "warning",
      finding: "大量查询失败或跳过。",
      evidence: `${quality.skippedQueries} 条 skipped，${quality.failedQueries} 条 failed。`,
      requiredAction: "记录为工具链边界，重试关键查询或降级结论强度。"
    });
  }
  return reasons;
}

function judgeConfidenceAlignment(evidenceBrief: EvidenceBrief): AgentJudgeReason[] {
  if (evidenceBrief.confidenceScore < 72) return [];
  const hasWeakFoundation =
    evidenceBrief.sourceBudgetScore < 70 ||
    evidenceBrief.objectiveEvidenceRatio < 60 ||
    evidenceBrief.temporalValidityScore < 60;
  if (!hasWeakFoundation) return [];
  return [
    {
      id: "judge-confidence-alignment",
      category: "confidence_alignment",
      severity: "warning",
      finding: "证据置信较高，但基础指标存在短板。",
      evidence: `证据置信 ${evidenceBrief.confidenceScore}/100，Source Budget ${evidenceBrief.sourceBudgetScore}/100，客观证据 ${evidenceBrief.objectiveEvidenceRatio}%，时效 ${evidenceBrief.temporalValidityScore}/100。`,
      requiredAction: "报告中必须写明置信边界，不得把潜力判断表达成已验证市场事实。"
    }
  ];
}

function judgeDecision(
  status: AgentJudgeVerdict["status"],
  evidenceBrief: EvidenceBrief,
  webResearch: WebResearchSummary,
  reasons: AgentJudgeReason[]
): AgentJudgeVerdict["decision"] {
  if (status === "block" && reasons.some((reason) => reason.category === "search_quality")) {
    const executed = webResearch.queryExecutions?.some((execution) => execution.status === "executed") ?? false;
    return executed ? "block_strong_decision" : "needs_user_evidence";
  }
  if (status === "block") return "block_strong_decision";
  if (
    status === "warn" &&
    evidenceBrief.evidenceStop &&
    (webResearch.researchLoops?.length ?? 0) < 2
  ) {
    return "continue_research";
  }
  return "proceed_to_report";
}

function confidenceCapFor(
  status: AgentJudgeVerdict["status"],
  evidenceBrief: EvidenceBrief,
  reasons: AgentJudgeReason[]
) {
  let cap = status === "block" ? 55 : status === "warn" ? 72 : 88;
  if (reasons.some((reason) => reason.category === "opposition" && reason.severity === "blocker")) {
    cap = Math.min(cap, 58);
  }
  if (reasons.some((reason) => reason.category === "search_quality" && reason.severity === "blocker")) {
    cap = Math.min(cap, 52);
  }
  if (evidenceBrief.evidenceStop) {
    cap = Math.min(cap, 55);
  }
  return Math.max(25, Math.min(cap, evidenceBrief.confidenceScore));
}

function reportStrengthFor(
  status: AgentJudgeVerdict["status"],
  confidenceCap: number
): AgentJudgeVerdict["allowedReportStrength"] {
  if (status === "block" || confidenceCap < 58) return "exploratory";
  if (status === "warn" || confidenceCap < 74) return "moderate";
  return "strong";
}

function allowedDecisionsFor(
  evidenceBrief: EvidenceBrief,
  status: AgentJudgeVerdict["status"],
  decision: AgentJudgeVerdict["decision"]
): ProductDecision["decision"][] {
  if (decision === "needs_user_evidence") return ["test_first"];
  if (status === "block" || evidenceBrief.evidenceStop) return ["test_first"];
  if (evidenceBrief.decision.decision === "stop") return ["test_first", "stop"];
  if (evidenceBrief.decision.decision === "reposition") return ["test_first", "reposition"];
  if (evidenceBrief.decision.decision === "build") return ["test_first", "build"];
  return ["test_first"];
}

function judgeMetrics(evidenceBrief: EvidenceBrief, webResearch: WebResearchSummary): AgentJudgeVerdict["metrics"] {
  const evidenceCards = evidenceBrief.evidenceCards.length;
  const externalEvidence = evidenceBrief.evidenceCards.filter(
    (card) => card.sourceType !== "uploaded_material"
  ).length;
  const supportEvidence = evidenceBrief.evidenceCards.filter((card) => card.direction === "support").length;
  const oppositionEvidence = evidenceBrief.evidenceCards.filter((card) => card.direction === "oppose").length;
  const executions = webResearch.queryExecutions ?? [];
  return {
    evidenceCards,
    externalEvidence,
    supportEvidence,
    oppositionEvidence,
    sourceBudgetScore: evidenceBrief.sourceBudgetScore,
    unmetSourceBudgets: evidenceBrief.sourceBudgets.filter((budget) => budget.status !== "met").length,
    objectiveEvidenceRatio: evidenceBrief.objectiveEvidenceRatio,
    currentEvidenceRatio: evidenceBrief.currentEvidenceRatio,
    temporalValidityScore: evidenceBrief.temporalValidityScore,
    searchQualityScore: webResearch.searchQuality?.qualityScore ?? 0,
    executedQueries: executions.filter((execution) => execution.status === "executed").length,
    skippedQueries: executions.filter((execution) => execution.status === "skipped").length,
    failedQueries: executions.filter((execution) => execution.status === "failed").length
  };
}

function judgeSummary(
  status: AgentJudgeVerdict["status"],
  decision: AgentJudgeVerdict["decision"],
  confidenceCap: number,
  reasons: AgentJudgeReason[]
) {
  const prefix =
    status === "pass"
      ? "证据边界通过"
      : status === "warn"
        ? "证据边界存在警告"
        : "证据边界阻断强结论";
  const decisionText =
    decision === "continue_research"
      ? "建议继续补查"
      : decision === "needs_user_evidence"
        ? "需要用户补充可核验证据"
        : decision === "block_strong_decision"
          ? "阻断 build/stop/reposition 等强决策"
          : "允许进入报告生成";
  const topReason = reasons.find((reason) => reason.severity !== "info")?.finding;
  return `${prefix}，${decisionText}，置信上限 ${confidenceCap}/100。${topReason ? `首要原因：${topReason}` : ""}`;
}
