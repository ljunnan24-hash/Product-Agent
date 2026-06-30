import type {
  EvidenceStopRule,
  EvidenceSearchIntent,
  EvidenceSearchQuery,
  EvidenceSearchTarget,
  SourceBudget,
  UploadedMaterial
} from "./types";

type QueryPlannerInput = {
  brief: string;
  productName: string;
  materials: UploadedMaterial[];
};

const maxQueries = 11;

type QueryTemplate = {
  assumptionId: string;
  intent: EvidenceSearchIntent;
  targetDirection: EvidenceSearchTarget;
  priority: 1 | 2 | 3;
  query: string;
  rationale: string;
  expectedEvidence: string;
};

type BudgetCoverage = Record<
  string,
  {
    supportCandidates: number;
    oppositionCandidates: number;
    freshCandidates: number;
  }
>;

export function buildEvidenceSearchPlan(
  input: QueryPlannerInput
): EvidenceSearchQuery[] {
  const materialText = input.materials
    .map((material) => material.extractedText || material.textPreview || "")
    .join("\n\n");
  const context = [input.brief, materialText].filter(Boolean).join("\n\n");
  const productName = normalizeProductName(input.productName, context);
  const targetUser = inferTargetUser(context);
  const problemPhrase = inferProblemPhrase(context);
  const category = inferCategory(context, productName);
  const base = compactTerms([productName, category, problemPhrase]).join(" ");
  const target = compactTerms([targetUser, category]).join(" ");

  const templates: QueryTemplate[] = [
    {
      assumptionId: "problem",
      intent: "problem",
      targetDirection: "support",
      priority: 1,
      query: compactTerms([
        problemPhrase || category || productName,
        targetUser,
        "problem pain workaround"
      ]).join(" "),
      rationale: "验证目标用户是否真的在公开场合描述过这个问题。",
      expectedEvidence: "近期用户讨论、抱怨、问题帖、手动 workaround。"
    },
    {
      assumptionId: "payment",
      intent: "payment",
      targetDirection: "support",
      priority: 1,
      query: compactTerms([base || target, "pricing paid subscription"]).join(" "),
      rationale: "验证相邻问题是否已经有人付费或存在预算。",
      expectedEvidence: "定价页、付费竞品、咨询服务、购买意向、预算讨论。"
    },
    {
      assumptionId: "alternative",
      intent: "alternative",
      targetDirection: "support",
      priority: 1,
      query: compactTerms([base || target, "alternative competitor compare"]).join(" "),
      rationale: "验证用户今天用什么替代方案解决同一问题。",
      expectedEvidence: "替代产品、对比文章、用户迁移讨论、开源项目。"
    },
    {
      assumptionId: "competitor",
      intent: "competitor_review",
      targetDirection: "support",
      priority: 2,
      query: compactTerms([base || target, "review complaints G2 Capterra Reddit"]).join(" "),
      rationale: "从评价和差评里找真实用户行为、满意点和未满足需求。",
      expectedEvidence: "评论、评分、差评、Reddit/HN 讨论、用户反馈。"
    },
    {
      assumptionId: "distribution",
      intent: "distribution",
      targetDirection: "support",
      priority: 2,
      query: compactTerms([target || base, "community forum newsletter product hunt"]).join(" "),
      rationale: "验证首批用户是否存在可触达渠道。",
      expectedEvidence: "活跃社区、榜单、发布帖、垂直媒体、Newsletter。"
    },
    {
      assumptionId: "opposition",
      intent: "opposition",
      targetDirection: "opposition",
      priority: 1,
      query: compactTerms([
        base || target,
        "failed shutdown no demand too expensive not worth it"
      ]).join(" "),
      rationale: "主动寻找失败、关闭、太贵、低频或不值得的反证。",
      expectedEvidence: "失败案例、关闭公告、负面评价、预算不足、低频使用。"
    },
    {
      assumptionId: "timing",
      intent: "recency",
      targetDirection: "freshness",
      priority: 2,
      query: compactTerms([base || target, "2025 2026 trend launch funding"]).join(" "),
      rationale: "验证证据是否足够新，避免用过期市场信号判断当前机会。",
      expectedEvidence: "最近发布、融资、趋势、招聘、产品更新、市场变化。"
    },
    {
      assumptionId: "ai-advantage",
      intent: "ai_advantage",
      targetDirection: "context",
      priority: 3,
      query: compactTerms([base || target, "AI automation agent workflow"]).join(" "),
      rationale: "验证 AI 是否真能提供新的优势，而不是普通软件包装。",
      expectedEvidence: "自动化案例、Agent 工作流、模型能力边界、用户采用信号。"
    }
  ];
  const githubTemplates = buildGitHubReadmeQueries(input.materials);
  const allTemplates = githubTemplates.length
    ? [...templates.slice(0, 4), ...githubTemplates, ...templates.slice(4)]
    : templates;

  return dedupeQueries(
    allTemplates
      .filter((item) => item.query.length >= 8)
      .map((item, index) => ({
        id: `query-${index + 1}`,
        phase: "seed" as const,
        ...item
      }))
  ).slice(0, maxQueries);
}

