import type {
  AgentRetryTarget,
  AgentRuntimeResumeImpact,
  AgentRuntimeResumeAction,
  AgentRuntimeResumeRequest,
  AgentRuntimeTrace,
  AgentTaskGraphNode,
  AnalysisRecord,
  WebEvidence,
  WebResearchSummary
} from "./types";
import { AgentRuntimeHarness } from "./agent-runtime";
import { runJudgeAgent } from "./agent-judge";
import { modelName } from "./deepseek";
import {
  applyExperimentResultToEvidenceBrief,
  generateEvidenceBrief
} from "./evidence-agent";
import {
  codeExecutionResultToExperimentArtifact,
  mergeCodeExecutionArtifactIntoExperimentResult
} from "./experiment-code-evidence";
import { listDurableWorkerQueueRecords } from "./durable-worker-queue";
import {
  replayDurableWorkerQueueRecord,
  type DurableWorkerReplayOutput
} from "./durable-worker-replay";
import { buildReportEvidenceBindings } from "./report-evidence-binding";
import { generateReportWithRuntime } from "./report-composer";
import { attachReportQualityToTrace, evaluateReportQuality } from "./report-quality";

export type RuntimeResumeInput = {
  targetId: string;
  action: AgentRuntimeResumeAction;
  note?: string;
};

export type RuntimeResumeResult = {
  record: AnalysisRecord;
  request: AgentRuntimeResumeRequest;
};

type RuntimeReplayPlan =
  | {
      kind: "judge_and_report";
      reason: string;
    }
  | {
      kind: "report_only";
      reason: string;
    }
  | {
      kind: "unsupported";
      reason: string;
      limitations: string[];
    };

type LocalRefreshPlan = {
  strategy: NonNullable<AgentRuntimeResumeImpact["localRefreshStrategy"]>;
  recomputed: AgentRuntimeResumeImpact["recomputed"];
  downstreamTaskNodeIds: string[];
  staleTaskNodeIds: string[];
  summary: string;
  limitations: string[];
};

export function createRuntimeResumeRequest(
  record: AnalysisRecord,
  input: RuntimeResumeInput
): RuntimeResumeResult {
  const trace = record.webResearch?.runtimeTrace;
  if (!trace) {
    throw new Error("当前分析没有 runtime trace，无法创建节点恢复请求。");
  }
  const target = findResumeTarget(trace, input.targetId);
  if (!target) {
    throw new Error(`没有找到可恢复目标：${input.targetId}`);
  }

  const now = new Date().toISOString();
  const request = buildResumeRequest({
    trace,
    target,
    action: input.action,
    note: input.note,
    now
  });
  const nextTrace: AgentRuntimeTrace = {
    ...trace,
    updatedAt: now,
    resumeRequests: [...(trace.resumeRequests ?? []), request].slice(-80)
  };

  return {
    request,
    record: {
      ...record,
      updatedAt: now,
      webResearch: record.webResearch
        ? {
            ...record.webResearch,
            runtimeTrace: nextTrace
          }
        : record.webResearch
    }
  };
}

export async function runRuntimeResume(
  record: AnalysisRecord,
  input: RuntimeResumeInput
): Promise<RuntimeResumeResult> {
  const created = createRuntimeResumeRequest(record, input);
  const request = created.request;
  if (input.action !== "queue_retry" || request.status !== "queued") {
    return created;
  }

  const durableReplay = await tryReplayDurableWorker(created.record, request);
  if (durableReplay) {
    return durableReplay;
  }

  const durableTaskReplay = await tryReplayDurableTaskNode(created.record, request);
  if (durableTaskReplay) {
    return durableTaskReplay;
  }

  const evidenceExtractReplay = await tryReplayEvidenceExtract(created.record, request);
  if (evidenceExtractReplay) {
    return evidenceExtractReplay;
  }

  const replayPlan = planRuntimeReplay(created.record, request);
  if (replayPlan.kind === "unsupported") {
    const unsupportedRequest: AgentRuntimeResumeRequest = {
      ...request,
      status: "unsupported",
      executionMode: "auto_replay",
      updatedAt: new Date().toISOString(),
      resultSummary: replayPlan.reason,
      limitations: replayPlan.limitations
    };
    return {
      request: unsupportedRequest,
      record: replaceResumeRequest(created.record, unsupportedRequest)
    };
  }

  try {
    const replayed = await replayTerminalRuntimeNode(created.record, replayPlan);
    const appliedRequest: AgentRuntimeResumeRequest = {
      ...request,
      status: "applied",
      executionMode: "auto_replay",
      updatedAt: new Date().toISOString(),
      resultSummary:
        replayPlan.kind === "judge_and_report"
          ? "已重跑 Judge Agent、Report Composer 和质量审计；网页调研结果复用原有 evidence/artifact。"
          : "已重跑 Report Composer 和质量审计；网页调研与 Judge verdict 复用原有结果。",
      limitations: [
        "本次第一版 replay 只覆盖 Judge/Report 末端节点。",
        "搜索、抓取和证据抽取节点仍需 durable queue 与工具原始输入重构才能真正局部重放。"
      ],
      impact: buildResumeImpact({
        request,
        replayScope: "terminal",
        sourceTaskNodeId: request.taskNodeId ?? taskNodeIdFromRequest(request),
        replayedTaskNodeIds:
          replayPlan.kind === "judge_and_report" ? ["judge", "report"] : ["report"],
        artifactIds: request.artifactIds,
        recomputed:
          replayPlan.kind === "judge_and_report"
            ? ["judge", "report", "report_evidence_bindings", "report_quality"]
            : ["report", "report_evidence_bindings", "report_quality"],
        notes: [replayPlan.reason]
      })
    };
    return {
      request: appliedRequest,
      record: replaceResumeRequest(replayed, appliedRequest)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "runtime resume failed");
    const blockedRequest: AgentRuntimeResumeRequest = {
      ...request,
      status: "blocked",
      executionMode: "auto_replay",
      updatedAt: new Date().toISOString(),
      resultSummary: `自动恢复失败：${message}`,
      limitations: [
        "恢复请求已保存，但自动 replay 没有成功。",
        "可以查看最新 worker/tool trace，修复配置或材料后再次触发。"
      ]
    };
    return {
      request: blockedRequest,
      record: replaceResumeRequest(created.record, blockedRequest)
    };
  }
}

