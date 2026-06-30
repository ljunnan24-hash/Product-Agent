import { writeAgentArtifact } from "./storage";
import { refreshGraphExecutor, queueReadyTaskNodes as queueReadyGraphTaskNodes } from "./graph-executor";
import { redactSecretsInText } from "./tool-security";
import { evaluateAgentRun } from "./agent-run-eval";
import type {
  AgentHandoffPacket,
  AgentHandoffContextBudget,
  AgentContextPack,
  AgentRetryTarget,
  AgentResumePlan,
  AgentRunInterrupt,
  AgentRuntimeArtifact,
  AgentRuntimeArtifactKind,
  AgentRunStateSnapshot,
  AgentRuntimeSpan,
  AgentRuntimeSubagentId,
  AgentRuntimeToolCall,
  AgentRuntimeTrace,
  AgentRunInterruptBlockedUntil,
  AgentRunInterruptMode,
  AgentRunInterruptResumeCheckpoint,
  AgentTaskGraph,
  AgentTaskGraphEdge,
  AgentTaskGraphNode,
  AgentTaskNodeExecution,
  AgentTaskNodeKind,
  AgentTaskNodeStatus,
  AgentToolGuardrailResult,
  AgentToolPolicy,
  AgentWorkerBudget,
  AgentWorkerBudgetUsed,
  AgentWorkerDefinition,
  AgentWorkerExecutionBoundary,
  AgentWorkerExecutionMode,
  AgentWorkerFailureCode,
  AgentWorkerQueueItem,
  AgentWorkerQueueItemStatus,
  AgentWorkerRun
} from "./types";

type SpanInput = {
  subagent: AgentRuntimeSubagentId;
  title: string;
  inputSummary: string;
  taskNodeId?: string;
  parentId?: string;
  metrics?: Record<string, number | string | boolean>;
};

type ArtifactInput = {
  kind: AgentRuntimeArtifactKind;
  owner: AgentRuntimeSubagentId;
  title: string;
  summary: string;
  payload?: unknown;
  itemCount?: number;
  preview?: string;
};

type HandoffInput = {
  from: AgentRuntimeSubagentId;
  to: AgentRuntimeSubagentId | "main_agent";
  goal: string;
  contextSummary: string;
  artifactIds: string[];
  sourceArtifactIds?: string[];
  evidenceRefs?: string[];
  openQuestions?: string[];
  nextActions?: string[];
  acceptedInputSummary?: string;
  keyFindings?: string[];
  uncertainties?: string[];
  forbiddenClaims?: string[];
  contextBudget?: AgentHandoffContextBudget;
};

type WorkerRunInput = {
  definition: AgentWorkerDefinition;
  inputSummary: string;
  parentSpanId?: string;
  idempotencyKey?: string;
  attempt?: number;
  taskNodeId?: string;
  runnerVersion?: string;
  executionMode?: AgentWorkerExecutionMode;
  executionBoundary?: Partial<AgentWorkerExecutionBoundary>;
};

type FinishWorkerRunOptions = {
  artifactIds?: string[];
  handoffId?: string;
  budgetUsed?: Partial<AgentWorkerBudgetUsed>;
  errorMessage?: string;
  failureCode?: AgentWorkerFailureCode;
  transcriptArtifactId?: string;
  budgetWarnings?: string[];
};

type ToolCallInput = {
  policy: AgentToolPolicy;
  inputSummary: string;
  parentSpanId?: string;
  workerRunId?: string;
  provider?: AgentRuntimeToolCall["provider"];
  costEstimate?: number;
  guardrails?: AgentToolGuardrailResult[];
  idempotencyKey?: string;
  cacheKey?: string;
  cacheStatus?: AgentRuntimeToolCall["cacheStatus"];
  taskNodeId?: string;
};

type FinishToolCallOptions = {
  artifactIds?: string[];
  costEstimate?: number;
  guardrails?: AgentToolGuardrailResult[];
  errorMessage?: string;
  cacheStatus?: AgentRuntimeToolCall["cacheStatus"];
  cacheRef?: string;
};

type WorkerBoundaryArtifactInput = {
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
  boundaryEnforcement?: AgentWorkerExecutionBoundary["boundaryEnforcement"];
  contextBudget?: AgentWorkerExecutionBoundary["contextBudget"];
};

type TaskGraphInput = {
  id: string;
  title: string;
  nodes: Array<{
    id: string;
    kind: AgentTaskNodeKind;
    label: string;
    dependsOn?: string[];
    inputSummary: string;
    resumeHint?: string;
    metrics?: Record<string, number | string | boolean>;
  }>;
  edges?: AgentTaskGraphEdge[];
};

type TaskNodeLinkInput = {
  spanIds?: string[];
  workerRunIds?: string[];
  toolCallIds?: string[];
  artifactIds?: string[];
  handoffIds?: string[];
};

type WorkerQueueInput = {
  queueItemId?: string;
  durableQueueId?: string;
  durableInputRef?: string;
  queueLabel: string;
  definition: AgentWorkerDefinition;
  inputSummary: string;
  taskNodeId?: string;
  parentSpanId?: string;
  priority?: number;
  concurrencyGroup?: string;
  sourceArtifactIds?: string[];
  metrics?: Record<string, number | string | boolean>;
};

type FinishWorkerQueueOptions = {
  workerRunId?: string;
  artifactIds?: string[];
  errorMessage?: string;
  metrics?: Record<string, number | string | boolean>;
};

type RunInterruptInput = {
  type: AgentRunInterrupt["type"];
  severity: AgentRunInterrupt["severity"];
  title: string;
  summary: string;
  requestedBy: AgentRunInterrupt["requestedBy"];
  requiredActions: string[];
  resumeTargetId?: string;
  taskNodeId?: string;
  workerRunId?: string;
  toolCallId?: string;
  artifactIds?: string[];
  source: AgentRunInterrupt["source"];
  resultSummary?: string;
  blockTaskNode?: boolean;
  mode?: AgentRunInterruptMode;
  blockedUntil?: AgentRunInterruptBlockedUntil;
  resumeCheckpoint?: Partial<AgentRunInterruptResumeCheckpoint>;
};

export class AgentRuntimeHarness {
  private trace: AgentRuntimeTrace;

  constructor(rootGoal: string, traceId = crypto.randomUUID()) {
    const now = new Date().toISOString();
    this.trace = {
      id: traceId,
      createdAt: now,
      updatedAt: now,
      rootGoal,
      status: "running",
      spans: [],
      artifacts: [],
      handoffs: [],
      workerRuns: [],
      toolCalls: [],
      workerQueue: [],
      interrupts: [],
      stateSnapshots: []
    };
  }

  static fromTrace(trace: AgentRuntimeTrace) {
    const harness = new AgentRuntimeHarness(trace.rootGoal, trace.id);
    harness.trace = {
      ...trace,
      spans: [...trace.spans],
      artifacts: [...trace.artifacts],
      handoffs: [...trace.handoffs],
      workerRuns: [...(trace.workerRuns ?? [])],
      toolCalls: [...(trace.toolCalls ?? [])],
      workerQueue: [...(trace.workerQueue ?? [])],
      interrupts: [...(trace.interrupts ?? [])],
      stateSnapshots: [...(trace.stateSnapshots ?? [])],
      resumeRequests: [...(trace.resumeRequests ?? [])],
      taskGraph: trace.taskGraph
        ? {
            ...trace.taskGraph,
            nodes: [...trace.taskGraph.nodes],
            edges: [...trace.taskGraph.edges],
            definitions: trace.taskGraph.definitions ? [...trace.taskGraph.definitions] : undefined,
            executor: trace.taskGraph.executor
              ? {
                  ...trace.taskGraph.executor,
                  readyNodeIds: [...trace.taskGraph.executor.readyNodeIds],
                  queuedNodeIds: [...trace.taskGraph.executor.queuedNodeIds],
                  runningNodeIds: [...trace.taskGraph.executor.runningNodeIds],
                  blockedNodeIds: [...trace.taskGraph.executor.blockedNodeIds],
                  terminalNodeIds: [...trace.taskGraph.executor.terminalNodeIds],
                  staleNodeIds: [...trace.taskGraph.executor.staleNodeIds],
                  cancelledNodeIds: [...trace.taskGraph.executor.cancelledNodeIds],
                  warnings: [...trace.taskGraph.executor.warnings]
                }
              : undefined
          }
        : undefined
    };
    if (harness.trace.taskGraph) {
      harness.trace.taskGraph = refreshGraphExecutor({
        graph: harness.trace.taskGraph,
        now: harness.trace.taskGraph.updatedAt
      });
    }
    return harness;
  }