function buildGitHubReadmeQueries(materials: UploadedMaterial[]): QueryTemplate[] {
  const repo = inferGitHubRepoTerm(materials);
  if (!repo) return [];

  return [
    {
      assumptionId: "distribution",
      intent: "distribution",
      targetDirection: "support",
      priority: 1,
      query: compactTerms([repo, "GitHub stars forks adoption users case study"]).join(" "),
      rationale: "README/GitHub 项目需要单独验证开发者采用和生态扩散。",
      expectedEvidence: "stars/forks、采用案例、外部教程、用户或生态集成。"
    },
    {
      assumptionId: "opposition",
      intent: "opposition",
      targetDirection: "opposition",
      priority: 1,
      query: compactTerms([repo, "GitHub issues discussions complaints abandoned"]).join(" "),
      rationale: "README/GitHub 项目需要主动查 issue、discussion 和维护风险反证。",
      expectedEvidence: "未解决问题、负面讨论、停更、维护风险或迁移抱怨。"
    },
    {
      assumptionId: "timing",
      intent: "recency",
      targetDirection: "freshness",
      priority: 2,
      query: compactTerms([repo, "release changelog roadmap 2025 2026"]).join(" "),
      rationale: "README/GitHub 项目需要确认最近 release、路线图和维护活跃度。",
      expectedEvidence: "近期 release、changelog、路线图、维护状态或版本更新。"
    }
  ];
}

