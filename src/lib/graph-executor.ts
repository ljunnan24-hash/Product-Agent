import type {
  AgentGraphExecutorState,
  AgentRunInterruptType,
  AgentRuntimeSubagentId,
  AgentRuntimeToolId,
  AgentTaskGraph,
  AgentTaskGraphNode,
  AgentTaskNodeDefinition,
  AgentTaskNodeExecution,
  AgentTaskNodeFreshnessPolicy,
  AgentTaskNodeKind,
  AgentTaskNodeRetryPolicy,
  AgentTaskNodeStatus,
  AgentWorkerFailureCode
} from "./types";
import { getTaskNodeRegistryLink } from "./subagent-registry";

export const graphExecutorVersion = "graph-executor-v1" as const;

type RefreshGraphExecutorInput = {
  graph: AgentTaskGraph;
  now?: string;
};

type TaskNodeTransitionInput = {
  graph: AgentTaskGraph;
  taskNodeId: string;
  status: AgentTaskNodeStatus;
  now?: string;
  outputSummary?: string;
  blockedByTaskNodeIds?: string[];
  leaseOwnerId?: string;
  leaseTtlMs?: number;
};

type QueueReadyTaskNodesInput = {
  graph: AgentTaskGraph;
  now?: string;
  limit?: number;
  leaseOwnerId?: string;
  leaseTtlMs?: number;
};

export function refreshGraphExecutor(input: RefreshGraphExecutorInput): AgentTaskGraph {
  const now = input.now ?? new Date().toISOString();
  const definitions = reconcileTaskNodeDefinitions(input.graph.nodes, input.graph.definitions);
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const nodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const nodes = input.graph.nodes.map((node) => {
    const definition = definitionById.get(node.id) ?? defaultTaskNodeDefinition(node);
    const blockedByTaskNodeIds = blockedDependenciesFor(node, nodeById);
    return {
      ...node,
      execution: buildTaskNodeExecution({
        node,
        definition,
        now,
        blockedByTaskNodeIds
      })
    };
  });
  const executor = buildGraphExecutorState({ ...input.graph, nodes, definitions }, now);
  return {
    ...input.graph,
    executorVersion: graphExecutorVersion,
    updatedAt: now,
    definitions,
    executor,
    nodes
  };
}

export function transitionTaskNode(input: TaskNodeTransitionInput): AgentTaskGraph {
  const now = input.now ?? new Date().toISOString();
  const graph = refreshGraphExecutor({ graph: input.graph, now });
  const nodes = graph.nodes.map((node) => {
    if (node.id !== input.taskNodeId) return node;
    const execution = node.execution ?? buildTaskNodeExecution({
      node,
      definition: defaultTaskNodeDefinition(node),
      now,
      blockedByTaskNodeIds: input.blockedByTaskNodeIds ?? []
    });
    const nextExecution = transitionExecution({
      execution,
      status: input.status,
      now,
      blockedByTaskNodeIds: input.blockedByTaskNodeIds,
      leaseOwnerId: input.leaseOwnerId,
      leaseTtlMs: input.leaseTtlMs
    });
    return {
      ...node,
      status: input.status,
      outputSummary:
        isTerminalTaskStatus(input.status) || input.status === "interrupted"
          ? input.outputSummary ?? node.outputSummary
          : node.outputSummary,
      blockedBy: input.blockedByTaskNodeIds?.length
        ? input.blockedByTaskNodeIds
        : input.status === "interrupted"
          ? node.blockedBy
          : node.blockedBy,
      execution: nextExecution
    };
  });
  return refreshGraphExecutor({
    graph: {
      ...graph,
      nodes
    },
    now
  });
}

export function queueReadyTaskNodes(input: QueueReadyTaskNodesInput): AgentTaskGraph {
  const now = input.now ?? new Date().toISOString();
  const graph = refreshGraphExecutor({ graph: input.graph, now });
  const ready = graph.executor?.readyNodeIds ?? [];
  const selected = new Set(ready.slice(0, input.limit ?? ready.length));
  if (!selected.size) return graph;
  const nodes = graph.nodes.map((node) => {
    if (!selected.has(node.id)) return node;
    const execution = transitionExecution({
      execution: node.execution ?? buildTaskNodeExecution({
        node,
        definition: defaultTaskNodeDefinition(node),
        now,
        blockedByTaskNodeIds: []
      }),
      status: "queued",
      now,
      leaseOwnerId: input.leaseOwnerId,
      leaseTtlMs: input.leaseTtlMs
    });
    return {
      ...node,
      status: "queued" as const,
      execution
    };
  });
  return refreshGraphExecutor({
    graph: {
      ...graph,
      nodes
    },
    now
  });
}

