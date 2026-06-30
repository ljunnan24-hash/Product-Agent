import type {
  ClaimLedger,
  EvidenceBrief,
  EvidenceCard,
  EvidenceCluster,
  ExperimentEvidenceArtifact,
  EvidenceStopRule,
  EvidenceVerdict,
  EvidenceGap,
  EvidenceStop,
  LifecycleEvidenceStandard,
  ProductClaim,
  ProductDecision,
  ProductLifecycleStage,
  SourceBudget,
  UploadedMaterial,
  ValidationExperiment,
  ValidationExperimentResult,
  WebEvidence,
  WebResearchSummary,
  WorkType
} from "./types";

type GenerateEvidenceBriefInput = {
  brief: string;
  materials: UploadedMaterial[];
  webResearch?: WebResearchSummary;
  productName: string;
  visibleText: string;
  workType: WorkType;
};

export function generateEvidenceBrief(
  input: GenerateEvidenceBriefInput
): EvidenceBrief {
  const capturedAt = new Date().toISOString();
  const productLifecycleStage = inferProductLifecycleStage(input.visibleText);
  const lifecycleEvidenceStandard = evidenceStandardForStage(productLifecycleStage);
  const materialCards = evidenceFromMaterials(input.materials, capturedAt);
  const webCards = evidenceFromWebResearch(input.webResearch, capturedAt);
  const evidenceCards = [...materialCards, ...webCards];
  const supportCards = evidenceCards.filter((card) => card.direction === "support");
  const opposeCards = evidenceCards.filter((card) => card.direction === "oppose");
  const objectiveEvidenceRatio = ratio(
    evidenceCards.filter(
      (card) =>
        card.objectiveLevel === "observed_fact" ||
        card.objectiveLevel === "evidence_interpretation"
    ).length,
    evidenceCards.length
  );
  const unknownRecencyRatio = ratio(
    evidenceCards.filter((card) => card.recencyBucket === "unknown_recency").length,
    evidenceCards.length
  );
  const currentEvidenceRatio = ratio(
    evidenceCards.filter(
      (card) =>
        card.recencyBucket === "fresh" || card.recencyBucket === "usable"
    ).length,
    evidenceCards.length
  );
  const staleEvidenceCount = evidenceCards.filter(
    (card) => card.recencyBucket === "historical"
  ).length;
  const claims = buildClaims(input, evidenceCards);
  const claimLedger = buildClaimLedger(claims, capturedAt);
  const evidenceGaps = buildEvidenceGaps(claims, evidenceCards, lifecycleEvidenceStandard);
  const sourceBudgets = buildSourceBudgets(
    evidenceCards,
    input.webResearch?.queryPlan,
    lifecycleEvidenceStandard
  );
  const recommendedExperiment = designExperiment(input, evidenceGaps);
  const clusters = buildClusters(evidenceCards, evidenceGaps);
  const sourceDiversityScore = Math.min(
    100,
    new Set(evidenceCards.map((card) => card.sourceType)).size * 22
  );
  const behaviorStrengthScore = Math.round(
    average(evidenceCards.map((card) => card.behaviorStrength)) * (100 / 7)
  );
  const recencyScore = Math.round(
    average(evidenceCards.map((card) => card.recencyScore))
  );
  const temporalValidityScore = Math.round(
    average(evidenceCards.map((card) => card.recencyScore * card.lifecycleRelevance))
  );
  const assumptionCoverageScore = Math.round(
    ratio(
      claims.filter((claim) => claim.status !== "unverified").length,
      claims.length
    ) * 100
  );
  const sourceBudgetScore = Math.round(
    ratio(sourceBudgets.filter((budget) => budget.status === "met").length, sourceBudgets.length) *
      100
  );
  const supportOppositionBalanceScore = opposeCards.length > 0 ? 85 : 50;
  const confidenceScore = capConfidence(
    Math.round(
      assumptionCoverageScore * 0.18 +
        sourceDiversityScore * 0.12 +
        behaviorStrengthScore * 0.2 +
        objectiveEvidenceRatio * 100 * 0.14 +
        temporalValidityScore * 0.14 +
        supportOppositionBalanceScore * 0.1 +
        60 * 0.08 +
        72 * 0.04
    ),
    {
      evidenceCards,
      webCards,
      supportCards,
      objectiveEvidenceRatio,
      unknownRecencyRatio,
      lifecycleEvidenceStandard
    }
  );
  const evidenceStop = shouldStopStrongDecision({
    evidenceCards,
    webCards,
    opposeCards,
    objectiveEvidenceRatio,
    unknownRecencyRatio,
    sourceBudgets,
    recommendedExperiment,
    lifecycleEvidenceStandard
  });
  const decision = decide({
    confidenceScore,
    evidenceStop,
    claims,
    supportCards,
    opposeCards
  });

  return {
    productName: input.productName,
    productLifecycleStage,
    lifecycleEvidenceStandard,
    claimLedger,
    evidenceStop,
    evidenceVerdict: verdictFor(confidenceScore, supportCards, opposeCards, evidenceStop),
    confidenceScore,
    supportScore: weightedCardScore(supportCards),
    oppositionScore: weightedCardScore(opposeCards),
    sourceDiversityScore,
    behaviorStrengthScore,
    recencyScore,
    temporalValidityScore,
    objectiveEvidenceRatio: Math.round(objectiveEvidenceRatio * 100),
    currentEvidenceRatio: Math.round(currentEvidenceRatio * 100),
    staleEvidenceCount,
    assumptionCoverageScore,
    sourceBudgetScore,
    keyEvidenceClusters: clusters,
    evidenceCards,
    sourceBudgets,
    strongestSupport: supportCards
      .sort((a, b) => cardWeight(b) - cardWeight(a))
      .slice(0, 5),
    strongestOpposition: opposeCards
      .sort((a, b) => cardWeight(b) - cardWeight(a))
      .slice(0, 5),
    evidenceGaps,
    decision,
    recommendedExperiment
  };
}

export function applyExperimentResultToEvidenceBrief(
  evidenceBrief: EvidenceBrief,
  result: ValidationExperimentResult
): EvidenceBrief {
  const lifecycleEvidenceStandard =
    evidenceBrief.lifecycleEvidenceStandard ??
    evidenceStandardForStage(evidenceBrief.productLifecycleStage ?? "unknown");
  const existingCards = Array.isArray(evidenceBrief.evidenceCards)
    ? evidenceBrief.evidenceCards
    : [];
  const existingGaps = Array.isArray(evidenceBrief.evidenceGaps)
    ? evidenceBrief.evidenceGaps
    : [];
  const experiment = {
    ...evidenceBrief.recommendedExperiment,
    status: "completed" as const,
    result
  };
  const assumptionId = experiment.assumptionId || "problem";
  const resultCard = makeExperimentResultCard({
    experiment,
    result,
    assumptionId
  });
  const resultCards = [
    resultCard,
    ...makeExperimentArtifactCards({
      experiment,
      result,
      assumptionId
    })
  ];
  const resultCardIds = new Set(resultCards.map((card) => card.id));
  const evidenceCards = [
    ...existingCards.filter((card) => !resultCardIds.has(card.id)),
    ...resultCards
  ];
  const supportCards = evidenceCards.filter((card) => card.direction === "support");
  const opposeCards = evidenceCards.filter((card) => card.direction === "oppose");
  const webCards = evidenceCards.filter((card) => card.sourceType !== "uploaded_material");
  const objectiveEvidenceRatio = ratio(
    evidenceCards.filter(
      (card) =>
        card.objectiveLevel === "observed_fact" ||
        card.objectiveLevel === "evidence_interpretation"
    ).length,
    evidenceCards.length
  );
  const unknownRecencyRatio = ratio(
    evidenceCards.filter((card) => card.recencyBucket === "unknown_recency").length,
    evidenceCards.length
  );
  const currentEvidenceRatio = ratio(
    evidenceCards.filter(
      (card) => card.recencyBucket === "fresh" || card.recencyBucket === "usable"
    ).length,
    evidenceCards.length
  );
  const staleEvidenceCount = evidenceCards.filter(
    (card) => card.recencyBucket === "historical"
  ).length;
  const sourceBudgets = updateSourceBudgetsWithExperimentCards(
    normalizeSourceBudgets(evidenceBrief, existingCards),
    resultCards
  );
  const baseClaims = normalizeClaims(evidenceBrief, existingCards);
  const claims = updateClaimsWithExperimentCards(
    baseClaims,
    resultCards,
    experiment.expectedConfidenceGain
  );
  const claimLedger = buildClaimLedger(claims, result.completedAt);
  const sourceDiversityScore = Math.min(
    100,
    new Set(evidenceCards.map((card) => card.sourceType)).size * 22
  );
  const behaviorStrengthScore = Math.round(
    average(evidenceCards.map((card) => card.behaviorStrength)) * (100 / 7)
  );
  const recencyScore = Math.round(average(evidenceCards.map((card) => card.recencyScore)));
  const temporalValidityScore = Math.round(
    average(evidenceCards.map((card) => card.recencyScore * card.lifecycleRelevance))
  );
  const assumptionCoverageScore = Math.round(
    ratio(claims.filter((claim) => claim.status !== "unverified").length, claims.length) *
      100
  );
  const sourceBudgetScore = Math.round(
    ratio(sourceBudgets.filter((budget) => budget.status === "met").length, sourceBudgets.length) *
      100
  );
  const supportOppositionBalanceScore = opposeCards.length > 0 ? 85 : 50;
  const confidenceScore = capConfidence(
    Math.round(
      assumptionCoverageScore * 0.18 +
        sourceDiversityScore * 0.12 +
        behaviorStrengthScore * 0.2 +
        objectiveEvidenceRatio * 100 * 0.14 +
        temporalValidityScore * 0.14 +
        supportOppositionBalanceScore * 0.1 +
        sourceBudgetScore * 0.08 +
        recencyScore * 0.04
    ),
    {
      evidenceCards,
      webCards,
      supportCards,
      objectiveEvidenceRatio,
      unknownRecencyRatio,
      lifecycleEvidenceStandard
    }
  );
  const recommendedExperiment = experiment;
  const evidenceStop = shouldStopStrongDecision({
    evidenceCards,
    webCards,
    opposeCards,
    objectiveEvidenceRatio,
    unknownRecencyRatio,
    sourceBudgets,
    recommendedExperiment,
    lifecycleEvidenceStandard
  });
  const decision = decide({
    confidenceScore,
    evidenceStop,
    claims,
    supportCards,
    opposeCards
  });

  return {
    ...evidenceBrief,
    lifecycleEvidenceStandard,
    claimLedger,
    evidenceStop,
    evidenceVerdict: verdictFor(confidenceScore, supportCards, opposeCards, evidenceStop),
    confidenceScore,
    supportScore: weightedCardScore(supportCards),
    oppositionScore: weightedCardScore(opposeCards),
    sourceDiversityScore,
    behaviorStrengthScore,
    recencyScore,
    temporalValidityScore,
    objectiveEvidenceRatio: Math.round(objectiveEvidenceRatio * 100),
    currentEvidenceRatio: Math.round(currentEvidenceRatio * 100),
    staleEvidenceCount,
    assumptionCoverageScore,
    sourceBudgetScore,
    evidenceCards,
    sourceBudgets,
    strongestSupport: supportCards
      .sort((a, b) => cardWeight(b) - cardWeight(a))
      .slice(0, 5),
    strongestOpposition: opposeCards
      .sort((a, b) => cardWeight(b) - cardWeight(a))
      .slice(0, 5),
    keyEvidenceClusters: buildClusters(
      evidenceCards,
      existingGaps.filter((gap) => gap.assumptionId !== assumptionId)
    ),
    evidenceGaps: existingGaps.filter((gap) => gap.assumptionId !== assumptionId),
    decision,
    recommendedExperiment
  };
}