export function buildBudgetFollowUpQueries({
  input,
  existingQueries,
  coverage
}: {
  input: QueryPlannerInput;
  existingQueries: EvidenceSearchQuery[];
  coverage: BudgetCoverage;
}): EvidenceSearchQuery[] {
  const materialText = input.materials
    .map((material) => material.extractedText || material.textPreview || "")
    .join("\n\n");
  const context = [input.brief, materialText].filter(Boolean).join("\n\n");
  const productName = normalizeProductName(input.productName, context);
  const targetUser = inferTargetUser(context);
  const problemPhrase = inferProblemPhrase(context);
  const category = inferCategory(context, productName);
  const base = compactTerms([productName, category, problemPhrase]).join(" ");
  const target = compactTerms([targetUser, category]).join(" ");
  const queryBase = base || target || productName || category || problemPhrase;
  const existing = new Set(existingQueries.map((query) => query.query.toLowerCase()));

  const definitions: Array<{
    assumptionId: string;
    intent: EvidenceSearchIntent;
    requiredSupport: number;
    requiredOpposition: number;
    supportTerms: string;
    oppositionTerms: string;
    supportRationale: string;
    oppositionRationale: string;
    expectedSupport: string;
    expectedOpposition: string;
    priority: 1 | 2 | 3;
  }> = [
    {
      assumptionId: "problem",
      intent: "problem",
      requiredSupport: 2,
      requiredOpposition: 1,
      supportTerms: "user problem pain discussion workaround reddit",
      oppositionTerms: "not a problem no demand low priority nice to have infrequent",
      supportRationale: "补查痛点真实性，寻找用户近期讨论和 workaround。",
      oppositionRationale: "补查痛点反证，寻找用户不认为这是问题的证据。",
      expectedSupport: "用户问题帖、抱怨、手动 workaround。",
      expectedOpposition: "低优先级、无需求、已有足够方案的讨论。",
      priority: 1
    },
    {
      assumptionId: "payment",
      intent: "payment",
      requiredSupport: 1,
      requiredOpposition: 1,
      supportTerms: "pricing subscription paid plan budget",
      oppositionTerms: "too expensive not worth paying free alternative overpriced",
      supportRationale: "补查付费意愿，寻找价格、预算或购买信号。",
      oppositionRationale: "补查付费反证，寻找太贵、不值得付费或免费替代。",
      expectedSupport: "定价页、付费计划、咨询服务、采购预算。",
      expectedOpposition: "价格抱怨、免费替代、拒绝付费讨论。",
      priority: 1
    },
    {
      assumptionId: "alternative",
      intent: "alternative",
      requiredSupport: 2,
      requiredOpposition: 1,
      supportTerms: "alternative competitor compare tools",
      oppositionTerms: "better alternative incumbent switching cost already use hard to switch",
      supportRationale: "补查替代方案，确认用户今天如何解决同一问题。",
      oppositionRationale: "补查替代方案反证，寻找强竞品、迁移成本或替代优势。",
      expectedSupport: "竞品、替代方案、对比文章、开源项目。",
      expectedOpposition: "强替代、低迁移意愿、现有方案足够好。",
      priority: 1
    },
    {
      assumptionId: "distribution",
      intent: "distribution",
      requiredSupport: 1,
      requiredOpposition: 1,
      supportTerms: "community forum newsletter product hunt launch",
      oppositionTerms: "hard to reach audience acquisition cost channel saturated crowded market",
      supportRationale: "补查分发渠道，寻找首批用户聚集处。",
      oppositionRationale: "补查分发反证，寻找触达难、渠道拥挤或获客成本风险。",
      expectedSupport: "活跃社区、榜单、发布帖、Newsletter。",
      expectedOpposition: "渠道拥挤、目标用户分散、获客成本高。",
      priority: 2
    },
    {
      assumptionId: "timing",
      intent: "recency",
      requiredSupport: 1,
      requiredOpposition: 0,
      supportTerms: "2025 2026 trend launch funding update",
      oppositionTerms: "",
      supportRationale: "补查时效性，寻找足够新的市场变化和发布信号。",
      oppositionRationale: "",
      expectedSupport: "近期发布、趋势、融资、招聘或更新。",
      expectedOpposition: "",
      priority: 2
    }
  ];

  const followUps: EvidenceSearchQuery[] = [];

  for (const definition of definitions) {
    const current = coverage[definition.assumptionId] ?? {
      supportCandidates: 0,
      oppositionCandidates: 0,
      freshCandidates: 0
    };
    if (current.supportCandidates < definition.requiredSupport) {
      followUps.push(
        makeBudgetQuery({
          id: `budget-${definition.assumptionId}-support`,
          assumptionId: definition.assumptionId,
          intent: definition.intent,
          targetDirection: "support",
          priority: definition.priority,
          query: compactTerms([queryBase, definition.supportTerms]).join(" "),
          rationale: definition.supportRationale,
          expectedEvidence: definition.expectedSupport
        })
      );
    }
    if (
      definition.requiredOpposition > 0 &&
      current.oppositionCandidates < definition.requiredOpposition
    ) {
      followUps.push(
        makeBudgetQuery({
          id: `budget-${definition.assumptionId}-opposition`,
          assumptionId: definition.assumptionId,
          intent: "opposition",
          targetDirection: "opposition",
          priority: definition.priority,
          query: compactTerms([queryBase, definition.oppositionTerms]).join(" "),
          rationale: definition.oppositionRationale,
          expectedEvidence: definition.expectedOpposition
        })
      );
    }
  }

  return followUps
    .filter((query) => query.query.length >= 8 && !existing.has(query.query.toLowerCase()))
    .slice(0, 8);
}

