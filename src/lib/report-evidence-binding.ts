import type {
  EvidenceBrief,
  EvidenceCard,
  ProductDiagnosisReport,
  ReportEvidenceBinding,
  ReportEvidenceTargetSection,
  SourceBudget
} from "./types";

type BuildReportEvidenceBindingsInput = {
  report: ProductDiagnosisReport;
  evidenceBrief?: EvidenceBrief;
};

type BindingTarget = {
  targetSection: ReportEvidenceTargetSection;
  targetIndex?: number;
  targetKey: string;
  targetLabel: string;
  claimText: string;
};

type ScoredCard = {
  card: EvidenceCard;
  score: number;
  assumptionMatched: boolean;
};

const maxEvidencePerDirection = 3;

export function buildReportEvidenceBindings({
  report,
  evidenceBrief
}: BuildReportEvidenceBindingsInput): ReportEvidenceBinding[] {
  if (!evidenceBrief) return [];
  const cards = evidenceBrief.evidenceCards ?? [];
  const targets = reportBindingTargets(report);

  return targets.map((target) =>
    bindTargetToEvidence({
      target,
      evidenceBrief,
      cards
    })
  );
}

function reportBindingTargets(report: ProductDiagnosisReport): BindingTarget[] {
  return [
    {
      targetSection: "potential_verdict",
      targetKey: "potential_verdict",
      targetLabel: "产品潜力",
      claimText: [report.share_summary?.one_line_diagnosis, report.potential_verdict]
        .filter(Boolean)
        .join("\n")
    },
    ...(report.market_evidence ?? []).map((item, index) => ({
      targetSection: "market_evidence" as const,
      targetIndex: index,
      targetKey: `market_evidence:${index}:${item.signal}`,
      targetLabel: `市场证据：${item.signal}`,
      claimText: [item.signal, item.evidence, item.interpretation].join("\n")
    })),
    ...(report.top_issues ?? []).map((item, index) => ({
      targetSection: "top_issues" as const,
      targetIndex: index,
      targetKey: `top_issues:${index}:${item.title}`,
      targetLabel: `问题：${item.title}`,
      claimText: [item.title, item.why_it_matters, item.how_to_fix].join("\n")
    })),
    ...(report.actionable_suggestions ?? []).map((item, index) => ({
      targetSection: "actionable_suggestions" as const,
      targetIndex: index,
      targetKey: `actionable_suggestions:${index}`,
      targetLabel: `行动：${item.slice(0, 24)}`,
      claimText: item
    }))
  ];
}

function bindTargetToEvidence({
  target,
  evidenceBrief,
  cards
}: {
  target: BindingTarget;
  evidenceBrief: EvidenceBrief;
  cards: EvidenceCard[];
}): ReportEvidenceBinding {
  const profile = targetBindingProfile(target);
  const scoredCards = cards
    .filter((card) => isBindableSourceForTarget(card, target, profile))
    .map((card) => ({
      card,
      score: scoreCardForTarget(card, target, profile),
      assumptionMatched: profile.assumptions.has(normalizeAssumption(card.assumptionId))
    }))
    .filter((item) => isCandidateStrongEnough(item, target, profile))
    .sort((a, b) => b.score - a.score);

  const fallbackCards = fallbackEvidenceForTarget(target, evidenceBrief, profile);
  const supportCards = selectCards(scoredCards, fallbackCards, "support", target);
  const oppositionCards = selectCards(scoredCards, fallbackCards, "oppose", target);
  const neutralCards = selectCards(scoredCards, fallbackCards, "neutral", target).slice(0, 1);
  const missingEvidence = bindingMissingEvidence({
    target,
    evidenceBrief
  });
  const status = bindingStatus({
    target,
    supportCards,
    oppositionCards,
    neutralCards,
    missingEvidence
  });
  const confidence = bindingConfidence({
    status,
    supportCards,
    oppositionCards,
    neutralCards
  });

  return {
    id: `binding-${target.targetKey.replace(/[^a-z0-9:_-]+/gi, "-").slice(0, 80)}`,
    ...target,
    status,
    confidence,
    supportEvidenceIds: supportCards.map((item) => item.card.id),
    oppositionEvidenceIds: oppositionCards.map((item) => item.card.id),
    neutralEvidenceIds: neutralCards.map((item) => item.card.id),
    rationale: bindingRationale({
      target,
      status,
      supportCards,
      oppositionCards,
      neutralCards
    }),
    missingEvidence
  };
}