function normalizeClaims(
  evidenceBrief: EvidenceBrief,
  evidenceCards: EvidenceCard[]
): ProductClaim[] {
  if (Array.isArray(evidenceBrief.claimLedger?.claims)) {
    return evidenceBrief.claimLedger.claims;
  }

  return buildClaims(
    {
      brief: "",
      materials: [],
      productName: evidenceBrief.productName || "该产品",
      visibleText: "",
      workType: "other"
    },
    evidenceCards
  );
}

function normalizeSourceBudgets(
  evidenceBrief: EvidenceBrief,
  evidenceCards: EvidenceCard[]
): SourceBudget[] {
  if (Array.isArray(evidenceBrief.sourceBudgets) && evidenceBrief.sourceBudgets.length) {
    return evidenceBrief.sourceBudgets;
  }
  return buildSourceBudgets(
    evidenceCards,
    [],
    evidenceBrief.lifecycleEvidenceStandard ??
      evidenceStandardForStage(evidenceBrief.productLifecycleStage ?? "unknown")
  );
}

function evidenceFromMaterials(
  materials: UploadedMaterial[],
  capturedAt: string
): EvidenceCard[] {
  return materials.slice(0, 12).map((material, index) => {
    const hasText = Boolean(material.textPreview || material.extractedText);
    return makeCard({
      id: `material-${index + 1}`,
      assumptionId: "input-materials",
      sourceTitle: material.name,
      sourceUrl: material.url,
      sourceType: material.sourceKind ?? "uploaded_material",
      capturedAt,
      recencyBucket: "fresh",
      objectiveLevel: "observed_fact",
      claim:
        material.sourceKind === "github_readme"
          ? `系统读取了 ${material.name}，类型为 ${material.type || "unknown"}。`
          : `用户上传了 ${material.name}，类型为 ${material.type || "unknown"}。`,
      signalType: hasText ? "claim" : "source",
      direction: "neutral",
      behaviorStrength: 1,
      quoteOrSnippet:
        material.textPreview?.slice(0, 260) ||
        `文件大小 ${Math.round(material.size / 1024)}KB。`,
      interpretation: hasText
        ? material.sourceKind === "github_readme"
          ? "这是公开 README，可证明产品表达和开发者面向叙事，但不等同于用户需求。"
          : "这是产品命题输入材料，不等同于外部市场证据。"
        : "该材料可用于理解产品，但不能证明市场需求。",
      caveat:
        material.sourceKind === "github_readme"
          ? "GitHub README 通常来自项目方，适合作为产品能力和表达证据，市场结论需要外部后验校准。"
          : "上传材料主要来自用户或产品方，不能直接当作市场事实。",
      relevanceScore: 0.75,
      credibilityScore: material.sourceKind === "github_readme" ? 0.56 : 0.45
    });
  });
}

function evidenceFromWebResearch(
  webResearch: WebResearchSummary | undefined,
  capturedAt: string
): EvidenceCard[] {
  const sources = dedupeWebResearchSources([
    ...(webResearch?.crawled ?? []),
    ...(webResearch?.searchResults ?? [])
  ])
    .sort((a, b) => webEvidencePriority(b) - webEvidencePriority(a))
    .slice(0, 40);

  return sources.map((source, index) => {
    const classification = classifyWebEvidence(source);
    return makeCard({
      id: `web-${index + 1}`,
      assumptionId: classification.assumptionId,
      sourceTitle: source.title,
      sourceUrl: source.url,
      sourceType: source.sourceType,
      publishedAt: source.publishedAt,
      updatedAt: source.updatedAt,
      capturedAt,
      recencyBucket: source.recencyBucket ?? "unknown_recency",
      objectiveLevel: "evidence_interpretation",
      claim: classification.claim,
      signalType: classification.signalType,
      direction: classification.direction,
      behaviorStrength: classification.behaviorStrength,
      quoteOrSnippet: source.snippet.slice(0, 320) || source.title,
      interpretation: classification.interpretation,
      caveat: caveatForWebEvidence(source),
      relevanceScore: classification.relevanceScore,
      credibilityScore: credibilityForWebEvidence(source)
    });
  });
}

function dedupeWebResearchSources(sources: WebEvidence[]) {
  const byKey = new Map<string, WebEvidence>();
  for (const source of sources) {
    const key = source.url ? normalizedEvidenceUrl(source.url) : `${source.sourceType}:${source.title}`;
    const existing = byKey.get(key);
    if (!existing || webSourceDetailScore(source) > webSourceDetailScore(existing)) {
      byKey.set(key, source);
    }
  }
  return [...byKey.values()];
}

function webSourceDetailScore(source: WebEvidence) {
  return (
    (source.sourceType === "crawled_url" ? 30 : 0) +
    (source.sourceType === "github_repository" ? 28 : 0) +
    (source.updatedAt || source.publishedAt ? 12 : 0) +
    Math.min(20, Math.round(source.snippet.length / 120))
  );
}