  initializeTaskGraph(input: TaskGraphInput) {
    const now = new Date().toISOString();
    const existing = this.trace.taskGraph;
    const existingById = new Map(existing?.nodes.map((node) => [node.id, node]) ?? []);
    const nextNodes = input.nodes.map((node) => {
      const current = existingById.get(node.id);
      return {
        id: node.id,
        kind: node.kind,
        label: node.label,
        status: current?.status ?? "pending",
        dependsOn: node.dependsOn ?? [],
        startedAt: current?.startedAt,
        completedAt: current?.completedAt,
        latencyMs: current?.latencyMs,
        inputSummary: node.inputSummary,
        outputSummary: current?.outputSummary,
        spanIds: current?.spanIds ?? [],
        workerRunIds: current?.workerRunIds ?? [],
        toolCallIds: current?.toolCallIds ?? [],
        artifactIds: current?.artifactIds ?? [],
        handoffIds: current?.handoffIds ?? [],
        blockedBy: current?.blockedBy,
        resumeHint: node.resumeHint ?? current?.resumeHint,
        metrics: {
          ...(current?.metrics ?? {}),
          ...(node.metrics ?? {})
        }
      } satisfies AgentTaskGraphNode;
    });
    this.trace.taskGraph = refreshGraphExecutor({
      graph: {
        id: input.id,
        version: "task-graph-v1",
        title: input.title,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        definitions: existing?.definitions,
        nodes: nextNodes,
        edges:
          input.edges ??
          nextNodes.flatMap((node) =>
            node.dependsOn.map((dependency) => ({
              from: dependency,
              to: node.id
            }))
          )
      },
      now
    });
    this.touch();
  }

  upsertTaskNode(input: TaskGraphInput["nodes"][number]) {
    const now = new Date().toISOString();
    if (!this.trace.taskGraph) {
      this.initializeTaskGraph({
        id: `${this.trace.id}-task-graph`,
        title: this.trace.rootGoal,
        nodes: [input]
      });
      return;
    }
    const existing = this.trace.taskGraph.nodes.find((node) => node.id === input.id);
    const nextNode: AgentTaskGraphNode = {
      id: input.id,
      kind: input.kind,
      label: input.label,
      status: existing?.status ?? "pending",
      dependsOn: input.dependsOn ?? existing?.dependsOn ?? [],
      startedAt: existing?.startedAt,
      completedAt: existing?.completedAt,
      latencyMs: existing?.latencyMs,
      inputSummary: input.inputSummary,
      outputSummary: existing?.outputSummary,
      spanIds: existing?.spanIds ?? [],
      workerRunIds: existing?.workerRunIds ?? [],
      toolCallIds: existing?.toolCallIds ?? [],
      artifactIds: existing?.artifactIds ?? [],
      handoffIds: existing?.handoffIds ?? [],
      blockedBy: existing?.blockedBy,
      resumeHint: input.resumeHint ?? existing?.resumeHint,
      metrics: {
        ...(existing?.metrics ?? {}),
        ...(input.metrics ?? {})
      }
    };
    this.trace.taskGraph = refreshGraphExecutor({
      graph: {
        ...this.trace.taskGraph,
        updatedAt: now,
        nodes: existing
          ? this.trace.taskGraph.nodes.map((node) => (node.id === input.id ? nextNode : node))
          : [...this.trace.taskGraph.nodes, nextNode],
        edges: existing
          ? this.trace.taskGraph.edges
          : [
              ...this.trace.taskGraph.edges,
              ...nextNode.dependsOn.map((dependency) => ({ from: dependency, to: nextNode.id }))
            ]
      },
      now
    });
    this.touch();
  }

  refreshTaskGraphExecutorState() {
    if (!this.trace.taskGraph) return;
    this.trace.taskGraph = refreshGraphExecutor({
      graph: this.trace.taskGraph,
      now: new Date().toISOString()
    });
    this.touch();
  }

  queueReadyTaskNodes(options?: { limit?: number; leaseOwnerId?: string; leaseTtlMs?: number }) {
    if (!this.trace.taskGraph) return [];
    const before = new Set(this.trace.taskGraph.executor?.queuedNodeIds ?? []);
    this.trace.taskGraph = queueReadyGraphTaskNodes({
      graph: this.trace.taskGraph,
      limit: options?.limit,
      leaseOwnerId: options?.leaseOwnerId,
      leaseTtlMs: options?.leaseTtlMs,
      now: new Date().toISOString()
    });
    this.touch();
    return (this.trace.taskGraph.executor?.queuedNodeIds ?? []).filter((id) => !before.has(id));
  }

  queueTaskNode(taskNodeId: string, inputSummary?: string, options?: { leaseOwnerId?: string }) {
    this.updateTaskNode(taskNodeId, "queued", inputSummary, {
      metrics: {
        queuedByGraphExecutor: true,
        ...(options?.leaseOwnerId ? { leaseOwnerId: options.leaseOwnerId } : {})
      }
    });
  }

  startTaskNode(taskNodeId: string, options?: { inputSummary?: string; metrics?: Record<string, number | string | boolean> }) {
    this.updateTaskNode(taskNodeId, "running", options?.inputSummary, {
      metrics: options?.metrics
    });
  }

  completeTaskNode(
    taskNodeId: string,
    outputSummary: string,
    options?: TaskNodeLinkInput & { metrics?: Record<string, number | string | boolean> }
  ) {
    this.updateTaskNode(taskNodeId, "completed", outputSummary, options);
  }

  skipTaskNode(
    taskNodeId: string,
    outputSummary: string,
    options?: TaskNodeLinkInput & {
      metrics?: Record<string, number | string | boolean>;
      blockedBy?: string[];
    }
  ) {
    this.updateTaskNode(taskNodeId, "skipped", outputSummary, options);
  }

  failTaskNode(taskNodeId: string, outputSummary: string, options?: TaskNodeLinkInput & { blockedBy?: string[] }) {
    this.updateTaskNode(taskNodeId, "failed", outputSummary, options);
  }

  interruptTaskNode(taskNodeId: string, outputSummary: string, options?: TaskNodeLinkInput & { blockedBy?: string[] }) {
    this.updateTaskNode(taskNodeId, "interrupted", outputSummary, options);
  }

  cancelTaskNode(taskNodeId: string, outputSummary: string, options?: TaskNodeLinkInput & { blockedBy?: string[] }) {
    this.updateTaskNode(taskNodeId, "cancelled", outputSummary, options);
  }

  linkTaskNodeRefs(taskNodeId: string | undefined, refs: TaskNodeLinkInput) {
    if (!taskNodeId || !this.trace.taskGraph) return;
    const now = new Date().toISOString();
    this.trace.taskGraph = refreshGraphExecutor({
      graph: {
        ...this.trace.taskGraph,
        updatedAt: now,
        nodes: this.trace.taskGraph.nodes.map((node) =>
          node.id === taskNodeId ? mergeTaskNodeRefs(node, refs) : node
        )
      },
      now
    });
    this.touch();
  }

