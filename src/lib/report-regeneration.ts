import { modelName } from "./deepseek";
import { AgentRuntimeHarness } from "./agent-runtime";
import {
  applyExperimentResultToEvidenceBrief,
  generateEvidenceBrief
} from "./evidence-agent";
import { runJudgeAgent } from "./agent-judge";
import { makeReportTextDiff } from "./report-rewrite";
import { generateReportWithRuntime } from "./report-composer";
import { buildReportEvidenceBindings } from "./report-evidence-binding";
import { evaluateReportQuality } from "./report-quality";
import {
  completeLatestEvidenceResearchLoop,
  runEvidenceResearchLoop
} from "./web-research";
import { SubagentRunner } from "./subagent-runner";
import { getRegisteredWorkerDefinition } from "./subagent-registry";
import { toolPolicies } from "./tool-policy";
import type {
  AgentTraceStep,
  AgentRuntimeTrace,
  AgentToolGuardrailResult,
  AnalysisFollowUpTurn,
  AnalysisRecord,
  EvidenceBrief,
  ProductDiagnosisReport,
  ReportRegenerationDraft,
  UploadedMaterial,
  WebResearchSummary
} from "./types";

export type ReportDraftProgressEvent = {
  stage:
    | "prepare"
    | "web_research"
    | "evidence_brief"
    | "report_composer"
    | "quality_gate"
    | "save";
  status: "running" | "completed" | "failed";
  title: string;
  summary: string;
};

type ReportDraftProgressReporter = (
  event: ReportDraftProgressEvent
) => void | Promise<void>;

export async function generateFollowUpReportDraft({
  record,
  draftId,
  createdAt,
  turnId,
  onProgress
}: {
  record: AnalysisRecord;
  draftId: string;
  createdAt: string;
  turnId?: string;
  onProgress?: ReportDraftProgressReporter;
}): Promise<{
  draft: ReportRegenerationDraft;
  traceStep: AgentTraceStep;
}> {
  const result = await generateFollowUpReportDraftCore({
    record,
    draftId,
    createdAt,
    turnId,
    onProgress
  });
  return attachReportDraftRuntime({
    record,
    result,
    draftId,
    turnId,
    createdAt
  });
}

