import type {
  AgentStage,
  AgentToolCall,
  AgentToolGuardrailResult
} from "./types";

type LegacyTraceToolCallInput = {
  id?: string;
  stage: AgentStage;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  startedAt?: number;
  latencyMs?: number;
  guardrails?: AgentToolGuardrailResult[];
  status?: AgentToolCall["status"];
};

export function legacyTraceToolCall({
  id,
  stage,
  toolName,
  inputSummary,
  outputSummary,
  startedAt,
  latencyMs,
  guardrails = [],
  status
}: LegacyTraceToolCallInput): AgentToolCall {
  return {
    id: id ?? crypto.randomUUID(),
    stage,
    toolName,
    status: status ?? statusFromGuardrails(guardrails),
    inputSummary,
    outputSummary: appendGuardrailSummary(outputSummary, guardrails),
    latencyMs:
      latencyMs ??
      (typeof startedAt === "number"
        ? Math.max(8, Math.round(performance.now() - startedAt))
        : 8)
  };
}

export function appendGuardrailSummary(
  outputSummary: string,
  guardrails: AgentToolGuardrailResult[]
) {
  const summary = guardrailSummary(guardrails);
  return summary ? `${outputSummary}；${summary}` : outputSummary;
}

export function guardrailSummary(guardrails: AgentToolGuardrailResult[]) {
  const actionable = guardrails.filter((guardrail) => guardrail.status !== "pass");
  if (!actionable.length) {
    const passCount = guardrails.filter((guardrail) => guardrail.status === "pass").length;
    return passCount ? `guardrail ${passCount} pass` : "";
  }
  return actionable
    .slice(0, 4)
    .map((guardrail) => `${guardrail.status}: ${guardrail.label} - ${guardrail.message}`)
    .join("；");
}

function statusFromGuardrails(guardrails: AgentToolGuardrailResult[]): AgentToolCall["status"] {
  return guardrails.some((guardrail) => guardrail.status === "block") ? "failed" : "completed";
}
