import type {
  AgentRunEval,
  AgentRunEvalCategory,
  AgentRunEvalCheck,
  AgentRunEvalStatus,
  AgentRuntimeToolCall,
  AgentRuntimeTrace,
  AgentTaskNodeKind,
  AgentTaskNodeStatus
} from "./types";

const evalVersion = "agent-run-eval-v1" as const;

type BuildCheckInput = {
  id: string;
  label: string;
  category: AgentRunEvalCategory;
  score: number;
  summary: string;
  evidence: string[];
  recommendation?: string;
  blockAt?: number;
  warnAt?: number;
};

export function evaluateAgentRun(trace: AgentRuntimeTrace, evaluatedAt = new Date().toISOString()): AgentRunEval {
  const metrics = collectMetrics(trace);
  const checks = [
    evaluateTaskGraphCoverage(trace, metrics),
    evaluateEvidenceRouteCoverage(trace, metrics),
    evaluateRunnerEnforcement(trace, metrics),
    evaluateSubagentIsolation(trace, metrics),
    evaluateContextBoundary(trace, metrics),
    evaluateToolSecurity(trace, metrics),
    evaluateHandoffIntegrity(trace, metrics),
    evaluateJudgeReportBoundary(trace, metrics),
    evaluateRecoveryReadiness(trace, metrics),
    evaluateToolEfficiency(trace, metrics),
    evaluateRuntimeVersioning(trace, metrics)
  ];
  const averageScore = Math.round(
    checks.reduce((sum, check) => sum + check.score, 0) / Math.max(1, checks.length)
  );
  const blockers = checks
    .filter((check) => check.status === "block")
    .map((check) => `${check.label}: ${check.summary}`);
  const warnings = checks
    .filter((check) => check.status === "warn")
    .map((check) => `${check.label}: ${check.summary}`);
  const strengths = checks
    .filter((check) => check.status === "pass")
    .slice(0, 4)
    .map((check) => `${check.label}: ${check.summary}`);
  const status: AgentRunEvalStatus =
    blockers.length || metrics.activeHardInterrupts
      ? "block"
      : averageScore >= 82
        ? "pass"
        : "warn";

  return {
    version: evalVersion,
    evaluatedAt,
    status,
    score: averageScore,
    summary: buildSummary({ status, score: averageScore, blockers, warnings, trace }),
    checks,
    blockers,
    warnings,
    strengths,
    metrics
  };
}

function collectMetrics(trace: AgentRuntimeTrace): AgentRunEval["metrics"] {
  const taskNodes = trace.taskGraph?.nodes ?? [];
  const searchTaskNodes = taskNodes.filter((node) => isSearchTaskKind(node.kind));
  const workerRuns = trace.workerRuns ?? [];
  const toolCalls = trace.toolCalls ?? [];
  const guardrails = toolCalls.flatMap((tool) => tool.guardrails);
  const inputCounts = new Map<string, number>();
  for (const tool of toolCalls) {
    const key = `${tool.toolId}:${normalizeToolInput(tool.inputSummary)}`;
    inputCounts.set(key, (inputCounts.get(key) ?? 0) + 1);
  }
  const duplicateToolInputs = [...inputCounts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0
  );
  const activeHardInterrupts = (trace.interrupts ?? []).filter(
    (interrupt) =>
      interrupt.status === "active" &&
      (interrupt.mode === "hard" || interrupt.blocksRun === true)
  ).length;

  return {
    taskNodes: taskNodes.length,
    completedTaskNodes: taskNodes.filter((node) => node.status === "completed").length,
    terminalTaskNodes: taskNodes.filter((node) => isTerminalTaskStatus(node.status)).length,
    staleTaskNodes: trace.taskGraph?.executor?.staleNodeIds.length ?? 0,
    searchTaskNodes: searchTaskNodes.length,
    completedSearchTaskNodes: searchTaskNodes.filter((node) => node.status === "completed").length,
    workerRuns: workerRuns.length,
    runnerWorkers: workerRuns.filter((run) => run.executionMode === "subagent_runner").length,
    manualWorkers: workerRuns.filter((run) => run.executionMode !== "subagent_runner").length,
    boundaryCount: workerRuns.filter((run) => run.executionBoundary).length,
    boundaryViolations: workerRuns.filter(
      (run) => run.executionBoundary?.boundaryEnforcement?.status === "violation"
    ).length,
    boundaryCompactions: workerRuns.filter(
      (run) => run.executionBoundary?.boundaryEnforcement?.status === "compacted"
    ).length,
    toolCalls: toolCalls.length,
    highRiskToolCalls: toolCalls.filter(isHighRiskRuntimeTool).length,
    unenforcedToolCalls: toolCalls.filter((tool) => isHighRiskRuntimeTool(tool) && !hasRuntimeBoundary(tool, trace)).length,
    blockedToolCalls: toolCalls.filter((tool) => tool.status === "blocked").length,
    failedToolCalls: toolCalls.filter((tool) => tool.status === "failed").length,
    blockingGuardrails: guardrails.filter((guardrail) => guardrail.status === "block").length,
    warningGuardrails: guardrails.filter((guardrail) => guardrail.status === "warn").length,
    duplicateToolInputs,
    handoffs: trace.handoffs.length,
    handoffsWithForbiddenClaims: trace.handoffs.filter((handoff) => handoff.forbiddenClaims?.length).length,
    activeHardInterrupts,
    resumeTargets: trace.resumePlan?.targetCount ?? 0,
    stateSnapshots: trace.stateSnapshots?.length ?? 0,
    cacheHits: toolCalls.filter((tool) => tool.cacheStatus === "hit").length
  };
}