async function generateFollowUpReportDraftCore({
  record,
  draftId,
  createdAt,
  turnId,
  onProgress
}: {
  record: AnalysisRecord;
  draftId: string;
  createdAt: string;
  turnId?: string;
  onProgress?: ReportDraftProgressReporter;
}): Promise<{
  draft: ReportRegenerationDraft;
  traceStep: AgentTraceStep;
}> {
  const emit = async (event: ReportDraftProgressEvent) => {
    await onProgress?.(event);
  };

  if (!record.report) {
    throw new Error("当前分析没有可重生成的报告。");
  }
  if (!record.evidenceBrief) {
    throw new Error("当前分析没有 Evidence Brief。");
  }

  const sourceTurns = selectedTurns(record.followUps ?? [], turnId);
  if (turnId && !sourceTurns.length) {
    throw new Error("找不到这次继续对话。");
  }

  await emit({
    stage: "prepare",
    status: "completed",
    title: "准备草案",
    summary: sourceTurns.length
      ? `已选取 ${sourceTurns.length} 轮继续对话作为草案依据。`
      : "使用当前报告和证据账本生成草案。"
  });

  const materialsForAudit = materialsWithAppliedFollowUps(record);
  const beforeEvidenceBrief = record.evidenceBrief;
  let webResearch = record.webResearch ?? emptyWebResearch();
  const input = {
    brief: followUpBrief(record, sourceTurns),
    materials: materialsForAudit,
    productName: record.productName,
    runtimeId: record.id
  };
  const nextRound = (webResearch.researchLoops?.length ?? 0) + 1;

  await emit({
    stage: "web_research",
    status: "running",
    title: "补查网页",
    summary: "根据继续对话和当前证据缺口生成补查查询。"
  });

  webResearch = await runEvidenceResearchLoop({
    input,
    webResearch,
    evidenceBrief: beforeEvidenceBrief,
    round: nextRound
  });

  await emit({
    stage: "web_research",
    status: "completed",
    title: "网页补查完成",
    summary: latestLoopSummary(webResearch)
  });

  await emit({
    stage: "evidence_brief",
    status: "running",
    title: "重算证据账本",
    summary: "合并追问材料、既有网页调研和实验回填。"
  });

  let evidenceBrief = generateEvidenceBrief({
    brief: input.brief,
    materials: materialsForAudit,
    webResearch,
    productName: record.productName,
    visibleText: followUpVisibleText(record, sourceTurns),
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
    contextLabel: "继续对话报告草案"
  });
  webResearch = judged.webResearch;

  await emit({
    stage: "evidence_brief",
    status: "completed",
    title: "证据账本与 Judge 完成",
    summary: `证据置信 ${beforeEvidenceBrief.confidenceScore} -> ${evidenceBrief.confidenceScore}，Judge：${judged.verdict.summary}`
  });

  await emit({
    stage: "report_composer",
    status: "running",
    title: "生成新版报告",
    summary: `${modelName()} 正在根据更新后的 Evidence Brief 写报告草案。`
  });

  const reportRun = await generateReportWithRuntime({
    productVariant: record.productVariant,
    brief: input.brief,
    materials: materialsForAudit,
    webResearch,
    evidenceBrief,
    calibrationContext: record.calibrationContext,
    agentTrace: record.agentTrace,
    workType: record.workType,
    targetFeeling: record.targetFeeling,
    visibleText: followUpVisibleText(record, sourceTurns),
    productName: record.productName,
    imageMetrics: record.imageMetrics
  });
  const report = reportRun.report;
  webResearch = reportRun.webResearch;

  await emit({
    stage: "report_composer",
    status: "completed",
    title: "新版报告生成完成",
    summary: `草案潜力分 ${report.potential_score}/100，诊断分 ${report.diagnosis_score}/100。`
  });

  await emit({
    stage: "quality_gate",
    status: "running",
    title: "质检草案",
    summary: "检查新版报告是否证据绑定、具体且保留推断边界。"
  });

  const reportEvidenceBindings = buildReportEvidenceBindings({
    report,
    evidenceBrief
  });
  const reportQualityAudit = evaluateReportQuality({
    report,
    evidenceBrief,
    webResearch,
    materials: materialsForAudit,
    calibrationContext: record.calibrationContext,
    reportEvidenceBindings
  });
  const confidenceBefore = beforeEvidenceBrief.confidenceScore;
  const confidenceAfter = evidenceBrief.confidenceScore;
  const decisionBefore = beforeEvidenceBrief.decision.decision;
  const decisionAfter = evidenceBrief.decision.decision;
  const diff = makeReportTextDiff(reportText(record.report), reportText(report));

  await emit({
    stage: "quality_gate",
    status: "completed",
    title: "草案质检完成",
    summary: `质检 ${reportQualityAudit.score}/100；差异 ${diff.length} 行。`
  });

  const draft: ReportRegenerationDraft = {
    id: draftId,
    createdAt,
    source: "follow_up",
    turnId,
    title: "继续对话生成的新版报告",
    summary: `补查网页并重写报告草案：证据置信 ${confidenceBefore} -> ${confidenceAfter}，决策 ${decisionBefore} -> ${decisionAfter}。`,
    beforeReport: record.report,
    afterReport: report,
    diff,
    evidenceBrief,
    webResearch,
    reportQualityAudit,
    confidenceBefore,
    confidenceAfter,
    decisionBefore,
    decisionAfter,
    model: modelName(),
    evidenceRefs: evidenceRefs(evidenceBrief, sourceTurns)
  };

  return {
    draft,
    traceStep: {
      stage: "follow_up",
      title: "新版报告草案已生成",
      status: "completed",
      summary: draft.summary,
      toolCalls: [
        {
          id: `${draftId}-research-loop`,
          stage: "follow_up",
          toolName: "run_follow_up_web_research_loop",
          status: "completed",
          inputSummary: "根据继续对话和当前证据缺口补查网页",
          outputSummary: latestLoopSummary(webResearch),
          latencyMs: 8
        },
        {
          id: `${draftId}-compose-report-draft`,
          stage: "follow_up",
          toolName: "compose_report_regeneration_draft",
          status: "completed",
          inputSummary: "基于更新后的 Evidence Brief 生成新版报告草案",
          outputSummary: `质检 ${reportQualityAudit.score}/100；diff ${diff.length} 行。`,
          latencyMs: 8
        }
      ]
    }
  };
}