  addInterrupt(input: RunInterruptInput) {
    const now = new Date().toISOString();
    const normalizedActions = [...new Set(input.requiredActions.map((item) => item.trim()).filter(Boolean))];
    const mode = input.mode ?? (input.severity === "blocker" || input.blockTaskNode ? "hard" : "soft");
    const existing = (this.trace.interrupts ?? []).find(
      (interrupt) =>
        interrupt.status === "active" &&
        interrupt.type === input.type &&
        interrupt.taskNodeId === input.taskNodeId &&
        interrupt.source.reason === input.source.reason
    );
    const interrupt: AgentRunInterrupt = {
      id: existing?.id ?? crypto.randomUUID(),
      traceId: this.trace.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      type: input.type,
      status: "active",
      mode,
      blockedUntil: input.blockedUntil ?? blockedUntilForInterrupt(input.type),
      blocksRun: mode === "hard",
      severity: input.severity,
      title: input.title,
      summary: input.summary,
      requestedBy: input.requestedBy,
      requiredActions: normalizedActions.length ? normalizedActions : ["补充必要信息后再恢复该节点。"],
      resumeTargetId: input.resumeTargetId,
      taskNodeId: input.taskNodeId,
      workerRunId: input.workerRunId,
      toolCallId: input.toolCallId,
      artifactIds: input.artifactIds ?? [],
      resumeCheckpoint: buildInterruptResumeCheckpoint({
        traceId: this.trace.id,
        now,
        input,
        requiredActions: normalizedActions
      }),
      source: input.source,
      resultSummary: input.resultSummary
    };
    this.trace.interrupts = existing
      ? (this.trace.interrupts ?? []).map((item) => (item.id === existing.id ? interrupt : item))
      : [...(this.trace.interrupts ?? []), interrupt].slice(-80);
    if (input.blockTaskNode && input.taskNodeId) {
      if (mode === "hard") {
        this.interruptTaskNode(input.taskNodeId, input.summary, {
          blockedBy: input.requiredActions
        });
      } else {
        this.failTaskNode(input.taskNodeId, input.summary, {
          blockedBy: input.requiredActions
        });
      }
    }
    if (mode === "hard") {
      this.trace.status = "interrupted";
    }
    this.touch();
    return interrupt.id;
  }

  resolveInterrupt(interruptId: string, resultSummary: string) {
    const now = new Date().toISOString();
    this.trace.interrupts = (this.trace.interrupts ?? []).map((interrupt) =>
      interrupt.id === interruptId
        ? {
            ...interrupt,
            status: "resolved",
            updatedAt: now,
            resultSummary
          }
        : interrupt
    );
    this.refreshInterruptedStatus();
    this.touch();
  }

  enqueueWorkerQueueItem(input: WorkerQueueInput) {
    const now = new Date().toISOString();
    const queueItem: AgentWorkerQueueItem = {
      id: input.queueItemId ?? crypto.randomUUID(),
      durableQueueId: input.durableQueueId,
      durableInputRef: input.durableInputRef,
      queueLabel: input.queueLabel,
      workerId: input.definition.id,
      workerLabel: input.definition.label,
      taskNodeId: input.taskNodeId ?? this.taskNodeIdForSpan(input.parentSpanId),
      parentSpanId: input.parentSpanId,
      status: "queued",
      priority: input.priority ?? 5,
      concurrencyGroup: input.concurrencyGroup ?? input.definition.subagent,
      enqueuedAt: now,
      inputSummary: input.inputSummary,
      sourceArtifactIds: input.sourceArtifactIds ?? [],
      artifactIds: [],
      metrics: input.metrics
    };
    this.trace.workerQueue = [...(this.trace.workerQueue ?? []), queueItem].slice(-160);
    if (queueItem.taskNodeId) {
      this.updateTaskNode(queueItem.taskNodeId, "queued", input.inputSummary, {
        metrics: {
          ...(input.metrics ?? {}),
          graphExecutorQueueItemId: queueItem.id,
          ...(queueItem.durableQueueId ? { graphExecutorDurableQueueId: queueItem.durableQueueId } : {}),
          graphExecutorQueueLabel: queueItem.queueLabel,
          graphExecutorConcurrencyGroup: queueItem.concurrencyGroup,
          graphExecutorPriority: queueItem.priority
        }
      });
    }
    this.touch();
    return queueItem.id;
  }

  startWorkerQueueItem(queueItemId: string) {
    this.updateWorkerQueueItem(queueItemId, "running");
  }

  completeWorkerQueueItem(
    queueItemId: string,
    outputSummary: string,
    options?: FinishWorkerQueueOptions
  ) {
    this.finishWorkerQueueItem(queueItemId, "completed", outputSummary, options);
  }

  skipWorkerQueueItem(queueItemId: string, outputSummary: string, options?: FinishWorkerQueueOptions) {
    this.finishWorkerQueueItem(queueItemId, "skipped", outputSummary, options);
  }

  failWorkerQueueItem(queueItemId: string, outputSummary: string, options?: FinishWorkerQueueOptions) {
    this.finishWorkerQueueItem(queueItemId, "failed", outputSummary, {
      ...options,
      errorMessage: options?.errorMessage ?? outputSummary
    });
  }

  cancelWorkerQueueItem(queueItemId: string, outputSummary: string, options?: FinishWorkerQueueOptions) {
    this.updateWorkerQueueItem(queueItemId, "cancelled", outputSummary, {
      ...options,
      errorMessage: options?.errorMessage ?? outputSummary,
      metrics: {
        ...(options?.metrics ?? {}),
        cancelled: true
      }
    });
  }

  startSpan(input: SpanInput) {
    const now = new Date().toISOString();
    const taskNodeId = input.taskNodeId ?? this.taskNodeIdForSpan(input.parentId);
    const span: AgentRuntimeSpan = {
      id: crypto.randomUUID(),
      parentId: input.parentId,
      taskNodeId,
      subagent: input.subagent,
      title: input.title,
      status: "running",
      startedAt: now,
      inputSummary: input.inputSummary,
      artifactIds: [],
      metrics: input.metrics
    };
    this.trace.status = "running";
    this.trace.spans.push(span);
    if (taskNodeId) {
      this.startTaskNode(taskNodeId, { inputSummary: input.inputSummary, metrics: input.metrics });
      this.linkTaskNodeRefs(taskNodeId, { spanIds: [span.id] });
    }
    this.touch();
    return span.id;
  }

  completeSpan(
    spanId: string,
    outputSummary: string,
    options?: {
      artifactIds?: string[];
      handoffId?: string;
      metrics?: Record<string, number | string | boolean>;
    }
  ) {
    this.finishSpan(spanId, "completed", outputSummary, options);
  }

  skipSpan(spanId: string, outputSummary: string, options?: { artifactIds?: string[] }) {
    this.finishSpan(spanId, "skipped", outputSummary, options);
  }

  failSpan(spanId: string, errorMessage: string, options?: { artifactIds?: string[] }) {
    this.finishSpan(spanId, "failed", errorMessage, {
      ...options,
      errorMessage
    });
    this.trace.status = "failed";
  }

  startWorkerRun(input: WorkerRunInput) {
    const now = new Date().toISOString();
    const taskNodeId = input.taskNodeId ?? this.taskNodeIdForSpan(input.parentSpanId);
    const run: AgentWorkerRun = {
      id: crypto.randomUUID(),
      workerId: input.definition.id,
      workerLabel: input.definition.label,
      subagent: input.definition.subagent,
      taskNodeId,
      status: "running",
      startedAt: now,
      attempt: input.attempt ?? 1,
      maxAttempts: input.definition.maxAttempts,
      parentSpanId: input.parentSpanId,
      idempotencyKey: input.idempotencyKey,
      runnerVersion: input.runnerVersion,
      executionMode: input.executionMode ?? "inline_manual",
      inputSummary: input.inputSummary,
      artifactIds: [],
      budget: input.definition.budget,
      budgetUsed: emptyBudgetUsed(),
      executionBoundary: buildWorkerExecutionBoundary(
        input.definition,
        input.inputSummary,
        input.executionBoundary
      )
    };
    this.trace.status = "running";
    this.trace.workerRuns = [...(this.trace.workerRuns ?? []), run];
    this.linkTaskNodeRefs(taskNodeId, { workerRunIds: [run.id] });
    this.touch();
    return run.id;
  }

