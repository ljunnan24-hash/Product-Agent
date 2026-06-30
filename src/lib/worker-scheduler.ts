import { AgentRuntimeHarness } from "./agent-runtime";
import {
  createDurableWorkerQueueRecord,
  failDurableWorkerQueueRecord,
  finishDurableWorkerQueueRecord,
  markDurableWorkerQueueRunning
} from "./durable-worker-queue";
import type {
  AgentTaskGraph,
  AgentTaskGraphNode,
  AgentTaskNodeDefinition,
  AgentTaskNodeExecution,
  AgentTaskNodeStatus,
  AgentWorkerDefinition,
  AgentWorkerQueueItemStatus
} from "./types";

export type WorkerQueueTaskResult<T> = {
  value: T;
  status?: Extract<AgentWorkerQueueItemStatus, "completed" | "failed" | "skipped">;
  workerRunId?: string;
  artifactIds?: string[];
  outputSummary: string;
  errorMessage?: string;
  metrics?: Record<string, number | string | boolean>;
};

export type WorkerQueueTask<T> = {
  id?: string;
  queueLabel: string;
  definition: AgentWorkerDefinition;
  inputSummary: string;
  taskNodeId?: string;
  parentSpanId?: string;
  priority?: number;
  concurrencyGroup?: string;
  sourceArtifactIds?: string[];
  inputPayload?: unknown;
  resumeStrategy?: string;
  idempotencyKey?: string;
  leaseMs?: number;
  metrics?: Record<string, number | string | boolean>;
  respectTaskNodeDependencies?: boolean;
  blockedValue?: T;
  execute: (queueItemId: string) => Promise<WorkerQueueTaskResult<T>>;
};

export async function runWorkerQueue<T>({
  runtime,
  queueLabel,
  tasks,
  concurrency = 2
}: {
  runtime: AgentRuntimeHarness;
  queueLabel: string;
  tasks: WorkerQueueTask<T>[];
  concurrency?: number;
}) {
  if (!tasks.length) return [];
  const traceId = runtime.getTrace().id;
  const results: Array<WorkerQueueTaskResult<T> | undefined> = new Array(tasks.length);
  const queuedTasks = (
    await Promise.all(
      tasks.map(async (task, index) => {
        const queueItemId = task.id ?? crypto.randomUUID();
        const taskGraph = runtime.getTrace().taskGraph;
        const taskNodeSnapshot = task.taskNodeId
          ? taskGraph?.nodes.find((node) => node.id === task.taskNodeId)
          : undefined;
        const taskNodeDefinition = task.taskNodeId
          ? taskGraph?.definitions?.find((definition) => definition.id === task.taskNodeId)
          : undefined;
        const schedule = resolveTaskNodeSchedule({
          task,
          taskGraph,
          taskNodeSnapshot,
          taskNodeDefinition
        });
        const durableRecord = await createDurableWorkerQueueRecord({
          traceId,
          queueItemId,
          queueLabel: task.queueLabel || queueLabel,
          definition: task.definition,
          taskNodeDefinition,
          taskNodeExecution: taskNodeSnapshot?.execution,
          inputSummary: task.inputSummary,
          inputPayload: task.inputPayload,
          taskNodeId: task.taskNodeId,
          parentSpanId: task.parentSpanId,
          priority: schedule.priority,
          concurrencyGroup: schedule.concurrencyGroup,
          sourceArtifactIds: task.sourceArtifactIds,
          metrics: schedule.metrics,
          resumeStrategy: task.resumeStrategy,
          idempotencyKey: task.idempotencyKey
        });
        runtime.enqueueWorkerQueueItem({
          queueItemId,
          durableQueueId: durableRecord.id,
          durableInputRef: durableRecord.inputPayloadRef,
          queueLabel: task.queueLabel || queueLabel,
          definition: task.definition,
          inputSummary: task.inputSummary,
          taskNodeId: task.taskNodeId,
          parentSpanId: task.parentSpanId,
          priority: schedule.priority,
          concurrencyGroup: schedule.concurrencyGroup,
          sourceArtifactIds: task.sourceArtifactIds,
          metrics: {
            ...schedule.metrics,
            durableQueueId: durableRecord.id
          }
        });
        const blockedResult = schedule.blockedBy.length
          ? {
              value: task.blockedValue as T,
              status: "skipped" as const,
              outputSummary: `GraphExecutor 阻止执行：依赖节点未满足（${schedule.blockedBy.join(" / ")}）。`,
              errorMessage: `blocked by task nodes: ${schedule.blockedBy.join(", ")}`,
              metrics: {
                ...schedule.metrics,
                graphExecutorBlocked: true,
                graphExecutorBlockedBy: schedule.blockedBy.join(",")
              }
            }
          : undefined;
        if (blockedResult) {
          runtime.skipWorkerQueueItem(queueItemId, blockedResult.outputSummary, {
            errorMessage: blockedResult.errorMessage,
            metrics: blockedResult.metrics
          });
          await finishDurableWorkerQueueRecord(durableRecord.id, {
            status: "skipped",
            outputSummary: blockedResult.outputSummary,
            errorMessage: blockedResult.errorMessage,
            metrics: blockedResult.metrics
          });
          results[index] = blockedResult;
        }
        return {
          task,
          index,
          queueItemId,
          durableQueueId: durableRecord.id,
          priority: schedule.priority,
          leaseMs: schedule.leaseMs,
          blocked: Boolean(blockedResult)
        };
      })
    )
  )
    .filter((item) => !item.blocked)
    .sort((a, b) => a.priority - b.priority || a.index - b.index);

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, queuedTasks.length));
  if (!queuedTasks.length) {
    return results.filter((item): item is WorkerQueueTaskResult<T> => Boolean(item));
  }

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < queuedTasks.length) {
        const queued = queuedTasks[cursor];
        cursor += 1;
        if (!queued) continue;
        runtime.startWorkerQueueItem(queued.queueItemId);
        const leasedRecord = await markDurableWorkerQueueRunning({
          id: queued.durableQueueId,
          leaseMs: queued.leaseMs
        });
        if (leasedRecord?.status === "cancelled") {
          const cancelledResult: WorkerQueueTaskResult<T> = {
            value: undefined as T,
            status: "skipped",
            outputSummary: leasedRecord.outputSummary || "worker 已在执行前取消。",
            errorMessage: leasedRecord.cancellationReason,
            metrics: {
              cancelled: true
            }
          };
          runtime.skipWorkerQueueItem(queued.queueItemId, cancelledResult.outputSummary, {
            errorMessage: cancelledResult.errorMessage,
            metrics: cancelledResult.metrics
          });
          results[queued.index] = cancelledResult;
          continue;
        }
        try {
          const result = await queued.task.execute(queued.queueItemId);
          const status = result.status ?? "completed";
          if (status === "failed") {
            runtime.failWorkerQueueItem(queued.queueItemId, result.outputSummary, {
              workerRunId: result.workerRunId,
              artifactIds: result.artifactIds,
              errorMessage: result.errorMessage,
              metrics: result.metrics
            });
          } else if (status === "skipped") {
            runtime.skipWorkerQueueItem(queued.queueItemId, result.outputSummary, {
              workerRunId: result.workerRunId,
              artifactIds: result.artifactIds,
              metrics: result.metrics
            });
          } else {
            runtime.completeWorkerQueueItem(queued.queueItemId, result.outputSummary, {
              workerRunId: result.workerRunId,
              artifactIds: result.artifactIds,
              metrics: result.metrics
            });
          }
          await finishDurableWorkerQueueRecord(queued.durableQueueId, {
            status,
            workerRunId: result.workerRunId,
            artifactIds: result.artifactIds,
            outputSummary: result.outputSummary,
            errorMessage: result.errorMessage,
            metrics: result.metrics
          });
          results[queued.index] = result;
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown worker queue error";
          runtime.failWorkerQueueItem(queued.queueItemId, message, {
            errorMessage: message
          });
          await failDurableWorkerQueueRecord(queued.durableQueueId, message);
          throw error;
        }
      }
    })
  );

  return results.filter((item): item is WorkerQueueTaskResult<T> => Boolean(item));
}