export async function applyReportRegenerationDraft({
  record,
  draftId,
  appliedAt
}: {
  record: AnalysisRecord;
  draftId: string;
  appliedAt: string;
}): Promise<{
  record: AnalysisRecord;
  draft: ReportRegenerationDraft;
  traceStep: AgentTraceStep;
}> {
  const result = applyReportRegenerationDraftCore({
    record,
    draftId,
    appliedAt
  });
  return attachReportApplyRuntime({
    result,
    originalRecord: record,
    draftId,
    appliedAt
  });
}

function applyReportRegenerationDraftCore({
  record,
  draftId,
  appliedAt
}: {
  record: AnalysisRecord;
  draftId: string;
  appliedAt: string;
}): {
  record: AnalysisRecord;
  draft: ReportRegenerationDraft;
  traceStep: AgentTraceStep;
} {
  const drafts = record.reportRegenerationDrafts ?? [];
  const draft = drafts.find((item) => item.id === draftId);
  if (!draft) {
    throw new Error("找不到这份新版报告草案。");
  }
  if (draft.appliedAt) {
    return {
      record,
      draft,
      traceStep: appliedTraceStep(draft)
    };
  }

  const appliedDraft = {
    ...draft,
    appliedAt
  };
  const reportEvidenceBindings = buildReportEvidenceBindings({
    report: draft.afterReport,
    evidenceBrief: draft.evidenceBrief
  });
  const updatedRecord = {
    ...record,
    updatedAt: appliedAt,
    report: draft.afterReport,
    evidenceBrief: draft.evidenceBrief,
    webResearch: draft.webResearch ?? record.webResearch,
    reportQualityAudit: draft.reportQualityAudit ?? record.reportQualityAudit,
    reportEvidenceBindings,
    model: draft.model,
    reportRegenerationDrafts: drafts.map((item) =>
      item.id === draftId ? appliedDraft : item
    )
  };

  return {
    record: updatedRecord,
    draft: appliedDraft,
    traceStep: appliedTraceStep(appliedDraft)
  };
}