  completeWorkerRun(workerRunId: string, outputSummary: string, options?: FinishWorkerRunOptions) {
    this.finishWorkerRun(workerRunId, "completed", outputSummary, options);
  }

  skipWorkerRun(workerRunId: string, outputSummary: string, options?: FinishWorkerRunOptions) {
    this.finishWorkerRun(workerRunId, "skipped", outputSummary, options);
  }

  failWorkerRun(workerRunId: string, errorMessage: string, options?: FinishWorkerRunOptions) {
    this.finishWorkerRun(workerRunId, "failed", errorMessage, {
      ...options,
      errorMessage
    });
  }

  async addWorkerBoundaryArtifact(workerRunId: string, input?: WorkerBoundaryArtifactInput) {
    const run = (this.trace.workerRuns ?? []).find((item) => item.id === workerRunId);
    if (!run) return null;
    const boundary = mergeWorkerBoundary(run.executionBoundary, input);
    const artifact = await this.addArtifact({
      kind: "worker_context",
      owner: run.subagent,
      title: `${run.workerLabel} 输入边界`,
      summary: boundary.acceptedInputSummary,
      payload: {
        workerRunId: run.id,
        workerId: run.workerId,
        workerLabel: run.workerLabel,
        subagent: run.subagent,
        idempotencyKey: run.idempotencyKey,
        boundary,
        contextPack: input?.contextPack,
        inputPayload: input?.payload
      },
      itemCount: boundary.inputArtifactIds.length,
      preview: [
        boundary.acceptedInputSummary,
        boundary.boundaryEnforcement ? `boundary: ${boundary.boundaryEnforcement.status}` : "",
        boundary.compressionStrategy ? `compression: ${boundary.compressionStrategy}` : "",
        boundary.contextWarnings?.length ? `warnings: ${boundary.contextWarnings.join(" | ")}` : "",
        `tools: ${boundary.allowedTools.join(", ")}`,
        `input refs: ${boundary.inputArtifactIds.length}`
      ]
        .filter(Boolean)
        .join("；")
    });
    const sealedBoundary = {
      ...boundary,
      boundaryArtifactId: artifact.id
    };
    this.trace.workerRuns = (this.trace.workerRuns ?? []).map((item) =>
      item.id === workerRunId ? { ...item, executionBoundary: sealedBoundary } : item
    );
    this.linkTaskNodeRefs(run.taskNodeId, { artifactIds: [artifact.id] });
    this.touch();
    return artifact;
  }

  startToolCall(input: ToolCallInput) {
    const now = new Date().toISOString();
    const taskNodeId =
      input.taskNodeId ??
      this.taskNodeIdForWorker(input.workerRunId) ??
      this.taskNodeIdForSpan(input.parentSpanId);
    const toolCall: AgentRuntimeToolCall = {
      id: crypto.randomUUID(),
      toolId: input.policy.id,
      toolLabel: input.policy.label,
      taskNodeId,
      status: "running",
      startedAt: now,
      parentSpanId: input.parentSpanId,
      workerRunId: input.workerRunId,
      provider: input.provider,
      inputSummary: input.inputSummary,
      artifactIds: [],
      riskLevel: input.policy.riskLevel,
      costUnit: input.policy.costUnit,
      costEstimate: input.costEstimate ?? input.policy.estimatedCostPerCall,
      timeoutMs: input.policy.timeoutMs,
      retryPolicy: input.policy.retryPolicy,
      guardrails: input.guardrails ?? [],
      idempotencyKey: input.idempotencyKey,
      cacheKey: input.cacheKey,
      cacheStatus: input.cacheStatus
    };
    this.trace.status = "running";
    this.trace.toolCalls = [...(this.trace.toolCalls ?? []), toolCall];
    this.linkTaskNodeRefs(taskNodeId, { toolCallIds: [toolCall.id] });
    this.touch();
    return toolCall.id;
  }

  completeToolCall(toolCallId: string, outputSummary: string, options?: FinishToolCallOptions) {
    this.finishToolCall(toolCallId, "completed", outputSummary, options);
  }

  skipToolCall(toolCallId: string, outputSummary: string, options?: FinishToolCallOptions) {
    this.finishToolCall(toolCallId, "skipped", outputSummary, options);
  }

  blockToolCall(toolCallId: string, outputSummary: string, options?: FinishToolCallOptions) {
    this.finishToolCall(toolCallId, "blocked", outputSummary, options);
  }

  failToolCall(toolCallId: string, errorMessage: string, options?: FinishToolCallOptions) {
    this.finishToolCall(toolCallId, "failed", errorMessage, {
      ...options,
      errorMessage
    });
  }

  async addArtifact(input: ArtifactInput) {
    const id = crypto.randomUUID();
    let storageRef: string | undefined;
    let byteSize: number | undefined;
    if (input.payload !== undefined) {
      const persisted = await writeAgentArtifact({
        traceId: this.trace.id,
        artifactId: id,
        payload: input.payload
      });
      storageRef = persisted.storageRef;
      byteSize = persisted.byteSize;
    }
    const artifact: AgentRuntimeArtifact = {
      id,
      kind: input.kind,
      owner: input.owner,
      title: redactSecretsInText(input.title),
      summary: redactSecretsInText(input.summary),
      createdAt: new Date().toISOString(),
      storageRef,
      byteSize,
      itemCount: input.itemCount,
      preview: compactPreview(redactSecretsInText(input.preview ?? input.summary))
    };
    this.trace.artifacts.push(artifact);
    this.touch();
    return artifact;
  }

  createHandoff(input: HandoffInput) {
    const evidenceRefs = input.evidenceRefs ?? [];
    const openQuestions = input.openQuestions ?? [];
    const nextActions = input.nextActions ?? [];
    const contextBudget = input.contextBudget ?? defaultHandoffBudget(input.contextSummary, input.artifactIds, evidenceRefs);
    const handoff: AgentHandoffPacket = {
      id: crypto.randomUUID(),
      from: input.from,
      to: input.to,
      goal: input.goal,
      contextSummary: input.contextSummary,
      artifactIds: input.artifactIds,
      sourceArtifactIds: input.sourceArtifactIds ?? input.artifactIds,
      evidenceRefs,
      openQuestions,
      nextActions,
      acceptedInputSummary:
        input.acceptedInputSummary ??
        `接收 ${input.artifactIds.length} 个 artifact、${evidenceRefs.length} 条 evidence ref、${openQuestions.length} 个 open question。`,
      keyFindings: normalizeList(input.keyFindings),
      uncertainties: normalizeList(input.uncertainties ?? openQuestions),
      forbiddenClaims: normalizeList(input.forbiddenClaims),
      contextBudget,
      createdAt: new Date().toISOString()
    };
    this.trace.handoffs.push(handoff);
    this.linkTaskNodeRefs(this.taskNodeIdForArtifacts(input.artifactIds), {
      handoffIds: [handoff.id],
      artifactIds: handoff.artifactIds
    });
    this.addStateSnapshot({
      checkpointType: "handoff",
      status: "completed",
      label: `${handoff.from} -> ${handoff.to}`,
      summary: handoff.contextSummary,
      handoffId: handoff.id,
      artifactIds: handoff.artifactIds,
      resumeHint: `可从 handoff ${handoff.id} 继续；只读取 artifact ref 和压缩摘要，不回灌网页全文。`
    });
    this.touch();
    return handoff;
  }