function scoreCardForTarget(card: EvidenceCard, target: BindingTarget, profile: BindingProfile) {
  const targetTerms = termsForText(target.claimText);
  const cardTerms = termsForText(
    [
      card.claim,
      card.sourceTitle,
      card.quoteOrSnippet,
      card.interpretation,
      card.signalType,
      card.assumptionId
    ].join("\n")
  );
  const overlap = [...targetTerms].filter((term) => cardTerms.has(term)).length;
  const assumptionScore = profile.assumptions.has(normalizeAssumption(card.assumptionId))
    ? 34
    : isUploadedMaterialEvidence(card) && profile.isProductMaterialClaim
      ? 22
      : -18;
  const sectionScore = sectionDirectionBoost(target, card);
  const confidenceScore = Math.round((card.confidence ?? 0) * 0.22);
  const sourceScore = sourceStrengthScore(card);
  const recencyScore =
    card.recencyBucket === "fresh"
      ? 10
      : card.recencyBucket === "usable"
        ? 7
        : card.recencyBucket === "historical"
          ? -6
          : 0;

  const gapPenalty =
    profile.isGapClaim && target.targetSection !== "potential_verdict" && !cardLooksLikeGapEvidence(card)
      ? -45
      : 0;

  return overlap * 8 + assumptionScore + sectionScore + confidenceScore + sourceScore + recencyScore + gapPenalty;
}

type BindingProfile = {
  assumptions: Set<string>;
  isGapClaim: boolean;
  isExperimentClaim: boolean;
  isProductMaterialClaim: boolean;
};

function targetBindingProfile(target: BindingTarget): BindingProfile {
  return {
    assumptions: targetAssumptions(target.claimText),
    isGapClaim: /缺失|未找到|没有|无外部|不足|失败|跳过|无法|缺少|待验证|unknown|insufficient|missing|failed|skipped/i.test(
      target.claimText
    ),
    isExperimentClaim: /experiment|fake door|测试|实验|访谈|留资|点击|转化|样本|指标|问卷|访谈/i.test(
      target.claimText
    ),
    isProductMaterialClaim: /readme|prd|文档|材料|截图|页面|首页|landing|价值主张|定位|文案|用户画像|演示|案例/i.test(
      target.claimText
    )
  };
}

function isBindableSourceForTarget(card: EvidenceCard, target: BindingTarget, profile: BindingProfile) {
  const sourceType = card.sourceType ?? "";
  const cardAssumption = normalizeAssumption(card.assumptionId);
  const assumptionMatched = profile.assumptions.has(cardAssumption);

  if (target.targetSection === "potential_verdict") {
    return !isUploadedMaterialEvidence(card);
  }

  if (target.targetSection === "market_evidence") {
    if (!assumptionMatched) return false;
    if (profile.isGapClaim && !cardLooksLikeGapEvidence(card)) return false;
    if (isExperimentEvidence(card)) return profile.isExperimentClaim && experimentEvidenceMatchesTarget(card, target);
    return !isUploadedMaterialEvidence(card);
  }

  if (target.targetSection === "top_issues") {
    if (isUploadedMaterialEvidence(card)) return profile.isProductMaterialClaim;
    if (isExperimentEvidence(card)) {
      return profile.isExperimentClaim && assumptionMatched && experimentEvidenceMatchesTarget(card, target);
    }
    if (profile.isGapClaim && !cardLooksLikeGapEvidence(card)) return false;
    return assumptionMatched || specificTermOverlap(card, target) >= 3;
  }

  if (target.targetSection === "actionable_suggestions") {
    if (isUploadedMaterialEvidence(card)) return profile.isProductMaterialClaim;
    if (isExperimentEvidence(card)) {
      return profile.isExperimentClaim && assumptionMatched && experimentEvidenceMatchesTarget(card, target);
    }
    if (profile.isGapClaim && !cardLooksLikeGapEvidence(card)) return false;
    return assumptionMatched || (profile.isExperimentClaim && specificTermOverlap(card, target) >= 2);
  }

  return sourceType !== "uploaded_material";
}

