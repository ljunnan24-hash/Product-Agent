import type { GitHubBacktestCase } from "./github-readme-backtests";
import type {
  DynamicBacktestFailureDetail,
  DynamicBacktestRecord
} from "./types";

export type BacktestCalibrationSummary = {
  generatedAt: string;
  staticSampleCount: number;
  dynamicSampleCount: number;
  completedDynamicCount: number;
  failedDynamicCount: number;
  averageAbsoluteDelta: number | null;
  alignedRate: number | null;
  resultCounts: {
    aligned: number;
    underestimated: number;
    overestimated: number;
    insufficient: number;
  };
  rules: BacktestCalibrationRule[];
  signalCalibrations: BacktestSignalCalibration[];
  actions: BacktestCalibrationAction[];
  failurePatterns: BacktestFailurePattern[];
};

export type BacktestCalibrationRule = {
  id: string;
  title: string;
  summary: string;
  evidence: string[];
  agentRule: string;
  priority: "high" | "medium" | "low";
};

export type BacktestSignalCalibration = {
  label: string;
  sampleCount: number;
  averageScore: number;
  averageDelta: number;
  verdict: "usable" | "overweighted" | "underweighted" | "needs_more_samples";
  lesson: string;
};

export type BacktestCalibrationAction = {
  id: string;
  target: string;
  action: "upweight" | "downweight" | "hold" | "collect_more" | "fix_tooling";
  label: string;
  confidence: "high" | "medium" | "low";
  sampleCount: number;
  neededSamples: number;
  averageDelta: number | null;
  recommendedAdjustment: string;
  reason: string;
  nextStep: string;
};

export type BacktestFailurePattern = {
  key: string;
  label: string;
  stage: string;
  count: number;
  retryableCount: number;
  example: string;
  action: string;
};

export function buildBacktestCalibrationSummary({
  staticCases,
  dynamicRecords
}: {
  staticCases: GitHubBacktestCase[];
  dynamicRecords: DynamicBacktestRecord[];
}): BacktestCalibrationSummary {
  const completedDynamic = dynamicRecords.filter((record) => record.status === "completed");
  const failedDynamic = dynamicRecords.filter((record) => record.status === "failed");
  const dynamicWithCalibration = completedDynamic.filter(
    (record) => record.calibration.result !== "insufficient"
  );
  const deltas = dynamicWithCalibration.map((record) => record.calibration.delta);
  const resultCounts = {
    aligned: countByResult(completedDynamic, "aligned"),
    underestimated: countByResult(completedDynamic, "underestimated"),
    overestimated: countByResult(completedDynamic, "overestimated"),
    insufficient: countByResult(completedDynamic, "insufficient")
  };
  const signalCalibrations = buildSignalCalibrations(completedDynamic);
  const failurePatterns = buildFailurePatterns(failedDynamic);

  return {
    generatedAt: new Date().toISOString(),
    staticSampleCount: staticCases.length,
    dynamicSampleCount: dynamicRecords.length,
    completedDynamicCount: completedDynamic.length,
    failedDynamicCount: failedDynamic.length,
    averageAbsoluteDelta: deltas.length
      ? Math.round(deltas.reduce((sum, delta) => sum + Math.abs(delta), 0) / deltas.length)
      : null,
    alignedRate: dynamicWithCalibration.length
      ? Math.round((resultCounts.aligned / dynamicWithCalibration.length) * 100)
      : null,
    resultCounts,
    rules: buildCalibrationRules(staticCases, dynamicRecords),
    signalCalibrations,
    actions: buildCalibrationActions({
      completedDynamic,
      failedDynamic,
      signalCalibrations,
      failurePatterns
    }),
    failurePatterns
  };
}

