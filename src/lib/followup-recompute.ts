import { runDeterministicAgentWorkflow } from "./agent-workflow";
import { AgentRuntimeHarness } from "./agent-runtime";
import {
  applyExperimentResultToEvidenceBrief,
  generateEvidenceBrief
} from "./evidence-agent";
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
  UploadedMaterial
} from "./types";

export type FollowUpEvidenceRecomputeResult = {
  evidenceBrief: EvidenceBrief;
  materialsForAudit: UploadedMaterial[];
  followUps: AnalysisFollowUpTurn[];
  traceStep: AgentTraceStep;
  confidenceBefore: number;
  confidenceAfter: number;
  decisionBefore?: EvidenceBrief["decision"]["decision"];
  decisionAfter: EvidenceBrief["decision"]["decision"];
  appliedTurnIds: string[];
  runtimeTrace?: AgentRuntimeTrace;
};

export async function recomputeEvidenceFromFollowUpsWithRuntime({
  record,
  turnId,
  recomputedAt
}: {
  record: AnalysisRecord;
  turnId?: string;
  recomputedAt: string;
}): Promise<FollowUpEvidenceRecomputeResult> {
  const runtime = record.webResearch?.runtimeTrace
    ? AgentRuntimeHarness.fromTrace(record.webResearch.runtimeTrace)
    : new AgentRuntimeHarness(
        `追问材料证据重算：${record.productName || record.id}`,
        record.id
      );
  const taskNodeId = `follow_up:${turnId || "pending"}:evidence_recompute`;
  runtime.upsertTaskNode({
    id: taskNodeId,
    kind: "evidence_extract",
    label: "追问证据重算",
    inputSummary: turnId
      ? `把继续对话 ${turnId} 的补充材料纳入 Evidence Brief。`
      : "把未纳入的继续对话补充材料纳入 Evidence Brief。",
    resumeHint: "追问证据重算失败时，从该 evidence_extract 节点重新执行。",
    metrics: {
      followUpRecompute: true,
      selectedTurnId: turnId || "auto"
    }
  });
  runtime.startTaskNode(taskNodeId, {
    inputSummary: "合并追问材料、原始材料和既有网页调研，重算 Evidence Brief。",
    metrics: {
      followUpRecompute: true
    }
  });
  const definition = getRegisteredWorkerDefinition("evidence-extractor");
  const runner = new SubagentRunner(runtime);
  const run = await runner.run<FollowUpEvidenceRecomputeResult>({
    definition,
    taskNodeId,
    inputSummary: "追问补充材料进入 Evidence Brief 的派生产物刷新。",
    idempotencyKey: `follow-up-recompute:${record.id}:${turnId || "auto"}:${recomputedAt}`,
    boundary: {
      acceptedInputSummary: "只接收已抽取的追问材料摘要、原始材料 refs、已有 WebResearch 摘要和当前 Evidence Brief 指标。",
      inputCharCount: jsonCharLength({
        turnId,
        followUps: (record.followUps ?? []).map((turn) => ({
          id: turn.id,
          materialCount: turn.materials.length,
          evidenceAppliedAt: turn.evidenceAppliedAt
        })),
        confidence: record.evidenceBrief?.confidenceScore,
        decision: record.evidenceBrief?.decision.decision
      }),
      modelProvider: "deterministic",
      payload: {
        turnId,
        followUpCount: record.followUps?.length ?? 0,
        materialCount: (record.followUps ?? []).reduce(
          (sum, turn) => sum + turn.materials.length,
          0
        ),
        currentEvidenceCardCount: record.evidenceBrief?.evidenceCards.length ?? 0
      },
      forbiddenInputs: [
        "不得把追问材料自述当成外部市场事实。",
        "不得直接把长材料正文传给报告模型。",
        "不得绕过 Evidence Stop 或 Source Budget。"
      ],
      isolationNotes: [
        "本 worker 只刷新 Evidence Brief 派生产物和追问回填状态。",
        "输出必须通过 evidence artifact 和 handoff 交接。"
      ]
    },
    execute: async (context) => {
      const toolCallId = runtime.startToolCall({
        policy: toolPolicies.evidence_extract,
        taskNodeId,
        workerRunId: context.workerRunId,
        provider: "local",
        inputSummary: "用追问补充材料重算 Evidence Brief。",
        guardrails: recomputeGuardrails(record)
      });
      const result = recomputeEvidenceFromFollowUps({
        record,
        turnId,
        recomputedAt
      });
      const evidenceArtifact = await runtime.addArtifact({
        kind: "evidence_cards",
        owner: "evidence_extractor",
        title: "追问材料 Evidence Brief 刷新",
        summary: `证据置信 ${result.confidenceBefore} -> ${result.confidenceAfter}；决策 ${result.decisionBefore || "unknown"} -> ${result.decisionAfter}。`,
        payload: {
          appliedTurnIds: result.appliedTurnIds,
          confidenceBefore: result.confidenceBefore,
          confidenceAfter: result.confidenceAfter,
          decisionBefore: result.decisionBefore,
          decisionAfter: result.decisionAfter,
          evidenceCardIds: result.evidenceBrief.evidenceCards.map((card) => card.id),
          sourceBudgets: result.evidenceBrief.sourceBudgets
        },
        itemCount: result.evidenceBrief.evidenceCards.length,
        preview: result.traceStep.summary
      });
      runtime.completeToolCall(
        toolCallId,
        `重算 Evidence Brief：证据卡 ${result.evidenceBrief.evidenceCards.length} 张，置信 ${result.confidenceBefore} -> ${result.confidenceAfter}。`,
        {
          artifactIds: [evidenceArtifact.id],
          guardrails: recomputeGuardrails(record, result)
        }
      );
      const handoff = runtime.createHandoff({
        from: "evidence_extractor",
        to: "judge_agent",
        goal: "把追问材料重算后的 Evidence Brief 交给后续质检与报告刷新。",
        contextSummary: result.traceStep.summary,
        artifactIds: [evidenceArtifact.id],
        evidenceRefs: result.evidenceBrief.evidenceCards
          .slice(0, 10)
          .map((card) => card.id),
        acceptedInputSummary: "只交付 Evidence Brief 摘要、证据卡 refs、Source Budget 和决策变化。",
        keyFindings: [
          `confidence ${result.confidenceBefore} -> ${result.confidenceAfter}`,
          `decision ${result.decisionBefore || "unknown"} -> ${result.decisionAfter}`,
          `applied turns ${result.appliedTurnIds.length}`
        ],
        uncertainties: result.evidenceBrief.sourceBudgets
          .filter((budget) => budget.status !== "met")
          .slice(0, 4)
          .map((budget) => `${budget.label}: ${budget.missingEvidence.join("、")}`),
        forbiddenClaims: [
          "不得把追问材料当成独立市场验证。",
          "不得在 Source Budget 未达标时升级为强决策。"
        ]
      });
      return {
        value: result,
        outputSummary: result.traceStep.summary,
        handoffId: handoff.id,
        artifactIds: [evidenceArtifact.id],
        budgetUsed: {
          toolCalls: 1,
          artifacts: 1,
          outputChars: result.traceStep.summary.length
        }
      };
    }
  });

  runtime.completeTrace();
  return {
    ...run.value,
    runtimeTrace: runtime.getTrace()
  };
}