  completeTrace() {
    if (this.trace.status !== "failed") {
      this.trace.status = hasActiveHardInterrupt(this.trace) ? "interrupted" : "completed";
    }
    this.trace.runEval = evaluateAgentRun(this.trace);
    this.touch();
  }

  getTrace() {
    const trace: AgentRuntimeTrace = {
      ...this.trace,
      spans: [...this.trace.spans],
      artifacts: [...this.trace.artifacts],
      handoffs: [...this.trace.handoffs],
      workerRuns: [...(this.trace.workerRuns ?? [])],
      toolCalls: [...(this.trace.toolCalls ?? [])],
      workerQueue: [...(this.trace.workerQueue ?? [])],
      interrupts: [...(this.trace.interrupts ?? [])],
      stateSnapshots: [...(this.trace.stateSnapshots ?? [])],
      resumeRequests: [...(this.trace.resumeRequests ?? [])],
      taskGraph: this.trace.taskGraph
        ? {
            ...this.trace.taskGraph,
            nodes: [...this.trace.taskGraph.nodes],
            edges: [...this.trace.taskGraph.edges],
            definitions: this.trace.taskGraph.definitions ? [...this.trace.taskGraph.definitions] : undefined,
            executor: this.trace.taskGraph.executor
              ? {
                  ...this.trace.taskGraph.executor,
                  readyNodeIds: [...this.trace.taskGraph.executor.readyNodeIds],
                  queuedNodeIds: [...this.trace.taskGraph.executor.queuedNodeIds],
                  runningNodeIds: [...this.trace.taskGraph.executor.runningNodeIds],
                  blockedNodeIds: [...this.trace.taskGraph.executor.blockedNodeIds],
                  terminalNodeIds: [...this.trace.taskGraph.executor.terminalNodeIds],
                  staleNodeIds: [...this.trace.taskGraph.executor.staleNodeIds],
                  cancelledNodeIds: [...this.trace.taskGraph.executor.cancelledNodeIds],
                  warnings: [...this.trace.taskGraph.executor.warnings]
                }
              : undefined
          }
        : undefined,
      resumePlan: buildResumePlan(this.trace)
    };
    return {
      ...trace,
      runEval: evaluateAgentRun(trace)
    };
  }

  private finishSpan(
    spanId: string,
    status: AgentRuntimeSpan["status"],
    outputSummary: string,
    options?: {
      artifactIds?: string[];
      handoffId?: string;
      errorMessage?: string;
      metrics?: Record<string, number | string | boolean>;
    }
  ) {
    const now = new Date().toISOString();
    this.trace.spans = this.trace.spans.map((span) => {
      if (span.id !== spanId) return span;
      return {
        ...span,
        status,
        completedAt: now,
        latencyMs: Math.max(0, new Date(now).getTime() - new Date(span.startedAt).getTime()),
        outputSummary,
        artifactIds: [...new Set([...span.artifactIds, ...(options?.artifactIds ?? [])])],
        handoffId: options?.handoffId ?? span.handoffId,
        errorMessage: options?.errorMessage,
        metrics: {
          ...(span.metrics ?? {}),
          ...(options?.metrics ?? {})
        }
      };
    });
    const completedSpan = this.trace.spans.find((span) => span.id === spanId);
    if (completedSpan?.taskNodeId) {
      this.updateTaskNode(completedSpan.taskNodeId, taskStatusForSpan(status), outputSummary, {
        spanIds: [completedSpan.id],
        artifactIds: options?.artifactIds ?? [],
        handoffIds: options?.handoffId ? [options.handoffId] : [],
        metrics: options?.metrics,
        blockedBy: options?.errorMessage ? [options.errorMessage] : undefined
      });
    }
    this.touch();
  }

  private finishToolCall(
    toolCallId: string,
    status: AgentRuntimeToolCall["status"],
    outputSummary: string,
    options?: FinishToolCallOptions
  ) {
    const now = new Date().toISOString();
    this.trace.toolCalls = (this.trace.toolCalls ?? []).map((toolCall) => {
      if (toolCall.id !== toolCallId) return toolCall;
      return {
        ...toolCall,
        status,
        completedAt: now,
        latencyMs: Math.max(0, new Date(now).getTime() - new Date(toolCall.startedAt).getTime()),
        outputSummary,
        artifactIds: [...new Set([...toolCall.artifactIds, ...(options?.artifactIds ?? [])])],
        costEstimate: options?.costEstimate ?? toolCall.costEstimate,
        guardrails: mergeGuardrails(toolCall.guardrails, options?.guardrails),
        cacheStatus: options?.cacheStatus ?? toolCall.cacheStatus,
        cacheRef: options?.cacheRef ?? toolCall.cacheRef,
        errorMessage: options?.errorMessage
      };
    });
    const completedTool = (this.trace.toolCalls ?? []).find((toolCall) => toolCall.id === toolCallId);
    if (completedTool?.taskNodeId) {
      this.linkTaskNodeRefs(completedTool.taskNodeId, {
        toolCallIds: [completedTool.id],
        artifactIds: options?.artifactIds ?? []
      });
    }
    this.touch();
  }

  private finishWorkerRun(
    workerRunId: string,
    status: AgentWorkerRun["status"],
    outputSummary: string,
    options?: FinishWorkerRunOptions
  ) {
    const now = new Date().toISOString();
    this.trace.workerRuns = (this.trace.workerRuns ?? []).map((run) => {
      if (run.id !== workerRunId) return run;
      return {
        ...run,
        status,
        completedAt: now,
        latencyMs: Math.max(0, new Date(now).getTime() - new Date(run.startedAt).getTime()),
        outputSummary,
        artifactIds: [...new Set([...run.artifactIds, ...(options?.artifactIds ?? [])])],
        handoffId: options?.handoffId ?? run.handoffId,
        errorMessage: options?.errorMessage,
        failureCode: options?.failureCode ?? run.failureCode,
        transcriptArtifactId: options?.transcriptArtifactId ?? run.transcriptArtifactId,
        budgetWarnings: mergeWarnings(run.budgetWarnings, options?.budgetWarnings),
        budgetUsed: mergeBudgetUsed(run.budgetUsed, options?.budgetUsed)
      };
    });
    const completedRun = (this.trace.workerRuns ?? []).find((run) => run.id === workerRunId);
    if (completedRun) {
      this.linkTaskNodeRefs(completedRun.taskNodeId, {
        workerRunIds: [completedRun.id],
        artifactIds: completedRun.artifactIds,
        handoffIds: completedRun.handoffId ? [completedRun.handoffId] : []
      });
      if (completedRun.taskNodeId) {
        this.updateTaskNode(completedRun.taskNodeId, taskStatusForWorker(status), outputSummary, {
          workerRunIds: [completedRun.id],
          artifactIds: completedRun.artifactIds,
          handoffIds: completedRun.handoffId ? [completedRun.handoffId] : [],
          blockedBy: completedRun.errorMessage ? [completedRun.errorMessage] : undefined
        });
      }
      this.addStateSnapshot({
        checkpointType: "worker_run",
        status: status === "running" ? "completed" : status,
        label: completedRun.workerLabel,
        summary: outputSummary,
        workerRunId: completedRun.id,
        spanId: completedRun.parentSpanId,
        handoffId: completedRun.handoffId,
        artifactIds: completedRun.artifactIds,
        resumeHint: resumeHintForWorker(completedRun)
      });
    }
    this.touch();
  }

