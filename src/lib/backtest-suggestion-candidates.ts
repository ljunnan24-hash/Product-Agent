import type {
  BacktestCandidateRepo,
  BacktestCandidateSampleFit,
  BacktestSuggestion
} from "./types";

type GitHubSearchRepository = {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  language?: string | null;
  topics?: string[];
  archived?: boolean;
  disabled?: boolean;
  pushed_at?: string;
};

type CandidateProfile =
  | "overestimated_readme"
  | "underestimated_readme"
  | "tooling_failure"
  | "balanced_samples";

type CandidatePatch = Pick<
  BacktestSuggestion,
  | "candidateStatus"
  | "candidateGeneratedAt"
  | "candidateQuery"
  | "candidateWarnings"
  | "candidates"
>;

export async function ensureBacktestSuggestionCandidates(
  suggestions: BacktestSuggestion[],
  options: {
    limit?: number;
    force?: boolean;
    updateSuggestion?: (
      id: string,
      patch: Partial<BacktestSuggestion>
    ) => Promise<BacktestSuggestion | null>;
  } = {}
) {
  const limit = options.limit ?? 6;
  const shouldGenerate = (suggestion: BacktestSuggestion) =>
    suggestion.status === "open" &&
    (options.force ||
      !suggestion.candidates?.length ||
      suggestion.candidateStatus === "not_generated");
  const targets = suggestions.filter(shouldGenerate).slice(0, limit);
  if (!targets.length) return suggestions;

  const updates = await Promise.all(
    targets.map(async (suggestion) => {
      const patch = await buildBacktestCandidatePatch(suggestion);
      const updated = options.updateSuggestion
        ? await options.updateSuggestion(suggestion.id, patch)
        : null;
      return updated ?? { ...suggestion, ...patch, updatedAt: new Date().toISOString() };
    })
  );
  const updatedById = new Map(updates.map((item) => [item.id, item]));
  return suggestions.map((suggestion) => updatedById.get(suggestion.id) ?? suggestion);
}

export async function buildBacktestCandidatePatch(
  suggestion: BacktestSuggestion
): Promise<CandidatePatch> {
  const now = new Date().toISOString();
  const profile = profileForSuggestion(suggestion);
  const searchQuery = githubSearchQueryForProfile(profile, suggestion);
  const warnings: string[] = [];
  const searched = await searchGitHubCandidateRepos(searchQuery, profile).catch((error) => {
    warnings.push(error instanceof Error ? error.message : "GitHub 搜索失败");
    return [] as BacktestCandidateRepo[];
  });
  const candidates = uniqueCandidateRepos([
    ...searched,
    ...curatedCandidatesForProfile(profile, suggestion)
  ])
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 3);

  if (!candidates.length) {
    return {
      candidateStatus: "failed",
      candidateGeneratedAt: now,
      candidateQuery: searchQuery,
      candidateWarnings: uniqueStrings([
        ...warnings,
        "GitHub 搜索和精选库都没有找到可用候选。"
      ]),
      candidates: []
    };
  }

  return {
    candidateStatus: warnings.length ? "generated" : "generated",
    candidateGeneratedAt: now,
    candidateQuery: searchQuery,
    candidateWarnings: warnings,
    candidates
  };
}

function profileForSuggestion(suggestion: BacktestSuggestion): CandidateProfile {
  const text = [suggestion.issueTitle, suggestion.title, suggestion.targetSignal, suggestion.suggestion]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (/工具链|读取失败|搜索失败|抓取失败|重跑失败|provider|tooling|failed/.test(text)) {
    return "tooling_failure";
  }
  if (/高估|表达很强但后验弱|后验弱|停更|社区弱|商业化失败|强竞品|downweight|overweight/.test(text)) {
    return "overestimated_readme";
  }
  if (/低估|表达一般但生态后验强|后验强|高 stars|活跃 issues|第三方教程|生产环境|upweight|underweight/.test(text)) {
    return "underestimated_readme";
  }
  return "balanced_samples";
}

function githubSearchQueryForProfile(profile: CandidateProfile, suggestion: BacktestSuggestion) {
  const target = normalizedTargetTerm(suggestion.targetSignal || suggestion.suggestion);
  if (profile === "overestimated_readme") {
    return `${target} developer tool archived:true stars:50..8000`;
  }
  if (profile === "underestimated_readme") {
    return `${target} developer tool stars:>5000 pushed:>2025-01-01 archived:false`;
  }
  if (profile === "tooling_failure") {
    return `readme parser github api developer tool stars:>1000 archived:false`;
  }
  return `${target} developer tool stars:>1000 pushed:>2025-01-01 archived:false`;
}

function normalizedTargetTerm(value: string) {
  const lower = value.toLowerCase();
  if (/ai|agent|llm|模型|智能体/.test(lower)) return "ai agent";
  if (/readme|github|开发者|developer|tool/.test(lower)) return "developer productivity";
  if (/定价|付费|pricing|revenue/.test(lower)) return "pricing billing";
  if (/分发|社区|product hunt|distribution/.test(lower)) return "community developer";
  if (/产品|验证|潜力|validation|mvp/.test(lower)) return "product validation";
  return "developer productivity";
}

