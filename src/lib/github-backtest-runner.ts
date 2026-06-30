import { importGitHubRepositories } from "./github-repository";
import { saveBacktestRecord } from "./storage";
import { collectBacktestPosteriorResearch } from "./web-research";
import type {
  BacktestPredictionDecision,
  DynamicBacktestFailureDetail,
  DynamicBacktestFailureStage,
  EvidenceQueryExecution,
  BacktestSearchProviderComparison,
  BacktestScoreItem,
  DynamicBacktestRecord,
  GitHubRepositorySnapshot,
  UploadedMaterial,
  WebEvidence,
  WebResearchSummary,
  WebSearchProvider
} from "./types";

export async function runDynamicGitHubBacktest(repoUrl: string) {
  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const normalizedRepoUrl = normalizeBacktestRepoUrl(repoUrl);
  let stage: DynamicBacktestFailureStage = "github_import";
  let repository: GitHubRepositorySnapshot | null = null;
  let material: UploadedMaterial | undefined;
  let warnings: string[] = [];
  let failureDetails: DynamicBacktestFailureDetail[] = [];

  try {
    const imported = await importGitHubRepositories({
      urls: [normalizedRepoUrl],
      analysisId: `backtest-${id}`
    });
    repository = imported.repositories[0] ?? null;
    material = imported.materials[0];
    warnings = imported.warnings;

    if (!repository || !material) {
      throw new Error(imported.warnings[0] || "没有读取到可回测的 GitHub README。");
    }

    stage = "readme_prediction";
    const prediction = predictFromReadmeOnly({
      material,
      repository
    });
    const productName = productNameFromReadme(material, repository);

    stage = "posterior_research";
    const posteriorRuns = await runPosteriorProviderComparisons({
      repo: repository.repo,
      productName,
      materials: imported.materials,
      backtestId: id
    });
    failureDetails = posteriorRuns
      .map((run) => run.failureDetail)
      .filter((item): item is DynamicBacktestFailureDetail => Boolean(item));
    const selectedPosteriorRun = selectBestPosteriorRun(posteriorRuns);
    const posteriorEvidenceRun = selectedPosteriorRun ?? posteriorRuns[0];
    const searchComparisons = posteriorRuns.map((run) =>
      comparisonFromResearch(run, Boolean(selectedPosteriorRun && run.provider === selectedPosteriorRun.provider))
    );
    const runtimeTraces = posteriorRuns
      .map((run) =>
        run.research.runtimeTrace
          ? {
              provider: run.provider,
              trace: run.research.runtimeTrace
            }
          : null
      )
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const posterior = buildPosteriorOutcome({
      repository,
      searchResults: posteriorEvidenceRun?.research.searchResults ?? [],
      queryExecutions: posteriorEvidenceRun?.research.queryExecutions ?? [],
      skippedReasons: posteriorEvidenceRun?.research.skippedReasons ?? [],
      selectedProvider: selectedPosteriorRun?.provider,
      searchComparisons,
      runtimeTraces
    });

    stage = "calibration";
    const calibration = calibrateBacktest(prediction.potential, posterior.outcomeScore);
    const record: DynamicBacktestRecord = {
      id,
      createdAt,
      updatedAt: new Date().toISOString(),
      repo: repository.repo,
      repoUrl: repository.repoUrl,
      status: "completed",
      failureDetails: failureDetails.length ? failureDetails : undefined,
      retryInput: buildBacktestRetryInput(repository.repoUrl),
      readmePreview: (material.textPreview || material.extractedText || "").slice(0, 900),
      repository,
      prediction,
      posterior,
      calibration,
      warnings: imported.warnings
    };

    await saveBacktestRecord(record);
    return record;
  } catch (error) {
    const record = failedBacktestRecord({
      id,
      createdAt,
      repoUrl: repository?.repoUrl || normalizedRepoUrl,
      repository,
      material,
      stage,
      error,
      warnings,
      failureDetails
    });
    await saveBacktestRecord(record);
    return record;
  }
}