async function tryReplayDurableWorker(
  record: AnalysisRecord,
  request: AgentRuntimeResumeRequest
): Promise<RuntimeResumeResult | null> {
  const traceId = record.webResearch?.runtimeTrace?.id;
  if (!traceId || !request.workerRunId) return null;
  const durableRecords = await listDurableWorkerQueueRecords({ traceId, limit: 400 });
  const durableRecord = durableRecords.find(
    (item) =>
      item.workerRunId === request.workerRunId ||
      item.queueItemId === request.targetId ||
      item.id === request.targetId
  );
  if (!durableRecord) return null;

  const replay = await replayDurableWorkerQueueRecord({
    id: durableRecord.id,
    runtimeTrace: record.webResearch?.runtimeTrace,
    rootGoal: `Runtime Resume: ${record.productName || record.id}`
  });
  const status =
    replay.status === "applied" || replay.status === "skipped"
      ? "applied"
      : replay.status === "unsupported"
        ? "unsupported"
        : "blocked";
  const downstreamRecord =
    replay.status === "applied" && replay.output
      ? await refreshRecordAfterDurableReplays(record, [replay.output])
      : record;
  const refreshed = downstreamRecord !== record;
  const recomputed = replay.output ? recomputedForReplayOutputs([replay.output], record) : [];
  const replayedRequest: AgentRuntimeResumeRequest = {
    ...request,
    status,
    executionMode: "auto_replay",
    updatedAt: new Date().toISOString(),
    artifactIds: [...new Set([...request.artifactIds, ...(replay.record.artifactIds ?? [])])],
    resultSummary: refreshed && replay.output
      ? `${replay.summary} ${localRefreshPlanForReplayOutputs([replay.output], record).summary}`
      : replay.summary,
    limitations: [
      refreshed && replay.output
        ? localRefreshPlanForReplayOutputs([replay.output], record).limitations.join(" ")
        : "已执行 durable worker replay；本次没有可合并的结构化输出。",
      "local refresh v2 会优先刷新 replay 对应 artifact/task node；未重算的下游节点会标记为 stale。",
      replay.artifactRef ? `输出 artifact: ${replay.artifactRef}` : ""
    ].filter(Boolean),
    impact: buildResumeImpact({
      request,
      replayScope: "worker",
      sourceTaskNodeId: replay.record.taskNodeId ?? request.taskNodeId,
      replayedTaskNodeIds: [replay.record.taskNodeId ?? request.taskNodeId].filter(Boolean),
      replayedWorkerRunIds: [replay.record.workerRunId ?? request.workerRunId].filter(Boolean),
      durableQueueRecordIds: [replay.record.id],
      artifactIds: [...new Set([...(request.artifactIds ?? []), ...(replay.record.artifactIds ?? [])])],
      recomputed: refreshed ? recomputed : [],
      staleTaskNodeIds: replay.output ? localRefreshPlanForReplayOutputs([replay.output], record).staleTaskNodeIds : [],
      downstreamTaskNodeIds: replay.output ? localRefreshPlanForReplayOutputs([replay.output], record).downstreamTaskNodeIds : undefined,
      localRefreshStrategy: replay.output ? localRefreshPlanForReplayOutputs([replay.output], record).strategy : undefined,
      notes: [
        replay.summary,
        refreshed && replay.output
          ? `local refresh strategy: ${localRefreshPlanForReplayOutputs([replay.output], record).strategy}`
          : "no structured replay output merged"
      ]
    })
  };
  return {
    request: replayedRequest,
    record: replaceResumeRequest(downstreamRecord, replayedRequest)
  };
}

async function tryReplayDurableTaskNode(
  record: AnalysisRecord,
  request: AgentRuntimeResumeRequest
): Promise<RuntimeResumeResult | null> {
  const traceId = record.webResearch?.runtimeTrace?.id;
  const taskNodeId = request.taskNodeId ?? taskNodeIdFromRequest(request);
  if (!traceId || !taskNodeId) return null;
  const durableRecords = await listDurableWorkerQueueRecords({ traceId, limit: 500 });
  const replayableRecords = durableRecords
    .filter((item) => item.taskNodeId === taskNodeId)
    .filter((item) => item.status === "queued" || item.status === "failed" || item.status === "skipped")
    .sort(durableRecordReplaySort)
    .slice(0, 24);
  if (!replayableRecords.length) return null;

  const replays = [];
  for (const durableRecord of replayableRecords) {
    replays.push(await replayDurableWorkerQueueRecord({
      id: durableRecord.id,
      runtimeTrace: record.webResearch?.runtimeTrace,
      rootGoal: `Runtime Resume: ${record.productName || record.id}`
    }));
  }

  const outputs = replays
    .map((replay) => replay.output)
    .filter((output): output is DurableWorkerReplayOutput => Boolean(output));
  const downstreamRecord = outputs.length
    ? await refreshRecordAfterDurableReplays(record, outputs)
    : record;
  const refreshed = downstreamRecord !== record;
  const recomputed = recomputedForReplayOutputs(outputs, record);
  const status = statusForDurableTaskReplay(replays);
  const artifactIds = [
    ...request.artifactIds,
    ...replays.flatMap((replay) => replay.record.artifactIds ?? [])
  ];
  const appliedCount = replays.filter((replay) => replay.status === "applied").length;
  const skippedCount = replays.filter((replay) => replay.status === "skipped").length;
  const blockedCount = replays.filter((replay) => replay.status === "blocked").length;
  const unsupportedCount = replays.filter((replay) => replay.status === "unsupported").length;
  const replayedRequest: AgentRuntimeResumeRequest = {
    ...request,
    status,
    executionMode: "auto_replay",
    updatedAt: new Date().toISOString(),
    artifactIds: [...new Set(artifactIds)],
    resultSummary: refreshed
      ? `已重放 task ${taskNodeId} 下 ${replays.length} 个 durable worker：applied ${appliedCount}，skipped ${skippedCount}，blocked ${blockedCount}，unsupported ${unsupportedCount}；${localRefreshPlanForReplayOutputs(outputs, record).summary}`
      : `已处理 task ${taskNodeId} 下 ${replays.length} 个 durable worker：applied ${appliedCount}，skipped ${skippedCount}，blocked ${blockedCount}，unsupported ${unsupportedCount}。`,
    limitations: [
      outputs.length
        ? localRefreshPlanForReplayOutputs(outputs, record).limitations.join(" ")
        : "本次 task node replay 没有产生可合并的结构化输出。",
      blockedCount ? `${blockedCount} 个 worker replay blocked，需要查看 durable queue record。` : "",
      unsupportedCount ? `${unsupportedCount} 个 worker 暂不支持 durable replay。` : "",
      "local refresh v2 会优先刷新 replay 对应 artifact/task node，并把未重算下游标记为 stale。"
    ].filter(Boolean),
    impact: buildResumeImpact({
      request,
      replayScope: "task_node",
      sourceTaskNodeId: taskNodeId,
      replayedTaskNodeIds: [taskNodeId],
      replayedWorkerRunIds: replays.map((replay) => replay.record.workerRunId).filter(Boolean),
      durableQueueRecordIds: replays.map((replay) => replay.record.id),
      artifactIds: [...new Set(artifactIds)],
      recomputed: outputs.length ? recomputed : [],
      staleTaskNodeIds: outputs.length ? localRefreshPlanForReplayOutputs(outputs, record).staleTaskNodeIds : [],
      downstreamTaskNodeIds: outputs.length ? localRefreshPlanForReplayOutputs(outputs, record).downstreamTaskNodeIds : undefined,
      localRefreshStrategy: outputs.length ? localRefreshPlanForReplayOutputs(outputs, record).strategy : undefined,
      notes: [
        `durable workers replayed: ${replays.length}`,
        `applied=${appliedCount}, skipped=${skippedCount}, blocked=${blockedCount}, unsupported=${unsupportedCount}`,
        outputs.length ? `local refresh strategy: ${localRefreshPlanForReplayOutputs(outputs, record).strategy}` : ""
      ]
    })
  };

  return {
    request: replayedRequest,
    record: replaceResumeRequest(downstreamRecord, replayedRequest)
  };
}

async function refreshRecordAfterDurableReplays(
  record: AnalysisRecord,
  outputs: DurableWorkerReplayOutput[]
): Promise<AnalysisRecord> {
  if (!record.webResearch) return record;
  const refreshPlan = localRefreshPlanForReplayOutputs(outputs, record);
  const webResearch = outputs.reduce(
    (current, output) => mergeReplayOutputIntoWebResearch(current, output),
    record.webResearch
  );
  const codeOutputs = outputs.filter(
    (output): output is Extract<DurableWorkerReplayOutput, { kind: "code_execute" }> =>
      output.kind === "code_execute"
  );
  const reportOutputs = outputs.filter(
    (output): output is Extract<DurableWorkerReplayOutput, { kind: "model_report" }> =>
      output.kind === "model_report"
  );
  const hasWebEvidenceOutput = outputs.some(
    (output) => output.kind === "web_search" || output.kind === "web_fetch"
  );
  const hasEvidenceExtractOutput = outputs.some((output) => output.kind === "evidence_extract");
  const hasJudgeOutput = outputs.some((output) => output.kind === "judge");
  const judgeOutputs = outputs.filter(
    (output): output is Extract<DurableWorkerReplayOutput, { kind: "judge" }> =>
      output.kind === "judge"
  );
  let nextRecord: AnalysisRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    webResearch
  };
  if (hasWebEvidenceOutput && refreshPlan.strategy === "artifact_only") {
    nextRecord = {
      ...nextRecord,
      webResearch: markReplayStaleTaskNodes(webResearch, refreshPlan)
    };
  } else if (hasEvidenceExtractOutput) {
    nextRecord = await refreshRecordWithWebResearch(
      nextRecord,
      webResearch,
      "Evidence Extract Durable Replay"
    );
  } else if (hasJudgeOutput) {
    nextRecord = await refreshRecordWithJudgeOutput(
      nextRecord,
      webResearch,
      judgeOutputs[judgeOutputs.length - 1]
    );
  }
  if (codeOutputs.length) {
    nextRecord = refreshRecordWithCodeExecutionOutputs(nextRecord, codeOutputs);
  }
  if (reportOutputs.length) {
    nextRecord = refreshRecordWithModelReportOutput(nextRecord, reportOutputs[reportOutputs.length - 1]);
  }
  if (!hasWebEvidenceOutput && !hasEvidenceExtractOutput && !hasJudgeOutput && !codeOutputs.length && !reportOutputs.length) {
    nextRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
      webResearch
    };
  }
  return nextRecord;
}