export function buildEvidenceLoopQueries({
  input,
  existingQueries,
  sourceBudgets,
  stopRules = [],
  round
}: {
  input: QueryPlannerInput;
  existingQueries: EvidenceSearchQuery[];
  sourceBudgets: SourceBudget[];
  stopRules?: EvidenceStopRule[];
  round: number;
}): EvidenceSearchQuery[] {
  const context = contextForInput(input);
  const productName = normalizeProductName(input.productName, context);
  const targetUser = inferTargetUser(context);
  const problemPhrase = inferProblemPhrase(context);
  const category = inferCategory(context, productName);
  const base = compactTerms([productName, category, problemPhrase]).join(" ");
  const target = compactTerms([targetUser, category]).join(" ");
  const queryBase = base || target || productName || category || problemPhrase;
  const existing = new Set(existingQueries.map((query) => query.query.toLowerCase()));
  const blockingRuleIds = new Set(
    stopRules.filter((rule) => rule.status === "block").map((rule) => rule.id)
  );
  const candidates: EvidenceSearchQuery[] = [];
  const unmetBudgets = sourceBudgets
    .filter((budget) => budget.status !== "met")
    .sort((a, b) => budgetSeverity(b) - budgetSeverity(a));

  for (const budget of unmetBudgets) {
    const definition = loopDefinitionForBudget(budget.assumptionId);
    const supportGap = Math.max(0, budget.requiredSupport - budget.currentSupport);
    const oppositionGap = Math.max(0, budget.requiredOpposition - budget.currentOpposition);

    if (supportGap > 0) {
      candidates.push(
        makeEvidenceLoopQuery({
          id: `loop-${round}-${budget.assumptionId}-support`,
          assumptionId: budget.assumptionId,
          intent: definition.intent,
          targetDirection: definition.supportTarget,
          priority: definition.priority,
          query: compactTerms([queryBase, definition.supportTerms]).join(" "),
          rationale: `${budget.label}未达标：${budget.missingEvidence.join("；")}。${definition.supportRationale}`,
          expectedEvidence: definition.expectedSupport
        })
      );
    }

    if (oppositionGap > 0) {
      candidates.push(
        makeEvidenceLoopQuery({
          id: `loop-${round}-${budget.assumptionId}-opposition`,
          assumptionId: budget.assumptionId,
          intent: "opposition",
          targetDirection: "opposition",
          priority: definition.priority,
          query: compactTerms([queryBase, definition.oppositionTerms]).join(" "),
          rationale: `${budget.label}反证不足：${budget.missingEvidence.join("；")}。${definition.oppositionRationale}`,
          expectedEvidence: definition.expectedOpposition
        })
      );
    }
  }

  if (blockingRuleIds.has("external_evidence") || blockingRuleIds.has("lifecycle_standard")) {
    candidates.push(
      makeEvidenceLoopQuery({
        id: `loop-${round}-external-support`,
        assumptionId: "problem",
        intent: "problem",
        targetDirection: "support",
        priority: 1,
        query: compactTerms([
          queryBase,
          "user discussion case study launch review feedback"
        ]).join(" "),
        rationale: "生命周期标准或外部证据数量未达标，补查更贴近真实用户行为的公开来源。",
        expectedEvidence: "用户讨论、案例、发布反馈、评论、榜单或产品评价。"
      })
    );
  }

  if (blockingRuleIds.has("temporal_validity")) {
    candidates.push(
      makeEvidenceLoopQuery({
        id: `loop-${round}-freshness-support`,
        assumptionId: "timing",
        intent: "recency",
        targetDirection: "freshness",
        priority: 2,
        query: compactTerms([queryBase, "2026 2025 launch update trend review"]).join(" "),
        rationale: "证据时效未达标，补查带日期的近期市场或产品信号。",
        expectedEvidence: "近期发布、更新、趋势、评论或市场变化。"
      })
    );
  }

  return candidates
    .filter((query) => query.query.length >= 8 && !existing.has(query.query.toLowerCase()))
    .filter(uniqueQuery)
    .slice(0, 6);
}

function makeBudgetQuery(
  query: Omit<EvidenceSearchQuery, "phase">
): EvidenceSearchQuery {
  return {
    ...query,
    phase: "budget_fill"
  };
}

function makeEvidenceLoopQuery(
  query: Omit<EvidenceSearchQuery, "phase">
): EvidenceSearchQuery {
  return {
    ...query,
    phase: "evidence_loop"
  };
}

function contextForInput(input: QueryPlannerInput) {
  const materialText = input.materials
    .map((material) => material.extractedText || material.textPreview || "")
    .join("\n\n");
  return [input.brief, materialText].filter(Boolean).join("\n\n");
}