function predictFromReadmeOnly({
  material,
  repository
}: {
  material: UploadedMaterial;
  repository: GitHubRepositorySnapshot;
}): DynamicBacktestRecord["prediction"] {
  const text = `${repository.description}\n${material.extractedText || ""}`;
  const lower = text.toLowerCase();
  const scoreBreakdown: BacktestScoreItem[] = [
    scoreItem(
      "目标用户清晰度",
      hasAny(lower, ["developer", "team", "founder", "engineer", "designer", "user", "for "]) ||
        /开发者|团队|用户|创始人|设计师|工程师/.test(text),
      14,
      "README 是否直接说明给谁用。"
    ),
    scoreItem(
      "高频任务",
      hasAny(lower, ["workflow", "data", "api", "deploy", "automation", "calendar", "database", "fetching", "monitoring"]) ||
        /流程|数据|接口|部署|自动化|日历|数据库|监控|抓取/.test(text),
      16,
      "是否落在重复发生的工作任务上。"
    ),
    scoreItem(
      "替代方案/差异化",
      hasAny(lower, ["alternative", "open source", "self-hosted", "replace", "vs ", "better than", "competitor"]) ||
        /替代|开源|自托管|对比|竞品|更好/.test(text),
      14,
      "是否说明为什么不用现有方案。"
    ),
    scoreItem(
      "可上手程度",
      hasAny(lower, ["npm install", "pnpm", "yarn", "pip install", "docker", "quick start", "getting started", "curl "]) ||
        /安装|快速开始|部署|示例/.test(text),
      12,
      "README 是否让用户能马上试。"
    ),
    scoreItem(
      "证据与可信度",
      hasAny(lower, ["used by", "customers", "case study", "stars", "sponsor", "production", "trusted"]) ||
        /客户|案例|生产环境|赞助|可信|用户/.test(text),
      10,
      "是否出现外部采用、客户或生产使用信号。"
    ),
    scoreItem(
      "生态和分发",
      repository.stars >= 1000 || repository.forks >= 100 || repository.topics.length >= 3,
      repository.stars >= 10000 ? 18 : repository.stars >= 1000 ? 14 : 8,
      `${repository.stars} stars、${repository.forks} forks、${repository.topics.length} 个 topic。`
    ),
    scoreItem(
      "维护活跃度",
      isRecentlyActive(repository.pushedAt),
      12,
      repository.pushedAt
        ? `最近 push：${repository.pushedAt.slice(0, 10)}。`
        : "没有读取到最近 push 时间。"
    )
  ];
  const penalty = repository.archived || repository.disabled ? 24 : 0;
  const potential = clampScore(
    18 + scoreBreakdown.reduce((sum, item) => sum + item.score, 0) - penalty
  );
  const decision = readmeDecision(potential, repository);

  return {
    potential,
    decision,
    rationale: predictionRationale(scoreBreakdown, repository, potential),
    uncertainty:
      "这是 readme-only 预测，只能判断产品表达、开发者采用和维护迹象；付费、留存、真实用户强度需要后验证据确认。",
    scoreBreakdown
  };
}

function buildPosteriorOutcome({
  repository,
  searchResults,
  queryExecutions,
  skippedReasons,
  selectedProvider,
  searchComparisons,
  runtimeTraces
}: {
  repository: GitHubRepositorySnapshot;
  searchResults: WebEvidence[];
  queryExecutions: DynamicBacktestRecord["posterior"]["queryExecutions"];
  skippedReasons: string[];
  selectedProvider?: WebSearchProvider;
  searchComparisons?: BacktestSearchProviderComparison[];
  runtimeTraces?: DynamicBacktestRecord["posterior"]["runtimeTraces"];
}): DynamicBacktestRecord["posterior"] {
  const supportResults = searchResults.filter(isPosteriorSupport);
  const oppositionResults = searchResults.filter(isPosteriorOpposition);
  const activityScore = isRecentlyActive(repository.pushedAt) ? 14 : -6;
  const starScore =
    repository.stars >= 50000
      ? 38
      : repository.stars >= 10000
        ? 30
        : repository.stars >= 1000
          ? 22
          : repository.stars >= 100
            ? 12
            : 4;
  const forkScore =
    repository.forks >= 3000
      ? 18
      : repository.forks >= 500
        ? 14
        : repository.forks >= 100
          ? 10
          : repository.forks >= 20
            ? 6
            : 2;
  const posteriorSignalScore = supportResults.length * 7 - oppositionResults.length * 9;
  const archivedPenalty = repository.archived || repository.disabled ? 35 : 0;
  const outcomeScore = clampScore(
    18 + starScore + forkScore + activityScore + posteriorSignalScore - archivedPenalty
  );
  const outcomeLabel = posteriorLabel(outcomeScore, oppositionResults.length);
  const evidence = [
    `GitHub 当前 ${repository.stars} stars、${repository.forks} forks、${repository.openIssues} open issues。`,
    repository.pushedAt
      ? `最近 push：${repository.pushedAt.slice(0, 10)}，活跃度 ${isRecentlyActive(repository.pushedAt) ? "可用" : "偏旧"}。`
      : "没有读取到最近 push 时间。",
    ...supportResults.slice(0, 3).map((item) => `支持：${item.title} - ${item.snippet.slice(0, 120)}`),
    ...oppositionResults.slice(0, 3).map((item) => `反证：${item.title} - ${item.snippet.slice(0, 120)}`)
  ];

  return {
    outcomeLabel,
    outcomeScore,
    evidence,
    supportCount: supportResults.length,
    oppositionCount: oppositionResults.length,
    searchResults: searchResults.slice(0, 12),
    queryExecutions,
    skippedReasons,
    selectedProvider,
    searchComparisons,
    runtimeTraces
  };
}