function localRefreshPlanForReplayOutputs(
  outputs: DurableWorkerReplayOutput[],
  record: AnalysisRecord
): LocalRefreshPlan {
  const hasWebOutput = outputs.some((output) => output.kind === "web_search" || output.kind === "web_fetch");
  const hasEvidenceExtract = outputs.some((output) => output.kind === "evidence_extract");
  const hasJudge = outputs.some((output) => output.kind === "judge");
  const hasReport = outputs.some((output) => output.kind === "model_report");
  const hasCode = outputs.some((output) => output.kind === "code_execute");
  if (hasEvidenceExtract) {
    return {
      strategy: "full_downstream",
      recomputed: [
        "evidence_handoff",
        "evidence_brief",
        "judge",
        "report",
        "report_evidence_bindings",
        "report_quality"
      ],
      downstreamTaskNodeIds: ["judge", "report"],
      staleTaskNodeIds: [],
      summary: "已刷新 evidence_extract artifact、Evidence Brief、Judge、Report 和质量审计。",
      limitations: [
        "本次只从 evidence_extract 节点向下刷新；未重新执行 search/fetch。",
        "如果上游网页证据刚变化，应先重放 search/fetch，再重放 evidence_extract。"
      ]
    };
  }
  if (hasWebOutput) {
    return {
      strategy: "artifact_only",
      recomputed: ["web_research"],
      downstreamTaskNodeIds: [],
      staleTaskNodeIds: ["evidence_extract", "judge", "report"],
      summary:
        "已合并网页搜索/抓取 replay 输出到 WebResearch 和 runtime artifact；Evidence Brief/Judge/Report 未自动重算，已标记为需要后续局部刷新。",
      limitations: [
        "search/fetch replay 只刷新网页证据层，避免自动改写判断和报告。",
        "下一步应重放 evidence_extract task node，再由证据层向下刷新 Judge/Report。"
      ]
    };
  }
  if (hasJudge) {
    return {
      strategy: "partial_downstream",
      recomputed: ["judge", "report", "report_evidence_bindings", "report_quality"],
      downstreamTaskNodeIds: ["report"],
      staleTaskNodeIds: [],
      summary: "已应用 Judge replay 输出，并只刷新 Report Composer、证据绑定和质量审计。",
      limitations: ["本次复用现有 Evidence Brief，不重算网页证据或 Evidence Brief。"]
    };
  }
  if (hasReport) {
    return {
      strategy: "terminal_only",
      recomputed: ["report", "report_evidence_bindings", "report_quality"],
      downstreamTaskNodeIds: [],
      staleTaskNodeIds: [],
      summary: "已应用 Report replay 输出，并刷新证据绑定和质量审计。",
      limitations: ["本次只替换报告 artifact，不重算 Evidence Brief 或 Judge。"]
    };
  }
  if (hasCode) {
    const recomputed: AgentRuntimeResumeImpact["recomputed"] = record.evidenceBrief?.recommendedExperiment.result
      ? ["code_execution", "evidence_brief", "report_evidence_bindings", "report_quality"]
      : ["code_execution"];
    return {
      strategy: "partial_downstream",
      recomputed,
      downstreamTaskNodeIds: [],
      staleTaskNodeIds: record.evidenceBrief?.recommendedExperiment.result ? ["report"] : [],
      summary: record.evidenceBrief?.recommendedExperiment.result
        ? "已刷新代码执行 artifact、实验计算证据、Evidence Brief 派生分和质量审计；报告正文未自动改写。"
        : "已刷新代码执行 trace 和 artifact；当前没有实验结果可映射到 Evidence Brief。",
      limitations: [
        record.evidenceBrief?.recommendedExperiment.result
          ? "代码 replay 只影响实验计算证据和质检，不自动重写模型报告正文。"
          : "当前分析没有可更新的实验结果，因此只刷新代码执行层。"
      ]
    };
  }
  return {
    strategy: "artifact_only",
    recomputed: [],
    downstreamTaskNodeIds: [],
    staleTaskNodeIds: [],
    summary: "没有可合并的结构化 replay 输出。",
    limitations: ["未刷新任何下游派生产物。"]
  };
}

async function tryReplayEvidenceExtract(
  record: AnalysisRecord,
  request: AgentRuntimeResumeRequest
): Promise<RuntimeResumeResult | null> {
  const taskNodeId = request.taskNodeId ?? taskNodeIdFromRequest(request);
  if (!taskNodeId || !isEvidenceExtractTaskNode(taskNodeId) || !record.webResearch?.runtimeTrace) {
    return null;
  }
  const webResearch = await rebuildEvidenceExtractionHandoff(record.webResearch, taskNodeId);
  const downstreamRecord = await refreshRecordWithWebResearch(
    record,
    webResearch,
    "Evidence Extract Replay"
  );
  const appliedRequest: AgentRuntimeResumeRequest = {
    ...request,
    status: "applied",
    executionMode: "auto_replay",
    updatedAt: new Date().toISOString(),
    artifactIds: [
      ...new Set([
        ...request.artifactIds,
        ...(webResearch.runtimeTrace?.artifacts.slice(-2).map((artifact) => artifact.id) ?? [])
      ])
    ],
    resultSummary:
      "已重建 evidence_extract 的 evidence_cards artifact 和 handoff，并刷新 Evidence Brief、Judge、Report 和质量审计。",
    limitations: [
      "本次 evidence_extract replay 复用当前 WebResearchSummary，不重新执行搜索或抓取。",
      "如果上游搜索/抓取证据已经变化，应先恢复对应 search/fetch task node，再恢复 evidence_extract。",
      "local refresh v2 会从 evidence_extract 节点向下刷新，避免 search/fetch replay 直接改写报告。"
    ],
    impact: buildResumeImpact({
      request,
      replayScope: "evidence_extract",
      sourceTaskNodeId: taskNodeId,
      replayedTaskNodeIds: [taskNodeId],
      artifactIds: [
        ...new Set([
          ...request.artifactIds,
          ...(webResearch.runtimeTrace?.artifacts.slice(-2).map((artifact) => artifact.id) ?? [])
        ])
      ],
      recomputed: [
        "evidence_handoff",
        "evidence_brief",
        "judge",
        "report",
        "report_evidence_bindings",
        "report_quality"
      ],
      notes: ["rebuilt evidence_cards artifact and handoff without network access"]
    })
  };

  return {
    request: appliedRequest,
    record: replaceResumeRequest(downstreamRecord, appliedRequest)
  };
}

