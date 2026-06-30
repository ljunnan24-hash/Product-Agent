import {
  failDurableWorkerQueueRecord,
  finishDurableWorkerQueueRecord,
  getDurableWorkerQueueRecord,
  markDurableWorkerQueueRunning,
  readDurableWorkerInputPayload,
  requeueDurableWorkerQueueRecord
} from "./durable-worker-queue";
import { AgentRuntimeHarness } from "./agent-runtime";
import { runJudgeAgent } from "./agent-judge";
import {
  runCodeExecutionWithRuntime,
  type CodeExecutionInputFile,
  type CodeExecutionOutputFile
} from "./code-executor";
import {
  generateReportWithRuntime,
  type ReportComposerInput
} from "./report-composer";
import { writeAgentArtifact } from "./storage";
import type {
  DurableWorkerQueueRecord,
  EvidenceBrief,
  EvidenceQueryExecution,
  EvidenceSearchQuery,
  AgentJudgeVerdict,
  AgentRuntimeTrace,
  ProductDiagnosisReport,
  SearchProviderQuality,
  WebEvidence,
  WebResearchSummary,
  WebSearchProvider
} from "./types";
import {
  crawlUrls,
  resolveSearchProvider,
  runQueryBatch,
  type QueryBatchResult
} from "./web-research";
import { supportedWorkerDaemonToolLabels } from "./worker-daemon-capabilities";

export type DurableWorkerReplayResult = {
  status: "applied" | "blocked" | "unsupported" | "skipped";
  record: DurableWorkerQueueRecord;
  summary: string;
  artifactRef?: string;
  output?: DurableWorkerReplayOutput;
};

export type DurableWorkerReplayOutput =
  | {
      kind: "web_search";
      provider: WebSearchProvider;
      queries: EvidenceSearchQuery[];
      searchResults: WebEvidence[];
      queryExecutions: EvidenceQueryExecution[];
      failures: string[];
    }
  | {
      kind: "web_fetch";
      urls: string[];
      crawled: WebEvidence[];
    }
  | {
      kind: "code_execute";
      status: "completed" | "failed" | "blocked" | "cancelled";
      stdout: string;
      stderr: string;
      outputFiles: CodeExecutionOutputFile[];
      summary: string;
      durableQueueRecordId?: string;
      artifactId?: string;
      handoffId?: string;
      runtimeTrace?: AgentRuntimeTrace;
    }
  | {
      kind: "evidence_extract";
      crawled: WebEvidence[];
      searchResults: WebEvidence[];
      queryExecutions: EvidenceQueryExecution[];
      searchQuality: SearchProviderQuality;
      summary: string;
      durableQueueRecordId?: string;
      artifactId?: string;
      handoffId?: string;
      runtimeTrace?: AgentRuntimeTrace;
    }
  | {
      kind: "judge";
      verdict: AgentJudgeVerdict;
      summary: string;
      durableQueueRecordId?: string;
      artifactId?: string;
      handoffId?: string;
      runtimeTrace?: AgentRuntimeTrace;
    }
  | {
      kind: "model_report";
      report: ProductDiagnosisReport;
      summary: string;
      durableQueueRecordId?: string;
      artifactId?: string;
      handoffId?: string;
      runtimeTrace?: AgentRuntimeTrace;
    };

export type EvidenceExtractReplayPayload = {
  kind?: "evidence_extract";
  rootGoal?: string;
  taskNodeId?: string;
  taskLabel?: string;
  inputSummary?: string;
  webResearch?: Pick<
    WebResearchSummary,
    | "crawled"
    | "searchResults"
    | "queryExecutions"
    | "searchQuality"
    | "skippedReasons"
    | "searchProvider"
  >;
  runtimeTrace?: AgentRuntimeTrace;
};

export type JudgeReplayPayload = {
  kind?: "judge";
  rootGoal?: string;
  contextLabel?: string;
  evidenceBrief?: EvidenceBrief;
  webResearch?: WebResearchSummary;
};

export type ReportReplayPayload = Partial<ReportComposerInput> & {
  kind?: "model_report";
  input?: ReportComposerInput;
  rootGoal?: string;
};

type DurableReplayInput = {
  id: string;
  leaseMs?: number;
  runtimeTrace?: AgentRuntimeTrace;
  rootGoal?: string;
};

type SearchReplayPayload = {
  phaseLabel?: string;
  provider?: WebSearchProvider;
  queries?: EvidenceSearchQuery[];
};