async function searchGitHubCandidateRepos(query: string, profile: CandidateProfile) {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query);
  url.searchParams.set("sort", profile === "overestimated_readme" ? "updated" : "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", "8");

  const response = await fetch(url, {
    headers: githubHeaders(),
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`GitHub 候选搜索失败 HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { items?: GitHubSearchRepository[] };
  return (payload.items ?? [])
    .filter((item) => item.full_name && item.html_url)
    .map((item) => candidateFromSearchResult(item, profile, query));
}

function candidateFromSearchResult(
  item: GitHubSearchRepository,
  profile: CandidateProfile,
  query: string
): BacktestCandidateRepo {
  const repo = item.full_name || "";
  const stars = item.stargazers_count ?? 0;
  const forks = item.forks_count ?? 0;
  const sampleFit = sampleFitForRepository(item, profile);
  return {
    repo,
    repoUrl: item.html_url || `https://github.com/${repo}`,
    description: item.description || "GitHub repository",
    stars,
    forks,
    language: item.language || undefined,
    topics: item.topics?.slice(0, 8) ?? [],
    source: "github_search",
    sampleFit,
    matchScore: candidateScore({
      stars,
      forks,
      pushedAt: item.pushed_at,
      archived: Boolean(item.archived || item.disabled),
      sampleFit,
      profile
    }),
    whyThisSample: whyCandidate({
      repo,
      source: "github_search",
      profile,
      sampleFit,
      query,
      stars,
      pushedAt: item.pushed_at
    })
  };
}

function curatedCandidatesForProfile(
  profile: CandidateProfile,
  suggestion: BacktestSuggestion
): BacktestCandidateRepo[] {
  const query = githubSearchQueryForProfile(profile, suggestion);
  return curatedCandidateLibrary()
    .filter((candidate) => curatedMatchesProfile(candidate, profile))
    .map((candidate) => ({
      ...candidate,
      matchScore: Math.min(100, candidate.matchScore + profileBonus(candidate.sampleFit, profile)),
      whyThisSample: whyCandidate({
        repo: candidate.repo,
        source: "curated",
        profile,
        sampleFit: candidate.sampleFit,
        query
      })
    }));
}

function curatedCandidateLibrary(): BacktestCandidateRepo[] {
  return [
    {
      repo: "supabase/supabase",
      repoUrl: "https://github.com/supabase/supabase",
      description: "Open source Firebase alternative.",
      topics: ["database", "developer-tools", "self-hosted"],
      source: "curated",
      sampleFit: "success_case",
      matchScore: 88,
      whyThisSample: ""
    },
    {
      repo: "calcom/cal.com",
      repoUrl: "https://github.com/calcom/cal.com",
      description: "Open scheduling infrastructure.",
      topics: ["calendar", "scheduling", "saas"],
      source: "curated",
      sampleFit: "success_case",
      matchScore: 84,
      whyThisSample: ""
    },
    {
      repo: "vercel/swr",
      repoUrl: "https://github.com/vercel/swr",
      description: "React Hooks for data fetching.",
      topics: ["react", "data-fetching", "frontend"],
      source: "curated",
      sampleFit: "success_case",
      matchScore: 82,
      whyThisSample: ""
    },
    {
      repo: "microsoft/playwright",
      repoUrl: "https://github.com/microsoft/playwright",
      description: "End-to-end testing for modern web apps.",
      topics: ["testing", "browser", "automation"],
      source: "curated",
      sampleFit: "success_case",
      matchScore: 86,
      whyThisSample: ""
    },
    {
      repo: "langchain-ai/langchain",
      repoUrl: "https://github.com/langchain-ai/langchain",
      description: "Build context-aware reasoning applications.",
      topics: ["ai", "llm", "agent"],
      source: "curated",
      sampleFit: "mixed_case",
      matchScore: 80,
      whyThisSample: ""
    },
    {
      repo: "open-webui/open-webui",
      repoUrl: "https://github.com/open-webui/open-webui",
      description: "User-friendly AI interface.",
      topics: ["ai", "llm", "chat"],
      source: "curated",
      sampleFit: "mixed_case",
      matchScore: 78,
      whyThisSample: ""
    },
    {
      repo: "segmentio/nightmare",
      repoUrl: "https://github.com/segmentio/nightmare",
      description: "High-level browser automation library.",
      topics: ["automation", "browser", "testing"],
      source: "curated",
      sampleFit: "weak_case",
      matchScore: 76,
      whyThisSample: ""
    },
    {
      repo: "hoodiehq/hoodie",
      repoUrl: "https://github.com/hoodiehq/hoodie",
      description: "Offline-first backend for frontend developers.",
      topics: ["offline-first", "backend", "developer-tools"],
      source: "curated",
      sampleFit: "weak_case",
      matchScore: 72,
      whyThisSample: ""
    },
    {
      repo: "readmeio/oas",
      repoUrl: "https://github.com/readmeio/oas",
      description: "OpenAPI tooling from ReadMe.",
      topics: ["readme", "openapi", "docs"],
      source: "curated",
      sampleFit: "tooling_case",
      matchScore: 70,
      whyThisSample: ""
    },
    {
      repo: "github/markup",
      repoUrl: "https://github.com/github/markup",
      description: "Markup rendering used around GitHub READMEs.",
      topics: ["readme", "markup", "github"],
      source: "curated",
      sampleFit: "tooling_case",
      matchScore: 68,
      whyThisSample: ""
    },
    {
      repo: "remarkjs/remark",
      repoUrl: "https://github.com/remarkjs/remark",
      description: "Markdown processor powered by plugins.",
      topics: ["markdown", "readme", "parser"],
      source: "curated",
      sampleFit: "tooling_case",
      matchScore: 66,
      whyThisSample: ""
    }
  ];
}

