export type GitHubBacktestCase = {
  id: string;
  repo: string;
  repoUrl: string;
  sampleType: "strong_success" | "mixed_outcome" | "developer_tool";
  readmeThesis: string;
  readmeOnlyPrediction: {
    potential: number;
    decision: "build" | "test_first" | "reposition" | "stop";
    rationale: string;
    uncertainty: string;
  };
  posteriorOutcome: {
    label: string;
    evidence: string[];
  };
  calibrationLesson: string;
  sources: Array<{
    label: string;
    url: string;
  }>;
};

export const githubReadmeBacktestCases: GitHubBacktestCase[] = [
  {
    id: "supabase",
    repo: "supabase/supabase",
    repoUrl: "https://github.com/supabase/supabase",
    sampleType: "strong_success",
    readmeThesis:
      "README 把 Supabase 定位成 Postgres development platform 和开源 Firebase 替代，目标用户、替代方案和开发者采用场景都很清楚。",
    readmeOnlyPrediction: {
      potential: 82,
      decision: "test_first",
      rationale:
        "强点是大替代方案、开发者高频工作流、开源信任和可扩展生态；只看 README 时仍不能确认付费、留存和单位经济。",
      uncertainty: "需要后验检查 GitHub stars、融资、使用规模和商业化。"
    },
    posteriorOutcome: {
      label: "强成功",
      evidence: [
        "Supabase 官方记录达到 100,000 GitHub stars。",
        "YC 公司页列出 2025 年 Series D、2026 年 Series F 等后续融资新闻。",
        "TechCrunch 报道 2026 年 Series F 后估值达到约 100 亿美元。"
      ]
    },
    calibrationLesson:
      "README 里如果同时出现清晰替代对象、高频开发者任务、开源信任和可扩展生态，早期应给高潜力；但强决策仍需要后验验证商业化。",
    sources: [
      {
        label: "GitHub README",
        url: "https://github.com/supabase/supabase"
      },
      {
        label: "100k GitHub stars",
        url: "https://supabase.com/blog/100000-github-stars"
      },
      {
        label: "YC company page",
        url: "https://www.ycombinator.com/companies/supabase"
      },
      {
        label: "TechCrunch Series F",
        url: "https://techcrunch.com/2026/06/05/supabase-doubles-valuation-to-10b-in-8-months/"
      }
    ]
  },
  {
    id: "calcom",
    repo: "calcom/cal.diy",
    repoUrl: "https://github.com/calcom/cal.diy",
    sampleType: "mixed_outcome",
    readmeThesis:
      "README 把 Cal.com/Cal.diy 定位成可自托管、可控制数据和工作流的开源 scheduling infrastructure，替代 Calendly 的角度非常明确。",
    readmeOnlyPrediction: {
      potential: 76,
      decision: "test_first",
      rationale:
        "强点是已存在大竞品、控制权/自托管差异化和明确用户场景；风险是日历排程并非新需求，商业化和安全责任重。",
      uncertainty: "需要后验检查开源社区是否持续、企业版策略和安全/维护成本。"
    },
    posteriorOutcome: {
      label: "混合结果",
      evidence: [
        "GitHub 组织页显示 Cal.diy 仍有较高 stars/forks，是明显开发者采用信号。",
        "Cal.com 2026 年宣布核心产品转向闭源，公开原因是 AI 时代安全风险。",
        "社区和开源生态对闭源有明显争议，说明 README 的开源卖点需要生命周期校准。"
      ]
    },
    calibrationLesson:
      "README 的强差异化不一定长期成立；开源策略、安全成本和商业压力会改变产品生命周期。对这类产品，Agent 需要把后验证据时效放得更重。",
    sources: [
      {
        label: "Cal.diy GitHub",
        url: "https://github.com/calcom/cal.diy"
      },
      {
        label: "Cal.com closed source announcement",
        url: "https://cal.com/blog/cal-com-goes-closed-source-why"
      },
      {
        label: "Cal.com v6.4 license changes",
        url: "https://cal.com/blog/calcom-v6-4"
      },
      {
        label: "GitHub org metrics",
        url: "https://github.com/calcom"
      }
    ]
  },
  {
    id: "swr",
    repo: "vercel/swr",
    repoUrl: "https://github.com/vercel/swr",
    sampleType: "developer_tool",
    readmeThesis:
      "README 用一句话解释 React Hooks for Data Fetching，并把 stale-while-revalidate、缓存、重试、分页、SSR/SSG 等开发者痛点列得很具体。",
    readmeOnlyPrediction: {
      potential: 78,
      decision: "test_first",
      rationale:
        "强点是高频开发者任务、API 小、收益清楚、背靠 Vercel/Next.js 生态；弱点是库型产品商业化不直接。",
      uncertainty: "需要后验检查 stars、forks、文档采用和社区讨论质量。"
    },
    posteriorOutcome: {
      label: "库型成功",
      evidence: [
        "GitHub README 和官网持续强调 React data fetching 的核心场景。",
        "GitHub Stars Leaderboard 显示 vercel/swr 约 32k stars、1.3k forks。",
        "GitHub Discussions 里持续存在真实使用问题、API 改进和大型应用经验讨论。"
      ]
    },
    calibrationLesson:
      "开发者库的潜力不该用 SaaS 付费标准直接扣分；应把生态背书、API 频率、集成摩擦和社区问题密度作为单独证据预算。",
    sources: [
      {
        label: "SWR GitHub README",
        url: "https://github.com/vercel/swr"
      },
      {
        label: "SWR official site",
        url: "https://swr.vercel.app/"
      },
      {
        label: "GitHub stars leaderboard",
        url: "https://githublb.vercel.app/repo/vercel/swr"
      },
      {
        label: "SWR discussions",
        url: "https://github.com/vercel/swr/discussions/categories/q-a"
      }
    ]
  }
];

export const githubBacktestLessons = [
  "README 只负责预测：目标用户、替代对象、核心任务、差异化和信任表达。",
  "后验只看客观证据：stars/forks、融资、客户/社区、版本活跃、闭源/停更/争议。",
  "同一产品生命周期会改变判断：Cal.com 早期开源是优势，后期安全和商业压力变成关键风险。",
  "开发者工具要单独校准，GitHub 活跃度是强采用信号，但不能直接等于付费意愿。"
];