export function recomputeEvidenceFromFollowUps({
  record,
  turnId,
  recomputedAt
}: {
  record: AnalysisRecord;
  turnId?: string;
  recomputedAt: string;
}): FollowUpEvidenceRecomputeResult {
  const followUps = record.followUps ?? [];
  const selectedTurnIds = new Set(
    turnId
      ? [turnId]
      : followUps
          .filter((turn) => turn.materials.length > 0 && !turn.evidenceAppliedAt)
          .map((turn) => turn.id)
  );
  const selectedTurns = followUps.filter((turn) => selectedTurnIds.has(turn.id));

  if (!selectedTurns.length) {
    throw new Error("没有找到可重算的补充材料。");
  }

  const evidenceTurns = followUps.filter(
    (turn) => turn.evidenceAppliedAt || selectedTurnIds.has(turn.id)
  );
  const selectedMaterials = selectedTurns.flatMap((turn) => turn.materials);
  if (!selectedMaterials.length) {
    throw new Error("这次追问没有补充材料，无法重算证据。");
  }

  const followUpMaterials = evidenceTurns.flatMap((turn) =>
    turn.materials.map((material) => ({
      ...material,
      id: `followup-${turn.id}-${material.id}`,
      name: `追问补充 · ${material.name}`
    }))
  );
  const materialsForAudit = dedupeMaterials([
    ...(record.materials ?? []),
    ...followUpMaterials
  ]);
  const visibleText = [
    record.visibleText,
    followUpContextText(evidenceTurns)
  ]
    .filter(Boolean)
    .join("\n\n");
  const brief = [record.brief, followUpQuestionText(evidenceTurns)]
    .filter(Boolean)
    .join("\n\n");
  const workflow = runDeterministicAgentWorkflow({
    brief,
    materials: materialsForAudit,
    primaryMetrics: record.imageMetrics,
    webResearch: record.webResearch
  });

  let evidenceBrief = generateEvidenceBrief({
    brief,
    materials: materialsForAudit,
    webResearch: record.webResearch,
    productName: record.productName || workflow.inferredProductName,
    visibleText,
    workType: record.workType || workflow.inferredWorkType
  });
  const previousExperiment = record.evidenceBrief?.recommendedExperiment;
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

  const selectedUrls = new Set(selectedMaterials.map((material) => material.url));
  const selectedEvidenceCardIds = evidenceBrief.evidenceCards
    .filter((card) => selectedUrls.has(card.sourceUrl))
    .map((card) => card.id);
  const confidenceBefore = record.evidenceBrief?.confidenceScore ?? 0;
  const confidenceAfter = evidenceBrief.confidenceScore;
  const decisionBefore = record.evidenceBrief?.decision.decision;
  const decisionAfter = evidenceBrief.decision.decision;
  const updatedFollowUps = followUps.map((turn) => {
    if (!selectedTurnIds.has(turn.id)) return turn;
    return {
      ...turn,
      evidenceAppliedAt: recomputedAt,
      evidenceCardIds: selectedEvidenceCardIds,
      confidenceBefore,
      confidenceAfter,
      decisionBefore,
      decisionAfter,
      confidenceNote: `已纳入 Evidence Brief 重算：证据置信 ${confidenceBefore} -> ${confidenceAfter}。`
    };
  });

  return {
    evidenceBrief,
    materialsForAudit,
    followUps: updatedFollowUps,
    traceStep: recomputeTraceStep({
      selectedTurns,
      selectedMaterials,
      confidenceBefore,
      confidenceAfter,
      decisionBefore,
      decisionAfter,
      cardCount: selectedEvidenceCardIds.length
    }),
    confidenceBefore,
    confidenceAfter,
    decisionBefore,
    decisionAfter,
    appliedTurnIds: [...selectedTurnIds]
  };
}

