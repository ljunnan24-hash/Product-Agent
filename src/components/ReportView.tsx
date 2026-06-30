"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  Bot,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Gauge,
  Globe2,
  ListChecks,
  Loader2,
  Paperclip,
  RotateCcw,
  Search,
  TrendingUp,
  Wand2
} from "lucide-react";
import type {
  AgentTraceStep,
  AgentJudgeVerdict,
  AgentRunInterruptAction,
  AgentRuntimeResumeAction,
  AgentRunInterrupt,
  AgentRuntimeResumeRequest,
  AgentRuntimeTrace,
  AgentRuntimeSubagentId,
  AgentWorkerQueueItem,
  AgentStage,
  AgentToolGuardrailResult,
  AnalysisRecord,
  DurableWorkerQueueRecord,
  EvidenceBrief,
  EvidenceCard,
  EvidenceQueryExecution,
  EvidenceSearchIntent,
  EvidenceStopRule,
  WebEvidence,
  ProductDiagnosisReport,
  QualityResearchRunSummary,
  ReportEvidenceBinding,
  ReportRegenerationDraft,
  ReportRewriteDiffLine,
  ReportRewriteRevision
} from "@/lib/types";
import { AgentArtifactViewer } from "@/components/AgentArtifactViewer";
import { buildReportEvidenceBindings } from "@/lib/report-evidence-binding";
import { evaluateReportQuality, isCurrentReportQualityAudit } from "@/lib/report-quality";
import { getVariant } from "@/lib/variants";

type Props = {
  record: AnalysisRecord;
};

type WorkerQueueAction = "cancel" | "requeue" | "replay";
type WorkerQueuePatch = Partial<
  Pick<
    AgentWorkerQueueItem,
    | "status"
    | "outputSummary"
    | "errorMessage"
    | "completedAt"
    | "latencyMs"
    | "cancelRequestedAt"
    | "cancellationReason"
  >
>;

type WorkerDaemonStatusSnapshot = {
  generatedAt: string;
  staleMs: number;
  supportedTools?: Array<{
    toolId: string;
    label: string;
    replayScope: string;
    status: string;
  }>;
  launchd?: {
    platform: string;
    available: boolean;
    label: string;
    daemonId: string;
    plistPath: string;
    installed: boolean;
    loaded: boolean;
    domain?: string;
    pid?: number;
    state?: string;
    lastExitCode?: string;
    stdoutPath: string;
    stderrPath: string;
    summary: string;
  };
  health?: {
    status: "healthy" | "degraded" | "down" | "unknown";
    liveDaemonCount: number;
    staleDaemonCount: number;
    supervisedDaemonCount: number;
    lastHeartbeatAgeMs?: number;
    recentRestarts: number;
    recentFailures: number;
    launchdInstalled: boolean;
    launchdLoaded: boolean;
    messages: string[];
  };
  queueSla?: {
    scanned: number;
    generatedAt: string;
    counts: {
      queued: number;
      running: number;
      completed: number;
      failed: number;
      skipped: number;
      cancelled: number;
    };
    activeCount: number;
    terminalCount: number;
    queuedCount: number;
    runningCount: number;
    failedCount: number;
    expiredRunningCount: number;
    cancelRequestedCount: number;
    oldestQueuedAgeMs?: number;
    oldestRunningAgeMs?: number;
    byTool: Array<{
      toolId: string;
      count: number;
      queued: number;
      running: number;
      failed: number;
    }>;
    alerts: Array<{
      id: string;
      severity: "info" | "warning" | "critical";
      title: string;
      summary: string;
      recordIds?: string[];
    }>;
  };
  alertChannel?: {
    enabled: boolean;
    webhookEnabled: boolean;
    webhookUrlConfigured: boolean;
    cooldownMs: number;
    generatedAt: string;
    logPath: string;
    statePath: string;
    activeCount: number;
    emittedCount: number;
    suppressedCount: number;
    resolvedCount: number;
    lastEmittedAt?: string;
    lastWebhookAt?: string;
    lastWebhookError?: string;
    recentEvents: Array<{
      id: string;
      source: "health" | "queue_sla";
      severity: "info" | "warning" | "critical";
      title: string;
      summary: string;
      eventType: "emitted" | "suppressed" | "resolved";
      fingerprint: string;
      at: string;
      firstSeenAt: string;
      suppressedCount: number;
    }>;
  };
  daemons: Array<{
    heartbeat: {
      daemonId: string;
      status: string;
      mode?: string;
      version?: string;
      pid?: number;
      updatedAt: string;
      cycle?: number;
      lastResult?: {
        selected?: number;
        scannedQueued?: number;
        counts?: {
          applied?: number;
          blocked?: number;
          unsupported?: number;
          skipped?: number;
          errors?: number;
        };
        maintenance?: {
          scanned?: number;
          requeued?: number;
          cancelled?: number;
          failedExpired?: number;
          stillRunning?: number;
          recoveredRecords?: Array<{
            id: string;
            status: string;
            workerLabel?: string;
            attempt?: number;
            maxAttempts?: number;
            reason?: string;
          }>;
        };
      };
      error?: string;
    };
    stale: boolean;
    ageMs: number;
    supervisor?: {
      status: string;
      supervisorPid?: number;
      workerPid?: number;
      updatedAt: string;
      restarts?: number;
      maxRestarts?: number;
      nextRestartAt?: string;
      stopReason?: string;
      error?: string;
      lastExit?: {
        code?: number | null;
        signal?: string | null;
        at?: string;
      };
    };
    latestRuns: Array<{
      at: string;
      cycle?: number;
      result?: {
        selected?: number;
        scannedQueued?: number;
        counts?: {
          applied?: number;
          blocked?: number;
          unsupported?: number;
          skipped?: number;
          errors?: number;
        };
      };
    }>;
  }>;
};

type WorkerDaemonAction = "start" | "stop";

type ReportDraftRunEvent = {
  type?: "progress" | "complete" | "error";
  stage: string;
  status: "running" | "completed" | "failed" | "skipped";
  title: string;
  summary: string;
  message?: string;
  draftId?: string;
};

type QualityResearchRunEvent = ReportDraftRunEvent & {
  queryCount?: number;
  resultCount?: number;
  crawledCount?: number;
  confidenceBefore?: number;
  confidenceAfter?: number;
  qualityScore?: number;
};