function budgetSeverity(budget: SourceBudget) {
  const supportGap = Math.max(0, budget.requiredSupport - budget.currentSupport);
  const oppositionGap = Math.max(0, budget.requiredOpposition - budget.currentOpposition);
  const statusWeight =
    budget.status === "missing" ? 8 : budget.status === "planned" ? 6 : 3;
  return statusWeight + supportGap * 2 + oppositionGap * 3;
}

function loopDefinitionForBudget(assumptionId: string) {
  const definitions: Record<
    string,
    {
      intent: EvidenceSearchIntent;
      supportTarget: EvidenceSearchTarget;
      supportTerms: string;
      oppositionTerms: string;
      supportRationale: string;
      oppositionRationale: string;
      expectedSupport: string;
      expectedOpposition: string;
      priority: 1 | 2 | 3;
    }
  > = {
    problem: {
      intent: "problem",
      supportTarget: "support",
      supportTerms: "user problem pain discussion workaround reddit hn",
      oppositionTerms: "not a problem no demand low priority nice to have infrequent",
      supportRationale: "继续寻找真实痛点和 workaround。",
      oppositionRationale: "继续寻找无需求、低频或低优先级反证。",
      expectedSupport: "近期用户问题帖、抱怨、手动 workaround 或需求讨论。",
      expectedOpposition: "无需求、低优先级、已有方案足够好的公开讨论。",
      priority: 1
    },
    payment: {
      intent: "payment",
      supportTarget: "support",
      supportTerms: "pricing paid subscription budget purchase intent",
      oppositionTerms: "too expensive not worth paying free alternative overpriced",
      supportRationale: "继续寻找付费、预算或购买意图。",
      oppositionRationale: "继续寻找价格抗拒、免费替代或不值得付费反证。",
      expectedSupport: "定价页、付费计划、预算讨论、采购或预约信号。",
      expectedOpposition: "太贵、不值得付费、免费替代、拒绝购买的讨论。",
      priority: 1
    },
    alternative: {
      intent: "alternative",
      supportTarget: "support",
      supportTerms: "alternative competitor compare tools migration",
      oppositionTerms: "better alternative incumbent switching cost already use hard to switch",
      supportRationale: "继续确认用户今天如何解决问题。",
      oppositionRationale: "继续寻找强替代和迁移成本反证。",
      expectedSupport: "竞品、替代方案、对比文章、迁移讨论或开源项目。",
      expectedOpposition: "强竞品、迁移成本、已有方案足够好。",
      priority: 1
    },
    distribution: {
      intent: "distribution",
      supportTarget: "support",
      supportTerms: "community forum newsletter product hunt launch audience",
      oppositionTerms: "hard to reach audience acquisition cost channel saturated crowded market",
      supportRationale: "继续寻找首批用户聚集渠道。",
      oppositionRationale: "继续寻找触达难、渠道拥挤或获客成本反证。",
      expectedSupport: "活跃社区、发布帖、垂直媒体、Newsletter 或榜单。",
      expectedOpposition: "渠道拥挤、获客成本高、目标用户分散。",
      priority: 2
    },
    timing: {
      intent: "recency",
      supportTarget: "freshness",
      supportTerms: "2026 2025 trend launch funding update review",
      oppositionTerms: "outdated declining churn sunset discontinued",
      supportRationale: "继续寻找近期证据，避免用过期信号判断。",
      oppositionRationale: "继续寻找市场降温、停运或需求迁移反证。",
      expectedSupport: "近期发布、趋势、更新、融资、招聘或评论。",
      expectedOpposition: "停运、过时、需求下降或市场迁移信号。",
      priority: 2
    },
    opposition: {
      intent: "opposition",
      supportTarget: "opposition",
      supportTerms: "failed shutdown no demand too expensive not worth it low priority",
      oppositionTerms: "failed shutdown no demand too expensive not worth it low priority",
      supportRationale: "继续主动寻找反证，降低确认偏误。",
      oppositionRationale: "继续主动寻找失败、关闭、无需求、太贵或低频反证。",
      expectedSupport: "失败案例、关闭公告、负面评价或低需求讨论。",
      expectedOpposition: "失败案例、关闭公告、负面评价或低需求讨论。",
      priority: 1
    }
  };

  return definitions[assumptionId] ?? definitions.problem;
}