  private updateTaskNode(
    taskNodeId: string,
    status: AgentTaskNodeStatus,
    summary?: string,
    options?: TaskNodeLinkInput & {
      metrics?: Record<string, number | string | boolean>;
      blockedBy?: string[];
    }
  ) {
    if (!this.trace.taskGraph) return;
    const now = new Date().toISOString();
    this.trace.taskGraph = refreshGraphExecutor({
      graph: {
        ...this.trace.taskGraph,
        updatedAt: now,
        nodes: this.trace.taskGraph.nodes.map((node) => {
          if (node.id !== taskNodeId) return node;
          const startedAt = node.startedAt ?? (status === "running" ? now : node.startedAt);
          const completedAt = isCompletedTaskStatus(status) ? now : node.completedAt;
          return mergeTaskNodeRefs(
            {
              ...node,
              status,
              startedAt,
              completedAt,
              latencyMs:
                startedAt && completedAt
                  ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
                  : node.latencyMs,
              inputSummary: (status === "running" || status === "queued") && summary ? summary : node.inputSummary,
              outputSummary: status !== "running" && status !== "queued" && summary ? summary : node.outputSummary,
              blockedBy: options?.blockedBy ?? node.blockedBy,
              metrics: {
                ...(node.metrics ?? {}),
                ...(options?.metrics ?? {})
              },
              execution: updateTaskNodeExecutionForStatus(node.execution, status, now)
            },
            options ?? {}
          );
        })
      },
      now
    });
    this.touch();
  }

  private finishWorkerQueueItem(
    queueItemId: string,
    status: Exclude<AgentWorkerQueueItemStatus, "queued" | "running" | "cancelled">,
    outputSummary: string,
    options?: FinishWorkerQueueOptions
  ) {
    this.updateWorkerQueueItem(queueItemId, status, outputSummary, options);
  }

  private updateWorkerQueueItem(
    queueItemId: string,
    status: AgentWorkerQueueItemStatus,
    outputSummary?: string,
    options?: FinishWorkerQueueOptions
  ) {
    const now = new Date().toISOString();
    this.trace.workerQueue = (this.trace.workerQueue ?? []).map((item) => {
      if (item.id !== queueItemId) return item;
      const startedAt = item.startedAt ?? (status === "running" ? now : item.startedAt);
      const completedAt =
        status === "completed" || status === "failed" || status === "skipped" || status === "cancelled"
          ? now
          : item.completedAt;
      return {
        ...item,
        status,
        startedAt,
        completedAt,
        waitMs: startedAt
          ? Math.max(0, new Date(startedAt).getTime() - new Date(item.enqueuedAt).getTime())
          : item.waitMs,
        latencyMs:
          startedAt && completedAt
            ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
            : item.latencyMs,
        outputSummary: outputSummary ?? item.outputSummary,
        workerRunId: options?.workerRunId ?? item.workerRunId,
        artifactIds: [...new Set([...item.artifactIds, ...(options?.artifactIds ?? [])])],
        errorMessage: options?.errorMessage ?? item.errorMessage,
        metrics: {
          ...(item.metrics ?? {}),
          ...(options?.metrics ?? {})
        }
      };
    });
    const updatedItem = (this.trace.workerQueue ?? []).find((item) => item.id === queueItemId);
    if (updatedItem?.taskNodeId) {
      this.updateTaskNode(updatedItem.taskNodeId, taskStatusForQueueItem(status), outputSummary ?? updatedItem.inputSummary, {
        workerRunIds: options?.workerRunId ? [options.workerRunId] : [],
        artifactIds: options?.artifactIds,
        blockedBy: options?.errorMessage ? [options.errorMessage] : undefined,
        metrics: {
          ...(options?.metrics ?? {}),
          graphExecutorQueueItemId: updatedItem.id,
          ...(updatedItem.durableQueueId ? { graphExecutorDurableQueueId: updatedItem.durableQueueId } : {}),
          graphExecutorQueueStatus: status,
          graphExecutorQueueLabel: updatedItem.queueLabel
        }
      });
    }
    this.touch();
  }

  private refreshInterruptedStatus() {
    if (this.trace.status !== "interrupted") return;
    this.trace.status = hasActiveHardInterrupt(this.trace) ? "interrupted" : "completed";
  }

  private taskNodeIdForSpan(spanId?: string) {
    if (!spanId) return undefined;
    return this.trace.spans.find((span) => span.id === spanId)?.taskNodeId;
  }

  private taskNodeIdForWorker(workerRunId?: string) {
    if (!workerRunId) return undefined;
    return (this.trace.workerRuns ?? []).find((run) => run.id === workerRunId)?.taskNodeId;
  }

  private taskNodeIdForArtifacts(artifactIds: string[]) {
    if (!this.trace.taskGraph || !artifactIds.length) return undefined;
    return this.trace.taskGraph.nodes.find((node) =>
      artifactIds.some((artifactId) => node.artifactIds.includes(artifactId))
    )?.id;
  }

  private addStateSnapshot(input: Omit<AgentRunStateSnapshot, "id" | "traceId" | "createdAt">) {
    const snapshot: AgentRunStateSnapshot = {
      id: crypto.randomUUID(),
      traceId: this.trace.id,
      createdAt: new Date().toISOString(),
      ...input
    };
    this.trace.stateSnapshots = [...(this.trace.stateSnapshots ?? []), snapshot].slice(-80);
  }

  private touch() {
    this.trace.updatedAt = new Date().toISOString();
  }
}

function compactPreview(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 520);
}

function defaultHandoffBudget(
  contextSummary: string,
  artifactIds: string[],
  evidenceRefs: string[]
): AgentHandoffContextBudget {
  const maxSummaryChars = 1200;
  const maxArtifactRefs = 8;
  const maxEvidenceRefs = 10;
  return {
    maxSummaryChars,
    maxArtifactRefs,
    maxEvidenceRefs,
    usedSummaryChars: Math.min(contextSummary.length, maxSummaryChars),
    usedArtifactRefs: Math.min(artifactIds.length, maxArtifactRefs),
    usedEvidenceRefs: Math.min(evidenceRefs.length, maxEvidenceRefs),
    droppedContextSummary: [
      contextSummary.length > maxSummaryChars ? `summary 截断 ${contextSummary.length - maxSummaryChars} 字符` : "",
      artifactIds.length > maxArtifactRefs ? `artifact refs 截断 ${artifactIds.length - maxArtifactRefs} 个` : "",
      evidenceRefs.length > maxEvidenceRefs ? `evidence refs 截断 ${evidenceRefs.length - maxEvidenceRefs} 个` : ""
    ]
      .filter(Boolean)
      .join("；")
  };
}

function normalizeList(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 12);
}

function mergeTaskNodeRefs(
  node: AgentTaskGraphNode,
  refs: TaskNodeLinkInput
): AgentTaskGraphNode {
  return {
    ...node,
    spanIds: mergeUnique(node.spanIds, refs.spanIds),
    workerRunIds: mergeUnique(node.workerRunIds, refs.workerRunIds),
    toolCallIds: mergeUnique(node.toolCallIds, refs.toolCallIds),
    artifactIds: mergeUnique(node.artifactIds, refs.artifactIds),
    handoffIds: mergeUnique(node.handoffIds, refs.handoffIds)
  };
}

function taskStatusForSpan(status: AgentRuntimeSpan["status"]): AgentTaskNodeStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "running";
}

function taskStatusForWorker(status: AgentWorkerRun["status"]): AgentTaskNodeStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "running";
}

function taskStatusForQueueItem(status: AgentWorkerQueueItemStatus): AgentTaskNodeStatus {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "cancelled";
}

function isCompletedTaskStatus(status: AgentTaskNodeStatus) {
  return status === "completed" || status === "failed" || status === "skipped" || status === "cancelled";
}

function updateTaskNodeExecutionForStatus(
  execution: AgentTaskNodeExecution | undefined,
  status: AgentTaskNodeStatus,
  now: string
) {
  if (!execution) return execution;
  return {
    ...execution,
    attempt:
      status === "running" && execution.lastTransitionAt !== now
        ? execution.attempt + 1
        : execution.attempt,
    queuedAt: status === "queued" ? execution.queuedAt ?? now : execution.queuedAt,
    cancelledAt: status === "cancelled" ? now : execution.cancelledAt,
    lastTransitionAt: now,
    lease:
      status === "completed" || status === "failed" || status === "skipped" || status === "cancelled"
        ? undefined
        : execution.lease
  } satisfies AgentTaskNodeExecution;
}