function resolveTaskNodeSchedule<T>({
  task,
  taskGraph,
  taskNodeSnapshot,
  taskNodeDefinition
}: {
  task: WorkerQueueTask<T>;
  taskGraph?: AgentTaskGraph;
  taskNodeSnapshot?: AgentTaskGraphNode;
  taskNodeDefinition?: AgentTaskNodeDefinition;
}) {
  const execution = taskNodeSnapshot?.execution;
  const priority = task.priority ?? execution?.priority ?? taskNodeDefinition?.priority ?? 5;
  const concurrencyGroup =
    task.concurrencyGroup ??
    execution?.concurrencyGroup ??
    taskNodeDefinition?.concurrencyGroup ??
    task.definition.subagent;
  const leaseMs = task.leaseMs ?? execution?.timeoutMs ?? taskNodeDefinition?.timeoutMs;
  const blockedBy = task.respectTaskNodeDependencies
    ? graphSchedulingBlockers(taskGraph, taskNodeSnapshot, execution)
    : [];
  return {
    priority,
    concurrencyGroup,
    leaseMs,
    blockedBy,
    metrics: {
      ...(task.metrics ?? {}),
      graphExecutorDriven: Boolean(taskNodeSnapshot?.execution || taskNodeDefinition),
      graphExecutorPriority: priority,
      graphExecutorConcurrencyGroup: concurrencyGroup,
      ...(leaseMs ? { graphExecutorLeaseMs: leaseMs } : {}),
      ...(taskNodeSnapshot ? { graphExecutorTaskStatus: taskNodeSnapshot.status } : {})
    }
  };
}

function graphSchedulingBlockers(
  taskGraph?: AgentTaskGraph,
  taskNodeSnapshot?: AgentTaskGraphNode,
  execution?: AgentTaskNodeExecution
) {
  if (!taskGraph || !taskNodeSnapshot) return [];
  const nodeById = new Map(taskGraph.nodes.map((node) => [node.id, node]));
  const dependencyBlockers = taskNodeSnapshot.dependsOn
    .filter((dependencyId) => !isDependencySatisfied(nodeById.get(dependencyId)))
    .map((dependencyId) => {
      const node = nodeById.get(dependencyId);
      return `${dependencyId}:${node?.status ?? "missing"}`;
    });
  const executionBlockers = (execution?.blockedByTaskNodeIds ?? []).map((dependencyId) => {
    const node = nodeById.get(dependencyId);
    return `${dependencyId}:${node?.status ?? "missing"}`;
  });
  return [...new Set([...dependencyBlockers, ...executionBlockers])];
}

function isDependencySatisfied(node: AgentTaskGraphNode | undefined) {
  if (!node) return false;
  if (node.metrics?.graphExecutorBlocked) return false;
  return node.status === "completed" || node.status === "skipped";
}
