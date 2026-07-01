"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  CheckCircle2,
  CircleDashed,
  FileImage,
  ListChecks,
  Loader2,
  Paperclip,
  Search,
  TrendingUp,
  Wand2
} from "lucide-react";
import type { ProductVariantConfig } from "@/lib/variants";
import type {
  AnalysisRecord,
  AnalysisRunLog,
  ImageMetrics,
  RunRetryInput,
  StoredRunEvent
} from "@/lib/types";

type MaterialDraft = {
  file: File;
  preview: string | null;
  metrics: ImageMetrics | null;
};

type LiveRunStageId =
  | "intake"
  | "material_reader"
  | "web_research"
  | "evidence_agent"
  | "report_composer"
  | "quality_gate";

type LiveRunPhaseId = "read" | "research" | "organize" | "write";

type LiveRunEvent = {
  type?: "progress" | "complete" | "error";
  stage: LiveRunStageId;
  status: "running" | "completed" | "failed";
  title: string;
  summary: string;
  detail?: string;
  at?: string;
  id?: string;
  runId?: string;
};

type StreamPayload = Partial<LiveRunEvent> & {
  type?: "progress" | "complete" | "error";
  message?: string;
  status?: number;
  id?: string;
  analysisId?: string;
  runId?: string;
};

type ResumedRunState = {
  id: string;
  status: AnalysisRunLog["status"];
  analysisId?: string;
  errorMessage?: string;
  sourceSummary?: string;
  retryInput?: RunRetryInput;
  summary?: AnalysisRunLog["summary"];
  updatedAt: string;
};

type DemoExamplePayload = {
  brief: string;
  githubRepoUrl?: string;
  materials: Array<{
    name: string;
    mimeType: string;
    content: string;
  }>;
};

type ConversationAnalysisAnswer = {
  analysisId: string;
  productName: string;
  score: number;
  headline: string;
  verdict: string;
  firstImpression: string;
  signals: string[];
  risks: string[];
  nextStep: string;
  accuracyNote: string;
};

type Props = {
  variant: ProductVariantConfig;
};

const sampleBrief =
  "";

