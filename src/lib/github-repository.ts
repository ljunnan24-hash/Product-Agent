import { extractUrls } from "./text-extractor";
import type { GitHubRepositorySnapshot, UploadedMaterial, WebEvidence } from "./types";

type GitHubRepoRef = {
  owner: string;
  repo: string;
  url: string;
};

type GitHubRepositoryApi = {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  homepage?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  subscribers_count?: number;
  language?: string | null;
  topics?: string[];
  archived?: boolean;
  disabled?: boolean;
  created_at?: string;
  updated_at?: string;
  pushed_at?: string;
  default_branch?: string;
  license?: {
    spdx_id?: string | null;
  } | null;
};

export type GitHubRepositoryImport = {
  materials: UploadedMaterial[];
  evidence: WebEvidence[];
  repositories: GitHubRepositorySnapshot[];
  warnings: string[];
};

export function extractGitHubRepositoryUrls(text: string) {
  const matches = text.match(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^\s)\]'"<>]*)?/gi) ?? [];
  return [...new Set(matches.map((url) => normalizeGitHubRepoUrl(url)).filter(Boolean))]
    .slice(0, 2) as string[];
}

export async function importGitHubRepositories({
  urls,
  analysisId
}: {
  urls: string[];
  analysisId: string;
}): Promise<GitHubRepositoryImport> {
  const refs = urls
    .map(parseGitHubRepositoryUrl)
    .filter((item): item is GitHubRepoRef => Boolean(item));
  const results = await Promise.allSettled(
    refs.map((repo, index) => importGitHubRepository(repo, analysisId, index))
  );

  const materials: UploadedMaterial[] = [];
  const evidence: WebEvidence[] = [];
  const repositories: GitHubRepositorySnapshot[] = [];
  const warnings: string[] = [];

  for (const [index, result] of results.entries()) {
    const repo = refs[index];
    if (!repo) continue;
    if (result.status === "fulfilled") {
      materials.push(...result.value.materials);
      evidence.push(...result.value.evidence);
      repositories.push(...result.value.repositories);
      warnings.push(...result.value.warnings);
    } else {
      warnings.push(
        `${repo.owner}/${repo.repo} 导入失败：${
          result.reason instanceof Error ? result.reason.message : "unknown error"
        }`
      );
    }
  }

  return { materials, evidence, repositories, warnings };
}

async function importGitHubRepository(
  repo: GitHubRepoRef,
  analysisId: string,
  index: number
): Promise<GitHubRepositoryImport> {
  const warnings: string[] = [];
  const repository = await fetchRepository(repo);
  const snapshot = repositorySnapshot(repository, repo.url);
  const defaultBranch = repository.default_branch || "main";
  const readme = await fetchReadme(repo, defaultBranch);
  if (!readme.text) {
    warnings.push(`${repo.owner}/${repo.repo} 未读取到 README。`);
  }

  const repoUrl = repository.html_url || repo.url;
  const readmeText = readme.text || fallbackReadme(repository);
  const extractedUrls = [
    repoUrl,
    repository.homepage || "",
    ...extractUrls(readmeText)
  ].filter(Boolean);
  const material: UploadedMaterial = {
    id: `${analysisId}-github-${index}`,
    name: `GitHub README · ${repo.owner}/${repo.repo}`,
    type: "text/markdown",
    size: Buffer.byteLength(readmeText, "utf8"),
    url: readme.url || repoUrl,
    sourceKind: "github_readme",
    metrics: null,
    extractedText: readmeText.slice(0, 18000),
    textPreview: readmeText.slice(0, 1200),
    extractedUrls: [...new Set(extractedUrls)].slice(0, 10)
  };

  return {
    materials: [material],
    evidence: [repositoryEvidence(repository, repoUrl)],
    repositories: [snapshot],
    warnings
  };
}

async function fetchRepository(repo: GitHubRepoRef): Promise<GitHubRepositoryApi> {
  const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
    headers: githubHeaders(),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`GitHub repo HTTP ${response.status}`);
  }

  return (await response.json()) as GitHubRepositoryApi;
}

async function fetchReadme(repo: GitHubRepoRef, branch: string) {
  const candidates = [
    "README.md",
    "readme.md",
    "README.mdx",
    "README.markdown",
    "README"
  ];

  for (const fileName of candidates) {
    const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(branch)}/${fileName}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "ProductAgentMVP/0.1 (+local prototype)"
      },
      cache: "no-store"
    });
    if (response.ok) {
      return {
        url,
        text: (await response.text()).replace(/\u0000/g, "").slice(0, 20000)
      };
    }
  }

  return { url: "", text: "" };
}