function curatedMatchesProfile(candidate: BacktestCandidateRepo, profile: CandidateProfile) {
  if (profile === "overestimated_readme") {
    return candidate.sampleFit === "weak_case" || candidate.sampleFit === "mixed_case";
  }
  if (profile === "underestimated_readme") {
    return candidate.sampleFit === "success_case" || candidate.sampleFit === "mixed_case";
  }
  if (profile === "tooling_failure") {
    return candidate.sampleFit === "tooling_case" || candidate.topics.includes("readme");
  }
  return candidate.sampleFit !== "tooling_case";
}

function sampleFitForRepository(
  item: GitHubSearchRepository,
  profile: CandidateProfile
): BacktestCandidateSampleFit {
  if (profile === "tooling_failure") return "tooling_case";
  if (item.archived || item.disabled) return "weak_case";
  if (profile === "overestimated_readme") return "weak_case";
  if (profile === "underestimated_readme") return "success_case";
  return (item.stargazers_count ?? 0) >= 10000 ? "success_case" : "mixed_case";
}

function candidateScore({
  stars,
  forks,
  pushedAt,
  archived,
  sampleFit,
  profile
}: {
  stars: number;
  forks: number;
  pushedAt?: string;
  archived: boolean;
  sampleFit: BacktestCandidateSampleFit;
  profile: CandidateProfile;
}) {
  const starScore = Math.min(34, Math.round(Math.log10(Math.max(stars, 1)) * 10));
  const forkScore = Math.min(14, Math.round(Math.log10(Math.max(forks, 1)) * 5));
  const recencyScore = pushedAt && new Date(pushedAt).getTime() > Date.now() - 540 * 24 * 60 * 60 * 1000 ? 16 : 4;
  const archiveScore = archived ? (profile === "overestimated_readme" ? 18 : -18) : 6;
  return Math.max(1, Math.min(100, 22 + starScore + forkScore + recencyScore + archiveScore + profileBonus(sampleFit, profile)));
}

function profileBonus(sampleFit: BacktestCandidateSampleFit, profile: CandidateProfile) {
  if (profile === "overestimated_readme" && sampleFit === "weak_case") return 14;
  if (profile === "underestimated_readme" && sampleFit === "success_case") return 14;
  if (profile === "tooling_failure" && sampleFit === "tooling_case") return 14;
  if (profile === "balanced_samples" && (sampleFit === "success_case" || sampleFit === "mixed_case")) return 8;
  return 0;
}

function whyCandidate({
  repo,
  source,
  profile,
  sampleFit,
  query,
  stars,
  pushedAt
}: {
  repo: string;
  source: BacktestCandidateRepo["source"];
  profile: CandidateProfile;
  sampleFit: BacktestCandidateSampleFit;
  query: string;
  stars?: number;
  pushedAt?: string;
}) {
  const sourceText = source === "github_search" ? `GitHub 搜索命中「${query}」` : "来自本地精选回测库";
  const fitText = sampleFitLabel(sampleFit);
  const metricText = typeof stars === "number" ? `，当前 stars ${stars}` : "";
  const recencyText = pushedAt ? `，最近 push ${pushedAt.slice(0, 10)}` : "";
  return `${sourceText}；适合作为「${profileLabel(profile)}」的${fitText}样本${metricText}${recencyText}。`;
}

function sampleFitLabel(sampleFit: BacktestCandidateSampleFit) {
  if (sampleFit === "success_case") return "强后验";
  if (sampleFit === "weak_case") return "弱后验/反例";
  if (sampleFit === "tooling_case") return "工具链";
  if (sampleFit === "mixed_case") return "混合";
  return "相邻";
}

function profileLabel(profile: CandidateProfile) {
  if (profile === "overestimated_readme") return "README 高估校准";
  if (profile === "underestimated_readme") return "README 低估校准";
  if (profile === "tooling_failure") return "工具链修复";
  return "补充样本";
}

function uniqueCandidateRepos(candidates: BacktestCandidateRepo[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.repo.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(items: string[]) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function githubHeaders() {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ProductAgentMVP/0.1 (+local prototype)",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}