export function ReportView({ record }: Props) {
  const report = normalizeReportForView(record.report as ProductDiagnosisReport);
  const variant = getVariant(record.productVariant);
  const references = report.references.map((item) => item.name).join(" + ");
  const trace = record.agentTrace ?? [];
  const primaryMaterial = record.materials?.[0];
  const isPdf = primaryMaterial?.type === "application/pdf";
  const isText = primaryMaterial ? isTextMaterial(primaryMaterial) : false;
  const scoreTone = useMemo(() => {
    if (report.diagnosis_score >= 78) return "strong";
    if (report.diagnosis_score >= 62) return "mid";
    return "low";
  }, [report.diagnosis_score]);
  const reportEvidenceBindings = useMemo(
    () =>
      record.reportEvidenceBindings?.length
        ? record.reportEvidenceBindings
        : record.evidenceBrief
          ? buildReportEvidenceBindings({
              report,
              evidenceBrief: record.evidenceBrief
            })
          : [],
    [record.evidenceBrief, record.reportEvidenceBindings, report]
  );
  const reportEvidenceCards = record.evidenceBrief?.evidenceCards ?? [];
  const evidenceBindingFor = (
    targetSection: ReportEvidenceBinding["targetSection"],
    targetIndex?: number
  ) =>
    reportEvidenceBindings.find((binding) =>
      binding.targetSection === targetSection &&
      (typeof targetIndex === "number" ? binding.targetIndex === targetIndex : true)
    );

  function downloadShareCard() {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 630;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#f5f1e8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#141414";
    ctx.fillRect(36, 36, canvas.width - 72, canvas.height - 72);

    ctx.fillStyle = "#f5f1e8";
    ctx.font = "34px Arial, sans-serif";
    ctx.fillText(variant.shareCardTitle, 78, 106);

    ctx.fillStyle = "#ff6f3c";
    ctx.font = "bold 118px Arial, sans-serif";
    ctx.fillText(String(report.diagnosis_score), 78, 235);

    ctx.fillStyle = "#f5f1e8";
    ctx.font = "28px Arial, sans-serif";
    ctx.fillText("/100", 230, 227);

    ctx.fillStyle = "#9fc5e8";
    ctx.font = "bold 32px Arial, sans-serif";
    wrapText(ctx, report.share_summary.current_style, 78, 308, 460, 38);

    ctx.fillStyle = "#f5f1e8";
    ctx.font = "30px Arial, sans-serif";
    wrapText(ctx, report.share_summary.one_line_diagnosis, 78, 390, 980, 42);

    ctx.fillStyle = "#c7e7b3";
    ctx.font = "24px Arial, sans-serif";
    wrapText(ctx, `参考对象：${references}`, 78, 540, 980, 32);

    ctx.fillStyle = "#f5f1e8";
    ctx.font = "22px Arial, sans-serif";
    ctx.fillText("product-agent.local", 884, 574);

    const url = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.download = `product-agent-${record.id}.png`;
    link.href = url;
    link.click();
  }

  return (
    <main className="report-shell">
      <header className="report-header">
        <Link className="brand" href="/">
          Product Agent
        </Link>
        <div className="topbar-actions">
          <Link className="secondary-link" href="/backtests">
            回测
          </Link>
          <Link className="secondary-link" href="/analyses">
            报告库
          </Link>
          <Link className="secondary-link" href={variant.path}>
            <RotateCcw size={16} />
            新建诊断
          </Link>
        </div>
      </header>

      <section className="report-grid">
        <aside className="snapshot-panel">
          {isPdf || isText ? (
            <div className="pdf-preview-panel">
              <strong>{isPdf ? "PDF" : materialLabel(primaryMaterial)}</strong>
              <span>{primaryMaterial?.name}</span>
              <p>{primaryMaterial?.textPreview || "材料文本已进入 Agent 上下文。"}</p>
            </div>
          ) : (
            <img src={record.imageUrl} alt="Uploaded work" />
          )}
          <div className="snapshot-meta">
            <span>{variant.navLabel}</span>
            <span>{record.workType.replaceAll("_", " ")}</span>
          </div>
          {isPdf ? (
            <div className="image-stats">
              <span>{primaryMaterial?.pageCount ?? 0} pages</span>
              <span>{Math.round((primaryMaterial?.size ?? 0) / 1024)} KB</span>
            </div>
          ) : isText ? (
            <div className="image-stats">
              <span>{materialLabel(primaryMaterial)} text</span>
              <span>{Math.round((primaryMaterial?.size ?? 0) / 1024)} KB</span>
              <span>{primaryMaterial?.extractedUrls?.length ?? 0} URLs</span>
            </div>
          ) : record.imageMetrics ? (
            <div className="image-stats">
              <span>
                {record.imageMetrics.width} x {record.imageMetrics.height}
              </span>
              <span>Brightness {Math.round(record.imageMetrics.brightness)}</span>
              <span>Contrast {Math.round(record.imageMetrics.contrast)}</span>
            </div>
          ) : null}
        </aside>

        <article className="report-content">
          <div className="score-row">
            <div className={`score-dial ${scoreTone}`}>
              <strong>{report.diagnosis_score}</strong>
              <span>/100</span>
            </div>
            <div>
              <p className="report-kicker">{report.share_summary.current_style}</p>
              <h1>{report.share_summary.one_line_diagnosis}</h1>
            </div>
          </div>

          <p className="first-impression">{report.first_impression}</p>

          <section className="potential-panel">
            <div>
              <span>产品潜力</span>
              <strong>{report.potential_score}</strong>
            </div>
            <p>{report.potential_verdict}</p>
            <ReportEvidenceBindingCard
              binding={evidenceBindingFor("potential_verdict")}
              evidenceCards={reportEvidenceCards}
            />
          </section>

          <div className="tag-row">
            {report.diagnosis_tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>

          <section className="report-section">
            <h2>市场证据</h2>
            <div className="evidence-list">
              {report.market_evidence.map((item, index) => (
                <div className="evidence-item" key={item.signal}>
                  <h3>{item.signal}</h3>
                  <p>{item.evidence}</p>
                  <strong>{item.interpretation}</strong>
                  <ReportEvidenceBindingCard
                    binding={evidenceBindingFor("market_evidence", index)}
                    evidenceCards={reportEvidenceCards}
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="report-section">
            <h2>最大问题</h2>
            <div className="issue-list">
              {report.top_issues.map((issue, index) => (
                <div className="issue-item" key={issue.title}>
                  <span>{index + 1}</span>
                  <div>
                    <h3>{issue.title}</h3>
                    <p>{issue.why_it_matters}</p>
                    <strong>{issue.how_to_fix}</strong>
                    <ReportEvidenceBindingCard
                      binding={evidenceBindingFor("top_issues", index)}
                      evidenceCards={reportEvidenceCards}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="report-section">
            <h2>推荐参考</h2>
            <div className="reference-grid">
              {report.references.map((reference) => (
                <div className="reference-card" key={reference.name}>
                  <div>
                    <h3>{reference.name}</h3>
                    <span>{reference.category}</span>
                  </div>
                  <p>{reference.why_relevant}</p>
                  <strong>{reference.what_to_learn}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="report-section">
            <h2>下一步行动</h2>
            <ul className="suggestion-list">
              {report.actionable_suggestions.map((suggestion, index) => (
                <li key={suggestion}>
                  <span>{suggestion}</span>
                  <ReportEvidenceBindingCard
                    binding={evidenceBindingFor("actionable_suggestions", index)}
                    evidenceCards={reportEvidenceCards}
                  />
                </li>
              ))}
            </ul>
          </section>

          {report.limitations.length > 0 ? (
            <section className="report-section muted-section">
              <h2>诊断边界</h2>
              <ul>
                {report.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
            </ul>
          </section>
        ) : null}

          <div className="share-panel">
            <div>
              <p>分享卡片</p>
              <strong>
                {report.share_summary.current_style} · {references}
              </strong>
            </div>
            <button onClick={downloadShareCard}>
              <Download size={18} />
              下载 PNG
            </button>
          </div>

          <a className="deep-review" href={`mailto:?subject=Product Agent deep review&body=Analysis ${record.id}`}>
            <ExternalLink size={16} />
            申请更深入的人工产品诊断
          </a>
        </article>

        <HarnessPanel record={record} report={report} trace={trace} />
      </section>
    </main>
  );
}

function HarnessPanel({
  record,
  report,
  trace
}: {
  record: AnalysisRecord;
  report: ProductDiagnosisReport;
  trace: AgentTraceStep[];
}) {
  const router = useRouter();
  const visibleTrace = trace.length ? trace : fallbackTrace();
  const webResearch = record.webResearch;
  const evidenceBrief = record.evidenceBrief;
  const [experimentError, setExperimentError] = useState("");
  const [isSavingExperiment, setIsSavingExperiment] = useState(false);
  const [rewriteError, setRewriteError] = useState("");
  const [applyingIssueId, setApplyingIssueId] = useState<string | null>(null);
  const [researchingIssueId, setResearchingIssueId] = useState<string | null>(null);
  const [qualityResearchIssueId, setQualityResearchIssueId] = useState<string | null>(null);
  const [qualityResearchEvents, setQualityResearchEvents] = useState<QualityResearchRunEvent[]>([]);
  const [queueingBacktestIssueId, setQueueingBacktestIssueId] = useState<string | null>(null);
  const [rollingBackRevisionId, setRollingBackRevisionId] = useState<string | null>(null);
  const evidenceCards = evidenceBrief?.evidenceCards ?? [
    ...(evidenceBrief?.strongestSupport ?? []),
    ...(evidenceBrief?.strongestOpposition ?? [])
  ];
  const sourceBudgets = evidenceBrief?.sourceBudgets ?? [];
  const reportQualityAudit = useMemo(
    () => {
      const savedAuditHasDrafts =
        record.reportQualityAudit?.issues?.length &&
        record.reportQualityAudit.issues.some((issue) => issue.repairDraft);
      if (
        record.reportQualityAudit &&
        isCurrentReportQualityAudit(record.reportQualityAudit) &&
        (!record.reportQualityAudit.issues.length || savedAuditHasDrafts)
      ) {
        return record.reportQualityAudit;
      }

      return evaluateReportQuality({
        report,
        evidenceBrief,
        webResearch,
        materials: record.materials ?? [],
        calibrationContext: record.calibrationContext
      });
    },
    [evidenceBrief, record.materials, record.reportQualityAudit, report, webResearch]
  );
  const followUpInputRef = useRef<HTMLInputElement | null>(null);
  const [followUpMessage, setFollowUpMessage] = useState("");
  const [followUpFiles, setFollowUpFiles] = useState<File[]>([]);
  const [followUpError, setFollowUpError] = useState("");
  const [isSendingFollowUp, setIsSendingFollowUp] = useState(false);
  const [recomputingFollowUpId, setRecomputingFollowUpId] = useState<string | null>(null);
  const [isGeneratingReportDraft, setIsGeneratingReportDraft] = useState(false);
  const [applyingReportDraftId, setApplyingReportDraftId] = useState<string | null>(null);
  const [reportDraftEvents, setReportDraftEvents] = useState<ReportDraftRunEvent[]>([]);
  const queryExecutionById = new Map(
    webResearch?.queryExecutions?.map((execution) => [execution.queryId, execution]) ?? []
  );
  const materialCount = record.materials?.length ?? 0;
  const webEvidenceCount =
    (webResearch?.crawled.length ?? 0) + (webResearch?.searchResults.length ?? 0);
  const signalNames = report.market_evidence
    .slice(0, 3)
    .map((item) => item.signal)
    .join(" / ");
  const experimentArtifacts = evidenceBrief?.recommendedExperiment.result?.rawEvidenceArtifacts ?? [];
  const ocrArtifactCount = experimentArtifacts.filter(
    (artifact) => artifact.extractionMethod === "ocr"
  ).length;
  const ocrConfidenceValues = experimentArtifacts
    .map((artifact) => normalizedOcrConfidence(artifact.ocrConfidence))
    .filter((value) => value > 0);
  const ocrAverageConfidence = ocrConfidenceValues.length
    ? Math.round(
        (ocrConfidenceValues.reduce((sum, value) => sum + value, 0) /
          ocrConfidenceValues.length) *
          100
      )
    : 0;
  const activeReportDrafts = record.reportRegenerationDrafts?.slice(0, 3) ?? [];
  const canGenerateReportDraft = Boolean(
    record.followUps?.some((turn) => turn.evidenceAppliedAt)
  );
  const evidenceVisibility = webResearch ? buildEvidenceVisibility(webResearch) : null;
  const runtimeTrace = webResearch?.runtimeTrace;
  const [runtimeResumeRequests, setRuntimeResumeRequests] = useState<AgentRuntimeResumeRequest[]>(
    runtimeTrace?.resumeRequests ?? []
  );
  const [runtimeResumePendingId, setRuntimeResumePendingId] = useState<string | null>(null);
  const [runtimeResumeError, setRuntimeResumeError] = useState("");
  const [runtimeInterrupts, setRuntimeInterrupts] = useState<AgentRunInterrupt[]>(
    runtimeTrace?.interrupts ?? []
  );
  const [runtimeInterruptPendingId, setRuntimeInterruptPendingId] = useState<string | null>(null);
  const [runtimeInterruptError, setRuntimeInterruptError] = useState("");
  const [workerQueuePatches, setWorkerQueuePatches] = useState<Record<string, WorkerQueuePatch>>({});
  const [workerQueuePendingId, setWorkerQueuePendingId] = useState<string | null>(null);
  const [workerQueueError, setWorkerQueueError] = useState("");
  const [workerDaemonStatus, setWorkerDaemonStatus] = useState<WorkerDaemonStatusSnapshot | null>(null);
  const [workerDaemonPending, setWorkerDaemonPending] = useState(false);
  const [workerDaemonError, setWorkerDaemonError] = useState("");
  const judgeVerdict = webResearch?.judgeVerdict;
  const latestQualityResearchByIssue = useMemo(() => {
    const byIssue = new Map<string, QualityResearchRunSummary>();
    for (const run of record.qualityResearchRuns ?? []) {
      const existing = byIssue.get(run.issueId);
      if (!existing || new Date(run.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
        byIssue.set(run.issueId, run);
      }
    }
    return byIssue;
  }, [record.qualityResearchRuns]);
  const visibleQualityIssueIds = new Set(reportQualityAudit.issues.slice(0, 3).map((issue) => issue.id));
  const unmatchedQualityResearchRuns = (record.qualityResearchRuns ?? [])
    .filter((run) => !visibleQualityIssueIds.has(run.issueId))
    .slice(0, 3);

  useEffect(() => {
    setRuntimeResumeRequests(runtimeTrace?.resumeRequests ?? []);
    setRuntimeInterrupts(runtimeTrace?.interrupts ?? []);
    setWorkerQueuePatches({});
  }, [runtimeTrace?.id, runtimeTrace?.updatedAt]);

  useEffect(() => {
    if (!runtimeTrace?.id) return;
    void loadWorkerDaemonStatus({ silent: true });
  }, [runtimeTrace?.id]);

  async function submitRuntimeResume(targetId: string, action: AgentRuntimeResumeAction) {
    setRuntimeResumeError("");
    setRuntimeResumePendingId(`${targetId}:${action}`);
    try {
      const response = await fetch(`/api/analyses/${record.id}/runtime-resume`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ targetId, action })
      });
      const payload = (await response.json()) as {
        request?: AgentRuntimeResumeRequest;
        requests?: AgentRuntimeResumeRequest[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Runtime resume failed");
      }
      setRuntimeResumeRequests(payload.requests ?? (payload.request ? [payload.request] : []));
      if (payload.request?.executionMode === "auto_replay") {
        router.refresh();
      }
    } catch (error) {
      setRuntimeResumeError(error instanceof Error ? error.message : "Runtime resume failed");
    } finally {
      setRuntimeResumePendingId(null);
    }
  }

  async function submitRuntimeInterrupt(interruptId: string, action: AgentRunInterruptAction) {
    setRuntimeInterruptError("");
    setRuntimeInterruptPendingId(`${interruptId}:${action}`);
    try {
      const response = await fetch(`/api/analyses/${record.id}/runtime-interrupts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ interruptId, action })
      });
      const payload = (await response.json()) as {
        interrupt?: AgentRunInterrupt;
        interrupts?: AgentRunInterrupt[];
        resumeRequests?: AgentRuntimeResumeRequest[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Runtime interrupt failed");
      }
      setRuntimeInterrupts(payload.interrupts ?? (payload.interrupt ? [payload.interrupt] : []));
      if (payload.resumeRequests) {
        setRuntimeResumeRequests(payload.resumeRequests);
      }
      router.refresh();
    } catch (error) {
      setRuntimeInterruptError(error instanceof Error ? error.message : "Runtime interrupt failed");
    } finally {
      setRuntimeInterruptPendingId(null);
    }
  }

  async function submitWorkerQueueAction(item: AgentWorkerQueueItem, action: WorkerQueueAction) {
    const durableQueueId = item.durableQueueId;
    if (!durableQueueId) {
      setWorkerQueueError("这个 worker 没有关联 durable queue record，不能直接操作。");
      return;
    }
    setWorkerQueueError("");
    setWorkerQueuePendingId(`${durableQueueId}:${action}`);
    try {
      const response = await fetch("/api/worker-queue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id: durableQueueId,
          action,
          reason: workerQueueActionReason(action)
        })
      });
      const payload = (await response.json()) as {
        record?: DurableWorkerQueueRecord;
        result?: {
          record?: DurableWorkerQueueRecord;
          status?: string;
          summary?: string;
        };
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Worker queue action failed");
      }
      const updatedRecord = payload.record ?? payload.result?.record;
      const outputSummary =
        updatedRecord?.outputSummary ??
        payload.result?.summary ??
        workerQueueActionOptimisticSummary(action);
      setWorkerQueuePatches((current) => ({
        ...current,
        [durableQueueId]: {
          status: updatedRecord?.status ?? optimisticWorkerQueueStatus(action),
          outputSummary,
          errorMessage:
            updatedRecord?.errorMessage ??
            updatedRecord?.cancellationReason ??
            (action === "cancel" ? "已请求取消。" : undefined),
          completedAt: updatedRecord?.completedAt,
          latencyMs: updatedRecord?.latencyMs,
          cancelRequestedAt: updatedRecord?.cancelRequestedAt,
          cancellationReason: updatedRecord?.cancellationReason
        }
      }));
      router.refresh();
    } catch (error) {
      setWorkerQueueError(error instanceof Error ? error.message : "Worker queue action failed");
    } finally {
      setWorkerQueuePendingId(null);
    }
  }

  async function loadWorkerDaemonStatus(options: { silent?: boolean } = {}) {
    if (!options.silent) setWorkerDaemonPending(true);
    setWorkerDaemonError("");
    try {
      const response = await fetch("/api/worker-daemon?limit=6&runLimit=2&queueLimit=500", {
        cache: "no-store"
      });
      const payload = (await response.json()) as WorkerDaemonStatusSnapshot & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Worker daemon status failed");
      }
      setWorkerDaemonStatus(payload);
    } catch (error) {
      setWorkerDaemonError(error instanceof Error ? error.message : "Worker daemon status failed");
    } finally {
      if (!options.silent) setWorkerDaemonPending(false);
    }
  }

  async function submitWorkerDaemonDrain() {
    setWorkerDaemonPending(true);
    setWorkerDaemonError("");
    try {
      const response = await fetch("/api/worker-queue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action: "drain",
          traceId: runtimeTrace?.id,
          limit: 5,
          scanLimit: 80,
          concurrency: 2
        })
      });
      const payload = (await response.json()) as { result?: unknown; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Worker drain failed");
      }
      await loadWorkerDaemonStatus({ silent: true });
      router.refresh();
    } catch (error) {
      setWorkerDaemonError(error instanceof Error ? error.message : "Worker drain failed");
    } finally {
      setWorkerDaemonPending(false);
    }
  }

  async function submitWorkerDaemonAction(action: WorkerDaemonAction, daemonId?: string) {
    setWorkerDaemonPending(true);
    setWorkerDaemonError("");
    try {
      const response = await fetch("/api/worker-daemon", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action,
          daemonId,
          intervalMs: 5000,
          limit: 10,
          scanLimit: 200,
          concurrency: 2,
          restartBackoffMs: 1500,
          maxRestarts: 50
        })
      });
      const payload = (await response.json()) as { result?: { summary?: string }; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `Worker daemon ${action} failed`);
      }
      await new Promise((resolve) => window.setTimeout(resolve, action === "start" ? 700 : 400));
      await loadWorkerDaemonStatus({ silent: true });
    } catch (error) {
      setWorkerDaemonError(error instanceof Error ? error.message : `Worker daemon ${action} failed`);
    } finally {
      setWorkerDaemonPending(false);
    }
  }

  async function submitExperimentResult(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setExperimentError("");
    setIsSavingExperiment(true);

    const formData = new FormData(event.currentTarget);

    try {
      const response = await fetch(`/api/analyses/${record.id}/experiment-result`, {
        method: "POST",
        body: formData
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error || "实验结果保存失败");
      }
      window.location.reload();
    } catch (error) {
      setExperimentError(error instanceof Error ? error.message : "实验结果保存失败");
    } finally {
      setIsSavingExperiment(false);
    }
  }

  async function applyRepairDraft(issueId: string) {
    setRewriteError("");
    setApplyingIssueId(issueId);

    try {
      const response = await fetch(`/api/analyses/${record.id}/report-rewrite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ issueId })
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error || "报告修订失败");
      }
      window.location.reload();
    } catch (error) {
      setRewriteError(error instanceof Error ? error.message : "报告修订失败");
    } finally {
      setApplyingIssueId(null);
    }
  }

  async function runQualityResearch(issueId: string) {
    setRewriteError("");
    setResearchingIssueId(issueId);
    setQualityResearchIssueId(issueId);
    setQualityResearchEvents([
      {
        stage: "prepare",
        status: "running",
        title: "启动质检补证",
        summary: "正在建立补证任务。"
      }
    ]);

    try {
      await runQualityResearchStream(
        `/api/analyses/${record.id}/quality-research/stream`,
        issueId,
        (event) => {
          setQualityResearchEvents((current) => [...current, event].slice(-14));
        }
      );
      await delay(300);
      window.location.reload();
    } catch (error) {
      setRewriteError(error instanceof Error ? error.message : "质检补证失败");
      const failedEvent: QualityResearchRunEvent = {
        stage: "quality_gate",
        status: "failed",
        title: "补证失败",
        summary: error instanceof Error ? error.message : "质检补证失败"
      };
      setQualityResearchEvents((current) => [...current, failedEvent].slice(-14));
    } finally {
      setResearchingIssueId(null);
    }
  }

  async function sendBacktestSuggestions(issueId: string) {
    setRewriteError("");
    setQueueingBacktestIssueId(issueId);

    try {
      const response = await fetch("/api/backtest-suggestions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ analysisId: record.id, issueId })
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error || "发送 README 回测建议失败");
      }
      window.location.href = "/backtests";
    } catch (error) {
      setRewriteError(error instanceof Error ? error.message : "发送 README 回测建议失败");
    } finally {
      setQueueingBacktestIssueId(null);
    }
  }

  async function rollbackRevision(revisionId: string) {
    setRewriteError("");
    setRollingBackRevisionId(revisionId);

    try {
      const response = await fetch(`/api/analyses/${record.id}/report-rewrite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action: "rollback", revisionId })
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error || "报告回滚失败");
      }
      window.location.reload();
    } catch (error) {
      setRewriteError(error instanceof Error ? error.message : "报告回滚失败");
    } finally {
      setRollingBackRevisionId(null);
    }
  }

  function addFollowUpFiles(fileList: FileList | null) {
    if (!fileList) return;
    setFollowUpError("");
    const incoming = [...fileList].slice(0, 6 - followUpFiles.length);
    const accepted: File[] = [];

    for (const file of incoming) {
      if (!isAllowedFollowUpFile(file)) {
        setFollowUpError("支持 README/MD、TXT、PDF、PNG、JPG、WebP。");
        continue;
      }

      if (file.size > 12 * 1024 * 1024) {
        setFollowUpError("单个材料请压缩到 12MB 以内。");
        continue;
      }

      accepted.push(file);
    }

    setFollowUpFiles((current) => [...current, ...accepted].slice(0, 6));
  }

  async function submitFollowUp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFollowUpError("");

    if (!followUpMessage.trim() && followUpFiles.length === 0) {
      setFollowUpError("请输入追问，或上传补充材料。");
      return;
    }

    const formData = new FormData();
    formData.append("message", followUpMessage);
    followUpFiles.forEach((file) => formData.append("materials", file));
    setIsSendingFollowUp(true);

    try {
      const response = await fetch(`/api/analyses/${record.id}/follow-up`, {
        method: "POST",
        body: formData
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error || "继续对话失败");
      }
      window.location.reload();
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : "继续对话失败");
    } finally {
      setIsSendingFollowUp(false);
    }
  }

  async function recomputeFollowUpEvidence(turnId: string) {
    setFollowUpError("");
    setRecomputingFollowUpId(turnId);

    try {
      const response = await fetch(`/api/analyses/${record.id}/follow-up/recompute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ turnId })
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error || "重算证据失败");
      }
      window.location.reload();
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : "重算证据失败");
    } finally {
      setRecomputingFollowUpId(null);
    }
  }

  async function generateReportDraft() {
    setFollowUpError("");
    setIsGeneratingReportDraft(true);
    setReportDraftEvents([
      {
        stage: "prepare",
        status: "running",
        title: "启动草案生成",
        summary: "正在建立任务。"
      }
    ]);

    try {
      await runReportDraftStream(
        `/api/analyses/${record.id}/follow-up/report-draft/stream`,
        (event) => {
          setReportDraftEvents((current) => [...current, event].slice(-10));
        }
      );
      window.location.reload();
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : "生成新版报告草案失败");
      const failedEvent: ReportDraftRunEvent = {
        stage: "save",
        status: "failed",
        title: "生成失败",
        summary: error instanceof Error ? error.message : "生成新版报告草案失败"
      };
      setReportDraftEvents((current) => [
        ...current,
        failedEvent
      ].slice(-10));
    } finally {
      setIsGeneratingReportDraft(false);
    }
  }

  async function applyReportDraft(draftId: string) {
    setFollowUpError("");
    setApplyingReportDraftId(draftId);

    try {
      const response = await fetch(`/api/analyses/${record.id}/follow-up/report-draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action: "apply", draftId })
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error || "应用新版报告失败");
      }
      window.location.reload();
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : "应用新版报告失败");
    } finally {
      setApplyingReportDraftId(null);
    }
  }

  return (
    <aside className="run-panel harness-panel" aria-label="Agent visible reasoning harness">
      <div className="agent-identity">
        <span>
          <Bot size={18} />
        </span>
        <div>
          <strong>可见思考过程</strong>
          <small>
            {record.model} ·{" "}
            {webResearch?.searchProvider ? `${searchProviderLabel(webResearch.searchProvider)}检索 · ` : ""}
            证据化推理
          </small>
        </div>
      </div>

      <div className="harness-summary">
        <div>
          <span>材料</span>
          <strong>{materialCount}</strong>
        </div>
        <div>
          <span>网页证据</span>
          <strong>{webEvidenceCount}</strong>
        </div>
        <div>
          <span>证据置信</span>
          <strong>{evidenceBrief?.confidenceScore ?? report.potential_score}</strong>
        </div>
      </div>

      <section className="harness-section follow-up-section">
        <h2>继续对话</h2>
        <div className="follow-up-thread">
          {(record.followUps ?? []).slice(-4).map((turn) => (
            <div className="follow-up-turn" key={turn.id}>
              <div className="follow-up-message user">
                <span>你</span>
                <p>{turn.userMessage}</p>
                {turn.materials.length ? (
                  <small>{turn.materials.map((material) => material.name).join(" · ")}</small>
                ) : null}
              </div>
              <div className="follow-up-message agent">
                <span>Agent</span>
                <p>{turn.response}</p>
                {turn.suggestedActions.length ? (
                  <ul>
                    {turn.suggestedActions.slice(0, 4).map((action) => (
                      <li key={action}>{action}</li>
                    ))}
                  </ul>
                ) : null}
                <details>
                  <summary>可见步骤</summary>
                  {turn.visibleSteps.map((step) => (
                    <em key={`${turn.id}-${step.title}`}>
                      {step.title} · {step.summary}
                    </em>
                  ))}
                  <small>{turn.evidenceRefs.join(" · ")}</small>
                </details>
                {turn.materials.length ? (
                  <div className="follow-up-evidence-action">
                    {turn.evidenceAppliedAt ? (
                      <span>
                        已纳入证据
                        {typeof turn.confidenceBefore === "number" &&
                        typeof turn.confidenceAfter === "number"
                          ? ` · 置信 ${turn.confidenceBefore} -> ${turn.confidenceAfter}`
                          : ""}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => recomputeFollowUpEvidence(turn.id)}
                        disabled={recomputingFollowUpId === turn.id}
                      >
                        {recomputingFollowUpId === turn.id ? "重算中" : "纳入证据重算"}
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <form className="follow-up-form" onSubmit={submitFollowUp}>
          {followUpFiles.length ? (
            <div className="follow-up-materials">
              {followUpFiles.map((file, index) => (
                <span key={`${file.name}-${index}`}>
                  <strong>{fileKindLabel(file)}</strong>
                  {file.name}
                  <button
                    aria-label={`移除 ${file.name}`}
                    type="button"
                    onClick={() =>
                      setFollowUpFiles((current) =>
                        current.filter((_, fileIndex) => fileIndex !== index)
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            value={followUpMessage}
            onChange={(event) => setFollowUpMessage(event.target.value)}
            placeholder="继续问，例如：如果只做一个验证实验，先做哪个？"
            rows={3}
          />
          <div className="follow-up-actions">
            <input
              ref={followUpInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,application/pdf,text/markdown,text/plain,.md,.mdx,.txt,README"
              onChange={(event) => addFollowUpFiles(event.target.files)}
            />
            <button
              type="button"
              onClick={() => followUpInputRef.current?.click()}
            >
              <Paperclip size={14} />
              补材料
            </button>
            <div />
            <button type="submit" disabled={isSendingFollowUp}>
              {isSendingFollowUp ? <Loader2 className="spin" size={15} /> : <ArrowUp size={15} />}
            </button>
          </div>
        </form>
        {canGenerateReportDraft ? (
          <div className="report-draft-actions">
            <button
              type="button"
              onClick={generateReportDraft}
              disabled={isGeneratingReportDraft}
            >
              {isGeneratingReportDraft ? "生成中" : "生成新版报告草案"}
            </button>
            <span>会先补查网页，再生成草案；确认后才覆盖当前报告。</span>
          </div>
        ) : null}
        {reportDraftEvents.length ? (
          <div className="report-draft-progress" aria-label="新版报告草案生成进度">
            {reportDraftEvents.map((event, index) => (
              <div className={`report-draft-progress-item ${event.status}`} key={`${event.stage}-${index}`}>
                <i />
                <div>
                  <strong>{event.title}</strong>
                  <p>{event.summary}</p>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {activeReportDrafts.length ? (
          <div className="report-draft-list">
            <strong>新版报告草案</strong>
            {activeReportDrafts.map((draft) => (
              <details
                className={`report-draft-card ${draft.appliedAt ? "applied" : ""}`}
                key={draft.id}
                open={!draft.appliedAt}
              >
                <summary>
                  <span>{draft.appliedAt ? "已应用" : "待确认"}</span>
                  <strong>{draft.title}</strong>
                  <em>{formatTimestamp(draft.createdAt)}</em>
                </summary>
                <p>{draft.summary}</p>
                <div className="report-draft-metrics">
                  <span>证据 {draft.confidenceBefore}{" -> "}{draft.confidenceAfter}</span>
                  <span>
                    决策 {draft.decisionBefore ? decisionLabel(draft.decisionBefore) : "未知"}{" -> "}
                    {decisionLabel(draft.decisionAfter)}
                  </span>
                  <span>质检 {draft.reportQualityAudit?.score ?? 0}</span>
                </div>
                <div className="revision-diff report-draft-diff" aria-label="新版报告差异">
                  {draft.diff.slice(0, 32).map((line, lineIndex) => (
                    <code className={`diff-line ${line.type}`} key={`${draft.id}-${line.type}-${lineIndex}`}>
                      <span>{diffPrefix(line.type)}</span>
                      {line.text}
                    </code>
                  ))}
                </div>
                <div className="report-draft-card-actions">
                  <button
                    type="button"
                    onClick={() => applyReportDraft(draft.id)}
                    disabled={Boolean(draft.appliedAt) || applyingReportDraftId === draft.id}
                  >
                    {draft.appliedAt
                      ? "已应用"
                      : applyingReportDraftId === draft.id
                        ? "应用中"
                        : "应用新版报告"}
                  </button>
                  <small>{draft.evidenceRefs.slice(0, 4).join(" · ")}</small>
                </div>
              </details>
            ))}
          </div>
        ) : null}
        {followUpError ? <p className="form-error">{followUpError}</p> : null}
      </section>

      {record.calibrationContext ? (
        <section className="harness-section calibration-context-section">
          <h2>校准规则</h2>
          <div className="calibration-context-head">
            <div>
              <span>{record.calibrationContext.appliesTo === "github_readme" ? "GitHub README" : "README"}</span>
              <strong>{record.calibrationContext.rules.length} 条规则已应用</strong>
            </div>
            <p>
              静态 {record.calibrationContext.staticSampleCount} · 动态{" "}
              {record.calibrationContext.dynamicSampleCount} · 对齐率{" "}
              {record.calibrationContext.alignedRate === null
                ? "待样本"
                : `${record.calibrationContext.alignedRate}%`}
            </p>
          </div>
          <div className="calibration-context-rules">
            {record.calibrationContext.rules.slice(0, 4).map((rule) => (
              <div className={`calibration-context-rule ${rule.priority}`} key={rule.id}>
                <strong>{rule.title}</strong>
                <p>{rule.agentRule}</p>
              </div>
            ))}
          </div>
          {record.calibrationContext.actions?.length ? (
            <div className="calibration-context-actions">
              {record.calibrationContext.actions.slice(0, 4).map((action) => (
                <div className={`calibration-context-action ${action.action}`} key={action.id}>
                  <span>{action.label} · {action.confidence}</span>
                  <strong>{action.target}</strong>
                  <p>{action.reason}</p>
                </div>
              ))}
            </div>
          ) : null}
          <small>{record.calibrationContext.limitations.join(" ")}</small>
        </section>
      ) : null}

      {evidenceBrief ? (
        <>
          <section className="harness-section evidence-room">
            <h2>证据室</h2>
            <div className="evidence-decision">
              <div>
                <span>当前决策</span>
                <strong>{decisionLabel(evidenceBrief.decision.decision)}</strong>
              </div>
              <div>
                <span>证据结论</span>
                <strong>{verdictLabel(evidenceBrief.evidenceVerdict)}</strong>
              </div>
            </div>
            <div className="evidence-metrics">
              <span>客观证据 {evidenceBrief.objectiveEvidenceRatio}%</span>
              <span>当前证据 {evidenceBrief.currentEvidenceRatio}%</span>
              <span>时效有效 {evidenceBrief.temporalValidityScore}</span>
              <span>{lifecycleLabel(evidenceBrief.productLifecycleStage)}</span>
            </div>
            {evidenceBrief.lifecycleEvidenceStandard ? (
              <div className="lifecycle-standard">
                <div>
                  <strong>{evidenceBrief.lifecycleEvidenceStandard.label}</strong>
                  <span>{evidenceBrief.lifecycleEvidenceStandard.decisionRule}</span>
                </div>
                <p>{evidenceBrief.lifecycleEvidenceStandard.evidenceGoal}</p>
                <div className="lifecycle-standard-grid">
                  <span>外部 {evidenceBrief.lifecycleEvidenceStandard.requiredExternalEvidence}</span>
                  <span>总证据 {evidenceBrief.lifecycleEvidenceStandard.requiredTotalEvidence}</span>
                  <span>反证 {evidenceBrief.lifecycleEvidenceStandard.requiredOpposition}</span>
                  <span>新鲜网页 {evidenceBrief.lifecycleEvidenceStandard.requiredFreshWebEvidence}</span>
                  <span>
                    行为不低于 {evidenceBrief.lifecycleEvidenceStandard.minimumBehaviorStrength} ·{" "}
                    {evidenceBrief.lifecycleEvidenceStandard.requiredStrongBehaviorCards}
                  </span>
                </div>
                <em>
                  必看：{evidenceBrief.lifecycleEvidenceStandard.requiredEvidenceTypes.slice(0, 3).join("；")}
                </em>
              </div>
            ) : null}
            {evidenceBrief.evidenceStop ? (
              <div className="evidence-stop">
                <strong>强决策被阻断</strong>
                <p>{evidenceBrief.evidenceStop.reason}</p>
                <div className="stop-rule-list">
                  {evidenceBrief.evidenceStop.ruleResults?.map((rule) => (
                    <div className={`stop-rule ${rule.status}`} key={rule.id}>
                      <div>
                        <strong>{rule.label}</strong>
                        <span>{stopRuleStatusLabel(rule.status)} · {rule.score}</span>
                      </div>
                      <p>{rule.reason}</p>
                      {rule.minimumEvidenceNeeded.length ? (
                        <em>{rule.minimumEvidenceNeeded.join("；")}</em>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          {sourceBudgets.length ? (
            <section className="harness-section">
              <h2>Source Budget</h2>
              <div className="source-budget-list">
                {sourceBudgets.slice(0, 6).map((budget, index) => {
                  const supportCards = cardsForIds(evidenceCards, budget.supportEvidenceIds);
                  const oppositionCards = cardsForIds(evidenceCards, budget.oppositionEvidenceIds);
                  const neutralCards = cardsForIds(evidenceCards, budget.neutralEvidenceIds);
                  const plannedQueries = queriesForIds(
                    webResearch?.queryPlan ?? [],
                    budget.plannedQueryIds
                  );
                  return (
                    <details
                      className={`source-budget-item ${budget.status}`}
                      key={budget.assumptionId}
                      open={index < 2}
                    >
                      <summary>
                        <div>
                          <strong>{budget.label}</strong>
                          <span>{budgetStatusLabel(budget.status)}</span>
                        </div>
                        <p>
                          支持 {budget.currentSupport}/{budget.requiredSupport} · 反证{" "}
                          {budget.currentOpposition}/{budget.requiredOpposition} · 候选{" "}
                          {budget.currentNeutral}
                        </p>
                        {budget.missingEvidence.length ? (
                          <em>{budget.missingEvidence.join("；")}</em>
                        ) : null}
                      </summary>
                      <div className="source-budget-detail">
                        <EvidenceRows
                          title="支持证据"
                          cards={supportCards}
                          emptyText="还没有达标支持证据。"
                          limit={4}
                        />
                        <EvidenceRows
                          title="反证"
                          cards={oppositionCards}
                          emptyText="还没有直接反证。"
                          limit={4}
                        />
                        <EvidenceRows
                          title="候选证据"
                          cards={neutralCards}
                          emptyText="暂无候选证据。"
                          limit={3}
                        />
                        <BudgetQueryRows
                          queries={plannedQueries}
                          queryExecutionById={queryExecutionById}
                        />
                      </div>
                    </details>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="harness-section">
            <h2>Claim Ledger</h2>
            <div className="claim-list">
              {evidenceBrief.claimLedger.claims.slice(0, 4).map((claim, index) => {
                const supportCards = cardsForIds(evidenceCards, claim.supportEvidenceIds);
                const oppositionCards = cardsForIds(evidenceCards, claim.opposeEvidenceIds);
                const relatedBudget = budgetForClaim(evidenceBrief, claim.claimType);
                return (
                  <details className="claim-item" key={claim.id} open={index < 2}>
                    <summary>
                      <div>
                        <strong>{claimStatusLabel(claim.status)}</strong>
                        <span>{claim.confidence}</span>
                      </div>
                      <p>{claim.text}</p>
                    </summary>
                    <div className="claim-detail">
                      {relatedBudget ? (
                        <p className="claim-budget">
                          {relatedBudget.label}：支持 {relatedBudget.currentSupport}/
                          {relatedBudget.requiredSupport}，反证{" "}
                          {relatedBudget.currentOpposition}/
                          {relatedBudget.requiredOpposition}
                        </p>
                      ) : null}
                      <EvidenceRows
                        title="支持证据"
                        cards={supportCards}
                        emptyText="暂无直接支持证据。"
                      />
                      <EvidenceRows
                        title="反证"
                        cards={oppositionCards}
                        emptyText="暂无直接反证。"
                      />
                      <div className="claim-missing">
                        <strong>还需要</strong>
                        <p>{claim.whatWouldChangeThisClaim.join("；")}</p>
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          </section>

          <section className="harness-section experiment-box">
            <h2>下一步验证</h2>
            <strong>{evidenceBrief.recommendedExperiment.title}</strong>
            <p>{evidenceBrief.recommendedExperiment.hypothesis}</p>
            <div>
              <span>{evidenceBrief.recommendedExperiment.sampleSize}</span>
              <span>{evidenceBrief.recommendedExperiment.timeRequired}</span>
              <span>{evidenceBrief.recommendedExperiment.costLevel}</span>
            </div>
            {evidenceBrief.recommendedExperiment.primaryMetric ? (
              <div className="experiment-metric">
                <span>主指标</span>
                <strong>{evidenceBrief.recommendedExperiment.primaryMetric.name}</strong>
                <p>
                  成功：{evidenceBrief.recommendedExperiment.primaryMetric.target}
                  <br />
                  失败：{evidenceBrief.recommendedExperiment.primaryMetric.failureThreshold}
                </p>
              </div>
            ) : null}
            {evidenceBrief.recommendedExperiment.evidenceToCollect?.length ? (
              <details className="experiment-detail" open>
                <summary>要收集的证据</summary>
                <ul>
                  {evidenceBrief.recommendedExperiment.evidenceToCollect.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {evidenceBrief.recommendedExperiment.resultSchema ? (
              <details className="experiment-detail">
                <summary>回填字段</summary>
                <p>
                  必填：{evidenceBrief.recommendedExperiment.resultSchema.requiredFields.join("、")}
                </p>
                <p>
                  选填：{evidenceBrief.recommendedExperiment.resultSchema.optionalFields.join("、")}
                </p>
              </details>
            ) : null}
            {evidenceBrief.recommendedExperiment.decisionRules ? (
              <details className="experiment-detail">
                <summary>判定规则</summary>
                <p>通过：{evidenceBrief.recommendedExperiment.decisionRules.validated}</p>
                <p>不确定：{evidenceBrief.recommendedExperiment.decisionRules.inconclusive}</p>
                <p>失败：{evidenceBrief.recommendedExperiment.decisionRules.invalidated}</p>
              </details>
            ) : null}
            {evidenceBrief.recommendedExperiment.result ? (
              <div className="experiment-result">
                <strong>{experimentResultLabel(evidenceBrief.recommendedExperiment.result.status)}</strong>
                <p>{evidenceBrief.recommendedExperiment.result.evidenceSummary}</p>
                <span>
                  样本 {evidenceBrief.recommendedExperiment.result.sampleSize} · 主指标{" "}
                  {evidenceBrief.recommendedExperiment.result.primaryMetricValue} · 置信变化{" "}
                  {evidenceBrief.recommendedExperiment.result.confidenceDelta > 0 ? "+" : ""}
                  {evidenceBrief.recommendedExperiment.result.confidenceDelta}
                </span>
                {evidenceBrief.recommendedExperiment.result.rawEvidenceArtifacts?.length ? (
                  <span>
                    原始证据 {evidenceBrief.recommendedExperiment.result.rawEvidenceArtifacts.length} 件
                  </span>
                ) : null}
                {ocrArtifactCount ? (
                  <span>
                    OCR 抽取 {ocrArtifactCount} 件
                    {ocrAverageConfidence ? ` · 平均置信 ${ocrAverageConfidence}%` : ""}
                  </span>
                ) : null}
              </div>
            ) : (
              <form className="experiment-result-form" onSubmit={submitExperimentResult}>
                <strong>回填实验结果</strong>
                <label>
                  <span>结果</span>
                  <select name="status" defaultValue="validated">
                    <option value="validated">通过</option>
                    <option value="inconclusive">不确定</option>
                    <option value="invalidated">失败</option>
                  </select>
                </label>
                <label>
                  <span>样本量</span>
                  <input name="sampleSize" type="number" min="0" placeholder="例如 120" />
                </label>
                <label>
                  <span>主指标结果</span>
                  <input name="primaryMetricValue" placeholder="例如 点击率 3.8%，有效留资 4 个" />
                </label>
                <label>
                  <span>证据摘要</span>
                  <textarea
                    name="evidenceSummary"
                    rows={3}
                    placeholder="写清楚真实发生了什么，以及它支持或反驳了哪个假设。"
                  />
                </label>
                <label>
                  <span>原始链接</span>
                  <textarea
                    name="rawEvidenceUrls"
                    rows={2}
                    placeholder="可选，每行一个帖子、表格、截图或数据链接。"
                  />
                </label>
                <label>
                  <span>原始材料摘录</span>
                  <textarea
                    name="rawEvidenceNotes"
                    rows={4}
                    placeholder="可粘贴评论、访谈纪要、CSV 行或指标日志；系统会拆成证据卡。"
                  />
                </label>
                <label>
                  <span>上传原始材料</span>
                  <input
                    name="rawEvidenceFiles"
                    type="file"
                    multiple
                    accept=".txt,.md,.mdx,.csv,.tsv,.json,.pdf,.png,.jpg,.jpeg,.webp"
                  />
                </label>
                <label>
                  <span>备注</span>
                  <textarea name="notes" rows={2} placeholder="可选，补充异常样本或渠道背景。" />
                </label>
                {experimentError ? <p className="experiment-error">{experimentError}</p> : null}
                <button type="submit" disabled={isSavingExperiment}>
                  {isSavingExperiment ? "保存中" : "保存结果"}
                </button>
              </form>
            )}
          </section>
        </>
      ) : null}

      <section className={`harness-section report-quality-section ${reportQualityAudit.status}`}>
        <h2>报告质检</h2>
        <div className="report-quality-head">
          <div>
            <span>{reportQualityStatusLabel(reportQualityAudit.status)}</span>
            <strong>{reportQualityAudit.score}</strong>
          </div>
          <p>{reportQualityAudit.summary}</p>
        </div>
        <div className="report-quality-checks">
          {reportQualityAudit.checks.map((check) => (
            <div className={`report-quality-check ${check.status}`} key={check.id}>
              <div>
                <strong>{check.label}</strong>
                <span>{reportQualityStatusLabel(check.status)} · {check.score}</span>
              </div>
              <p>{check.reason}</p>
              {check.minimumFixes.length ? <em>{check.minimumFixes[0]}</em> : null}
            </div>
          ))}
        </div>
        {reportQualityAudit.issues.length ? (
          <div className="report-quality-issues">
            {reportQualityAudit.issues.slice(0, 3).map((issue) => {
              const qualityResearchSummary = latestQualityResearchByIssue.get(issue.id);
              return (
                <details className={`report-quality-issue ${issue.severity}`} key={issue.id}>
                  <summary>
                    <span>{qualityIssueSeverityLabel(issue.severity)}</span>
                    <strong>{issue.title}</strong>
                  </summary>
                  <p>{issue.finding}</p>
                  <em>{issue.fix}</em>
                  {issue.repairDraft ? (
                    <div className="repair-draft">
                      <div>
                        <span>{repairTargetLabel(issue.repairDraft.targetSection)} · 修复草案</span>
                        <strong>{issue.repairDraft.title}</strong>
                      </div>
                      <p>{issue.repairDraft.replacementText}</p>
                      <em>{issue.repairDraft.whyThisFix}</em>
                      {issue.repairDraft.evidenceRefs.length ? (
                        <small>{issue.repairDraft.evidenceRefs.join(" · ")}</small>
                      ) : null}
                      {issue.repairDraft.researchPlan ? (
                        <div className="repair-research-plan">
                          <strong>{issue.repairDraft.researchPlan.title}</strong>
                          <p>{issue.repairDraft.researchPlan.trigger}</p>
                          {issue.repairDraft.researchPlan.queries.length ? (
                            <div>
                              <span>补查 query</span>
                              {issue.repairDraft.researchPlan.queries.slice(0, 4).map((query) => (
                                <em key={query}>{query}</em>
                              ))}
                            </div>
                          ) : null}
                          {issue.repairDraft.researchPlan.backtestSuggestions.length ? (
                            <div>
                              <span>README 回测</span>
                              {issue.repairDraft.researchPlan.backtestSuggestions.slice(0, 3).map((item) => (
                                <em key={item}>{item}</em>
                              ))}
                              <button
                                type="button"
                                onClick={() => sendBacktestSuggestions(issue.id)}
                                disabled={queueingBacktestIssueId === issue.id}
                              >
                                {queueingBacktestIssueId === issue.id ? "发送中" : "发送到回测台"}
                              </button>
                            </div>
                          ) : null}
                          {issue.repairDraft.researchPlan.experimentActions.length ? (
                            <div>
                              <span>实验动作</span>
                              {issue.repairDraft.researchPlan.experimentActions.slice(0, 3).map((item) => (
                                <em key={item}>{item}</em>
                              ))}
                            </div>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => runQualityResearch(issue.id)}
                            disabled={researchingIssueId === issue.id}
                          >
                            {researchingIssueId === issue.id ? "补证中" : "执行补证"}
                          </button>
                          {qualityResearchIssueId === issue.id && qualityResearchEvents.length ? (
                            <div className="report-draft-progress quality-research-progress" aria-label="质检补证进度">
                              {qualityResearchEvents.map((event, index) => (
                                <div
                                  className={`report-draft-progress-item ${event.status}`}
                                  key={`${event.stage}-${index}`}
                                >
                                  <i />
                                  <div>
                                    <strong>{event.title}</strong>
                                    <p>{event.summary}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {qualityResearchSummary ? (
                        <QualityResearchSummaryCard summary={qualityResearchSummary} />
                      ) : null}
                      <button
                        type="button"
                        onClick={() => applyRepairDraft(issue.id)}
                        disabled={
                          applyingIssueId === issue.id ||
                          Boolean(record.reportRevisions?.some((revision) => revision.issueId === issue.id))
                        }
                      >
                        {record.reportRevisions?.some((revision) => revision.issueId === issue.id)
                          ? "已应用"
                          : applyingIssueId === issue.id
                            ? "应用中"
                            : "应用草案"}
                      </button>
                    </div>
                  ) : qualityResearchSummary ? (
                    <QualityResearchSummaryCard summary={qualityResearchSummary} />
                  ) : null}
                </details>
              );
            })}
          </div>
        ) : null}
        {unmatchedQualityResearchRuns.length ? (
          <div className="quality-research-summary-list">
            <strong>最近补证摘要</strong>
            {unmatchedQualityResearchRuns.map((summary) => (
              <QualityResearchSummaryCard key={summary.id} summary={summary} />
            ))}
          </div>
        ) : null}
        {rewriteError ? <p className="report-rewrite-error">{rewriteError}</p> : null}
        {record.reportRevisions?.length ? (
          <div className="report-revisions">
            <strong>报告修订</strong>
            {record.reportRevisions.slice(0, 5).map((revision, index) => {
              const blockedByNewer = Boolean(
                record.reportRevisions
                  ?.slice(0, index)
                  .some(
                    (item) =>
                      item.targetSection === revision.targetSection &&
                      !item.rolledBackAt
                  )
              );
              const diff = revisionDiff(revision);
              return (
                <details
                  className={`revision-card ${revision.rolledBackAt ? "rolled-back" : ""}`}
                  key={revision.id}
                  open={index === 0}
                >
                  <summary>
                    <span>{repairTargetLabel(revision.targetSection)}</span>
                    <strong>{revision.draftTitle}</strong>
                    <em>{revision.rolledBackAt ? "已回滚" : formatTimestamp(revision.createdAt)}</em>
                  </summary>
                  <p>{revision.summary}</p>
                  {revision.evidenceRefs.length ? (
                    <small>{revision.evidenceRefs.join(" · ")}</small>
                  ) : null}
                  <div className="revision-diff" aria-label="修订前后对比">
                    {diff.map((line, lineIndex) => (
                      <code className={`diff-line ${line.type}`} key={`${line.type}-${lineIndex}`}>
                        <span>{diffPrefix(line.type)}</span>
                        {line.text}
                      </code>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => rollbackRevision(revision.id)}
                    disabled={
                      Boolean(revision.rolledBackAt) ||
                      blockedByNewer ||
                      rollingBackRevisionId === revision.id
                    }
                  >
                    {revision.rolledBackAt
                      ? "已回滚"
                      : rollingBackRevisionId === revision.id
                        ? "回滚中"
                        : "回滚这次修订"}
                  </button>
                  {blockedByNewer ? <small>同一段落有更新修订，请先回滚更新的版本。</small> : null}
                </details>
              );
            })}
          </div>
        ) : null}
        {reportQualityAudit.strengths.length ? (
          <div className="report-quality-strengths">
            {reportQualityAudit.strengths.slice(0, 2).map((strength) => (
              <p key={strength}>{strength}</p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="harness-section">
        <h2>判断过程</h2>
        <ol className="thinking-steps">
          <li>
            <span>1</span>
            <div>
              <strong>拆材料</strong>
              <p>{record.workType.replaceAll("_", " ")} · {record.productName}</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>找证据</strong>
              <p>
                {webEvidenceCount
                  ? `读取 ${webEvidenceCount} 条外部网页证据`
                  : "主要基于用户上传材料判断"}
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>判信号</strong>
              <p>{signalNames || "用户任务 / 风险 / 分发路径"}</p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>定结论</strong>
              <p>{report.share_summary.main_problem}</p>
            </div>
          </li>
        </ol>
      </section>

      {webResearch?.queryPlan?.length ? (
        <section className="harness-section">
          <h2>调研计划</h2>
          <div className="query-plan-list">
            {webResearch.queryPlan.slice(0, 10).map((query) => {
              const execution = queryExecutionById.get(query.id);
              return (
                <div className={`query-plan-item ${execution?.status ?? "planned"}`} key={query.id}>
                  <div>
                    <strong>{intentLabel(query.intent)}</strong>
                    <span>
                      P{query.priority} · {queryPhaseLabel(query.phase)} ·{" "}
                      {execution?.provider ? `${searchProviderLabel(execution.provider)} · ` : ""}
                      {queryExecutionLabel(execution?.status)} {execution?.resultCount ?? 0}
                    </span>
                  </div>
                  <p>{query.query}</p>
                  <em>{execution?.reason || query.rationale}</em>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {runtimeTrace ? (
        <SubagentRuntimeSection
          trace={{
            ...runtimeTrace,
            resumeRequests: runtimeResumeRequests,
            interrupts: runtimeInterrupts
          }}
          pendingResumeId={runtimeResumePendingId}
          resumeError={runtimeResumeError}
          onRuntimeResume={submitRuntimeResume}
          pendingInterruptId={runtimeInterruptPendingId}
          interruptError={runtimeInterruptError}
          onRuntimeInterrupt={submitRuntimeInterrupt}
          workerQueuePatches={workerQueuePatches}
          pendingWorkerQueueActionId={workerQueuePendingId}
          workerQueueError={workerQueueError}
          onWorkerQueueAction={submitWorkerQueueAction}
          workerDaemonStatus={workerDaemonStatus}
          workerDaemonPending={workerDaemonPending}
          workerDaemonError={workerDaemonError}
          onRefreshWorkerDaemon={() => loadWorkerDaemonStatus()}
          onDrainWorkerDaemon={submitWorkerDaemonDrain}
          onWorkerDaemonAction={submitWorkerDaemonAction}
        />
      ) : null}

      {judgeVerdict ? <JudgeVerdictSection verdict={judgeVerdict} /> : null}

      {webResearch?.researchLoops?.length ? (
        <section className="harness-section evidence-loop-section">
          <h2>自动补证循环</h2>
          <div className="evidence-loop-list">
            {webResearch.researchLoops.map((loop) => (
              <div className={`evidence-loop-item ${loop.status}`} key={loop.id}>
                <div>
                  <strong>第 {loop.round} 轮 · {researchLoopStatusLabel(loop.status)}</strong>
                  <span>
                    查询 {loop.queryIds.length} · 结果 {loop.resultCount} · 置信{" "}
                    {loop.beforeConfidence}
                    {loop.afterConfidence !== undefined ? ` -> ${loop.afterConfidence}` : ""}
                  </span>
                </div>
                <p>{loop.trigger}</p>
                <em>{loop.stopCondition || loop.reason}</em>
                {loop.remainingGaps.length ? (
                  <ul>
                    {loop.remainingGaps.slice(0, 3).map((gap) => (
                      <li key={gap}>{gap}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {webResearch?.searchQuality ? (
        <section className="harness-section search-quality-section">
          <h2>搜索质量</h2>
          <div className="search-quality-head">
            <div>
              <span>{searchProviderLabel(webResearch.searchQuality.provider)}</span>
              <strong>{webResearch.searchQuality.qualityScore}</strong>
            </div>
            <p>
              {webResearch.searchQuality.executedQueries}/
              {webResearch.searchQuality.plannedQueries} 查询执行 ·{" "}
              {webResearch.searchQuality.totalResults} 条结果
            </p>
          </div>
          <div className="search-quality-grid">
            <SearchQualityMetric label="成功率" value={webResearch.searchQuality.querySuccessRate} />
            <SearchQualityMetric label="URL" value={webResearch.searchQuality.urlCoverage} />
            <SearchQualityMetric label="日期" value={webResearch.searchQuality.dateCoverage} />
            <SearchQualityMetric label="反证" value={webResearch.searchQuality.oppositionResultRatio} />
            <SearchQualityMetric label="假设" value={webResearch.searchQuality.assumptionCoverage} />
            <SearchQualityMetric label="时效" value={webResearch.searchQuality.freshResultRatio} />
          </div>
          {webResearch.searchQuality.warnings.length ? (
            <div className="search-quality-warnings">
              {webResearch.searchQuality.warnings.slice(0, 3).map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {evidenceVisibility ? (
        <section className="harness-section evidence-visibility-section">
          <h2>证据可用性</h2>
          <div className="evidence-visibility-grid">
            <EvidenceVisibilityMetric
              label="网页正文"
              value={evidenceVisibility.crawledBodyCount}
              detail="已抓正文，可作为较强公开证据"
            />
            <EvidenceVisibilityMetric
              label="搜索摘要"
              value={evidenceVisibility.searchSummaryCount}
              detail="候选信号，需要谨慎使用"
            />
            <EvidenceVisibilityMetric
              label="无 URL 摘要"
              value={evidenceVisibility.urlMissingCount}
              detail="低置信，只能提示方向"
            />
            <EvidenceVisibilityMetric
              label="失败/跳过"
              value={evidenceVisibility.failedOrSkippedCount}
              detail="不能算作证据"
            />
          </div>
          <div className="evidence-visibility-status">
            <span>{evidenceVisibility.executedCount} 执行</span>
            <span>{evidenceVisibility.plannedCount} 计划</span>
            <span>{evidenceVisibility.skippedCount} 跳过</span>
            <span>{evidenceVisibility.failedCount} 失败</span>
            <span>{evidenceVisibility.githubMetricCount} GitHub 指标</span>
          </div>
          {evidenceVisibility.notes.length ? (
            <div className="evidence-visibility-notes">
              {evidenceVisibility.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          ) : null}
          {evidenceVisibility.examples.length ? (
            <div className="evidence-visibility-examples">
              {evidenceVisibility.examples.map((item) => (
                item.url ? (
                  <a href={item.url} key={`${item.kind}-${item.title}`} target="_blank" rel="noreferrer">
                    {item.icon === "body" ? <Globe2 size={13} /> : <Search size={13} />}
                    <span>{item.kind} · {item.title}</span>
                  </a>
                ) : (
                  <p key={`${item.kind}-${item.title}`}>
                    {item.kind} · {item.title}
                  </p>
                )
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {webResearch ? (
        <section className="harness-section">
          <h2>证据来源</h2>
          <div className="source-list">
            {webResearch.crawled.slice(0, 4).map((item) => (
              <a href={item.url} key={item.url} target="_blank" rel="noreferrer">
                <Globe2 size={14} />
                <span>{item.title}</span>
              </a>
            ))}
            {webResearch.searchResults.slice(0, 4).map((item) => (
              item.url ? (
                <a href={item.url} key={`${item.queryId}-${item.url}`} target="_blank" rel="noreferrer">
                  <Search size={14} />
                  <span>{item.title}</span>
                </a>
              ) : (
                <p key={`${item.queryId}-${item.title}`}>
                  {item.title} · {item.searchProvider === "zhipu" ? "智谱摘要，URL 缺失" : "URL 缺失"}
                </p>
              )
            ))}
            {webResearch.skippedReasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </div>
        </section>
      ) : null}

      <section className="harness-section">
        <h2>工具调用</h2>
        <div className="trace-detail-list">
          {visibleTrace.map((step, index) => {
            const Icon = iconForStage(step.stage);
            return (
              <details className="trace-detail" key={`${step.stage}-${index}`} open={index < 4}>
                <summary>
                  <Icon size={15} />
                  <span>{step.title}</span>
                  <i className={`status-dot ${step.status}`} />
                </summary>
                <p>{step.summary || "已完成该步骤。"}</p>
                {step.toolCalls.length > 0 ? (
                  <div className="tool-call-list">
                    {step.toolCalls.map((tool) => (
                      <div className="tool-call" key={tool.id}>
                        <div>
                          <strong>{tool.toolName}</strong>
                          <span>{tool.status} · {tool.latencyMs}ms</span>
                        </div>
                        <p>{tool.inputSummary}</p>
                        <em>{tool.outputSummary}</em>
                      </div>
                    ))}
                  </div>
                ) : null}
              </details>
            );
          })}
        </div>
      </section>

      <div className="quality-stack">
        {evidenceBrief ? (
          <>
            <QualityBar label="证据置信度" value={evidenceBrief.confidenceScore} />
            <QualityBar label="客观证据占比" value={evidenceBrief.objectiveEvidenceRatio} />
            <QualityBar label="时效有效性" value={evidenceBrief.temporalValidityScore} />
            <QualityBar label="Source Budget" value={evidenceBrief.sourceBudgetScore ?? 0} />
            <QualityBar label="报告质检" value={reportQualityAudit.score} />
          </>
        ) : (
          <>
            <QualityBar label="产品潜力" value={report.potential_score} />
            <QualityBar label="行动清晰度" value={86} />
            <QualityBar label="问题覆盖度" value={78} />
            <QualityBar label="发布说服力" value={report.diagnosis_score} />
            <QualityBar label="报告质检" value={reportQualityAudit.score} />
          </>
        )}
      </div>

      <div className="run-note">
        <span>Created</span>
        <strong>{formatTimestamp(record.createdAt)}</strong>
      </div>
    </aside>
  );
}

function normalizeReportForView(
  report: ProductDiagnosisReport
): ProductDiagnosisReport {
  const legacyReport = report as ProductDiagnosisReport & {
    taste_score?: number;
    aesthetic_tags?: string[];
    potential_score?: number;
    potential_verdict?: string;
    market_evidence?: ProductDiagnosisReport["market_evidence"];
  };

  return {
    ...report,
    diagnosis_score:
      legacyReport.diagnosis_score ?? legacyReport.taste_score ?? 0,
    diagnosis_tags:
      legacyReport.diagnosis_tags ?? legacyReport.aesthetic_tags ?? [],
    potential_score: legacyReport.potential_score ?? 0,
    potential_verdict:
      legacyReport.potential_verdict ?? "旧报告没有产品潜力判断。",
    market_evidence: legacyReport.market_evidence ?? []
  };
}

function fallbackTrace(): AgentTraceStep[] {
  return [
    {
      stage: "material_observer",
      title: "材料信号已读取",
      summary: "",
      status: "completed",
      toolCalls: []
    },
    {
      stage: "web_research",
      title: "网页证据已检查",
      summary: "",
      status: "completed",
      toolCalls: []
    },
    {
      stage: "evidence_agent",
      title: "证据账本已生成",
      summary: "",
      status: "completed",
      toolCalls: []
    },
    {
      stage: "potential_assessment",
      title: "产品潜力已评估",
      summary: "",
      status: "completed",
      toolCalls: []
    },
    {
      stage: "priority_planner",
      title: "下一步已排序",
      summary: "",
      status: "completed",
      toolCalls: []
    },
    {
      stage: "quality_gate",
      title: "报告质量已检查",
      summary: "",
      status: "completed",
      toolCalls: []
    }
  ];
}

function iconForStage(stage: AgentStage) {
  if (stage === "readme_reader") return FileText;
  if (stage === "material_observer") return Eye;
  if (stage === "product_thesis") return Bot;
  if (stage === "evidence_agent") return ListChecks;
  if (stage === "web_research") return Globe2;
  if (stage === "customer_job") return Search;
  if (stage === "risk_review") return Gauge;
  if (stage === "ux_trust_review") return Eye;
  if (stage === "market_fit_review") return Search;
  if (stage === "potential_assessment") return TrendingUp;
  if (stage === "reference_curator") return Search;
  if (stage === "priority_planner") return ListChecks;
  if (stage === "report_composer") return Wand2;
  if (stage === "quality_gate") return Gauge;
  return Bot;
}

function decisionLabel(decision: EvidenceBrief["decision"]["decision"]) {
  if (decision === "build") return "继续构建";
  if (decision === "test_first") return "先验证";
  if (decision === "reposition") return "重定位";
  return "停止";
}

function verdictLabel(verdict: EvidenceBrief["evidenceVerdict"]) {
  if (verdict === "strong_support") return "强支持";
  if (verdict === "weak_support") return "弱支持";
  if (verdict === "mixed") return "混合";
  if (verdict === "weak_opposition") return "弱反证";
  if (verdict === "strong_opposition") return "强反证";
  return "证据不足";
}

function claimStatusLabel(status: EvidenceBrief["claimLedger"]["claims"][number]["status"]) {
  if (status === "supported") return "支持";
  if (status === "opposed") return "反证";
  if (status === "mixed") return "混合";
  if (status === "stale") return "过期";
  return "未证实";
}

function lifecycleLabel(stage: EvidenceBrief["productLifecycleStage"]) {
  if (stage === "idea") return "想法期";
  if (stage === "prototype") return "原型期";
  if (stage === "mvp") return "MVP";
  if (stage === "launch") return "发布期";
  if (stage === "early_traction") return "早期牵引";
  if (stage === "growth") return "增长期";
  if (stage === "mature") return "成熟期";
  if (stage === "decline") return "衰退期";
  return "生命周期未知";
}

function budgetStatusLabel(status: EvidenceBrief["sourceBudgets"][number]["status"]) {
  if (status === "met") return "达标";
  if (status === "partial") return "部分";
  if (status === "planned") return "已规划";
  return "缺失";
}

function stopRuleStatusLabel(status: EvidenceStopRule["status"]) {
  if (status === "pass") return "通过";
  if (status === "warn") return "提醒";
  return "阻断";
}

function experimentResultLabel(status: "validated" | "inconclusive" | "invalidated") {
  if (status === "validated") return "实验通过";
  if (status === "inconclusive") return "实验不确定";
  return "实验失败";
}

function reportQualityStatusLabel(status: "pass" | "warn" | "fail") {
  if (status === "pass") return "通过";
  if (status === "warn") return "提醒";
  return "未通过";
}

function qualityIssueSeverityLabel(severity: "blocker" | "warning" | "info") {
  if (severity === "blocker") return "阻断";
  if (severity === "warning") return "提醒";
  return "记录";
}

function repairTargetLabel(
  target: NonNullable<
    NonNullable<
      NonNullable<AnalysisRecord["reportQualityAudit"]>["issues"][number]["repairDraft"]
    >
  >["targetSection"]
) {
  if (target === "potential_verdict") return "替换结论";
  if (target === "market_evidence") return "补证据段";
  if (target === "top_issues") return "修问题段";
  if (target === "actionable_suggestions") return "改行动项";
  return "补限制";
}

function budgetForClaim(
  evidenceBrief: EvidenceBrief,
  claimType: EvidenceBrief["claimLedger"]["claims"][number]["claimType"]
) {
  const assumptionId =
    claimType === "payment"
      ? "payment"
      : claimType === "distribution"
        ? "distribution"
        : claimType === "timing"
          ? "timing"
          : claimType === "ai_advantage"
            ? "ai-advantage"
            : "problem";
  return evidenceBrief.sourceBudgets?.find((budget) => budget.assumptionId === assumptionId);
}

function cardsForIds(cards: EvidenceCard[], ids: string[]) {
  const wanted = new Set(ids);
  return cards.filter((card) => wanted.has(card.id));
}

function queriesForIds(
  queries: NonNullable<AnalysisRecord["webResearch"]>["queryPlan"],
  ids: string[]
) {
  const wanted = new Set(ids);
  return (queries ?? []).filter((query) => wanted.has(query.id));
}

function EvidenceRows({
  title,
  cards,
  emptyText,
  limit = 3
}: {
  title: string;
  cards: EvidenceCard[];
  emptyText: string;
  limit?: number;
}) {
  return (
    <div className="evidence-mini-list">
      <strong>{title}</strong>
      {cards.length ? (
        cards.slice(0, limit).map((card) => {
          const content = (
            <>
              <span>{card.direction === "oppose" ? "反" : "证"}</span>
              <div>
                <p>{card.claim}</p>
                <em>
                  {card.sourceTitle} · {recencyLabel(card.recencyBucket)} · {card.confidence}
                </em>
              </div>
            </>
          );

          return card.sourceUrl ? (
            <a href={card.sourceUrl} key={card.id} target="_blank" rel="noreferrer">
              {content}
            </a>
          ) : (
            <div className="evidence-mini-row" key={card.id}>
              {content}
            </div>
          );
        })
      ) : (
        <p>{emptyText}</p>
      )}
    </div>
  );
}

function ReportEvidenceBindingCard({
  binding,
  evidenceCards
}: {
  binding?: ReportEvidenceBinding;
  evidenceCards: EvidenceCard[];
}) {
  if (!binding) return null;
  const supportCards = cardsForIds(evidenceCards, binding.supportEvidenceIds);
  const oppositionCards = cardsForIds(evidenceCards, binding.oppositionEvidenceIds);
  const neutralCards = cardsForIds(evidenceCards, binding.neutralEvidenceIds);
  const total = supportCards.length + oppositionCards.length + neutralCards.length;

  return (
    <details className={`report-evidence-binding ${binding.status}`}>
      <summary>
        <span>{reportBindingStatusLabel(binding.status)}</span>
        <strong>
          依据 {supportCards.length + neutralCards.length}
          {oppositionCards.length ? ` · 反证 ${oppositionCards.length}` : ""}
        </strong>
        <em>{binding.confidence}</em>
      </summary>
      <p>{binding.rationale}</p>
      <EvidenceRows
        title="支持依据"
        cards={[...supportCards, ...neutralCards]}
        emptyText="没有找到直接支持证据。"
        limit={3}
      />
      <EvidenceRows
        title="反证/风险"
        cards={oppositionCards}
        emptyText="没有绑定反证。"
        limit={2}
      />
      {binding.missingEvidence.length ? (
        <div className="report-evidence-gaps">
          <strong>还缺什么</strong>
          {binding.missingEvidence.slice(0, 3).map((gap) => (
            <em key={gap}>{gap}</em>
          ))}
        </div>
      ) : null}
      {!total ? <small>这段应降级为待验证假设，或补充可复核证据。</small> : null}
    </details>
  );
}

function reportBindingStatusLabel(status: ReportEvidenceBinding["status"]) {
  if (status === "bound") return "已绑定";
  if (status === "weak") return "弱绑定";
  return "缺依据";
}

function QualityResearchSummaryCard({ summary }: { summary: QualityResearchRunSummary }) {
  const confidenceDelta = summary.confidenceAfter - summary.confidenceBefore;
  const qualityDelta = summary.qualityScoreAfter - summary.qualityScoreBefore;

  return (
    <div className={`quality-research-summary ${summary.stillOpen ? "open" : "resolved"}`}>
      <div className="quality-research-summary-head">
        <div>
          <span>{summary.stillOpen ? "补证后仍需处理" : "补证后已解除"}</span>
          <strong>{summary.issueTitle}</strong>
        </div>
        <small>{formatTimestamp(summary.createdAt)}</small>
      </div>
      <div className="quality-research-metrics">
        <span>query {summary.queryCount}</span>
        <span>结果 {summary.resultCount}</span>
        <span>正文 {summary.crawledCount}</span>
        <span>
          置信 {summary.confidenceBefore}{" -> "}{summary.confidenceAfter}
          {confidenceDelta ? ` (${confidenceDelta > 0 ? "+" : ""}${confidenceDelta})` : ""}
        </span>
        <span>
          质检 {summary.qualityScoreBefore}{" -> "}{summary.qualityScoreAfter}
          {qualityDelta ? ` (${qualityDelta > 0 ? "+" : ""}${qualityDelta})` : ""}
        </span>
      </div>
      <p>{summary.applyRecommendation}</p>
      {summary.newEvidence.length ? (
        <div className="quality-research-evidence">
          <span>新增/补强证据</span>
          {summary.newEvidence.slice(0, 4).map((item, index) => (
            <details
              className="quality-research-evidence-card"
              key={`${item.sourceType}-${item.url || item.title}-${index}`}
            >
              <summary>
                <strong>{item.title || item.url || `证据 ${index + 1}`}</strong>
                <em>
                  {qualityEvidenceSourceLabel(item.sourceType)}
                  {item.direction ? ` · ${qualityEvidenceDirectionLabel(item.direction)}` : ""}
                  {item.recencyBucket ? ` · ${recencyLabel(item.recencyBucket)}` : ""}
                </em>
              </summary>
              <p>{item.snippet}</p>
              <div className="quality-evidence-facts">
                <span>URL</span>
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.url}
                  </a>
                ) : (
                  <em>无原始 URL</em>
                )}
                <span>日期</span>
                <em>{qualityEvidenceDateLabel(item)}</em>
                <span>进入判断</span>
                <em>{item.whyIncluded || item.interpretation || "作为补证候选进入 Evidence Brief。"} </em>
                <span>信号</span>
                <em>
                  {item.assumptionId || "未绑定假设"}
                  {item.signalType ? ` · ${item.signalType}` : ""}
                  {typeof item.confidence === "number" ? ` · 置信 ${item.confidence}` : ""}
                </em>
                <span>客观性</span>
                <em>
                  {item.objectiveLevel ? qualityObjectiveLabel(item.objectiveLevel) : "未标注"}
                  {typeof item.credibilityScore === "number" ? ` · 可信 ${Math.round(item.credibilityScore * 100)}` : ""}
                  {typeof item.behaviorStrength === "number" ? ` · 行为 ${item.behaviorStrength}` : ""}
                </em>
                {item.caveat ? (
                  <>
                    <span>边界</span>
                    <em>{item.caveat}</em>
                  </>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <em className="quality-research-empty">本轮没有形成新的可用证据，建议换更具体 query 或补原始实验材料。</em>
      )}
      {summary.remainingGaps.length ? (
        <div className="quality-research-gaps">
          <span>剩余缺口</span>
          {summary.remainingGaps.slice(0, 4).map((gap) => (
            <em key={gap}>{gap}</em>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function qualityEvidenceSourceLabel(sourceType: string) {
  if (sourceType === "crawled_url") return "网页正文";
  if (sourceType === "search_result") return "搜索结果";
  if (sourceType === "github_repository") return "GitHub 指标";
  return sourceType;
}

function qualityEvidenceDirectionLabel(direction: "support" | "oppose" | "neutral") {
  if (direction === "support") return "支持";
  if (direction === "oppose") return "反证";
  return "中性";
}

function qualityEvidenceDateLabel(item: QualityResearchRunSummary["newEvidence"][number]) {
  const date = item.updatedAt || item.publishedAt || item.capturedAt;
  if (!date) return "日期未知";
  const kind = item.updatedAt ? "更新" : item.publishedAt ? "发布" : "抓取";
  const source = item.dateSource ? ` · ${item.dateSource}` : "";
  return `${kind} ${formatTimestamp(date)}${source}`;
}

function qualityObjectiveLabel(level: NonNullable<QualityResearchRunSummary["newEvidence"][number]["objectiveLevel"]>) {
  if (level === "observed_fact") return "观察事实";
  if (level === "evidence_interpretation") return "证据解释";
  if (level === "model_inference") return "模型推断";
  return "假设";
}

function BudgetQueryRows({
  queries,
  queryExecutionById
}: {
  queries: NonNullable<AnalysisRecord["webResearch"]>["queryPlan"];
  queryExecutionById: Map<string, EvidenceQueryExecution>;
}) {
  return (
    <div className="budget-query-list">
      <strong>对应查询</strong>
      {queries?.length ? (
        queries.slice(0, 4).map((query) => {
          const execution = queryExecutionById.get(query.id);
          return (
            <div className={`budget-query-row ${execution?.status ?? "planned"}`} key={query.id}>
              <span>
                {queryPhaseLabel(query.phase)} ·{" "}
                {queryExecutionLabel(execution?.status)} {execution?.resultCount ?? 0}
              </span>
              <p>{query.query}</p>
              <em>{execution?.reason || query.expectedEvidence}</em>
            </div>
          );
        })
      ) : (
        <p>暂无对应查询。</p>
      )}
    </div>
  );
}

function SearchQualityMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="search-quality-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SubagentRuntimeSection({
  trace,
  pendingResumeId,
  resumeError,
  onRuntimeResume,
  pendingInterruptId,
  interruptError,
  onRuntimeInterrupt,
  workerQueuePatches,
  pendingWorkerQueueActionId,
  workerQueueError,
  onWorkerQueueAction,
  workerDaemonStatus,
  workerDaemonPending,
  workerDaemonError,
  onRefreshWorkerDaemon,
  onDrainWorkerDaemon,
  onWorkerDaemonAction
}: {
  trace: AgentRuntimeTrace;
  pendingResumeId: string | null;
  resumeError: string;
  onRuntimeResume: (targetId: string, action: AgentRuntimeResumeAction) => Promise<void>;
  pendingInterruptId: string | null;
  interruptError: string;
  onRuntimeInterrupt: (interruptId: string, action: AgentRunInterruptAction) => Promise<void>;
  workerQueuePatches: Record<string, WorkerQueuePatch>;
  pendingWorkerQueueActionId: string | null;
  workerQueueError: string;
  onWorkerQueueAction: (item: AgentWorkerQueueItem, action: WorkerQueueAction) => Promise<void>;
  workerDaemonStatus: WorkerDaemonStatusSnapshot | null;
  workerDaemonPending: boolean;
  workerDaemonError: string;
  onRefreshWorkerDaemon: () => Promise<void>;
  onDrainWorkerDaemon: () => Promise<void>;
  onWorkerDaemonAction: (action: WorkerDaemonAction, daemonId?: string) => Promise<void>;
}) {
  const latestHandoff = trace.handoffs[trace.handoffs.length - 1];
  const latestSpans = trace.spans.slice(-9);
  const latestWorkers = (trace.workerRuns ?? []).slice(-6);
  const latestToolCalls = (trace.toolCalls ?? []).slice(-6);
  const workerQueue = (trace.workerQueue ?? []).map((item) => {
    const patch = item.durableQueueId ? workerQueuePatches[item.durableQueueId] : undefined;
    return patch ? { ...item, ...patch } : item;
  });
  const latestQueueItems = workerQueue.slice(-6);
  const interrupts = trace.interrupts ?? [];
  const activeInterrupts = interrupts.filter((item) => item.status === "active");
  const latestInterrupts = interrupts.slice(-5).reverse();
  const resumeRequests = trace.resumeRequests ?? [];
  const latestResumeRequests = resumeRequests.slice(-5).reverse();
  const completedSpans = trace.spans.filter((span) => span.status === "completed").length;
  const failedSpans = trace.spans.filter((span) => span.status === "failed").length;
  const failedWorkers = (trace.workerRuns ?? []).filter((run) => run.status === "failed").length;
  const boundaryCount = (trace.workerRuns ?? []).filter((run) => run.executionBoundary).length;
  const blockedToolCalls = (trace.toolCalls ?? []).filter((tool) => tool.status === "blocked").length;
  const runningQueueItems = workerQueue.filter((item) => item.status === "running").length;
  const queuedQueueItems = workerQueue.filter((item) => item.status === "queued").length;
  const cacheHitCount = (trace.toolCalls ?? []).filter((tool) => tool.cacheStatus === "hit").length;
  const resumePlan = trace.resumePlan;
  const resumeTargets = resumePlan?.targets.slice(-5) ?? [];
  const runEval = trace.runEval;
  const visibleEvalChecks = runEval?.checks.filter((check) => check.status !== "pass").slice(0, 5) ?? [];
  const taskNodes = trace.taskGraph?.nodes ?? [];
  const taskDefinitionsById = new Map((trace.taskGraph?.definitions ?? []).map((definition) => [definition.id, definition]));
  const completedTasks = taskNodes.filter((node) => node.status === "completed").length;
  const graphExecutor = trace.taskGraph?.executor;
  const latestDaemon =
    workerDaemonStatus?.daemons.find(
      (item) =>
        !item.stale &&
        (item.heartbeat.status === "starting" ||
          item.heartbeat.status === "running" ||
          item.heartbeat.status === "idle")
    ) ?? workerDaemonStatus?.daemons[0];
  const latestDaemonLive = Boolean(
    latestDaemon &&
      !latestDaemon.stale &&
      (latestDaemon.heartbeat.status === "starting" ||
        latestDaemon.heartbeat.status === "running" ||
        latestDaemon.heartbeat.status === "idle")
  );
  const latestMaintenance = latestDaemon?.heartbeat.lastResult?.maintenance;
  const daemonHealth = workerDaemonStatus?.health;
  const daemonLaunchd = workerDaemonStatus?.launchd;
  const daemonQueueSla = workerDaemonStatus?.queueSla;
  const daemonAlertChannel = workerDaemonStatus?.alertChannel;
  const supportedDaemonTools =
    workerDaemonStatus?.supportedTools?.map((tool) => tool.toolId).join(" / ") ||
    "web_search / web_fetch / code_execute / evidence_extract / judge / model_report";
  const leaseRecoveryCount =
    (latestMaintenance?.requeued ?? 0) +
    (latestMaintenance?.failedExpired ?? 0) +
    (latestMaintenance?.cancelled ?? 0);

  return (
    <section className="harness-section subagent-runtime-section">
      <h2>Subagent 运行账本</h2>
      <div className="subagent-runtime-head">
        <div>
          <span>{runtimeStatusLabel(trace.status)}</span>
          <strong>{completedSpans}/{trace.spans.length}</strong>
          <small>span 完成</small>
        </div>
        <div>
          <span>Artifacts</span>
          <strong>{trace.artifacts.length}</strong>
          <small>外部化上下文</small>
        </div>
        <div>
          <span>Handoff</span>
          <strong>{trace.handoffs.length}</strong>
          <small>阶段交接包</small>
        </div>
        <div>
          <span>失败</span>
          <strong>{failedSpans}</strong>
          <small>可定位任务</small>
        </div>
        <div>
          <span>Workers</span>
          <strong>{trace.workerRuns?.length ?? 0}</strong>
          <small>独立预算任务</small>
        </div>
        <div>
          <span>Queue</span>
          <strong>{workerQueue.length}</strong>
          <small>{queuedQueueItems} queued · {runningQueueItems} running</small>
        </div>
        <div>
          <span>Interrupt</span>
          <strong>{activeInterrupts.length}</strong>
          <small>{interrupts.length} total</small>
        </div>
        <div>
          <span>Boundary</span>
          <strong>{boundaryCount}</strong>
          <small>隔离输入包</small>
        </div>
        <div>
          <span>Tools</span>
          <strong>{trace.toolCalls?.length ?? 0}</strong>
          <small>{blockedToolCalls} blocked</small>
        </div>
        <div>
          <span>Resume</span>
          <strong>{resumePlan?.retryableCount ?? 0}</strong>
          <small>{cacheHitCount} cache hit</small>
        </div>
        <div>
          <span>Requests</span>
          <strong>{resumeRequests.length}</strong>
          <small>{latestResumeRequests[0]?.status ? resumeRequestStatusLabel(latestResumeRequests[0].status) : "none"}</small>
        </div>
        <div>
          <span>Tasks</span>
          <strong>{taskNodes.length}</strong>
          <small>
            {completedTasks} completed
            {graphExecutor ? ` · ${graphExecutor.readyNodeIds.length} ready · ${graphExecutor.blockedNodeIds.length} blocked` : ""}
          </small>
        </div>
        <div>
          <span>Snapshots</span>
          <strong>{trace.stateSnapshots?.length ?? 0}</strong>
          <small>恢复锚点</small>
        </div>
        <div>
          <span>Eval</span>
          <strong>{runEval ? runEval.score : "-"}</strong>
          <small>{runEval ? evalStatusLabel(runEval.status) : "未生成"}</small>
        </div>
      </div>

      <div
        className={`worker-daemon-panel ${latestDaemon?.stale ? "stale" : latestDaemon?.heartbeat.status ?? "unknown"} health-${daemonHealth?.status ?? "unknown"}`}
      >
        <div>
          <strong>Worker daemon</strong>
          <span>
            {latestDaemon
              ? `${latestDaemon.heartbeat.daemonId} · ${workerDaemonStatusLabel(latestDaemon.heartbeat.status)}${latestDaemon.stale ? " · stale" : ""}`
              : "未发现 heartbeat"}
          </span>
        </div>
        <p>
          {latestDaemon
            ? `cycle ${latestDaemon.heartbeat.cycle ?? 0} · age ${formatRuntimeMs(latestDaemon.ageMs)} · selected ${latestDaemon.heartbeat.lastResult?.selected ?? 0} · queued ${latestDaemon.heartbeat.lastResult?.scannedQueued ?? 0} · applied ${latestDaemon.heartbeat.lastResult?.counts?.applied ?? 0}`
            : "启动 `pnpm worker:local-drain -- --watch` 后，这里会显示后台消费状态。"}
        </p>
        <p>supported {supportedDaemonTools}</p>
        {daemonHealth ? (
          <p>
            health {workerDaemonHealthLabel(daemonHealth.status)} · live {daemonHealth.liveDaemonCount} · stale {daemonHealth.staleDaemonCount} · restarts {daemonHealth.recentRestarts} · failures {daemonHealth.recentFailures}
          </p>
        ) : null}
        {daemonLaunchd ? (
          <p>
            launchd {daemonLaunchd.available ? (daemonLaunchd.loaded ? "loaded" : daemonLaunchd.installed ? "installed" : "not installed") : "unavailable"} · {daemonLaunchd.label}
            {daemonLaunchd.pid ? ` · pid ${daemonLaunchd.pid}` : ""}
          </p>
        ) : null}
        {daemonHealth?.messages?.length ? (
          <div>
            {daemonHealth.messages.slice(0, 3).map((message) => (
              <span key={message}>{message}</span>
            ))}
          </div>
        ) : null}
        {daemonQueueSla ? (
          <p>
            queue SLA queued {daemonQueueSla.queuedCount} · running {daemonQueueSla.runningCount} · expired {daemonQueueSla.expiredRunningCount} · failed {daemonQueueSla.failedCount}
            {daemonQueueSla.oldestQueuedAgeMs ? ` · oldest ${formatRuntimeMs(daemonQueueSla.oldestQueuedAgeMs)}` : ""}
          </p>
        ) : null}
        {daemonQueueSla?.alerts?.length ? (
          <div>
            {daemonQueueSla.alerts.slice(0, 3).map((alert) => (
              <span className={`queue-sla-alert ${alert.severity}`} key={alert.id}>
                {queueSlaSeverityLabel(alert.severity)} · {alert.title}: {alert.summary}
              </span>
            ))}
          </div>
        ) : null}
        {daemonQueueSla?.byTool?.length ? (
          <div>
            {daemonQueueSla.byTool.slice(0, 4).map((item) => (
              <span key={item.toolId}>
                {item.toolId} {item.count}
                {item.queued || item.running || item.failed
                  ? ` · q${item.queued}/r${item.running}/f${item.failed}`
                  : ""}
              </span>
            ))}
          </div>
        ) : null}
        {daemonAlertChannel ? (
          <p>
            alerts {daemonAlertChannel.enabled ? "enabled" : "disabled"} · active {daemonAlertChannel.activeCount} · emitted {daemonAlertChannel.emittedCount} · suppressed {daemonAlertChannel.suppressedCount}
            {daemonAlertChannel.webhookEnabled ? " · webhook on" : " · webhook off"}
            {daemonAlertChannel.lastEmittedAt ? ` · last ${formatRuntimeDate(daemonAlertChannel.lastEmittedAt)}` : ""}
          </p>
        ) : null}
        {daemonAlertChannel?.recentEvents?.length ? (
          <div>
            {daemonAlertChannel.recentEvents.slice(0, 3).map((event) => (
              <span className={`queue-sla-alert ${event.severity}`} key={`${event.fingerprint}-${event.at}`}>
                {workerAlertEventLabel(event.eventType)} · {queueSlaSeverityLabel(event.severity)} · {event.title}
              </span>
            ))}
          </div>
        ) : null}
        {daemonAlertChannel?.lastWebhookError ? <em>webhook {daemonAlertChannel.lastWebhookError}</em> : null}
        {latestDaemon?.supervisor ? (
          <p>
            supervisor {workerDaemonSupervisorStatusLabel(latestDaemon.supervisor.status)} · restarts {latestDaemon.supervisor.restarts ?? 0}
            {latestDaemon.supervisor.workerPid ? ` · worker ${latestDaemon.supervisor.workerPid}` : ""}
            {latestDaemon.supervisor.lastExit
              ? ` · last exit ${latestDaemon.supervisor.lastExit.signal ?? latestDaemon.supervisor.lastExit.code ?? "-"}`
              : ""}
          </p>
        ) : null}
        {latestMaintenance ? (
          <p>
            lease recovery {leaseRecoveryCount} · requeued {latestMaintenance.requeued ?? 0} · failed {latestMaintenance.failedExpired ?? 0} · cancelled {latestMaintenance.cancelled ?? 0} · running {latestMaintenance.stillRunning ?? 0}
          </p>
        ) : null}
        {latestMaintenance?.recoveredRecords?.length ? (
          <div>
            {latestMaintenance.recoveredRecords.slice(0, 3).map((record) => (
              <span key={record.id}>
                lease {record.status} · {record.workerLabel || record.id.slice(0, 8)} · attempt {record.attempt ?? "-"}/{record.maxAttempts ?? "-"}
              </span>
            ))}
          </div>
        ) : null}
        {latestDaemon?.latestRuns.length ? (
          <div>
            {latestDaemon.latestRuns.slice(0, 2).map((entry) => (
              <span key={`${entry.at}-${entry.cycle ?? 0}`}>
                run {entry.cycle ?? "-"} · selected {entry.result?.selected ?? 0} · applied {entry.result?.counts?.applied ?? 0}
              </span>
            ))}
          </div>
        ) : null}
        <div className="worker-daemon-actions">
          <button type="button" disabled={workerDaemonPending} onClick={onRefreshWorkerDaemon}>
            {workerDaemonPending ? "刷新中" : "刷新状态"}
          </button>
          <button type="button" disabled={workerDaemonPending || latestDaemonLive} onClick={() => onWorkerDaemonAction("start")}>
            {workerDaemonPending ? "处理中" : "启动 daemon"}
          </button>
          <button
            type="button"
            disabled={workerDaemonPending || !latestDaemonLive}
            onClick={() => onWorkerDaemonAction("stop", latestDaemon?.heartbeat.daemonId)}
          >
            {workerDaemonPending ? "处理中" : "停止 daemon"}
          </button>
          <button type="button" disabled={workerDaemonPending} onClick={onDrainWorkerDaemon}>
            {workerDaemonPending ? "执行中" : "Drain 当前 trace"}
          </button>
        </div>
        {latestDaemon?.heartbeat.error ? <em>{latestDaemon.heartbeat.error}</em> : null}
      </div>
      {workerDaemonError ? <p className="subagent-resume-error">{workerDaemonError}</p> : null}

      {runEval ? (
        <div className={`agent-run-eval ${runEval.status}`}>
          <div>
            <strong>AgentRunEval · {runEval.score}/100</strong>
            <span>{evalStatusLabel(runEval.status)} · {runEval.version}</span>
          </div>
          <p>{runEval.summary}</p>
          <div className="agent-run-eval-metrics">
            <span>routes {runEval.metrics.completedSearchTaskNodes}/{runEval.metrics.searchTaskNodes}</span>
            <span>boundary {runEval.metrics.boundaryCount}</span>
            <span>
              enforced {runEval.metrics.highRiskToolCalls - runEval.metrics.unenforcedToolCalls}/{runEval.metrics.highRiskToolCalls}
            </span>
            <span>unenforced {runEval.metrics.unenforcedToolCalls}</span>
            <span>violations {runEval.metrics.boundaryViolations}</span>
            <span>guard block {runEval.metrics.blockingGuardrails}</span>
            <span>resume {runEval.metrics.resumeTargets}</span>
          </div>
          {visibleEvalChecks.length ? (
            <div className="agent-run-eval-checks">
              {visibleEvalChecks.map((check) => (
                <em className={check.status} key={check.id}>
                  {evalCategoryLabel(check.category)} · {check.label} · {check.score}: {check.summary}
                </em>
              ))}
            </div>
          ) : (
            <em>当前 v1 检查没有发现阻断或告警。</em>
          )}
        </div>
      ) : null}

      {latestInterrupts.length ? (
        <div className="runtime-interrupt-list">
          {latestInterrupts.map((interrupt) => (
            <div className={`runtime-interrupt ${interrupt.status} ${interrupt.severity}`} key={interrupt.id}>
              <div>
                <strong>{interrupt.title}</strong>
                <span>
                  {interruptStatusLabel(interrupt.status)} · {interruptTypeLabel(interrupt.type)} · {interrupt.mode ?? "soft"} · {interrupt.severity}
                </span>
              </div>
              <p>{interrupt.summary}</p>
              <em>{interrupt.source.label}：{interrupt.source.reason}</em>
              {interrupt.blockedUntil || interrupt.resumeCheckpoint?.targetId ? (
                <div>
                  {interrupt.blockedUntil ? <span>blocked until {interruptBlockedUntilLabel(interrupt.blockedUntil)}</span> : null}
                  {interrupt.resumeCheckpoint?.targetId ? <span>resume {interrupt.resumeCheckpoint.targetId}</span> : null}
                </div>
              ) : null}
              <div>
                {interrupt.requiredActions.slice(0, 4).map((action) => (
                  <span key={action}>{action}</span>
                ))}
              </div>
              {interrupt.artifactIds.length ? (
                <AgentArtifactViewer artifacts={trace.artifacts} artifactIds={interrupt.artifactIds} limit={2} />
              ) : null}
              {interrupt.status === "active" ? (
                <div className="runtime-interrupt-actions">
                  <button
                    type="button"
                    disabled={pendingInterruptId === `${interrupt.id}:queue_resume`}
                    onClick={() => onRuntimeInterrupt(interrupt.id, "queue_resume")}
                  >
                    {pendingInterruptId === `${interrupt.id}:queue_resume` ? "执行中" : "尝试恢复"}
                  </button>
                  <button
                    type="button"
                    disabled={pendingInterruptId === `${interrupt.id}:mark_resolved`}
                    onClick={() => onRuntimeInterrupt(interrupt.id, "mark_resolved")}
                  >
                    已处理
                  </button>
                  <button
                    type="button"
                    disabled={pendingInterruptId === `${interrupt.id}:wait_for_user`}
                    onClick={() => onRuntimeInterrupt(interrupt.id, "wait_for_user")}
                  >
                    稍后处理
                  </button>
                  <button
                    type="button"
                    disabled={pendingInterruptId === `${interrupt.id}:dismiss`}
                    onClick={() => onRuntimeInterrupt(interrupt.id, "dismiss")}
                  >
                    忽略
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {interruptError ? <p className="subagent-resume-error">{interruptError}</p> : null}

      {taskNodes.length ? (
        <div className="subagent-span-list task-graph-list">
          {taskNodes.map((node) => {
            const definition = taskDefinitionsById.get(node.id);
            return (
              <div className={`subagent-span ${node.status}`} key={node.id}>
                <div>
                  <strong>{taskNodeKindLabel(node.kind)}</strong>
                  <span>
                    {runtimeStatusLabel(node.status)} · depends {node.dependsOn.length}
                    {node.execution ? ` · p${node.execution.priority} · try ${node.execution.attempt}/${node.execution.maxAttempts}` : ""}
                  </span>
                </div>
                <p>{node.label}</p>
                <em>{node.outputSummary || node.inputSummary}</em>
                <div>
                  <span>span {node.spanIds.length}</span>
                  <span>worker {node.workerRunIds.length}</span>
                  <span>tool {node.toolCallIds.length}</span>
                  <span>artifact {node.artifactIds.length}</span>
                  <span>handoff {node.handoffIds.length}</span>
                  {node.execution?.concurrencyGroup ? <span>group {node.execution.concurrencyGroup}</span> : null}
                  {definition?.registry ? <span>registry {definition.registry.workerId}</span> : null}
                  {definition?.registry?.memoryScopes.length ? <span>memory {definition.registry.memoryScopes.length}</span> : null}
                  {definition?.registry?.evaluationMetrics.length ? <span>eval {definition.registry.evaluationMetrics.length}</span> : null}
                  {node.execution?.blockedByTaskNodeIds.length ? <span>blocked by {node.execution.blockedByTaskNodeIds.join(" / ")}</span> : null}
                  {node.execution?.freshnessPolicy?.refreshBeforeReport ? <span>freshness</span> : null}
                  {node.metrics?.lastReplayScope ? <span>resume {String(node.metrics.lastReplayScope)}</span> : null}
                </div>
                {node.artifactIds.length ? (
                  <AgentArtifactViewer artifacts={trace.artifacts} artifactIds={node.artifactIds} limit={3} />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {latestQueueItems.length ? (
        <div className="subagent-queue-list">
          {latestQueueItems.map((item) => (
            <div className={`subagent-queue-item ${item.status}`} key={item.id}>
              <div>
                <strong>{item.workerLabel}</strong>
                <span>
                  {workerQueueStatusLabel(item.status)} · p{item.priority} · {item.concurrencyGroup}
                </span>
              </div>
              <p>{item.outputSummary || item.inputSummary}</p>
              <div>
                <span>{item.queueLabel}</span>
                {item.durableQueueId ? <span>durable {shortRuntimeId(item.durableQueueId)}</span> : null}
                {item.taskNodeId ? <span>task {item.taskNodeId}</span> : null}
                {item.workerRunId ? <span>worker linked</span> : null}
                <span>wait {item.waitMs ?? 0}ms</span>
                <span>run {item.latencyMs ?? 0}ms</span>
              </div>
              {item.durableQueueId ? (
                <div className="subagent-queue-actions">
                  {canCancelWorkerQueueItem(item) ? (
                    <button
                      type="button"
                      disabled={pendingWorkerQueueActionId === `${item.durableQueueId}:cancel`}
                      onClick={() => onWorkerQueueAction(item, "cancel")}
                    >
                      {pendingWorkerQueueActionId === `${item.durableQueueId}:cancel` ? "取消中" : "取消"}
                    </button>
                  ) : null}
                  {canRequeueWorkerQueueItem(item) ? (
                    <button
                      type="button"
                      disabled={pendingWorkerQueueActionId === `${item.durableQueueId}:requeue`}
                      onClick={() => onWorkerQueueAction(item, "requeue")}
                    >
                      {pendingWorkerQueueActionId === `${item.durableQueueId}:requeue` ? "重排中" : "重排"}
                    </button>
                  ) : null}
                  {canReplayWorkerQueueItem(item) ? (
                    <button
                      type="button"
                      disabled={pendingWorkerQueueActionId === `${item.durableQueueId}:replay`}
                      onClick={() => onWorkerQueueAction(item, "replay")}
                    >
                      {pendingWorkerQueueActionId === `${item.durableQueueId}:replay` ? "重放中" : "重放"}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {item.errorMessage ? <em>{item.errorMessage}</em> : null}
            </div>
          ))}
        </div>
      ) : null}
      {workerQueueError ? <p className="subagent-resume-error">{workerQueueError}</p> : null}

      <div className="subagent-span-list">
        {latestSpans.map((span) => (
          <div className={`subagent-span ${span.status}`} key={span.id}>
            <div>
              <strong>{subagentLabel(span.subagent)}</strong>
              <span>
                {runtimeStatusLabel(span.status)} · {span.latencyMs ?? 0}ms
              </span>
            </div>
            <p>{span.title}</p>
            <em>{span.outputSummary || span.inputSummary}</em>
            {span.artifactIds.length ? (
              <AgentArtifactViewer
                artifacts={trace.artifacts}
                artifactIds={span.artifactIds}
                limit={4}
              />
            ) : null}
          </div>
        ))}
      </div>

      {latestWorkers.length ? (
        <div className="subagent-worker-list">
          {latestWorkers.map((worker) => (
            <div className={`subagent-worker ${worker.status}`} key={worker.id}>
              <div>
                <strong>{worker.workerLabel}</strong>
                <span>
                  {runtimeStatusLabel(worker.status)} · {worker.executionMode === "subagent_runner" ? "Runner" : "Manual"} · 尝试 {worker.attempt}/{worker.maxAttempts}
                </span>
              </div>
              <p>{worker.outputSummary || worker.inputSummary}</p>
              {worker.failureCode || worker.budgetWarnings?.length ? (
                <p>
                  {worker.failureCode ? `failure ${worker.failureCode}` : ""}
                  {worker.failureCode && worker.budgetWarnings?.length ? " · " : ""}
                  {worker.budgetWarnings?.slice(0, 2).join("；") ?? ""}
                </p>
              ) : null}
              <div>
                <span>query {worker.budgetUsed.searchQueries}/{worker.budget.maxSearchQueries ?? "-"}</span>
                <span>fetch {worker.budgetUsed.fetchUrls}/{worker.budget.maxFetchUrls ?? "-"}</span>
                <span>artifact {worker.budgetUsed.artifacts}</span>
                {worker.runnerVersion ? <span>{worker.runnerVersion}</span> : null}
              </div>
              {worker.executionBoundary ? (
                <div className="subagent-worker-boundary">
                  <span>{worker.executionBoundary.mode}</span>
                  {worker.executionBoundary.boundaryEnforcement ? (
                    <span>boundary {worker.executionBoundary.boundaryEnforcement.status}</span>
                  ) : (
                    <span>boundary legacy</span>
                  )}
                  <span>tools {worker.executionBoundary.allowedTools.join(", ") || "-"}</span>
                  <span>
                    context {worker.executionBoundary.contextBudget.usedInputChars}/{worker.executionBoundary.contextBudget.maxInputChars}
                  </span>
                  <span>
                    input refs {worker.executionBoundary.contextBudget.usedArtifactRefs}/{worker.executionBoundary.contextBudget.maxArtifactRefs}
                  </span>
                  {worker.executionBoundary.contextPackId ? (
                    <span>context {worker.executionBoundary.contextPackId}</span>
                  ) : null}
                  {worker.executionBoundary.droppedInputArtifactIds?.length ? (
                    <span>dropped refs {worker.executionBoundary.droppedInputArtifactIds.length}</span>
                  ) : null}
                  {worker.executionBoundary.contextWarnings?.length ? (
                    <span>warn {worker.executionBoundary.contextWarnings.length}</span>
                  ) : null}
                  {worker.executionBoundary.boundaryEnforcement?.omittedPayloadChars ? (
                    <span>omitted {worker.executionBoundary.boundaryEnforcement.omittedPayloadChars}</span>
                  ) : null}
                  {worker.executionBoundary.boundaryEnforcement?.violations.length ? (
                    <span>violations {worker.executionBoundary.boundaryEnforcement.violations.length}</span>
                  ) : null}
                  {worker.executionBoundary.compressionStrategy ? (
                    <em>{worker.executionBoundary.compressionStrategy}</em>
                  ) : null}
                  {worker.executionBoundary.boundaryArtifactId ? (
                    <AgentArtifactViewer
                      artifacts={trace.artifacts}
                      artifactIds={[worker.executionBoundary.boundaryArtifactId]}
                      limit={1}
                    />
                  ) : null}
                </div>
              ) : null}
              {worker.transcriptArtifactId ? (
                <div className="subagent-worker-boundary">
                  <span>transcript</span>
                  <AgentArtifactViewer
                    artifacts={trace.artifacts}
                    artifactIds={[worker.transcriptArtifactId]}
                    limit={1}
                  />
                </div>
              ) : null}
            </div>
          ))}
          {failedWorkers ? <em>{failedWorkers} 个 worker 失败，报告应降级证据强度。</em> : null}
        </div>
      ) : null}

      {latestToolCalls.length ? (
        <div className="subagent-tool-list">
          {latestToolCalls.map((tool) => {
            const guardCounts = guardrailCounts(tool.guardrails);
            return (
              <div className={`subagent-tool ${tool.status}`} key={tool.id}>
                <div>
                  <strong>{tool.toolLabel}</strong>
                  <span>
                    {runtimeStatusLabel(tool.status)} · {tool.provider || "local"} · {tool.riskLevel}
                  </span>
                </div>
                <p>{tool.outputSummary || tool.inputSummary}</p>
                <div>
                  <span>pass {guardCounts.pass}</span>
                  <span>warn {guardCounts.warn}</span>
                  <span>block {guardCounts.block}</span>
                  <span>cost {tool.costEstimate ?? 0} {tool.costUnit}</span>
                  <span>cache {tool.cacheStatus || "bypass"}</span>
                </div>
                {tool.guardrails.some((guardrail) => guardrail.status !== "pass") ? (
                  <em>
                    {tool.guardrails
                      .filter((guardrail) => guardrail.status !== "pass")
                      .slice(0, 2)
                      .map((guardrail) => `${guardrail.label}: ${guardrail.message}`)
                      .join("；")}
                  </em>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {resumeTargets.length ? (
        <div className="subagent-resume-list">
          {resumeTargets.map((target) => (
            <div className={`subagent-resume ${target.status}`} key={target.id}>
              <div>
                <strong>{target.label}</strong>
                <span>{runtimeStatusLabel(target.status)} · {resumeActionLabel(target.retryAction)}</span>
              </div>
              <p>{target.reason}</p>
              <em>{target.resumeHint}</em>
              <div>
                <span>{target.retryable ? "可重试" : "需人工确认"}</span>
                <span>input {target.inputArtifactIds.length}</span>
                <span>output {target.outputArtifactIds.length}</span>
                {target.cacheKey ? <span>cache {target.cacheStatus || "miss"}</span> : null}
              </div>
              <div className="subagent-resume-actions">
                <button
                  type="button"
                  disabled={pendingResumeId === `${target.id}:queue_retry`}
                  onClick={() => onRuntimeResume(target.id, "queue_retry")}
                >
                  {pendingResumeId === `${target.id}:queue_retry` ? "执行中" : "重试"}
                </button>
                <button
                  type="button"
                  disabled={pendingResumeId === `${target.id}:mark_reviewed`}
                  onClick={() => onRuntimeResume(target.id, "mark_reviewed")}
                >
                  已复核
                </button>
                <button
                  type="button"
                  disabled={pendingResumeId === `${target.id}:skip_until_configured`}
                  onClick={() => onRuntimeResume(target.id, "skip_until_configured")}
                >
                  等配置
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {resumeError ? <p className="subagent-resume-error">{resumeError}</p> : null}

      {latestResumeRequests.length ? (
        <div className="subagent-resume-list">
          {latestResumeRequests.map((request) => (
            <div className={`subagent-resume ${request.status}`} key={request.id}>
              <div>
                <strong>{request.label}</strong>
                <span>
                  {resumeRequestStatusLabel(request.status)} · {resumeExecutionModeLabel(request.executionMode)}
                </span>
              </div>
              <p>{request.resultSummary}</p>
              <em>{request.reason}</em>
              <div>
                <span>{resumeRequestActionLabel(request.action)}</span>
                <span>{request.targetKind}</span>
                {request.taskNodeId ? <span>task {request.taskNodeId}</span> : null}
                {request.artifactIds.length ? <span>artifact {request.artifactIds.length}</span> : null}
              </div>
              {request.impact ? (
                <div>
                  <span>scope {resumeImpactScopeLabel(request.impact.replayScope)}</span>
                  {request.impact.sourceTaskNodeId ? <span>source {request.impact.sourceTaskNodeId}</span> : null}
                  {request.impact.downstreamTaskNodeIds.length ? (
                    <span>downstream {request.impact.downstreamTaskNodeIds.join(" / ")}</span>
                  ) : null}
                  {request.impact.recomputed.length ? (
                    <span>recomputed {request.impact.recomputed.join(" / ")}</span>
                  ) : null}
                </div>
              ) : null}
              {request.limitations.length ? <em>{request.limitations.slice(0, 2).join("；")}</em> : null}
            </div>
          ))}
        </div>
      ) : null}

      {latestHandoff ? (
        <div className="subagent-handoff">
          <strong>
            {subagentLabel(latestHandoff.from)} → {latestHandoff.to === "main_agent" ? "主 Agent" : subagentLabel(latestHandoff.to)}
          </strong>
          <p>{latestHandoff.contextSummary}</p>
          {latestHandoff.acceptedInputSummary ? (
            <em>{latestHandoff.acceptedInputSummary}</em>
          ) : null}
          <div className="handoff-v2-grid">
            {latestHandoff.keyFindings?.length ? (
              <HandoffBoundaryBlock title="Key Findings" items={latestHandoff.keyFindings} />
            ) : null}
            {latestHandoff.uncertainties?.length ? (
              <HandoffBoundaryBlock title="Uncertainties" items={latestHandoff.uncertainties} />
            ) : null}
            {latestHandoff.forbiddenClaims?.length ? (
              <HandoffBoundaryBlock title="Forbidden Claims" items={latestHandoff.forbiddenClaims} />
            ) : null}
          </div>
          {latestHandoff.contextBudget ? (
            <small className="handoff-budget">
              context {latestHandoff.contextBudget.usedSummaryChars}/{latestHandoff.contextBudget.maxSummaryChars} chars · artifact {latestHandoff.contextBudget.usedArtifactRefs}/{latestHandoff.contextBudget.maxArtifactRefs} · evidence {latestHandoff.contextBudget.usedEvidenceRefs}/{latestHandoff.contextBudget.maxEvidenceRefs}
            </small>
          ) : null}
          {latestHandoff.nextActions.length ? (
            <div>
              {latestHandoff.nextActions.slice(0, 3).map((action) => (
                <span key={action}>{action}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {trace.stateSnapshots?.length ? (
        <div className="runtime-snapshot-strip">
          {trace.stateSnapshots.slice(-4).map((snapshot) => (
            <span className={snapshot.status} key={snapshot.id}>
              {snapshot.label} · {runtimeStatusLabel(snapshot.status)}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function HandoffBoundaryBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="handoff-v2-block">
      <strong>{title}</strong>
      {items.slice(0, 4).map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
}

function guardrailCounts(guardrails: AgentToolGuardrailResult[]) {
  return guardrails.reduce(
    (counts, guardrail) => ({
      ...counts,
      [guardrail.status]: counts[guardrail.status] + 1
    }),
    { pass: 0, warn: 0, block: 0 }
  );
}

function JudgeVerdictSection({ verdict }: { verdict: AgentJudgeVerdict }) {
  return (
    <section className={`harness-section judge-verdict-section ${verdict.status}`}>
      <h2>Judge Agent</h2>
      <div className="judge-verdict-head">
        <div>
          <span>{judgeStatusLabel(verdict.status)}</span>
          <strong>{verdict.confidenceCap}</strong>
          <small>置信上限</small>
        </div>
        <div>
          <span>报告强度</span>
          <strong>{judgeStrengthLabel(verdict.allowedReportStrength)}</strong>
          <small>{judgeDecisionLabel(verdict.decision)}</small>
        </div>
      </div>
      <p>{verdict.summary}</p>
      <div className="judge-metrics">
        <span>证据 {verdict.metrics.evidenceCards}</span>
        <span>外部 {verdict.metrics.externalEvidence}</span>
        <span>反证 {verdict.metrics.oppositionEvidence}</span>
        <span>预算 {verdict.metrics.sourceBudgetScore}</span>
        <span>搜索 {verdict.metrics.searchQualityScore}</span>
      </div>
      {verdict.reasons.length ? (
        <div className="judge-reason-list">
          {verdict.reasons.slice(0, 5).map((reason) => (
            <div className={`judge-reason ${reason.severity}`} key={reason.id}>
              <strong>{reason.finding}</strong>
              <p>{reason.evidence}</p>
              <em>{reason.requiredAction}</em>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function subagentLabel(subagent: AgentRuntimeSubagentId) {
  if (subagent === "research_supervisor") return "Research Supervisor";
  if (subagent === "query_planner") return "Query Planner";
  if (subagent === "support_search_worker") return "Support Search Worker";
  if (subagent === "search_worker") return "Search Worker";
  if (subagent === "web_fetch_worker") return "Web Fetch Worker";
  if (subagent === "evidence_extractor") return "Evidence Extractor";
  if (subagent === "opposition_scout") return "Opposition Scout";
  if (subagent === "freshness_worker") return "Freshness Worker";
  if (subagent === "competitor_worker") return "Competitor Worker";
  if (subagent === "code_executor") return "Code Executor";
  if (subagent === "report_composer") return "Report Composer";
  return "Judge Agent";
}

function judgeStatusLabel(status: AgentJudgeVerdict["status"]) {
  if (status === "pass") return "通过";
  if (status === "warn") return "警告";
  return "阻断";
}

function judgeStrengthLabel(strength: AgentJudgeVerdict["allowedReportStrength"]) {
  if (strength === "strong") return "强";
  if (strength === "moderate") return "中";
  return "探索";
}

function judgeDecisionLabel(decision: AgentJudgeVerdict["decision"]) {
  if (decision === "continue_research") return "继续补查";
  if (decision === "needs_user_evidence") return "需用户证据";
  if (decision === "block_strong_decision") return "阻断强决策";
  return "可生成报告";
}

function taskNodeKindLabel(kind: NonNullable<AgentRuntimeTrace["taskGraph"]>["nodes"][number]["kind"]) {
  if (kind === "research_supervisor") return "调研编排";
  if (kind === "material_fetch") return "材料抓取";
  if (kind === "query_plan") return "查询规划";
  if (kind === "support_search") return "正向搜索";
  if (kind === "opposition_search") return "反证搜索";
  if (kind === "freshness_search") return "时效搜索";
  if (kind === "competitor_search") return "竞品搜索";
  if (kind === "result_fetch") return "正文抓取";
  if (kind === "evidence_extract") return "证据交接";
  if (kind === "code_execute") return "代码执行";
  if (kind === "judge") return "证据审判";
  if (kind === "report") return "报告生成";
  if (kind === "evidence_loop") return "自动补证";
  return "后验调研";
}

function runtimeStatusLabel(status: "pending" | "queued" | "running" | "completed" | "failed" | "skipped" | "blocked" | "interrupted" | "cancelled") {
  if (status === "pending") return "等待";
  if (status === "queued") return "排队";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "skipped") return "跳过";
  if (status === "blocked") return "阻断";
  if (status === "interrupted") return "等待用户";
  if (status === "cancelled") return "取消";
  return "运行中";
}

function evalStatusLabel(status: NonNullable<AgentRuntimeTrace["runEval"]>["status"]) {
  if (status === "pass") return "通过";
  if (status === "warn") return "告警";
  return "阻断";
}

function evalCategoryLabel(category: NonNullable<AgentRuntimeTrace["runEval"]>["checks"][number]["category"]) {
  if (category === "coverage") return "覆盖";
  if (category === "evidence") return "证据";
  if (category === "context") return "上下文";
  if (category === "security") return "安全";
  if (category === "recovery") return "恢复";
  if (category === "efficiency") return "效率";
  if (category === "judge") return "裁决";
  return "版本";
}

function resumeRequestStatusLabel(status: AgentRuntimeResumeRequest["status"]) {
  if (status === "queued") return "已排队";
  if (status === "applied") return "已应用";
  if (status === "blocked") return "被阻断";
  return "暂不支持";
}

function resumeExecutionModeLabel(mode: AgentRuntimeResumeRequest["executionMode"]) {
  if (mode === "auto_replay") return "自动重放";
  return "控制面记录";
}

function resumeRequestActionLabel(action: AgentRuntimeResumeAction) {
  if (action === "queue_retry") return "请求重试";
  if (action === "mark_reviewed") return "人工复核";
  return "等待配置";
}

function resumeImpactScopeLabel(scope: NonNullable<AgentRuntimeResumeRequest["impact"]>["replayScope"]) {
  if (scope === "worker") return "worker";
  if (scope === "task_node") return "task";
  if (scope === "evidence_extract") return "evidence";
  if (scope === "terminal") return "terminal";
  return "control";
}

function workerQueueStatusLabel(status: NonNullable<AgentRuntimeTrace["workerQueue"]>[number]["status"]) {
  if (status === "queued") return "排队";
  if (status === "running") return "运行";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "skipped") return "跳过";
  return "取消";
}

function workerDaemonStatusLabel(status: string) {
  if (status === "starting") return "启动中";
  if (status === "running") return "运行中";
  if (status === "idle") return "空闲";
  if (status === "stopped") return "已停止";
  if (status === "failed") return "失败";
  return status || "未知";
}

function workerDaemonSupervisorStatusLabel(status: string) {
  if (status === "starting") return "启动中";
  if (status === "running") return "托管中";
  if (status === "restarting") return "重启中";
  if (status === "stopping") return "停止中";
  if (status === "stopped") return "已停止";
  if (status === "failed") return "失败";
  return status || "未知";
}

function workerDaemonHealthLabel(status: string) {
  if (status === "healthy") return "健康";
  if (status === "degraded") return "降级";
  if (status === "down") return "离线";
  return "未知";
}

function queueSlaSeverityLabel(severity: string) {
  if (severity === "critical") return "阻断";
  if (severity === "warning") return "告警";
  return "信息";
}

function workerAlertEventLabel(eventType: string) {
  if (eventType === "emitted") return "已发送";
  if (eventType === "resolved") return "已恢复";
  if (eventType === "suppressed") return "冷却";
  return eventType || "事件";
}

function formatRuntimeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatRuntimeMs(value: number) {
  if (!Number.isFinite(value)) return "-";
  if (value < 1000) return `${Math.max(0, Math.round(value))}ms`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value / 60_000)}m`;
}

function canCancelWorkerQueueItem(item: AgentWorkerQueueItem) {
  return item.status === "queued" || item.status === "running";
}

function canRequeueWorkerQueueItem(item: AgentWorkerQueueItem) {
  return item.status === "failed" || item.status === "skipped";
}

function canReplayWorkerQueueItem(item: AgentWorkerQueueItem) {
  return item.status === "queued" || item.status === "failed" || item.status === "skipped";
}

function optimisticWorkerQueueStatus(action: WorkerQueueAction): AgentWorkerQueueItem["status"] {
  if (action === "cancel") return "cancelled";
  if (action === "requeue") return "queued";
  return "running";
}

function workerQueueActionReason(action: WorkerQueueAction) {
  if (action === "cancel") return "用户在运行账本中请求取消 worker。";
  if (action === "requeue") return "用户在运行账本中请求重新入队 worker。";
  return "用户在运行账本中请求重放 durable worker。";
}

function workerQueueActionOptimisticSummary(action: WorkerQueueAction) {
  if (action === "cancel") return "已请求取消该 worker。";
  if (action === "requeue") return "已请求重新入队该 worker。";
  return "已请求重放该 durable worker。";
}

function shortRuntimeId(value: string) {
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function interruptStatusLabel(status: NonNullable<AgentRuntimeTrace["interrupts"]>[number]["status"]) {
  if (status === "active") return "等待用户";
  if (status === "resolved") return "已解决";
  return "已忽略";
}

function interruptTypeLabel(type: NonNullable<AgentRuntimeTrace["interrupts"]>[number]["type"]) {
  if (type === "needs_search_key") return "缺搜索 key";
  if (type === "needs_material") return "需材料";
  if (type === "approve_deep_research") return "需批准深查";
  if (type === "clarify_target_user") return "需明确用户";
  if (type === "confirm_competitor_set") return "需确认竞品";
  return "证据不足";
}

function interruptBlockedUntilLabel(value: NonNullable<AgentRuntimeTrace["interrupts"]>[number]["blockedUntil"]) {
  if (value === "configuration") return "配置";
  if (value === "approval") return "批准";
  if (value === "material") return "材料";
  return "用户动作";
}

function resumeActionLabel(action: NonNullable<AgentRuntimeTrace["resumePlan"]>["targets"][number]["retryAction"]) {
  if (action === "retry_worker") return "重试 worker";
  if (action === "retry_tool") return "重试工具";
  if (action === "provide_key") return "补 key";
  if (action === "provide_evidence") return "补材料";
  return "审 guardrail";
}

function recencyLabel(bucket: EvidenceCard["recencyBucket"]) {
  if (bucket === "fresh") return "新鲜";
  if (bucket === "usable") return "可用";
  if (bucket === "historical") return "历史";
  return "日期未知";
}

function intentLabel(intent: EvidenceSearchIntent) {
  if (intent === "problem") return "痛点";
  if (intent === "payment") return "付费";
  if (intent === "alternative") return "替代";
  if (intent === "competitor_review") return "评价";
  if (intent === "distribution") return "分发";
  if (intent === "opposition") return "反证";
  if (intent === "recency") return "时效";
  return "AI 优势";
}

function searchProviderLabel(provider: EvidenceQueryExecution["provider"] | undefined) {
  if (provider === "zhipu") return "智谱";
  if (provider === "serper") return "Serper";
  return "搜索";
}

function queryExecutionLabel(
  status: EvidenceQueryExecution["status"] | undefined
) {
  if (status === "executed") return "已执行";
  if (status === "skipped") return "跳过";
  if (status === "failed") return "失败";
  return "计划";
}

function queryPhaseLabel(phase: EvidenceQueryExecution["phase"] | undefined) {
  if (phase === "evidence_loop") return "自动补证";
  if (phase === "budget_fill") return "补查";
  return "首轮";
}

function researchLoopStatusLabel(status: "executed" | "skipped" | "failed" | "stopped") {
  if (status === "executed") return "已执行";
  if (status === "failed") return "失败";
  if (status === "skipped") return "已跳过";
  return "已停止";
}

function formatTimestamp(value: string) {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function revisionDiff(revision: ReportRewriteRevision): ReportRewriteDiffLine[] {
  if (revision.diff?.length) return revision.diff;
  return fallbackRevisionDiff(revision.beforeText, revision.afterText);
}

function fallbackRevisionDiff(
  beforeText: string,
  afterText: string
): ReportRewriteDiffLine[] {
  const beforeLines = splitRevisionLines(beforeText);
  const afterLines = splitRevisionLines(afterText);
  if (!beforeLines.length && !afterLines.length) return [];
  if (beforeText.trim() === afterText.trim()) {
    return beforeLines.map((text) => ({ type: "unchanged", text }));
  }
  return [
    ...beforeLines.slice(0, 8).map((text) => ({ type: "removed" as const, text })),
    ...afterLines.slice(0, 12).map((text) => ({ type: "added" as const, text }))
  ];
}

function splitRevisionLines(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function diffPrefix(type: ReportRewriteDiffLine["type"]) {
  if (type === "added") return "+";
  if (type === "removed") return "-";
  return " ";
}

function normalizedOcrConfidence(value: number | undefined) {
  if (!Number.isFinite(value) || !value) return 0;
  return value > 1 ? Math.min(1, value / 100) : Math.min(1, value);
}

function isTextMaterial(material: { name: string; type: string }) {
  const lower = material.name.toLowerCase();
  return (
    material.type.startsWith("text/") ||
    lower.endsWith(".md") ||
    lower.endsWith(".mdx") ||
    lower.endsWith(".txt") ||
    lower === "readme"
  );
}

function materialLabel(material?: { name: string; type: string }) {
  if (!material) return "TXT";
  const lower = material.name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx") || lower === "readme") {
    return "MD";
  }
  if (lower.endsWith(".txt") || material.type === "text/plain") return "TXT";
  return "DOC";
}

function fileKindLabel(file: File) {
  const lower = file.name.toLowerCase();
  if (file.type === "application/pdf" || lower.endsWith(".pdf")) return "PDF";
  if (lower.endsWith(".md") || lower.endsWith(".mdx") || lower === "readme") return "MD";
  if (isFollowUpTextFile(file)) return "TXT";
  return "IMG";
}

function isAllowedFollowUpFile(file: File) {
  return (
    isFollowUpImageFile(file) ||
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf") ||
    isFollowUpTextFile(file)
  );
}

type ReportDraftStreamPayload = {
  type?: "progress" | "complete" | "error";
  stage?: string;
  status?: string;
  title?: string;
  summary?: string;
  message?: string;
  draftId?: string;
};

type QualityResearchStreamPayload = ReportDraftStreamPayload & {
  queryCount?: number;
  resultCount?: number;
  crawledCount?: number;
  confidenceBefore?: number;
  confidenceAfter?: number;
  qualityScore?: number;
};

async function runReportDraftStream(
  url: string,
  onEvent: (event: ReportDraftRunEvent) => void
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action: "generate" })
  });

  if (!response.body) {
    const result = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      throw new Error(result?.error || "生成新版报告草案失败");
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      handleReportDraftStreamPayload(parseReportDraftStreamPayload(line), onEvent);
    }
  }

  if (buffer.trim()) {
    handleReportDraftStreamPayload(parseReportDraftStreamPayload(buffer), onEvent);
  }

  if (!response.ok) {
    throw new Error("生成新版报告草案失败");
  }
}

async function runQualityResearchStream(
  url: string,
  issueId: string,
  onEvent: (event: QualityResearchRunEvent) => void
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ issueId })
  });

  if (!response.body) {
    const result = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      throw new Error(result?.error || "质检补证失败");
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      handleQualityResearchStreamPayload(parseQualityResearchStreamPayload(line), onEvent);
    }
  }

  if (buffer.trim()) {
    handleQualityResearchStreamPayload(parseQualityResearchStreamPayload(buffer), onEvent);
  }

  if (!response.ok) {
    throw new Error("质检补证失败");
  }
}