function evaluateTaskGraphCoverage(
  trace: AgentRuntimeTrace,
  metrics: AgentRunEval["metrics"]
): AgentRunEvalCheck {
  const nodes = trace.taskGraph?.nodes ?? [];
  if (!nodes.length) {
    return buildCheck({
      id: "task_graph_coverage",
      label: "Task Graph Coverage",
      category: "coverage",
      score: 35,
      summary: "缺少可执行 task graph，无法证明调研路径完整。",
      evidence: ["taskGraph: missing"],
      recommendation: "所有主分析和回测运行都应初始化 research task graph。",
      blockAt: 39
    });
  }
  const required: AgentTaskNodeKind[] = [
    "material_fetch",
    "query_plan",
    "support_search",
    "opposition_search",
    "freshness_search",
    "competitor_search",
    "result_fetch",
    "evidence_extract",
    "judge",
    "report"
  ];
  const present = new Set(nodes.map((node) => node.kind));
  const presentCount = required.filter((kind) => present.has(kind)).length;
  const terminalRatio = metrics.terminalTaskNodes / Math.max(1, metrics.taskNodes);
  const score = clamp(Math.round((presentCount / required.length) * 62 + terminalRatio * 38));
  return buildCheck({
    id: "task_graph_coverage",
    label: "Task Graph Coverage",
    category: "coverage",
    score,
    summary: `${presentCount}/${required.length} 个核心节点存在，${metrics.terminalTaskNodes}/${metrics.taskNodes} 个节点到达终态。`,
    evidence: [
      `nodes=${metrics.taskNodes}`,
      `completed=${metrics.completedTaskNodes}`,
      `terminal=${metrics.terminalTaskNodes}`,
      `missing=${required.filter((kind) => !present.has(kind)).join(", ") || "none"}`
    ],
    recommendation: "缺失的核心节点需要进入 GraphExecutor，避免过程式链路绕过 trace。",
    blockAt: 55,
    warnAt: 82
  });
}

function evaluateEvidenceRouteCoverage(
  trace: AgentRuntimeTrace,
  metrics: AgentRunEval["metrics"]
): AgentRunEvalCheck {
  const routeMap = {
    support: hasCompletedRoute(trace, "support_search", ["support", "正向"]),
    opposition: hasCompletedRoute(trace, "opposition_search", ["opposition", "反证"]),
    freshness: hasCompletedRoute(trace, "freshness_search", ["freshness", "时效", "recency"]),
    competitor: hasCompletedRoute(trace, "competitor_search", ["competitor", "竞品", "替代"])
  };
  const covered = Object.entries(routeMap).filter(([, value]) => value).map(([key]) => key);
  const score = clamp(covered.length * 25);
  return buildCheck({
    id: "evidence_route_coverage",
    label: "Evidence Route Coverage",
    category: "evidence",
    score,
    summary: `覆盖 ${covered.length}/4 条证据路径：${covered.join(", ") || "none"}。`,
    evidence: [
      `searchTasks=${metrics.searchTaskNodes}`,
      `completedSearchTasks=${metrics.completedSearchTaskNodes}`,
      ...Object.entries(routeMap).map(([key, value]) => `${key}=${value ? "yes" : "no"}`)
    ],
    recommendation: "潜力判断至少要实际完成支持、反证、时效和竞品路径；只有 planned/skipped 节点不算覆盖。",
    blockAt: 49,
    warnAt: 75
  });
}