async function attachReportDraftRuntime({
  record,
  result,
  draftId,
  turnId,
  createdAt
}: {
  record: AnalysisRecord;
  result: {
    draft: ReportRegenerationDraft;
    traceStep: AgentTraceStep;
  };
  draftId: string;
  turnId?: string;
  createdAt: string;
}) {
  const baseWebResearch = result.draft.webResearch ?? record.webResearch ?? emptyWebResearch();
  const runtime = baseWebResearch.runtimeTrace
    ? AgentRuntimeHarness.fromTrace(baseWebResearch.runtimeTrace)
    : new AgentRuntimeHarness(`继续对话报告草案生成：${record.productName || record.id}`, record.id);
  const taskNodeId = `follow_up:${draftId}:report_draft`;
  runtime.upsertTaskNode({
    id: taskNodeId,
    kind: "report",
    label: "新版报告草案生成",
    inputSummary: turnId
      ? `根据继续对话 ${turnId} 生成新版报告草案。`
      : "根据当前证据账本和最近继续对话生成新版报告草案。",
    resumeHint: "报告草案生成失败时，从该 report 节点重新执行。",
    metrics: {
      reportDraft: true,
      draftId,
      createdAt
    }
  });
  runtime.startTaskNode(taskNodeId, {
    inputSummary: "补查网页、刷新 Evidence Brief、Judge、Report Composer 和质量门后生成草案。",
    metrics: {
      reportDraft: true
    }
  });

  const definition = getRegisteredWorkerDefinition("report-composer");
  const runner = new SubagentRunner(runtime);
  const run = await runner.run<typeof result>({
    definition,
    taskNodeId,
    inputSummary: `生成新版报告草案 ${draftId}。`,
    idempotencyKey: `report-draft:${record.id}:${draftId}`,
    boundary: {
      acceptedInputSummary: "只接收 Evidence Brief、Judge 结果、report diff、质量审计和 citation refs；不接收网页或材料原文。",
      inputCharCount: jsonCharLength({
        draftId,
        turnId,
        confidenceBefore: result.draft.confidenceBefore,
        confidenceAfter: result.draft.confidenceAfter,
        decisionBefore: result.draft.decisionBefore,
        decisionAfter: result.draft.decisionAfter,
        diffLines: result.draft.diff.length,
        qualityScore: result.draft.reportQualityAudit?.score
      }),
      modelProvider: "deterministic",
      payload: {
        draftId,
        turnId,
        summary: result.draft.summary,
        evidenceRefs: result.draft.evidenceRefs.slice(0, 12)
      },
      forbiddenInputs: [
        "不得把草案报告当成已应用的正式报告。",
        "不得突破 Judge 允许的报告强度。",
        "不得回灌网页正文或材料原文给主 Agent。"
      ],
      isolationNotes: [
        "报告草案是派生产物，必须先保存为 draft artifact，用户应用后才覆盖正式报告。",
        "主 Agent 只消费草案摘要、diff、质量审计和 evidence refs。"
      ]
    },
    execute: async (context) => {
      const guardrails = reportDraftGuardrails(result.draft);
      const toolCallId = runtime.startToolCall({
        policy: toolPolicies.model_report,
        taskNodeId,
        workerRunId: context.workerRunId,
        provider: "local",
        inputSummary: "记录继续对话新版报告草案派生产物。",
        guardrails
      });
      const artifact = await runtime.addArtifact({
        kind: "model_report",
        owner: "report_composer",
        title: "继续对话新版报告草案",
        summary: result.draft.summary,
        payload: {
          draftId,
          turnId,
          confidenceBefore: result.draft.confidenceBefore,
          confidenceAfter: result.draft.confidenceAfter,
          decisionBefore: result.draft.decisionBefore,
          decisionAfter: result.draft.decisionAfter,
          qualityScore: result.draft.reportQualityAudit?.score,
          diff: result.draft.diff.slice(0, 80),
          evidenceRefs: result.draft.evidenceRefs
        },
        itemCount: result.draft.diff.length,
        preview: result.draft.summary
      });
      runtime.completeToolCall(
        toolCallId,
        `草案已生成：质检 ${result.draft.reportQualityAudit?.score ?? 0}/100，diff ${result.draft.diff.length} 行。`,
        {
          artifactIds: [artifact.id],
          guardrails
        }
      );
      const handoff = runtime.createHandoff({
        from: "report_composer",
        to: "main_agent",
        goal: "交付可人工确认应用的新版报告草案。",
        contextSummary: result.draft.summary,
        artifactIds: [artifact.id],
        evidenceRefs: result.draft.evidenceRefs.slice(0, 10),
        acceptedInputSummary: "只交付草案摘要、diff、质检分和 evidence refs；不覆盖正式报告。",
        keyFindings: [
          `confidence ${result.draft.confidenceBefore} -> ${result.draft.confidenceAfter}`,
          `decision ${result.draft.decisionBefore} -> ${result.draft.decisionAfter}`,
          `quality ${result.draft.reportQualityAudit?.score ?? 0}/100`
        ],
        uncertainties: result.draft.reportQualityAudit?.issues
          .slice(0, 4)
          .map((issue) => issue.title),
        forbiddenClaims: [
          "草案未应用前，不得声称正式报告已更新。",
          "不得把草案中的新增判断视为用户已接受的结论。"
        ]
      });
      return {
        value: result,
        outputSummary: result.draft.summary,
        artifactIds: [artifact.id],
        handoffId: handoff.id,
        budgetUsed: {
          toolCalls: 1,
          artifacts: 1,
          outputChars: result.draft.summary.length
        }
      };
    }
  });

  runtime.completeTrace();
  const runtimeTrace = runtime.getTrace();
  return {
    ...run.value,
    draft: {
      ...run.value.draft,
      webResearch: {
        ...baseWebResearch,
        ...(run.value.draft.webResearch ?? {}),
        runtimeTrace
      }
    }
  };
}

