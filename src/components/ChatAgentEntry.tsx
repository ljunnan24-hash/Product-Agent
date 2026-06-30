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
  const [isRestoringRun, setIsRestoringRun] = useState(false);
  const [isLoadingExample, setIsLoadingExample] = useState(false);

  const primaryMetrics = materials[0]?.metrics ?? null;
  const isAwaitingSupplement = Boolean(
    followUpPrompt && (submittedBrief || submittedMaterialNames.length)
  );
  const composerPlaceholder = isAwaitingSupplement
    ? "补充目标用户、痛点或核心功能。"
    : "粘贴产品介绍，或补充一句你想判断的问题。";
  const followUpDisplay = simplifyFollowUpPrompt(followUpPrompt);

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
      setError("先补充一点目标用户、痛点或核心功能。");
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
    await startAnalysis(body);
  }

  async function startAnalysis(body: FormData) {
    setIsSubmitting(true);
    setResumedRun(null);
    setRunEvents([
      {
        stage: "intake",
        status: "running",
          title: "准备开始",
          summary: "产品介绍已收到。"
      }
    ]);

    try {
      const analysisId = await runStreamingAnalysis(body, (event) => {
        setRunEvents((current) => [...current, event].slice(-24));
      });

      router.push(`/analysis/${analysisId}`);
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
        <h1>上传产品介绍</h1>
        <p>我来判断这个产品有没有潜力。</p>
      </section>

      <form className="chat-console conversation-console" onSubmit={onSubmit}>
        <div className="chat-history conversation-thread" aria-label="Product Agent conversation">
          <Message role="agent">
            <strong>把产品介绍发给我。</strong>
            <p>直接粘贴一段介绍，也可以上传材料。</p>
            <div className="demo-example-action">
              <button
                type="button"
                onClick={loadDemoExample}
                disabled={isLoadingExample}
                aria-label="载入示例产品介绍"
              >
                {isLoadingExample ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
                载入示例
              </button>
            </div>
          </Message>
          {submittedBrief || submittedMaterialNames.length > 0 ? (
            <Message role="user">
              <strong>
                {submittedMaterialNames.length
                  ? `已上传 ${submittedMaterialNames.length} 份产品介绍。`
                  : "我想分析这个产品。"}
              </strong>
              {submittedBrief ? <p>{submittedBrief}</p> : <p>请判断产品潜力。</p>}
              {submittedMaterialNames.length ? (
                <div className="user-material-list">
                  {submittedMaterialNames.map((name, index) => (
                    <span key={`${name}-${index}`}>{name}</span>
                  ))}
                </div>
              ) : null}
            </Message>
          ) : null}
          {submittedBrief || submittedMaterialNames.length > 0 ? (
            <Message role="agent">
              {followUpPrompt ? (
                <div className="agent-follow-up">
                  <strong>我先看了一遍，还需要一点信息。</strong>
                  <p>{followUpDisplay}</p>
                </div>
              ) : (
                <p>收到。我会先读产品介绍，再查证据，最后给潜力判断和下一步。</p>
              )}
              <LiveReasoningPanel
                hasMaterials={Boolean(submittedBrief || submittedMaterialNames.length)}
                isSubmitting={isSubmitting}
                hasTextMaterial={
                  Boolean(submittedBrief) || materials.some((material) => isTextFile(material.file))
                }
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
                        打开报告
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
                  hasTextMaterial
                  events={runEvents}
                />
              </div>
            </Message>
          ) : null}
        </div>

        <div className="composer-box">
          {isAwaitingSupplement ? (
            <p className="composer-follow-up-hint">
              补充内容会和上一轮产品介绍一起分析。
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
              上传产品介绍
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

function mergeIntakeBrief(previousBrief: string, supplement: string) {
  const previous = previousBrief.trim();
  const next = supplement.trim();
  if (!previous) return next;
  if (!next) return previous;
  return `${previous}\n\n补充：${next}`;
}

function simplifyFollowUpPrompt(prompt: string) {
  const text = prompt.replace(/\s+/g, " ").trim();
  const supplement = text.match(/请补充[:：]\s*([^。]+)。?/);
  if (supplement?.[1]) {
    return `请补充：${supplement[1]}。`;
  }
  return text;
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
  if (file.type === "application/pdf") return "PDF";
  if (name.endsWith(".md") || name.endsWith(".mdx") || name === "readme") {
    return "MD";
  }
  if (isTextFile(file)) return "TXT";
  return "IMG";
}

function Message({ role, children }: { role: "agent" | "user"; children: React.ReactNode }) {
  return (
    <div className={`chat-message ${role}`}>
      <span className="message-avatar">{role === "agent" ? "A" : "你"}</span>
      <div className="message-bubble">{children}</div>
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

  if (!analysisId) throw new Error("分析已结束，但没有返回报告 ID。");
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
      title: "分析完成",
      summary: "报告已生成，可以打开查看。",
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
      title: "分析完成",
      summary: "报告已生成，可以打开查看。",
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
  hasTextMaterial,
  events
}: {
  hasMaterials: boolean;
  isSubmitting: boolean;
  hasTextMaterial: boolean;
  events: LiveRunEvent[];
}) {
  const latestByStage = new Map<LiveRunStageId, LiveRunEvent>();
  for (const event of events) latestByStage.set(event.stage, event);
  const latestEvent =
    [...events].reverse().find((event) => event.status === "failed" || event.status === "running") ??
    events.at(-1);
  const hasStarted = events.length > 0;
  const recentEvents = events.slice(-5);
  const statusText = visibleRunSummary(latestEvent, hasTextMaterial);

  return (
    <section className={`live-harness compact ${isSubmitting ? "active" : ""}`} aria-label="分析状态">
      <div className="live-harness-header">
        <div>
          <span>分析状态</span>
          <strong>
            {latestEvent?.title ||
              (isSubmitting ? "启动中" : hasMaterials ? "准备好了" : "等待产品介绍")}
          </strong>
        </div>
        <small>{isSubmitting ? "正在处理" : "可查看过程"}</small>
      </div>
      <div className="live-current">
        <CircleDashed className={isSubmitting ? "spin" : ""} size={16} />
        <p>{statusText}</p>
      </div>
      <details className="live-details">
        <summary>查看过程</summary>
        <div className="live-stage-list">
          {liveStageConfig.map((step, index) => {
            const event = latestByStage.get(step.id);
            const status = event?.status ?? (hasStarted ? "waiting" : hasMaterials ? "ready" : "waiting");
            const Icon = step.icon;
            return (
              <div className={`live-stage ${status}`} key={step.id}>
                <span>{status === "completed" ? <CheckCircle2 size={13} /> : index + 1}</span>
                <Icon size={16} />
                <div>
                  <strong>{step.title}</strong>
                  <p>{event?.summary || step.body}</p>
                </div>
              </div>
            );
          })}
        </div>
        {recentEvents.length ? (
          <div className="live-event-feed" aria-label="实时事件">
            {recentEvents.map((event, index) => (
              <div className={`live-event ${event.status}`} key={`${event.stage}-${event.status}-${event.at || index}`}>
                <strong>{event.title}</strong>
                <p>{event.detail || event.summary}</p>
              </div>
            ))}
          </div>
        ) : null}
      </details>
    </section>
  );
}

function visibleRunSummary(event: LiveRunEvent | undefined, hasTextMaterial: boolean) {
  if (!event) {
    return hasTextMaterial ? "我会先读产品介绍，再查证据。" : "我会先读产品介绍，再查证据。";
  }
  if (event.stage === "intake") return "我已收到产品介绍。";
  if (event.stage === "material_reader" && event.status === "failed") {
    return "信息还不够，我会先问你补齐关键内容。";
  }
  if (event.stage === "material_reader") return "我正在先快速读一遍产品介绍。";
  if (event.stage === "web_research") return "材料够了，我正在查公开证据。";
  if (event.stage === "evidence_agent") return "我正在整理支持证据和风险。";
  if (event.stage === "report_composer") return "我正在写潜力判断。";
  if (event.stage === "quality_gate") return "我正在做最后检查。";
  return event.summary || "我正在处理。";
}

const liveStageConfig: Array<{
  id: LiveRunStageId;
  icon: typeof Paperclip;
  title: string;
  body: string;
}> = [
  {
    id: "intake",
    icon: Paperclip,
    title: "接收",
    body: "检查产品介绍是否可读取。"
  },
  {
    id: "material_reader",
    icon: FileImage,
    title: "读介绍",
    body: "理解产品、用户和当前问题。"
  },
  {
    id: "web_research",
    icon: Search,
    title: "查证据",
    body: "规划查询，搜索公开网页和反证。"
  },
  {
    id: "evidence_agent",
    icon: ListChecks,
    title: "建账本",
    body: "整理支持证据和风险。"
  },
  {
    id: "report_composer",
    icon: Wand2,
    title: "写报告",
    body: "基于证据账本生成潜力判断。"
  },
  {
    id: "quality_gate",
    icon: TrendingUp,
    title: "收尾",
    body: "保存记录并打开报告。"
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