function buildCalibrationRules(
  staticCases: GitHubBacktestCase[],
  dynamicRecords: DynamicBacktestRecord[]
): BacktestCalibrationRule[] {
  const rules: BacktestCalibrationRule[] = [
    {
      id: "clear-alternative-workflow",
      title: "清晰替代对象 + 高频任务是高潜力底座",
      summary:
        "README 同时说清替代谁、解决什么高频任务、为什么现在能做，早期潜力可以上调，但仍不能直接推出付费和留存。",
      evidence: staticCases
        .filter((item) => item.id === "supabase")
        .map((item) => item.calibrationLesson),
      agentRule:
        "当 README 命中替代对象、高频任务、可上手路径和开源/生态信任时，提高 readme-only 潜力；强决策仍要求后验证据补齐付费、留存或采用。",
      priority: "high"
    },
    {
      id: "lifecycle-drift",
      title: "生命周期会改写原来的优势",
      summary:
        "早期成立的差异化，后期可能被安全、商业化、闭源、停更或社区争议反转；判断必须绑定证据日期。",
      evidence: staticCases
        .filter((item) => item.id === "calcom")
        .map((item) => item.calibrationLesson),
      agentRule:
        "看到开源、自托管、安全、平台依赖类产品时，必须查询最近 12-18 个月的许可、维护、争议和战略变化，旧证据只能作历史背景。",
      priority: "high"
    },
    {
      id: "developer-library-budget",
      title: "开发者库不能套 SaaS 付费标准",
      summary:
        "库型产品的潜力更多体现为任务频率、生态背书、集成摩擦、社区问题密度和维护活跃度。",
      evidence: staticCases
        .filter((item) => item.id === "swr")
        .map((item) => item.calibrationLesson),
      agentRule:
        "产品被识别为 developer library / framework / SDK 时，单独启用开发者工具证据预算：stars/forks、docs、issues/discussions、生态集成和最近 release。",
      priority: "medium"
    }
  ];

  const overestimated = dynamicRecords.filter(
    (record) => record.status === "completed" && record.calibration.result === "overestimated"
  );
  if (overestimated.length) {
    rules.push({
      id: "dynamic-overestimate",
      title: "高估样本要补反证",
      summary: `${overestimated.length} 个动态样本显示 README 预测高于后验结果，说明表达强不等于真实采用强。`,
      evidence: overestimated.slice(0, 3).map((record) => `${record.repo}：偏差 ${record.calibration.delta}`),
      agentRule:
        "README 文案很完整但后验弱时，优先查停更、闭源、替代方案更强、社区负面反馈和最近采用下降。",
      priority: "high"
    });
  }

  const underestimated = dynamicRecords.filter(
    (record) => record.status === "completed" && record.calibration.result === "underestimated"
  );
  if (underestimated.length) {
    rules.push({
      id: "dynamic-underestimate",
      title: "低估样本要看生态补偿",
      summary: `${underestimated.length} 个动态样本显示后验强于 README 预测，README 表达弱时也可能被生态和采用补回来。`,
      evidence: underestimated.slice(0, 3).map((record) => `${record.repo}：偏差 +${record.calibration.delta}`),
      agentRule:
        "README 不强但 GitHub 活跃、生态集成、社区讨论和外部教程强时，不要过早判 stop，应转为 test_first 并要求补真实使用证据。",
      priority: "medium"
    });
  }

  const failed = dynamicRecords.filter((record) => record.status === "failed");
  if (failed.length) {
    rules.push({
      id: "dynamic-failure-recovery",
      title: "失败样本不进入判断，只进入工具改进",
      summary: `${failed.length} 个动态回测失败样本需要先修读取或搜索链路，不能当成产品潜力负样本。`,
      evidence: failed.slice(0, 3).map((record) => `${record.repo}：${record.errorMessage || "回测失败"}`),
      agentRule:
        "读取 GitHub、README 或 provider 失败时，结论必须标记为工具失败；不要把缺证据误判成产品没潜力。",
      priority: "high"
    });
  }

  return rules;
}

function buildSignalCalibrations(
  completedRecords: DynamicBacktestRecord[]
): BacktestSignalCalibration[] {
  const buckets = new Map<string, { scores: number[]; deltas: number[] }>();
  for (const record of completedRecords) {
    if (record.calibration.result === "insufficient") continue;
    for (const score of record.prediction.scoreBreakdown) {
      if (score.score <= 0) continue;
      const bucket = buckets.get(score.label) ?? { scores: [], deltas: [] };
      bucket.scores.push(score.score);
      bucket.deltas.push(record.calibration.delta);
      buckets.set(score.label, bucket);
    }
  }

  return [...buckets.entries()]
    .map(([label, bucket]) => {
      const averageScore = average(bucket.scores);
      const averageDelta = average(bucket.deltas);
      const verdict = signalVerdict(bucket.deltas.length, averageDelta);
      return {
        label,
        sampleCount: bucket.deltas.length,
        averageScore,
        averageDelta,
        verdict,
        lesson: signalLesson(label, verdict, averageDelta)
      };
    })
    .sort((a, b) => {
      if (a.verdict === "needs_more_samples" && b.verdict !== "needs_more_samples") return 1;
      if (b.verdict === "needs_more_samples" && a.verdict !== "needs_more_samples") return -1;
      return Math.abs(b.averageDelta) - Math.abs(a.averageDelta);
    })
    .slice(0, 8);
}