async function attachReportApplyRuntime({
  result,
  originalRecord,
  draftId,
  appliedAt
}: {
  result: {
    record: AnalysisRecord;
    draft: ReportRegenerationDraft;
    traceStep: AgentTraceStep;
  };
  originalRecord: AnalysisRecord;
  draftId: string;
  appliedAt: string;
}) {
  const baseWebResearch = result.record.webResearch ?? originalRecord.webResearch ?? emptyWebResearch();
  const runtime = baseWebResearch.runtimeTrace
    ? AgentRuntimeHarness.fromTrace(baseWebResearch.runtimeTrace)
    : new AgentRuntimeHarness(`新版报告草案应用：${result.record.productName || result.record.id}`, result.record.id);
  const taskNodeId = `follow_up:${draftId}:report_apply`;
  runtime.upsertTaskNode({
    id: taskNodeId,
    kind: "report",
    label: "新版报告草案应用",
    inputSummary: `应用新版报告草案 ${draftId}。`,
    resumeHint: "报告草案应用失败时，从该 report 节点重新执行。",
    metrics: {
      reportDraftApply: true,
      draftId,
      appliedAt
    }
  });
  runtime.startTaskNode(taskNodeId, {
    inputSummary: "用户确认草案后覆盖正式报告、Evidence Brief、WebResearch 和质检产物。",
    metrics: {
      reportDraftApply: true
    }
  });

  const definition = getRegisteredWorkerDefinition("report-composer");
  const runner = new SubagentRunner(runtime);
  const run = await runner.run<typeof result>({
    definition,
    taskNodeId,
    inputSummary: `应用新版报告草案 ${draftId}。`,
    idempotencyKey: `report-draft-apply:${result.record.id}:${draftId}:${appliedAt}`,
    boundary: {
      acceptedInputSummary: "只接收已保存草案、diff、Evidence Brief、WebResearch runtime refs 和质检结果。",
      inputCharCount: jsonCharLength({
        draftId,
        appliedAt,
        confidenceBefore: result.draft.confidenceBefore,
        confidenceAfter: result.draft.confidenceAfter,
        decisionBefore: result.draft.decisionBefore,
        decisionAfter: result.draft.decisionAfter
      }),
      modelProvider: "deterministic",
      payload: {
        draftId,
        appliedAt,
        summary: result.draft.summary
      },
      forbiddenInputs: [
        "不得重新生成草案内容。",
        "不得绕过用户确认应用草案。",
        "不得丢弃草案生成时的 runtime trace。"
      ],
      isolationNotes: [
        "应用 worker 只负责把已确认草案写入正式产物。",
        "应用后 runtimeTrace 必须随 webResearch 一起保存。"
      ]
    },
    execute: async (context) => {
      const guardrails = reportApplyGuardrails(result.draft);
      const toolCallId = runtime.startToolCall({
        policy: toolPolicies.model_report,
        taskNodeId,
        workerRunId: context.workerRunId,
        provider: "local",
        inputSummary: "应用已确认的新版报告草案。",
        guardrails
      });
      const artifact = await runtime.addArtifact({
        kind: "model_report",
        owner: "report_composer",
        title: "新版报告草案已应用",
        summary: result.traceStep.summary,
        payload: {
          draftId,
          appliedAt,
          confidenceBefore: result.draft.confidenceBefore,
          confidenceAfter: result.draft.confidenceAfter,
          decisionBefore: result.draft.decisionBefore,
          decisionAfter: result.draft.decisionAfter,
          qualityScore: result.draft.reportQualityAudit?.score
        },
        itemCount: 1,
        preview: result.traceStep.summary
      });
      runtime.completeToolCall(
        toolCallId,
        `已应用草案：证据置信 ${result.draft.confidenceBefore} -> ${result.draft.confidenceAfter}。`,
        {
          artifactIds: [artifact.id],
          guardrails
        }
      );
      const handoff = runtime.createHandoff({
        from: "report_composer",
        to: "main_agent",
        goal: "确认新版报告草案已经应用为正式报告。",
        contextSummary: result.traceStep.summary,
        artifactIds: [artifact.id],
        evidenceRefs: result.draft.evidenceRefs.slice(0, 10),
        acceptedInputSummary: "只交付已应用状态、质检结果和 evidence refs。",
        keyFindings: [
          `applied ${draftId}`,
          `confidence ${result.draft.confidenceBefore} -> ${result.draft.confidenceAfter}`,
          `decision ${result.draft.decisionBefore} -> ${result.draft.decisionAfter}`
        ],
        forbiddenClaims: [
          "不得丢失草案生成前后的差异记录。",
          "不得把应用动作伪装成新的外部证据。"
        ]
      });
      return {
        value: result,
        outputSummary: result.traceStep.summary,
        artifactIds: [artifact.id],
        handoffId: handoff.id,
        budgetUsed: {
          toolCalls: 1,
          artifacts: 1,
          outputChars: result.traceStep.summary.length
        }
      };
    }
  });

  runtime.completeTrace();
  const runtimeTrace = runtime.getTrace();
  return {
    ...run.value,
    record: {
      ...run.value.record,
      webResearch: {
        ...baseWebResearch,
        ...(run.value.record.webResearch ?? {}),
        runtimeTrace
      }
    },
    draft: {
      ...run.value.draft,
      webResearch: run.value.draft.webResearch
        ? {
            ...run.value.draft.webResearch,
            runtimeTrace
          }
        : run.value.draft.webResearch
    }
  };
}