function isCandidateStrongEnough(
  item: ScoredCard,
  target: BindingTarget,
  profile: BindingProfile
) {
  if (item.score <= 0) return false;
  const confidence = item.card.confidence ?? 0;
  const sourceType = item.card.sourceType ?? "";

  if (target.targetSection === "market_evidence" && !item.assumptionMatched) return false;
  if (profile.isGapClaim && target.targetSection !== "potential_verdict" && !cardLooksLikeGapEvidence(item.card)) {
    return false;
  }
  if (isLowQualitySearchEvidence(item.card) && item.score < 52) return false;
  if (isExperimentEvidence(item.card) && !profile.isExperimentClaim && target.targetSection !== "potential_verdict") {
    return false;
  }
  if (
    isExperimentEvidence(item.card) &&
    target.targetSection !== "potential_verdict" &&
    !experimentEvidenceMatchesTarget(item.card, target)
  ) {
    return false;
  }
  if (!isUploadedMaterialEvidence(item.card) && confidence < minimumEvidenceConfidence(sourceType, target)) {
    return false;
  }

  return item.score >= candidateThreshold(target);
}

function candidateThreshold(target: BindingTarget) {
  if (target.targetSection === "potential_verdict") return 34;
  if (target.targetSection === "market_evidence") return 42;
  if (target.targetSection === "top_issues") return 36;
  return 34;
}

function minimumEvidenceConfidence(sourceType: string, target: BindingTarget) {
  if (target.targetSection === "potential_verdict") return 18;
  if (sourceType === "search_result") return 18;
  if (sourceType === "crawled_url" || sourceType === "github_repository") return 20;
  if (sourceType.startsWith("experiment_")) return 20;
  return 16;
}

function sourceStrengthScore(card: EvidenceCard) {
  if (card.sourceType === "crawled_url") return 18;
  if (card.sourceType === "github_repository") return 14;
  if (card.sourceType === "search_result") return 8;
  if (card.sourceType === "uploaded_material") return 8;
  if (card.sourceType === "experiment_result") return 14;
  if ((card.sourceType ?? "").startsWith("experiment_")) return 10;
  return 6;
}

function isUploadedMaterialEvidence(card: EvidenceCard) {
  return card.sourceType === "uploaded_material";
}

function isExperimentEvidence(card: EvidenceCard) {
  return (card.sourceType ?? "").startsWith("experiment_");
}

function isLowQualitySearchEvidence(card: EvidenceCard) {
  return (
    (card.sourceType === "search_result" || card.sourceType === "crawled_url") &&
    (card.confidence ?? 0) < 22
  );
}

function experimentEvidenceMatchesTarget(card: EvidenceCard, target: BindingTarget) {
  const targetKinds = experimentKinds(target.claimText);
  const cardText = [
    card.sourceTitle,
    card.claim,
    card.quoteOrSnippet,
    card.interpretation,
    card.signalType
  ].join("\n");
  const cardKinds = experimentKinds(cardText);
  if (!targetKinds.size || !cardKinds.size) return specificTermOverlap(card, target) >= 4;
  return [...targetKinds].some((kind) => cardKinds.has(kind));
}

