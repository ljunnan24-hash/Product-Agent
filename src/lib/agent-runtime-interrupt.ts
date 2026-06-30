import { runRuntimeResume } from "./agent-runtime-resume";
import type {
  AgentRunInterrupt,
  AgentRunInterruptAction,
  AgentRuntimeTrace,
  AnalysisRecord
} from "./types";

export type RuntimeInterruptInput = {
  interruptId: string;
  action: AgentRunInterruptAction;
  note?: string;
};

export type RuntimeInterruptResult = {
  record: AnalysisRecord;
  interrupt: AgentRunInterrupt;
};

export async function handleRuntimeInterrupt(
  record: AnalysisRecord,
  input: RuntimeInterruptInput
): Promise<RuntimeInterruptResult> {
  const trace = record.webResearch?.runtimeTrace;
  if (!trace) {
    throw new Error("当前分析没有 runtime trace，无法处理 interrupt。");
  }
  const interrupt = trace.interrupts?.find((item) => item.id === input.interruptId);
  if (!interrupt) {
    throw new Error(`没有找到 interrupt：${input.interruptId}`);
  }

  if (input.action === "queue_resume") {
    const targetId = inferInterruptResumeTarget(trace, interrupt);
    if (!targetId) {
      return updateInterrupt(record, {
        ...interrupt,
        updatedAt: new Date().toISOString(),
        resolutionAction: "queue_resume",
        note: input.note,
        resultSummary: "没有找到可恢复目标；请先补齐材料、key 或使用全量重跑。"
      });
    }
    const resumed = await runRuntimeResume(record, {
      targetId,
      action: "queue_retry",
      note: input.note || `from interrupt ${interrupt.id}`
    });
    const status =
      resumed.request.status === "applied" || resumed.request.status === "queued"
        ? "resolved"
        : interrupt.status;
    return updateInterrupt(resumed.record, {
      ...interrupt,
      status,
      updatedAt: new Date().toISOString(),
      resolutionAction: "queue_resume",
      resumeRequestId: resumed.request.id,
      note: input.note,
      resultSummary: `已创建恢复请求：${resumed.request.resultSummary}`
    });
  }

  if (input.action === "mark_resolved") {
    return updateInterrupt(record, {
      ...interrupt,
      status: "resolved",
      updatedAt: new Date().toISOString(),
      resolutionAction: "mark_resolved",
      note: input.note,
      resultSummary: input.note || "用户确认该暂停点已处理。"
    });
  }

  if (input.action === "dismiss") {
    return updateInterrupt(record, {
      ...interrupt,
      status: "dismissed",
      updatedAt: new Date().toISOString(),
      resolutionAction: "dismiss",
      note: input.note,
      resultSummary: input.note || "用户选择忽略该暂停点。"
    });
  }

  return updateInterrupt(record, {
    ...interrupt,
    updatedAt: new Date().toISOString(),
    resolutionAction: "wait_for_user",
    note: input.note,
    resultSummary: input.note || "等待用户补充配置、材料或批准继续。"
  });
}

function inferInterruptResumeTarget(trace: AgentRuntimeTrace, interrupt: AgentRunInterrupt) {
  if (interrupt.resumeCheckpoint?.targetId) return interrupt.resumeCheckpoint.targetId;
  if (interrupt.resumeTargetId) return interrupt.resumeTargetId;
  if (interrupt.workerRunId) return interrupt.workerRunId;
  if (interrupt.toolCallId) return interrupt.toolCallId;
  if (interrupt.taskNodeId) return `task:${interrupt.taskNodeId}`;

  if (interrupt.type === "needs_search_key") {
    const provideKeyTarget = trace.resumePlan?.targets.find(
      (target) =>
        target.retryAction === "provide_key" ||
        target.failureCode === "missing_provider_key" ||
        target.reason.includes("未配置") ||
        target.reason.includes("missing")
    );
    return provideKeyTarget?.id;
  }

  return undefined;
}

function updateInterrupt(
  record: AnalysisRecord,
  interrupt: AgentRunInterrupt
): RuntimeInterruptResult {
  const trace = record.webResearch?.runtimeTrace;
  if (!trace) return { record, interrupt };
  const interrupts = trace.interrupts ?? [];
  const nextTrace: AgentRuntimeTrace = {
    ...trace,
    updatedAt: interrupt.updatedAt,
    status: statusAfterInterruptUpdate(trace, interrupt),
    interrupts: interrupts.some((item) => item.id === interrupt.id)
      ? interrupts.map((item) => (item.id === interrupt.id ? interrupt : item))
      : [...interrupts, interrupt]
  };
  return {
    interrupt,
    record: {
      ...record,
      updatedAt: interrupt.updatedAt,
      webResearch: record.webResearch
        ? {
            ...record.webResearch,
            runtimeTrace: nextTrace
          }
        : record.webResearch
    }
  };
}

function statusAfterInterruptUpdate(
  trace: AgentRuntimeTrace,
  patchedInterrupt: AgentRunInterrupt
): AgentRuntimeTrace["status"] {
  if (trace.status === "failed") return "failed";
  const nextInterrupts = (trace.interrupts ?? []).some((item) => item.id === patchedInterrupt.id)
    ? (trace.interrupts ?? []).map((item) => (item.id === patchedInterrupt.id ? patchedInterrupt : item))
    : [...(trace.interrupts ?? []), patchedInterrupt];
  const hasActiveHard = nextInterrupts.some(
    (interrupt) =>
      interrupt.status === "active" &&
      (interrupt.mode === "hard" || interrupt.blocksRun === true)
  );
  if (hasActiveHard) return "interrupted";
  return trace.status === "interrupted" ? "completed" : trace.status;
}