function mergeUnique(current: string[], patch?: string[]) {
  return [...new Set([...current, ...(patch ?? [])].filter(Boolean))];
}

function buildWorkerExecutionBoundary(
  definition: AgentWorkerDefinition,
  inputSummary: string,
  patch?: Partial<AgentWorkerExecutionBoundary>
): AgentWorkerExecutionBoundary {
  const maxInputChars = 2400;
  const maxArtifactRefs = 8;
  const inputArtifactIds = patch?.inputArtifactIds ?? [];
  return {
    mode: "isolated_worker",
    modelProvider: patch?.modelProvider ?? "deterministic",
    contextPackId: patch?.contextPackId,
    systemPrompt: patch?.systemPrompt ?? definition.role,
    inputSchema: patch?.inputSchema ?? definition.inputSchema,
    outputSchema: patch?.outputSchema ?? definition.outputSchema,
    allowedTools: patch?.allowedTools ?? [...definition.allowedTools],
    inputArtifactIds,
    droppedInputArtifactIds: patch?.droppedInputArtifactIds ?? [],
    boundaryArtifactId: patch?.boundaryArtifactId,
    acceptedInputSummary: patch?.acceptedInputSummary ?? compactPreview(inputSummary),
    forbiddenInputs:
      patch?.forbiddenInputs ??
      [
        "不得读取主 Agent 的完整隐式上下文。",
        "不得把网页全文、搜索噪音或失败 provider 结果直接交给主 Agent。",
        "不得调用未列入 allowlist 的工具。"
      ],
    isolationNotes:
      patch?.isolationNotes ??
      [
        "worker 只处理输入包和显式 artifact ref。",
        "输出必须落 artifact 或 Handoff Packet，主 Agent 只消费压缩摘要。"
      ],
    contextBudget:
      patch?.contextBudget ??
      {
        maxInputChars,
        usedInputChars: Math.min(inputSummary.length, maxInputChars),
        maxArtifactRefs,
        usedArtifactRefs: Math.min(inputArtifactIds.length, maxArtifactRefs),
        maxOutputChars: definition.budget.maxOutputChars,
        droppedInputSummary: [
          inputSummary.length > maxInputChars ? `input summary 截断 ${inputSummary.length - maxInputChars} 字符` : "",
          inputArtifactIds.length > maxArtifactRefs ? `artifact refs 截断 ${inputArtifactIds.length - maxArtifactRefs} 个` : ""
        ]
          .filter(Boolean)
          .join("；")
      },
    compressionStrategy: patch?.compressionStrategy,
    contextWarnings: patch?.contextWarnings ?? [],
    boundaryEnforcement: patch?.boundaryEnforcement,
    resumeStrategy:
      patch?.resumeStrategy ??
      `用 workerRunId ${definition.id}、idempotencyKey 和 input artifact refs 重试，不回灌主流程长上下文。`
  };
}

function mergeWorkerBoundary(
  current: AgentWorkerExecutionBoundary | undefined,
  input?: WorkerBoundaryArtifactInput
): AgentWorkerExecutionBoundary {
  const fallbackDefinition: AgentWorkerDefinition = {
    id: "unknown-worker",
    label: "Unknown Worker",
    subagent: "research_supervisor",
    role: "Worker boundary missing.",
    allowedTools: [],
    inputSchema: "unknown",
    outputSchema: "unknown",
    budget: {},
    maxAttempts: 1
  };
  const base = current ?? buildWorkerExecutionBoundary(fallbackDefinition, input?.acceptedInputSummary ?? "");
  const inputArtifactIds = input?.inputArtifactIds ?? base.inputArtifactIds;
  const maxInputChars = base.contextBudget.maxInputChars;
  const maxArtifactRefs = base.contextBudget.maxArtifactRefs;
  const inputCharCount = input?.inputCharCount ?? base.contextBudget.usedInputChars;
  return {
    ...base,
    modelProvider: input?.modelProvider ?? base.modelProvider,
    contextPackId: input?.contextPackId ?? base.contextPackId,
    inputArtifactIds,
    droppedInputArtifactIds: input?.droppedInputArtifactIds ?? base.droppedInputArtifactIds ?? [],
    acceptedInputSummary: input?.acceptedInputSummary ?? base.acceptedInputSummary,
    forbiddenInputs: input?.forbiddenInputs ?? base.forbiddenInputs,
    isolationNotes: input?.isolationNotes ?? base.isolationNotes,
    compressionStrategy: input?.compressionStrategy ?? base.compressionStrategy,
    contextWarnings: mergeWarnings(base.contextWarnings, input?.contextWarnings),
    boundaryEnforcement: input?.boundaryEnforcement ?? base.boundaryEnforcement,
    contextBudget:
      input?.contextBudget ??
      {
        ...base.contextBudget,
        usedInputChars: Math.min(inputCharCount, maxInputChars),
        usedArtifactRefs: Math.min(inputArtifactIds.length, maxArtifactRefs),
        droppedInputSummary: [
          inputCharCount > maxInputChars ? `input package 截断 ${inputCharCount - maxInputChars} 字符` : "",
          inputArtifactIds.length > maxArtifactRefs ? `artifact refs 截断 ${inputArtifactIds.length - maxArtifactRefs} 个` : "",
          base.contextBudget.droppedInputSummary
        ]
          .filter(Boolean)
          .join("；")
      }
  };
}

function mergeGuardrails(
  current: AgentToolGuardrailResult[],
  patch?: AgentToolGuardrailResult[]
) {
  if (!patch?.length) return current;
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of patch) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function buildResumePlan(trace: AgentRuntimeTrace): AgentResumePlan {
  const workerTargets: AgentRetryTarget[] =
    trace.workerRuns
      ?.filter((run) => run.status === "failed" || run.status === "skipped")
      .map((run) => {
        const requiredFixes = requiredFixesForWorker(run);
        return {
          id: `worker:${run.id}`,
          kind: "worker_run" as const,
          status: run.status as "failed" | "skipped",
          label: run.workerLabel,
          reason: run.errorMessage || run.outputSummary || run.inputSummary,
          retryable: run.attempt < run.maxAttempts || run.status === "skipped",
          retryAction: retryActionForWorker(run),
          requiredFixes,
          workerRunId: run.id,
          failureCode: run.failureCode,
          parentSpanId: run.parentSpanId,
          idempotencyKey: run.idempotencyKey,
          cacheKey: undefined,
          cacheStatus: undefined,
          inputArtifactIds: [
            ...(run.executionBoundary?.inputArtifactIds ?? []),
            run.executionBoundary?.boundaryArtifactId ?? ""
          ].filter(Boolean),
          outputArtifactIds: run.artifactIds,
          resumeHint: resumeHintForWorker(run)
        };
      }) ?? [];

  const toolTargets: AgentRetryTarget[] =
    trace.toolCalls
      ?.filter((tool) => tool.status === "failed" || tool.status === "skipped" || tool.status === "blocked")
      .map((tool) => {
        const requiredFixes = requiredFixesForTool(tool);
        return {
          id: `tool:${tool.id}`,
          kind: "tool_call" as const,
          status: tool.status as "failed" | "skipped" | "blocked",
          label: tool.toolLabel,
          reason: tool.errorMessage || tool.outputSummary || tool.inputSummary,
          retryable: tool.status !== "blocked" || requiredFixes.length > 0,
          retryAction: retryActionForTool(tool),
          requiredFixes,
          workerRunId: tool.workerRunId,
          toolCallId: tool.id,
          parentSpanId: tool.parentSpanId,
          idempotencyKey: tool.idempotencyKey,
          cacheKey: tool.cacheKey,
          cacheStatus: tool.cacheStatus,
          inputArtifactIds: [],
          outputArtifactIds: tool.artifactIds,
          resumeHint: resumeHintForTool(tool)
        };
      }) ?? [];

  const targets = [...workerTargets, ...toolTargets].slice(-24);
  const cacheableCount = targets.filter((target) => Boolean(target.cacheKey || target.idempotencyKey)).length;
  return {
    generatedAt: new Date().toISOString(),
    status: targets.length ? "ready" : "no_retry_needed",
    targetCount: targets.length,
    retryableCount: targets.filter((target) => target.retryable).length,
    cacheableCount,
    targets
  };
}