function experimentKinds(text: string) {
  const lower = text.toLowerCase();
  const kinds = new Set<string>();
  if (/fake door|pricing|price|定价|价格|付费页|pro plan|按钮|点击|留资|转化|landing/.test(lower)) {
    kinds.add("pricing");
  }
  if (/interview|访谈|story-based|用户访谈|客户访谈/.test(lower)) {
    kinds.add("interview");
  }
  if (/survey|问卷|表单|调研/.test(lower)) {
    kinds.add("survey");
  }
  if (/ocr|截图|图片|screen/.test(lower)) {
    kinds.add("artifact");
  }
  if (/csv|metric|指标|样本|数据/.test(lower)) {
    kinds.add("metric");
  }
  return kinds;
}

function cardLooksLikeGapEvidence(card: EvidenceCard) {
  return /缺失|未找到|没有|失败|跳过|无法|不足|无外部|429|skipped|failed|missing|insufficient/i.test(
    [card.claim, card.sourceTitle, card.quoteOrSnippet, card.interpretation, card.caveat]
      .filter(Boolean)
      .join("\n")
  );
}

function specificTermOverlap(card: EvidenceCard, target: BindingTarget) {
  const targetTerms = termsForText(target.claimText);
  const cardTerms = termsForText(
    [card.claim, card.sourceTitle, card.quoteOrSnippet, card.interpretation, card.signalType].join("\n")
  );
  return [...targetTerms].filter((term) => cardTerms.has(term)).length;
}

function sectionDirectionBoost(target: BindingTarget, card: EvidenceCard) {
  if (target.targetSection === "potential_verdict") {
    return card.direction === "support" || card.direction === "oppose" ? 10 : 2;
  }
  if (target.targetSection === "top_issues") {
    return card.direction === "oppose" ? 22 : card.direction === "neutral" ? 6 : 2;
  }
  if (target.targetSection === "actionable_suggestions") {
    return /experiment|实验|测试|访谈|定价|价格|留资|点击|渠道|社区/i.test(target.claimText)
      ? 10
      : 4;
  }
  return card.direction === "support" ? 18 : card.direction === "oppose" ? 12 : 4;
}

function fallbackEvidenceForTarget(
  target: BindingTarget,
  evidenceBrief: EvidenceBrief,
  profile: BindingProfile
): ScoredCard[] {
  if (target.targetSection === "potential_verdict") {
    const strongestSupport = Array.isArray(evidenceBrief.strongestSupport)
      ? evidenceBrief.strongestSupport
      : [];
    const strongestOpposition = Array.isArray(evidenceBrief.strongestOpposition)
      ? evidenceBrief.strongestOpposition
      : [];
    return [
      ...strongestSupport
        .filter((card) => card.sourceType !== "uploaded_material")
        .map((card) => ({ card, score: 40, assumptionMatched: profile.assumptions.has(normalizeAssumption(card.assumptionId)) })),
      ...strongestOpposition
        .filter((card) => card.sourceType !== "uploaded_material")
        .map((card) => ({ card, score: 38, assumptionMatched: profile.assumptions.has(normalizeAssumption(card.assumptionId)) }))
    ];
  }

  const evidenceCards = Array.isArray(evidenceBrief.evidenceCards)
    ? evidenceBrief.evidenceCards
    : [];
  return evidenceCards
    .filter((card) => isBindableSourceForTarget(card, target, profile))
    .filter((card) => profile.assumptions.has(normalizeAssumption(card.assumptionId)))
    .filter((card) => !profile.isGapClaim || cardLooksLikeGapEvidence(card))
    .map((card) => ({ card, score: 22, assumptionMatched: true }))
    .sort((a, b) => b.card.confidence - a.card.confidence);
}

function selectCards(
  scoredCards: ScoredCard[],
  fallbackCards: ScoredCard[],
  direction: EvidenceCard["direction"],
  target: BindingTarget
) {
  const threshold = target.targetSection === "potential_verdict" ? 18 : 24;
  const primary = scoredCards.filter((item) => item.card.direction === direction && item.score >= threshold);
  const fallback = fallbackCards.filter((item) => item.card.direction === direction);
  return uniqueScoredCards([...primary, ...fallback]).slice(0, maxEvidencePerDirection);
}