function normalizedEvidenceUrl(url: string) {
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

function webEvidencePriority(source: WebEvidence) {
  const phaseWeight =
    source.searchPhase === "evidence_loop"
      ? 30
      : source.searchPhase === "budget_fill"
        ? 20
        : source.sourceType === "github_repository"
          ? 22
          : source.sourceType === "crawled_url"
            ? 18
            : 10;
  const targetWeight =
    source.searchTarget === "opposition" || source.searchIntent === "opposition"
      ? 6
      : source.searchTarget === "freshness"
        ? 4
        : 0;
  const recencyWeight =
    source.recencyBucket === "fresh"
      ? 5
      : source.recencyBucket === "usable"
        ? 3
        : source.recencyBucket === "historical"
          ? 1
          : 0;
  return phaseWeight + targetWeight + recencyWeight;
}

function caveatForWebEvidence(source: WebEvidence) {
  if (source.sourceType === "github_repository") {
    return source.updatedAt
      ? `GitHub API 返回仓库公开指标，最近代码活动日期 ${source.updatedAt}；这是开发者采用和项目活跃信号，不等同于付费需求。`
      : "GitHub API 返回仓库公开指标；这是开发者采用和项目活跃信号，不等同于付费需求。";
  }
  if (!source.url && source.searchProvider === "zhipu") {
    return source.publishedAt
      ? `智谱返回了摘要和发布时间 ${source.publishedAt}，但缺少原始 URL，需降权使用。`
      : "智谱返回了摘要但缺少原始 URL 和发布时间，只能作为低置信候选信号。";
  }
  if (source.updatedAt && source.publishedAt) {
    return `该网页证据识别到发布时间 ${source.publishedAt}，更新时间 ${source.updatedAt}，日期来源：${dateSourceLabel(source.dateSource)}。`;
  }
  if (source.updatedAt) {
    return `该网页证据识别到更新时间 ${source.updatedAt}，日期来源：${dateSourceLabel(source.dateSource)}。`;
  }
  if (source.publishedAt) {
    return `该网页证据发布时间识别为 ${source.publishedAt}，日期来源：${dateSourceLabel(source.dateSource)}。`;
  }
  return "该网页证据尚未确认发布时间，当前只能作为低到中等置信的公开信号。";
}

function dateSourceLabel(source: string | undefined) {
  if (!source) return "搜索摘要或文本解析";
  if (source.includes("html")) return "网页元数据";
  return source;
}

function credibilityForWebEvidence(source: WebEvidence) {
  if (source.sourceType === "github_repository") return 0.72;
  if (source.sourceType === "crawled_url") return 0.58;
  if (source.searchProvider === "zhipu") return source.url ? 0.54 : 0.38;
  return 0.5;
}

function classifyGitHubRepositoryEvidence(source: WebEvidence) {
  const stars = numberAfterLabel(source.snippet, "Stars");
  const forks = numberAfterLabel(source.snippet, "Forks");
  const isArchived = /repository status:\s*archived/i.test(source.snippet);
  const activeRecently =
    source.recencyBucket === "fresh" || source.recencyBucket === "usable";
  const direction =
    isArchived || (!activeRecently && stars < 100)
      ? ("neutral" as const)
      : stars >= 100 || forks >= 20
        ? ("support" as const)
        : ("neutral" as const);
  const behaviorStrength =
    stars >= 5000
      ? (6 as const)
      : stars >= 1000
        ? (5 as const)
        : stars >= 100 || forks >= 20
          ? (4 as const)
          : (2 as const);

  return {
    assumptionId: "distribution",
    claim: `GitHub 仓库显示 ${stars} stars、${forks} forks，代码活动时效为 ${source.recencyBucket ?? "unknown"}。`,
    signalType: "developer_adoption_signal",
    direction,
    behaviorStrength,
    interpretation: isArchived
      ? "仓库已归档，说明后续维护或增长可能停止；只能作为历史参考。"
      : direction === "support"
        ? "GitHub stars/forks 和近期活动说明有开发者关注或采用迹象，但仍需验证真实用户、使用频率和商业化。"
        : "GitHub 指标可证明项目存在，但当前强度不足以单独支撑市场潜力判断。",
    relevanceScore: stars >= 1000 ? 0.72 : stars >= 100 ? 0.62 : 0.48
  };
}

function numberAfterLabel(text: string, label: string) {
  const match = text.match(new RegExp(`${label}:\\s*([\\d,]+)`, "i"));
  if (!match?.[1]) return 0;
  return Number(match[1].replace(/,/g, "")) || 0;
}

function classifyWebEvidence(source: WebEvidence) {
  const text = `${source.title} ${source.url} ${source.snippet}`.toLowerCase();
  if (source.sourceType === "github_repository") {
    return classifyGitHubRepositoryEvidence(source);
  }
  const hasPayment = /pricing|price|paid|subscription|付费|价格|定价|\$/.test(text);
  const hasReview = /review|rating|g2|capterra|评价|评论|差评/.test(text);
  const hasAlternative = /alternative|competitor|compare|替代|竞品|对比/.test(text);
  const hasFailure = /failed|failure|shutdown|closed|dead|abandoned|discontinued|sunset|失败|关闭|停运|下线|废弃/.test(text);
  const hasPriceResistance = /too expensive|not worth paying|not worth it|pricey|overpriced|太贵|不值得付费|价格高|免费替代/.test(text);
  const hasNoDemand = /no demand|not a problem|nobody needs|no one needs|没有需求|不是问题|没人需要/.test(text);
  const hasLowPriority = /low priority|nice to have|infrequent|rarely|低优先级|低频|不常用/.test(text);
  const hasStrongIncumbent = /incumbent|switching cost|better alternative|already use|hard to switch|迁移成本|已有方案|强竞品/.test(text);
  const hasDistributionRisk = /hard to reach|acquisition cost|channel saturated|crowded market|获客成本|渠道拥挤|触达难|市场拥挤/.test(text);
  const hasComplaint = /problem|pain|struggle|complain|hate|抱怨|痛点/.test(text) || hasPriceResistance || hasFailure;
  const isNegative =
    hasFailure ||
    hasPriceResistance ||
    hasNoDemand ||
    hasLowPriority ||
    hasStrongIncumbent ||
    hasDistributionRisk ||
    /complain|hate|差评|抱怨/.test(text);

  if (source.searchIntent) {
    const planned = classifyPlannedSearchEvidence(source, {
      hasPayment,
      hasReview,
      hasAlternative,
      hasComplaint,
      hasFailure,
      hasPriceResistance,
      hasNoDemand,
      hasLowPriority,
      hasStrongIncumbent,
      hasDistributionRisk,
      isNegative
    });
    if (planned) return planned;
  }

  if (hasComplaint && (text.includes("failed") || text.includes("shutdown") || text.includes("失败"))) {
    return {
      assumptionId: "opposition",
      claim: "公开网页中出现失败、关闭或负面相关信号。",
      signalType: "failure_case",
      direction: "oppose" as const,
      behaviorStrength: 4 as const,
      interpretation:
        "这类信号可能说明同类需求存在风险，需要检查失败原因是否仍然成立。",
      relevanceScore: 0.62
    };
  }

  if (hasPayment) {
    return {
      assumptionId: "payment",
      claim: "公开网页中出现定价、付费或商业化相关信号。",
      signalType: "pricing",
      direction: "support" as const,
      behaviorStrength: 5 as const,
      interpretation:
        "付费或定价页面说明相邻问题可能存在商业化尝试，但还不能证明当前产品会被购买。",
      relevanceScore: 0.72
    };
  }

  if (hasReview) {
    return {
      assumptionId: "competitor",
      claim: "公开网页中出现评价、评论或竞品反馈相关信号。",
      signalType: "negative_review",
      direction: hasComplaint ? ("oppose" as const) : ("support" as const),
      behaviorStrength: 6 as const,
      interpretation:
        "真实评价比趋势文章更接近用户行为，但需要确认用户是否匹配目标人群。",
      relevanceScore: 0.68
    };
  }

  if (hasAlternative) {
    return {
      assumptionId: "alternative",
      claim: "公开网页中出现替代方案、竞品或对比相关信号。",
      signalType: "comparison",
      direction: "support" as const,
      behaviorStrength: 4 as const,
      interpretation:
        "替代方案存在通常说明用户已经在寻找解决路径，也意味着差异化需要更清楚。",
      relevanceScore: 0.66
    };
  }

  if (hasComplaint) {
    return {
      assumptionId: "problem",
      claim: "公开网页中出现问题、痛点或抱怨相关文本。",
      signalType: "complaint",
      direction: "support" as const,
      behaviorStrength: 3 as const,
      interpretation:
        "抱怨信号说明问题可能存在，但公开文本还需要更多来源交叉验证。",
      relevanceScore: 0.6
    };
  }

  return {
    assumptionId: "market-context",
    claim: "公开网页提供了相邻市场或产品上下文。",
    signalType: "claim",
    direction: "neutral" as const,
    behaviorStrength: 2 as const,
    interpretation:
      "该信号有助于理解市场语境，但不能单独支撑潜力判断。",
    relevanceScore: 0.45
  };
}

function classifyPlannedSearchEvidence(
  source: WebEvidence,
  signals: {
    hasPayment: boolean;
    hasReview: boolean;
    hasAlternative: boolean;
    hasComplaint: boolean;
    hasFailure: boolean;
    hasPriceResistance: boolean;
    hasNoDemand: boolean;
    hasLowPriority: boolean;
    hasStrongIncumbent: boolean;
    hasDistributionRisk: boolean;
    isNegative: boolean;
  }
) {
  if (source.searchIntent === "opposition") {
    const opposition = oppositionSignalFor(source.assumptionId || "opposition", signals);
    return {
      assumptionId: source.assumptionId || "opposition",
      claim: opposition.claim,
      signalType: opposition.signalType,
      direction: opposition.direction,
      behaviorStrength: opposition.behaviorStrength,
      interpretation: opposition.interpretation,
      relevanceScore: opposition.relevanceScore
    };
  }

  if (source.searchIntent === "payment") {
    return {
      assumptionId: "payment",
      claim: signals.hasPayment
        ? "付费查询命中了定价、订阅或商业化相关信号。"
        : "付费查询命中了候选来源，但还没有明确付费信号。",
      signalType: signals.hasPayment ? "pricing" : "payment_candidate",
      direction: signals.hasPayment ? ("support" as const) : ("neutral" as const),
      behaviorStrength: signals.hasPayment ? (5 as const) : (2 as const),
      interpretation: signals.hasPayment
        ? "付费信号说明相邻问题可能存在商业化空间。"
        : "需要打开来源确认是否有预算、价格、购买或付费意图。",
      relevanceScore: signals.hasPayment ? 0.74 : 0.5
    };
  }

  if (source.searchIntent === "alternative") {
    return {
      assumptionId: "alternative",
      claim: "替代方案查询命中了竞品、对比或相邻解决方案候选。",
      signalType: signals.hasAlternative ? "comparison" : "alternative_candidate",
      direction: "support" as const,
      behaviorStrength: signals.hasAlternative ? (4 as const) : (3 as const),
      interpretation:
        "替代方案存在通常说明用户已经在解决该问题，但也会提高差异化要求。",
      relevanceScore: signals.hasAlternative ? 0.68 : 0.56
    };
  }

  if (source.searchIntent === "competitor_review") {
    return {
      assumptionId: "competitor",
      claim: "评价查询命中了评论、评分或用户反馈候选。",
      signalType: signals.hasReview ? "review" : "review_candidate",
      direction: signals.hasComplaint ? ("oppose" as const) : ("support" as const),
      behaviorStrength: signals.hasReview ? (6 as const) : (3 as const),
      interpretation:
        "评价类证据接近真实用户行为，但需要确认评价对象和目标用户是否匹配。",
      relevanceScore: signals.hasReview ? 0.7 : 0.54
    };
  }

  if (source.searchIntent === "problem") {
    return {
      assumptionId: "problem",
      claim: "痛点查询命中了问题、需求或 workaround 候选。",
      signalType: signals.hasComplaint ? "complaint" : "pain_candidate",
      direction: "support" as const,
      behaviorStrength: signals.hasComplaint ? (4 as const) : (3 as const),
      interpretation:
        "这说明有机会继续验证目标用户是否真的频繁遇到该问题。",
      relevanceScore: signals.hasComplaint ? 0.64 : 0.55
    };
  }

  if (source.searchIntent === "distribution") {
    return {
      assumptionId: "distribution",
      claim: "分发查询命中了社区、发布渠道或受众聚集地候选。",
      signalType: "distribution_channel",
      direction: "support" as const,
      behaviorStrength: 3 as const,
      interpretation:
        "渠道存在不等于可获客，需要后续用发布测试验证点击、回复和留资。",
      relevanceScore: 0.58
    };
  }

  if (source.searchIntent === "recency") {
    return {
      assumptionId: "timing",
      claim: source.publishedAt
        ? "时效查询命中了带日期的近期或历史市场信号。"
        : "时效查询命中了候选来源，但日期尚未被识别。",
      signalType: "timing_signal",
      direction: source.recencyBucket === "fresh" ? ("support" as const) : ("neutral" as const),
      behaviorStrength: source.recencyBucket === "fresh" ? (4 as const) : (2 as const),
      interpretation:
        "产品生命周期判断需要当前证据；过旧或无日期证据只能低权重使用。",
      relevanceScore: source.publishedAt ? 0.62 : 0.46
    };
  }

  if (source.searchIntent === "ai_advantage") {
    return {
      assumptionId: "ai-advantage",
      claim: "AI 优势查询命中了自动化、Agent 或工作流相关候选。",
      signalType: "ai_advantage_candidate",
      direction: "neutral" as const,
      behaviorStrength: 2 as const,
      interpretation:
        "这能帮助判断 AI 是否形成真实优势，但不能单独证明需求或付费。",
      relevanceScore: 0.5
    };
  }

  return null;
}

function oppositionSignalFor(
  assumptionId: string,
  signals: {
    hasFailure: boolean;
    hasPriceResistance: boolean;
    hasNoDemand: boolean;
    hasLowPriority: boolean;
    hasStrongIncumbent: boolean;
    hasDistributionRisk: boolean;
    isNegative: boolean;
  }
) {
  if (signals.hasFailure) {
    return {
      claim: "反证查询命中了失败、关闭、停运或废弃相关信号。",
      signalType: "failure_case",
      direction: "oppose" as const,
      behaviorStrength: 5 as const,
      interpretation: "优先阅读失败原因，判断它是否同样适用于当前产品命题。",
      relevanceScore: 0.72
    };
  }

  if (assumptionId === "payment" && signals.hasPriceResistance) {
    return {
      claim: "付费反证查询命中了太贵、不值得付费或免费替代相关信号。",
      signalType: "price_resistance",
      direction: "oppose" as const,
      behaviorStrength: 5 as const,
      interpretation: "这会直接削弱付费意愿假设，需要验证用户愿意为哪一档价值付费。",
      relevanceScore: 0.74
    };
  }

  if (assumptionId === "problem" && signals.hasNoDemand) {
    return {
      claim: "痛点反证查询命中了无需求、不是问题或没人需要相关信号。",
      signalType: "no_demand",
      direction: "oppose" as const,
      behaviorStrength: 5 as const,
      interpretation: "这会直接挑战痛点真实性，需要用访谈或行为数据确认问题是否真的存在。",
      relevanceScore: 0.74
    };
  }

  if (assumptionId === "problem" && signals.hasLowPriority) {
    return {
      claim: "痛点反证查询命中了低优先级、低频或 nice-to-have 相关信号。",
      signalType: "low_priority",
      direction: "oppose" as const,
      behaviorStrength: 4 as const,
      interpretation: "低频问题可能仍有价值，但需要更强付费或高客单价场景支撑。",
      relevanceScore: 0.68
    };
  }

  if (assumptionId === "alternative" && signals.hasStrongIncumbent) {
    return {
      claim: "替代方案反证查询命中了强替代、已有方案或迁移成本相关信号。",
      signalType: "strong_incumbent",
      direction: "oppose" as const,
      behaviorStrength: 5 as const,
      interpretation: "这会提高差异化门槛，需要证明当前产品有足够尖锐的 wedge。",
      relevanceScore: 0.72
    };
  }

  if (assumptionId === "distribution" && signals.hasDistributionRisk) {
    return {
      claim: "分发反证查询命中了触达难、渠道拥挤或获客成本相关信号。",
      signalType: "distribution_risk",
      direction: "oppose" as const,
      behaviorStrength: 4 as const,
      interpretation: "这会削弱低成本获客假设，需要先做渠道 smoke test。",
      relevanceScore: 0.68
    };
  }

  if (signals.isNegative) {
    return {
      claim: "反证查询命中了负面或风险相关信号。",
      signalType: "opposition_signal",
      direction: "oppose" as const,
      behaviorStrength: 4 as const,
      interpretation: "该来源可能揭示当前产品命题的风险，需要进一步确认来源相关性。",
      relevanceScore: 0.62
    };
  }

  return {
    claim: "反证查询命中了候选来源，但尚未确认存在真实负面证据。",
    signalType: "opposition_candidate",
    direction: "neutral" as const,
    behaviorStrength: 2 as const,
    interpretation: "这是反证搜索的候选入口，不能直接当作产品不成立的证据。",
    relevanceScore: 0.48
  };
}

function buildClaims(
  input: GenerateEvidenceBriefInput,
  cards: EvidenceCard[]
): ProductClaim[] {
  const materialIds = cards
    .filter((card) => card.sourceType === "uploaded_material")
    .map((card) => card.id);
  const webSupportIds = cards
    .filter((card) => card.sourceType !== "uploaded_material" && card.direction === "support")
    .map((card) => card.id);
  const webEvidenceIds = cards
    .filter((card) => card.sourceType !== "uploaded_material")
    .map((card) => card.id);
  const paymentIds = cards
    .filter((card) => card.assumptionId === "payment" && card.direction === "support")
    .map((card) => card.id);
  const opposeIds = cards
    .filter((card) => card.direction === "oppose")
    .map((card) => card.id);

  return [
    makeClaim({
      id: "claim-product-thesis",
      text: `${input.productName} 的产品命题可以从上传材料中初步重建。`,
      claimType: "problem",
      objectiveLevel: materialIds.length ? "evidence_interpretation" : "hypothesis",
      supportEvidenceIds: materialIds,
      opposeEvidenceIds: [],
      status: materialIds.length ? "supported" : "unverified",
      confidence: materialIds.length ? 52 : 20,
      whyItMatters: "没有清楚命题，就无法判断证据是否匹配正确用户和场景。",
      whatWouldChangeThisClaim: ["补充更清晰的一句话定位、目标用户和使用场景。"]
    }),
    makeClaim({
      id: "claim-external-signal",
      text: "当前存在一定公开外部信号可用于辅助判断。",
      claimType: "timing",
      objectiveLevel: webEvidenceIds.length ? "evidence_interpretation" : "hypothesis",
      supportEvidenceIds: webSupportIds,
      opposeEvidenceIds: opposeIds,
      status: webEvidenceIds.length
        ? opposeIds.length && webSupportIds.length
          ? "mixed"
          : opposeIds.length
            ? "opposed"
            : webSupportIds.length
              ? "supported"
              : "unverified"
        : "unverified",
      confidence: webEvidenceIds.length ? 44 : 18,
      whyItMatters: "产品潜力不能只靠上传材料，需要外部市场信号校准。",
      whatWouldChangeThisClaim: ["增加更多新鲜、来源多样且贴近目标用户的公开证据。"]
    }),
    makeClaim({
      id: "claim-payment",
      text: "当前产品方向是否存在付费或商业化信号仍需验证。",
      claimType: "payment",
      objectiveLevel: paymentIds.length ? "evidence_interpretation" : "hypothesis",
      supportEvidenceIds: paymentIds,
      opposeEvidenceIds: [],
      status: paymentIds.length ? "supported" : "unverified",
      confidence: paymentIds.length ? 50 : 16,
      whyItMatters: "没有付费或预算证据时，潜力不能被判断为高置信。",
      whatWouldChangeThisClaim: ["找到定价页、付费竞品、外包服务、预约 demo 或 fake-door 定价测试结果。"]
    }),
    makeClaim({
      id: "claim-distribution",
      text: "产品是否能低成本触达首批目标用户尚未被证明。",
      claimType: "distribution",
      objectiveLevel: "hypothesis",
      supportEvidenceIds: [],
      opposeEvidenceIds: [],
      status: "unverified",
      confidence: 15,
      whyItMatters: "没有分发证据时，即使产品有用也可能无法获得市场反馈。",
      whatWouldChangeThisClaim: ["在 2-3 个目标社区发布定位测试，并记录点击、回复和预约。"]
    })
  ].map((claim) => ({
    ...claim,
    temporalValidityScore: temporalValidityForClaim(claim, cards)
  }));
}

function buildClaimLedger(
  claims: ProductClaim[],
  capturedAt: string
): ClaimLedger {
  return {
    claims,
    lastUpdatedAt: capturedAt,
    overallConfidence: Math.round(average(claims.map((claim) => claim.confidence))),
    openQuestions: claims
      .filter((claim) => claim.status === "unverified" || claim.status === "mixed")
      .map((claim) => claim.whatWouldChangeThisClaim[0])
      .filter(Boolean)
  };
}

function buildEvidenceGaps(
  claims: ProductClaim[],
  cards: EvidenceCard[],
  lifecycleEvidenceStandard: LifecycleEvidenceStandard
): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  const hasPayment = cards.some((card) => card.assumptionId === "payment");
  const hasOpposition = cards.some((card) => card.direction === "oppose");
  const hasExternal = cards.some((card) => card.sourceType !== "uploaded_material");

  if (!hasExternal) {
    gaps.push({
      assumptionId: "external-signal",
      missingEvidence: `缺少${lifecycleEvidenceStandard.label}所需的公开市场证据和目标用户外部信号。`,
      whyItMatters: lifecycleEvidenceStandard.evidenceGoal,
      recommendedExperimentType: "community_post",
      expectedConfidenceGain: 0.18
    });
  }

  if (!hasPayment) {
    gaps.push({
      assumptionId: "payment",
      missingEvidence: "缺少付费、预算、定价或购买意图证据。",
      whyItMatters:
        lifecycleEvidenceStandard.stage === "idea"
          ? "想法期可以先弱化付费结论，但必须知道下一步如何验证预算或购买意图。"
          : "进入 MVP/发布后，没有付费或预算证据时，潜力不能被判断为高置信。",
      recommendedExperimentType: "pricing_test",
      expectedConfidenceGain: 0.22
    });
  }

  if (!hasOpposition) {
    gaps.push({
      assumptionId: "opposition",
      missingEvidence: "缺少足够反证，当前分析可能有确认偏误。",
      whyItMatters: "没有反证覆盖时，不能说明风险不存在，只能说明还没有查够。",
      recommendedExperimentType: "customer_interview",
      expectedConfidenceGain: 0.14
    });
  }

  for (const claim of claims.filter((item) => item.status === "unverified").slice(0, 2)) {
    gaps.push({
      assumptionId: claim.id,
      missingEvidence: claim.whatWouldChangeThisClaim[0] || "缺少可验证证据。",
      whyItMatters: claim.whyItMatters,
      recommendedExperimentType: "customer_interview",
      expectedConfidenceGain: 0.12
    });
  }

  return gaps.slice(0, 5);
}