function evaluateRunnerEnforcement(
  trace: AgentRuntimeTrace,
  metrics: AgentRunEval["metrics"]
): AgentRunEvalCheck {
  const unenforced = (trace.toolCalls ?? [])
    .filter((tool) => isHighRiskRuntimeTool(tool) && !hasRuntimeBoundary(tool, trace))
    .slice(0, 6)
    .map((tool) => `${tool.toolId}:${tool.toolLabel}`);
  const score = metrics.highRiskToolCalls
    ? clamp(Math.round(((metrics.highRiskToolCalls - metrics.unenforcedToolCalls) / metrics.highRiskToolCalls) * 100))
    : 100;
  return buildCheck({
    id: "subagent_runner_enforcement",
    label: "Runner Enforcement",
    category: "context",
    score,
    summary: `${metrics.highRiskToolCalls - metrics.unenforcedToolCalls}/${metrics.highRiskToolCalls} 个高风险工具调用挂在 worker/task/boundary 下。`,
    evidence: [
      `highRiskToolCalls=${metrics.highRiskToolCalls}`,
      `unenforcedToolCalls=${metrics.unenforcedToolCalls}`,
      ...unenforced.map((item) => `unenforced=${item}`)
    ],
    recommendation: "file/pdf/ocr/code/github/search/fetch/evidence/judge/report/follow-up 等高风险工具必须通过 SubagentRunner 或等价 worker boundary。",
    blockAt: 85,
    warnAt: 98
  });
}

function evaluateSubagentIsolation(
  trace: AgentRuntimeTrace,
  metrics: AgentRunEval["metrics"]
): AgentRunEvalCheck {
  if (!metrics.workerRuns) {
    return buildCheck({
      id: "subagent_isolation",
      label: "Subagent Isolation",
      category: "context",
      score: 35,
      summary: "没有 worker run，无法证明高上下文任务被隔离。",
      evidence: ["workerRuns=0"],
      recommendation: "材料读取、搜索、抓取、证据抽取、Judge 和 Report 都应有 worker run。",
      blockAt: 39
    });
  }
  const runnerRatio = metrics.runnerWorkers / Math.max(1, metrics.workerRuns);
  const boundaryRatio = metrics.boundaryCount / Math.max(1, metrics.workerRuns);
  const score = clamp(Math.round(runnerRatio * 45 + boundaryRatio * 40 + (metrics.manualWorkers ? 0 : 15)));
  return buildCheck({
    id: "subagent_isolation",
    label: "Subagent Isolation",
    category: "context",
    score,
    summary: `${metrics.runnerWorkers}/${metrics.workerRuns} 个 worker 走 Runner，${metrics.boundaryCount}/${metrics.workerRuns} 个有隔离边界。`,
    evidence: [
      `runnerWorkers=${metrics.runnerWorkers}`,
      `manualWorkers=${metrics.manualWorkers}`,
      `boundaries=${metrics.boundaryCount}`
    ],
    recommendation: "把剩余 inline/manual worker 迁入 SubagentRunner，并要求 contextPackId。",
    blockAt: 55,
    warnAt: 85
  });
}

function evaluateContextBoundary(
  trace: AgentRuntimeTrace,
  metrics: AgentRunEval["metrics"]
): AgentRunEvalCheck {
  const score = clamp(100 - metrics.boundaryViolations * 45 - metrics.boundaryCompactions * 8);
  const violationExamples = (trace.workerRuns ?? [])
    .flatMap((run) => run.executionBoundary?.boundaryEnforcement?.violations ?? [])
    .slice(0, 3);
  return buildCheck({
    id: "context_boundary_health",
    label: "Context Boundary",
    category: "context",
    score,
    summary: `${metrics.boundaryViolations} 个 boundary violation，${metrics.boundaryCompactions} 个 compacted boundary。`,
    evidence: [
      `boundaryCount=${metrics.boundaryCount}`,
      `violations=${metrics.boundaryViolations}`,
      `compactions=${metrics.boundaryCompactions}`,
      ...violationExamples.map((item) => `violation=${item}`)
    ],
    recommendation: "网页/PDF/README 原文只能进 artifact，报告链路只能消费压缩 handoff 和 citation refs。",
    blockAt: 90,
    warnAt: 98
  });
}