function parseReportDraftStreamPayload(line: string): ReportDraftStreamPayload | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as ReportDraftStreamPayload;
  } catch {
    return null;
  }
}

function parseQualityResearchStreamPayload(line: string): QualityResearchStreamPayload | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as QualityResearchStreamPayload;
  } catch {
    return null;
  }
}

function handleReportDraftStreamPayload(
  payload: ReportDraftStreamPayload | null,
  onEvent: (event: ReportDraftRunEvent) => void
) {
  if (!payload) return;
  if (payload.type === "error") {
    throw new Error(payload.message || "生成新版报告草案失败");
  }
  if (payload.type === "complete") {
    onEvent({
      stage: "save",
      status: "completed",
      title: "草案生成完成",
      summary: payload.summary || "新版报告草案已保存。",
      draftId: payload.draftId
    });
    return;
  }
  if (
    !payload.stage ||
    !payload.title ||
    !payload.status ||
    !isReportDraftRunStatus(payload.status)
  ) {
    return;
  }

  onEvent({
    stage: payload.stage,
    status: payload.status,
    title: payload.title,
    summary: payload.summary || "",
    draftId: payload.draftId
  });
}

function handleQualityResearchStreamPayload(
  payload: QualityResearchStreamPayload | null,
  onEvent: (event: QualityResearchRunEvent) => void
) {
  if (!payload) return;
  if (payload.type === "error") {
    throw new Error(payload.message || "质检补证失败");
  }
  if (payload.type === "complete") {
    onEvent({
      stage: "save",
      status: "completed",
      title: "补证完成",
      summary:
        typeof payload.confidenceBefore === "number" &&
        typeof payload.confidenceAfter === "number"
          ? `证据置信 ${payload.confidenceBefore} -> ${payload.confidenceAfter}，新增候选结果 ${payload.resultCount ?? 0} 条。`
          : "补证结果已保存。",
      resultCount: payload.resultCount,
      confidenceBefore: payload.confidenceBefore,
      confidenceAfter: payload.confidenceAfter,
      qualityScore: payload.qualityScore
    });
    return;
  }
  if (
    !payload.stage ||
    !payload.title ||
    !payload.status ||
    !isReportDraftRunStatus(payload.status)
  ) {
    return;
  }

  onEvent({
    stage: payload.stage,
    status: payload.status,
    title: payload.title,
    summary: payload.summary || "",
    queryCount: payload.queryCount,
    resultCount: payload.resultCount,
    crawledCount: payload.crawledCount,
    confidenceBefore: payload.confidenceBefore,
    confidenceAfter: payload.confidenceAfter,
    qualityScore: payload.qualityScore
  });
}