function buildSourceBudgets(
  cards: EvidenceCard[],
  queryPlan: WebResearchSummary["queryPlan"] = [],
  lifecycleEvidenceStandard: LifecycleEvidenceStandard = evidenceStandardForStage("unknown")
): SourceBudget[] {
  const definitions: Array<{
    assumptionId: string;
    label: string;
    requiredSupport: number;
    requiredOpposition: number;
  }> = [
    {
      assumptionId: "problem",
      label: "痛点真实性",
      requiredSupport: budgetSupportRequirement(lifecycleEvidenceStandard, "problem", 2),
      requiredOpposition: 1
    },
    {
      assumptionId: "payment",
      label: "付费意愿",
      requiredSupport: budgetSupportRequirement(lifecycleEvidenceStandard, "payment", 1),
      requiredOpposition: budgetOppositionRequirement(lifecycleEvidenceStandard, "payment", 1)
    },
    {
      assumptionId: "alternative",
      label: "替代方案",
      requiredSupport: budgetSupportRequirement(lifecycleEvidenceStandard, "alternative", 2),
      requiredOpposition: 1
    },
    {
      assumptionId: "distribution",
      label: "分发渠道",
      requiredSupport: budgetSupportRequirement(lifecycleEvidenceStandard, "distribution", 1),
      requiredOpposition: 1
    },
    {
      assumptionId: "opposition",
      label: "反证覆盖",
      requiredSupport: 0,
      requiredOpposition: lifecycleEvidenceStandard.requiredOpposition
    },
    {
      assumptionId: "timing",
      label: "证据时效",
      requiredSupport: budgetSupportRequirement(lifecycleEvidenceStandard, "timing", 1),
      requiredOpposition: 0
    }
  ];

  return definitions.map((definition) => {
    const relatedCards = cards.filter(
      (card) =>
        card.assumptionId === definition.assumptionId ||
        (definition.assumptionId === "opposition" &&
          (card.direction === "oppose" || card.signalType === "opposition_candidate"))
    );
    const supportEvidenceIds = relatedCards
      .filter((card) => card.direction === "support")
      .map((card) => card.id);
    const oppositionEvidenceIds = relatedCards
      .filter((card) => card.direction === "oppose")
      .map((card) => card.id);
    const neutralEvidenceIds = relatedCards
      .filter((card) => card.direction === "neutral")
      .map((card) => card.id);
    const plannedQueryIds = queryPlan
      .filter(
        (query) =>
          query.assumptionId === definition.assumptionId ||
          (definition.assumptionId === "opposition" && query.intent === "opposition")
      )
      .map((query) => query.id);
    const missingEvidence = missingForBudget({
      requiredSupport: definition.requiredSupport,
      requiredOpposition: definition.requiredOpposition,
      supportEvidenceIds,
      oppositionEvidenceIds
    });
    const hasAnyEvidence =
      supportEvidenceIds.length + oppositionEvidenceIds.length + neutralEvidenceIds.length > 0;
    const status =
      missingEvidence.length === 0
        ? "met"
        : hasAnyEvidence
          ? "partial"
          : plannedQueryIds.length
            ? "planned"
            : "missing";

    return {
      ...definition,
      currentSupport: supportEvidenceIds.length,
      currentOpposition: oppositionEvidenceIds.length,
      currentNeutral: neutralEvidenceIds.length,
      supportEvidenceIds,
      oppositionEvidenceIds,
      neutralEvidenceIds,
      plannedQueryIds,
      status,
      missingEvidence
    };
  });
}

function budgetSupportRequirement(
  standard: LifecycleEvidenceStandard,
  assumptionId: string,
  fallback: number
) {
  if (standard.stage === "idea") {
    if (assumptionId === "payment") return 0;
    if (assumptionId === "distribution") return 0;
  }
  if (standard.stage === "prototype") {
    if (assumptionId === "payment") return 1;
    if (assumptionId === "distribution") return 1;
  }
  if (standard.stage === "mvp") {
    if (assumptionId === "payment") return 1;
    if (assumptionId === "distribution") return 1;
  }
  if (standard.stage === "launch") {
    if (assumptionId === "payment") return 2;
    if (assumptionId === "distribution") return 2;
    if (assumptionId === "timing") return 2;
  }
  if (standard.stage === "early_traction") {
    if (assumptionId === "payment") return 2;
    if (assumptionId === "distribution") return 2;
    if (assumptionId === "problem") return 1;
  }
  if (standard.stage === "growth" || standard.stage === "mature") {
    if (assumptionId === "payment") return 3;
    if (assumptionId === "distribution") return 3;
    if (assumptionId === "alternative") return 2;
  }
  return fallback;
}

function budgetOppositionRequirement(
  standard: LifecycleEvidenceStandard,
  assumptionId: string,
  fallback: number
) {
  if (standard.stage === "idea" && assumptionId === "payment") return 0;
  if (standard.stage === "launch" && assumptionId === "distribution") return 2;
  if (
    (standard.stage === "early_traction" || standard.stage === "growth") &&
    (assumptionId === "payment" || assumptionId === "distribution")
  ) {
    return 2;
  }
  return fallback;
}

function missingForBudget({
  requiredSupport,
  requiredOpposition,
  supportEvidenceIds,
  oppositionEvidenceIds
}: {
  requiredSupport: number;
  requiredOpposition: number;
  supportEvidenceIds: string[];
  oppositionEvidenceIds: string[];
}) {
  const missing: string[] = [];
  const supportGap = requiredSupport - supportEvidenceIds.length;
  const oppositionGap = requiredOpposition - oppositionEvidenceIds.length;
  if (supportGap > 0) {
    missing.push(`还缺 ${supportGap} 条支持证据`);
  }
  if (oppositionGap > 0) {
    missing.push(`还缺 ${oppositionGap} 条反证`);
  }
  return missing;
}

