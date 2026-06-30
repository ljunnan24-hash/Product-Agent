import type {
  AgentContextPack,
  AgentRuntimeArtifactKind,
  AgentRuntimeSubagentId,
  AgentWorkerBudget,
  AgentWorkerBudgetUsed,
  AgentWorkerDefinition,
  AgentWorkerExecutionBoundary,
  AgentWorkerFailureCode,
  AgentWorkerTranscriptEvent
} from "./types";
import { AgentRuntimeHarness } from "./agent-runtime";
import { buildWorkerContextPack, contextPackToBoundaryInput } from "./context-manager";
import {
  getRegisteredWorkerDefinitionById,
  subagentRegistryVersion,
  workerRegistryEvaluationMetrics
} from "./subagent-registry";

const runnerVersion = "subagent-runner-v2.0";

type WorkerBoundaryInput = {
  payload?: unknown;
  inputArtifactIds?: string[];
  acceptedInputSummary?: string;
  inputCharCount?: number;
  modelProvider?: AgentWorkerExecutionBoundary["modelProvider"];
  forbiddenInputs?: string[];
  isolationNotes?: string[];
  contextPackId?: string;
  contextPack?: AgentContextPack;
  droppedInputArtifactIds?: string[];
  compressionStrategy?: string;
  contextWarnings?: string[];
  contextBudget?: AgentWorkerExecutionBoundary["contextBudget"];
};

type RunnerArtifactInput = {
  kind: AgentRuntimeArtifactKind;
  owner?: AgentRuntimeSubagentId;
  title: string;
  summary: string;
  payload?: unknown;
  itemCount?: number;
  preview?: string;
};

type RunnerEventInput = Omit<AgentWorkerTranscriptEvent, "id" | "at">;

export type SubagentRunnerContext = {
  runtime: AgentRuntimeHarness;
  workerRunId: string;
  definition: AgentWorkerDefinition;
  parentSpanId?: string;
  recordEvent: (event: RunnerEventInput) => void;
};

export type SubagentRunResult<T> = {
  status?: "completed" | "failed" | "skipped";
  value: T;
  outputSummary: string;
  artifact?: RunnerArtifactInput | RunnerArtifactInput[];
  artifactIds?: string[];
  handoffId?: string;
  budgetUsed?: Partial<AgentWorkerBudgetUsed>;
  failureCode?: AgentWorkerFailureCode;
  errorMessage?: string;
  transcript?: RunnerEventInput[];
};

export type SubagentRunInput<T> = {
  runtime: AgentRuntimeHarness;
  definition: AgentWorkerDefinition;
  parentSpanId?: string;
  taskNodeId?: string;
  inputSummary: string;
  idempotencyKey?: string;
  attempt?: number;
  boundary?: WorkerBoundaryInput;
  execute: (context: SubagentRunnerContext) => Promise<SubagentRunResult<T>>;
  onError?: (error: unknown, context: SubagentRunnerContext) => Promise<SubagentRunResult<T>>;
};

export type SubagentRunOutput<T> = {
  workerRunId: string;
  value: T;
  status: "completed" | "failed" | "skipped";
  resultArtifactIds: string[];
  artifactIds: string[];
  transcriptArtifactId?: string;
  failureCode?: AgentWorkerFailureCode;
  budgetWarnings: string[];
};

export class SubagentRunner {
  constructor(private runtime: AgentRuntimeHarness) {}

  async run<T>(input: Omit<SubagentRunInput<T>, "runtime">) {
    return runSubagentWorker({
      ...input,
      runtime: this.runtime
    });
  }
}