export function defaultTaskNodeDefinition(node: AgentTaskGraphNode): AgentTaskNodeDefinition {
  const profile = taskNodeProfile(node.kind);
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    description: profile.description,
    dependsOn: node.dependsOn,
    inputSchema: profile.inputSchema,
    outputSchema: profile.outputSchema,
    allowedTools: profile.allowedTools,
    subagent: profile.subagent,
    workerId: profile.workerId,
    priority: profile.priority,
    concurrencyGroup: profile.concurrencyGroup,
    timeoutMs: profile.timeoutMs,
    retryPolicy: profile.retryPolicy,
    interruptPolicy: {
      hardInterruptTypes: profile.hardInterruptTypes,
      approvalRequired: profile.approvalRequired,
      blockDownstreamOnFailure: profile.blockDownstreamOnFailure,
      userActionHint: profile.userActionHint
    },
    freshnessPolicy: profile.freshnessPolicy,
    registry: getTaskNodeRegistryLink(node.kind, profile.workerId)
  };
}

export function isTaskNodeReady(node: AgentTaskGraphNode, statusById: Map<string, AgentTaskNodeStatus>) {
  if (node.status !== "pending") return false;
  return node.dependsOn.every((dependency) => {
    const status = statusById.get(dependency);
    return status === "completed" || status === "skipped";
  });
}

export function isTaskNodeDependencySatisfied(node: AgentTaskGraphNode | undefined) {
  if (!node) return false;
  if (node.metrics?.graphExecutorBlocked) return false;
  return node.status === "completed" || node.status === "skipped";
}

export function isTerminalTaskStatus(status: AgentTaskNodeStatus) {
  return status === "completed" || status === "failed" || status === "skipped" || status === "cancelled";
}

function reconcileTaskNodeDefinitions(
  nodes: AgentTaskGraphNode[],
  existing: AgentTaskGraph["definitions"] | undefined
) {
  const existingById = new Map((existing ?? []).map((definition) => [definition.id, definition]));
  return nodes.map((node) => ({
    ...defaultTaskNodeDefinition(node),
    ...(existingById.get(node.id) ?? {}),
    id: node.id,
    kind: node.kind,
    label: node.label,
    dependsOn: node.dependsOn
  }));
}

function buildGraphExecutorState(graph: AgentTaskGraph, now: string): AgentGraphExecutorState {
  const statusById = new Map(graph.nodes.map((node) => [node.id, node.status]));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const warnings: string[] = [];
  const readyNodeIds: string[] = [];
  const queuedNodeIds: string[] = [];
  const runningNodeIds: string[] = [];
  const blockedNodeIds: string[] = [];
  const terminalNodeIds: string[] = [];
  const staleNodeIds: string[] = [];
  const cancelledNodeIds: string[] = [];

  for (const node of graph.nodes) {
    if (node.dependsOn.some((dependency) => !statusById.has(dependency))) {
      warnings.push(`${node.id} depends on missing node ${node.dependsOn.find((dependency) => !statusById.has(dependency))}.`);
    }
    if (node.status === "pending" && node.dependsOn.every((dependency) => isTaskNodeDependencySatisfied(nodeById.get(dependency)))) {
      readyNodeIds.push(node.id);
    }
    if (node.status === "queued") queuedNodeIds.push(node.id);
    if (node.status === "running") runningNodeIds.push(node.id);
    if (node.status === "failed" || node.status === "interrupted") blockedNodeIds.push(node.id);
    if (isTerminalTaskStatus(node.status)) terminalNodeIds.push(node.id);
    if (node.status === "cancelled") cancelledNodeIds.push(node.id);
    if (isNodeStale(node, now)) staleNodeIds.push(node.id);
  }

  for (const node of graph.nodes) {
    const blockedBy = blockedDependenciesFor(node, nodeById);
    if (node.status === "pending" && blockedBy.length) blockedNodeIds.push(node.id);
  }

  return {
    version: graphExecutorVersion,
    updatedAt: now,
    readyNodeIds: [...new Set(readyNodeIds)],
    queuedNodeIds: [...new Set(queuedNodeIds)],
    runningNodeIds: [...new Set(runningNodeIds)],
    blockedNodeIds: [...new Set(blockedNodeIds)],
    terminalNodeIds: [...new Set(terminalNodeIds)],
    staleNodeIds: [...new Set(staleNodeIds)],
    cancelledNodeIds: [...new Set(cancelledNodeIds)],
    warnings: [...new Set(warnings)].slice(0, 20)
  };
}