function makeExperimentResultCard({
  experiment,
  result,
  assumptionId
}: {
  experiment: ValidationExperiment;
  result: ValidationExperimentResult;
  assumptionId: string;
}) {
  const direction =
    result.status === "validated"
      ? ("support" as const)
      : result.status === "invalidated"
        ? ("oppose" as const)
        : ("neutral" as const);
  const behaviorStrength =
    result.status === "validated" ? (7 as const) : result.status === "invalidated" ? (6 as const) : (3 as const);
  const claim =
    result.status === "validated"
      ? `实验结果支持「${experiment.title}」对应假设。`
      : result.status === "invalidated"
        ? `实验结果反驳「${experiment.title}」对应假设。`
        : `实验结果对「${experiment.title}」仍不确定。`;

  return makeCard({
    id: `experiment-${experiment.id || assumptionId}`,
    assumptionId,
    sourceTitle: `${experiment.title} · 实验结果`,
    sourceUrl: result.rawEvidenceUrls?.[0] || "",
    sourceType: "experiment_result",
    observedAt: result.completedAt,
    capturedAt: result.completedAt,
    recencyBucket: "fresh",
    objectiveLevel: "observed_fact",
    claim,
    signalType:
      result.status === "validated"
        ? "experiment_validated"
        : result.status === "invalidated"
          ? "experiment_invalidated"
          : "experiment_inconclusive",
    direction,
    behaviorStrength,
    quoteOrSnippet: result.evidenceSummary.slice(0, 320),
    interpretation: `主指标结果：${result.primaryMetricValue}；样本量：${result.sampleSize}。`,
    caveat: "该证据来自用户回填的验证实验结果，仍需保留原始截图、链接或访谈记录备查。",
    relevanceScore: result.status === "inconclusive" ? 0.62 : 0.86,
    credibilityScore: result.rawEvidenceUrls?.length ? 0.82 : 0.7,
    lifecycleRelevance: 1
  });
}

function makeExperimentArtifactCards({
  experiment,
  result,
  assumptionId
}: {
  experiment: ValidationExperiment;
  result: ValidationExperimentResult;
  assumptionId: string;
}) {
  return (result.rawEvidenceArtifacts ?? []).slice(0, 12).map((artifact, index) =>
    makeExperimentArtifactCard({
      experiment,
      result,
      assumptionId,
      artifact,
      index
    })
  );
}

function makeExperimentArtifactCard({
  experiment,
  result,
  assumptionId,
  artifact,
  index
}: {
  experiment: ValidationExperiment;
  result: ValidationExperimentResult;
  assumptionId: string;
  artifact: ExperimentEvidenceArtifact;
  index: number;
}) {
  const artifactAssumptionId =
    artifact.direction === "oppose" ? assumptionIdForOpposition(assumptionId) : assumptionId;
  return makeCard({
    id: `experiment-${experiment.id || assumptionId}-artifact-${artifact.id || index + 1}`,
    assumptionId: artifactAssumptionId,
    sourceTitle: `${experiment.title} · ${artifact.title}`,
    sourceUrl: artifact.sourceUrl || result.rawEvidenceUrls?.[0] || "",
    sourceType: sourceTypeForExperimentArtifact(artifact),
    observedAt: artifact.capturedAt || result.completedAt,
    capturedAt: artifact.capturedAt || result.completedAt,
    recencyBucket: "fresh",
    objectiveLevel: artifact.objectiveLevel,
    claim: claimForExperimentArtifact(experiment, artifact),
    signalType: signalTypeForExperimentArtifact(artifact),
    direction: artifact.direction,
    behaviorStrength: behaviorStrengthForExperimentArtifact(artifact),
    quoteOrSnippet: artifact.excerpt.slice(0, 320),
    interpretation: artifact.parsedSignal,
    caveat: caveatForExperimentArtifact(artifact),
    relevanceScore: relevanceForExperimentArtifact(artifact),
    credibilityScore: credibilityForExperimentArtifact(artifact),
    lifecycleRelevance: 1
  });
}

function sourceTypeForExperimentArtifact(artifact: ExperimentEvidenceArtifact) {
  if (artifact.extractionMethod === "code") return "experiment_code_execution";
  if (artifact.extractionMethod === "ocr") return "experiment_ocr";
  if (artifact.kind === "csv_row") return "experiment_csv";
  if (artifact.kind === "metric_snapshot") return "experiment_metric";
  if (artifact.kind === "interview_note") return "experiment_interview";
  if (artifact.kind === "screenshot") return "experiment_screenshot";
  if (artifact.kind === "url") return "experiment_source_url";
  return "experiment_raw_evidence";
}

function signalTypeForExperimentArtifact(artifact: ExperimentEvidenceArtifact) {
  if (artifact.extractionMethod === "code") {
    return artifact.direction === "oppose" ? "experiment_code_metric_negative" : "experiment_code_metric";
  }
  if (artifact.extractionMethod === "ocr") {
    if (artifact.kind === "csv_row" || artifact.kind === "metric_snapshot") {
      return artifact.direction === "oppose" ? "experiment_ocr_metric_negative" : "experiment_ocr_metric";
    }
    if (artifact.kind === "interview_note") {
      return artifact.direction === "oppose" ? "experiment_ocr_objection" : "experiment_ocr_interview";
    }
    return "experiment_ocr_text";
  }
  if (artifact.kind === "csv_row" || artifact.kind === "metric_snapshot") {
    return artifact.direction === "oppose" ? "experiment_metric_negative" : "experiment_metric";
  }
  if (artifact.kind === "interview_note") {
    return artifact.direction === "oppose" ? "experiment_interview_objection" : "experiment_interview";
  }
  if (artifact.kind === "screenshot") return "experiment_screenshot";
  if (artifact.kind === "url") return "experiment_source_url";
  return "experiment_raw_evidence";
}

function behaviorStrengthForExperimentArtifact(
  artifact: ExperimentEvidenceArtifact
): EvidenceCard["behaviorStrength"] {
  if (artifact.direction === "neutral") return 3;
  if (artifact.kind === "csv_row" || artifact.kind === "metric_snapshot") return 6;
  if (artifact.kind === "screenshot") return 5;
  if (artifact.kind === "interview_note") return 5;
  if (artifact.kind === "url") return 4;
  return 4;
}

function credibilityForExperimentArtifact(artifact: ExperimentEvidenceArtifact) {
  if (artifact.extractionMethod === "code") return 0.88;
  if (artifact.extractionMethod === "ocr") {
    const confidence = normalizedOcrConfidence(artifact);
    const base =
      artifact.kind === "csv_row" || artifact.kind === "metric_snapshot"
        ? 0.64
        : artifact.kind === "interview_note"
          ? 0.58
          : 0.56;
    const confidenceLift = confidence ? Math.max(0, Math.min(0.16, (confidence - 0.45) * 0.32)) : 0;
    return Number(Math.min(0.8, base + confidenceLift).toFixed(2));
  }
  if (artifact.kind === "csv_row" || artifact.kind === "metric_snapshot") return 0.86;
  if (artifact.kind === "screenshot") return 0.78;
  if (artifact.kind === "interview_note") return 0.72;
  if (artifact.kind === "url") return 0.7;
  return 0.66;
}

function relevanceForExperimentArtifact(artifact: ExperimentEvidenceArtifact) {
  if (artifact.direction === "neutral") return 0.58;
  if (artifact.kind === "csv_row" || artifact.kind === "metric_snapshot") return 0.86;
  if (artifact.kind === "interview_note") return 0.76;
  return 0.7;
}

function claimForExperimentArtifact(
  experiment: ValidationExperiment,
  artifact: ExperimentEvidenceArtifact
) {
  if (artifact.direction === "support") {
    return `原始实验材料支持「${experiment.title}」相关假设。`;
  }
  if (artifact.direction === "oppose") {
    return `原始实验材料反驳或削弱「${experiment.title}」相关假设。`;
  }
  return `原始实验材料补充了「${experiment.title}」的上下文。`;
}

function caveatForExperimentArtifact(artifact: ExperimentEvidenceArtifact) {
  if (artifact.extractionMethod === "code") {
    return "该证据来自受限代码对用户上传实验原件的计算结果；它能提高指标口径一致性，但仍受样本来源、文件完整性和上传数据真实性限制。";
  }
  if (artifact.extractionMethod === "ocr") {
    const engine = artifact.ocrEngine === "apple_vision" ? "Apple Vision OCR" : artifact.ocrEngine || "OCR";
    const confidence = normalizedOcrConfidence(artifact);
    const confidenceText = confidence ? `平均置信度 ${Math.round(confidence * 100)}%` : "未返回置信度";
    return `该证据来自 ${engine} 自动抽取（${confidenceText}）；可能存在误读，应核对截图原件后再做强结论。`;
  }
  if (artifact.kind === "screenshot") {
    return "该证据来自用户上传的截图原件；当前版本尚未 OCR，需结合人工阅读或后续 OCR 核验。";
  }
  if (artifact.kind === "interview_note") {
    return "该证据来自用户整理的访谈或评论摘录，需要保留原始上下文，避免选择性摘录。";
  }
  if (artifact.kind === "csv_row" || artifact.kind === "metric_snapshot") {
    return "该证据来自用户上传的实验数据或指标快照，需要确认样本来源和统计口径。";
  }
  return "该证据来自用户回填的原始材料，仍需保留原件备查。";
}

function normalizedOcrConfidence(artifact: ExperimentEvidenceArtifact) {
  const value = Number(artifact.ocrConfidence);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? Math.min(1, value / 100) : Math.min(1, value);
}

function assumptionIdForOpposition(assumptionId: string) {
  return assumptionId === "opposition" ? "opposition" : assumptionId;
}

function updateSourceBudgetsWithExperimentCards(
  budgets: SourceBudget[],
  cards: EvidenceCard[]
) {
  return cards.reduce(
    (currentBudgets, card) => updateSourceBudgetsWithExperimentResult(currentBudgets, card),
    budgets
  );
}

function updateSourceBudgetsWithExperimentResult(
  budgets: SourceBudget[],
  card: EvidenceCard
) {
  return budgets.map((budget) => {
    const applies =
      budget.assumptionId === card.assumptionId ||
      (budget.assumptionId === "opposition" && card.direction === "oppose");
    if (!applies) return budget;

    const existingSupportIds = budget.supportEvidenceIds.filter((id) => id !== card.id);
    const existingOppositionIds = budget.oppositionEvidenceIds.filter((id) => id !== card.id);
    const existingNeutralIds = budget.neutralEvidenceIds.filter((id) => id !== card.id);
    const supportEvidenceIds =
      card.direction === "support"
        ? uniqueStrings([...existingSupportIds, card.id])
        : existingSupportIds;
    const oppositionEvidenceIds =
      card.direction === "oppose"
        ? uniqueStrings([...existingOppositionIds, card.id])
        : existingOppositionIds;
    const neutralEvidenceIds =
      card.direction === "neutral"
        ? uniqueStrings([...existingNeutralIds, card.id])
        : existingNeutralIds;
    const missingEvidence = missingForBudget({
      requiredSupport: budget.requiredSupport,
      requiredOpposition: budget.requiredOpposition,
      supportEvidenceIds,
      oppositionEvidenceIds
    });
    const hasAnyEvidence =
      supportEvidenceIds.length + oppositionEvidenceIds.length + neutralEvidenceIds.length > 0;

    return {
      ...budget,
      currentSupport: supportEvidenceIds.length,
      currentOpposition: oppositionEvidenceIds.length,
      currentNeutral: neutralEvidenceIds.length,
      supportEvidenceIds,
      oppositionEvidenceIds,
      neutralEvidenceIds,
      status:
        missingEvidence.length === 0
          ? ("met" as const)
          : hasAnyEvidence
            ? ("partial" as const)
            : budget.status,
      missingEvidence
    };
  });
}