function uniqueScoredCards(items: ScoredCard[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.card.id)) return false;
    seen.add(item.card.id);
    return true;
  });
}

function bindingStatus({
  target,
  supportCards,
  oppositionCards,
  neutralCards,
  missingEvidence
}: {
  target: BindingTarget;
  supportCards: ScoredCard[];
  oppositionCards: ScoredCard[];
  neutralCards: ScoredCard[];
  missingEvidence: string[];
}): ReportEvidenceBinding["status"] {
  const evidenceCount = supportCards.length + oppositionCards.length + neutralCards.length;
  const averageConfidence = averageCardConfidence([
    ...supportCards,
    ...oppositionCards,
    ...neutralCards
  ]);
  const isGapClaim = targetBindingProfile(target).isGapClaim;
  if (!evidenceCount) return missingEvidence.length ? "weak" : "missing";
  if (isGapClaim && target.targetSection !== "potential_verdict") return "weak";
  if (averageConfidence < 34) return "weak";
  if (
    target.targetSection === "potential_verdict" &&
    uniqueCardAssumptions([...supportCards, ...oppositionCards, ...neutralCards]).length < 2
  ) {
    return "weak";
  }
  if (target.targetSection === "top_issues") {
    if (oppositionCards.length >= 1 || evidenceCount >= 2) return "bound";
    return "weak";
  }
  if (supportCards.length >= 1 && evidenceCount >= 2) return "bound";
  return "weak";
}

function bindingConfidence({
  status,
  supportCards,
  oppositionCards,
  neutralCards
}: {
  status: ReportEvidenceBinding["status"];
  supportCards: ScoredCard[];
  oppositionCards: ScoredCard[];
  neutralCards: ScoredCard[];
}) {
  if (status === "missing") return 0;
  const cards = [...supportCards, ...oppositionCards, ...neutralCards];
  const averageConfidence = averageCardConfidence(cards);
  return Math.max(0, Math.min(100, averageConfidence + (status === "bound" ? 8 : -12)));
}

function averageCardConfidence(cards: ScoredCard[]) {
  return cards.length
    ? Math.round(cards.reduce((sum, item) => sum + (item.card.confidence ?? 0), 0) / cards.length)
    : 0;
}

function uniqueCardAssumptions(cards: ScoredCard[]) {
  return [...new Set(cards.map((item) => normalizeAssumption(item.card.assumptionId)).filter(Boolean))];
}

function bindingMissingEvidence({
  target,
  evidenceBrief
}: {
  target: BindingTarget;
  evidenceBrief: EvidenceBrief;
}) {
  const assumptions = targetAssumptions(target.claimText);
  const sourceBudgets = Array.isArray(evidenceBrief.sourceBudgets)
    ? evidenceBrief.sourceBudgets
    : [];
  const evidenceGaps = Array.isArray(evidenceBrief.evidenceGaps)
    ? evidenceBrief.evidenceGaps
    : [];
  const budgetGaps = sourceBudgets
    .filter((budget) => assumptions.has(normalizeAssumption(budget.assumptionId)) && budget.status !== "met")
    .flatMap((budget) => budget.missingEvidence.map((item) => `${budget.label}：${item}`));
  const stopGaps = evidenceBrief.evidenceStop?.minimumEvidenceNeeded ?? [];
  const generic =
    target.targetSection === "potential_verdict"
      ? stopGaps
      : evidenceGaps
          .filter((gap) => assumptions.has(normalizeAssumption(gap.assumptionId)))
          .map((gap) => gap.missingEvidence);
  return uniqueStrings([...budgetGaps, ...generic]).slice(0, 4);
}

