import type {
  AgentTraceStep,
  AnalysisFollowUpTurn,
  AnalysisRecord,
  EvidenceBrief,
  SourceBudget,
  UploadedMaterial
} from "./types";

export function createAnalysisFollowUpTurn({
  record,
  userMessage,
  materials,
  turnId,
  createdAt
}: {
  record: AnalysisRecord;
  userMessage: string;
  materials: UploadedMaterial[];
  turnId: string;
  createdAt: string;
}): AnalysisFollowUpTurn {
  const evidenceBrief = record.evidenceBrief;
  const message = userMessage.trim() || "我补充了材料，请继续判断。";
  const unmetBudgets = evidenceBrief?.sourceBudgets?.filter((budget) => budget.status !== "met") ?? [];
  const recommendedExperiment = evidenceBrief?.recommendedExperiment;
  const materialSummary = summarizeFollowUpMaterials(materials);
  const answerParts = [
    decisionParagraph(evidenceBrief),
    materialSummary,
    sourceBudgetParagraph(unmetBudgets),
    recommendedExperiment
      ? `下一步仍建议优先执行「${recommendedExperiment.title}」。主指标是「${recommendedExperiment.primaryMetric?.name || recommendedExperiment.successMetric}」，成功线是「${recommendedExperiment.primaryMetric?.target || recommendedExperiment.successMetric}」，失败线是「${recommendedExperiment.primaryMetric?.failureThreshold || recommendedExperiment.failureMetric}」。`
      : "下一步先补用户行为证据：最近一次遇到问题的场景、当前替代方案、是否愿意付出时间或钱。",
    "这是一条增量回答：我引用当前报告和证据账本，不会把新材料直接改写成强结论；要提高置信度，需要把新材料转成实验结果或触发完整再分析。"
  ].filter(Boolean);

  return {
    id: turnId,
    createdAt,
    userMessage: message,
    materials,
    response: answerParts.join("\n\n"),
    evidenceRefs: evidenceRefs(record, materials, unmetBudgets),
    suggestedActions: suggestedActions(evidenceBrief, unmetBudgets),
    confidenceNote: confidenceNote(evidenceBrief, materials),
    visibleSteps: [
      {
        title: "读取追问",
        status: "completed",
        summary: shorten(message, 90)
      },
      {
        title: "处理补充材料",
        status: "completed",
        summary: materials.length
          ? `已保存 ${materials.length} 份材料；可抽取文本 ${materials.filter((item) => item.textPreview || item.extractedText).length} 份。`
          : "本轮没有新增材料。"
      },
      {
        title: "对照证据账本",
        status: evidenceBrief ? "completed" : "skipped",
        summary: evidenceBrief
          ? `当前决策 ${decisionLabel(evidenceBrief.decision.decision)}，证据置信 ${evidenceBrief.confidenceScore}/100。`
          : "当前记录没有 Evidence Brief，只能基于报告文本回答。"
      },
      {
        title: "给出下一步",
        status: "completed",
        summary: recommendedExperiment
          ? `优先推进「${recommendedExperiment.title}」。`
          : "优先补齐用户行为、付费意愿和反证。"
      }
    ]
  };
}

export function createFollowUpTraceStep(turn: AnalysisFollowUpTurn): AgentTraceStep {
  return {
    stage: "follow_up",
    title: "继续对话",
    status: "completed",
    summary: `回答追问：${shorten(turn.userMessage, 64)}；补充材料 ${turn.materials.length} 份。`,
    toolCalls: [
      {
        id: `${turn.id}-read-message`,
        stage: "follow_up",
        toolName: "read_follow_up_message",
        status: "completed",
        inputSummary: "读取报告页继续追问",
        outputSummary: shorten(turn.userMessage, 100),
        latencyMs: 8
      },
      {
        id: `${turn.id}-read-materials`,
        stage: "follow_up",
        toolName: "extract_follow_up_materials",
        status: "completed",
        inputSummary: "保存并抽取补充材料",
        outputSummary: turn.materials.length
          ? turn.materials.map((item) => item.name).join("、")
          : "没有新增材料",
        latencyMs: 8
      },
      {
        id: `${turn.id}-answer`,
        stage: "follow_up",
        toolName: "synthesize_evidence_bound_answer",
        status: "completed",
        inputSummary: "对照 Evidence Brief、Source Budget 和推荐实验回答",
        outputSummary: turn.confidenceNote,
        latencyMs: 8
      }
    ]
  };
}