function buildFailurePatterns(records: DynamicBacktestRecord[]) {
  const details = records.flatMap((record) => {
    if (record.failureDetails?.length) return record.failureDetails;
    return [
      {
        stage: record.failureStage || "unknown",
        status: "failed",
        label: failureStageLabel(record.failureStage || "unknown"),
        message: record.errorMessage || "README 回测失败",
        retryable: Boolean(record.retryInput?.canRetry),
        at: record.updatedAt
      } satisfies DynamicBacktestFailureDetail
    ];
  });
  const buckets = new Map<string, DynamicBacktestFailureDetail[]>();
  for (const detail of details) {
    const key = `${detail.stage}:${detail.provider || "run"}:${detail.label}`;
    buckets.set(key, [...(buckets.get(key) ?? []), detail]);
  }

  return [...buckets.entries()]
    .map(([key, items]) => {
      const first = items[0];
      return {
        key,
        label: first.label,
        stage: failureStageLabel(first.stage),
        count: items.length,
        retryableCount: items.filter((item) => item.retryable).length,
        example: first.message,
        action: failureAction(first)
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function buildCalibrationActions({
  completedDynamic,
  failedDynamic,
  signalCalibrations,
  failurePatterns
}: {
  completedDynamic: DynamicBacktestRecord[];
  failedDynamic: DynamicBacktestRecord[];
  signalCalibrations: BacktestSignalCalibration[];
  failurePatterns: BacktestFailurePattern[];
}): BacktestCalibrationAction[] {
  const actions: BacktestCalibrationAction[] = [];
  const calibratedCompleted = completedDynamic.filter(
    (record) => record.calibration.result !== "insufficient"
  );
  const minimumSamplesForGlobalUse = 5;
  const missingGlobalSamples = Math.max(0, minimumSamplesForGlobalUse - calibratedCompleted.length);

  if (missingGlobalSamples > 0) {
    actions.push({
      id: "global-sample-floor",
      target: "README 回测总体规则",
      action: "collect_more",
      label: "先补样本",
      confidence: calibratedCompleted.length >= 3 ? "medium" : "low",
      sampleCount: calibratedCompleted.length,
      neededSamples: missingGlobalSamples,
      averageDelta: null,
      recommendedAdjustment: "暂不自动调全局权重",
      reason: `已有 ${calibratedCompleted.length} 个可校准动态样本，低于 ${minimumSamplesForGlobalUse} 个样本门槛。`,
      nextStep: `再跑 ${missingGlobalSamples} 个不同类型的 GitHub README，覆盖强成功、混合和弱后验样本。`
    });
  }

  for (const signal of signalCalibrations) {
    actions.push(calibrationActionFromSignal(signal));
  }

  for (const pattern of failurePatterns.slice(0, 2)) {
    actions.push({
      id: `fix-${pattern.key}`,
      target: pattern.label,
      action: "fix_tooling",
      label: "先修工具链",
      confidence: pattern.count >= 3 ? "high" : "medium",
      sampleCount: pattern.count,
      neededSamples: 0,
      averageDelta: null,
      recommendedAdjustment: "失败样本不进入调权",
      reason: `${pattern.stage} 出现 ${pattern.count} 次失败，其中 ${pattern.retryableCount} 次可重试。`,
      nextStep: pattern.action
    });
  }

  if (!actions.length) {
    actions.push({
      id: "no-dynamic-actions",
      target: "README 回测总体规则",
      action: "hold",
      label: "保持当前规则",
      confidence: "low",
      sampleCount: 0,
      neededSamples: minimumSamplesForGlobalUse,
      averageDelta: null,
      recommendedAdjustment: "继续使用静态校准规则",
      reason: "还没有动态回测样本，不能从样本偏差推出调权建议。",
      nextStep: `先跑 ${minimumSamplesForGlobalUse} 个公开 GitHub repo，形成可比较的后验样本。`
    });
  }

  return actions
    .sort((a, b) => calibrationActionRank(b) - calibrationActionRank(a))
    .slice(0, 8);
}

function calibrationActionFromSignal(
  signal: BacktestSignalCalibration
): BacktestCalibrationAction {
  const minimumSamplesForSignalUse = 3;
  const neededSamples = Math.max(0, minimumSamplesForSignalUse - signal.sampleCount);
  const base = {
    id: `signal-${slugifyActionId(signal.label)}`,
    target: signal.label,
    sampleCount: signal.sampleCount,
    neededSamples,
    averageDelta: signal.averageDelta
  };

  if (signal.verdict === "overweighted") {
    return {
      ...base,
      action: "downweight",
      label: "建议降权",
      confidence: actionConfidence(signal),
      recommendedAdjustment: "README 初判中降低该信号权重，并要求外部采用或反证补齐。",
      reason: `${signal.label} 平均偏差 ${signal.averageDelta}，README 预测高于后验结果。`,
      nextStep: `优先查 ${signal.label} 是否只是表达完整，而没有真实采用、留存、复用或近期增长。`
    };
  }

  if (signal.verdict === "underweighted") {
    return {
      ...base,
      action: "upweight",
      label: "建议升权",
      confidence: actionConfidence(signal),
      recommendedAdjustment: "README 初判中提高该信号权重，但仍要求后验证据确认。",
      reason: `${signal.label} 平均偏差 +${signal.averageDelta}，后验表现持续强于 README 初判。`,
      nextStep: `把 ${signal.label} 作为补查入口，继续找生态采用、外部教程、issue/discussion 和近期 release。`
    };
  }

  if (signal.verdict === "usable") {
    return {
      ...base,
      action: "hold",
      label: "保持权重",
      confidence: actionConfidence(signal),
      neededSamples: 0,
      recommendedAdjustment: "保持当前权重",
      reason: `${signal.label} 与后验基本一致，平均偏差 ${signal.averageDelta}。`,
      nextStep: "继续积累样本；只有连续偏差超过阈值后再调权。"
    };
  }

  return {
    ...base,
    action: "collect_more",
    label: "样本不足",
    confidence: "low",
    recommendedAdjustment: "暂不自动调权",
    reason: `${signal.label} 只有 ${signal.sampleCount} 个可用样本，低于 ${minimumSamplesForSignalUse} 个信号门槛。`,
    nextStep: `再补 ${neededSamples} 个命中「${signal.label}」的 repo 后再判断是否升权或降权。`
  };
}

function countByResult(
  records: DynamicBacktestRecord[],
  result: DynamicBacktestRecord["calibration"]["result"]
) {
  return records.filter((record) => record.calibration.result === result).length;
}

function average(values: number[]) {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function signalVerdict(
  sampleCount: number,
  averageDelta: number
): BacktestSignalCalibration["verdict"] {
  if (sampleCount < 2) return "needs_more_samples";
  if (averageDelta <= -12) return "overweighted";
  if (averageDelta >= 12) return "underweighted";
  return "usable";
}

function actionConfidence(signal: BacktestSignalCalibration): BacktestCalibrationAction["confidence"] {
  if (signal.sampleCount >= 5 && Math.abs(signal.averageDelta) >= 18) return "high";
  if (signal.sampleCount >= 3 || Math.abs(signal.averageDelta) >= 16) return "medium";
  return "low";
}

function calibrationActionRank(action: BacktestCalibrationAction) {
  const actionRank = {
    downweight: 50,
    upweight: 48,
    fix_tooling: 44,
    collect_more: 34,
    hold: 20
  }[action.action];
  const confidenceRank = { high: 9, medium: 5, low: 1 }[action.confidence];
  return actionRank + confidenceRank + Math.min(8, action.sampleCount);
}

function slugifyActionId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function signalLesson(
  label: string,
  verdict: BacktestSignalCalibration["verdict"],
  averageDelta: number
) {
  if (verdict === "overweighted") {
    return `${label} 当前可能被高估，平均偏差 ${averageDelta}；需要补真实采用和反证。`;
  }
  if (verdict === "underweighted") {
    return `${label} 当前可能被低估，平均偏差 +${averageDelta}；后验强时要上调权重。`;
  }
  if (verdict === "usable") {
    return `${label} 与后验基本一致，可继续作为 README 初判信号。`;
  }
  return `${label} 样本不足，先展示但不自动改权重。`;
}

function failureAction(detail: DynamicBacktestFailureDetail) {
  if (detail.stage === "github_import") {
    return "优先校验 repo URL、GitHub API 限流、README 路径和私有仓库权限。";
  }
  if (detail.stage === "posterior_research") {
    return "优先检查搜索 provider key、请求限流和查询是否过宽，必要时只用 GitHub 指标完成后验。";
  }
  if (detail.stage === "readme_prediction") {
    return "优先检查 README 文本抽取和预测规则输入，失败样本不要进入校准统计。";
  }
  if (detail.stage === "calibration") {
    return "优先检查后验分、预测分和校准 delta 是否完整。";
  }
  return "先保留失败样本，定位工具链路后再重新回测。";
}

function failureStageLabel(stage: string | undefined) {
  if (stage === "github_import") return "读取 GitHub/README";
  if (stage === "readme_prediction") return "README 初判";
  if (stage === "posterior_research") return "后验证据搜索";
  if (stage === "calibration") return "校准结果";
  return "未知阶段";
}