async function refreshRecordWithWebResearch(
  record: AnalysisRecord,
  webResearch: WebResearchSummary,
  contextLabel: string
): Promise<AnalysisRecord> {
  const evidenceBrief = generateEvidenceBrief({
    brief: record.brief ?? "",
    materials: record.materials ?? [],
    webResearch,
    productName: record.productName || record.evidenceBrief?.productName || "该产品",
    visibleText: record.visibleText || record.brief || "",
    workType: record.workType || "other"
  });
  const judged = await runJudgeAgent({
    evidenceBrief,
    webResearch,
    memoryContext: record.memoryContext,
    contextLabel
  });
  const reportRun = await generateReportWithRuntime({
    productVariant: record.productVariant,
    brief: record.brief ?? "",
    materials: record.materials ?? [],
    webResearch: judged.webResearch,
    evidenceBrief,
    calibrationContext: record.calibrationContext,
    memoryContext: record.memoryContext,
    agentTrace: record.agentTrace ?? [],
    workType: record.workType,
    targetFeeling: record.targetFeeling,
    visibleText: record.visibleText,
    productName: record.productName,
    imageMetrics: record.imageMetrics
  });
  const report = reportRun.report;
  const nextWebResearch = reportRun.webResearch;
  const reportEvidenceBindings = buildReportEvidenceBindings({
    report,
    evidenceBrief
  });
  const reportQualityAudit = evaluateReportQuality({
    report,
    evidenceBrief,
    webResearch: nextWebResearch,
    materials: record.materials ?? [],
    calibrationContext: record.calibrationContext,
    reportEvidenceBindings
  });

  return {
    ...record,
    updatedAt: new Date().toISOString(),
    webResearch: nextWebResearch,
    evidenceBrief,
    report,
    reportEvidenceBindings,
    reportQualityAudit,
    agentTrace: attachReportQualityToTrace(record.agentTrace ?? [], reportQualityAudit),
    model: modelName(),
    errorMessage: null
  };
}

async function refreshRecordWithJudgeOutput(
  record: AnalysisRecord,
  webResearch: WebResearchSummary,
  output: Extract<DurableWorkerReplayOutput, { kind: "judge" }> | undefined
): Promise<AnalysisRecord> {
  if (!output || !record.evidenceBrief || !record.report) {
    return {
      ...record,
      updatedAt: new Date().toISOString(),
      webResearch
    };
  }
  const judgedWebResearch: WebResearchSummary = {
    ...webResearch,
    judgeVerdict: output.verdict
  };
  const reportRun = await generateReportWithRuntime({
    productVariant: record.productVariant,
    brief: record.brief ?? "",
    materials: record.materials ?? [],
    webResearch: judgedWebResearch,
    evidenceBrief: record.evidenceBrief,
    calibrationContext: record.calibrationContext,
    memoryContext: record.memoryContext,
    agentTrace: record.agentTrace ?? [],
    workType: record.workType,
    targetFeeling: record.targetFeeling,
    visibleText: record.visibleText,
    productName: record.productName,
    imageMetrics: record.imageMetrics
  });
  const report = reportRun.report;
  const nextWebResearch = reportRun.webResearch;
  const reportEvidenceBindings = buildReportEvidenceBindings({
    report,
    evidenceBrief: record.evidenceBrief
  });
  const reportQualityAudit = evaluateReportQuality({
    report,
    evidenceBrief: record.evidenceBrief,
    webResearch: nextWebResearch,
    materials: record.materials ?? [],
    calibrationContext: record.calibrationContext,
    reportEvidenceBindings
  });
  return {
    ...record,
    updatedAt: new Date().toISOString(),
    webResearch: nextWebResearch,
    report,
    reportEvidenceBindings,
    reportQualityAudit,
    agentTrace: attachReportQualityToTrace(record.agentTrace ?? [], reportQualityAudit),
    model: modelName(),
    errorMessage: null
  };
}

function markReplayStaleTaskNodes(
  webResearch: WebResearchSummary,
  refreshPlan: LocalRefreshPlan
): WebResearchSummary {
  const trace = webResearch.runtimeTrace;
  if (!trace?.taskGraph || !refreshPlan.staleTaskNodeIds.length) return webResearch;
  const now = new Date().toISOString();
  const staleIds = new Set(refreshPlan.staleTaskNodeIds);
  return {
    ...webResearch,
    runtimeTrace: {
      ...trace,
      updatedAt: now,
      taskGraph: {
        ...trace.taskGraph,
        updatedAt: now,
        executor: trace.taskGraph.executor
          ? {
              ...trace.taskGraph.executor,
              updatedAt: now,
              staleNodeIds: [...new Set([...trace.taskGraph.executor.staleNodeIds, ...refreshPlan.staleTaskNodeIds])],
              warnings: [
                ...trace.taskGraph.executor.warnings,
                "Local refresh v2: web artifact replay updated upstream evidence; replay evidence_extract before trusting Judge/Report."
              ].slice(-12)
            }
          : trace.taskGraph.executor,
        nodes: trace.taskGraph.nodes.map((node) => {
          if (!staleIds.has(node.id)) return node;
          return {
            ...node,
            outputSummary:
              "Stale after local web artifact replay; replay evidence_extract to refresh Evidence Brief/Judge/Report.",
            metrics: {
              ...(node.metrics ?? {}),
              localRefreshState: "stale",
              staleAfterReplayAt: now,
              staleReason: "upstream web_search/web_fetch replay updated WebResearch only"
            }
          };
        })
      }
    }
  };
}

function refreshRecordWithCodeExecutionOutputs(
  record: AnalysisRecord,
  outputs: Array<Extract<DurableWorkerReplayOutput, { kind: "code_execute" }>>
): AnalysisRecord {
  if (!record.evidenceBrief?.recommendedExperiment.result) return record;
  const completedOutputs = outputs.filter((output) => output.status === "completed" && output.stdout.trim());
  if (!completedOutputs.length) return record;
  const latest = completedOutputs[completedOutputs.length - 1];
  const currentResult = record.evidenceBrief.recommendedExperiment.result;
  const artifact = codeExecutionResultToExperimentArtifact({
    id: `code-replay-${latest.durableQueueRecordId || latest.artifactId || Date.now()}`,
    stdout: latest.stdout,
    summary: latest.summary,
    status: latest.status,
    capturedAt: new Date().toISOString(),
    experimentStatus: currentResult.status
  });
  if (!artifact) return record;
  const updatedResult = mergeCodeExecutionArtifactIntoExperimentResult(currentResult, artifact);
  const evidenceBrief = applyExperimentResultToEvidenceBrief(record.evidenceBrief, updatedResult);
  const reportEvidenceBindings = record.report
    ? buildReportEvidenceBindings({
        report: record.report,
        evidenceBrief
      })
    : record.reportEvidenceBindings;
  const reportQualityAudit = record.report
    ? evaluateReportQuality({
        report: record.report,
        evidenceBrief,
        webResearch: record.webResearch,
        materials: record.materials ?? [],
        calibrationContext: record.calibrationContext,
        reportEvidenceBindings
      })
    : record.reportQualityAudit;
  return {
    ...record,
    updatedAt: new Date().toISOString(),
    evidenceBrief,
    reportEvidenceBindings,
    reportQualityAudit,
    agentTrace: reportQualityAudit
      ? attachReportQualityToTrace(record.agentTrace ?? [], reportQualityAudit)
      : record.agentTrace,
    errorMessage: null
  };
}

function refreshRecordWithModelReportOutput(
  record: AnalysisRecord,
  output: Extract<DurableWorkerReplayOutput, { kind: "model_report" }>
): AnalysisRecord {
  const webResearch = record.webResearch
    ? mergeReplayOutputIntoWebResearch(record.webResearch, output)
    : record.webResearch;
  if (!record.evidenceBrief) {
    return {
      ...record,
      updatedAt: new Date().toISOString(),
      webResearch,
      report: output.report,
      model: modelName(),
      errorMessage: null
    };
  }
  const reportEvidenceBindings = buildReportEvidenceBindings({
    report: output.report,
    evidenceBrief: record.evidenceBrief
  });
  const reportQualityAudit = evaluateReportQuality({
    report: output.report,
    evidenceBrief: record.evidenceBrief,
    webResearch,
    materials: record.materials ?? [],
    calibrationContext: record.calibrationContext,
    reportEvidenceBindings
  });
  return {
    ...record,
    updatedAt: new Date().toISOString(),
    webResearch,
    report: output.report,
    reportEvidenceBindings,
    reportQualityAudit,
    agentTrace: attachReportQualityToTrace(record.agentTrace ?? [], reportQualityAudit),
    model: modelName(),
    errorMessage: null
  };
}