async function runPosteriorProviderComparisons({
  repo,
  productName,
  materials,
  backtestId
}: {
  repo: string;
  productName: string;
  materials: UploadedMaterial[];
  backtestId: string;
}): Promise<Array<{ provider: WebSearchProvider; research: WebResearchSummary; failureDetail?: DynamicBacktestFailureDetail }>> {
  const providers: WebSearchProvider[] = ["zhipu", "serper"];
  const runs = await Promise.all(
    providers.map(async (provider) => {
      try {
        return {
          provider,
          research: await collectBacktestPosteriorResearch({
            repo,
            productName,
            materials,
            provider,
            runtimeId: `backtest-${backtestId}-${provider}`
          })
        };
      } catch (error) {
        const failureDetail = providerFailureDetail(provider, error);
        return {
          provider,
          research: failedProviderResearch(provider, failureDetail.message),
          failureDetail
        };
      }
    })
  );

  return runs;
}

function selectBestPosteriorRun(
  runs: Array<{ provider: WebSearchProvider; research: WebResearchSummary }>
) {
  const ranked = runs
    .slice()
    .sort((a, b) => posteriorResearchRank(b.research) - posteriorResearchRank(a.research));
  const best = ranked[0];
  if (!best || posteriorResearchRank(best.research) <= 0) return undefined;
  return best;
}

function posteriorResearchRank(research: WebResearchSummary) {
  return (
    (research.searchQuality?.qualityScore ?? 0) * 1000 +
    research.searchResults.length * 20 +
    (research.queryExecutions?.filter((item) => item.status === "executed").length ?? 0)
  );
}

function comparisonFromResearch(
  run: { provider: WebSearchProvider; research: WebResearchSummary },
  selected: boolean
): BacktestSearchProviderComparison {
  const quality = run.research.searchQuality;
  const executedQueries = quality?.executedQueries ?? 0;
  const failedQueries = quality?.failedQueries ?? 0;
  const skippedQueries = quality?.skippedQueries ?? 0;
  const status =
    executedQueries > 0
      ? ("executed" as const)
      : failedQueries > 0
        ? ("failed" as const)
        : ("skipped" as const);

  return {
    provider: run.provider,
    status,
    qualityScore: quality?.qualityScore ?? 0,
    totalResults: quality?.totalResults ?? run.research.searchResults.length,
    executedQueries,
    failedQueries,
    skippedQueries,
    querySuccessRate: quality?.querySuccessRate ?? 0,
    urlCoverage: quality?.urlCoverage ?? 0,
    dateCoverage: quality?.dateCoverage ?? 0,
    freshResultRatio: quality?.freshResultRatio ?? 0,
    oppositionResultRatio: quality?.oppositionResultRatio ?? 0,
    selected,
    reason: comparisonReason(run.research, selected),
    warnings: quality?.warnings ?? [],
    skippedReasons: run.research.skippedReasons ?? [],
    sampleResults: run.research.searchResults.slice(0, 3).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet.slice(0, 160)
    }))
  };
}