function evaluateToolSecurity(
  trace: AgentRuntimeTrace,
  metrics: AgentRunEval["metrics"]
): AgentRunEvalCheck {
  const score = clamp(
    100 -
      metrics.blockingGuardrails * 16 -
      metrics.warningGuardrails * 4 -
      metrics.blockedToolCalls * 8 -
      metrics.failedToolCalls * 4
  );
  const notableGuardrails = (trace.toolCalls ?? [])
    .flatMap((tool) =>
      tool.guardrails
        .filter((guardrail) => guardrail.status !== "pass")
        .map((guardrail) => `${tool.toolId}:${guardrail.label}:${guardrail.status}`)
    )
    .slice(0, 5);
  return buildCheck({
    id: "tool_guardrail_security",
    label: "Tool Guardrails",
    category: "security",
    score,
    summary: `${metrics.blockingGuardrails} 个 block guardrail，${metrics.warningGuardrails} 个 warn guardrail，${metrics.blockedToolCalls} 个 blocked tool。`,
    evidence: [
      `toolCalls=${metrics.toolCalls}`,
      `failedToolCalls=${metrics.failedToolCalls}`,
      ...notableGuardrails
    ],
    recommendation: "安全 block 后下游必须降级或 interrupt，不能继续生成强结论。",
    blockAt: 45,
    warnAt: 86
  });
}

function evaluateHandoffIntegrity(
  trace: AgentRuntimeTrace,
  metrics: AgentRunEval["metrics"]
): AgentRunEvalCheck {
  const richHandoffs = trace.handoffs.filter(
    (handoff) =>
      (handoff.keyFindings?.length ?? 0) +
        (handoff.uncertainties?.length ?? 0) +
        (handoff.forbiddenClaims?.length ?? 0) >
      0
  ).length;
  const budgetedHandoffs = trace.handoffs.filter((handoff) => handoff.contextBudget).length;
  const score = metrics.handoffs
    ? clamp(Math.round((richHandoffs / metrics.handoffs) * 55 + (budgetedHandoffs / metrics.handoffs) * 35 + 10))
    : 30;
  return buildCheck({
    id: "handoff_integrity",
    label: "Handoff Integrity",
    category: "coverage",
    score,
    summary: `${richHandoffs}/${metrics.handoffs} 个 handoff 带 findings/uncertainties/forbidden claims，${budgetedHandoffs}/${metrics.handoffs} 个带上下文预算。`,
    evidence: [
      `handoffs=${metrics.handoffs}`,
      `richHandoffs=${richHandoffs}`,
      `budgetedHandoffs=${budgetedHandoffs}`,
      `forbiddenClaimHandoffs=${metrics.handoffsWithForbiddenClaims}`
    ],
    recommendation: "每个 worker 交接应明确 findings、uncertainties、forbidden claims 和 context budget。",
    blockAt: 45,
    warnAt: 80
  });
}

function evaluateJudgeReportBoundary(
  trace: AgentRuntimeTrace,
  metrics: AgentRunEval["metrics"]
): AgentRunEvalCheck {
  const judgeNode = trace.taskGraph?.nodes.find((node) => node.kind === "judge");
  const reportNode = trace.taskGraph?.nodes.find((node) => node.kind === "report");
  const judgeArtifact = trace.artifacts.some((artifact) => artifact.kind === "judge_report");
  const reportArtifact = trace.artifacts.some((artifact) => artifact.kind === "model_report");
  const judgeExists = Boolean(judgeNode || judgeArtifact || trace.workerRuns?.some((run) => run.subagent === "judge_agent"));
  const reportExists = Boolean(reportNode || reportArtifact || trace.workerRuns?.some((run) => run.subagent === "report_composer"));
  const reportCompleted = reportNode?.status === "completed" || reportArtifact;
  const judgeCompleted = judgeNode?.status === "completed" || judgeArtifact;
  const score = reportCompleted && !judgeCompleted
    ? 25
    : judgeExists && reportExists
      ? 95
      : judgeExists || reportExists
        ? 70
        : 40;
  return buildCheck({
    id: "judge_report_boundary",
    label: "Judge / Report Boundary",
    category: "judge",
    score,
    summary: `Judge ${judgeExists ? judgeNode?.status ?? "artifact/worker" : "missing"}，Report ${reportExists ? reportNode?.status ?? "artifact/worker" : "missing"}。`,
    evidence: [
      `judgeNode=${judgeNode?.status ?? "none"}`,
      `reportNode=${reportNode?.status ?? "none"}`,
      `judgeArtifact=${judgeArtifact}`,
      `reportArtifact=${reportArtifact}`,
      `activeHardInterrupts=${metrics.activeHardInterrupts}`
    ],
    recommendation: "报告生成必须位于 Judge 之后；Judge block 时报告只能降级、跳过或进入 interrupt。",
    blockAt: 50,
    warnAt: 85
  });
}

