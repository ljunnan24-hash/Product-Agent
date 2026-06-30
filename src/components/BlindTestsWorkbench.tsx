"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Loader2,
  Play,
  Scale
} from "lucide-react";
import {
  blindTestPrompt,
  defaultBlindTestScores,
  scoreBlindTestJudgment
} from "@/lib/blind-test-cases";
import { BacktestRuntimeSummary } from "@/components/BacktestRuntimeSummary";
import type {
  BlindTestCase,
  BlindTestJudgment,
  BlindTestParticipant,
  BlindTestScores,
  DynamicBacktestRecord
} from "@/lib/types";

type Props = {
  cases: BlindTestCase[];
  initialBacktests: DynamicBacktestRecord[];
  initialJudgments: BlindTestJudgment[];
};

type ManualDraft = {
  output: string;
  notes: string;
  scores: BlindTestScores;
  potentialScore: string;
  decision: BlindTestJudgment["decision"] | "";
};

export function BlindTestsWorkbench({ cases, initialBacktests, initialJudgments }: Props) {
  const [judgments, setJudgments] = useState(initialJudgments);
  const [backtests, setBacktests] = useState(initialBacktests);
  const [drafts, setDrafts] = useState<Record<string, ManualDraft>>({});
  const [runningCaseId, setRunningCaseId] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  const judgmentByKey = useMemo(
    () => new Map(judgments.map((item) => [judgmentKey(item.caseId, item.participant), item])),
    [judgments]
  );
  const backtestById = useMemo(
    () => new Map(backtests.map((item) => [item.id, item])),
    [backtests]
  );
  const summary = useMemo(() => blindTestSummary(cases, judgments), [cases, judgments]);

  async function runProductAgent(testCase: BlindTestCase) {
    setError("");
    setRunningCaseId(testCase.id);
    try {
      const response = await fetch("/api/blind-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run_product_agent", caseId: testCase.id })
      });
      const payload = (await response.json()) as {
        judgment?: BlindTestJudgment;
        backtest?: DynamicBacktestRecord;
        error?: string;
      };
      if (!response.ok || !payload.judgment) {
        throw new Error(payload.error || "Product Agent 盲测失败");
      }
      upsertJudgment(payload.judgment);
      if (payload.backtest) {
        setBacktests((current) => [
          payload.backtest!,
          ...current.filter((item) => item.id !== payload.backtest!.id)
        ]);
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Product Agent 盲测失败");
    } finally {
      setRunningCaseId(null);
    }
  }

  async function saveManualJudgment(testCase: BlindTestCase, participant: Exclude<BlindTestParticipant, "product_agent">) {
    const key = judgmentKey(testCase.id, participant);
    const draft = getDraft(testCase.id, participant);
    setError("");
    setSavingKey(key);
    try {
      const response = await fetch("/api/blind-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_judgment",
          caseId: testCase.id,
          participant,
          output: draft.output,
          notes: draft.notes,
          scores: draft.scores,
          potentialScore: draft.potentialScore ? Number(draft.potentialScore) : undefined,
          decision: draft.decision || undefined
        })
      });
      const payload = (await response.json()) as {
        judgment?: BlindTestJudgment;
        error?: string;
      };
      if (!response.ok || !payload.judgment) {
        throw new Error(payload.error || "保存盲测结果失败");
      }
      upsertJudgment(payload.judgment);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存盲测结果失败");
    } finally {
      setSavingKey(null);
    }
  }

  function upsertJudgment(judgment: BlindTestJudgment) {
    setJudgments((current) => [
      judgment,
      ...current.filter(
        (item) => !(item.caseId === judgment.caseId && item.participant === judgment.participant)
      )
    ]);
  }

  function getDraft(caseId: string, participant: Exclude<BlindTestParticipant, "product_agent">) {
    const key = judgmentKey(caseId, participant);
    const existing = judgmentByKey.get(key);
    return (
      drafts[key] ?? {
        output: existing?.output || "",
        notes: existing?.notes || "",
        scores: existing?.scores || defaultBlindTestScores(),
        potentialScore: typeof existing?.potentialScore === "number" ? String(existing.potentialScore) : "",
        decision: existing?.decision || ""
      }
    );
  }

  function updateDraft(
    caseId: string,
    participant: Exclude<BlindTestParticipant, "product_agent">,
    patch: Partial<ManualDraft>
  ) {
    const key = judgmentKey(caseId, participant);
    setDrafts((current) => ({
      ...current,
      [key]: {
        ...getDraft(caseId, participant),
        ...patch
      }
    }));
  }

  async function copyPrompt(testCase: BlindTestCase) {
    setError("");
    try {
      await navigator.clipboard.writeText(blindTestPrompt(testCase));
    } catch {
      setError("复制失败，可以手动复制页面里的提示词。");
    }
  }

  return (
    <section className="blind-workbench">
      <div className="blind-summary">
        <Metric label="样本" value={String(cases.length)} detail="真实 README / repo" />
        <Metric label="Product Agent" value={`${summary.productAgentDone}/${cases.length}`} detail="已跑自动判断" />
        <Metric label="ChatGPT" value={`${summary.chatgptDone}/${cases.length}`} detail="已保存手动结果" />
        <Metric label="Claude" value={`${summary.claudeDone}/${cases.length}`} detail="已保存手动结果" />
        <Metric label="平均分" value={summary.bestAverage} detail="当前最高参评者" />
      </div>

      {error ? <p className="blind-error">{error}</p> : null}

      <div className="blind-case-list">
        {cases.map((testCase, index) => {
          const productAgentJudgment = judgmentByKey.get(judgmentKey(testCase.id, "product_agent"));
          const productAgentBacktest = productAgentJudgment?.linkedBacktestId
            ? backtestById.get(productAgentJudgment.linkedBacktestId)
            : undefined;
          return (
            <article className="blind-case" key={testCase.id}>
              <div className="blind-case-head">
                <div>
                  <span>Case {String.fromCharCode(65 + index)}</span>
                  <h2>{testCase.repo}</h2>
                  <p>{testCase.promptFocus}</p>
                </div>
                <div className="blind-case-actions">
                  <a href={testCase.repoUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} />
                    README
                  </a>
                  <button type="button" onClick={() => copyPrompt(testCase)}>
                    <Clipboard size={14} />
                    复制提示词
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(runningCaseId)}
                    onClick={() => runProductAgent(testCase)}
                  >
                    {runningCaseId === testCase.id ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <Play size={14} />
                    )}
                    跑 Agent
                  </button>
                </div>
              </div>

              <details className="blind-prompt">
                <summary>统一提示词</summary>
                <pre>{blindTestPrompt(testCase)}</pre>
              </details>

              <div className="blind-judgment-grid">
                <JudgmentCard
                  title="Product Agent"
                  icon={<Bot size={15} />}
                  judgment={productAgentJudgment}
                  backtest={productAgentBacktest}
                />
                {(["chatgpt", "claude"] as const).map((participant) => {
                  const draft = getDraft(testCase.id, participant);
                  const existing = judgmentByKey.get(judgmentKey(testCase.id, participant));
                  return (
                    <ManualJudgmentCard
                      draft={draft}
                      existing={existing}
                      isSaving={savingKey === judgmentKey(testCase.id, participant)}
                      key={participant}
                      participant={participant}
                      onChange={(patch) => updateDraft(testCase.id, participant, patch)}
                      onSave={() => saveManualJudgment(testCase, participant)}
                    />
                  );
                })}
              </div>

              <details className="blind-outcome">
                <summary>揭示后验参考</summary>
                <strong>{outcomeLabel(testCase.hiddenOutcome.label)}</strong>
                <p>{testCase.hiddenOutcome.summary}</p>
                <ul>
                  {testCase.hiddenOutcome.evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function JudgmentCard({
  title,
  icon,
  judgment,
  backtest
}: {
  title: string;
  icon: ReactNode;
  judgment?: BlindTestJudgment;
  backtest?: DynamicBacktestRecord;
}) {
  return (
    <div className="blind-judgment">
      <div className="blind-judgment-title">
        <strong>
          {icon}
          {title}
        </strong>
        {judgment ? (
          <span>
            <CheckCircle2 size={13} />
            {scoreBlindTestJudgment(judgment.scores)}
          </span>
        ) : (
          <span>待跑</span>
        )}
      </div>
      {judgment ? (
        <>
          <p>{judgment.output.slice(0, 360)}</p>
          <ScoreStrip scores={judgment.scores} />
          {backtest?.posterior.runtimeTraces?.length ? (
            <BacktestRuntimeSummary backtest={backtest} />
          ) : null}
        </>
      ) : (
        <p>还没有结果。</p>
      )}
    </div>
  );
}

function ManualJudgmentCard({
  participant,
  draft,
  existing,
  isSaving,
  onChange,
  onSave
}: {
  participant: Exclude<BlindTestParticipant, "product_agent">;
  draft: ManualDraft;
  existing?: BlindTestJudgment;
  isSaving: boolean;
  onChange: (patch: Partial<ManualDraft>) => void;
  onSave: () => void;
}) {
  return (
    <div className="blind-judgment manual">
      <div className="blind-judgment-title">
        <strong>
          <Scale size={15} />
          {participant === "chatgpt" ? "ChatGPT" : "Claude"}
        </strong>
        {existing ? (
          <span>
            <CheckCircle2 size={13} />
            {scoreBlindTestJudgment(existing.scores)}
          </span>
        ) : (
          <span>待粘贴</span>
        )}
      </div>
      <textarea
        value={draft.output}
        onChange={(event) => onChange({ output: event.target.value })}
        placeholder="粘贴模型输出"
        rows={5}
      />
      <div className="blind-manual-row">
        <input
          value={draft.potentialScore}
          onChange={(event) => onChange({ potentialScore: event.target.value })}
          placeholder="潜力分"
        />
        <select
          value={draft.decision}
          onChange={(event) =>
            onChange({ decision: event.target.value as ManualDraft["decision"] })
          }
        >
          <option value="">决策</option>
          <option value="build">build</option>
          <option value="test_first">test first</option>
          <option value="reposition">reposition</option>
          <option value="stop">stop</option>
        </select>
      </div>
      <ScoreEditor
        scores={draft.scores}
        onChange={(scores) => onChange({ scores })}
      />
      <textarea
        value={draft.notes}
        onChange={(event) => onChange({ notes: event.target.value })}
        placeholder="评分备注，可选"
        rows={2}
      />
      <button type="button" disabled={isSaving} onClick={onSave}>
        {isSaving ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
        保存结果
      </button>
    </div>
  );
}

function ScoreEditor({
  scores,
  onChange
}: {
  scores: BlindTestScores;
  onChange: (scores: BlindTestScores) => void;
}) {
  return (
    <div className="blind-score-editor">
      {scoreFields.map((field) => (
        <label key={field.key}>
          <span>{field.label}</span>
          <input
            max={5}
            min={1}
            type="number"
            value={scores[field.key]}
            onChange={(event) =>
              onChange({
                ...scores,
                [field.key]: Number(event.target.value)
              })
            }
          />
        </label>
      ))}
    </div>
  );
}

function ScoreStrip({ scores }: { scores: BlindTestScores }) {
  return (
    <div className="blind-score-strip">
      {scoreFields.map((field) => (
        <span key={field.key}>
          {field.label} {scores[field.key]}
        </span>
      ))}
    </div>
  );
}

const scoreFields: Array<{ key: keyof BlindTestScores; label: string }> = [
  { key: "evidenceQuality", label: "证据" },
  { key: "oppositionCoverage", label: "反证" },
  { key: "experimentActionability", label: "实验" },
  { key: "calibration", label: "校准" },
  { key: "trust", label: "信任" }
];

function blindTestSummary(cases: BlindTestCase[], judgments: BlindTestJudgment[]) {
  const productAgentDone = countParticipant(judgments, "product_agent");
  const chatgptDone = countParticipant(judgments, "chatgpt");
  const claudeDone = countParticipant(judgments, "claude");
  const averages = (["product_agent", "chatgpt", "claude"] as const).map((participant) => {
    const participantScores = judgments
      .filter((item) => item.participant === participant)
      .map((item) => scoreBlindTestJudgment(item.scores));
    return {
      participant,
      average: participantScores.length
        ? participantScores.reduce((sum, value) => sum + value, 0) / participantScores.length
        : 0
    };
  });
  const best = averages.sort((a, b) => b.average - a.average)[0];
  return {
    productAgentDone,
    chatgptDone,
    claudeDone,
    bestAverage: best.average ? `${participantLabel(best.participant)} ${best.average.toFixed(2)}` : "待样本"
  };
}

function countParticipant(judgments: BlindTestJudgment[], participant: BlindTestParticipant) {
  return new Set(judgments.filter((item) => item.participant === participant).map((item) => item.caseId)).size;
}

function judgmentKey(caseId: string, participant: BlindTestParticipant) {
  return `${caseId}:${participant}`;
}

function participantLabel(participant: BlindTestParticipant) {
  if (participant === "product_agent") return "Agent";
  if (participant === "chatgpt") return "ChatGPT";
  return "Claude";
}

function outcomeLabel(label: string) {
  if (label === "strong_success") return "强成功";
  if (label === "promising") return "有希望";
  if (label === "mixed") return "混合";
  if (label === "weak") return "偏弱";
  return "证据不足";
}
