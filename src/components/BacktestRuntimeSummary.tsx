"use client";

import { AgentArtifactViewer } from "@/components/AgentArtifactViewer";
import type {
  AgentRuntimeSubagentId,
  AgentTaskNodeKind,
  AgentWorkerQueueItem,
  DynamicBacktestRecord
} from "@/lib/types";

export function BacktestRuntimeSummary({ backtest }: { backtest: DynamicBacktestRecord }) {
  const traces = backtest.posterior.runtimeTraces ?? [];
  if (!traces.length) return null;

  const spanCount = traces.reduce((sum, item) => sum + item.trace.spans.length, 0);
  const workerCount = traces.reduce((sum, item) => sum + (item.trace.workerRuns?.length ?? 0), 0);
  const queueCount = traces.reduce((sum, item) => sum + (item.trace.workerQueue?.length ?? 0), 0);
  const interruptCount = traces.reduce((sum, item) => sum + (item.trace.interrupts?.length ?? 0), 0);
  const artifactCount = traces.reduce((sum, item) => sum + item.trace.artifacts.length, 0);
  const handoffCount = traces.reduce((sum, item) => sum + item.trace.handoffs.length, 0);
  const snapshotCount = traces.reduce((sum, item) => sum + (item.trace.stateSnapshots?.length ?? 0), 0);
  const toolCount = traces.reduce((sum, item) => sum + (item.trace.toolCalls?.length ?? 0), 0);
  const blockedToolCount = traces.reduce(
    (sum, item) => sum + (item.trace.toolCalls?.filter((tool) => tool.status === "blocked").length ?? 0),
    0
  );
  const retryableCount = traces.reduce((sum, item) => sum + (item.trace.resumePlan?.retryableCount ?? 0), 0);
  const cacheHitCount = traces.reduce(
    (sum, item) => sum + (item.trace.toolCalls?.filter((tool) => tool.cacheStatus === "hit").length ?? 0),
    0
  );
  const boundaryCount = traces.reduce(
    (sum, item) => sum + (item.trace.workerRuns?.filter((run) => run.executionBoundary).length ?? 0),
    0
  );
  const taskCount = traces.reduce((sum, item) => sum + (item.trace.taskGraph?.nodes.length ?? 0), 0);
  const evals = traces.map((item) => item.trace.runEval).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const averageEvalScore = evals.length
    ? Math.round(evals.reduce((sum, item) => sum + item.score, 0) / evals.length)
    : null;

  return (
    <details className="blind-runtime backtest-runtime-summary">
      <summary>
        Subagent 运行账本 · {taskCount} task · {spanCount} span · {workerCount} worker · {boundaryCount} boundary · {toolCount} tool · {blockedToolCount} blocked · {retryableCount} retry · {cacheHitCount} cache · {artifactCount} artifact · {handoffCount} handoff · {snapshotCount} snapshot
        {queueCount ? ` · ${queueCount} queue` : ""}
        {interruptCount ? ` · ${interruptCount} interrupt` : ""}
        {averageEvalScore !== null ? ` · eval ${averageEvalScore}` : ""}
      </summary>
      <div className="blind-runtime-grid">
        {traces.map((item) => {
          const latestHandoff = item.trace.handoffs[item.trace.handoffs.length - 1];
          const failedSpans = item.trace.spans.filter((span) => span.status === "failed").length;
          const failedWorkers = (item.trace.workerRuns ?? []).filter((run) => run.status === "failed").length;
          const providerBoundaries = item.trace.workerRuns?.filter((run) => run.executionBoundary).length ?? 0;
          const providerQueueCount = item.trace.workerQueue?.length ?? 0;
          const providerInterruptCount = item.trace.interrupts?.length ?? 0;
          const providerBlockedTools = item.trace.toolCalls?.filter((tool) => tool.status === "blocked").length ?? 0;
          const providerRetryable = item.trace.resumePlan?.retryableCount ?? 0;
          const executor = item.trace.taskGraph?.executor;
          const runEval = item.trace.runEval;
          const transcriptArtifactIds =
            item.trace.workerRuns
              ?.map((worker) => worker.transcriptArtifactId)
              .filter((id): id is string => Boolean(id))
              .slice(-3) ?? [];
          const latestTaskNodes = item.trace.taskGraph?.nodes.slice(-5) ?? [];
          return (
            <div className="blind-runtime-provider backtest-runtime-provider" key={item.provider}>
              <strong>{item.provider === "zhipu" ? "智谱" : "Serper"}</strong>
              <span>
                {item.trace.taskGraph?.nodes.length ?? 0} task · {item.trace.spans.length} span · {item.trace.workerRuns?.length ?? 0} worker · {providerQueueCount} queue · {providerInterruptCount} interrupt · {providerBoundaries} boundary · {item.trace.toolCalls?.length ?? 0} tool · blocked {providerBlockedTools} · retry {providerRetryable} · 失败 {failedSpans + failedWorkers}
              </span>
              {runEval ? (
                <span>
                  eval {runEval.score}/100 · {runEval.status} · block {runEval.blockers.length} · warn {runEval.warnings.length}
                </span>
              ) : null}
              {executor ? (
                <span>
                  executor {executor.readyNodeIds.length} ready · {executor.queuedNodeIds.length} queued · {executor.blockedNodeIds.length} blocked
                </span>
              ) : null}
              {item.trace.stateSnapshots?.length ? (
                <span>恢复锚点 {item.trace.stateSnapshots.length}</span>
              ) : null}
              {latestHandoff ? <p>{latestHandoff.contextSummary}</p> : null}
              {latestHandoff?.keyFindings?.length || latestHandoff?.forbiddenClaims?.length ? (
                <p>
                  Handoff v2：{latestHandoff.keyFindings?.length ?? 0} findings · {latestHandoff.uncertainties?.length ?? 0} uncertainties · {latestHandoff.forbiddenClaims?.length ?? 0} forbidden
                </p>
              ) : null}
              <div>
                {item.trace.spans.slice(-3).map((span) => (
                  <em key={span.id}>
                    {runtimeSubagentLabel(span.subagent)} · {runtimeStatusLabel(span.status)}
                  </em>
                ))}
              </div>
              {latestTaskNodes.length ? (
                <div>
                  {latestTaskNodes.map((node) => (
                    <em key={node.id}>
                      {taskNodeKindLabel(node.kind)} · {runtimeStatusLabel(node.status)} · worker {node.workerRunIds.length}
                    </em>
                  ))}
                </div>
              ) : null}
              {item.trace.interrupts?.length ? (
                <div>
                  {item.trace.interrupts.slice(-3).map((interrupt) => (
                    <em key={interrupt.id}>
                      {interrupt.title} · {interrupt.status} · {interrupt.severity}
                    </em>
                  ))}
                </div>
              ) : null}
              {item.trace.workerQueue?.length ? (
                <div>
                  {item.trace.workerQueue.slice(-3).map((queueItem) => (
                    <em key={queueItem.id}>
                      {queueItem.workerLabel} · {queueStatusLabel(queueItem.status)} · wait {queueItem.waitMs ?? 0}ms · run {queueItem.latencyMs ?? 0}ms
                    </em>
                  ))}
                </div>
              ) : null}
              {item.trace.workerRuns?.length ? (
                <div>
                  {item.trace.workerRuns.slice(-3).map((worker) => (
                    <em key={worker.id}>
                      {worker.workerLabel} · {runtimeStatusLabel(worker.status)} · {worker.executionMode === "subagent_runner" ? "Runner" : "Manual"} · query {worker.budgetUsed.searchQueries} · tools {worker.executionBoundary?.allowedTools.join(", ") || "-"} · boundary {worker.executionBoundary?.boundaryEnforcement?.status ?? "legacy"} · ctx {worker.executionBoundary?.contextWarnings?.length ?? 0}
                    </em>
                  ))}
                </div>
              ) : null}
              {transcriptArtifactIds.length ? (
                <div>
                  <em>执行记录 · {transcriptArtifactIds.length}</em>
                  <AgentArtifactViewer
                    artifacts={item.trace.artifacts}
                    artifactIds={transcriptArtifactIds}
                    limit={3}
                  />
                </div>
              ) : null}
              {item.trace.toolCalls?.length ? (
                <div>
                  {item.trace.toolCalls.slice(-3).map((tool) => (
                    <em key={tool.id}>
                      {tool.toolLabel} · {runtimeStatusLabel(tool.status)} · guard {tool.guardrails.filter((guardrail) => guardrail.status !== "pass").length} · cache {tool.cacheStatus || "bypass"}
                    </em>
                  ))}
                </div>
              ) : null}
              {item.trace.resumePlan?.targets.length ? (
                <div>
                  {item.trace.resumePlan.targets.slice(-3).map((target) => (
                    <em key={target.id}>
                      {target.label} · {runtimeStatusLabel(target.status)} · {target.retryable ? "可重试" : "需确认"}
                    </em>
                  ))}
                </div>
              ) : null}
              <AgentArtifactViewer artifacts={item.trace.artifacts} limit={4} />
            </div>
          );
        })}
      </div>
    </details>
  );
}