function repositoryEvidence(repository: GitHubRepositoryApi, fallbackUrl: string): WebEvidence {
  const pushedAt = dateOnly(repository.pushed_at);
  const updatedAt = dateOnly(repository.updated_at);
  const createdAt = dateOnly(repository.created_at);
  const fullName = repository.full_name || new URL(fallbackUrl).pathname.replace(/^\/+/, "");
  const stars = repository.stargazers_count ?? 0;
  const forks = repository.forks_count ?? 0;
  const issues = repository.open_issues_count ?? 0;
  const watchers = repository.subscribers_count ?? 0;
  const topics = repository.topics?.slice(0, 8).join(", ") || "none";
  const license = repository.license?.spdx_id || "unknown";
  const activity = repository.archived
    ? "archived"
    : repository.disabled
      ? "disabled"
      : "active";

  return {
    title: `GitHub repository metrics · ${fullName}`,
    url: repository.html_url || fallbackUrl,
    sourceType: "github_repository",
    sourceName: "GitHub API",
    snippet: [
      repository.description ? `Description: ${repository.description}` : "",
      `Stars: ${stars}`,
      `Forks: ${forks}`,
      `Watchers: ${watchers}`,
      `Open issues: ${issues}`,
      `Language: ${repository.language || "unknown"}`,
      `Topics: ${topics}`,
      `License: ${license}`,
      `Repository status: ${activity}`,
      createdAt ? `Created: ${createdAt}` : "",
      updatedAt ? `Updated: ${updatedAt}` : "",
      pushedAt ? `Last push: ${pushedAt}` : "",
      repository.homepage ? `Homepage: ${repository.homepage}` : ""
    ]
      .filter(Boolean)
      .join("\n"),
    updatedAt: pushedAt || updatedAt,
    publishedAt: createdAt,
    dateSource: "github_api",
    recencyBucket: bucketForDate(pushedAt || updatedAt)
  };
}

function repositorySnapshot(
  repository: GitHubRepositoryApi,
  fallbackUrl: string
): GitHubRepositorySnapshot {
  const fullName = repository.full_name || new URL(fallbackUrl).pathname.replace(/^\/+/, "");
  return {
    repo: fullName,
    repoUrl: repository.html_url || fallbackUrl,
    description: repository.description || "",
    homepage: repository.homepage || undefined,
    stars: repository.stargazers_count ?? 0,
    forks: repository.forks_count ?? 0,
    openIssues: repository.open_issues_count ?? 0,
    watchers: repository.subscribers_count ?? 0,
    language: repository.language || "unknown",
    topics: repository.topics ?? [],
    license: repository.license?.spdx_id || "unknown",
    archived: Boolean(repository.archived),
    disabled: Boolean(repository.disabled),
    createdAt: repository.created_at,
    updatedAt: repository.updated_at,
    pushedAt: repository.pushed_at,
    defaultBranch: repository.default_branch || "main"
  };
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

function fallbackReadme(repository: GitHubRepositoryApi) {
  return [
    `# ${repository.full_name || "GitHub Repository"}`,
    repository.description || "",
    repository.homepage ? `Homepage: ${repository.homepage}` : "",
    repository.topics?.length ? `Topics: ${repository.topics.join(", ")}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function normalizeGitHubRepoUrl(raw: string) {
  const parsed = parseGitHubRepositoryUrl(raw);
  return parsed?.url || "";
}

function parseGitHubRepositoryUrl(raw: string): GitHubRepoRef | null {
  try {
    const parsed = new URL(raw.replace(/[.,;:!?]+$/g, ""));
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const [owner, repoName] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repoName) return null;
    const repo = repoName.replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      return null;
    }
    return {
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`
    };
  } catch {
    return null;
  }
}

function dateOnly(value: string | undefined) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function bucketForDate(date: string | undefined): WebEvidence["recencyBucket"] {
  if (!date) return "unknown_recency";
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(timestamp)) return "unknown_recency";
  const ageDays = (Date.now() - timestamp) / 86_400_000;
  if (ageDays < -2) return "unknown_recency";
  if (ageDays <= 365) return "fresh";
  if (ageDays <= 1095) return "usable";
  return "historical";
}
