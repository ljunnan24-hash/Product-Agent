import { AlertTriangle, Gauge, ListChecks, Scale, SlidersHorizontal } from "lucide-react";
import type { BacktestCalibrationSummary } from "@/lib/backtest-calibration";

type Props = {
  summary: BacktestCalibrationSummary;
};

type CalibrationAction = BacktestCalibrationSummary["actions"][number];

export function BacktestCalibrationPanel({ summary }: Props) {
  return (
    <section className="backtest-calibration" aria-label="README 回测校准沉淀">
      <div className="backtest-calibration-header">
        <div>
          <span>校准账本</span>
          <h2>把回测变成判断规则。</h2>
        </div>
        <small>静态样本 {summary.staticSampleCount} · 动态样本 {summary.dynamicSampleCount}</small>
      </div>

      <div className="backtest-calibration-metrics">
        <Metric
          label="已完成动态回测"
          value={String(summary.completedDynamicCount)}
          detail={`失败 ${summary.failedDynamicCount}`}
        />
        <Metric
          label="平均偏差"
          value={summary.averageAbsoluteDelta === null ? "待样本" : String(summary.averageAbsoluteDelta)}
          detail="README 预测 vs 后验"
        />
        <Metric
          label="对齐率"
          value={summary.alignedRate === null ? "待样本" : `${summary.alignedRate}%`}
          detail={`高估 ${summary.resultCounts.overestimated} · 低估 ${summary.resultCounts.underestimated}`}
        />
        <Metric
          label="规则数"
          value={String(summary.rules.length)}
          detail="可复用到 Agent"
        />
      </div>

      <div className="calibration-action-ledger">
        <div className="section-title">
          <SlidersHorizontal size={15} />
          <strong>调权闭环</strong>
        </div>
        <div className="calibration-action-list">
          {summary.actions.map((action) => (
            <article className={`calibration-action ${action.action}`} key={action.id}>
              <div>
                <span>{calibrationActionLabel(action.action)}</span>
                <strong>{action.label}</strong>
              </div>
              <h3>{action.target}</h3>
              <p>{action.reason}</p>
              <small>
                样本 {action.sampleCount} · 缺口 {action.neededSamples} · 偏差{" "}
                {formatNullableDelta(action.averageDelta)} · {confidenceLabel(action.confidence)}
              </small>
              <em>{action.recommendedAdjustment}</em>
              <p>{action.nextStep}</p>
            </article>
          ))}
        </div>
      </div>

      <div className="backtest-calibration-grid">
        <div className="backtest-calibration-section rules">
          <div className="section-title">
            <ListChecks size={15} />
            <strong>已沉淀规则</strong>
          </div>
          {summary.rules.slice(0, 5).map((rule) => (
            <article className={`calibration-rule ${rule.priority}`} key={rule.id}>
              <span>{priorityLabel(rule.priority)}</span>
              <h3>{rule.title}</h3>
              <p>{rule.summary}</p>
              <small>{rule.agentRule}</small>
            </article>
          ))}
        </div>

        <div className="backtest-calibration-section">
          <div className="section-title">
            <Scale size={15} />
            <strong>动态信号权重</strong>
          </div>
          {summary.signalCalibrations.length ? (
            <div className="signal-list">
              {summary.signalCalibrations.map((signal) => (
                <div className={`signal-row ${signal.verdict}`} key={signal.label}>
                  <div>
                    <strong>{signal.label}</strong>
                    <span>{signalLessonLabel(signal.verdict)}</span>
                  </div>
                  <p>
                    样本 {signal.sampleCount} · 均分 {signal.averageScore} · 偏差{" "}
                    {formatDelta(signal.averageDelta)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="calibration-empty">
              还没有足够动态样本。先跑 3-5 个 repo，系统会开始判断哪些 README 信号被高估或低估。
            </div>
          )}
        </div>

        <div className="backtest-calibration-section">
          <div className="section-title">
            <AlertTriangle size={15} />
            <strong>失败模式</strong>
          </div>
          {summary.failurePatterns.length ? (
            <div className="failure-pattern-list">
              {summary.failurePatterns.map((pattern) => (
                <div className="failure-pattern" key={pattern.key}>
                  <strong>
                    {pattern.label}
                    <span>{pattern.count}</span>
                  </strong>
                  <p>{pattern.example}</p>
                  <small>{pattern.action}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="calibration-empty">
              暂无动态失败样本。失败会进入工具改进，不会被当作产品没潜力。
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>
        <Gauge size={15} />
        {value}
      </strong>
      <small>{detail}</small>
    </div>
  );
}

function priorityLabel(priority: string) {
  if (priority === "high") return "高优先";
  if (priority === "medium") return "中优先";
  return "低优先";
}

function signalLessonLabel(verdict: string) {
  if (verdict === "usable") return "可用";
  if (verdict === "overweighted") return "可能高估";
  if (verdict === "underweighted") return "可能低估";
  return "样本不足";
}

function calibrationActionLabel(action: CalibrationAction["action"]) {
  if (action === "upweight") return "升权";
  if (action === "downweight") return "降权";
  if (action === "hold") return "保持";
  if (action === "fix_tooling") return "修链路";
  return "补样本";
}

function confidenceLabel(confidence: CalibrationAction["confidence"]) {
  if (confidence === "high") return "高置信";
  if (confidence === "medium") return "中置信";
  return "低置信";
}

function formatNullableDelta(delta: number | null) {
  if (delta === null) return "待样本";
  return formatDelta(delta);
}

function formatDelta(delta: number) {
  if (delta > 0) return `+${delta}`;
  return String(delta);
}