function queueStatusLabel(status: AgentWorkerQueueItem["status"]) {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "cancelled";
}

function runtimeSubagentLabel(subagent: AgentRuntimeSubagentId) {
  if (subagent === "research_supervisor") return "Supervisor";
  if (subagent === "query_planner") return "Planner";
  if (subagent === "support_search_worker") return "Support";
  if (subagent === "search_worker") return "Search";
  if (subagent === "web_fetch_worker") return "Fetch";
  if (subagent === "evidence_extractor") return "Extract";
  if (subagent === "opposition_scout") return "Opposition";
  if (subagent === "freshness_worker") return "Freshness";
  if (subagent === "competitor_worker") return "Competitor";
  if (subagent === "code_executor") return "Code";
  if (subagent === "report_composer") return "Report";
  return "Judge";
}

function taskNodeKindLabel(kind: AgentTaskNodeKind) {
  if (kind === "research_supervisor") return "Supervisor";
  if (kind === "material_fetch") return "Material";
  if (kind === "query_plan") return "Plan";
  if (kind === "support_search") return "Support";
  if (kind === "opposition_search") return "Opposition";
  if (kind === "freshness_search") return "Freshness";
  if (kind === "competitor_search") return "Competitor";
  if (kind === "result_fetch") return "Fetch";
  if (kind === "evidence_extract") return "Extract";
  if (kind === "code_execute") return "Code";
  if (kind === "judge") return "Judge";
  if (kind === "report") return "Report";
  if (kind === "evidence_loop") return "Loop";
  return "Posterior";
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