function uniqueQuery(query: EvidenceSearchQuery, index: number, array: EvidenceSearchQuery[]) {
  return array.findIndex((item) => item.query.toLowerCase() === query.query.toLowerCase()) === index;
}

function normalizeProductName(productName: string, context: string) {
  if (productName && productName !== "Untitled work") {
    return cleanQueryTerm(productName);
  }

  const heading = context.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return cleanQueryTerm(heading);

  const nameMatch = context.match(
    /(?:product|project|产品|项目|name|名称)\s*[:：]\s*([A-Za-z0-9\u4e00-\u9fa5 ._-]{2,60})/i
  );
  return cleanQueryTerm(nameMatch?.[1] || "");
}

function inferTargetUser(context: string) {
  if (/独立开发|indie/i.test(context)) return "indie hackers";
  if (/创始人|founder|创业/i.test(context)) return "founders";
  if (/产品经理|product manager/i.test(context)) return "product managers";
  if (/开发者|developer|github|readme|api/i.test(context)) return "developers";

  const match = context.match(
    /(?:for|给|面向|target user|目标用户)\s*[:：]?\s*([^\n。；;]{2,42})/i
  );
  const candidate = cleanQueryTerm(match?.[1] || "");
  if (isNoisyExtract(candidate)) return "";
  return candidate;
}

function inferProblemPhrase(context: string) {
  if (/产品.*潜力|潜力.*判断|验证.*产品|product potential/i.test(context)) {
    return "product potential validation";
  }
  if (/市场证据|证据.*调研|evidence/i.test(context)) {
    return "evidence-based market research";
  }
  if (/审美|taste|作品|设计能力/i.test(context)) {
    return "taste improvement design feedback";
  }

  const match = context.match(
    /(?:problem|pain|痛点|问题|解决)\s*[:：]?\s*([^\n。；;]{2,54})/i
  );
  const candidate = cleanQueryTerm(match?.[1] || "");
  if (candidate && !isNoisyExtract(candidate)) return candidate;

  const sentence = context
    .split(/[\n。.!?]/)
    .map((item) => item.trim())
    .find((item) => /help|solve|自动|分析|验证|判断|reduce|improve|提升|减少/.test(item));
  const fallback = cleanQueryTerm(sentence || "");
  return isNoisyExtract(fallback) ? "" : fallback;
}

function inferCategory(context: string, productName: string) {
  const lower = context.toLowerCase();
  if (/readme|github|developer|api|cli|sdk|开发者/.test(lower)) {
    return "developer tool";
  }
  if (/agent|workflow|自动|ai/.test(lower)) return "AI agent product";
  if (/saas|dashboard|crm|b2b/.test(lower)) return "B2B SaaS";
  if (/设计|审美|visual|brand|landing/.test(lower)) return "design tool";
  return productName ? "software product" : "";
}

function compactTerms(terms: string[]) {
  return terms
    .map(cleanQueryTerm)
    .filter((term, index, array) => term && array.indexOf(term) === index)
    .slice(0, 5);
}

function inferGitHubRepoTerm(materials: UploadedMaterial[]) {
  const readmeMaterial = materials.find(
    (material) =>
      material.sourceKind === "github_readme" ||
      material.name.toLowerCase().includes("github readme")
  );
  const fromName = readmeMaterial?.name.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/)?.[1];
  if (fromName) return fromName;

  const fromUrl = materials
    .flatMap((material) => [material.url, ...(material.extractedUrls ?? [])])
    .map((url) => url.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i)?.[1])
    .find(Boolean);
  return fromUrl ? fromUrl.replace(/\.git$/i, "") : "";
}

function cleanQueryTerm(term: string) {
  return term
    .replace(/[`"'“”‘’]/g, " ")
    .replace(/^[,，、。；;:：\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

function isNoisyExtract(term: string) {
  if (!term) return true;
  if (term.length > 36 && /[\u4e00-\u9fa5]/.test(term)) return true;
  return /上传|材料|README|PDF|自然语言|补充|文件|MVP 暂时|后续由 Agent|用户上传/.test(term);
}

function dedupeQueries(queries: EvidenceSearchQuery[]) {
  const seen = new Set<string>();
  return queries.filter((query) => {
    const key = query.query.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
