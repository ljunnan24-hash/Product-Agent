import type {
  BlindTestCase,
  BlindTestJudgment,
  BlindTestScores,
  DynamicBacktestRecord
} from "./types";

export const blindTestCases: BlindTestCase[] = [
  {
    id: "case-a-supabase",
    repo: "supabase/supabase",
    repoUrl: "https://github.com/supabase/supabase",
    materialType: "github_readme",
    promptFocus: "判断这个开源开发者产品是否还有继续投入的潜力，以及下一步最低成本验证什么。",
    whyIncluded: "强成功样本，用来检验 Agent 是否能识别清晰替代对象、高频开发者任务和生态采用。",
    hiddenOutcome: {
      label: "strong_success",
      summary: "开源 Firebase 替代方向形成了强开发者生态和商业化后验。",
      evidence: ["高 GitHub 采用", "清晰竞品替代", "持续商业化和生态增长"]
    }
  },
  {
    id: "case-b-posthog",
    repo: "PostHog/posthog",
    repoUrl: "https://github.com/PostHog/posthog",
    materialType: "github_readme",
    promptFocus: "判断这个开源产品分析工具的产品潜力、差异化和增长风险。",
    whyIncluded: "强成功但竞争密集样本，用来检验 Agent 是否能同时看到开源 wedge 和成熟市场竞争。",
    hiddenOutcome: {
      label: "strong_success",
      summary: "开源产品分析和增长套件有强采用，但竞争和产品复杂度也高。",
      evidence: ["开源采用强", "目标用户和替代方案明确", "多产品线导致复杂度风险"]
    }
  },
  {
    id: "case-c-appwrite",
    repo: "appwrite/appwrite",
    repoUrl: "https://github.com/appwrite/appwrite",
    materialType: "github_readme",
    promptFocus: "判断这个后端开发平台是否有潜力，以及相对 Supabase/Firebase 的风险。",
    whyIncluded: "相邻强竞品市场样本，用来检验 Agent 是否会因为 README 强表达而低估竞争压力。",
    hiddenOutcome: {
      label: "promising",
      summary: "开发者采用强，但差异化和生态竞争需要谨慎判断。",
      evidence: ["高 GitHub 采用", "明确后端平台任务", "强竞品压力"]
    }
  },
  {
    id: "case-d-calcom",
    repo: "calcom/cal.com",
    repoUrl: "https://github.com/calcom/cal.com",
    materialType: "github_readme",
    promptFocus: "判断这个开源排程产品的长期潜力、开源策略和商业化风险。",
    whyIncluded: "生命周期变化样本，用来检验 Agent 是否会考虑开源优势随时间变成安全/商业压力。",
    hiddenOutcome: {
      label: "mixed",
      summary: "早期开源差异化强，后期安全、商业化和许可策略引入复杂风险。",
      evidence: ["明确 Calendly 替代", "开源社区采用", "后期许可/商业策略变化"]
    }
  },
  {
    id: "case-e-swr",
    repo: "vercel/swr",
    repoUrl: "https://github.com/vercel/swr",
    materialType: "github_readme",
    promptFocus: "判断一个开发者库的潜力，不要直接用 SaaS 付费标准扣分。",
    whyIncluded: "库型开发者工具样本，用来校准 GitHub 采用、生态背书和商业化间接性的关系。",
    hiddenOutcome: {
      label: "promising",
      summary: "库型产品商业化不直接，但任务高频、生态背书和社区采用很强。",
      evidence: ["高频 React 数据获取任务", "Vercel/Next.js 生态", "大量开发者采用"]
    }
  },
  {
    id: "case-f-playwright",
    repo: "microsoft/playwright",
    repoUrl: "https://github.com/microsoft/playwright",
    materialType: "github_readme",
    promptFocus: "判断这个浏览器自动化/测试工具的产品潜力和护城河。",
    whyIncluded: "强开发者基础设施样本，用来检验 Agent 是否识别高频刚需、生态集成和官方背书。",
    hiddenOutcome: {
      label: "strong_success",
      summary: "端到端测试是高频刚需，Playwright 有强生态和官方背书。",
      evidence: ["高频自动化测试任务", "跨浏览器能力", "Microsoft 背书和活跃生态"]
    }
  },
  {
    id: "case-g-langchain",
    repo: "langchain-ai/langchain",
    repoUrl: "https://github.com/langchain-ai/langchain",
    materialType: "github_readme",
    promptFocus: "判断这个 AI agent / LLM 开发框架的潜力、噪音和竞争风险。",
    whyIncluded: "高热度 AI 框架样本，用来检验 Agent 是否能区分 adoption、炒作、复杂度和真实开发者价值。",
    hiddenOutcome: {
      label: "mixed",
      summary: "采用和知名度极高，但抽象复杂度、竞争和开发者争议也高。",
      evidence: ["AI 开发生态高热度", "大量集成和采用", "复杂度与替代框架风险"]
    }
  },
  {
    id: "case-h-open-webui",
    repo: "open-webui/open-webui",
    repoUrl: "https://github.com/open-webui/open-webui",
    materialType: "github_readme",
    promptFocus: "判断这个 AI 界面产品是否有持续潜力，重点看用户任务和平台依赖。",
    whyIncluded: "AI 应用层样本，用来检验 Agent 是否能看见强需求和模型/平台依赖风险。",
    hiddenOutcome: {
      label: "promising",
      summary: "本地/自托管 AI 界面需求强，但平台和模型变化风险需要跟踪。",
      evidence: ["自托管 AI 使用需求", "社区采用", "模型平台依赖"]
    }
  },
  {
    id: "case-i-nightmare",
    repo: "segmentio/nightmare",
    repoUrl: "https://github.com/segmentio/nightmare",
    materialType: "github_readme",
    promptFocus: "判断一个 README 看起来清楚但后验变弱的开发者工具，是否还值得投入。",
    whyIncluded: "弱后验/停更样本，用来检验 Agent 是否会主动查维护活跃度和替代方案。",
    hiddenOutcome: {
      label: "weak",
      summary: "早期定位清晰，但维护和生态后验变弱，替代方案更强。",
      evidence: ["维护活跃度弱", "浏览器自动化替代方案强", "历史 stars 不能代表当前潜力"]
    }
  },
  {
    id: "case-j-hoodie",
    repo: "hoodiehq/hoodie",
    repoUrl: "https://github.com/hoodiehq/hoodie",
    materialType: "github_readme",
    promptFocus: "判断一个曾经有清晰愿景但后续变弱的开源产品，如何做 stop/reposition 判断。",
    whyIncluded: "愿景强但后验弱样本，用来检验 Agent 是否能避免被 README 理想叙事带偏。",
    hiddenOutcome: {
      label: "weak",
      summary: "离线优先后端愿景明确，但生态、维护和替代方案削弱了当前潜力。",
      evidence: ["愿景强", "维护/社区后验弱", "市场替代方案改变"]
    }
  }
];