async function rebuildEvidenceExtractionHandoff(
  webResearch: WebResearchSummary,
  taskNodeId: string
): Promise<WebResearchSummary> {
  const trace = webResearch.runtimeTrace;
  if (!trace) return webResearch;
  const runtime = AgentRuntimeHarness.fromTrace(trace);
  runtime.upsertTaskNode({
    id: taskNodeId,
    kind: "evidence_extract",
    label: taskNodeId === "evidence_extract" ? "Evidence Extractor" : "Evidence Loop Extractor",
    dependsOn: [],
    inputSummary: "从当前 WebResearchSummary 重建 evidence handoff。",
    resumeHint: "复用当前 searchResults、crawled、queryExecutions 和 searchQuality 重建压缩交接包。"
  });
  const spanId = runtime.startSpan({
    taskNodeId,
    subagent: "evidence_extractor",
    title: "重建证据交接包",
    inputSummary: "复用当前搜索结果、网页正文和 query 执行记录，重建 evidence artifact 与 handoff。"
  });
  const crawled = dedupeWebEvidence(webResearch.crawled ?? []);
  const searchResults = dedupeWebEvidence(webResearch.searchResults ?? []);
  const queryExecutions = webResearch.queryExecutions ?? [];
  const searchQuality = webResearch.searchQuality ?? fallbackSearchQuality(webResearch);
  const evidenceArtifact = await runtime.addArtifact({
    kind: "evidence_cards",
    owner: "evidence_extractor",
    title: "Replayed Research Handoff Evidence",
    summary: `重建 ${crawled.length} 条网页正文、${searchResults.length} 条搜索摘要和 ${queryExecutions.length} 条 query 执行记录。`,
    payload: {
      replayedAt: new Date().toISOString(),
      replaySource: "runtime_resume:evidence_extract",
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
      "只接收当前 WebResearchSummary 中的 searchResults、crawled、queryExecutions 和 searchQuality；不重新联网，不读取隐藏上下文。",
    keyFindings: [
      `网页正文 ${crawled.length} 条，搜索摘要 ${searchResults.length} 条。`,
      `query 执行记录 ${queryExecutions.length} 条，搜索质量 ${searchQuality.qualityScore}/100。`,
      `来源覆盖 ${searchQuality.urlCoverage}%，日期覆盖 ${searchQuality.dateCoverage}%。`
    ],
    openQuestions: [
      ...(webResearch.skippedReasons ?? []),
      ...searchQuality.warnings
    ].slice(0, 6),
    uncertainties: [
      ...searchQuality.warnings,
      ...(webResearch.skippedReasons ?? []).map((reason) => `skipped: ${reason}`)
    ].slice(0, 8),
    forbiddenClaims: [
      "不得把 planned/skipped/failed query 当成已执行证据。",
      "不得把搜索摘要当成强行为证据，除非后续有网页正文、实验数据或用户原始材料支持。",
      "不得突破 Evidence Stop、Source Budget 或 Judge confidenceCap。"
    ],
    nextActions: ["重算 Evidence Brief", "重跑 Judge", "刷新报告和质量审计"]
  });
  runtime.completeSpan(spanId, "已重建 evidence_extract artifact 和 handoff。", {
    artifactIds: [evidenceArtifact.id],
    handoffId: handoff.id,
    metrics: {
      crawledEvidence: crawled.length,
      searchEvidence: searchResults.length,
      queryExecutions: queryExecutions.length
    }
  });
  runtime.completeTaskNode(taskNodeId, handoff.contextSummary, {
    artifactIds: [evidenceArtifact.id],
    handoffIds: [handoff.id],
    metrics: {
      crawledEvidence: crawled.length,
      searchEvidence: searchResults.length,
      queryExecutions: queryExecutions.length,
      replayed: true
    }
  });
  runtime.completeTrace();

  return {
    ...webResearch,
    runtimeTrace: runtime.getTrace()
  };
}

function durableRecordReplaySort(
  a: Awaited<ReturnType<typeof listDurableWorkerQueueRecords>>[number],
  b: Awaited<ReturnType<typeof listDurableWorkerQueueRecords>>[number]
) {
  return (
    a.priority - b.priority ||
    new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime() ||
    a.id.localeCompare(b.id)
  );
}

function statusForDurableTaskReplay(
  replays: Array<Awaited<ReturnType<typeof replayDurableWorkerQueueRecord>>>
): AgentRuntimeResumeRequest["status"] {
  if (replays.some((replay) => replay.status === "blocked")) return "blocked";
  if (replays.some((replay) => replay.status === "applied" || replay.status === "skipped")) {
    return "applied";
  }
  if (replays.some((replay) => replay.status === "unsupported")) return "unsupported";
  return "blocked";
}

function recomputedForReplayOutputs(
  outputs: DurableWorkerReplayOutput[],
  record: AnalysisRecord
): AgentRuntimeResumeImpact["recomputed"] {
  return localRefreshPlanForReplayOutputs(outputs, record).recomputed;
}

function mergeReplayOutputIntoWebResearch(
  webResearch: WebResearchSummary,
  output: DurableWorkerReplayOutput
): WebResearchSummary {
  const now = new Date().toISOString();
  if (output.kind === "web_search") {
    return {
      ...webResearch,
      searchProvider: output.provider,
      searchResults: dedupeWebEvidence([...(webResearch.searchResults ?? []), ...output.searchResults]),
      queries: [
        ...new Set([
          ...(webResearch.queries ?? []),
          ...output.queries.map((query) => query.query)
        ])
      ],
      queryPlan: mergeQueryPlan(webResearch.queryPlan ?? [], output.queries),
      queryExecutions: [
        ...(webResearch.queryExecutions ?? []),
        ...output.queryExecutions
      ],
      skippedReasons: [
        ...(webResearch.skippedReasons ?? []),
        ...output.failures.map((failure) => `durable replay search failure: ${failure}`)
      ],
      runtimeTrace: webResearch.runtimeTrace
        ? {
            ...webResearch.runtimeTrace,
            updatedAt: now
          }
        : webResearch.runtimeTrace
    };
  }

  if (output.kind === "code_execute") {
    return {
      ...webResearch,
      runtimeTrace: output.runtimeTrace
        ? {
            ...output.runtimeTrace,
            updatedAt: now
          }
        : webResearch.runtimeTrace
          ? {
              ...webResearch.runtimeTrace,
              updatedAt: now
            }
          : webResearch.runtimeTrace
    };
  }

  if (output.kind === "evidence_extract") {
    return {
      ...webResearch,
      crawled: dedupeWebEvidence([...(webResearch.crawled ?? []), ...output.crawled]),
      searchResults: dedupeWebEvidence([...(webResearch.searchResults ?? []), ...output.searchResults]),
      queryExecutions: [
        ...(webResearch.queryExecutions ?? []),
        ...output.queryExecutions
      ],
      searchQuality: output.searchQuality,
      runtimeTrace: output.runtimeTrace
        ? {
            ...output.runtimeTrace,
            updatedAt: now
          }
        : webResearch.runtimeTrace
          ? {
              ...webResearch.runtimeTrace,
              updatedAt: now
            }
          : webResearch.runtimeTrace
    };
  }

  if (output.kind === "judge") {
    return {
      ...webResearch,
      judgeVerdict: output.verdict,
      runtimeTrace: output.runtimeTrace
        ? {
            ...output.runtimeTrace,
            updatedAt: now
          }
        : webResearch.runtimeTrace
          ? {
              ...webResearch.runtimeTrace,
              updatedAt: now
            }
          : webResearch.runtimeTrace
    };
  }

  if (output.kind === "model_report") {
    return {
      ...webResearch,
      runtimeTrace: output.runtimeTrace
        ? {
            ...output.runtimeTrace,
            updatedAt: now
          }
        : webResearch.runtimeTrace
          ? {
              ...webResearch.runtimeTrace,
              updatedAt: now
            }
          : webResearch.runtimeTrace
    };
  }

  return {
    ...webResearch,
    crawled: dedupeWebEvidence([...(webResearch.crawled ?? []), ...output.crawled]),
    runtimeTrace: webResearch.runtimeTrace
      ? {
          ...webResearch.runtimeTrace,
          updatedAt: now
        }
      : webResearch.runtimeTrace
  };
}

function mergeQueryPlan(
  existing: NonNullable<WebResearchSummary["queryPlan"]>,
  replayQueries: Extract<DurableWorkerReplayOutput, { kind: "web_search" }>["queries"]
) {
  const byId = new Map(existing.map((query) => [query.id, query]));
  for (const query of replayQueries) {
    byId.set(query.id, byId.get(query.id) ?? query);
  }
  return [...byId.values()];
}

function dedupeWebEvidence(items: WebEvidence[]) {
  const byKey = new Map<string, WebEvidence>();
  for (const item of items) {
    const key = item.url ? normalizedUrl(item.url) : `${item.sourceType}:${item.title}`;
    const existing = byKey.get(key);
    if (!existing || webEvidenceDetailScore(item) > webEvidenceDetailScore(existing)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

function webEvidenceDetailScore(item: WebEvidence) {
  return (
    (item.sourceType === "crawled_url" ? 30 : 0) +
    (item.sourceType === "github_repository" ? 25 : 0) +
    (item.updatedAt || item.publishedAt ? 10 : 0) +
    Math.min(20, Math.round((item.snippet || "").length / 120))
  );
}

function normalizedUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.delete("utm_source");
    parsed.searchParams.delete("utm_medium");
    parsed.searchParams.delete("utm_campaign");
    return parsed.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function buildResumeImpact({
  request,
  replayScope,
  localRefreshStrategy,
  sourceTaskNodeId,
  replayedTaskNodeIds = [],
  replayedWorkerRunIds = [],
  replayedToolCallIds = [],
  durableQueueRecordIds = [],
  downstreamTaskNodeIds,
  staleTaskNodeIds = [],
  artifactIds = [],
  recomputed = [],
  notes = []
}: {
  request: AgentRuntimeResumeRequest;
  replayScope: AgentRuntimeResumeImpact["replayScope"];
  localRefreshStrategy?: AgentRuntimeResumeImpact["localRefreshStrategy"];
  sourceTaskNodeId?: string;
  replayedTaskNodeIds?: Array<string | undefined>;
  replayedWorkerRunIds?: Array<string | undefined>;
  replayedToolCallIds?: Array<string | undefined>;
  durableQueueRecordIds?: Array<string | undefined>;
  downstreamTaskNodeIds?: Array<string | undefined>;
  staleTaskNodeIds?: Array<string | undefined>;
  artifactIds?: Array<string | undefined>;
  recomputed?: AgentRuntimeResumeImpact["recomputed"];
  notes?: string[];
}): AgentRuntimeResumeImpact {
  const source = sourceTaskNodeId ?? request.taskNodeId ?? taskNodeIdFromRequest(request);
  return {
    replayScope,
    localRefreshStrategy,
    sourceTargetId: request.targetId,
    sourceTaskNodeId: source,
    replayedTaskNodeIds: uniqueStrings(replayedTaskNodeIds),
    replayedWorkerRunIds: uniqueStrings([
      ...replayedWorkerRunIds,
      request.workerRunId
    ]),
    replayedToolCallIds: uniqueStrings([
      ...replayedToolCallIds,
      request.toolCallId
    ]),
    durableQueueRecordIds: uniqueStrings(durableQueueRecordIds),
    downstreamTaskNodeIds: downstreamTaskNodeIds
      ? uniqueStrings(downstreamTaskNodeIds)
      : downstreamTaskNodeIdsFor(source, replayScope),
    staleTaskNodeIds: uniqueStrings(staleTaskNodeIds),
    recomputed: uniqueResumeRecomputed(recomputed),
    artifactIds: uniqueStrings(artifactIds),
    notes: uniqueStrings(notes).slice(0, 8)
  };
}

function downstreamTaskNodeIdsFor(
  sourceTaskNodeId: string | undefined,
  scope: AgentRuntimeResumeImpact["replayScope"]
) {
  if (scope === "control_plane") return [];
  if (scope === "terminal") {
    return sourceTaskNodeId === "judge" ? ["report"] : [];
  }
  if (!sourceTaskNodeId) {
    return scope === "evidence_extract" ? ["judge", "report"] : ["evidence_extract", "judge", "report"];
  }
  if (isEvidenceExtractTaskNode(sourceTaskNodeId)) {
    return ["judge", "report"];
  }
  if (sourceTaskNodeId === "code_execute" || sourceTaskNodeId.endsWith(":code_execute")) {
    return [];
  }
  if (sourceTaskNodeId === "judge") return ["report"];
  if (sourceTaskNodeId === "report") return [];
  const loopPrefix = sourceTaskNodeId.match(/^(loop:\d+):/)?.[1];
  if (loopPrefix) {
    return [`${loopPrefix}:evidence_extract`, "judge", "report"];
  }
  if (
    /search|fetch|material_fetch|posterior/i.test(sourceTaskNodeId) ||
    scope === "worker" ||
    scope === "task_node"
  ) {
    return ["evidence_extract", "judge", "report"];
  }
  return ["judge", "report"];
}

function uniqueResumeRecomputed(
  values: AgentRuntimeResumeImpact["recomputed"]
): AgentRuntimeResumeImpact["recomputed"] {
  return [...new Set(values)];
}

function isEvidenceExtractTaskNode(taskNodeId: string) {
  return taskNodeId === "evidence_extract" || taskNodeId.endsWith(":evidence_extract");
}

function fallbackSearchQuality(webResearch: WebResearchSummary): NonNullable<WebResearchSummary["searchQuality"]> {
  const queryPlan = webResearch.queryPlan ?? [];
  const queryExecutions = webResearch.queryExecutions ?? [];
  const results = [...(webResearch.searchResults ?? []), ...(webResearch.crawled ?? [])];
  const plannedQueries = queryPlan.length;
  const executedQueries = queryExecutions.filter((item) => item.status === "executed").length;
  const failedQueries = queryExecutions.filter((item) => item.status === "failed").length;
  const skippedQueries = queryExecutions.filter((item) => item.status === "skipped").length;
  const completedQueries = executedQueries + failedQueries;
  const totalResults = results.length;
  const urlCoverage = percent(results.filter((item) => Boolean(item.url)).length, totalResults);
  const dateCoverage = percent(
    results.filter((item) => Boolean(item.publishedAt || item.updatedAt)).length,
    totalResults
  );
  const freshResultRatio = percent(
    results.filter((item) => item.recencyBucket === "fresh" || item.recencyBucket === "usable").length,
    totalResults
  );
  const oppositionResultRatio = percent(
    results.filter((item) => item.searchTarget === "opposition" || item.searchIntent === "opposition").length,
    Math.max(1, totalResults)
  );
  const assumptionCoverage = percent(
    new Set(results.map((item) => item.assumptionId).filter(Boolean)).size,
    Math.max(1, new Set(queryPlan.map((query) => query.assumptionId).filter(Boolean)).size || 6)
  );
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
    provider: webResearch.searchProvider ?? "zhipu",
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
    warnings: ["本次 evidence_extract replay 使用 fallback searchQuality；建议上游搜索完成后刷新。"]
  };
}

function percent(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

type FoundResumeTarget =
  | {
      source: "retry_target";
      target: AgentRetryTarget;
    }
  | {
      source: "task_node";
      node: AgentTaskGraphNode;
    };

function findResumeTarget(trace: AgentRuntimeTrace, targetId: string): FoundResumeTarget | null {
  const retryTarget = trace.resumePlan?.targets.find((target) => target.id === targetId);
  if (retryTarget) return { source: "retry_target", target: retryTarget };

  const taskNodeId = targetId.startsWith("task:") ? targetId.slice("task:".length) : targetId;
  const taskNode = trace.taskGraph?.nodes.find((node) => node.id === taskNodeId);
  if (taskNode) return { source: "task_node", node: taskNode };

  const worker = trace.workerRuns?.find((run) => run.id === targetId);
  if (worker) {
    const target: AgentRetryTarget = {
      id: `worker:${worker.id}`,
      kind: "worker_run",
      status: worker.status === "failed" ? "failed" : "skipped",
      label: worker.workerLabel,
      reason: worker.errorMessage || worker.outputSummary || worker.inputSummary,
      retryable: worker.status === "failed" || worker.status === "skipped",
      retryAction: "retry_worker",
      requiredFixes: ["复用 worker context pack、artifact refs 和 idempotencyKey 重试。"],
      workerRunId: worker.id,
      failureCode: worker.failureCode,
      parentSpanId: worker.parentSpanId,
      idempotencyKey: worker.idempotencyKey,
      inputArtifactIds: [
        ...(worker.executionBoundary?.inputArtifactIds ?? []),
        worker.executionBoundary?.boundaryArtifactId ?? ""
      ].filter(Boolean),
      outputArtifactIds: worker.artifactIds,
      resumeHint: worker.executionBoundary?.resumeStrategy || "从 worker context pack 恢复。"
    };
    return { source: "retry_target", target };
  }

  const tool = trace.toolCalls?.find((call) => call.id === targetId);
  if (tool) {
    const target: AgentRetryTarget = {
      id: `tool:${tool.id}`,
      kind: "tool_call",
      status: tool.status === "blocked" ? "blocked" : tool.status === "failed" ? "failed" : "skipped",
      label: tool.toolLabel,
      reason: tool.errorMessage || tool.outputSummary || tool.inputSummary,
      retryable: tool.status === "failed" || tool.status === "skipped" || tool.status === "blocked",
      retryAction: "retry_tool",
      requiredFixes: tool.guardrails
        .filter((guardrail) => guardrail.status === "block")
        .map((guardrail) => guardrail.message)
        .slice(0, 4),
      workerRunId: tool.workerRunId,
      toolCallId: tool.id,
      parentSpanId: tool.parentSpanId,
      idempotencyKey: tool.idempotencyKey,
      cacheKey: tool.cacheKey,
      cacheStatus: tool.cacheStatus,
      inputArtifactIds: [],
      outputArtifactIds: tool.artifactIds,
      resumeHint: "复用 tool policy、guardrail 和 cache key 重试工具调用。"
    };
    return { source: "retry_target", target };
  }

  return null;
}

function buildResumeRequest({
  trace,
  target,
  action,
  note,
  now
}: {
  trace: AgentRuntimeTrace;
  target: FoundResumeTarget;
  action: AgentRuntimeResumeAction;
  note?: string;
  now: string;
}): AgentRuntimeResumeRequest {
  if (target.source === "task_node") {
    const retryable =
      target.node.status === "failed" ||
      target.node.status === "skipped" ||
      isInterruptedTaskNode(trace, target.node.id);
    return {
      id: crypto.randomUUID(),
      traceId: trace.id,
      createdAt: now,
      updatedAt: now,
      action,
      status: statusForAction(action, retryable),
      executionMode: "control_plane_only",
      targetId: `task:${target.node.id}`,
      targetKind: "task_node",
      targetStatus: target.node.status,
      label: target.node.label,
      reason: target.node.outputSummary || target.node.inputSummary,
      requestedBy: "user",
      note,
      retryable,
      requiredFixes: retryable
        ? isInterruptedTaskNode(trace, target.node.id)
          ? ["先处理该节点关联的 hard interrupt，再从 task node 恢复或重放下游节点。"]
          : ["下一版 executor 会根据 task node 的 worker/tool/artifact refs 只恢复该节点。"]
        : ["该节点当前不是 failed/skipped，通常不需要恢复。"],
      taskNodeId: target.node.id,
      artifactIds: target.node.artifactIds,
      resultSummary: resultSummaryForAction(action, retryable, "task node"),
      limitations: controlPlaneLimitations(action)
    };
  }

  const retryable = target.target.retryable;
  return {
    id: crypto.randomUUID(),
    traceId: trace.id,
    createdAt: now,
    updatedAt: now,
    action,
    status: statusForAction(action, retryable),
    executionMode: "control_plane_only",
    targetId: target.target.id,
    targetKind: target.target.kind,
    targetStatus: target.target.status,
    label: target.target.label,
    reason: target.target.reason,
    requestedBy: "user",
    note,
    retryAction: target.target.retryAction,
    retryable,
    requiredFixes: target.target.requiredFixes,
    workerRunId: target.target.workerRunId,
    toolCallId: target.target.toolCallId,
    taskNodeId: target.target.parentSpanId
      ? trace.spans.find((span) => span.id === target.target.parentSpanId)?.taskNodeId
      : undefined,
    artifactIds: [...new Set([...target.target.inputArtifactIds, ...target.target.outputArtifactIds])],
    resultSummary: resultSummaryForAction(action, retryable, target.target.kind),
    limitations: controlPlaneLimitations(action)
  };
}

function isInterruptedTaskNode(trace: AgentRuntimeTrace, taskNodeId: string) {
  return (trace.interrupts ?? []).some(
    (interrupt) =>
      interrupt.status === "active" &&
      (interrupt.mode === "hard" || interrupt.blocksRun === true) &&
      (interrupt.taskNodeId === taskNodeId ||
        interrupt.resumeCheckpoint?.taskNodeId === taskNodeId ||
        interrupt.resumeCheckpoint?.relatedTaskNodeIds?.includes(taskNodeId))
  );
}

function statusForAction(action: AgentRuntimeResumeAction, retryable: boolean) {
  if (action === "mark_reviewed") return "applied";
  if (!retryable) return "blocked";
  if (action === "skip_until_configured") return "applied";
  return "queued";
}

function resultSummaryForAction(
  action: AgentRuntimeResumeAction,
  retryable: boolean,
  targetKind: string
) {
  if (action === "mark_reviewed") {
    return "已记录人工复核；不会自动重跑。";
  }
  if (action === "skip_until_configured") {
    return "已记录为等待配置/材料后再恢复。";
  }
  if (!retryable) {
    return `目标 ${targetKind} 当前不可自动排队恢复。`;
  }
  return `已排队恢复请求；当前版本先保存控制面记录，下一步接入自动 replay executor。`;
}

function controlPlaneLimitations(action: AgentRuntimeResumeAction) {
  if (action === "queue_retry") {
    return [
      "当前版本会尝试自动重放 Judge/Report 末端节点。",
      "搜索、抓取和证据抽取仍先进入控制面记录，等待 durable queue 与工具原始输入重构。"
    ];
  }
  return ["该动作只更新恢复账本，不改变历史 trace 状态。"];
}

function planRuntimeReplay(record: AnalysisRecord, request: AgentRuntimeResumeRequest): RuntimeReplayPlan {
  if (!record.evidenceBrief || !record.webResearch) {
    return {
      kind: "unsupported",
      reason: "缺少 Evidence Brief 或 WebResearchSummary，无法重放 runtime 节点。",
      limitations: ["只能对已有完整证据账本的分析执行 runtime replay。"]
    };
  }

  const trace = record.webResearch.runtimeTrace;
  const taskNodeId = request.taskNodeId ?? taskNodeIdFromRequest(request);
  const worker = request.workerRunId
    ? trace?.workerRuns?.find((run) => run.id === request.workerRunId)
    : undefined;
  const tool = request.toolCallId
    ? trace?.toolCalls?.find((call) => call.id === request.toolCallId)
    : undefined;

  if (
    taskNodeId === "judge" ||
    worker?.subagent === "judge_agent" ||
    tool?.toolId === "judge"
  ) {
    return {
      kind: "judge_and_report",
      reason: "Judge 节点可由 Evidence Brief 和 WebResearchSummary 安全重放，并需要刷新下游报告。"
    };
  }

  if (
    taskNodeId === "report" ||
    worker?.subagent === "report_composer" ||
    tool?.toolId === "model_report"
  ) {
    return {
      kind: "report_only",
      reason: "Report Composer 节点可复用 Evidence Brief、Judge verdict 和材料摘要重放。"
    };
  }

  return {
    kind: "unsupported",
    reason: "该目标属于搜索、抓取、证据抽取或其他上游节点，第一版 executor 还不能安全局部重放。",
    limitations: [
      "需要先把运行内 Worker Scheduler 升级为 durable queue，并补齐每个工具的原始输入重构。",
      "当前请求已记录，可先选择“等配置”或全量重跑分析。"
    ]
  };
}

function taskNodeIdFromRequest(request: AgentRuntimeResumeRequest) {
  if (request.targetKind === "task_node") {
    return request.targetId.startsWith("task:") ? request.targetId.slice("task:".length) : request.targetId;
  }
  return undefined;
}

async function replayTerminalRuntimeNode(
  record: AnalysisRecord,
  replayPlan: Extract<RuntimeReplayPlan, { kind: "judge_and_report" | "report_only" }>
) {
  if (!record.evidenceBrief || !record.webResearch) {
    throw new Error("缺少 Evidence Brief 或 WebResearchSummary。");
  }

  let webResearch = record.webResearch;
  if (replayPlan.kind === "judge_and_report") {
    const judged = await runJudgeAgent({
      evidenceBrief: record.evidenceBrief,
      webResearch,
      contextLabel: "Runtime Resume"
    });
    webResearch = judged.webResearch;
  }

  const reportRun = await generateReportWithRuntime({
    productVariant: record.productVariant,
    brief: record.brief ?? "",
    materials: record.materials ?? [],
    webResearch,
    evidenceBrief: record.evidenceBrief,
    calibrationContext: record.calibrationContext,
    agentTrace: record.agentTrace ?? [],
    workType: record.workType,
    targetFeeling: record.targetFeeling,
    visibleText: record.visibleText,
    productName: record.productName,
    imageMetrics: record.imageMetrics
  });

  const report = reportRun.report;
  webResearch = reportRun.webResearch;
  const reportEvidenceBindings = buildReportEvidenceBindings({
    report,
    evidenceBrief: record.evidenceBrief
  });
  const reportQualityAudit = evaluateReportQuality({
    report,
    evidenceBrief: record.evidenceBrief,
    webResearch,
    materials: record.materials ?? [],
    calibrationContext: record.calibrationContext,
    reportEvidenceBindings
  });

  return {
    ...record,
    updatedAt: new Date().toISOString(),
    webResearch,
    report,
    reportQualityAudit,
    reportEvidenceBindings,
    agentTrace: attachReportQualityToTrace(record.agentTrace ?? [], reportQualityAudit),
    model: modelName(),
    errorMessage: null
  };
}

function replaceResumeRequest(
  record: AnalysisRecord,
  request: AgentRuntimeResumeRequest
): AnalysisRecord {
  const trace = record.webResearch?.runtimeTrace;
  if (!trace) return record;
  const requests = trace.resumeRequests ?? [];
  const exists = requests.some((item) => item.id === request.id);
  const nextRequests = exists
    ? requests.map((item) => (item.id === request.id ? request : item))
    : [...requests, request];
  const nextTrace = applyResumeImpactToTrace(
    {
      ...trace,
      updatedAt: request.updatedAt,
      resumeRequests: nextRequests.slice(-80)
    },
    request
  );
  return {
    ...record,
    updatedAt: request.updatedAt,
    webResearch: record.webResearch
      ? {
          ...record.webResearch,
          runtimeTrace: nextTrace
        }
      : record.webResearch
  };
}

function applyResumeImpactToTrace(
  trace: AgentRuntimeTrace,
  request: AgentRuntimeResumeRequest
): AgentRuntimeTrace {
  if (!request.impact || !trace.taskGraph) return trace;
  const impact = request.impact;
  const sourceTaskNodeId = impact.sourceTaskNodeId;
  const replayedNodeIds = new Set([
    ...impact.replayedTaskNodeIds,
    sourceTaskNodeId ?? ""
  ].filter(Boolean));
  const downstreamNodeIds = new Set(impact.downstreamTaskNodeIds);
  const staleNodeIds = new Set(impact.staleTaskNodeIds ?? []);
  const affectedNodeIds = new Set([...replayedNodeIds, ...downstreamNodeIds, ...staleNodeIds]);
  if (!affectedNodeIds.size) return trace;

  return {
    ...trace,
    taskGraph: {
      ...trace.taskGraph,
      updatedAt: request.updatedAt,
      nodes: trace.taskGraph.nodes.map((node) => {
        if (!affectedNodeIds.has(node.id)) return node;
        const role = replayedNodeIds.has(node.id)
          ? "replayed"
          : staleNodeIds.has(node.id)
            ? "stale"
            : "downstream";
        const status = statusForImpactedTaskNode(node.status, request.status, role);
        const completedAt =
          status === "completed" || status === "failed" || status === "skipped"
            ? request.updatedAt
            : node.completedAt;
        return {
          ...node,
          status,
          completedAt,
          latencyMs:
            node.startedAt && completedAt
              ? Math.max(0, new Date(completedAt).getTime() - new Date(node.startedAt).getTime())
              : node.latencyMs,
          outputSummary: outputSummaryForImpactedTaskNode(node.outputSummary, request, role),
          artifactIds: [...new Set([...node.artifactIds, ...impact.artifactIds])],
          blockedBy:
            request.status === "blocked" && role === "replayed"
              ? request.limitations.length
                ? request.limitations
                : [request.resultSummary]
              : node.blockedBy,
          metrics: {
            ...(node.metrics ?? {}),
            lastResumeRequestId: request.id,
            lastResumeAt: request.updatedAt,
            lastReplayScope: impact.replayScope,
            localRefreshStrategy: impact.localRefreshStrategy ?? "",
            lastReplayRole: role,
            lastReplayStatus: request.status,
            replayDurableRecordCount: impact.durableQueueRecordIds.length,
            replayArtifactCount: impact.artifactIds.length,
            replayDownstreamCount: impact.downstreamTaskNodeIds.length,
            replayStaleCount: (impact.staleTaskNodeIds ?? []).length,
            replayRecomputed: impact.recomputed.join(",")
          }
        };
      })
    }
  };
}

function statusForImpactedTaskNode(
  current: AgentTaskGraphNode["status"],
  resumeStatus: AgentRuntimeResumeRequest["status"],
  role: "replayed" | "downstream" | "stale"
): AgentTaskGraphNode["status"] {
  if (role === "stale") return current;
  if (resumeStatus === "blocked" && role === "replayed") return "failed";
  if (resumeStatus === "unsupported" && role === "replayed") return "skipped";
  if (resumeStatus === "applied") return "completed";
  return current;
}

function outputSummaryForImpactedTaskNode(
  current: string | undefined,
  request: AgentRuntimeResumeRequest,
  role: "replayed" | "downstream" | "stale"
) {
  if (role === "replayed") {
    return `Resume ${request.status}: ${request.resultSummary}`;
  }
  if (role === "stale") {
    return `Stale after local refresh: replay upstream artifact, then refresh this node explicitly. ${request.impact?.notes.join(" ") || request.resultSummary}`;
  }
  return `Resume downstream refresh: ${request.impact?.recomputed.join(", ") || request.resultSummary}`;
}