function evaluateRecoveryReadiness(
  trace: AgentRuntimeTrace,
  metrics: AgentRunEval["metrics"]
): AgentRunEvalCheck {
  const failedOrBlocked =
    (trace.workerRuns ?? []).filter((run) => run.status === "failed").length +
    (trace.toolCalls ?? []).filter((tool) => tool.status === "failed" || tool.status === "blocked").length +
    (trace.taskGraph?.nodes.filter((node) => node.status === "failed" || node.status === "interrupted").length ?? 0);
  const interruptCheckpoints = (trace.interrupts ?? []).filter((interrupt) => interrupt.resumeCheckpoint).length;
  const score = failedOrBlocked
    ? clamp(Math.round((metrics.stateSnapshots ? 35 : 0) + (metrics.resumeTargets ? 35 : 0) + (interruptCheckpoints ? 30 : 0)))
    : clamp(Math.round((metrics.stateSnapshots ? 50 : 30) + (trace.resumePlan ? 30 : 10) + 20));
  return buildCheck({
    id: "recovery_readiness",
    label: "Recovery Readiness",
    category: "recovery",
    score,
    summary: `${failedOrBlocked} 个失败/阻断对象，${metrics.stateSnapshots} 个 snapshot，${metrics.resumeTargets} 个 resume target，${interruptCheckpoints} 个 interrupt checkpoint。`,
    evidence: [
      `failedOrBlocked=${failedOrBlocked}`,
      `stateSnapshots=${metrics.stateSnapshots}`,
      `resumeTargets=${metrics.resumeTargets}`,
      `interruptCheckpoints=${interruptCheckpoints}`
    ],
    recommendation: "所有失败、阻断和 hard interrupt 都应有 checkpoint 与可执行 resume target。",
    blockAt: failedOrBlocked ? 60 : 30,
    warnAt: 82
  });
}

function evaluateToolEfficiency(
  trace: AgentRuntimeTrace,
  metrics: AgentRunEval["metrics"]
): AgentRunEvalCheck {
  const highToolCountPenalty = Math.max(0, metrics.toolCalls - 40) * 2;
  const score = clamp(100 - metrics.duplicateToolInputs * 12 - highToolCountPenalty + Math.min(8, metrics.cacheHits * 2));
  const duplicates = duplicateToolInputs(trace.toolCalls ?? []).slice(0, 4);
  return buildCheck({
    id: "tool_efficiency",
    label: "Tool Efficiency",
    category: "efficiency",
    score,
    summary: `${metrics.duplicateToolInputs} 次重复 tool input，${metrics.cacheHits} 次 cache hit，${metrics.toolCalls} 次 tool call。`,
    evidence: [
      `toolCalls=${metrics.toolCalls}`,
      `duplicates=${metrics.duplicateToolInputs}`,
      `cacheHits=${metrics.cacheHits}`,
      ...duplicates
    ],
    recommendation: "重复 query/URL 应走缓存或合并，深查超预算时进入 interrupt。",
    blockAt: 35,
    warnAt: 82
  });
}

function evaluateRuntimeVersioning(
  trace: AgentRuntimeTrace,
  metrics: AgentRunEval["metrics"]
): AgentRunEvalCheck {
  const versionedWorkers = (trace.workerRuns ?? []).filter((worker) => worker.runnerVersion).length;
  const registryNodes = trace.taskGraph?.definitions?.filter((definition) => definition.registry).length ?? 0;
  const versionSignals = [
    versionedWorkers ? "runnerVersion" : "",
    registryNodes ? "registryLink" : "",
    trace.taskGraph?.executorVersion ? "graphExecutorVersion" : "",
    trace.runEval?.version || evalVersion
  ].filter(Boolean).length;
  const score = clamp(
    Math.round(
      (metrics.workerRuns ? (versionedWorkers / metrics.workerRuns) * 40 : 15) +
        (trace.taskGraph?.definitions?.length ? (registryNodes / trace.taskGraph.definitions.length) * 35 : 10) +
        (trace.taskGraph?.executorVersion ? 15 : 0) +
        10
    )
  );
  return buildCheck({
    id: "runtime_versioning",
    label: "Runtime Versioning",
    category: "versioning",
    score,
    summary: `${versionedWorkers}/${metrics.workerRuns} 个 worker 带 runnerVersion，${registryNodes}/${trace.taskGraph?.definitions?.length ?? 0} 个 task definition 带 registry link。`,
    evidence: [
      `versionSignals=${versionSignals}`,
      `executorVersion=${trace.taskGraph?.executorVersion ?? "missing"}`,
      `evalVersion=${evalVersion}`
    ],
    recommendation: "后续补 run manifest，记录 prompt/schema/tool policy/context policy/model/provider 版本。",
    blockAt: 35,
    warnAt: 78
  });
}