function selectedTurns(turns: AnalysisFollowUpTurn[], turnId?: string) {
  if (turnId) return turns.filter((turn) => turn.id === turnId);
  const evidenceTurns = turns.filter((turn) => turn.evidenceAppliedAt);
  return evidenceTurns.length ? evidenceTurns.slice(-3) : turns.slice(-3);
}

function materialsWithAppliedFollowUps(record: AnalysisRecord) {
  const followUpMaterials = (record.followUps ?? [])
    .filter((turn) => turn.evidenceAppliedAt)
    .flatMap((turn) =>
      turn.materials.map((material) => ({
        ...material,
        id: `followup-${turn.id}-${material.id}`,
        name: `追问补充 · ${material.name}`
      }))
    );
  return dedupeMaterials([...(record.materials ?? []), ...followUpMaterials]);
}

function followUpBrief(record: AnalysisRecord, turns: AnalysisFollowUpTurn[]) {
  return [
    record.brief,
    ...turns.map((turn, index) => `Follow-up ${index + 1}: ${turn.userMessage}`)
  ]
    .filter(Boolean)
    .join("\n\n");
}

function followUpVisibleText(record: AnalysisRecord, turns: AnalysisFollowUpTurn[]) {
  return [
    record.visibleText,
    ...turns.map((turn, index) => {
      const materials = turn.materials
        .map((material) => {
          const text = material.extractedText || material.textPreview || "";
          return `${material.name}\n${text.slice(0, 2200)}`;
        })
        .join("\n\n");
      return [`Follow-up ${index + 1}: ${turn.userMessage}`, materials]
        .filter(Boolean)
        .join("\n\n");
    })
  ]
    .filter(Boolean)
    .join("\n\n");
}

