"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  Github,
  Loader2,
  RotateCcw,
  Sparkles,
  Search,
  TrendingUp,
  X
} from "lucide-react";
import type {
  BacktestCandidateSampleFit,
  BacktestSuggestion,
  DynamicBacktestRecord
} from "@/lib/types";
import { BacktestRuntimeSummary } from "@/components/BacktestRuntimeSummary";

type Props = {
  initialBacktests: DynamicBacktestRecord[];
  initialSuggestions: BacktestSuggestion[];
};

export function BacktestsRunner({ initialBacktests, initialSuggestions }: Props) {
  const [repoUrl, setRepoUrl] = useState("");
  const [backtests, setBacktests] = useState(initialBacktests);
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  const [suggestionRepoUrls, setSuggestionRepoUrls] = useState<Record<string, string>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [runningSuggestionId, setRunningSuggestionId] = useState<string | null>(null);
  const [dismissingSuggestionId, setDismissingSuggestionId] = useState<string | null>(null);
  const [refreshingSuggestionId, setRefreshingSuggestionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const openSuggestions = suggestions.filter((item) => item.status === "open");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runBacktest(repoUrl);
  }

  async function runBacktest(targetRepoUrl: string, suggestionId?: string) {
    setError("");
    const nextRepoUrl = targetRepoUrl.trim();
    if (!nextRepoUrl) {
      setError("请先输入 GitHub repo URL。");
      return;
    }
    setIsRunning(true);
    setRunningSuggestionId(suggestionId ?? null);

    try {
      const response = await fetch("/api/backtests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ repoUrl: nextRepoUrl, suggestionId })
      });
      const payload = (await response.json()) as {
        backtest?: DynamicBacktestRecord;
        error?: string;
      };
      if (!response.ok || !payload.backtest) {
        throw new Error(payload.error || "README 回测失败");
      }
      setBacktests((current) =>
        [
          payload.backtest as DynamicBacktestRecord,
          ...current.filter((item) => item.id !== payload.backtest?.id)
        ].slice(0, 20)
      );
      if (suggestionId) {
        setSuggestions((current) =>
          current.map((item) =>
            item.id === suggestionId
              ? {
                  ...item,
                  status: "used",
                  repoUrl: payload.backtest?.repoUrl || nextRepoUrl,
                  usedBacktestId: payload.backtest?.id,
                  usedAt: new Date().toISOString()
                }
              : item
          )
        );
        setSuggestionRepoUrls((current) => {
          const next = { ...current };
          delete next[suggestionId];
          return next;
        });
      }
      if (payload.backtest.status === "failed") {
        setError("回测失败，已保存失败记录。");
      } else {
        setRepoUrl("");
      }
    } catch (backtestError) {
      setError(backtestError instanceof Error ? backtestError.message : "README 回测失败");
    } finally {
      setIsRunning(false);
      setRunningSuggestionId(null);
    }
  }

  async function retryBacktest(item: DynamicBacktestRecord) {
    const retryUrl = item.retryInput?.repoUrl || item.repoUrl;
    setRepoUrl(retryUrl);
    await runBacktest(retryUrl);
  }

  async function dismissSuggestion(suggestionId: string) {
    setError("");
    setDismissingSuggestionId(suggestionId);

    try {
      const response = await fetch(`/api/backtest-suggestions/${suggestionId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action: "dismiss" })
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "忽略回测建议失败");
      }
      setSuggestions((current) =>
        current.map((item) =>
          item.id === suggestionId
            ? {
                ...item,
                status: "dismissed",
                dismissedAt: new Date().toISOString()
              }
            : item
        )
      );
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : "忽略回测建议失败");
    } finally {
      setDismissingSuggestionId(null);
    }
  }

  async function refreshSuggestionCandidates(suggestionId: string) {
    setError("");
    setRefreshingSuggestionId(suggestionId);

    try {
      const response = await fetch(`/api/backtest-suggestions/${suggestionId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action: "refresh_candidates" })
      });
      const payload = (await response.json()) as {
        suggestion?: BacktestSuggestion;
        error?: string;
      };
      if (!response.ok || !payload.suggestion) {
        throw new Error(payload.error || "生成候选 repo 失败");
      }
      setSuggestions((current) =>
        current.map((item) =>
          item.id === suggestionId ? (payload.suggestion as BacktestSuggestion) : item
        )
      );
    } catch (candidateError) {
      setError(candidateError instanceof Error ? candidateError.message : "生成候选 repo 失败");
    } finally {
      setRefreshingSuggestionId(null);
    }
  }

  return (
    <section className="dynamic-backtest" aria-label="动态 README 回测">
      {openSuggestions.length ? (
        <div className="backtest-suggestion-panel" aria-label="待回测建议">
          <div className="backtest-suggestion-head">
            <div>
              <span>待验证样本</span>
              <strong>来自报告质检的 README 回测建议。</strong>
            </div>
            <b>{openSuggestions.length}</b>
          </div>
          <div className="backtest-suggestion-list">
            {openSuggestions.map((suggestion) => {
              const currentUrl = suggestionRepoUrls[suggestion.id] || "";
              const isRunningThis = runningSuggestionId === suggestion.id;
              return (
                <article className="backtest-suggestion-card" key={suggestion.id}>
                  <div className="backtest-suggestion-title">
                    <ClipboardList size={15} />
                    <div>
                      <span>{suggestion.issueTitle}</span>
                      <strong>{suggestion.targetSignal || suggestion.title}</strong>
                    </div>
                    <a href={`/analysis/${suggestion.analysisId}`}>
                      <ExternalLink size={13} />
                      报告
                    </a>
                  </div>
                  <p>{suggestion.suggestion}</p>
                  {suggestion.candidates?.length ? (
                    <div className="backtest-candidate-list" aria-label="候选 repo">
                      {suggestion.candidates.map((candidate) => (
                        <div className="backtest-candidate" key={candidate.repoUrl}>
                          <div>
                            <strong>{candidate.repo}</strong>
                            <span>{candidateFitLabel(candidate.sampleFit)}</span>
                          </div>
                          <p>{candidate.whyThisSample}</p>
                          <div className="backtest-candidate-meta">
                            {typeof candidate.stars === "number" ? (
                              <span>{candidate.stars} stars</span>
                            ) : null}
                            {candidate.language ? <span>{candidate.language}</span> : null}
                            <span>{candidate.source === "github_search" ? "GitHub 搜索" : "精选库"}</span>
                            <span>匹配 {candidate.matchScore}</span>
                          </div>
                          <div className="backtest-candidate-actions">
                            <a href={candidate.repoUrl} target="_blank" rel="noreferrer">
                              <ExternalLink size={13} />
                              GitHub
                            </a>
                            <button
                              className="ghost"
                              type="button"
                              onClick={() =>
                                setSuggestionRepoUrls((current) => ({
                                  ...current,
                                  [suggestion.id]: candidate.repoUrl
                                }))
                              }
                            >
                              填入
                            </button>
                            <button
                              type="button"
                              disabled={isRunning}
                              onClick={() => runBacktest(candidate.repoUrl, suggestion.id)}
                            >
                              {isRunningThis ? (
                                <Loader2 className="spin" size={14} />
                              ) : (
                                <Search size={14} />
                              )}
                              跑样本
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="backtest-candidate-empty">
                      <span>还没有候选 repo。</span>
                      <button
                        type="button"
                        disabled={refreshingSuggestionId === suggestion.id}
                        onClick={() => refreshSuggestionCandidates(suggestion.id)}
                      >
                        {refreshingSuggestionId === suggestion.id ? (
                          <Loader2 className="spin" size={14} />
                        ) : (
                          <Sparkles size={14} />
                        )}
                        生成候选
                      </button>
                    </div>
                  )}
                  {suggestion.candidateWarnings?.length ? (
                    <small className="backtest-candidate-warning">
                      {suggestion.candidateWarnings.slice(0, 2).join("；")}
                    </small>
                  ) : null}
                  <form
                    className="backtest-suggestion-runner"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void runBacktest(currentUrl, suggestion.id);
                    }}
                  >
                    <label>
                      <Github size={15} />
                      <input
                        value={currentUrl}
                        onChange={(event) =>
                          setSuggestionRepoUrls((current) => ({
                            ...current,
                            [suggestion.id]: event.target.value
                          }))
                        }
                        placeholder="填入匹配这条建议的 GitHub repo"
                      />
                    </label>
                    <button disabled={isRunning} type="submit">
                      {isRunningThis ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
                      跑样本
                    </button>
                    <button
                      className="ghost"
                      disabled={Boolean(dismissingSuggestionId)}
                      type="button"
                      onClick={() => dismissSuggestion(suggestion.id)}
                    >
                      {dismissingSuggestionId === suggestion.id ? (
                        <Loader2 className="spin" size={15} />
                      ) : (
                        <X size={15} />
                      )}
                      忽略
                    </button>
                    <button
                      className="ghost"
                      disabled={refreshingSuggestionId === suggestion.id}
                      type="button"
                      onClick={() => refreshSuggestionCandidates(suggestion.id)}
                    >
                      {refreshingSuggestionId === suggestion.id ? (
                        <Loader2 className="spin" size={15} />
                      ) : (
                        <Sparkles size={15} />
                      )}
                      刷新候选
                    </button>
                  </form>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}

      <form className="dynamic-backtest-form" onSubmit={submit}>
        <div>
          <span>动态回测</span>
          <strong>输入 repo，先预测，再查后验。</strong>
        </div>
        <label>
          <Github size={16} />
          <input
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/owner/repo"
          />
        </label>
        <button disabled={isRunning}>
          {isRunning ? <Loader2 className="spin" size={16} /> : <Search size={16} />}
          运行回测
        </button>
      </form>
      {error ? <p className="dynamic-backtest-error">{error}</p> : null}

      {backtests.length ? (
        <div className="dynamic-backtest-list">
          {backtests.map((item) => (
            <article
              className={`dynamic-backtest-card ${item.status === "failed" ? "failed" : ""}`}
              key={item.id}
            >
              <div className="dynamic-backtest-top">
                <div>
                  <span>
                    {item.status === "failed"
                      ? "回测失败"
                      : calibrationLabel(item.calibration.result)}
                  </span>
                  <h2>{item.repo}</h2>
                </div>
                <a href={item.repoUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} />
                  GitHub
                </a>
              </div>

              {item.status === "failed" ? (
                <div className="dynamic-backtest-failure">
                  <strong>
                    <AlertTriangle size={14} />
                    {item.errorMessage || "README 回测失败"}
                  </strong>
                  <span>失败阶段：{failureStageLabel(item.failureStage)}</span>
                  {item.failureDetails?.length ? (
                    <ul>
                      {item.failureDetails.slice(0, 4).map((detail, index) => (
                        <li key={`${detail.stage}-${detail.provider || "run"}-${index}`}>
                          <b>{detail.label}</b>
                          {detail.provider ? ` · ${providerLabel(detail.provider)}` : ""}：
                          {detail.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {item.retryInput?.reason ? <p>{item.retryInput.reason}</p> : null}
                  <button
                    type="button"
                    disabled={isRunning || item.retryInput?.canRetry === false}
                    onClick={() => retryBacktest(item)}
                  >
                    {isRunning ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
                    重试回测
                  </button>
                </div>
              ) : (
                <>
                  <div className="dynamic-backtest-score">
                    <div>
                      <span>README 预测</span>
                      <strong>{item.prediction.potential}</strong>
                    </div>
                    <div>
                      <span>后验分</span>
                      <strong>{item.posterior.outcomeScore}</strong>
                    </div>
                    <div>
                      <span>偏差</span>
                      <strong>{formatDelta(item.calibration.delta)}</strong>
                    </div>
                  </div>

                  <p>{item.prediction.rationale}</p>
                  {item.posterior.searchComparisons?.length ? (
                    <div className="dynamic-backtest-provider-grid">
                      {item.posterior.searchComparisons.map((comparison) => (
                        <div
                          className={`dynamic-backtest-provider ${comparison.selected ? "selected" : ""}`}
                          key={comparison.provider}
                        >
                          <div>
                            <strong>
                              {providerLabel(comparison.provider)}
                              {comparison.selected ? " · 已选" : ""}
                            </strong>
                            <span>{comparison.status}</span>
                          </div>
                          <p>{comparison.reason}</p>
                          <div className="provider-metrics">
                            <span>质量 {comparison.qualityScore}</span>
                            <span>结果 {comparison.totalResults}</span>
                            <span>URL {comparison.urlCoverage}%</span>
                            <span>日期 {comparison.dateCoverage}%</span>
                          </div>
                          {comparison.warnings.length || comparison.skippedReasons.length ? (
                            <small>
                              {[...comparison.warnings, ...comparison.skippedReasons].slice(0, 2).join("；")}
                            </small>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {item.posterior.runtimeTraces?.length ? (
                    <BacktestRuntimeSummary backtest={item} />
                  ) : null}
                  {item.failureDetails?.length ? (
                    <div className="dynamic-backtest-warning">
                      <strong>Provider 异常</strong>
                      <p>
                        {item.failureDetails
                          .map((detail) => `${detail.label}：${detail.message}`)
                          .slice(0, 2)
                          .join("；")}
                      </p>
                    </div>
                  ) : null}
                  <div className="dynamic-backtest-evidence">
                    <strong>
                      <TrendingUp size={14} />
                      后验证据
                    </strong>
                    <ul>
                      {item.posterior.evidence.slice(0, 5).map((evidence) => (
                        <li key={evidence}>{evidence}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="dynamic-backtest-lesson">
                    <strong>
                      <CheckCircle2 size={14} />
                      {outcomeLabel(item.posterior.outcomeLabel)}
                    </strong>
                    <p>{item.calibration.lesson}</p>
                  </div>

                  <details>
                    <summary>查看查询和评分项</summary>
                    <div className="dynamic-backtest-details">
                      {item.prediction.scoreBreakdown.map((score) => (
                        <span key={score.label}>
                          {score.label} {score.score}
                        </span>
                      ))}
                      {item.posterior.queryExecutions.map((execution) => (
                        <span key={`${execution.queryId}-${execution.status}`}>
                          {execution.queryId} · {execution.status} · {execution.resultCount}
                        </span>
                      ))}
                      </div>
                  </details>
                </>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="dynamic-backtest-empty">还没有动态回测记录。</div>
      )}
    </section>
  );
}

function calibrationLabel(result: DynamicBacktestRecord["calibration"]["result"]) {
  if (result === "aligned") return "判断对齐";
  if (result === "underestimated") return "README 低估";
  if (result === "overestimated") return "README 高估";
  return "证据不足";
}

function outcomeLabel(result: DynamicBacktestRecord["posterior"]["outcomeLabel"]) {
  if (result === "strong_success") return "后验：强成功";
  if (result === "promising") return "后验：有希望";
  if (result === "mixed") return "后验：混合";
  if (result === "weak") return "后验：弱";
  return "后验：不足";
}

function formatDelta(delta: number) {
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function providerLabel(provider: string) {
  if (provider === "zhipu") return "智谱";
  if (provider === "serper") return "Serper";
  return provider;
}

function candidateFitLabel(fit: BacktestCandidateSampleFit) {
  if (fit === "success_case") return "强后验";
  if (fit === "weak_case") return "弱后验/反例";
  if (fit === "tooling_case") return "工具链";
  if (fit === "mixed_case") return "混合样本";
  return "相邻样本";
}

function failureStageLabel(stage: DynamicBacktestRecord["failureStage"]) {
  if (stage === "github_import") return "读取 GitHub/README";
  if (stage === "readme_prediction") return "README 初判";
  if (stage === "posterior_research") return "后验证据搜索";
  if (stage === "calibration") return "校准结果";
  return "未知阶段";
}
