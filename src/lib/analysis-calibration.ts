import { buildBacktestCalibrationSummary } from "./backtest-calibration";
import { githubReadmeBacktestCases } from "./github-readme-backtests";
import { listBacktestRecords } from "./storage";
import type {
  AgentTraceStep,
  ProductAnalysisCalibrationContext,
  UploadedMaterial
} from "./types";

export async function loadProductAnalysisCalibrationContext({
  brief,
  materials
}: {
  brief: string;
  materials: UploadedMaterial[];
}): Promise<ProductAnalysisCalibrationContext | undefined> {
  const appliesTo = calibrationTarget({ brief, materials });
  if (!appliesTo) return undefined;

  const dynamicRecords = await listBacktestRecords();
  const summary = buildBacktestCalibrationSummary({
    staticCases: githubReadmeBacktestCases,
    dynamicRecords
  });
  const highPriorityRules = summary.rules.filter((rule) => rule.priority === "high");
  const mediumPriorityRules = summary.rules.filter((rule) => rule.priority === "medium");

  return {
    source: "readme_backtest",
    appliedAt: new Date().toISOString(),
    appliesTo,
    reason:
      appliesTo === "github_readme"
        ? "本次材料包含 GitHub README / repo 指标，适用 README 回测校准。"
        : "本次材料包含 README/Markdown 产品说明，适用 README 回测校准。",
    staticSampleCount: summary.staticSampleCount,
    dynamicSampleCount: summary.dynamicSampleCount,
    completedDynamicCount: summary.completedDynamicCount,
    failedDynamicCount: summary.failedDynamicCount,
    averageAbsoluteDelta: summary.averageAbsoluteDelta,
    alignedRate: summary.alignedRate,
    rules: [...highPriorityRules, ...mediumPriorityRules]
      .slice(0, 5)
      .map((rule) => ({
        id: rule.id,
        title: rule.title,
        summary: rule.summary,
        agentRule: rule.agentRule,
        priority: rule.priority
      })),
    signalCalibrations: summary.signalCalibrations.slice(0, 6).map((signal) => ({
      label: signal.label,
      sampleCount: signal.sampleCount,
      averageDelta: signal.averageDelta,
      verdict: signal.verdict,
      lesson: signal.lesson
    })),
    actions: summary.actions.slice(0, 6).map((action) => ({
      id: action.id,
      target: action.target,
      action: action.action,
      label: action.label,
      confidence: action.confidence,
      sampleCount: action.sampleCount,
      neededSamples: action.neededSamples,
      averageDelta: action.averageDelta,
      recommendedAdjustment: action.recommendedAdjustment,
      reason: action.reason,
      nextStep: action.nextStep
    })),
    failurePatternSummaries: summary.failurePatterns
      .slice(0, 4)
      .map((pattern) => `${pattern.stage}/${pattern.label}: ${pattern.count} 次；${pattern.action}`),
    limitations: [
      summary.dynamicSampleCount
        ? `已有 ${summary.dynamicSampleCount} 个动态回测样本，规则会参考动态偏差。`
        : "当前还没有动态回测样本，主分析只使用静态校准规则。",
      "校准规则只调整 README/GitHub 产品判断框架，不把 README 表达当作市场事实。"
    ]
  };
}

export function appendCalibrationTraceStep(
  trace: AgentTraceStep[],
  calibrationContext: ProductAnalysisCalibrationContext | undefined
) {
  if (!calibrationContext) return trace;
  return [...trace, calibrationTraceStep(calibrationContext)];
}

function calibrationTarget({
  brief,
  materials
}: {
  brief: string;
  materials: UploadedMaterial[];
}): ProductAnalysisCalibrationContext["appliesTo"] | undefined {
  if (
    materials.some(
      (material) =>
        material.sourceKind === "github_readme" ||
        material.extractedUrls?.some((url) => /github\.com\/[^/]+\/[^/\s]+/i.test(url))
    ) ||
    /github\.com\/[^/]+\/[^/\s]+/i.test(brief)
  ) {
    return "github_readme";
  }

  if (
    materials.some((material) => {
      const name = material.name.toLowerCase();
      return (
        name === "readme" ||
        name.includes("readme") ||
        name.endsWith(".md") ||
        name.endsWith(".mdx") ||
        material.type === "text/markdown"
      );
    }) ||
    /\breadme\b/i.test(brief)
  ) {
    return "readme";
  }

  return undefined;
}

function calibrationTraceStep(
  calibrationContext: ProductAnalysisCalibrationContext
): AgentTraceStep {
  const started = performance.now();
  return {
    stage: "evidence_agent",
    title: "应用 README 回测校准",
    status: "completed",
    summary: `应用 ${calibrationContext.rules.length} 条校准规则；动态样本 ${calibrationContext.dynamicSampleCount} 个。`,
    toolCalls: [
      {
        id: crypto.randomUUID(),
        stage: "evidence_agent",
        toolName: "load_readme_backtest_calibration",
        status: "completed",
        inputSummary: calibrationContext.reason,
        outputSummary: calibrationContext.rules.map((rule) => rule.title).join("；"),
        latencyMs: Math.max(8, Math.round(performance.now() - started))
      },
      {
        id: crypto.randomUUID(),
        stage: "evidence_agent",
        toolName: "apply_calibrated_judgment_rules",
        status: "completed",
        inputSummary: "把 README/GitHub 回测规则用于产品潜力判断边界。",
        outputSummary:
          "已要求报告区分 README 表达、GitHub 开发者采用、外部后验证据、付费/留存缺口。",
        latencyMs: Math.max(8, Math.round(performance.now() - started))
      }
    ]
  };
}
