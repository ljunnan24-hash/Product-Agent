import Link from "next/link";
import { Plus } from "lucide-react";
import { BacktestCalibrationPanel } from "@/components/BacktestCalibrationPanel";
import { BacktestsRunner } from "@/components/BacktestsRunner";
import {
  githubBacktestLessons,
  githubReadmeBacktestCases
} from "@/lib/github-readme-backtests";
import { buildBacktestCalibrationSummary } from "@/lib/backtest-calibration";
import { ensureBacktestSuggestionCandidates } from "@/lib/backtest-suggestion-candidates";
import {
  listBacktestRecords,
  listBacktestSuggestions,
  updateBacktestSuggestion
} from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function BacktestsPage() {
  const dynamicBacktests = await listBacktestRecords();
  const backtestSuggestions = await ensureBacktestSuggestionCandidates(
    await listBacktestSuggestions(),
    { updateSuggestion: updateBacktestSuggestion }
  );
  const calibrationSummary = buildBacktestCalibrationSummary({
    staticCases: githubReadmeBacktestCases,
    dynamicRecords: dynamicBacktests
  });

  return (
    <main className="backtest-shell">
      <header className="report-header">
        <Link className="brand" href="/">
          Product Agent
        </Link>
        <div className="topbar-actions">
          <Link className="secondary-link" href="/">
            <Plus size={16} />
            新建诊断
          </Link>
          <Link className="secondary-link" href="/analyses">
            报告库
          </Link>
          <Link className="secondary-link" href="/blind-tests">
            真实盲测
          </Link>
        </div>
      </header>

      <section className="backtest-hero">
        <div>
          <p>README 回测</p>
          <h1>先预测，再看后验。</h1>
        </div>
        <span>{githubReadmeBacktestCases.length} 个校准样本</span>
      </section>

      <section className="backtest-lessons" aria-label="回测原则">
        {githubBacktestLessons.map((lesson) => (
          <div key={lesson}>{lesson}</div>
        ))}
      </section>

      <BacktestCalibrationPanel summary={calibrationSummary} />

      <BacktestsRunner
        initialBacktests={dynamicBacktests}
        initialSuggestions={backtestSuggestions}
      />

      <section className="backtest-grid" aria-label="GitHub README 回测样本">
        {githubReadmeBacktestCases.map((item) => (
          <article className="backtest-card" key={item.id}>
            <div className="backtest-card-header">
              <div>
                <span>{caseTypeLabel(item.sampleType)}</span>
                <h2>{item.repo}</h2>
              </div>
              <a href={item.repoUrl} target="_blank">
                GitHub
              </a>
            </div>

            <div className="backtest-section">
              <strong>README 信号</strong>
              <p>{item.readmeThesis}</p>
            </div>

            <div className="backtest-prediction">
              <div>
                <span>预测潜力</span>
                <strong>{item.readmeOnlyPrediction.potential}</strong>
              </div>
              <div>
                <span>预测决策</span>
                <strong>{decisionLabel(item.readmeOnlyPrediction.decision)}</strong>
              </div>
            </div>

            <div className="backtest-section">
              <strong>只看 README 的判断</strong>
              <p>{item.readmeOnlyPrediction.rationale}</p>
              <small>{item.readmeOnlyPrediction.uncertainty}</small>
            </div>

            <div className="backtest-section outcome">
              <strong>后验结果：{item.posteriorOutcome.label}</strong>
              <ul>
                {item.posteriorOutcome.evidence.map((evidence) => (
                  <li key={evidence}>{evidence}</li>
                ))}
              </ul>
            </div>

            <div className="backtest-section lesson">
              <strong>校准教训</strong>
              <p>{item.calibrationLesson}</p>
            </div>

            <div className="backtest-sources">
              {item.sources.map((source) => (
                <a href={source.url} key={source.url} target="_blank">
                  {source.label}
                </a>
              ))}
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function caseTypeLabel(type: string) {
  if (type === "strong_success") return "强成功样本";
  if (type === "mixed_outcome") return "混合样本";
  return "开发者工具";
}

function decisionLabel(decision: string) {
  if (decision === "build") return "build";
  if (decision === "reposition") return "reposition";
  if (decision === "stop") return "stop";
  return "test first";
}