export async function runSubagentWorker<T>(
  input: SubagentRunInput<T>
): Promise<SubagentRunOutput<T>> {
  const events: AgentWorkerTranscriptEvent[] = [];
  const recordEvent = (event: RunnerEventInput) => {
    events.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      ...event
    });
  };
  const workerRunId = input.runtime.startWorkerRun({
    definition: input.definition,
    parentSpanId: input.parentSpanId,
    taskNodeId: input.taskNodeId,
    inputSummary: input.inputSummary,
    idempotencyKey: input.idempotencyKey,
    attempt: input.attempt,
    runnerVersion,
    executionMode: "subagent_runner"
  });
  recordEvent({
    type: "worker_start",
    summary: `${input.definition.label} started by ${runnerVersion}.`,
    metadata: {
      attempt: input.attempt ?? 1,
      maxAttempts: input.definition.maxAttempts
    }
  });
  const contextPack = buildWorkerContextPack({
    definition: input.definition,
    inputSummary: input.inputSummary,
    boundary: input.boundary,
    parentSpanId: input.parentSpanId,
    taskNodeId: input.taskNodeId,
    idempotencyKey: input.idempotencyKey
  });
  const registeredWorker = getRegisteredWorkerDefinitionById(input.definition.id);
  recordEvent({
    type: "boundary",
    summary: `${contextPack.policyId} context pack · ${contextPack.contextBudget.usedInputChars}/${contextPack.contextBudget.maxInputChars} chars · ${contextPack.inputArtifactIds.length}/${contextPack.contextBudget.maxArtifactRefs} refs.`,
    metadata: {
      registryVersion: registeredWorker?.registryVersion ?? "unregistered",
      contextPackId: contextPack.id,
      boundaryStatus: contextPack.boundaryEnforcement.status,
      boundaryViolations: contextPack.boundaryEnforcement.violations.length,
      warnings: contextPack.warnings.length,
      droppedRefs: contextPack.droppedInputArtifactIds.length,
      evalMetrics: workerRegistryEvaluationMetrics(input.definition.id).length
    }
  });
  const boundaryArtifact = await input.runtime.addWorkerBoundaryArtifact(
    workerRunId,
    contextPackToBoundaryInput(contextPack)
  );
  if (boundaryArtifact) {
    recordEvent({
      type: "boundary",
      summary: boundaryArtifact.summary,
      refs: [boundaryArtifact.id],
      metadata: {
        inputRefs: contextPack.inputArtifactIds.length,
        inputChars: contextPack.contextBudget.usedInputChars,
        contextPackId: contextPack.id
      }
    });
  }

  const context: SubagentRunnerContext = {
    runtime: input.runtime,
    workerRunId,
    definition: input.definition,
    parentSpanId: input.parentSpanId,
    recordEvent
  };

  let result: SubagentRunResult<T>;
  try {
    result = await input.execute(context);
  } catch (error) {
    if (!input.onError) {
      const message = errorMessage(error);
      const failureArtifact = await input.runtime.addArtifact({
        kind: "failure_report",
        owner: input.definition.subagent,
        title: `${input.definition.label} 失败`,
        summary: message,
        payload: {
          worker: input.definition,
          inputSummary: input.inputSummary,
          error: message,
          failureCode: classifyWorkerFailure(error)
        },
        itemCount: 1,
        preview: message
      });
      recordEvent({
        type: "artifact",
        summary: failureArtifact.summary,
        refs: [failureArtifact.id]
      });
      result = {
        status: "failed",
        value: undefined as T,
        outputSummary: message,
        artifactIds: [failureArtifact.id],
        budgetUsed: { artifacts: 1 },
        failureCode: classifyWorkerFailure(error),
        errorMessage: message
      };
    } else {
      result = await input.onError(error, context);
    }
  }

  for (const event of result.transcript ?? []) {
    recordEvent(event);
  }

  const artifactIds = [...(result.artifactIds ?? [])];
  for (const artifactInput of normalizeArtifacts(result.artifact)) {
    const artifact = await input.runtime.addArtifact({
      ...artifactInput,
      owner: artifactInput.owner ?? input.definition.subagent
    });
    artifactIds.push(artifact.id);
    recordEvent({
      type: artifact.kind === "handoff_packet" ? "handoff" : "artifact",
      summary: artifact.summary,
      refs: [artifact.id],
      metadata: {
        itemCount: artifact.itemCount ?? 0,
        byteSize: artifact.byteSize ?? 0
      }
    });
  }

  const status = result.status ?? "completed";
  const budgetUsed = completeBudgetUsed(result.budgetUsed);
  const budgetWarnings = [
    ...budgetWarningsFor(input.definition.budget, budgetUsed, artifactIds.length),
    ...contextBoundaryWarnings(contextPack.boundaryEnforcement)
  ];
  for (const warning of budgetWarnings) {
    recordEvent({
      type: "budget_warning",
      summary: warning
    });
  }
  recordEvent({
    type:
      status === "failed" ? "worker_fail" : status === "skipped" ? "worker_skip" : "worker_complete",
    summary: result.outputSummary,
    metadata: {
      artifacts: artifactIds.length,
      outputChars: budgetUsed.outputChars,
      searchQueries: budgetUsed.searchQueries,
      fetchUrls: budgetUsed.fetchUrls
    }
  });

  const transcriptArtifact = await input.runtime.addArtifact({
    kind: "worker_transcript",
    owner: input.definition.subagent,
    title: `${input.definition.label} 执行记录`,
    summary: `${runnerVersion} · ${status} · ${result.outputSummary}`,
    payload: {
      runnerVersion,
      workerRunId,
      worker: input.definition,
      idempotencyKey: input.idempotencyKey,
      inputSummary: input.inputSummary,
      status,
      outputSummary: result.outputSummary,
      failureCode: result.failureCode,
      errorMessage: result.errorMessage,
      budget: input.definition.budget,
      budgetUsed,
      budgetWarnings,
      registry: registeredWorker
        ? {
            version: subagentRegistryVersion,
            workerId: registeredWorker.id,
            subagent: registeredWorker.subagent,
            taskNodeKinds: registeredWorker.taskNodeKinds,
            modelProvider: registeredWorker.defaultModelProvider,
            memoryScopes: registeredWorker.readableMemoryScopes,
            writableArtifactKinds: registeredWorker.writableArtifactKinds,
            evaluationMetrics: registeredWorker.evaluationMetrics,
            securityNotes: registeredWorker.securityNotes,
            interruptTypes: registeredWorker.interruptTypes
          }
        : {
            version: "unregistered",
            workerId: input.definition.id,
            subagent: input.definition.subagent
          },
      contextBoundaryEnforcement: contextPack.boundaryEnforcement,
      contextPack,
      boundaryArtifactId: boundaryArtifact?.id,
      artifactIds,
      events
    },
    itemCount: events.length,
    preview: events.slice(-4).map((event) => event.summary).join("；")
  });
  const finalArtifactIds = [...new Set([...artifactIds, transcriptArtifact.id])];
  const finishOptions = {
    artifactIds: finalArtifactIds,
    handoffId: result.handoffId,
    budgetUsed,
    errorMessage: result.errorMessage,
    failureCode: result.failureCode,
    transcriptArtifactId: transcriptArtifact.id,
    budgetWarnings
  };

  if (status === "failed") {
    input.runtime.failWorkerRun(workerRunId, result.outputSummary, finishOptions);
  } else if (status === "skipped") {
    input.runtime.skipWorkerRun(workerRunId, result.outputSummary, finishOptions);
  } else {
    input.runtime.completeWorkerRun(workerRunId, result.outputSummary, finishOptions);
  }

  return {
    workerRunId,
    value: result.value,
    status,
    resultArtifactIds: artifactIds,
    artifactIds: finalArtifactIds,
    transcriptArtifactId: transcriptArtifact.id,
    failureCode: result.failureCode,
    budgetWarnings
  };
}