function failedBacktestRecord({
  id,
  createdAt,
  repoUrl,
  repository,
  material,
  stage,
  error,
  warnings,
  failureDetails
}: {
  id: string;
  createdAt: string;
  repoUrl: string;
  repository: GitHubRepositorySnapshot | null;
  material?: UploadedMaterial;
  stage: DynamicBacktestFailureStage;
  error: unknown;
  warnings: string[];
  failureDetails: DynamicBacktestFailureDetail[];
}): DynamicBacktestRecord {
  const message = errorMessage(error);
  const details = [
    ...failureDetails,
    {
      stage,
      status: "failed" as const,
      label: failureStageLabel(stage),
      message,
      retryable: true,
      at: new Date().toISOString()
    }
  ];

  return {
    id,
    createdAt,
    updatedAt: new Date().toISOString(),
    repo: repository?.repo || repoNameFromUrl(repoUrl),
    repoUrl,
    status: "failed",
    errorMessage: message,
    failureStage: stage,
    failureDetails: details,
    retryInput: buildBacktestRetryInput(repoUrl),
    readmePreview: (material?.textPreview || material?.extractedText || "").slice(0, 900),
    repository,
    prediction: emptyPrediction(stage, message),
    posterior: emptyPosterior(details),
    calibration: emptyCalibration(message),
    warnings
  };
}

function emptyPrediction(
  stage: DynamicBacktestFailureStage,
  message: string
): DynamicBacktestRecord["prediction"] {
  return {
    potential: 0,
    decision: "stop",
    rationale: `回测在「${failureStageLabel(stage)}」失败：${message}`,
    uncertainty: "这条记录只用于失败恢复，不能作为 README 潜力预测样本。",
    scoreBreakdown: []
  };
}

function emptyPosterior(
  failureDetails: DynamicBacktestFailureDetail[]
): DynamicBacktestRecord["posterior"] {
  return {
    outcomeLabel: "insufficient",
    outcomeScore: 0,
    evidence: failureDetails.map((detail) => `${detail.label}：${detail.message}`).slice(0, 5),
    supportCount: 0,
    oppositionCount: 0,
    searchResults: [],
    queryExecutions: [],
    skippedReasons: failureDetails.map((detail) => detail.message),
    searchComparisons: []
  };
}

function emptyCalibration(message: string): DynamicBacktestRecord["calibration"] {
  return {
    result: "insufficient",
    delta: 0,
    lesson: `回测失败，暂不能校准 README 判断规则。失败原因：${message}`
  };
}

function providerFailureDetail(
  provider: WebSearchProvider,
  error: unknown
): DynamicBacktestFailureDetail {
  return {
    stage: "posterior_research",
    status: "failed",
    label: `${backtestProviderLabel(provider)} 后验搜索失败`,
    message: errorMessage(error),
    provider,
    retryable: true,
    at: new Date().toISOString()
  };
}

function failedProviderResearch(
  provider: WebSearchProvider,
  message: string
): WebResearchSummary {
  const queryExecutions: EvidenceQueryExecution[] = [
    {
      queryId: "provider_failure",
      provider,
      status: "failed",
      phase: "seed",
      resultCount: 0,
      reason: message
    }
  ];

  return {
    extractedUrls: [],
    crawled: [],
    searchResults: [],
    skippedReasons: [`${backtestProviderLabel(provider)} 后验搜索失败：${message}`],
    queries: [],
    searchProvider: provider,
    queryPlan: [],
    queryExecutions,
    searchQuality: {
      provider,
      qualityScore: 0,
      plannedQueries: 1,
      executedQueries: 0,
      failedQueries: 1,
      skippedQueries: 0,
      totalResults: 0,
      querySuccessRate: 0,
      urlCoverage: 0,
      dateCoverage: 0,
      freshResultRatio: 0,
      oppositionResultRatio: 0,
      assumptionCoverage: 0,
      averageSnippetLength: 0,
      warnings: [message]
    }
  };
}

function buildBacktestRetryInput(repoUrl: string): DynamicBacktestRecord["retryInput"] {
  const canRetry = /^https:\/\/github\.com\/[^/]+\/[^/\s]+$/i.test(repoUrl);
  return {
    repoUrl,
    canRetry,
    reason: canRetry
      ? "重新运行会重新抓取 GitHub README、repo 指标和后验证据。"
      : "repo URL 不是标准 GitHub 仓库地址，需要重新输入。"
  };
}

function failureStageLabel(stage: DynamicBacktestFailureStage) {
  if (stage === "github_import") return "读取 GitHub/README";
  if (stage === "readme_prediction") return "README 初判";
  if (stage === "posterior_research") return "后验证据搜索";
  if (stage === "calibration") return "校准结果";
  return "未知阶段";
}

function backtestProviderLabel(provider: WebSearchProvider) {
  return provider === "zhipu" ? "智谱" : "Serper";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "README 回测失败";
}