function updateClaimsWithExperimentCards(
  claims: ProductClaim[],
  cards: EvidenceCard[],
  expectedConfidenceGain: number
) {
  return cards.reduce(
    (currentClaims, card) =>
      updateClaimsWithExperimentResult(currentClaims, card, expectedConfidenceGain),
    claims
  );
}

function updateClaimsWithExperimentResult(
  claims: ProductClaim[],
  card: EvidenceCard,
  expectedConfidenceGain: number
) {
  return claims.map((claim) => {
    if (assumptionForClaimType(claim.claimType) !== card.assumptionId) return claim;

    const existingSupportIds = claim.supportEvidenceIds.filter((id) => id !== card.id);
    const existingOpposeIds = claim.opposeEvidenceIds.filter((id) => id !== card.id);
    const supportEvidenceIds =
      card.direction === "support"
        ? uniqueStrings([...existingSupportIds, card.id])
        : existingSupportIds;
    const opposeEvidenceIds =
      card.direction === "oppose"
        ? uniqueStrings([...existingOpposeIds, card.id])
        : existingOpposeIds;
    const status =
      supportEvidenceIds.length && opposeEvidenceIds.length
        ? ("mixed" as const)
        : supportEvidenceIds.length
          ? ("supported" as const)
          : opposeEvidenceIds.length
            ? ("opposed" as const)
            : claim.status;
    const confidenceShift = Math.round(expectedConfidenceGain * 100);
    const baselineConfidence = baselineConfidenceForClaim(
      claim,
      existingSupportIds,
      existingOpposeIds
    );
    const confidence =
      card.direction === "support"
        ? Math.min(92, baselineConfidence + confidenceShift)
        : card.direction === "oppose"
          ? Math.max(8, baselineConfidence - confidenceShift)
          : baselineConfidence;

    return {
      ...claim,
      objectiveLevel: "observed_fact" as const,
      supportEvidenceIds,
      opposeEvidenceIds,
      status,
      confidence,
      temporalValidityScore: 100,
      whatWouldChangeThisClaim:
        card.direction === "neutral"
          ? claim.whatWouldChangeThisClaim
          : ["根据实验结果更新下一轮判断；如有新原始证据，继续回填。"]
    };
  });
}

function baselineConfidenceForClaim(
  claim: ProductClaim,
  supportEvidenceIds: string[],
  opposeEvidenceIds: string[]
) {
  if (claim.id === "claim-product-thesis") {
    return supportEvidenceIds.length ? 52 : 20;
  }
  if (claim.id === "claim-external-signal") {
    return supportEvidenceIds.length || opposeEvidenceIds.length ? 44 : 18;
  }
  if (claim.id === "claim-payment") {
    return supportEvidenceIds.length ? 50 : 16;
  }
  if (claim.id === "claim-distribution") {
    return supportEvidenceIds.length || opposeEvidenceIds.length ? 42 : 15;
  }
  return claim.confidence;
}

function assumptionForClaimType(claimType: ProductClaim["claimType"]) {
  if (claimType === "payment") return "payment";
  if (claimType === "distribution") return "distribution";
  if (claimType === "timing") return "timing";
  if (claimType === "ai_advantage") return "ai-advantage";
  return "problem";
}

function designExperiment(
  input: GenerateEvidenceBriefInput,
  gaps: EvidenceGap[]
): ValidationExperiment {
  const primaryGap = gaps[0];
  if (primaryGap?.recommendedExperimentType === "pricing_test") {
    return {
      id: experimentId(primaryGap),
      assumptionId: primaryGap.assumptionId,
      status: "planned",
      title: "定价页 Fake Door 测试",
      hypothesis: "如果目标用户真的有强需求，至少会点击价格/预约入口。",
      targetUser: inferTargetUser(input.visibleText),
      channel: "官网首屏、README、社媒发布帖",
      steps: [
        "写两版一句话定位，分别强调痛点和结果。",
        "增加一个价格或预约 demo 按钮。",
        "记录访问、点击、留邮箱和预约数量。"
      ],
      successMetric: "100-300 次目标访问中，价格/预约点击率 >= 3%，且至少 3 个有效留资。",
      failureMetric: "点击率 < 1%，且没有目标用户主动追问。",
      sampleSize: "100-300 个目标用户访问",
      timeRequired: "3-7 days",
      costLevel: "low",
      expectedConfidenceGain: primaryGap.expectedConfidenceGain,
      primaryMetric: {
        name: "价格/预约点击率",
        unit: "%",
        target: ">= 3%，且至少 3 个有效留资",
        failureThreshold: "< 1%，且没有目标用户主动追问",
        direction: "higher_is_better"
      },
      secondaryMetrics: ["访问来源质量", "有效留资数量", "用户主动追问数量"],
      evidenceToCollect: [
        "访问量和来源渠道",
        "价格/预约按钮点击数",
        "有效邮箱或预约数量",
        "用户追问内容截图或链接"
      ],
      resultSchema: defaultExperimentResultSchema(),
      decisionRules: {
        validated: "点击率 >= 3% 且至少 3 个有效留资，付费/预算假设上调。",
        inconclusive: "点击率 1%-3% 或留资不足，需要换文案/渠道再测。",
        invalidated: "点击率 < 1% 且无目标用户追问，付费假设下调。"
      },
      result: null
    };
  }

  if (primaryGap?.recommendedExperimentType === "community_post") {
    return {
      id: experimentId(primaryGap),
      assumptionId: primaryGap.assumptionId,
      status: "planned",
      title: "目标社区问题帖测试",
      hypothesis: "如果问题真实存在，目标用户会对具体痛点表达回应或补充自己的 workaround。",
      targetUser: inferTargetUser(input.visibleText),
      channel: "X、即刻、Reddit、Hacker News 或垂直社群",
      steps: [
        "不要先发产品，先发具体问题和一个可验证场景。",
        "记录评论中是否出现同类痛点、替代方案和付费意愿。",
        "把有效回复整理成新的 Evidence Cards。"
      ],
      successMetric: "至少 5 个目标用户回应，其中 2 个愿意看 demo 或进一步交流。",
      failureMetric: "只有泛泛点赞，没有目标用户描述自己的问题或替代方案。",
      sampleSize: "3 个渠道帖或 20 个目标用户触达",
      timeRequired: "3-5 days",
      costLevel: "free",
      expectedConfidenceGain: primaryGap.expectedConfidenceGain,
      primaryMetric: {
        name: "目标用户有效回应数",
        unit: "count",
        target: ">= 5 个目标用户回应，且 >= 2 个愿意看 demo 或继续交流",
        failureThreshold: "0-1 个目标用户回应，或只有泛泛点赞",
        direction: "higher_is_better"
      },
      secondaryMetrics: ["评论中的 workaround 数量", "主动私信数量", "demo 请求数量"],
      evidenceToCollect: [
        "发布渠道和帖子链接",
        "目标用户评论截图或链接",
        "提到的替代方案和 workaround",
        "愿意看 demo 或继续交流的用户数"
      ],
      resultSchema: defaultExperimentResultSchema(),
      decisionRules: {
        validated: ">= 5 个目标用户回应且 >= 2 个继续交流，痛点/分发假设上调。",
        inconclusive: "有回应但不够具体，需换更窄场景或渠道再测。",
        invalidated: "只有泛泛点赞，没有目标用户描述真实问题，痛点假设下调。"
      },
      result: null
    };
  }

  return {
    id: experimentId(primaryGap),
    assumptionId: primaryGap?.assumptionId || "problem",
    status: "planned",
    title: "10 个 Story-based 用户访谈",
    hypothesis: "目标用户在过去 30 天内真实遇到过这个问题，并尝试过替代方案。",
    targetUser: inferTargetUser(input.visibleText),
    channel: "已有用户、社群私信、朋友转介绍",
    steps: [
      "只问过去行为，不问他们会不会用。",
      "记录他们最近一次遇到问题的场景、代价和替代方案。",
      "把每个访谈转成痛点、替代方案、付费和反证 Evidence Cards。"
    ],
    successMetric: "10 人中至少 4 人在近期遇到该问题，且 2 人已有明确 workaround。",
    failureMetric: "多数人只觉得有趣，但没有近期行为、代价或替代方案。",
    sampleSize: "10 个目标用户",
    timeRequired: "3-7 days",
    costLevel: "free",
    expectedConfidenceGain: primaryGap?.expectedConfidenceGain ?? 0.14,
    primaryMetric: {
      name: "近期真实痛点比例",
      unit: "%",
      target: "10 人中至少 4 人过去 30 天遇到该问题，且 2 人有明确 workaround",
      failureThreshold: "10 人中少于 2 人有近期行为或明确代价",
      direction: "higher_is_better"
    },
    secondaryMetrics: ["明确 workaround 数量", "付费/预算提及数量", "反证或低优先级反馈数量"],
    evidenceToCollect: [
      "访谈对象角色和来源",
      "最近一次遇到问题的时间和场景",
      "现有替代方案或 workaround",
      "问题造成的时间/金钱/机会成本",
      "明确反证：不痛、低频、不愿付费、已有方案足够好"
    ],
    resultSchema: defaultExperimentResultSchema(),
    decisionRules: {
      validated: ">= 40% 目标用户有近期行为，且 >= 2 个明确 workaround，痛点假设上调。",
      inconclusive: "有兴趣但缺近期行为，需要换目标用户或更窄场景。",
      invalidated: "少于 2 人有近期行为或代价，当前命题应 reposition。"
    },
    result: null
  };
}

function experimentId(gap?: EvidenceGap) {
  return `exp-${gap?.assumptionId || "problem"}-${gap?.recommendedExperimentType || "customer_interview"}`;
}

function defaultExperimentResultSchema() {
  return {
    requiredFields: [
      "status",
      "sampleSize",
      "primaryMetricValue",
      "evidenceSummary"
    ],
    optionalFields: ["rawEvidenceUrls", "rawEvidenceNotes", "rawEvidenceFiles", "notes"],
    decisionOptions: ["validated", "inconclusive", "invalidated"] as Array<
      "validated" | "inconclusive" | "invalidated"
    >
  };
}

function buildClusters(
  cards: EvidenceCard[],
  gaps: EvidenceGap[]
): EvidenceCluster[] {
  const definitions: Array<{
    id: string;
    title: string;
    clusterType: EvidenceCluster["clusterType"];
    match: (card: EvidenceCard) => boolean;
  }> = [
    {
      id: "cluster-payment",
      title: "付费信号",
      clusterType: "payment_signal",
      match: (card) => card.assumptionId === "payment"
    },
    {
      id: "cluster-competitor",
      title: "竞品与替代方案",
      clusterType: "competitor_signal",
      match: (card) =>
        card.assumptionId === "competitor" || card.assumptionId === "alternative"
    },
    {
      id: "cluster-pain",
      title: "痛点信号",
      clusterType: "pain_signal",
      match: (card) => card.assumptionId === "problem"
    },
    {
      id: "cluster-opposition",
      title: "反证信号",
      clusterType: "opposition_signal",
      match: (card) => card.direction === "oppose"
    }
  ];

  const clusters = definitions
    .map((definition) => {
      const matched = cards.filter(definition.match);
      if (!matched.length) return null;
      const supportCards = matched.filter((card) => card.direction === "support");
      const opposeCards = matched.filter((card) => card.direction === "oppose");
      const netStrength = weightedCardScore(supportCards) - weightedCardScore(opposeCards);
      return {
        id: definition.id,
        title: definition.title,
        clusterType: definition.clusterType,
        summary: summarizeCluster(definition.title, supportCards, opposeCards),
        supportCards,
        opposeCards,
        netStrength,
        confidence: Math.max(10, Math.min(90, Math.abs(netStrength)))
      };
    })
    .filter((item): item is EvidenceCluster => Boolean(item));

  if (gaps.length) {
    clusters.push({
      id: "cluster-missing",
      title: "缺失信号",
      clusterType: "missing_signal",
      summary: gaps.map((gap) => gap.missingEvidence).join("；"),
      supportCards: [],
      opposeCards: [],
      netStrength: -20,
      confidence: 70
    });
  }

  return clusters.slice(0, 6);
}

