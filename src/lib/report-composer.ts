import { AgentRuntimeHarness } from "./agent-runtime";
import { generateProductDiagnosisReport, modelName } from "./deepseek";
import { isTaskNodeDependencySatisfied } from "./graph-executor";
import { SubagentRunner } from "./subagent-runner";
import { getRegisteredWorkerDefinition } from "./subagent-registry";
import { toolPolicies } from "./tool-policy";
import type {
  AgentToolGuardrailResult,
  EvidenceBrief,
  ProductDiagnosisReport,
  WebResearchSummary
} from "./types";

export type ReportComposerInput = Parameters<typeof generateProductDiagnosisReport>[0] & {
  evidenceBrief: EvidenceBrief;
  webResearch: WebResearchSummary;
};

export type ReportComposerOutput = {
  report: ProductDiagnosisReport;
  webResearch: WebResearchSummary;
};

const reportComposerWorkerDefinition = getRegisteredWorkerDefinition("report-composer");

export async function generateReportWithRuntime(
  input: ReportComposerInput
): Promise<ReportComposerOutput> {
  const model = modelName();
  const runtime = input.webResearch.runtimeTrace
    ? AgentRuntimeHarness.fromTrace(input.webResearch.runtimeTrace)
    : new AgentRuntimeHarness(`Report Composer：生成 ${input.productName} 的证据约束报告。`);
  runtime.upsertTaskNode({
    id: "report",
    kind: "report",
    label: "Report Composer",
    dependsOn: runtime.getTrace().taskGraph?.nodes.some((node) => node.id === "judge")
      ? ["judge"]
      : [],
    inputSummary: "基于 Evidence Brief、Judge verdict、handoff 边界和材料摘要生成证据约束报告。",
    resumeHint: "复用 Evidence Brief、Judge verdict 和 handoff boundaries 重跑报告模型。",
    metrics: {
      evidenceConfidence: input.evidenceBrief.confidenceScore,
      judgeConfidenceCap: input.webResearch.judgeVerdict?.confidenceCap ?? "unknown"
    }
  });
  const dependencyBlockers = graphDependencyBlockersFor(runtime, "report");
  if (dependencyBlockers.length) {
    const report = blockedReport(input, dependencyBlockers);
    const artifact = await runtime.addArtifact({
      kind: "model_report",
      owner: "report_composer",
      title: "Report Composer Blocked",
      summary: report.potential_verdict,
      payload: {
        model: "graph-executor",
        report,
        dependencyBlockers
      },
      itemCount: dependencyBlockers.length,
      preview: dependencyBlockers.join("；")
    });
    const handoff = runtime.createHandoff({
      from: "report_composer",
      to: "main_agent",
      goal: "阻止报告模型在 Judge 未满足时生成强结论。",
      contextSummary: report.potential_verdict,
      artifactIds: [artifact.id],
      evidenceRefs: input.evidenceBrief.evidenceCards.slice(0, 4).map((card) => card.id),
      acceptedInputSummary: "接收 GraphExecutor task node 状态；Judge 未满足，Report Composer 不调用模型。",
      keyFindings: [`报告生成被阻断：${dependencyBlockers.join(" / ")}`],
      uncertainties: report.limitations,
      forbiddenClaims: reportForbiddenClaims(input),
      nextActions: report.actionable_suggestions
    });
    runtime.skipTaskNode("report", report.potential_verdict, {
      artifactIds: [artifact.id],
      handoffIds: [handoff.id],
      blockedBy: dependencyBlockers,
      metrics: {
        graphExecutorBlocked: true,
        graphExecutorBlockedBy: dependencyBlockers.join(","),
        potentialScore: report.potential_score,
        diagnosisScore: report.diagnosis_score
      }
    });
    runtime.completeTrace();
    return {
      report,
      webResearch: {
        ...input.webResearch,
        runtimeTrace: runtime.getTrace()
      }
    };
  }
  const spanId = runtime.startSpan({
    taskNodeId: "report",
    subagent: "report_composer",
    title: "生成证据约束报告",
    inputSummary: `用 ${model} 生成报告；Evidence ${input.evidenceBrief.evidenceCards.length} 张，Judge ${input.webResearch.judgeVerdict?.status ?? "unknown"}。`,
    metrics: {
      evidenceConfidence: input.evidenceBrief.confidenceScore,
      materialCount: input.materials?.length ?? 0,
      judgeConfidenceCap: input.webResearch.judgeVerdict?.confidenceCap ?? "unknown"
    }
  });
  const runner = new SubagentRunner(runtime);
  const run = await runner.run<{
    report: ProductDiagnosisReport;
    artifactId: string;
    handoffId: string;
  }>({
    definition: reportComposerWorkerDefinition,
    parentSpanId: spanId,
    taskNodeId: "report",
    inputSummary: `生成 ${input.productName || "Unknown Product"} 报告：证据置信 ${input.evidenceBrief.confidenceScore}/100，报告模型 ${model}。`,
    idempotencyKey: [
      "report",
      input.productName || "unknown",
      input.evidenceBrief.confidenceScore,
      input.evidenceBrief.evidenceCards.length,
      input.webResearch.judgeVerdict?.id ?? "no-judge",
      input.materials?.length ?? 0
    ].join(":"),
    boundary: {
      inputArtifactIds: latestRuntimeArtifactIds(input.webResearch),
      acceptedInputSummary:
        "接收 Evidence Brief、Judge verdict、最近 handoff、材料摘要、校准规则和 workflow trace；不接收网页全文或搜索噪音。",
      inputCharCount: reportInputCharCount(input),
      modelProvider: modelProviderForBoundary(model),
      payload: {
        model,
        productName: input.productName,
        materialCount: input.materials?.length ?? 0,
        evidenceCards: input.evidenceBrief.evidenceCards.length,
        confidenceScore: input.evidenceBrief.confidenceScore,
        judgeStatus: input.webResearch.judgeVerdict?.status ?? null,
        judgeConfidenceCap: input.webResearch.judgeVerdict?.confidenceCap ?? null,
        latestHandoffIds: input.webResearch.runtimeTrace?.handoffs.slice(-4).map((handoff) => handoff.id) ?? []
      },
      forbiddenInputs: [
        "不得读取主 Agent 的隐藏推理。",
        "不得把网页全文、搜索摘要噪音或失败 provider 当作市场证据。",
        "不得生成强于 Judge allowedReportStrength 的结论。",
        "不得突破 Judge confidenceCap 或 Evidence Stop。"
      ],
      isolationNotes: [
        "Report Composer 只做证据约束写作，不重新发明证据。",
        "报告输出必须落 model_report artifact，并通过 handoff 把结论边界交回主 Agent。"
      ]
    },
    execute: async (context) => {
      const inputGuardrails = reportInputGuardrails(input, model);
      const toolCallId = runtime.startToolCall({
        policy: toolPolicies.model_report,
        parentSpanId: spanId,
        workerRunId: context.workerRunId,
        provider: "model",
        inputSummary: `${model} 基于 Evidence Brief、Judge verdict 和 handoff boundaries 生成 ProductDiagnosisReport。`,
        costEstimate: estimateReportTokens(input),
        guardrails: inputGuardrails
      });
      context.recordEvent({
        type: "tool_call",
        summary: `${model} report generation started.`,
        metadata: {
          toolCallId,
          evidenceCards: input.evidenceBrief.evidenceCards.length,
          inputTokensEstimate: estimateReportTokens(input)
        }
      });

      try {
        const report = await generateProductDiagnosisReport(input);
        const outputGuardrails = reportOutputGuardrails(report, input);
        const artifact = await runtime.addArtifact({
          kind: "model_report",
          owner: "report_composer",
          title: "Report Composer Output",
          summary: `潜力分 ${report.potential_score}/100，诊断分 ${report.diagnosis_score}/100。`,
          payload: {
            model,
            report,
            guardrails: outputGuardrails
          },
          itemCount:
            report.market_evidence.length +
            report.top_issues.length +
            report.actionable_suggestions.length,
          preview: report.potential_verdict
        });
        const handoff = runtime.createHandoff({
          from: "report_composer",
          to: "main_agent",
          goal: "把模型报告、证据边界和下一步行动交给主 Agent 保存和质检。",
          contextSummary: `报告生成完成：潜力分 ${report.potential_score}/100，诊断分 ${report.diagnosis_score}/100。`,
          artifactIds: [artifact.id],
          evidenceRefs: input.evidenceBrief.evidenceCards.slice(0, 8).map((card) => card.id),
          acceptedInputSummary:
            "接收 Evidence Brief、Judge verdict、handoff 边界和材料摘要；输出证据约束报告 artifact。",
          keyFindings: [
            `潜力分 ${report.potential_score}/100，诊断分 ${report.diagnosis_score}/100。`,
            `Judge 状态 ${input.webResearch.judgeVerdict?.status ?? "unknown"}，置信上限 ${input.webResearch.judgeVerdict?.confidenceCap ?? "unknown"}。`,
            `主要问题：${report.top_issues.slice(0, 3).map((issue) => issue.title).join("；") || "未生成"}。`
          ],
          uncertainties: report.limitations.slice(0, 6),
          forbiddenClaims: reportForbiddenClaims(input),
          nextActions: report.actionable_suggestions.slice(0, 5)
        });
        runtime.completeToolCall(toolCallId, `报告生成完成：潜力分 ${report.potential_score}/100。`, {
          artifactIds: [artifact.id],
          costEstimate: estimateReportTokens(input),
          guardrails: outputGuardrails
        });
        context.recordEvent({
          type: "artifact",
          summary: `model_report artifact 已写入：潜力分 ${report.potential_score}/100。`,
          refs: [artifact.id],
          metadata: {
            potentialScore: report.potential_score,
            diagnosisScore: report.diagnosis_score,
            issueCount: report.top_issues.length
          }
        });
        context.recordEvent({
          type: "handoff",
          summary: "Report Composer handoff 已生成，等待质量审计。",
          refs: [handoff.id],
          metadata: {
            nextActions: report.actionable_suggestions.length,
            limitations: report.limitations.length
          }
        });

        return {
          value: {
            report,
            artifactId: artifact.id,
            handoffId: handoff.id
          },
          outputSummary: `潜力分 ${report.potential_score}/100，诊断分 ${report.diagnosis_score}/100。`,
          artifactIds: [artifact.id],
          handoffId: handoff.id,
          budgetUsed: {
            toolCalls: 1,
            artifacts: 1,
            outputChars: JSON.stringify(report).length
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "unknown report error");
        runtime.failToolCall(toolCallId, message, {
          guardrails: [
            ...inputGuardrails,
            {
              id: "report-model-exception",
              label: "Model Exception",
              status: "block",
              message
            }
          ]
        });
        throw error;
      }
    }
  });

  if (run.status !== "completed" || !run.value) {
    const message = `Report Composer 未完成：${run.failureCode ?? "unknown"}`;
    runtime.failSpan(spanId, message, { artifactIds: run.artifactIds });
    runtime.completeTrace();
    throw new Error(message);
  }

  runtime.completeSpan(spanId, `报告生成完成：潜力分 ${run.value.report.potential_score}/100。`, {
    artifactIds: [...new Set([run.value.artifactId, ...run.artifactIds])],
    handoffId: run.value.handoffId,
    metrics: {
      potentialScore: run.value.report.potential_score,
      diagnosisScore: run.value.report.diagnosis_score,
      issueCount: run.value.report.top_issues.length
    }
  });
  runtime.completeTrace();

  return {
    report: run.value.report,
    webResearch: {
      ...input.webResearch,
      runtimeTrace: runtime.getTrace()
    }
  };
}

function latestRuntimeArtifactIds(webResearch: WebResearchSummary) {
  return [
    ...(webResearch.runtimeTrace?.handoffs.slice(-4).flatMap((handoff) => handoff.artifactIds) ?? []),
    ...(webResearch.runtimeTrace?.artifacts
      .filter((artifact) =>
        ["evidence_cards", "judge_report", "search_results", "webpage_snapshot"].includes(artifact.kind)
      )
      .slice(-6)
      .map((artifact) => artifact.id) ?? [])
  ]
    .filter(Boolean)
    .filter((id, index, values) => values.indexOf(id) === index)
    .slice(-8);
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

function blockedReport(
  input: ReportComposerInput,
  dependencyBlockers: string[]
): ProductDiagnosisReport {
  const blockerText = dependencyBlockers.join(" / ");
  return {
    diagnosis_score: 0,
    potential_score: Math.min(20, input.evidenceBrief.confidenceScore),
    potential_verdict: `报告生成被 GraphExecutor 阻断：${blockerText}。需要先恢复 Judge/证据链。`,
    first_impression:
      "当前不能生成正常潜力报告，因为上游 Judge 或证据抽取节点未满足。该输出只作为恢复提示，不应当作为产品潜力判断。",
    diagnosis_tags: ["graph_executor_blocked", "needs_resume", "evidence_chain_incomplete"],
    market_evidence: [],
    top_issues: [
      {
        title: "证据链未完成",
        why_it_matters: "Judge 未满足时生成报告会把缺失证据伪装成完整判断，降低结论可信度。",
        how_to_fix: "先恢复被阻断的 task node，再重放 Judge 和 Report。"
      }
    ],
    references: [],
    actionable_suggestions: [
      "恢复被阻断的上游 task node。",
      "重放 Judge，确认报告强度边界。",
      "Judge 通过或明确降级后，再生成正式报告。"
    ],
    share_summary: {
      current_style: "blocked",
      main_problem: "证据链未完成，报告模型未运行。",
      recommended_references: "先查看 Subagent 运行账本中的 blocked task node。",
      one_line_diagnosis: "先恢复证据链，再生成报告。"
    },
    limitations: [
      `阻断依赖：${blockerText}`,
      "这是 GraphExecutor 生成的安全降级报告，不是模型完整分析。",
      "不得据此作出 build/stop/reposition 强决策。"
    ]
  };
}

function reportInputCharCount(input: ReportComposerInput) {
  return (
    (input.brief?.length ?? 0) +
    input.visibleText.length +
    JSON.stringify({
      materials: input.materials?.map((material) => ({
        name: material.name,
        type: material.type,
        text: material.extractedText?.length ?? 0,
        preview: material.textPreview?.length ?? 0
      })),
      evidenceCards: input.evidenceBrief.evidenceCards.length,
      sourceBudgets: input.evidenceBrief.sourceBudgets.length,
      confidenceScore: input.evidenceBrief.confidenceScore,
      judgeVerdict: input.webResearch.judgeVerdict,
      handoffs: input.webResearch.runtimeTrace?.handoffs.slice(-4).map((handoff) => handoff.contextSummary)
    }).length
  );
}

function estimateReportTokens(input: ReportComposerInput) {
  return Math.ceil(reportInputCharCount(input) / 4);
}

function modelProviderForBoundary(model: string) {
  if (model.startsWith("zhipu/")) return "zhipu";
  if (model.startsWith("deepseek/")) return "deepseek";
  return "external";
}

function reportInputGuardrails(
  input: ReportComposerInput,
  model: string
): AgentToolGuardrailResult[] {
  return [
    {
      id: "report-input-judge",
      label: "Judge Boundary",
      status: input.webResearch.judgeVerdict ? "pass" : "warn",
      message: input.webResearch.judgeVerdict
        ? `Judge ${input.webResearch.judgeVerdict.status}; confidence cap ${input.webResearch.judgeVerdict.confidenceCap}.`
        : "Judge verdict unavailable; report must stay exploratory."
    },
    {
      id: "report-input-evidence",
      label: "Evidence Brief",
      status: input.evidenceBrief.evidenceCards.length ? "pass" : "warn",
      message: `${input.evidenceBrief.evidenceCards.length} evidence cards; confidence ${input.evidenceBrief.confidenceScore}/100.`
    },
    {
      id: "report-input-model",
      label: "Model",
      status: model ? "pass" : "block",
      message: `Report model: ${model || "unknown"}.`
    }
  ];
}

function reportOutputGuardrails(
  report: ProductDiagnosisReport,
  input: ReportComposerInput
): AgentToolGuardrailResult[] {
  const judge = input.webResearch.judgeVerdict;
  const overJudgeCap = Boolean(judge && report.potential_score > judge.confidenceCap);
  const strongDespiteStop = Boolean(input.evidenceBrief.evidenceStop && report.potential_score >= 70);
  return [
    {
      id: "report-output-judge-cap",
      label: "Judge Cap",
      status: overJudgeCap ? "warn" : "pass",
      message: judge
        ? `Report potential ${report.potential_score}; Judge cap ${judge.confidenceCap}.`
        : "Judge cap unavailable."
    },
    {
      id: "report-output-evidence-stop",
      label: "Evidence Stop",
      status: strongDespiteStop ? "warn" : "pass",
      message: input.evidenceBrief.evidenceStop
        ? `Evidence Stop exists; potential score ${report.potential_score}.`
        : "No Evidence Stop active."
    },
    {
      id: "report-output-sections",
      label: "Report Sections",
      status:
        report.market_evidence.length >= 3 &&
        report.top_issues.length >= 3 &&
        report.actionable_suggestions.length >= 5
          ? "pass"
          : "warn",
      message: `market_evidence=${report.market_evidence.length}, issues=${report.top_issues.length}, actions=${report.actionable_suggestions.length}.`
    },
    {
      id: "report-output-limitations",
      label: "Limitations",
      status: report.limitations.length ? "pass" : "warn",
      message: `${report.limitations.length} limitations preserved.`
    }
  ];
}

function reportForbiddenClaims(input: ReportComposerInput) {
  const judge = input.webResearch.judgeVerdict;
  return [
    judge ? `报告潜力分不得超过 Judge 置信上限 ${judge.confidenceCap}。` : "",
    judge ? `报告结论不得强于 ${judge.allowedReportStrength}。` : "",
    input.evidenceBrief.evidenceStop ? "Evidence Stop 存在时不得推荐直接 build 或写成强市场验证。" : "",
    "不得把 GitHub stars、forks 或 README polish 写成收入、留存或付费意愿证据。",
    "不得把搜索计划、失败 provider 或无 URL 摘要写成客观市场证据。"
  ].filter(Boolean);
}