function normalizeBacktestRepoUrl(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:[/?#].*)?$/i);
  if (!match) return trimmed;
  return `https://github.com/${match[1]}/${match[2].replace(/\.git$/i, "")}`;
}

function repoNameFromUrl(repoUrl: string) {
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (!match) return "unknown/repo";
  return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
}

function comparisonReason(research: WebResearchSummary, selected: boolean) {
  if (selected) {
    return `被选为后验依据：质量分 ${research.searchQuality?.qualityScore ?? 0}，结果 ${research.searchResults.length} 条。`;
  }
  if (research.skippedReasons?.length) return research.skippedReasons[0];
  if (!research.searchResults.length) return "没有返回可用后验结果。";
  return `未选中：质量分 ${research.searchQuality?.qualityScore ?? 0}。`;
}

function calibrateBacktest(
  predictionScore: number,
  outcomeScore: number
): DynamicBacktestRecord["calibration"] {
  const delta = outcomeScore - predictionScore;
  if (outcomeScore === 0) {
    return {
      result: "insufficient",
      delta,
      lesson: "后验证据不足，不能校准 README 预测。需要更好的搜索 provider 或手工补证。"
    };
  }
  if (Math.abs(delta) <= 12) {
    return {
      result: "aligned",
      delta,
      lesson: "README 预测和后验结果基本一致，当前规则对这个样本可用。"
    };
  }
  if (delta > 12) {
    return {
      result: "underestimated",
      delta,
      lesson: "README 低估了后续表现，说明应提高生态背书、开发者任务频率或近期采用信号的权重。"
    };
  }
  return {
    result: "overestimated",
    delta,
    lesson: "README 高估了后续表现，说明产品叙事强但后验采用不足，后续判断要更重视真实使用和反证。"
  };
}

function scoreItem(label: string, condition: boolean, score: number, evidence: string) {
  return {
    label,
    score: condition ? score : 0,
    evidence: condition ? evidence : `缺口：${evidence}`
  };
}

function readmeDecision(
  potential: number,
  repository: GitHubRepositorySnapshot
): BacktestPredictionDecision {
  if (repository.archived || repository.disabled) return "stop";
  if (potential >= 86) return "build";
  if (potential >= 56) return "test_first";
  if (potential >= 40) return "reposition";
  return "stop";
}

function predictionRationale(
  scoreBreakdown: BacktestScoreItem[],
  repository: GitHubRepositorySnapshot,
  potential: number
) {
  const strengths = scoreBreakdown
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.label)
    .join("、");
  const gaps = scoreBreakdown
    .filter((item) => item.score === 0)
    .slice(0, 2)
    .map((item) => item.label)
    .join("、");
  return `readme-only 预测 ${potential}/100。主要强项：${strengths || "不明显"}。主要缺口：${gaps || "暂无明显缺口"}。GitHub 当前 ${repository.stars} stars、${repository.forks} forks，仍需后验验证真实采用和商业化。`;
}

function posteriorLabel(
  outcomeScore: number,
  oppositionCount: number
): DynamicBacktestRecord["posterior"]["outcomeLabel"] {
  if (outcomeScore >= 82 && oppositionCount <= 2) return "strong_success";
  if (outcomeScore >= 66) return "promising";
  if (outcomeScore >= 46 || oppositionCount >= 2) return "mixed";
  if (outcomeScore <= 0) return "insufficient";
  return "weak";
}

function productNameFromReadme(
  material: UploadedMaterial,
  repository: GitHubRepositorySnapshot
) {
  const heading = (material.extractedText || "").match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading ? heading.slice(0, 80) : repository.repo;
}

function isPosteriorSupport(item: WebEvidence) {
  const text = `${item.title} ${item.snippet} ${item.url}`.toLowerCase();
  return /funding|customer|customers|users|case study|adoption|stars|launched|growth|yc|techcrunch|product hunt|production|used by|融资|客户|用户|采用|增长|案例|发布/.test(text);
}

function isPosteriorOpposition(item: WebEvidence) {
  const text = `${item.title} ${item.snippet} ${item.url}`.toLowerCase();
  return /shutdown|closed source|closed-source|abandoned|unmaintained|no longer maintained|controversy|lawsuit|security issue|failed|dead|停更|关闭|闭源|争议|失败|安全问题/.test(text);
}

function hasAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function isRecentlyActive(value: string | undefined) {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp <= 548 * 86_400_000;
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