function shouldStopStrongDecision({
  evidenceCards,
  webCards,
  opposeCards,
  objectiveEvidenceRatio,
  unknownRecencyRatio,
  sourceBudgets,
  recommendedExperiment,
  lifecycleEvidenceStandard
}: {
  evidenceCards: EvidenceCard[];
  webCards: EvidenceCard[];
  opposeCards: EvidenceCard[];
  objectiveEvidenceRatio: number;
  unknownRecencyRatio: number;
  sourceBudgets: SourceBudget[];
  recommendedExperiment: ValidationExperiment;
  lifecycleEvidenceStandard: LifecycleEvidenceStandard;
}): EvidenceStop | undefined {
  const unmetCoreBudgets = sourceBudgets.filter(
    (budget) =>
      lifecycleEvidenceStandard.requiredSourceBudgets.includes(budget.assumptionId) &&
      budget.status !== "met"
  );
  const sourceBudgetScore = Math.round(
    ratio(sourceBudgets.filter((budget) => budget.status === "met").length, sourceBudgets.length) *
      100
  );
  const strongBehaviorCards = evidenceCards.filter(
    (card) =>
      card.behaviorStrength >= lifecycleEvidenceStandard.minimumBehaviorStrength &&
      card.direction === "support"
  );
  const freshOrUsableWebCards = webCards.filter(
    (card) => card.recencyBucket === "fresh" || card.recencyBucket === "usable"
  );
  const sourceDiversity = uniqueSourceCount(webCards);
  const ruleResults: EvidenceStopRule[] = [
    makeStopRule({
      id: "external_evidence",
      label: "当前外部证据",
      score: Math.min(
        100,
        Math.round(ratio(webCards.length, lifecycleEvidenceStandard.requiredExternalEvidence) * 100)
      ),
      status:
        webCards.length < lifecycleEvidenceStandard.requiredExternalEvidence ? "block" : "pass",
      reason:
        webCards.length < lifecycleEvidenceStandard.requiredExternalEvidence
          ? `${lifecycleEvidenceStandard.label}需要至少 ${lifecycleEvidenceStandard.requiredExternalEvidence} 条外部证据，当前 ${webCards.length} 条。`
          : `当前外部证据 ${webCards.length} 条，达到 ${lifecycleEvidenceStandard.label}最低数量要求。`,
      minimumEvidenceNeeded: [
        `至少补足 ${lifecycleEvidenceStandard.requiredExternalEvidence} 条${lifecycleEvidenceStandard.label}外部证据。`
      ]
    }),
    makeStopRule({
      id: "lifecycle_standard",
      label: "生命周期标准",
      score: Math.min(
        100,
        Math.round(ratio(evidenceCards.length, lifecycleEvidenceStandard.requiredTotalEvidence) * 100)
      ),
      status:
        evidenceCards.length < lifecycleEvidenceStandard.requiredTotalEvidence ? "block" : "pass",
      reason:
        evidenceCards.length < lifecycleEvidenceStandard.requiredTotalEvidence
          ? `${lifecycleEvidenceStandard.label}至少需要 ${lifecycleEvidenceStandard.requiredTotalEvidence} 张证据卡，当前 ${evidenceCards.length} 张。${lifecycleEvidenceStandard.decisionRule}`
          : `${lifecycleEvidenceStandard.label}证据卡数量达到最低要求。`,
      minimumEvidenceNeeded: lifecycleEvidenceStandard.requiredEvidenceTypes
    }),
    makeStopRule({
      id: "source_budget",
      label: "Source Budget",
      score: sourceBudgetScore,
      status: unmetCoreBudgets.length ? "block" : "pass",
      reason: unmetCoreBudgets.length
        ? `核心预算未达标：${unmetCoreBudgets.map((budget) => budget.label).join("、")}。`
        : "核心 Source Budget 已达标。",
      minimumEvidenceNeeded: unmetCoreBudgets.flatMap((budget) =>
        budget.missingEvidence.map((missing) => `${budget.label}：${missing}`)
      )
    }),
    makeStopRule({
      id: "opposition_coverage",
      label: "反证覆盖",
      score: Math.min(
        100,
        Math.round(ratio(opposeCards.length, lifecycleEvidenceStandard.requiredOpposition) * 100)
      ),
      status:
        opposeCards.length < lifecycleEvidenceStandard.requiredOpposition ? "block" : "pass",
      reason:
        opposeCards.length < lifecycleEvidenceStandard.requiredOpposition
          ? `反证卡 ${opposeCards.length}/${lifecycleEvidenceStandard.requiredOpposition}，还不能说明${lifecycleEvidenceStandard.label}主要风险已被查过。`
          : `已找到 ${opposeCards.length} 条反证，可用于校准乐观判断。`,
      minimumEvidenceNeeded: [
        `至少补足 ${lifecycleEvidenceStandard.requiredOpposition} 条直接反证。`
      ]
    }),
    makeStopRule({
      id: "temporal_validity",
      label: "证据时效",
      score: Math.round((1 - unknownRecencyRatio) * 100),
      status:
        unknownRecencyRatio > 0.4 ||
        freshOrUsableWebCards.length < lifecycleEvidenceStandard.requiredFreshWebEvidence
          ? "block"
          : unknownRecencyRatio > 0.25
            ? "warn"
            : "pass",
      reason:
        unknownRecencyRatio > 0.4
          ? "日期未知证据超过 40%，产品生命周期判断容易失真。"
          : freshOrUsableWebCards.length < lifecycleEvidenceStandard.requiredFreshWebEvidence
            ? `${lifecycleEvidenceStandard.label}需要至少 ${lifecycleEvidenceStandard.requiredFreshWebEvidence} 条新鲜或可用网页证据，当前 ${freshOrUsableWebCards.length} 条。`
            : "证据时效性达到最低要求。",
      minimumEvidenceNeeded: ["补充带发布时间/更新时间的近期证据。"]
    }),
    makeStopRule({
      id: "objectivity",
      label: "客观证据",
      score: Math.round(objectiveEvidenceRatio * 100),
      status: objectiveEvidenceRatio < 0.5 ? "block" : "pass",
      reason:
        objectiveEvidenceRatio < 0.5
          ? "客观证据占比低于 50%，模型推断和产品方材料占比过高。"
          : "客观证据占比达到最低要求。",
      minimumEvidenceNeeded: ["补充用户行为、公开评论、定价、发布或第三方来源。"]
    }),
    makeStopRule({
      id: "behavior_strength",
      label: "行为强度",
      score: Math.min(
        100,
        Math.round(
          ratio(strongBehaviorCards.length, lifecycleEvidenceStandard.requiredStrongBehaviorCards) *
            100
        )
      ),
      status:
        strongBehaviorCards.length < lifecycleEvidenceStandard.requiredStrongBehaviorCards
          ? "warn"
          : "pass",
      reason:
        strongBehaviorCards.length < lifecycleEvidenceStandard.requiredStrongBehaviorCards
          ? `${lifecycleEvidenceStandard.label}需要 ${lifecycleEvidenceStandard.requiredStrongBehaviorCards} 条行为强度 >= ${lifecycleEvidenceStandard.minimumBehaviorStrength} 的支持证据，当前 ${strongBehaviorCards.length} 条。`
          : `已有 ${strongBehaviorCards.length} 条较强行为信号。`,
      minimumEvidenceNeeded: ["补充付费、预约、留资、评论、迁移或真实使用证据。"]
    }),
    makeStopRule({
      id: "source_diversity",
      label: "来源多样性",
      score: Math.min(100, sourceDiversity * 34),
      status: sourceDiversity < 2 ? "warn" : "pass",
      reason:
        sourceDiversity < 2
          ? "证据来源过于集中，容易被单一渠道或摘要偏差影响。"
          : `外部证据来自 ${sourceDiversity} 个来源。`,
      minimumEvidenceNeeded: ["补充不同域名、社区、竞品或用户反馈来源。"]
    })
  ];
  const blockingRules = ruleResults.filter((rule) => rule.status === "block");

  if (!blockingRules.length) return undefined;
  const blockedDecisions = blockedDecisionsForRules(blockingRules);
  const minimumEvidenceNeeded = uniqueStrings(
    blockingRules.flatMap((rule) => rule.minimumEvidenceNeeded)
  );

  return {
    stopped: true,
    reason: blockingRules.map((rule) => rule.reason).join("；"),
    blockedDecision: blockedDecisions[0] ?? "build",
    blockedDecisions,
    allowedDecision: "test_first",
    minimumEvidenceNeeded,
    ruleResults,
    severity: blockingRules.length >= 3 ? "blocked" : "caution",
    recommendedExperiment
  };
}

function makeStopRule(rule: EvidenceStopRule): EvidenceStopRule {
  return {
    ...rule,
    score: Math.max(0, Math.min(100, Math.round(rule.score))),
    minimumEvidenceNeeded: rule.status === "pass" ? [] : rule.minimumEvidenceNeeded
  };
}

function blockedDecisionsForRules(rules: EvidenceStopRule[]) {
  const blocked = new Set<"build" | "stop" | "reposition">(["build"]);
  for (const rule of rules) {
    if (
      ["source_budget", "opposition_coverage", "objectivity", "temporal_validity"].includes(
        rule.id
      )
    ) {
      blocked.add("stop");
      blocked.add("reposition");
    }
  }
  return [...blocked];
}