function buildCheck(input: BuildCheckInput): AgentRunEvalCheck {
  const score = clamp(Math.round(input.score));
  const blockAt = input.blockAt ?? 50;
  const warnAt = input.warnAt ?? 80;
  return {
    id: input.id,
    label: input.label,
    category: input.category,
    status: score < blockAt ? "block" : score < warnAt ? "warn" : "pass",
    score,
    summary: input.summary,
    evidence: input.evidence.filter(Boolean).slice(0, 10),
    recommendation: input.recommendation
  };
}

function buildSummary({
  status,
  score,
  blockers,
  warnings,
  trace
}: {
  status: AgentRunEvalStatus;
  score: number;
  blockers: string[];
  warnings: string[];
  trace: AgentRuntimeTrace;
}) {
  if (status === "block") {
    return `运行轨迹评分 ${score}/100，存在 ${blockers.length} 个阻断项；当前 trace 状态为 ${trace.status}，报告结论需要降级或恢复后再使用。`;
  }
  if (status === "warn") {
    return `运行轨迹评分 ${score}/100，存在 ${warnings.length} 个告警；可读报告，但应优先复核证据覆盖、边界和恢复能力。`;
  }
  return `运行轨迹评分 ${score}/100，证据路径、边界、工具和恢复账本达到当前 v1 标准。`;
}

function isHighRiskRuntimeTool(tool: AgentRuntimeToolCall) {
  return [
    "web_search",
    "web_fetch",
    "file_read",
    "pdf_extract",
    "ocr",
    "code_execute",
    "github_import",
    "evidence_extract",
    "judge",
    "model_report",
    "follow_up"
  ].includes(tool.toolId);
}

function hasRuntimeBoundary(tool: AgentRuntimeToolCall, trace: AgentRuntimeTrace) {
  if (!tool.workerRunId || !tool.taskNodeId) return false;
  const worker = (trace.workerRuns ?? []).find((run) => run.id === tool.workerRunId);
  if (!worker?.executionBoundary?.contextPackId && !worker?.executionBoundary?.boundaryArtifactId) {
    return false;
  }
  if (worker.executionMode !== "subagent_runner") return false;
  return true;
}

function hasCompletedRoute(trace: AgentRuntimeTrace, kind: AgentTaskNodeKind, keywords: string[]) {
  if (trace.taskGraph?.nodes.length) {
    return trace.taskGraph.nodes.some((node) => node.kind === kind && node.status === "completed");
  }
  const successfulTools = (trace.toolCalls ?? []).filter(
    (tool) => tool.status === "completed" && (tool.outputSummary || tool.artifactIds.length)
  );
  const successfulWorkers = (trace.workerRuns ?? []).filter(
    (worker) => worker.status === "completed" && (worker.outputSummary || worker.artifactIds.length)
  );
  const haystack = [
    ...successfulWorkers.map((worker) => `${worker.workerId} ${worker.workerLabel} ${worker.inputSummary} ${worker.outputSummary ?? ""}`),
    ...successfulTools.map((tool) => `${tool.toolId} ${tool.toolLabel} ${tool.inputSummary} ${tool.outputSummary ?? ""}`)
  ]
    .join("\n")
    .toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function isSearchTaskKind(kind: AgentTaskNodeKind) {
  return (
    kind === "support_search" ||
    kind === "opposition_search" ||
    kind === "freshness_search" ||
    kind === "competitor_search" ||
    kind === "posterior_search"
  );
}

function isTerminalTaskStatus(status: AgentTaskNodeStatus) {
  return status === "completed" || status === "failed" || status === "skipped" || status === "cancelled";
}

function duplicateToolInputs(toolCalls: AgentRuntimeToolCall[]) {
  const counts = new Map<string, number>();
  for (const tool of toolCalls) {
    const key = `${tool.toolId}:${normalizeToolInput(tool.inputSummary)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => `${key} x${count}`);
}

function normalizeToolInput(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 180);
}

function clamp(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