function requiredFixesForWorker(run: AgentWorkerRun) {
  const reason = `${run.errorMessage || ""} ${run.outputSummary || ""}`.toLowerCase();
  if (run.failureCode === "missing_provider_key") {
    return ["补齐对应 provider/API key 后重试该 worker。"];
  }
  if (run.failureCode === "input_guardrail_blocked") {
    return ["先审查并修复被 guardrail 阻断的输入，再恢复该 worker。"];
  }
  if (run.failureCode === "budget_exceeded") {
    return ["降低输入规模或提高该 worker 预算后重试。"];
  }
  if (run.failureCode === "user_input_required") {
    return ["等待用户补充材料或确认目标后恢复。"];
  }
  if (reason.includes("missing") || reason.includes("未配置") || reason.includes("key")) {
    return ["补齐对应 provider/API key 后重试该 worker。"];
  }
  if (run.status === "skipped") {
    return ["补齐缺失的用户材料、provider 配置或查询输入后恢复。"];
  }
  if (run.attempt >= run.maxAttempts) {
    return ["已达到当前 maxAttempts，需要人工确认后再提升重试次数。"];
  }
  return ["复用 input artifact 和 idempotencyKey 重试该 worker。"];
}

function requiredFixesForTool(tool: AgentRuntimeToolCall) {
  const blocking = tool.guardrails.filter((guardrail) => guardrail.status === "block");
  if (blocking.some((guardrail) => /key|Provider/i.test(`${guardrail.id} ${guardrail.message}`))) {
    return ["补齐 provider/API key 后重试该 tool call。"];
  }
  if (blocking.length) {
    return blocking.slice(0, 3).map((guardrail) => `${guardrail.label}: ${guardrail.message}`);
  }
  if (tool.status === "skipped") {
    return ["补齐输入或确认跳过原因后重试。"];
  }
  return ["复用 cacheKey/idempotencyKey 重试该 tool call。"];
}

function retryActionForWorker(run: AgentWorkerRun): AgentResumePlan["targets"][number]["retryAction"] {
  const reason = `${run.errorMessage || ""} ${run.outputSummary || ""}`.toLowerCase();
  if (run.failureCode === "missing_provider_key") return "provide_key";
  if (run.failureCode === "input_guardrail_blocked") return "review_guardrail";
  if (run.failureCode === "user_input_required") return "provide_evidence";
  if (reason.includes("missing") || reason.includes("未配置") || reason.includes("key")) return "provide_key";
  if (run.status === "skipped") return "provide_evidence";
  return "retry_worker";
}

function retryActionForTool(tool: AgentRuntimeToolCall): AgentResumePlan["targets"][number]["retryAction"] {
  const blocking = tool.guardrails.filter((guardrail) => guardrail.status === "block");
  if (blocking.some((guardrail) => /key|Provider/i.test(`${guardrail.id} ${guardrail.message}`))) return "provide_key";
  if (tool.status === "blocked") return "review_guardrail";
  return "retry_tool";
}

function resumeHintForTool(tool: AgentRuntimeToolCall) {
  if (tool.status === "blocked") {
    return `可在修复 guardrail 后从 tool ${tool.toolId} 恢复；cacheKey ${tool.cacheKey || "未记录"}。`;
  }
  if (tool.status === "skipped") {
    return `可在补齐输入后重试 tool ${tool.toolId}；cacheKey ${tool.cacheKey || "未记录"}。`;
  }
  return `可重试 tool ${tool.toolId}；优先检查 cacheKey ${tool.cacheKey || "未记录"} 和 artifact ${tool.artifactIds.join(", ") || "无"}。`;
}

function emptyBudgetUsed(): AgentWorkerBudgetUsed {
  return {
    toolCalls: 0,
    searchQueries: 0,
    fetchUrls: 0,
    artifacts: 0,
    outputChars: 0
  };
}

function mergeBudgetUsed(
  current: AgentWorkerBudgetUsed,
  patch?: Partial<AgentWorkerBudgetUsed>
): AgentWorkerBudgetUsed {
  return {
    toolCalls: patch?.toolCalls ?? current.toolCalls,
    searchQueries: patch?.searchQueries ?? current.searchQueries,
    fetchUrls: patch?.fetchUrls ?? current.fetchUrls,
    artifacts: patch?.artifacts ?? current.artifacts,
    outputChars: patch?.outputChars ?? current.outputChars
  };
}

function mergeWarnings(current?: string[], patch?: string[]) {
  if (!patch?.length) return current;
  return [...new Set([...(current ?? []), ...patch])].slice(0, 12);
}

function hasActiveHardInterrupt(trace: AgentRuntimeTrace) {
  return (trace.interrupts ?? []).some(
    (interrupt) =>
      interrupt.status === "active" &&
      (interrupt.mode === "hard" || interrupt.blocksRun === true)
  );
}

function blockedUntilForInterrupt(type: AgentRunInterrupt["type"]): AgentRunInterruptBlockedUntil {
  if (type === "needs_search_key") return "configuration";
  if (type === "needs_material") return "material";
  if (type === "approve_deep_research") return "approval";
  return "user_action";
}

function buildInterruptResumeCheckpoint({
  traceId,
  now,
  input,
  requiredActions
}: {
  traceId: string;
  now: string;
  input: RunInterruptInput;
  requiredActions: string[];
}): AgentRunInterruptResumeCheckpoint {
  const targetId =
    input.resumeTargetId ??
    input.toolCallId ??
    input.workerRunId ??
    (input.taskNodeId ? `task:${input.taskNodeId}` : undefined);
  return {
    id: `interrupt-checkpoint-${crypto.randomUUID()}`,
    createdAt: now,
    targetId,
    targetKind: input.toolCallId
      ? "tool_call"
      : input.workerRunId
        ? "worker_run"
        : input.taskNodeId
          ? "task_node"
          : "unknown",
    taskNodeId: input.taskNodeId,
    relatedTaskNodeIds: input.resumeCheckpoint?.relatedTaskNodeIds,
    workerRunId: input.workerRunId,
    toolCallId: input.toolCallId,
    artifactIds: input.artifactIds ?? [],
    sourceArtifactIds:
      input.resumeCheckpoint?.sourceArtifactIds ?? input.artifactIds ?? [],
    inputSummary:
      input.resumeCheckpoint?.inputSummary ??
      `${input.source.label}: ${input.source.reason}`,
    resumeStrategy:
      input.resumeCheckpoint?.resumeStrategy ??
      (targetId
        ? `用户处理 ${input.type} 后，从 ${targetId} 创建恢复请求。`
        : `用户处理 ${input.type} 后，需要全量重跑或人工选择恢复目标。`),
    requiredActions
  };
}

export function workerBudget(input: AgentWorkerBudget): AgentWorkerBudget {
  return input;
}

function resumeHintForWorker(run: AgentWorkerRun) {
  if (run.status === "failed") {
    return `可从 worker ${run.workerId} 重试；复用 artifact ${run.artifactIds.join(", ") || "无"}，幂等键 ${run.idempotencyKey || "未记录"}。`;
  }
  if (run.status === "skipped") {
    return `可在补齐环境变量或用户证据后从 worker ${run.workerId} 恢复；幂等键 ${run.idempotencyKey || "未记录"}。`;
  }
  return `可从 worker ${run.workerId} 的 artifact/handoff 继续，避免重新读取大上下文；幂等键 ${run.idempotencyKey || "未记录"}。`;
}