export function blindTestPrompt(testCase: BlindTestCase) {
  return [
    "请只基于这个 GitHub README / repo 作为产品材料，判断产品有没有潜力。",
    `材料：${testCase.repoUrl}`,
    `任务：${testCase.promptFocus}`,
    "请输出：1）一句话结论；2）潜力分 0-100；3）核心证据；4）反证/风险；5）下一步最低成本验证实验；6）你对结论的置信度。",
    "要求：不要空泛评价，每个判断都要说明证据来源或证据缺口。"
  ].join("\n");
}

export function defaultBlindTestScores(): BlindTestScores {
  return {
    evidenceQuality: 3,
    oppositionCoverage: 3,
    experimentActionability: 3,
    calibration: 3,
    trust: 3
  };
}

export function scoreBlindTestJudgment(scores: BlindTestScores) {
  const values = [
    scores.evidenceQuality,
    scores.oppositionCoverage,
    scores.experimentActionability,
    scores.calibration,
    scores.trust
  ];
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

export function productAgentJudgmentFromBacktest(
  testCase: BlindTestCase,
  backtest: DynamicBacktestRecord
): Omit<BlindTestJudgment, "id" | "createdAt" | "updatedAt"> {
  const scores = scoresFromBacktest(backtest);
  return {
    caseId: testCase.id,
    participant: "product_agent",
    linkedBacktestId: backtest.id,
    potentialScore: backtest.prediction.potential,
    decision: backtest.prediction.decision,
    scores,
    output: [
      `一句话结论：${backtest.calibration.lesson}`,
      `潜力分：${backtest.prediction.potential}/100；决策：${backtest.prediction.decision}`,
      `README 初判：${backtest.prediction.rationale}`,
      `后验证据：${backtest.posterior.evidence.slice(0, 5).join("；")}`,
      `不确定性：${backtest.prediction.uncertainty}`,
      backtest.warnings.length ? `边界：${backtest.warnings.join("；")}` : ""
    ]
      .filter(Boolean)
      .join("\n"),
    notes: `由动态 README 回测生成；后验标签 ${backtest.posterior.outcomeLabel}，支持 ${backtest.posterior.supportCount}，反证 ${backtest.posterior.oppositionCount}。`
  };
}

function scoresFromBacktest(backtest: DynamicBacktestRecord): BlindTestScores {
  const hasSearchEvidence = backtest.posterior.searchResults.length > 0;
  const hasOpposition = backtest.posterior.oppositionCount > 0;
  const providerQuality = backtest.posterior.searchComparisons?.find((item) => item.selected)?.qualityScore ?? 0;
  return {
    evidenceQuality: clampScore(hasSearchEvidence ? 3 + Math.round(providerQuality / 50) : 2),
    oppositionCoverage: clampScore(hasOpposition ? 4 : 2),
    experimentActionability: backtest.prediction.uncertainty ? 3 : 2,
    calibration: backtest.calibration.result === "aligned" ? 4 : 3,
    trust: clampScore(backtest.status === "completed" ? 3 + (hasSearchEvidence ? 1 : 0) : 2)
  };
}

function clampScore(value: number) {
  return Math.max(1, Math.min(5, value));
}