type FetchReplayPayload = {
  urls?: string[];
  candidateUrls?: string[];
  searchArtifactId?: string;
};

type CodeReplayPayload = {
  kind?: "code_execute";
  rootGoal?: string;
  taskNodeId?: string;
  taskLabel?: string;
  inputSummary?: string;
  code?: string;
  inputFiles?: CodeExecutionInputFile[];
  timeoutMs?: number;
  maxOutputChars?: number;
};

export async function replayDurableWorkerQueueRecord({
  id,
  leaseMs = 10 * 60 * 1000,
  runtimeTrace,
  rootGoal
}: DurableReplayInput): Promise<DurableWorkerReplayResult> {
  const original = await getDurableWorkerQueueRecord(id);
  if (!original) {
    throw new Error(`没有找到 durable worker queue record：${id}`);
  }
  if (original.status === "completed") {
    return {
      status: "skipped",
      record: original,
      summary: "该 durable worker 已完成；如需重新执行，请先创建新的恢复请求。"
    };
  }
  if (original.status === "cancelled") {
    return {
      status: "skipped",
      record: original,
      summary: "该 durable worker 已取消，不会自动重放。"
    };
  }

  const retryable =
    original.status === "failed" || original.status === "skipped"
      ? await requeueDurableWorkerQueueRecord(id, "durable replay requested")
      : original;
  if (!retryable) {
    throw new Error(`无法准备 durable worker replay：${id}`);
  }

  const leased = await markDurableWorkerQueueRunning({
    id,
    leaseOwner: `replay:${process.pid}`,
    leaseMs
  });
  if (!leased) {
    throw new Error(`无法获取 durable worker lease：${id}`);
  }
  if (leased.status === "cancelled") {
    return {
      status: "skipped",
      record: leased,
      summary: leased.outputSummary || "该 durable worker 已取消。"
    };
  }

  try {
    if (leased.definition.allowedTools.includes("web_search")) {
      return await replaySearchWorker(leased);
    }
    if (leased.definition.allowedTools.includes("web_fetch")) {
      return await replayFetchWorker(leased);
    }
    if (leased.definition.allowedTools.includes("code_execute")) {
      return await replayCodeWorker(leased, {
        runtimeTrace,
        rootGoal
      });
    }
    if (leased.definition.allowedTools.includes("evidence_extract")) {
      return await replayEvidenceExtractWorker(leased, {
        runtimeTrace,
        rootGoal
      });
    }
    if (leased.definition.allowedTools.includes("judge")) {
      return await replayJudgeWorker(leased);
    }
    if (leased.definition.allowedTools.includes("model_report")) {
      return await replayReportWorker(leased);
    }
    const updated = await failDurableWorkerQueueRecord(
      id,
      `暂不支持 replay 工具：${leased.definition.allowedTools.join(", ")}`
    );
    return {
      status: "unsupported",
      record: updated ?? leased,
      summary: `当前 replay executor 只支持 ${supportedWorkerDaemonToolLabels().join("、")}。`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "durable worker replay failed";
    const failed = await failDurableWorkerQueueRecord(id, message);
    return {
      status: "blocked",
      record: failed ?? leased,
      summary: message
    };
  }
}

async function replayReportWorker(record: DurableWorkerQueueRecord): Promise<DurableWorkerReplayResult> {
  const payload = await readDurableWorkerInputPayload<ReportReplayPayload>(record);
  const reportInput = reportReplayInputFromPayload(payload);
  if (!reportInput) {
    const skipped = await finishDurableWorkerQueueRecord(record.id, {
      status: "skipped",
      outputSummary: "durable replay 跳过：缺少 ReportComposerInput、EvidenceBrief 或 WebResearchSummary。",
      metrics: { replayed: true, reportInputMissing: true }
    });
    return {
      status: "skipped",
      record: skipped ?? record,
      summary: "缺少 Report Composer 输入。"
    };
  }

  const reportRun = await generateReportWithRuntime(reportInput);
  const trace = reportRun.webResearch.runtimeTrace;
  const artifactId = latestArtifactId(trace, "model_report");
  const handoffId = trace?.handoffs.slice().reverse().find((handoff) => handoff.from === "report_composer")?.id;
  const updated = await finishDurableWorkerQueueRecord(record.id, {
    status: "completed",
    workerRunId: latestWorkerRunId(trace, "report_composer") ?? record.workerRunId,
    artifactIds: [artifactId].filter((item): item is string => Boolean(item)),
    outputSummary: reportSummary(reportRun.report),
    metrics: {
      replayed: true,
      potentialScore: reportRun.report.potential_score,
      diagnosisScore: reportRun.report.diagnosis_score,
      issueCount: reportRun.report.top_issues.length,
      actionCount: reportRun.report.actionable_suggestions.length
    }
  });
  return {
    status: "applied",
    record: updated ?? record,
    summary: `durable replay 完成：${reportSummary(reportRun.report)}`,
    artifactRef: artifactId,
    output: {
      kind: "model_report",
      report: reportRun.report,
      summary: reportSummary(reportRun.report),
      durableQueueRecordId: record.id,
      artifactId,
      handoffId,
      runtimeTrace: trace
    }
  };
}

async function replayJudgeWorker(record: DurableWorkerQueueRecord): Promise<DurableWorkerReplayResult> {
  const payload = await readDurableWorkerInputPayload<JudgeReplayPayload>(record);
  if (!payload?.evidenceBrief || !payload.webResearch) {
    const skipped = await finishDurableWorkerQueueRecord(record.id, {
      status: "skipped",
      outputSummary: "durable replay 跳过：缺少 EvidenceBrief 或 WebResearchSummary。",
      metrics: { replayed: true, judgeInputMissing: true }
    });
    return {
      status: "skipped",
      record: skipped ?? record,
      summary: "缺少 Judge 输入。"
    };
  }
  const judged = await runJudgeAgent({
    evidenceBrief: payload.evidenceBrief,
    webResearch: payload.webResearch,
    contextLabel: payload.contextLabel ?? "Durable Judge Replay"
  });
  const trace = judged.webResearch.runtimeTrace;
  const artifactId = latestArtifactId(trace, "judge_report");
  const handoffId = trace?.handoffs.slice().reverse().find((handoff) => handoff.from === "judge_agent")?.id;
  const updated = await finishDurableWorkerQueueRecord(record.id, {
    status: "completed",
    workerRunId: latestWorkerRunId(trace, "judge_agent") ?? record.workerRunId,
    artifactIds: [artifactId].filter((item): item is string => Boolean(item)),
    outputSummary: judged.verdict.summary,
    metrics: {
      replayed: true,
      judgeStatus: judged.verdict.status,
      confidenceCap: judged.verdict.confidenceCap,
      reasonCount: judged.verdict.reasons.length,
      allowedDecisions: judged.verdict.allowedDecisions.length
    }
  });
  return {
    status: "applied",
    record: updated ?? record,
    summary: `durable replay 完成：${judged.verdict.summary}`,
    artifactRef: artifactId,
    output: {
      kind: "judge",
      verdict: judged.verdict,
      summary: judged.verdict.summary,
      durableQueueRecordId: record.id,
      artifactId,
      handoffId,
      runtimeTrace: trace
    }
  };
}

function reportReplayInputFromPayload(payload: ReportReplayPayload | null | undefined): ReportComposerInput | null {
  const raw = payload?.input ?? payload;
  if (!raw?.evidenceBrief || !raw.webResearch) return null;
  return {
    productVariant: raw.productVariant ?? "coach",
    brief: raw.brief ?? "",
    materials: raw.materials ?? [],
    webResearch: raw.webResearch,
    evidenceBrief: raw.evidenceBrief,
    calibrationContext: raw.calibrationContext,
    agentTrace: raw.agentTrace ?? [],
    workType: raw.workType ?? "other",
    targetFeeling: raw.targetFeeling ?? "判断这个产品是否值得继续推进。",
    visibleText: raw.visibleText ?? raw.brief ?? "",
    productName: raw.productName ?? "Unknown Product",
    imageMetrics: raw.imageMetrics ?? null
  };
}

function reportSummary(report: ProductDiagnosisReport) {
  return `潜力分 ${report.potential_score}/100，诊断分 ${report.diagnosis_score}/100。`;
}

async function replayEvidenceExtractWorker(
  record: DurableWorkerQueueRecord,
  options: {
    runtimeTrace?: AgentRuntimeTrace;
    rootGoal?: string;
  }
): Promise<DurableWorkerReplayResult> {
  const payload = await readDurableWorkerInputPayload<EvidenceExtractReplayPayload>(record);
  const webResearch = payload?.webResearch;
  const crawled = dedupeWebEvidence(webResearch?.crawled ?? []);
  const searchResults = dedupeWebEvidence(webResearch?.searchResults ?? []);
  const queryExecutions = webResearch?.queryExecutions ?? [];
  if (!crawled.length && !searchResults.length && !queryExecutions.length) {
    const skipped = await finishDurableWorkerQueueRecord(record.id, {
      status: "skipped",
      outputSummary: "durable replay 跳过：没有可压缩的搜索结果、网页正文或 query 执行记录。",
      metrics: { replayed: true, evidenceItems: 0 }
    });
    return {
      status: "skipped",
      record: skipped ?? record,
      summary: "没有可压缩的 evidence_extract 输入。"
    };
  }
  const runtime = payload?.runtimeTrace
    ? AgentRuntimeHarness.fromTrace(payload.runtimeTrace)
    : options.runtimeTrace
      ? AgentRuntimeHarness.fromTrace(options.runtimeTrace)
      : new AgentRuntimeHarness(options.rootGoal ?? payload?.rootGoal ?? `Durable Evidence Extract Replay: ${record.workerLabel}`, record.traceId);
  const taskNodeId = record.taskNodeId ?? payload?.taskNodeId ?? `durable:${record.id}:evidence_extract`;
  const searchQuality = webResearch?.searchQuality ?? fallbackSearchQuality({
    searchProvider: webResearch?.searchProvider,
    searchResults,
    crawled,
    queryExecutions
  });
  runtime.upsertTaskNode({
    id: taskNodeId,
    kind: "evidence_extract",
    label: payload?.taskLabel ?? "Evidence Extract Replay",
    inputSummary: payload?.inputSummary ?? record.inputSummary,
    resumeHint: "从 durable input payload 读取已抓取网页、搜索结果和 query execution 后重建 evidence handoff。"
  });
  const spanId = runtime.startSpan({
    taskNodeId,
    subagent: "evidence_extractor",
    title: "Durable evidence extract replay",
    inputSummary: payload?.inputSummary ?? record.inputSummary
  });
  const evidenceArtifact = await runtime.addArtifact({
    kind: "evidence_cards",
    owner: "evidence_extractor",
    title: "Durable Replayed Research Handoff Evidence",
    summary: `重建 ${crawled.length} 条网页正文、${searchResults.length} 条搜索摘要和 ${queryExecutions.length} 条 query 执行记录。`,
    payload: {
      replayedAt: new Date().toISOString(),
      replaySource: "durable_worker:evidence_extract",
      durableQueueRecordId: record.id,
      taskNodeId,
      crawled,
      searchResults,
      queryExecutions,
      searchQuality
    },
    itemCount: crawled.length + searchResults.length,
    preview: [
      ...crawled.slice(0, 3).map((item) => `正文：${item.title}`),
      ...searchResults.slice(0, 3).map((item) => `摘要：${item.title}`)
    ].join("；")
  });
  const handoff = runtime.createHandoff({
    from: "evidence_extractor",
    to: "main_agent",
    goal: "重建证据压缩交接包，用于恢复 Evidence Brief、Judge 和报告生成。",
    contextSummary: `重建交接：网页正文 ${crawled.length} 条，搜索摘要 ${searchResults.length} 条；搜索质量 ${searchQuality.qualityScore}/100。`,
    artifactIds: [evidenceArtifact.id],
    evidenceRefs: [...crawled, ...searchResults].slice(0, 10).map((item) => item.url || item.title),
    acceptedInputSummary:
      "只接收 durable input payload 中的 searchResults、crawled、queryExecutions 和 searchQuality；不重新联网，不读取隐藏上下文。",
    keyFindings: [
      `网页正文 ${crawled.length} 条，搜索摘要 ${searchResults.length} 条。`,
      `query 执行记录 ${queryExecutions.length} 条，搜索质量 ${searchQuality.qualityScore}/100。`,
      `来源覆盖 ${searchQuality.urlCoverage}%，日期覆盖 ${searchQuality.dateCoverage}%。`
    ],
    openQuestions: [
      ...(webResearch?.skippedReasons ?? []),
      ...searchQuality.warnings
    ].slice(0, 6),
    uncertainties: [
      ...searchQuality.warnings,
      ...(webResearch?.skippedReasons ?? []).map((reason) => `skipped: ${reason}`)
    ].slice(0, 8),
    forbiddenClaims: [
      "不得把 planned/skipped/failed query 当成已执行证据。",
      "不得把搜索摘要当成强行为证据，除非后续有网页正文、实验数据或用户原始材料支持。",
      "不得突破 Evidence Stop、Source Budget 或 Judge confidenceCap。"
    ],
    nextActions: ["重算 Evidence Brief", "重跑 Judge", "刷新报告和质量审计"]
  });
  runtime.completeSpan(spanId, "已通过 durable replay 重建 evidence_extract artifact 和 handoff。", {
    artifactIds: [evidenceArtifact.id],
    handoffId: handoff.id,
    metrics: {
      crawledEvidence: crawled.length,
      searchEvidence: searchResults.length,
      queryExecutions: queryExecutions.length,
      durableReplay: true
    }
  });
  runtime.completeTaskNode(taskNodeId, handoff.contextSummary, {
    artifactIds: [evidenceArtifact.id],
    handoffIds: [handoff.id],
    metrics: {
      crawledEvidence: crawled.length,
      searchEvidence: searchResults.length,
      queryExecutions: queryExecutions.length,
      replayed: true,
      durableReplay: true
    }
  });
  runtime.completeTrace();
  const trace = runtime.getTrace();
  const updated = await finishDurableWorkerQueueRecord(record.id, {
    status: "completed",
    workerRunId: latestWorkerRunId(trace, "evidence_extractor") ?? record.workerRunId,
    artifactIds: [evidenceArtifact.id],
    outputSummary: handoff.contextSummary,
    metrics: {
      replayed: true,
      crawledEvidence: crawled.length,
      searchEvidence: searchResults.length,
      queryExecutions: queryExecutions.length,
      searchQuality: searchQuality.qualityScore
    }
  });
  return {
    status: "applied",
    record: updated ?? record,
    summary: `durable replay 完成：${handoff.contextSummary}`,
    artifactRef: evidenceArtifact.id,
    output: {
      kind: "evidence_extract",
      crawled,
      searchResults,
      queryExecutions,
      searchQuality,
      summary: handoff.contextSummary,
      durableQueueRecordId: record.id,
      artifactId: evidenceArtifact.id,
      handoffId: handoff.id,
      runtimeTrace: trace
    }
  };
}

async function replaySearchWorker(
  record: DurableWorkerQueueRecord
): Promise<DurableWorkerReplayResult> {
  const payload = await readDurableWorkerInputPayload<SearchReplayPayload>(record);
  const queries = Array.isArray(payload?.queries) ? payload.queries : [];
  if (!queries.length) {
    const skipped = await finishDurableWorkerQueueRecord(record.id, {
      status: "skipped",
      outputSummary: "durable replay 跳过：没有可执行 query。",
      metrics: { replayed: true, queryCount: 0 }
    });
    return {
      status: "skipped",
      record: skipped ?? record,
      summary: "没有可执行 query。"
    };
  }

  const config = resolveSearchProvider(payload?.provider);
  const batch = await runQueryBatch(config, queries);
  const artifact = await writeReplayArtifact(record, "search_results", {
    replayedAt: new Date().toISOString(),
    queueRecordId: record.id,
    workerId: record.workerId,
    workerLabel: record.workerLabel,
    inputPayload: payload,
    provider: config.provider,
    results: batch.results,
    executions: batch.executions,
    failures: batch.failures
  });
  const status = statusForSearchReplay(batch);
  const summary =
    status === "completed"
      ? `durable replay 完成：执行 ${queries.length} 条 query，返回 ${batch.results.length} 条候选。`
      : `durable replay 未取得可用搜索结果：执行 ${queries.length} 条 query，失败 ${batch.failures.length} 条。`;
  const updated = await finishDurableWorkerQueueRecord(record.id, {
    status,
    artifactIds: [artifact.artifactId],
    outputArtifactRefs: [artifact.storageRef],
    outputSummary: summary,
    errorMessage: status === "failed" ? batch.failures.slice(0, 3).join("；") || summary : undefined,
    metrics: {
      replayed: true,
      queryCount: queries.length,
      resultCount: batch.results.length,
      failureCount: batch.failures.length,
      provider: config.provider
    }
  });
  return {
    status: status === "failed" ? "blocked" : "applied",
    record: updated ?? record,
    summary,
    artifactRef: artifact.storageRef,
    output: {
      kind: "web_search",
      provider: config.provider,
      queries,
      searchResults: batch.results,
      queryExecutions: batch.executions,
      failures: batch.failures
    }
  };
}

async function replayFetchWorker(
  record: DurableWorkerQueueRecord
): Promise<DurableWorkerReplayResult> {
  const payload = await readDurableWorkerInputPayload<FetchReplayPayload>(record);
  const urls = uniqueStrings([...(payload?.urls ?? []), ...(payload?.candidateUrls ?? [])]);
  if (!urls.length) {
    const skipped = await finishDurableWorkerQueueRecord(record.id, {
      status: "skipped",
      outputSummary: "durable replay 跳过：没有可抓取 URL。",
      metrics: { replayed: true, urlCount: 0 }
    });
    return {
      status: "skipped",
      record: skipped ?? record,
      summary: "没有可抓取 URL。"
    };
  }

  const crawled = await crawlUrls(urls);
  const artifact = await writeReplayArtifact(record, "webpage_snapshot", {
    replayedAt: new Date().toISOString(),
    queueRecordId: record.id,
    workerId: record.workerId,
    workerLabel: record.workerLabel,
    inputPayload: payload,
    urls,
    crawled
  });
  const status = crawled.length ? "completed" : "failed";
  const summary =
    status === "completed"
      ? `durable replay 完成：抓取 ${crawled.length}/${urls.length} 个 URL。`
      : `durable replay 未取得可用正文：0/${urls.length} 个 URL。`;
  const updated = await finishDurableWorkerQueueRecord(record.id, {
    status,
    artifactIds: [artifact.artifactId],
    outputArtifactRefs: [artifact.storageRef],
    outputSummary: summary,
    errorMessage: status === "failed" ? summary : undefined,
    metrics: {
      replayed: true,
      urlCount: urls.length,
      crawledCount: crawled.length
    }
  });
  return {
    status: status === "failed" ? "blocked" : "applied",
    record: updated ?? record,
    summary,
    artifactRef: artifact.storageRef,
    output: {
      kind: "web_fetch",
      urls,
      crawled
    }
  };
}

async function replayCodeWorker(
  record: DurableWorkerQueueRecord,
  options: {
    runtimeTrace?: AgentRuntimeTrace;
    rootGoal?: string;
  }
): Promise<DurableWorkerReplayResult> {
  const payload = await readDurableWorkerInputPayload<CodeReplayPayload>(record);
  const code = typeof payload?.code === "string" ? payload.code : "";
  if (!code.trim()) {
    const skipped = await finishDurableWorkerQueueRecord(record.id, {
      status: "skipped",
      outputSummary: "durable replay 跳过：没有可执行代码。",
      metrics: { replayed: true, codeChars: 0 }
    });
    return {
      status: "skipped",
      record: skipped ?? record,
      summary: "没有可执行代码。"
    };
  }

  const result = await runCodeExecutionWithRuntime({
    runtimeTrace: options.runtimeTrace,
    rootGoal: options.rootGoal ?? payload?.rootGoal ?? `Durable Code Replay: ${record.workerLabel}`,
    traceId: record.traceId,
    taskNodeId: record.taskNodeId ?? payload?.taskNodeId ?? `durable:${record.id}:code_execute`,
    taskLabel: payload?.taskLabel ?? "代码执行重放",
    inputSummary: payload?.inputSummary ?? record.inputSummary,
    code,
    inputFiles: Array.isArray(payload?.inputFiles) ? payload.inputFiles : [],
    timeoutMs: payload?.timeoutMs,
    maxOutputChars: payload?.maxOutputChars,
    durableQueue: false
  });
  const status = result.status === "completed" ? "completed" : "failed";
  const updated = await finishDurableWorkerQueueRecord(record.id, {
    status,
    workerRunId: latestWorkerRunId(result.runtimeTrace, "code_executor") ?? record.workerRunId,
    artifactIds: [result.artifactId].filter((item): item is string => Boolean(item)),
    outputSummary: result.summary,
    errorMessage: status === "failed" ? result.stderr || result.summary : undefined,
    metrics: {
      replayed: true,
      codeChars: code.length,
      inputFiles: Array.isArray(payload?.inputFiles) ? payload.inputFiles.length : 0,
      outputFiles: result.outputFiles.length,
      codeStatus: result.status
    }
  });
  return {
    status: status === "completed" ? "applied" : "blocked",
    record: updated ?? record,
    summary:
      status === "completed"
        ? `durable replay 完成：${result.summary}`
        : `durable replay 阻断/失败：${result.summary}`,
    artifactRef: result.artifactId,
    output: {
      kind: "code_execute",
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      outputFiles: result.outputFiles,
      summary: result.summary,
      durableQueueRecordId: record.id,
      artifactId: result.artifactId,
      handoffId: result.handoffId,
      runtimeTrace: result.runtimeTrace
    }
  };
}

async function writeReplayArtifact(
  record: DurableWorkerQueueRecord,
  kind: string,
  payload: unknown
) {
  const artifactId = `durable-replay-${crypto.randomUUID()}`;
  const persisted = await writeAgentArtifact({
    traceId: record.traceId,
    artifactId,
    payload: {
      kind,
      durableQueueRecordId: record.id,
      payload
    }
  });
  return {
    artifactId,
    storageRef: persisted.storageRef
  };
}

function statusForSearchReplay(batch: QueryBatchResult) {
  if (batch.results.length) return "completed";
  if (batch.executions.length && batch.executions.every((item) => item.status === "skipped")) {
    return "failed";
  }
  return batch.failures.length ? "failed" : "skipped";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dedupeWebEvidence(items: WebEvidence[]) {
  const seen = new Set<string>();
  const result: WebEvidence[] = [];
  for (const item of items) {
    const key = item.url || `${item.title}:${item.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function fallbackSearchQuality(input: {
  searchProvider?: WebSearchProvider;
  searchResults: WebEvidence[];
  crawled: WebEvidence[];
  queryExecutions: EvidenceQueryExecution[];
}): SearchProviderQuality {
  const results = [...input.searchResults, ...input.crawled];
  const plannedQueries = input.queryExecutions.length;
  const executedQueries = input.queryExecutions.filter((item) => item.status === "executed").length;
  const failedQueries = input.queryExecutions.filter((item) => item.status === "failed").length;
  const skippedQueries = input.queryExecutions.filter((item) => item.status === "skipped").length;
  const completedQueries = input.queryExecutions.filter((item) => item.resultCount > 0).length;
  const totalResults = results.length;
  const urlCoverage = percent(results.filter((item) => item.url).length, totalResults);
  const dateCoverage = percent(results.filter((item) => item.publishedAt || item.updatedAt).length, totalResults);
  const freshResultRatio = percent(
    results.filter((item) => item.recencyBucket === "fresh" || item.recencyBucket === "usable").length,
    totalResults
  );
  const oppositionResultRatio = percent(
    results.filter((item) => item.searchTarget === "opposition" || item.searchIntent === "opposition").length,
    totalResults
  );
  const assumptionCoverage = percent(new Set(results.map((item) => item.assumptionId).filter(Boolean)).size, 5);
  const averageSnippetLength = Math.round(
    results.length
      ? results.reduce((sum, item) => sum + (item.snippet || "").length, 0) / results.length
      : 0
  );
  const querySuccessRate = percent(executedQueries, completedQueries || plannedQueries);
  const qualityScore = Math.round(
    querySuccessRate * 0.2 +
      urlCoverage * 0.18 +
      dateCoverage * 0.16 +
      assumptionCoverage * 0.14 +
      oppositionResultRatio * 0.12 +
      freshResultRatio * 0.1 +
      Math.min(100, Math.round((averageSnippetLength / 240) * 100)) * 0.1
  );
  return {
    provider: input.searchProvider ?? "zhipu",
    qualityScore,
    plannedQueries,
    executedQueries,
    failedQueries,
    skippedQueries,
    totalResults,
    querySuccessRate,
    urlCoverage,
    dateCoverage,
    freshResultRatio,
    oppositionResultRatio,
    assumptionCoverage,
    averageSnippetLength,
    warnings: ["本次 durable evidence_extract replay 使用 fallback searchQuality；建议上游搜索完成后刷新。"]
  };
}

function percent(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function latestWorkerRunId(trace: AgentRuntimeTrace | undefined, subagent: string) {
  return trace?.workerRuns
    ?.slice()
    .reverse()
    .find((run) => run.subagent === subagent)?.id;
}

function latestArtifactId(trace: AgentRuntimeTrace | undefined, kind: string) {
  return trace?.artifacts
    .slice()
    .reverse()
    .find((artifact) => artifact.kind === kind)?.id;
}