function buildTaskNodeExecution({
  node,
  definition,
  now,
  blockedByTaskNodeIds
}: {
  node: AgentTaskGraphNode;
  definition: AgentTaskNodeDefinition;
  now: string;
  blockedByTaskNodeIds: string[];
}): AgentTaskNodeExecution {
  const current = node.execution;
  return {
    executorVersion: graphExecutorVersion,
    definitionId: definition.id,
    priority: definition.priority,
    concurrencyGroup: definition.concurrencyGroup,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    allowedTools: definition.allowedTools,
    timeoutMs: definition.timeoutMs,
    attempt: current?.attempt ?? 0,
    maxAttempts: definition.retryPolicy.maxAttempts,
    queuedAt: node.status === "queued" ? current?.queuedAt ?? now : current?.queuedAt,
    cancelledAt: node.status === "cancelled" ? current?.cancelledAt ?? now : current?.cancelledAt,
    lastTransitionAt: current?.lastTransitionAt ?? now,
    blockedByTaskNodeIds,
    lease: current?.lease,
    retryPolicy: definition.retryPolicy,
    interruptPolicy: definition.interruptPolicy,
    freshnessPolicy: definition.freshnessPolicy
  };
}

function transitionExecution({
  execution,
  status,
  now,
  blockedByTaskNodeIds,
  leaseOwnerId,
  leaseTtlMs
}: {
  execution: AgentTaskNodeExecution;
  status: AgentTaskNodeStatus;
  now: string;
  blockedByTaskNodeIds?: string[];
  leaseOwnerId?: string;
  leaseTtlMs?: number;
}): AgentTaskNodeExecution {
  const lease =
    status === "queued" || status === "running"
      ? leaseOwnerId
        ? {
            id: crypto.randomUUID(),
            ownerId: leaseOwnerId,
            acquiredAt: now,
            expiresAt: new Date(new Date(now).getTime() + (leaseTtlMs ?? execution.timeoutMs)).toISOString()
          }
        : execution.lease
      : undefined;
  return {
    ...execution,
    attempt: status === "running" ? execution.attempt + 1 : execution.attempt,
    queuedAt: status === "queued" ? execution.queuedAt ?? now : execution.queuedAt,
    cancelledAt: status === "cancelled" ? now : execution.cancelledAt,
    lastTransitionAt: now,
    blockedByTaskNodeIds: blockedByTaskNodeIds ?? execution.blockedByTaskNodeIds,
    lease
  };
}

function blockedDependenciesFor(
  node: AgentTaskGraphNode,
  nodeById: Map<string, AgentTaskGraphNode>
) {
  return node.dependsOn.filter((dependency) => {
    const dependencyNode = nodeById.get(dependency);
    return !isTaskNodeDependencySatisfied(dependencyNode);
  });
}