function bindingRationale({
  target,
  status,
  supportCards,
  oppositionCards,
  neutralCards
}: {
  target: BindingTarget;
  status: ReportEvidenceBinding["status"];
  supportCards: ScoredCard[];
  oppositionCards: ScoredCard[];
  neutralCards: ScoredCard[];
}) {
  const evidenceCount = supportCards.length + oppositionCards.length + neutralCards.length;
  if (status === "missing") {
    return `「${target.targetLabel}」没有找到可复核 Evidence Card 直接支撑，需要补原始证据或更具体的网页证据。`;
  }
  if (status === "weak") {
    return `「${target.targetLabel}」只绑定到 ${evidenceCount} 条证据，适合低/中置信表达。`;
  }
  return `「${target.targetLabel}」绑定到 ${supportCards.length} 条支持证据、${oppositionCards.length} 条反证/风险和 ${neutralCards.length} 条上下文证据。`;
}

function targetAssumptions(text: string) {
  const lower = text.toLowerCase();
  const assumptions = new Set<string>();
  if (/price|pricing|paid|pay|revenue|customer|付费|定价|收入|预算|商业化/.test(lower)) {
    assumptions.add("payment");
  }
  if (/alternative|competitor|compare|替代|竞品|对比|迁移/.test(lower)) {
    assumptions.add("alternative");
  }
  if (/channel|distribution|product hunt|hacker news|社区|分发|渠道|传播|获客/.test(lower)) {
    assumptions.add("distribution");
  }
  if (/recent|release|changelog|roadmap|updated|最近|近期|时效|更新|发布/.test(lower)) {
    assumptions.add("timing");
    assumptions.add("recency");
  }
  if (/ai|agent|llm|模型|智能体|自动化/.test(lower)) {
    assumptions.add("ai_advantage");
    assumptions.add("ai-advantage");
  }
  if (/fail|failed|abandoned|shutdown|complaint|negative|反证|失败|停更|关闭|负面|太贵|不用|风险/.test(lower)) {
    assumptions.add("opposition");
  }
  if (!assumptions.size || /problem|pain|痛点|需求|任务|场景|workaround|抱怨|投诉/.test(lower)) {
    assumptions.add("problem");
  }
  return new Set([...assumptions].map(normalizeAssumption));
}

function normalizeAssumption(value: string) {
  return value.toLowerCase().replace(/_/g, "-");
}

function termsForText(text: string) {
  const lower = text.toLowerCase();
  const terms = new Set<string>();
  for (const match of lower.match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []) {
    if (!isStopTerm(match)) terms.add(match);
  }
  for (const match of lower.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    const chars = [...match];
    for (let index = 0; index < chars.length - 1; index += 1) {
      const term = `${chars[index]}${chars[index + 1]}`;
      if (!isStopTerm(term)) terms.add(term);
    }
  }
  for (const keyword of domainKeywords()) {
    if (lower.includes(keyword)) terms.add(keyword);
  }
  return terms;
}

function isStopTerm(term: string) {
  return stopTerms().has(term);
}

function stopTerms() {
  return new Set([
    "产品",
    "用户",
    "证据",
    "市场",
    "报告",
    "分析",
    "判断",
    "当前",
    "需要",
    "可以",
    "相关",
    "支持",
    "反驳",
    "削弱",
    "补充",
    "原始",
    "材料",
    "结果",
    "测试",
    "实验",
    "工具",
    "验证",
    "潜力",
    "问题",
    "建议",
    "缺失",
    "找到",
    "没有",
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "product",
    "user",
    "users",
    "evidence",
    "test",
    "tool",
    "report"
  ]);
}

function domainKeywords() {
  return [
    "readme",
    "github",
    "stars",
    "pricing",
    "paid",
    "users",
    "adoption",
    "release",
    "changelog",
    "alternative",
    "competitor",
    "agent",
    "llm",
    "ai",
    "付费",
    "定价",
    "用户",
    "痛点",
    "替代",
    "竞品",
    "采用",
    "生产",
    "社区",
    "分发",
    "留资",
    "访谈",
    "反证",
    "停更",
    "失败",
    "更新",
    "模型",
    "智能体"
  ];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