class StreamAnalysisError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export function ChatAgentEntry({ variant }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [brief, setBrief] = useState(sampleBrief);
  const [materials, setMaterials] = useState<MaterialDraft[]>([]);
  const [error, setError] = useState("");
  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [submittedBrief, setSubmittedBrief] = useState("");
  const [submittedMaterialNames, setSubmittedMaterialNames] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [runEvents, setRunEvents] = useState<LiveRunEvent[]>([]);
  const [resumedRun, setResumedRun] = useState<ResumedRunState | null>(null);
  const [analysisAnswer, setAnalysisAnswer] = useState<ConversationAnalysisAnswer | null>(null);
  const [isRestoringRun, setIsRestoringRun] = useState(false);
  const [isLoadingExample, setIsLoadingExample] = useState(false);

  const primaryMetrics = materials[0]?.metrics ?? null;
  const isAwaitingSupplement = Boolean(
    followUpPrompt && (submittedBrief || submittedMaterialNames.length)
  );
  const composerPlaceholder = isAwaitingSupplement
    ? "直接补一句：给谁用、现在怎么解决、你最想验证什么。"
    : "粘贴产品介绍。比如：给谁用、解决什么问题、现在做到哪一步。";
  const followUpDisplay = simplifyFollowUpPrompt(followUpPrompt);
  const submittedBriefParts = splitIntakeBrief(submittedBrief);
  const hasSubmittedSupplement = submittedBriefParts.supplements.length > 0;

  useEffect(() => {
    void restoreLastRun();
  }, []);

  useEffect(() => {
    if (resumedRun?.status !== "running") return;
    const timer = window.setInterval(() => {
      void loadRunLog(resumedRun.id, { silent: true });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [resumedRun?.id, resumedRun?.status]);

  async function addFiles(fileList: FileList | null) {
    if (!fileList) return;

    setError("");
    const incoming = [...fileList].slice(0, 6 - materials.length);
    const nextMaterials: MaterialDraft[] = [];

    for (const file of incoming) {
      if (
        !isAllowedMaterial(file)
      ) {
        setError("这个文件暂时不能读取，请换一份产品介绍。");
        continue;
      }

      if (file.size > 12 * 1024 * 1024) {
        setError("单个文件请压缩到 12MB 以内。");
        continue;
      }

      nextMaterials.push({
        file,
        preview: isImageFile(file) ? URL.createObjectURL(file) : null,
        metrics:
          isImageFile(file) ? await extractImageMetrics(file) : null
      });
    }

    setMaterials((current) => [...current, ...nextMaterials].slice(0, 6));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const isSupplementing = Boolean(
      followUpPrompt && (submittedBrief || submittedMaterialNames.length)
    );
    const currentBrief = brief.trim();
    const hasNewSupplementMaterial = materials.length > submittedMaterialNames.length;

    if (isSupplementing && !currentBrief && !hasNewSupplementMaterial) {
      setError("直接补一句目标用户、痛点或你想验证的问题就行。");
      return;
    }

    setFollowUpPrompt("");

    if (materials.length === 0 && !currentBrief && !isSupplementing) {
      setError("先上传或粘贴产品介绍。");
      return;
    }

    const mergedBrief = isSupplementing
      ? mergeIntakeBrief(submittedBrief, currentBrief)
      : currentBrief;
    const body = buildSubmissionBody({
      productVariant: variant.id,
      brief: mergedBrief,
      imageMetrics: primaryMetrics,
      githubRepoUrl: "",
      materials
    });

    setSubmittedBrief(mergedBrief);
    setSubmittedMaterialNames(materials.map((material) => material.file.name || "产品介绍"));
    setBrief("");
    await startAnalysis(body, { isSupplement: isSupplementing });
  }

  async function startAnalysis(body: FormData, options?: { isSupplement?: boolean }) {
    setIsSubmitting(true);
    setResumedRun(null);
    setAnalysisAnswer(null);
    setRunEvents([
      {
        stage: "intake",
        status: "running",
        title: options?.isSupplement ? "合并补充" : "开始浏览",
        summary: options?.isSupplement
          ? "我把刚补充的信息和上一轮产品介绍放在一起看。"
          : "产品介绍已收到，我先快速看一遍。"
      }
    ]);

    try {
      const analysisId = await runStreamingAnalysis(body, (event) => {
        setRunEvents((current) => [...current, event].slice(-24));
      });

      const answer = await loadConversationAnalysisAnswer(analysisId);
      setAnalysisAnswer(answer);
      setRunEvents((current) => [
        ...current,
        {
          type: "complete" as const,
          stage: "quality_gate" as const,
          status: "completed" as const,
          title: "判断完成",
          summary: "判断已写在对话里，你可以继续补充，或打开完整记录。"
        }
      ].slice(-24));
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "分析失败";
      if (submitError instanceof StreamAnalysisError && submitError.status === 422) {
        setFollowUpPrompt(message);
        setBrief("");
        setError("");
      } else {
        setError(message);
      }
      setRunEvents((current) => {
        if (current.some((event) => event.status === "failed")) return current;
        return [
          ...current,
          {
            stage: "quality_gate",
            status: "failed",
            title: "分析失败",
            summary: submitError instanceof Error ? submitError.message : "分析失败"
          }
        ];
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function retryResumedRun() {
    const retryInput = resumedRun?.retryInput;
    if (!retryInput) return;

    setBrief(retryInput.brief);
    setMaterials([]);

    if (!retryInput.canAutoPrefill || !retryInput.githubRepoUrl) {
      setError(retryInput.limitation || "请重新上传产品介绍后重试。");
      inputRef.current?.click();
      return;
    }

    setError("");
    const body = buildSubmissionBody({
      productVariant: retryInput.productVariant,
      brief: retryInput.brief,
      imageMetrics: null,
      githubRepoUrl: "",
      materials: []
    });
    await startAnalysis(body);
  }

  async function loadDemoExample() {
    setIsLoadingExample(true);
    setError("");
    try {
      const response = await fetch("/api/examples/local-beta-demo", {
        cache: "no-store"
      });
      const payload = (await response.json()) as DemoExamplePayload;
      if (!response.ok) {
        throw new Error("示例产品介绍读取失败");
      }
      setBrief(payload.brief || "");
      setMaterials(
        payload.materials.slice(0, 6).map((material) => ({
          file: new File([material.content], material.name, {
            type: material.mimeType || "text/plain"
          }),
          preview: null,
          metrics: null
        }))
      );
      setFollowUpPrompt("");
      setSubmittedBrief("");
      setSubmittedMaterialNames([]);
      setAnalysisAnswer(null);
      setRunEvents([]);
      setResumedRun(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "示例产品介绍读取失败");
    } finally {
      setIsLoadingExample(false);
    }
  }

  return (
    <main className="chat-agent-layout conversation-mode">
      <section className="product-intake-hero">
        <h1>把产品介绍发给我</h1>
        <p>我会先读一遍；信息不完整也会先判断，并告诉你补什么会更准。</p>
      </section>

      <form className="chat-console conversation-console" onSubmit={onSubmit}>
        <div className="chat-history conversation-thread" aria-label="Product Agent conversation">
          <Message role="agent">
            <strong>发你现在有的版本就行。</strong>
            <p>可以是一段话，也可以是你已有的产品材料。材料少也能先跑，我会在结论里标出不确定性。</p>
            <div className="demo-example-action">
              <button
                type="button"
                onClick={loadDemoExample}
                disabled={isLoadingExample}
                aria-label="载入示例产品介绍"
              >
                {isLoadingExample ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
                看示例
              </button>
            </div>
          </Message>
          {submittedBrief || submittedMaterialNames.length > 0 ? (
            <>
              <Message role="user">
                <strong>
                  {submittedMaterialNames.length
                    ? `已上传 ${submittedMaterialNames.length} 份产品介绍。`
                    : "我想分析这个产品。"}
                </strong>
                {submittedBriefParts.primary ? (
                  <p>{submittedBriefParts.primary}</p>
                ) : (
                  <p>请判断产品潜力。</p>
                )}
                {submittedMaterialNames.length ? (
                  <div className="user-material-list">
                    {submittedMaterialNames.map((name, index) => (
                      <span key={`${name}-${index}`}>{name}</span>
                    ))}
                  </div>
                ) : null}
              </Message>
              {submittedBriefParts.supplements.map((supplement, index) => (
                <Message role="user" key={`supplement-${index}-${supplement.slice(0, 24)}`}>
                  <strong>{index === 0 ? "我补充一下。" : "我再补充一点。"}</strong>
                  <p>{supplement}</p>
                </Message>
              ))}
            </>
          ) : null}
          {submittedBrief || submittedMaterialNames.length > 0 ? (
            <Message role="agent">
              {followUpPrompt ? (
                <div className="agent-follow-up">
                  <strong>我先看了一遍，还需要一点信息。</strong>
                  <p>{followUpDisplay}</p>
                </div>
              ) : analysisAnswer ? (
                <ConversationAnalysisAnswerCard
                  answer={analysisAnswer}
                  onOpen={() => router.push(`/analysis/${analysisAnswer.analysisId}`)}
                />
              ) : (
                <p>
                  {hasSubmittedSupplement
                    ? "收到补充。我会把前后信息放在一起，继续调研替代方案、真实痛点和反证。"
                    : "收到。我会先判断；信息不够也会继续跑，只会告诉你补什么会更准。"}
                </p>
              )}
              <LiveReasoningPanel
                hasMaterials={Boolean(submittedBrief || submittedMaterialNames.length)}
                isSubmitting={isSubmitting}
                events={runEvents}
              />
            </Message>
          ) : null}
          {resumedRun ? (
            <Message role="agent">
              <div className="resume-run-card">
                <div className="resume-run-header">
                  <div>
                    <span>已恢复上次运行</span>
                    <strong>{resumeStatusTitle(resumedRun)}</strong>
                    <small>更新于 {formatRunTime(resumedRun.updatedAt)}</small>
                  </div>
                  <div className="resume-run-actions">
                    <button
                      type="button"
                      onClick={() => loadRunLog(resumedRun.id)}
                      disabled={isRestoringRun}
                    >
                      {isRestoringRun ? "刷新中" : "刷新状态"}
                    </button>
                    {resumedRun.analysisId ? (
                      <button
                        type="button"
                        onClick={() => router.push(`/analysis/${resumedRun.analysisId}`)}
                      >
                        打开判断
                      </button>
                    ) : null}
                    {resumedRun.status === "failed" && resumedRun.retryInput ? (
                      <button type="button" onClick={retryResumedRun} disabled={isSubmitting}>
                        {resumedRun.retryInput.canAutoPrefill ? "一键重跑" : "带入说明"}
                      </button>
                    ) : null}
                    <button type="button" onClick={clearResumedRun}>
                      清除
                    </button>
                  </div>
                </div>
                {resumedRun.errorMessage ? (
                  <p className="resume-run-error">{resumedRun.errorMessage}</p>
                ) : null}
                {resumedRun.summary ? (
                  <div className="resume-run-progress">
                    <div>
                      <span style={{ width: `${resumedRun.summary.progressPercent}%` }} />
                    </div>
                    <small>
                      {resumedRun.summary.progressPercent}% ·{" "}
                      {resumedRun.summary.failedStage
                        ? `失败在${runStageLabel(resumedRun.summary.failedStage)}`
                        : resumedRun.summary.currentStage
                          ? `正在${runStageLabel(resumedRun.summary.currentStage)}`
                          : resumedRun.status === "completed"
                            ? "已完成"
                            : "等待更新"}
                    </small>
                    <p>{resumedRun.summary.recoverabilityReason}</p>
                  </div>
                ) : null}
                {resumedRun.sourceSummary ? (
                  <p className="resume-run-source">{resumedRun.sourceSummary}</p>
                ) : null}
                {resumedRun.status === "failed" && resumedRun.retryInput?.limitation ? (
                  <p className="resume-run-note">{resumedRun.retryInput.limitation}</p>
                ) : null}
                <LiveReasoningPanel
                  hasMaterials
                  isSubmitting={resumedRun.status === "running"}
                  events={runEvents}
                />
              </div>
            </Message>
          ) : null}
        </div>

        <div className="composer-box">
          {isAwaitingSupplement ? (
            <p className="composer-follow-up-hint">
              不用重写一遍，直接补一句就行，我会接着上一轮看。
            </p>
          ) : null}
          {materials.length > 0 ? (
            <div className="material-strip">
              {materials.map((material, index) => (
                <div className="material-chip" key={`${material.file.name}-${index}`}>
                  {material.preview ? (
                    <img src={material.preview} alt={material.file.name} />
                  ) : (
                    <div className="pdf-chip-icon">{fileKindLabel(material.file)}</div>
                  )}
                  <div>
                    <strong>{material.file.name}</strong>
                    <span>
                      {fileKindLabel(material.file)} ·{" "}
                      {Math.round(material.file.size / 1024)}KB
                    </span>
                  </div>
                  <button
                    aria-label={`移除 ${material.file.name}`}
                    type="button"
                    onClick={() =>
                      setMaterials((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder={composerPlaceholder}
            rows={5}
          />

          <div className="composer-actions">
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,application/pdf,text/markdown,text/plain,.md,.mdx,.txt,README"
              onChange={(event) => addFiles(event.target.files)}
            />
            <button
              className="attachment-button"
              type="button"
              onClick={() => inputRef.current?.click()}
              aria-label="上传产品介绍文件"
            >
              <Paperclip size={17} />
              附上材料
            </button>

            <div className="composer-spacer" />

            <button
              className="send-button"
              disabled={isSubmitting}
              aria-label={isSubmitting ? "正在分析" : "发送产品介绍"}
            >
              {isSubmitting ? <Loader2 className="spin" size={18} /> : <ArrowUp size={18} />}
            </button>
          </div>
        </div>

        {error ? <p className="form-error">{error}</p> : null}
      </form>
    </main>
  );

  async function restoreLastRun() {
    const runId = readRememberedRunId();
    if (!runId) return;
    await loadRunLog(runId, { silent: true });
  }

  async function loadRunLog(runId: string, options?: { silent?: boolean }) {
    if (!options?.silent) setIsRestoringRun(true);

    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => null)) as {
        run?: AnalysisRunLog;
        error?: string;
      } | null;
      if (!response.ok || !payload?.run) {
        forgetRunId(runId);
        setResumedRun(null);
        return;
      }

      const run = payload.run;
      if (options?.silent && !shouldRestoreRun(run)) {
        forgetRunId(run.id);
        setResumedRun(null);
        setRunEvents([]);
        return;
      }
      const restoredEvents = liveEventsFromRun(run);
      if (restoredEvents.length) {
        setRunEvents(restoredEvents.slice(-24));
      }
      setResumedRun({
        id: run.id,
        status: run.status,
        analysisId: run.analysisId,
        errorMessage: run.errorMessage,
        sourceSummary: run.sourceSummary,
        retryInput: run.retryInput,
        summary: run.summary,
        updatedAt: run.updatedAt
      });
    } finally {
      setIsRestoringRun(false);
    }
  }

  function clearResumedRun() {
    if (resumedRun?.id) forgetRunId(resumedRun.id);
    setResumedRun(null);
    setSubmittedBrief("");
    setSubmittedMaterialNames([]);
    setFollowUpPrompt("");
    setAnalysisAnswer(null);
    setRunEvents([]);
  }
}

function buildSubmissionBody({
  productVariant,
  brief,
  imageMetrics,
  githubRepoUrl,
  materials
}: {
  productVariant: string;
  brief: string;
  imageMetrics: ImageMetrics | null;
  githubRepoUrl: string;
  materials: MaterialDraft[];
}) {
  const body = new FormData();
  body.append("product_variant", productVariant);
  body.append("brief", brief);
  body.append("image_metrics", JSON.stringify(imageMetrics));
  if (githubRepoUrl.trim()) {
    body.append("github_repo_url", githubRepoUrl.trim());
  }

  for (const material of materials) {
    body.append("materials", material.file);
  }

  return body;
}

async function loadConversationAnalysisAnswer(analysisId: string) {
  const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}`, {
    cache: "no-store"
  });
  const payload = (await response.json().catch(() => null)) as AnalysisRecord | { error?: string } | null;

  if (!response.ok || !isAnalysisRecord(payload) || !payload.report) {
    throw new Error("判断完成了，但对话结果读取失败。可以从历史判断里打开完整记录。");
  }

  return buildConversationAnalysisAnswer(payload);
}

function isAnalysisRecord(value: AnalysisRecord | { error?: string } | null): value is AnalysisRecord {
  return Boolean(value && "id" in value && "status" in value && "report" in value);
}

function buildConversationAnalysisAnswer(record: AnalysisRecord): ConversationAnalysisAnswer {
  const report = record.report;
  if (!report) throw new Error("没有可展示的判断结果。");

  const evidenceGap = record.evidenceBrief?.evidenceGaps?.[0]?.missingEvidence;
  const accuracyNote =
    report.limitations.find((item) => /补充|不完整|不足|缺|更准/.test(item)) ||
    (evidenceGap
      ? `如果补充「${evidenceGap}」，判断会更准。`
      : "这次判断已经先跑完；后续补充真实用户反馈、付费意愿或竞品替代情况，会让结论更稳。");
  const recoveryFallback = needsConversationFallback(report);
  if (recoveryFallback) {
    return {
      analysisId: record.id,
      productName: record.productName || record.evidenceBrief?.productName || "这个产品",
      score: Math.min(report.potential_score || 0, 35),
      headline: "信息太少，先给低置信判断：暂时不建议直接投入。",
      verdict:
        "我会先把它当作一个很早期的产品想法看：现在只有一个方向词，还看不出目标用户、具体场景和真实痛点，所以分数会偏保守。",
      firstImpression:
        "如果这个方向能落到一个高频、刚需、愿意付费的细分任务上，才值得继续查证和验证。",
      signals: ["方向有空间：AI 工具仍有机会，但机会主要来自具体场景，而不是“AI”这个标签本身。"],
      risks: [
        "用户不清：不知道给谁用，就很难判断分发、竞品和付费意愿。",
        "问题不清：不知道解决什么具体麻烦，容易变成泛泛助手。"
      ],
      nextStep: "补一句：给谁用、他们现在怎么解决、最想验证什么。我会基于这句继续给更准的判断。",
      accuracyNote
    };
  }

  return {
    analysisId: record.id,
    productName: record.productName || record.evidenceBrief?.productName || "这个产品",
    score: report.potential_score,
    headline: report.share_summary.one_line_diagnosis || report.potential_verdict,
    verdict: report.potential_verdict,
    firstImpression: report.first_impression,
    signals: nonEmptyList(
      report.market_evidence
        .slice(0, 2)
        .map((item) => `${item.signal}：${item.interpretation}`),
      ["还没有足够强的外部信号，当前判断会偏保守。"]
    ),
    risks: nonEmptyList(
      report.top_issues
        .slice(0, 2)
        .map((issue) => `${issue.title}：${issue.why_it_matters}`),
      ["信息还不够具体，目标用户、使用场景和替代方案会显著影响判断。"]
    ),
    nextStep:
      record.evidenceBrief?.recommendedExperiment?.title ||
      report.actionable_suggestions[0] ||
      "先做一次低成本用户验证。",
    accuracyNote
  };
}

function needsConversationFallback(report: NonNullable<AnalysisRecord["report"]>) {
  return /GraphExecutor|graph_blocked|证据链未完成|报告生成被|不能生成正常潜力报告/i.test(
    [
      report.share_summary.one_line_diagnosis,
      report.potential_verdict,
      report.first_impression,
      ...report.top_issues.map((issue) => issue.title)
    ].join("\n")
  );
}

function nonEmptyList(items: string[], fallback: string[]) {
  const values = items.map((item) => item.trim()).filter(Boolean);
  return values.length ? values : fallback;
}

function mergeIntakeBrief(previousBrief: string, supplement: string) {
  const previous = previousBrief.trim();
  const next = supplement.trim();
  if (!previous) return next;
  if (!next) return previous;
  return `${previous}\n\n补充：${next}`;
}

function splitIntakeBrief(value: string) {
  const parts = value
    .split(/\n\n补充：/g)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    primary: parts[0] || "",
    supplements: parts.slice(1)
  };
}

function simplifyFollowUpPrompt(prompt: string) {
  return prompt.replace(/\s+/g, " ").trim();
}

function shouldRestoreRun(run: AnalysisRunLog) {
  if (run.status === "running" || run.status === "completed") return true;
  if (run.retryInput?.canAutoPrefill) return true;
  return false;
}

function isAllowedMaterial(file: File) {
  return (
    isImageFile(file) ||
    file.type === "application/pdf" ||
    isTextFile(file)
  );
}

function isImageFile(file: File) {
  return ["image/png", "image/jpeg", "image/webp"].includes(file.type);
}

function isTextFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    file.type === "text/plain" ||
    file.type === "text/markdown" ||
    name.endsWith(".md") ||
    name.endsWith(".mdx") ||
    name.endsWith(".txt") ||
    name === "readme"
  );
}

function fileKindLabel(file: File) {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf") return "文档";
  if (name.endsWith(".md") || name.endsWith(".mdx") || name === "readme") {
    return "文档";
  }
  if (isTextFile(file)) return "文档";
  return "图片";
}

function Message({ role, children }: { role: "agent" | "user"; children: React.ReactNode }) {
  return (
    <div className={`chat-message ${role}`}>
      <span className="message-avatar">{role === "agent" ? "A" : "你"}</span>
      <div className="message-bubble">{children}</div>
    </div>
  );
}

function ConversationAnalysisAnswerCard({
  answer,
  onOpen
}: {
  answer: ConversationAnalysisAnswer;
  onOpen: () => void;
}) {
  return (
    <div className="conversation-answer">
      <div className="conversation-answer-head">
        <span>先给判断</span>
        <strong>{answer.score}/100</strong>
      </div>
      <h2>{answer.headline}</h2>
      <p>{answer.verdict}</p>
      <p className="conversation-answer-impression">{answer.firstImpression}</p>

      <div className="conversation-answer-grid">
        <div>
          <strong>我看到的信号</strong>
          {answer.signals.map((signal, index) => (
            <p key={`${signal}-${index}`}>{signal}</p>
          ))}
        </div>
        <div>
          <strong>主要风险</strong>
          {answer.risks.map((risk, index) => (
            <p key={`${risk}-${index}`}>{risk}</p>
          ))}
        </div>
      </div>

      <div className="conversation-answer-next">
        <strong>下一步</strong>
        <p>{answer.nextStep}</p>
      </div>
      <p className="conversation-answer-accuracy">{answer.accuracyNote}</p>
      <button type="button" onClick={onOpen}>
        打开完整记录
      </button>
    </div>
  );
}

async function runStreamingAnalysis(
  body: FormData,
  onEvent: (event: LiveRunEvent) => void
) {
  const response = await fetch("/api/analyses/stream", {
    method: "POST",
    body
  });

  if (!response.body) {
    const payload = (await response.json().catch(() => null)) as {
      id?: string;
      error?: string;
    } | null;
    if (response.ok && payload?.id) return payload.id;
    throw new Error(payload?.error || "分析失败，请稍后再试。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let analysisId = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const payload = parseStreamPayload(line);
      if (!payload) continue;
      rememberRunId(payload.runId);

      if (payload.type === "error") {
        throw new StreamAnalysisError(
          payload.message || "分析失败，请稍后再试。",
          payload.status
        );
      }

      if (payload.type === "complete" && (payload.analysisId || payload.id)) {
        analysisId = payload.analysisId || payload.id || "";
        continue;
      }

      const event = normalizeStreamEvent(payload);
      if (event) onEvent(event);
    }
  }

  if (buffer.trim()) {
    const payload = parseStreamPayload(buffer);
    rememberRunId(payload?.runId);
    if (payload?.type === "error") {
      throw new StreamAnalysisError(
        payload.message || "分析失败，请稍后再试。",
        payload.status
      );
    }
    if (payload?.type === "complete" && (payload.analysisId || payload.id)) {
      analysisId = payload.analysisId || payload.id || "";
    } else {
      const event = payload ? normalizeStreamEvent(payload) : null;
      if (event) onEvent(event);
    }
  }

  if (!analysisId) throw new Error("分析已结束，但没有返回结果 ID。");
  return analysisId;
}

function rememberRunId(runId: string | undefined) {
  if (!runId) return;
  try {
    window.localStorage.setItem("product-agent:last-run-id", runId);
  } catch {
    // Ignore private-mode storage failures.
  }
}

function readRememberedRunId() {
  try {
    return window.localStorage.getItem("product-agent:last-run-id") || "";
  } catch {
    return "";
  }
}

function forgetRunId(runId: string) {
  try {
    const remembered = window.localStorage.getItem("product-agent:last-run-id");
    if (remembered === runId) {
      window.localStorage.removeItem("product-agent:last-run-id");
    }
  } catch {
    // Ignore private-mode storage failures.
  }
}

function liveEventsFromRun(run: AnalysisRunLog): LiveRunEvent[] {
  const checkpointEvents =
    run.checkpoints
      ?.filter(
        (checkpoint) =>
          checkpoint.status === "running" ||
          checkpoint.status === "completed" ||
          checkpoint.status === "failed"
      )
      .map((checkpoint) => ({
        type: "progress" as const,
        stage: checkpoint.stage,
        status: checkpoint.status as "running" | "completed" | "failed",
        title: checkpoint.title,
        summary: checkpoint.summary,
        detail: checkpoint.detail,
        at: checkpoint.updatedAt,
        runId: run.id
      })) ?? [];
  const events = run.events
    .map((event) => liveEventFromStoredRunEvent(event))
    .filter((event): event is LiveRunEvent => Boolean(event));

  if (run.status === "completed" && run.analysisId) {
    events.push({
      type: "complete",
      stage: "quality_gate",
      status: "completed",
      title: "判断完成",
      summary: "结果已生成，可以打开查看。",
      id: run.analysisId,
      runId: run.id,
      at: run.updatedAt
    });
  }

  if (run.status === "failed") {
    events.push({
      type: "error",
      stage: "quality_gate",
      status: "failed",
      title: "分析失败",
      summary: run.errorMessage || "运行失败，请重新开始。",
      runId: run.id,
      at: run.updatedAt
    });
  }

  return dedupeRunEvents([...checkpointEvents, ...events]);
}

function liveEventFromStoredRunEvent(event: StoredRunEvent): LiveRunEvent | null {
  if (event.type === "complete") {
    return {
      type: "complete",
      stage: "quality_gate",
      status: "completed",
      title: "判断完成",
      summary: "结果已生成，可以打开查看。",
      id: event.analysisId || event.id,
      runId: event.runId,
      at: event.at
    };
  }

  if (event.type === "error") {
    return {
      type: "error",
      stage: "quality_gate",
      status: "failed",
      title: "分析失败",
      summary: event.message || "运行失败，请重新开始。",
      runId: event.runId,
      at: event.at
    };
  }

  if (!event.stage || !isLiveRunStage(event.stage)) return null;
  if (
    event.status !== "running" &&
    event.status !== "completed" &&
    event.status !== "failed"
  ) {
    return null;
  }

  return {
    type: "progress",
    stage: event.stage,
    status: event.status,
    title: event.title || stageFallbackTitle(event.stage),
    summary: event.summary || "",
    detail: event.detail,
    at: event.at,
    id: event.id,
    runId: event.runId
  };
}

function dedupeRunEvents(events: LiveRunEvent[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.type || "progress"}:${event.stage}:${event.status}:${event.at || ""}:${event.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseStreamPayload(line: string): StreamPayload | null {
  if (!line.trim()) return null;

  try {
    return JSON.parse(line) as StreamPayload;
  } catch {
    return null;
  }
}

function normalizeStreamEvent(payload: StreamPayload): LiveRunEvent | null {
  if (!payload.stage || !isLiveRunStage(payload.stage)) return null;
  if (
    payload.status !== "running" &&
    payload.status !== "completed" &&
    payload.status !== "failed"
  ) {
    return null;
  }

  return {
    stage: payload.stage,
    status: payload.status,
    title: payload.title || stageFallbackTitle(payload.stage),
    summary: payload.summary || "",
    detail: payload.detail,
    at: payload.at,
    id: payload.id,
    runId: payload.runId
  };
}

function isLiveRunStage(stage: string): stage is LiveRunStageId {
  return [
    "intake",
    "material_reader",
    "web_research",
    "evidence_agent",
    "report_composer",
    "quality_gate"
  ].includes(stage);
}

function stageFallbackTitle(stage: LiveRunStageId) {
  return liveStageConfig.find((item) => item.id === stage)?.title || "执行中";
}

function resumeStatusTitle(run: ResumedRunState) {
  if (run.status === "completed") return "上次分析已完成";
  if (run.status === "failed") return "上次分析失败";
  if (run.summary?.isStale) return "上次分析可能中断";
  return "上次分析仍在运行";
}

function runStageLabel(stage: string) {
  return stageFallbackTitle(stage as LiveRunStageId);
}

function formatRunTime(value: string) {
  if (!value) return "未知时间";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(value));
  } catch {
    return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  }
}

function LiveReasoningPanel({
  hasMaterials,
  isSubmitting,
  events
}: {
  hasMaterials: boolean;
  isSubmitting: boolean;
  events: LiveRunEvent[];
}) {
  const reversedEvents = [...events].reverse();
  const completedEvent = reversedEvents.find(
    (event) => event.type === "complete" || (event.stage === "quality_gate" && event.status === "completed")
  );
  const latestEvent =
    completedEvent ??
    reversedEvents.find((event) => event.status === "failed" || event.status === "running") ??
    events.at(-1);
  const hasStarted = events.length > 0;
  const recentEvents = events.slice(-5);
  const phaseStates = livePhaseConfig.map((phase) => ({
    ...phase,
    status: phaseStatus(phase.id, events, latestEvent, hasStarted, hasMaterials)
  }));
  const currentPhase = visiblePhase(latestEvent, hasMaterials, isSubmitting);
  const statusText = visibleRunSummary(latestEvent);

  return (
    <section className={`live-harness compact ${isSubmitting ? "active" : ""}`} aria-label="Agent 工作过程">
      <div className="live-harness-header">
        <div>
          <span>Agent 正在做什么</span>
          <strong>{currentPhase.title}</strong>
        </div>
        <small>{currentPhase.hint}</small>
      </div>
      <div className="live-current">
        <CircleDashed className={isSubmitting ? "spin" : ""} size={16} />
        <p>{statusText}</p>
      </div>
      <details className="live-details">
        <summary>过程细节</summary>
        <div className="live-stage-list">
          {phaseStates.map((step, index) => {
            const Icon = step.icon;
            return (
              <div className={`live-stage ${step.status}`} key={step.id}>
                <span>{step.status === "completed" ? <CheckCircle2 size={13} /> : index + 1}</span>
                <Icon size={16} />
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </div>
              </div>
            );
          })}
        </div>
        {recentEvents.length ? (
          <div className="live-event-feed" aria-label="最近动作">
            {recentEvents.map((event, index) => (
              <div className={`live-event ${event.status}`} key={`${index}-${event.stage}-${event.status}-${event.at || "no-time"}`}>
                <strong>{visibleEventTitle(event)}</strong>
                <p>{visibleEventSummary(event)}</p>
              </div>
            ))}
          </div>
        ) : null}
      </details>
    </section>
  );
}

function visibleRunSummary(event: LiveRunEvent | undefined) {
  if (!event) {
    return "我会先读产品介绍，再查证据并给出判断。";
  }
  if (event.stage === "quality_gate" && event.status === "completed") {
    return "判断已完成，你可以继续补充信息，或打开完整记录看细节。";
  }
  if (event.stage === "intake") return "我已收到产品介绍，先快速浏览。";
  if (event.stage === "material_reader" && event.status === "failed") {
    return "信息还不够，我会先问你补齐关键内容。";
  }
  if (event.stage === "material_reader") return "我正在读产品、用户、场景和明显缺口。";
  if (event.stage === "web_research") return "我正在查市场、替代方案和反证。";
  if (event.stage === "evidence_agent") return "我正在整理支持、反对和不确定信号。";
  if (event.stage === "report_composer") return "我正在写判断和下一步验证建议。";
  if (event.stage === "quality_gate") return "我正在检查结论有没有说过头。";
  return event.summary || "我正在处理。";
}

function visibleEventTitle(event: LiveRunEvent) {
  if (event.stage === "intake") return "收到介绍";
  if (event.stage === "material_reader") {
    if (event.status === "failed") return "需要补问";
    if (event.status === "completed") return "读完介绍";
    return "正在读";
  }
  if (event.stage === "web_research") {
    return event.status === "completed" ? "查完外部信号" : "正在查";
  }
  if (event.stage === "evidence_agent") return "正在整理";
  if (event.stage === "report_composer") return "正在写判断";
  if (event.stage === "quality_gate") {
    if (event.status === "completed") return "判断完成";
    if (event.status === "failed") return "遇到问题";
    return "检查结论";
  }
  return event.title;
}

function visibleEventSummary(event: LiveRunEvent) {
  if (event.status === "failed" && event.detail) return event.detail;
  return visibleRunSummary(event);
}

function visiblePhase(
  event: LiveRunEvent | undefined,
  hasMaterials: boolean,
  isSubmitting: boolean
) {
  if (event?.status === "failed") {
    return {
      title: event.stage === "material_reader" ? "需要你补一句" : "遇到问题",
      hint: "等待处理"
    };
  }
  if (event?.stage === "quality_gate" && event.status === "completed") {
    return {
      title: "判断完成",
      hint: "可以继续追问"
    };
  }
  const phase = event ? livePhaseConfig.find((item) => item.id === phaseIdForStage(event.stage)) : null;
  if (phase) {
    return {
      title: phase.runningTitle,
      hint: isSubmitting ? "正在推进" : "过程可见"
    };
  }
  return {
    title: isSubmitting ? "准备开始" : hasMaterials ? "准备好了" : "等待产品介绍",
    hint: hasMaterials ? "过程可见" : "还没有开始"
  };
}

function phaseStatus(
  phaseId: LiveRunPhaseId,
  events: LiveRunEvent[],
  latestEvent: LiveRunEvent | undefined,
  hasStarted: boolean,
  hasMaterials: boolean
) {
  const phaseEvents = events.filter((event) => phaseIdForStage(event.stage) === phaseId);
  if (phaseEvents.some((event) => event.status === "failed")) return "failed";
  if (latestEvent && phaseIdForStage(latestEvent.stage) === phaseId && latestEvent.status === "running") {
    return "running";
  }
  if (isPhaseCompleted(phaseId, events)) return "completed";
  if (!hasStarted && hasMaterials && phaseId === "read") return "ready";
  return "waiting";
}

function isPhaseCompleted(phaseId: LiveRunPhaseId, events: LiveRunEvent[]) {
  const completed = events.some(
    (event) => phaseIdForStage(event.stage) === phaseId && event.status === "completed"
  );
  if (completed) return true;

  const latestPhaseIndex = Math.max(
    -1,
    ...events.map((event) => livePhaseIndex(phaseIdForStage(event.stage)))
  );
  return latestPhaseIndex > livePhaseIndex(phaseId);
}

function livePhaseIndex(phaseId: LiveRunPhaseId) {
  return livePhaseConfig.findIndex((item) => item.id === phaseId);
}

function phaseIdForStage(stage: LiveRunStageId): LiveRunPhaseId {
  if (stage === "web_research") return "research";
  if (stage === "evidence_agent") return "organize";
  if (stage === "report_composer" || stage === "quality_gate") return "write";
  return "read";
}

const livePhaseConfig: Array<{
  id: LiveRunPhaseId;
  icon: typeof Paperclip;
  title: string;
  runningTitle: string;
  body: string;
}> = [
  {
    id: "read",
    icon: Paperclip,
    title: "读",
    runningTitle: "正在读",
    body: "读产品介绍，估计哪些信息会影响准确度。"
  },
  {
    id: "research",
    icon: Search,
    title: "查",
    runningTitle: "正在查",
    body: "查竞品、替代方案、真实痛点和反证。"
  },
  {
    id: "organize",
    icon: ListChecks,
    title: "整理",
    runningTitle: "正在整理",
    body: "把支持、反对和不确定信号分开。"
  },
  {
    id: "write",
    icon: Wand2,
    title: "写判断",
    runningTitle: "正在写判断",
    body: "形成结论、风险和下一步验证。"
  }
];

const liveStageConfig: Array<{
  id: LiveRunStageId;
  icon: typeof Paperclip;
  title: string;
  body: string;
}> = [
  {
    id: "intake",
    icon: Paperclip,
    title: "收到产品介绍",
    body: "先确认我能读懂你给的信息。"
  },
  {
    id: "material_reader",
    icon: FileImage,
    title: "快速浏览",
    body: "理解产品、用户、场景和当前缺口。"
  },
  {
    id: "web_research",
    icon: Search,
    title: "外部调研",
    body: "搜索竞品、替代方案、痛点和反证。"
  },
  {
    id: "evidence_agent",
    icon: ListChecks,
    title: "整理证据",
    body: "区分支持、反对和不确定信号。"
  },
  {
    id: "report_composer",
    icon: Wand2,
    title: "形成判断",
    body: "给出是否继续、为什么和下一步。"
  },
  {
    id: "quality_gate",
    icon: TrendingUp,
    title: "检查结论",
    body: "避免把证据不足的地方说得太满。"
  }
];

async function extractImageMetrics(file: File): Promise<ImageMetrics> {
  const image = await loadImage(file);
  const canvas = document.createElement("canvas");
  const maxSide = 160;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法读取图片。");

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let brightnessSum = 0;
  let saturationSum = 0;
  let contrastSum = 0;
  let edgeCount = 0;
  const buckets = new Map<string, number>();
  const brightnessValues: number[] = [];

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
    const saturation = getSaturation(r, g, b);
    const color = quantizeColor(r, g, b);
    brightnessSum += brightness;
    saturationSum += saturation;
    brightnessValues.push(brightness);
    buckets.set(color, (buckets.get(color) ?? 0) + 1);

    const pixelIndex = i / 4;
    const x = pixelIndex % canvas.width;
    const y = Math.floor(pixelIndex / canvas.width);
    if (x > 0 && y > 0) {
      const leftIndex = i - 4;
      const upIndex = i - canvas.width * 4;
      const diff =
        Math.abs(r - data[leftIndex]) +
        Math.abs(g - data[leftIndex + 1]) +
        Math.abs(b - data[leftIndex + 2]) +
        Math.abs(r - data[upIndex]) +
        Math.abs(g - data[upIndex + 1]) +
        Math.abs(b - data[upIndex + 2]);
      if (diff > 120) edgeCount += 1;
    }
  }

  const pixelCount = data.length / 4;
  const averageBrightness = brightnessSum / pixelCount;
  for (const value of brightnessValues) {
    contrastSum += Math.abs(value - averageBrightness);
  }

  return {
    width: image.width,
    height: image.height,
    aspectRatio: Number((image.width / image.height).toFixed(2)),
    brightness: Number(averageBrightness.toFixed(2)),
    contrast: Number((contrastSum / pixelCount).toFixed(2)),
    saturation: Number((saturationSum / pixelCount).toFixed(2)),
    edgeDensity: Number((edgeCount / pixelCount).toFixed(4)),
    dominantColors: [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([color]) => color),
    colorCount: buckets.size
  };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败。"));
    image.src = URL.createObjectURL(file);
  });
}

function getSaturation(r: number, g: number, b: number) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === 0) return 0;
  return Number(((max - min) / max).toFixed(3));
}

function quantizeColor(r: number, g: number, b: number) {
  const step = 32;
  const qr = Math.min(255, Math.round(r / step) * step);
  const qg = Math.min(255, Math.round(g / step) * step);
  const qb = Math.min(255, Math.round(b / step) * step);
  return `#${toHex(qr)}${toHex(qg)}${toHex(qb)}`;
}

function toHex(value: number) {
  return value.toString(16).padStart(2, "0");
}