function isNodeStale(node: AgentTaskGraphNode, now: string) {
  const maxAgeDays = node.execution?.freshnessPolicy?.evidenceMaxAgeDays;
  if (!maxAgeDays || !node.completedAt) return false;
  const ageMs = new Date(now).getTime() - new Date(node.completedAt).getTime();
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

function taskNodeProfile(kind: AgentTaskNodeKind): {
  description: string;
  inputSchema: string;
  outputSchema: string;
  allowedTools: AgentRuntimeToolId[];
  subagent?: AgentRuntimeSubagentId;
  workerId?: string;
  priority: number;
  concurrencyGroup: string;
  timeoutMs: number;
  retryPolicy: AgentTaskNodeRetryPolicy;
  hardInterruptTypes: AgentRunInterruptType[];
  approvalRequired: boolean;
  blockDownstreamOnFailure: boolean;
  userActionHint: string;
  freshnessPolicy?: AgentTaskNodeFreshnessPolicy;
} {
  const defaultRetry = retryPolicy(1, []);
  if (kind === "material_fetch") {
    return profile({
      description: "读取用户上传材料、PDF、README、截图或 GitHub 导入内容。",
      inputSchema: "UploadedMaterial[] | GitHub repository URL",
      outputSchema: "trusted metadata + untrusted extracted material artifact refs",
      allowedTools: ["file_read", "pdf_extract", "github_import", "ocr"],
      subagent: "research_supervisor",
      workerId: "material_fetch_worker",
      priority: 1,
      concurrencyGroup: "material",
      timeoutMs: 60_000,
      retryPolicy: retryPolicy(2, ["tool_failed", "schema_invalid"]),
      hardInterruptTypes: ["needs_material"],
      userActionHint: "补充 README/PDF/截图或允许继续使用已有材料。"
    });
  }
  if (kind === "query_plan") {
    return profile({
      description: "把产品假设、生命周期和证据缺口拆成可执行查询。",
      inputSchema: "product thesis + evidence brief + source budget",
      outputSchema: "EvidenceSearchQuery[]",
      allowedTools: ["query_plan"],
      subagent: "query_planner",
      workerId: "query_planner",
      priority: 2,
      concurrencyGroup: "planning",
      timeoutMs: 45_000,
      retryPolicy: defaultRetry,
      userActionHint: "查询规划失败时，补充目标用户或产品边界后重试该节点。"
    });
  }
  if (
    kind === "support_search" ||
    kind === "opposition_search" ||
    kind === "freshness_search" ||
    kind === "competitor_search" ||
    kind === "posterior_search"
  ) {
    return profile({
      description: "执行隔离网页搜索，只返回候选结果、状态和失败原因。",
      inputSchema: "EvidenceSearchQuery[]",
      outputSchema: "WebEvidence[] + provider quality metrics",
      allowedTools: ["web_search"],
      subagent: kind === "opposition_search" ? "opposition_scout" : "search_worker",
      workerId: `${kind}_worker`,
      priority: kind === "opposition_search" ? 2 : 3,
      concurrencyGroup: "web_search",
      timeoutMs: 90_000,
      retryPolicy: retryPolicy(2, ["missing_provider_key", "network_error", "provider_error", "no_results"]),
      hardInterruptTypes: ["needs_search_key", "approve_deep_research"],
      approvalRequired: kind === "freshness_search" || kind === "competitor_search",
      userActionHint: "补齐搜索能力或批准继续深查后，从该搜索节点恢复。",
      freshnessPolicy: {
        evidenceMaxAgeDays: kind === "freshness_search" ? 30 : 90,
        refreshBeforeReport: true
      }
    });
  }
  if (kind === "result_fetch") {
    return profile({
      description: "抓取搜索结果正文并压缩为不可信网页证据 artifact。",
      inputSchema: "public URL[] + source query refs",
      outputSchema: "webpage snapshot artifact refs + extracted dates",
      allowedTools: ["web_fetch"],
      subagent: "web_fetch_worker",
      workerId: "web_fetch_worker",
      priority: 4,
      concurrencyGroup: "web_fetch",
      timeoutMs: 120_000,
      retryPolicy: retryPolicy(2, ["network_error", "provider_error", "tool_failed", "timeout"]),
      hardInterruptTypes: ["approve_deep_research"],
      userActionHint: "批准继续抓取或减少 URL 后，从正文抓取节点恢复。",
      freshnessPolicy: {
        evidenceMaxAgeDays: 90,
        refreshBeforeReport: true
      }
    });
  }
  if (kind === "evidence_extract") {
    return profile({
      description: "把材料、搜索结果和网页正文压缩为 Evidence Card 与 handoff。",
      inputSchema: "material refs + WebEvidence[] + webpage snapshot refs",
      outputSchema: "EvidenceCard[] + Handoff Packet",
      allowedTools: ["evidence_extract", "handoff"],
      subagent: "evidence_extractor",
      workerId: "evidence_extractor",
      priority: 5,
      concurrencyGroup: "evidence_extract",
      timeoutMs: 60_000,
      retryPolicy: retryPolicy(1, ["schema_invalid", "tool_failed"]),
      userActionHint: "先恢复上游搜索/抓取节点，再重建证据交接。"
    });
  }
  if (kind === "code_execute") {
    return profile({
      description: "在受限沙箱中执行计算、数据分析或轻量可视化，并把结果作为 artifact 交接。",
      inputSchema: "restricted Python code + sandbox input files",
      outputSchema: "stdout/stderr + computed metrics + output file refs",
      allowedTools: ["code_execute", "handoff"],
      subagent: "code_executor",
      workerId: "code-executor",
      priority: 5,
      concurrencyGroup: "code_execute",
      timeoutMs: 20_000,
      retryPolicy: retryPolicy(1, ["tool_failed", "timeout", "schema_invalid"]),
      userActionHint: "缩小输入文件、修正代码或改用手动指标后，从代码执行节点恢复。"
    });
  }
  if (kind === "judge") {
    return profile({
      description: "根据证据标准、反证覆盖和时效规则裁决报告强度。",
      inputSchema: "EvidenceBrief + SourceBudget + SearchQuality",
      outputSchema: "AgentJudgeVerdict",
      allowedTools: ["judge"],
      subagent: "judge_agent",
      workerId: "judge_agent",
      priority: 6,
      concurrencyGroup: "judge",
      timeoutMs: 30_000,
      retryPolicy: retryPolicy(1, ["schema_invalid"]),
      hardInterruptTypes: ["needs_material", "approve_deep_research", "evidence_too_weak_for_report"],
      userActionHint: "补材料、批准深查或接受降级报告边界后，从 Judge 节点恢复。"
    });
  }
  if (kind === "report") {
    return profile({
      description: "在 Judge 边界内生成证据约束报告，不发明新证据。",
      inputSchema: "EvidenceBrief + JudgeVerdict + Handoff refs",
      outputSchema: "model report + evidence bindings",
      allowedTools: ["model_report"],
      subagent: "report_composer",
      workerId: "report_composer",
      priority: 7,
      concurrencyGroup: "report",
      timeoutMs: 90_000,
      retryPolicy: retryPolicy(1, ["provider_error", "schema_invalid"]),
      userActionHint: "报告生成失败时，只重放 Report Composer。"
    });
  }
  if (kind === "evidence_loop") {
    return profile({
      description: "根据证据缺口、质检问题和停止规则发起补证循环。",
      inputSchema: "EvidenceBrief + quality gaps",
      outputSchema: "loop trigger + target assumptions",
      allowedTools: ["query_plan", "handoff"],
      subagent: "research_supervisor",
      workerId: "evidence_loop_supervisor",
      priority: 2,
      concurrencyGroup: "planning",
      timeoutMs: 30_000,
      retryPolicy: defaultRetry,
      hardInterruptTypes: ["approve_deep_research"],
      approvalRequired: true,
      userActionHint: "批准补证预算后继续该轮 evidence loop。"
    });
  }
  return profile({
    description: "主研究编排节点，只负责规划、分派、合并和交接。",
    inputSchema: "product brief + material refs",
    outputSchema: "research plan + handoff refs",
    allowedTools: ["handoff"],
    subagent: "research_supervisor",
    workerId: "research_supervisor",
    priority: 1,
    concurrencyGroup: "supervisor",
    timeoutMs: 30_000,
    retryPolicy: defaultRetry,
    userActionHint: "确认目标用户、材料或竞品集合后继续。"
  });
}

function profile<T extends ReturnType<typeof taskNodeProfile>>(value: Partial<T> & {
  description: string;
  inputSchema: string;
  outputSchema: string;
  allowedTools: AgentRuntimeToolId[];
  priority: number;
  concurrencyGroup: string;
  timeoutMs: number;
  retryPolicy: AgentTaskNodeRetryPolicy;
  userActionHint: string;
}) {
  return {
    hardInterruptTypes: [] as AgentRunInterruptType[],
    approvalRequired: false,
    blockDownstreamOnFailure: true,
    ...value
  };
}

function retryPolicy(
  maxAttempts: number,
  retryableFailures: AgentWorkerFailureCode[],
  backoffMs = 1_500
): AgentTaskNodeRetryPolicy {
  return {
    maxAttempts,
    backoffMs,
    retryableFailures
  };
}