function decisionParagraph(evidenceBrief?: EvidenceBrief) {
  if (!evidenceBrief) {
    return "我会先基于当前报告回答；这条记录缺少 Evidence Brief，所以不能给更高置信的增量判断。";
  }

  const stopReason = evidenceBrief.evidenceStop?.reason
    ? `强决策仍被阻断：${shorten(evidenceBrief.evidenceStop.reason, 160)}`
    : "当前没有触发强决策阻断，但仍应看 Source Budget 是否达标。";
  return `按当前证据账本，结论仍是「${decisionLabel(evidenceBrief.decision.decision)}」，证据置信 ${evidenceBrief.confidenceScore}/100。${stopReason}`;
}

function summarizeFollowUpMaterials(materials: UploadedMaterial[]) {
  if (!materials.length) return "";

  const summaries = materials.slice(0, 4).map((material) => {
    const preview = material.textPreview || material.extractedText || "";
    if (preview.trim()) {
      return `- ${material.name}：${shorten(preview.replace(/\s+/g, " "), 130)}`;
    }
    return `- ${material.name}：已保存原件，当前没有抽取到可审计文本。`;
  });
  return `你刚补充的材料已进入本次对话记录：\n${summaries.join("\n")}`;
}

function sourceBudgetParagraph(unmetBudgets: SourceBudget[]) {
  if (!unmetBudgets.length) {
    return "Source Budget 当前没有明显缺口；下一步重点是用真实实验结果确认行为强度，而不是继续堆材料。";
  }

  const lines = unmetBudgets.slice(0, 4).map((budget) => {
    const missing = budget.missingEvidence.length
      ? `；缺口：${budget.missingEvidence.slice(0, 2).join("、")}`
      : "";
    return `- ${budget.label}：支持 ${budget.currentSupport}/${budget.requiredSupport}，反证 ${budget.currentOpposition}/${budget.requiredOpposition}${missing}`;
  });
  return `现在最影响判断的仍是这些证据缺口：\n${lines.join("\n")}`;
}

function evidenceRefs(
  record: AnalysisRecord,
  materials: UploadedMaterial[],
  unmetBudgets: SourceBudget[]
) {
  const refs = [
    record.evidenceBrief
      ? `Evidence Brief confidence ${record.evidenceBrief.confidenceScore}`
      : "",
    record.evidenceBrief
      ? `Decision ${record.evidenceBrief.decision.decision}`
      : "",
    ...unmetBudgets.slice(0, 3).map((budget) => `Source Budget: ${budget.label}`),
    ...materials.slice(0, 3).map((material) => `Follow-up material: ${material.name}`)
  ].filter(Boolean);
  return refs.length ? refs : ["Current report"];
}

function suggestedActions(evidenceBrief?: EvidenceBrief, unmetBudgets: SourceBudget[] = []) {
  const experiment = evidenceBrief?.recommendedExperiment;
  const actions = [
    ...(experiment?.steps.slice(0, 3) ?? []),
    ...unmetBudgets
      .flatMap((budget) => budget.missingEvidence)
      .filter(Boolean)
      .slice(0, 3)
      .map((item) => `补齐：${item}`)
  ];

  if (actions.length) return unique(actions).slice(0, 5);
  return [
    "找 5-10 个目标用户，只问过去 30 天真实行为。",
    "保留原始截图、访谈摘录、链接和指标口径。",
    "把结果回填到推荐实验，更新证据置信度。"
  ];
}

function confidenceNote(evidenceBrief?: EvidenceBrief, materials: UploadedMaterial[] = []) {
  const base = evidenceBrief
    ? `当前证据置信 ${evidenceBrief.confidenceScore}/100。`
    : "当前缺少 Evidence Brief。";
  const materialNote = materials.length
    ? `新增 ${materials.length} 份材料已记录，但尚未重跑完整网页调研和报告生成。`
    : "本轮没有新增材料。";
  return `${base}${materialNote}`;
}

function decisionLabel(decision: EvidenceBrief["decision"]["decision"]) {
  if (decision === "build") return "继续构建";
  if (decision === "test_first") return "先验证";
  if (decision === "reposition") return "重新定位";
  return "停止";
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function shorten(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}...` : compact;
}