function uniqueSourceCount(cards: EvidenceCard[]) {
  const keys = cards.map((card) => {
    if (card.sourceUrl) {
      try {
        return new URL(card.sourceUrl).hostname.toLowerCase();
      } catch {
        return card.sourceUrl.toLowerCase();
      }
    }
    return `${card.sourceType}:${card.sourceTitle}`.toLowerCase();
  });
  return new Set(keys.filter(Boolean)).size;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function decide({
  confidenceScore,
  evidenceStop,
  claims,
  supportCards,
  opposeCards
}: {
  confidenceScore: number;
  evidenceStop?: EvidenceStop;
  claims: ProductClaim[];
  supportCards: EvidenceCard[];
  opposeCards: EvidenceCard[];
}): ProductDecision {
  if (evidenceStop) {
    return {
      decision: "test_first",
      confidence: Math.min(confidenceScore, 55),
      rationaleClaimIds: claims.map((claim) => claim.id),
      strongestReason:
        supportCards[0]?.claim || "上传材料足以重建产品命题，但不足以证明市场潜力。",
      strongestCounterReason:
        opposeCards[0]?.claim || "当前反证覆盖不足，不能高置信建议 build。",
      nextMilestone: "先完成推荐实验，获取当前用户行为证据。"
    };
  }

  return {
    decision: confidenceScore >= 72 ? "build" : "test_first",
    confidence: confidenceScore,
    rationaleClaimIds: claims.map((claim) => claim.id),
    strongestReason: supportCards[0]?.claim || "已有一些支持信号。",
    strongestCounterReason: opposeCards[0]?.claim || "仍需持续寻找反证。",
    nextMilestone:
      confidenceScore >= 72
        ? "继续推进窄切口版本，同时跟踪留资、预约和复用。"
        : "先验证最大证据缺口，再决定是否继续开发。"
  };
}

function makeCard(input: Omit<EvidenceCard, "recencyWeight" | "recencyScore" | "lifecycleRelevance" | "confidence"> & {
  lifecycleRelevance?: number;
}): EvidenceCard {
  const recencyWeight = weightForRecency(input.recencyBucket);
  const lifecycleRelevance = input.lifecycleRelevance ?? 0.75;
  return {
    ...input,
    recencyWeight,
    lifecycleRelevance,
    recencyScore: Math.round(recencyWeight * 100),
    confidence: Math.round(
      input.behaviorStrength *
        10 *
        input.relevanceScore *
        input.credibilityScore *
        recencyWeight *
        lifecycleRelevance
    )
  };
}

function makeClaim(
  input: Omit<ProductClaim, "temporalValidityScore">
): ProductClaim {
  return {
    ...input,
    temporalValidityScore: 50
  };
}

function temporalValidityForClaim(claim: ProductClaim, cards: EvidenceCard[]) {
  const ids = new Set([...claim.supportEvidenceIds, ...claim.opposeEvidenceIds]);
  const matched = cards.filter((card) => ids.has(card.id));
  if (!matched.length) return 20;
  return Math.round(average(matched.map((card) => card.recencyScore)));
}

function inferProductLifecycleStage(text: string): ProductLifecycleStage {
  const lower = text.toLowerCase();
  if (/decline|sunset|churn|流失|下滑|衰退|停运/.test(lower)) return "decline";
  if (/scale|growth|增长|规模化|渠道复用|单位经济|cac|ltv/.test(lower)) return "growth";
  if (/retention|留存|复购|推荐|nps|revenue|收入|付费用户|paying customers|active customers/.test(lower)) {
    return "early_traction";
  }
  if (/waitlist|coming soon|想法|idea|concept/.test(lower)) return "idea";
  if (/prototype|原型|demo/.test(lower)) return "prototype";
  if (/mvp|beta|内测|早期版本/.test(lower)) return "mvp";
  if (/launch|发布|上线|product hunt/.test(lower)) return "launch";
  return "unknown";
}

export function evidenceStandardForStage(
  stage: ProductLifecycleStage
): LifecycleEvidenceStandard {
  if (stage === "idea" || stage === "unknown") {
    return {
      stage,
      label: stage === "idea" ? "想法期" : "未知阶段",
      evidenceGoal: "先证明痛点、目标用户和替代方案真实存在，避免只验证创始人叙事。",
      requiredExternalEvidence: 3,
      requiredTotalEvidence: 6,
      requiredOpposition: 1,
      requiredFreshWebEvidence: 1,
      minimumBehaviorStrength: 3,
      requiredStrongBehaviorCards: 1,
      requiredSourceBudgets: ["problem", "alternative", "opposition", "timing"],
      requiredEvidenceTypes: [
        "近期用户痛点或问题讨论",
        "现有替代方案或 workaround",
        "至少 1 条低需求/低优先级/强替代反证"
      ],
      decisionRule: "想法期不能高置信 build，只能先验证痛点和用户任务。"
    };
  }

  if (stage === "prototype") {
    return {
      stage,
      label: "原型期",
      evidenceGoal: "证明目标用户愿意看 demo、愿意反馈，并且原型解决的是高优先级问题。",
      requiredExternalEvidence: 4,
      requiredTotalEvidence: 8,
      requiredOpposition: 2,
      requiredFreshWebEvidence: 2,
      minimumBehaviorStrength: 4,
      requiredStrongBehaviorCards: 1,
      requiredSourceBudgets: ["problem", "alternative", "distribution", "opposition", "timing"],
      requiredEvidenceTypes: [
        "demo 请求、访谈、等待名单或目标用户评论",
        "替代方案和切换动机",
        "目标渠道回应或预约"
      ],
      decisionRule: "原型期需要用户行为或 demo 反馈，不能只靠兴趣表态。"
    };
  }

  if (stage === "mvp") {
    return {
      stage,
      label: "MVP 阶段",
      evidenceGoal: "证明用户不仅感兴趣，还会点击、留资、试用、预约或手动交付。",
      requiredExternalEvidence: 5,
      requiredTotalEvidence: 10,
      requiredOpposition: 2,
      requiredFreshWebEvidence: 2,
      minimumBehaviorStrength: 5,
      requiredStrongBehaviorCards: 2,
      requiredSourceBudgets: [
        "problem",
        "payment",
        "alternative",
        "distribution",
        "opposition",
        "timing"
      ],
      requiredEvidenceTypes: [
        "点击、留资、预约、试用或手动交付证据",
        "付费、预算、定价或购买意图证据",
        "低成本触达渠道证据"
      ],
      decisionRule: "MVP 阶段没有行为证据和付费/分发证据时，不能建议继续加大开发。"
    };
  }

  if (stage === "launch") {
    return {
      stage,
      label: "发布期",
      evidenceGoal: "证明发布渠道能带来真实转化，并确认早期用户不是一次性好奇。",
      requiredExternalEvidence: 6,
      requiredTotalEvidence: 12,
      requiredOpposition: 2,
      requiredFreshWebEvidence: 3,
      minimumBehaviorStrength: 5,
      requiredStrongBehaviorCards: 2,
      requiredSourceBudgets: ["payment", "distribution", "alternative", "opposition", "timing"],
      requiredEvidenceTypes: [
        "发布帖曝光、点击、注册、留资或预约",
        "首批用户激活或复用信号",
        "渠道质量和获客成本迹象"
      ],
      decisionRule: "发布期要看转化和渠道质量，不能只看点赞或曝光。"
    };
  }

  if (stage === "early_traction") {
    return {
      stage,
      label: "早期牵引",
      evidenceGoal: "证明产品能留住用户、产生复用、付费或推荐，而不只是首批尝鲜。",
      requiredExternalEvidence: 7,
      requiredTotalEvidence: 14,
      requiredOpposition: 3,
      requiredFreshWebEvidence: 3,
      minimumBehaviorStrength: 6,
      requiredStrongBehaviorCards: 2,
      requiredSourceBudgets: ["payment", "distribution", "alternative", "opposition", "timing"],
      requiredEvidenceTypes: [
        "付费、续费、留存、复用或推荐证据",
        "支持成本、流失原因或负面反馈",
        "可重复获客渠道证据"
      ],
      decisionRule: "早期牵引阶段必须看留存/付费/推荐，不能只看注册或访问。"
    };
  }

  if (stage === "growth" || stage === "mature") {
    return {
      stage,
      label: stage === "growth" ? "增长期" : "成熟期",
      evidenceGoal: "证明增长可重复、单位经济成立，并且竞争压力没有吞掉差异化。",
      requiredExternalEvidence: 8,
      requiredTotalEvidence: 16,
      requiredOpposition: 3,
      requiredFreshWebEvidence: 4,
      minimumBehaviorStrength: 6,
      requiredStrongBehaviorCards: 3,
      requiredSourceBudgets: ["payment", "distribution", "alternative", "opposition", "timing"],
      requiredEvidenceTypes: [
        "付费留存、推荐、CAC/LTV 或销售转化证据",
        "渠道可重复性和边际成本证据",
        "竞品、迁移成本和价格抗拒反证"
      ],
      decisionRule: "增长期必须证明单位经济和分发可重复，不能只看需求存在。"
    };
  }

  return {
    stage,
    label: "衰退期",
    evidenceGoal: "判断需求是否迁移、替代方案是否吞噬市场，以及是否值得 reposition。",
    requiredExternalEvidence: 6,
    requiredTotalEvidence: 12,
    requiredOpposition: 3,
    requiredFreshWebEvidence: 3,
    minimumBehaviorStrength: 5,
    requiredStrongBehaviorCards: 2,
    requiredSourceBudgets: ["alternative", "opposition", "payment", "timing"],
    requiredEvidenceTypes: [
      "流失、低频、替代迁移或负面反馈",
      "仍然付费或强需求的细分人群",
      "重定位后可验证的新场景"
    ],
    decisionRule: "衰退期应优先判断是否重定位或停止，而不是继续优化旧命题。"
  };
}

function inferTargetUser(text: string) {
  const match = text.match(/(?:for|给|面向|target user|目标用户)\s*[:：]?\s*([^\n。；;]{2,40})/i);
  return match?.[1]?.trim() || "当前假设的目标用户";
}

function capConfidence(
  score: number,
  context: {
    evidenceCards: EvidenceCard[];
    webCards: EvidenceCard[];
    supportCards: EvidenceCard[];
    objectiveEvidenceRatio: number;
    unknownRecencyRatio: number;
    lifecycleEvidenceStandard: LifecycleEvidenceStandard;
  }
) {
  let capped = score;
  const strongSupportCount = context.supportCards.filter(
    (card) => card.behaviorStrength >= context.lifecycleEvidenceStandard.minimumBehaviorStrength
  ).length;
  if (strongSupportCount < context.lifecycleEvidenceStandard.requiredStrongBehaviorCards) {
    capped = Math.min(capped, 60);
  }
  if (context.webCards.length === 0) capped = Math.min(capped, 35);
  if (context.webCards.length < context.lifecycleEvidenceStandard.requiredExternalEvidence) {
    capped = Math.min(capped, 55);
  }
  if (context.evidenceCards.length < context.lifecycleEvidenceStandard.requiredTotalEvidence) {
    capped = Math.min(capped, 50);
  }
  if (context.unknownRecencyRatio > 0.4) capped = Math.min(capped, 55);
  if (context.objectiveEvidenceRatio < 0.5) capped = Math.min(capped, 60);
  return Math.max(10, Math.min(100, capped));
}

function verdictFor(
  confidenceScore: number,
  supportCards: EvidenceCard[],
  opposeCards: EvidenceCard[],
  stop?: EvidenceStop
): EvidenceVerdict {
  if (stop) return "insufficient";
  if (opposeCards.length && supportCards.length) return "mixed";
  if (confidenceScore >= 72) return "strong_support";
  if (supportCards.length) return "weak_support";
  if (opposeCards.length) return "weak_opposition";
  return "insufficient";
}

function summarizeCluster(
  title: string,
  supportCards: EvidenceCard[],
  opposeCards: EvidenceCard[]
) {
  if (supportCards.length && opposeCards.length) {
    return `${title}同时存在支持和反证，需要进一步拆分目标用户与场景。`;
  }
  if (supportCards.length) {
    return `${title}已有 ${supportCards.length} 条支持信号，但仍需更强行为证据。`;
  }
  return `${title}主要体现为反证或风险，需要优先验证。`;
}

function weightedCardScore(cards: EvidenceCard[]) {
  return Math.round(cards.reduce((sum, card) => sum + cardWeight(card), 0));
}

function cardWeight(card: EvidenceCard) {
  return (
    card.behaviorStrength *
    card.relevanceScore *
    card.credibilityScore *
    card.recencyWeight *
    card.lifecycleRelevance *
    12
  );
}

function weightForRecency(bucket: EvidenceCard["recencyBucket"]) {
  if (bucket === "fresh") return 1;
  if (bucket === "usable") return 0.65;
  if (bucket === "historical") return 0.3;
  return 0.2;
}

function ratio(value: number, total: number) {
  if (!total) return 0;
  return value / total;
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