export function classifyWorkerFailure(error: unknown): AgentWorkerFailureCode {
  const message = errorMessage(error).toLowerCase();
  if (/missing|未配置|缺少|api key|apikey|provider key|key missing/.test(message)) {
    return "missing_provider_key";
  }
  if (/guardrail|blocked|阻断|安全检查/.test(message)) return "input_guardrail_blocked";
  if (/timeout|timed out|超时/.test(message)) return "timeout";
  if (/schema|json|parse|解析/.test(message)) return "schema_invalid";
  if (/network|fetch failed|econn|etimedout|socket|dns/.test(message)) return "network_error";
  if (/provider|rate limit|quota|429|500|502|503|504/.test(message)) return "provider_error";
  if (/no result|no_results|没有返回|无结果/.test(message)) return "no_results";
  return "unknown";
}

function normalizeArtifacts(input?: RunnerArtifactInput | RunnerArtifactInput[]) {
  if (!input) return [];
  return Array.isArray(input) ? input : [input];
}

function completeBudgetUsed(input?: Partial<AgentWorkerBudgetUsed>): AgentWorkerBudgetUsed {
  return {
    toolCalls: input?.toolCalls ?? 0,
    searchQueries: input?.searchQueries ?? 0,
    fetchUrls: input?.fetchUrls ?? 0,
    artifacts: input?.artifacts ?? 0,
    outputChars: input?.outputChars ?? 0
  };
}

function budgetWarningsFor(
  budget: AgentWorkerBudget,
  used: AgentWorkerBudgetUsed,
  artifactCount: number
) {
  return [
    budget.maxToolCalls !== undefined && used.toolCalls > budget.maxToolCalls
      ? `tool call 超预算：${used.toolCalls}/${budget.maxToolCalls}`
      : "",
    budget.maxSearchQueries !== undefined && used.searchQueries > budget.maxSearchQueries
      ? `search query 超预算：${used.searchQueries}/${budget.maxSearchQueries}`
      : "",
    budget.maxFetchUrls !== undefined && used.fetchUrls > budget.maxFetchUrls
      ? `fetch URL 超预算：${used.fetchUrls}/${budget.maxFetchUrls}`
      : "",
    budget.maxArtifacts !== undefined && artifactCount > budget.maxArtifacts + 1
      ? `artifact 超预算：${artifactCount}/${budget.maxArtifacts}，包含 transcript artifact`
      : "",
    budget.maxOutputChars !== undefined && used.outputChars > budget.maxOutputChars
      ? `输出超预算：${used.outputChars}/${budget.maxOutputChars} 字符`
      : ""
  ].filter(Boolean);
}

function contextBoundaryWarnings(enforcement: AgentContextPack["boundaryEnforcement"]) {
  if (enforcement.status === "pass") return [];
  if (enforcement.status === "violation") {
    return [`context boundary violation：${enforcement.violations.slice(0, 3).join("；")}`];
  }
  return [`context boundary compacted：${enforcement.compactedReasons.slice(0, 3).join("；")}`];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "unknown worker error");
}