function recomputeTraceStep({
  selectedTurns,
  selectedMaterials,
  confidenceBefore,
  confidenceAfter,
  decisionBefore,
  decisionAfter,
  cardCount
}: {
  selectedTurns: AnalysisFollowUpTurn[];
  selectedMaterials: UploadedMaterial[];
  confidenceBefore: number;
  confidenceAfter: number;
  decisionBefore?: EvidenceBrief["decision"]["decision"];
  decisionAfter: EvidenceBrief["decision"]["decision"];
  cardCount: number;
}): AgentTraceStep {
  const id = selectedTurns.map((turn) => turn.id).join("-");
  return {
    stage: "follow_up",
    title: "追问材料已重算",
    status: "completed",
    summary: `补充材料 ${selectedMaterials.length} 份进入 Evidence Brief；证据置信 ${confidenceBefore} -> ${confidenceAfter}。`,
    toolCalls: [
      {
        id: `${id}-merge-followup-materials`,
        stage: "follow_up",
        toolName: "merge_follow_up_materials",
        status: "completed",
        inputSummary: "合并已选择的追问材料和原始材料",
        outputSummary: selectedMaterials.map((item) => item.name).join("、"),
        latencyMs: 8
      },
      {
        id: `${id}-recompute-evidence-brief`,
        stage: "follow_up",
        toolName: "recompute_evidence_brief",
        status: "completed",
        inputSummary: "用原始材料、追问材料和既有网页调研重算 Evidence Brief",
        outputSummary: `新增/匹配材料证据卡 ${cardCount} 张；决策 ${decisionBefore || "unknown"} -> ${decisionAfter}`,
        latencyMs: 8
      }
    ]
  };
}

function followUpQuestionText(turns: AnalysisFollowUpTurn[]) {
  return turns
    .map((turn, index) => `Follow-up ${index + 1}: ${turn.userMessage}`)
    .join("\n");
}

function followUpContextText(turns: AnalysisFollowUpTurn[]) {
  return turns
    .map((turn, index) => {
      const materials = turn.materials
        .map((material) => {
          const text = material.extractedText || material.textPreview || "";
          return [
            `Material: ${material.name}`,
            text ? `Extracted text:\n${text.slice(0, 2400)}` : "No extracted text."
          ].join("\n");
        })
        .join("\n\n");
      return [`Follow-up ${index + 1}: ${turn.userMessage}`, materials]
        .filter(Boolean)
        .join("\n\n");
    })
    .join("\n\n");
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

function recomputeGuardrails(
  record: AnalysisRecord,
  result?: FollowUpEvidenceRecomputeResult
): AgentToolGuardrailResult[] {
  const followUpMaterialCount = (record.followUps ?? []).reduce(
    (sum, turn) => sum + turn.materials.length,
    0
  );
  return [
    {
      id: "followup-material-present",
      label: "Follow-up material",
      status: followUpMaterialCount ? "pass" : "warn",
      message: `${followUpMaterialCount} 份追问补充材料可用于重算。`
    },
    {
      id: "derived-evidence-boundary",
      label: "Derived evidence boundary",
      status: "pass",
      message: "追问材料只刷新 Evidence Brief 派生产物，不能绕过 Source Budget 或 Evidence Stop。"
    },
    {
      id: "confidence-change-recorded",
      label: "Confidence delta",
      status: result ? "pass" : "warn",
      message: result
        ? `置信度 ${result.confidenceBefore} -> ${result.confidenceAfter}。`
        : "运行完成后必须记录置信度变化。"
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