function evidenceRefs(evidenceBrief: EvidenceBrief, turns: AnalysisFollowUpTurn[]) {
  return [
    `Evidence Brief confidence ${evidenceBrief.confidenceScore}`,
    `Decision ${evidenceBrief.decision.decision}`,
    ...evidenceBrief.sourceBudgets
      .filter((budget) => budget.status !== "met")
      .slice(0, 3)
      .map((budget) => `Source Budget: ${budget.label}`),
    ...turns.map((turn) => `Follow-up: ${turn.userMessage.slice(0, 60)}`)
  ];
}

function reportText(report: ProductDiagnosisReport) {
  return [
    `Potential score: ${report.potential_score}`,
    report.potential_verdict,
    report.first_impression,
    ...report.market_evidence.map(
      (item) => `${item.signal}\n${item.evidence}\n${item.interpretation}`
    ),
    ...report.top_issues.map(
      (item) => `${item.title}\n${item.why_it_matters}\n${item.how_to_fix}`
    ),
    ...report.actionable_suggestions,
    ...report.limitations
  ]
    .filter(Boolean)
    .join("\n\n");
}

function latestLoopSummary(webResearch: WebResearchSummary) {
  const loop = webResearch.researchLoops?.[webResearch.researchLoops.length - 1];
  if (!loop) return "没有执行新的补证循环。";
  return `${loop.status}，新增结果 ${loop.resultCount} 条；${loop.stopCondition}`;
}

function appliedTraceStep(draft: ReportRegenerationDraft): AgentTraceStep {
  return {
    stage: "follow_up",
    title: "新版报告已应用",
    status: "completed",
    summary: `已应用「${draft.title}」；证据置信 ${draft.confidenceBefore} -> ${draft.confidenceAfter}。`,
    toolCalls: [
      {
        id: `${draft.id}-apply-report-draft`,
        stage: "follow_up",
        toolName: "apply_report_regeneration_draft",
        status: "completed",
        inputSummary: "用户确认应用新版报告草案",
        outputSummary: `应用模型 ${draft.model} 生成的报告；质检 ${draft.reportQualityAudit?.score ?? 0}/100。`,
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

function reportDraftGuardrails(draft: ReportRegenerationDraft): AgentToolGuardrailResult[] {
  return [
    {
      id: "draft-not-applied",
      label: "Draft boundary",
      status: draft.appliedAt ? "warn" : "pass",
      message: draft.appliedAt
        ? "草案已应用，生成记录应只作为历史审计。"
        : "草案生成不会直接覆盖正式报告。"
    },
    {
      id: "draft-quality-present",
      label: "Quality audit",
      status: draft.reportQualityAudit ? "pass" : "warn",
      message: draft.reportQualityAudit
        ? `质检 ${draft.reportQualityAudit.score}/100。`
        : "草案缺少质量审计。"
    },
    {
      id: "draft-evidence-refs",
      label: "Evidence refs",
      status: draft.evidenceRefs.length ? "pass" : "warn",
      message: `${draft.evidenceRefs.length} 条 evidence refs 绑定到草案。`
    },
    {
      id: "draft-application-required",
      label: "Human confirmation",
      status: "pass",
      message: "草案必须由用户显式应用后才覆盖正式报告。"
    }
  ];
}

function reportApplyGuardrails(draft: ReportRegenerationDraft): AgentToolGuardrailResult[] {
  return [
    {
      id: "draft-applied-at",
      label: "Applied state",
      status: draft.appliedAt ? "pass" : "warn",
      message: draft.appliedAt
        ? `草案已在 ${draft.appliedAt} 应用。`
        : "草案应用时间尚未写入。"
    },
    {
      id: "draft-diff-preserved",
      label: "Diff ledger",
      status: draft.diff.length ? "pass" : "warn",
      message: `保留 ${draft.diff.length} 行报告差异。`
    },
    {
      id: "draft-web-research-trace",
      label: "Runtime trace",
      status: draft.webResearch?.runtimeTrace ? "pass" : "warn",
      message: draft.webResearch?.runtimeTrace
        ? "草案携带 runtimeTrace，可用于审计生成过程。"
        : "草案缺少 runtimeTrace。"
    }
  ];
}

function jsonCharLength(value: unknown) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}