function isReportDraftRunStatus(
  status: string
): status is ReportDraftRunEvent["status"] {
  return status === "running" || status === "completed" || status === "failed" || status === "skipped";
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isFollowUpImageFile(file: File) {
  return /^image\//.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
}

function isFollowUpTextFile(file: File) {
  const lower = file.name.toLowerCase();
  return (
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    /\.(md|mdx|txt|csv|tsv|json)$/i.test(lower) ||
    lower === "readme"
  );
}

function QualityBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="quality-bar">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <i style={{ width: `${Math.max(8, Math.min(100, value))}%` }} />
    </div>
  );
}

function EvidenceVisibilityMetric({
  label,
  value,
  detail
}: {
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function buildEvidenceVisibility(webResearch: NonNullable<AnalysisRecord["webResearch"]>) {
  const crawledBody = webResearch.crawled.filter(isCrawledBodyEvidence);
  const failedCrawls = webResearch.crawled.filter(isFailedCrawlEvidence);
  const githubMetricCount = webResearch.searchResults.filter(
    (item) => item.sourceType === "github_repository"
  ).length;
  const searchSummaries = webResearch.searchResults.filter(
    (item) => item.sourceType === "search_result"
  );
  const urlMissing = searchSummaries.filter((item) => !item.url);
  const queryExecutions = webResearch.queryExecutions ?? [];
  const queryPlan = webResearch.queryPlan ?? [];
  const executedCount = queryExecutions.filter((item) => item.status === "executed").length;
  const skippedCount = queryExecutions.filter((item) => item.status === "skipped").length;
  const failedCount = queryExecutions.filter((item) => item.status === "failed").length;
  const plannedCount = Math.max(0, queryPlan.length - queryExecutions.length);
  const failedOrSkippedCount = skippedCount + failedCount + failedCrawls.length;
  const notes = [
    crawledBody.length
      ? `已抓取 ${crawledBody.length} 个网页正文，优先作为公开证据。`
      : "没有可用网页正文，报告应降低外部证据置信。",
    urlMissing.length
      ? `${urlMissing.length} 条搜索摘要缺少 URL，只能作为低置信方向。`
      : "",
    failedOrSkippedCount
      ? `${failedOrSkippedCount} 个查询或抓取失败/跳过，不能计入证据。`
      : "",
    plannedCount
      ? `${plannedCount} 条查询仍是计划状态，不能当作已经查到的证据。`
      : ""
  ].filter(Boolean);
  const examples = [
    ...crawledBody.slice(0, 2).map((item) => visibilityExample(item, "正文", "body" as const)),
    ...searchSummaries
      .filter((item) => item.url)
      .slice(0, 2)
      .map((item) => visibilityExample(item, "摘要", "summary" as const)),
    ...urlMissing.slice(0, 1).map((item) => visibilityExample(item, "无 URL 摘要", "summary" as const))
  ];

  return {
    crawledBodyCount: crawledBody.length,
    searchSummaryCount: searchSummaries.length,
    urlMissingCount: urlMissing.length,
    githubMetricCount,
    executedCount,
    skippedCount,
    failedCount,
    plannedCount,
    failedOrSkippedCount,
    notes,
    examples
  };
}

function visibilityExample(
  item: WebEvidence,
  kind: string,
  icon: "body" | "summary"
) {
  return {
    kind,
    icon,
    title: item.title,
    url: item.url
  };
}

function isCrawledBodyEvidence(item: WebEvidence) {
  return (
    item.sourceType === "crawled_url" &&
    Boolean(item.url) &&
    !isFailedCrawlEvidence(item) &&
    item.snippet.trim().length >= 120
  );
}

function isFailedCrawlEvidence(item: WebEvidence) {
  return /^(无法读取网页正文|抓取失败)/.test(item.snippet);
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
) {
  const words = text.split(/\s+/);
  let line = "";

  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = word;
      y += lineHeight;
    } else {
      line = testLine;
    }
  }

  if (line) {
    ctx.fillText(line, x, y);
  }
}
