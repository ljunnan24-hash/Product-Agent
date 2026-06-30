import { promises as fs } from "fs";
import path from "path";
import type {
  AgentTaskNodeDefinition,
  AgentTaskNodeExecution,
  AgentWorkerDefinition,
  AgentWorkerQueueItemStatus,
  DurableWorkerQueueMaintenanceResult,
  DurableWorkerQueueRecord
} from "./types";

const queueDir = path.join(process.cwd(), ".taste-data", "worker-queue");
const queueInputDir = path.join(process.cwd(), ".taste-data", "worker-queue-inputs");

type CreateDurableWorkerQueueRecordInput = {
  id?: string;
  traceId: string;
  queueItemId: string;
  queueLabel: string;
  definition: AgentWorkerDefinition;
  taskNodeDefinition?: AgentTaskNodeDefinition;
  taskNodeExecution?: AgentTaskNodeExecution;
  inputSummary: string;
  inputPayload?: unknown;
  taskNodeId?: string;
  parentSpanId?: string;
  priority?: number;
  concurrencyGroup?: string;
  sourceArtifactIds?: string[];
  metrics?: Record<string, number | string | boolean>;
  resumeStrategy?: string;
  idempotencyKey?: string;
};

type FinishDurableWorkerQueueRecordInput = {
  status: Extract<AgentWorkerQueueItemStatus, "completed" | "failed" | "skipped" | "cancelled">;
  workerRunId?: string;
  artifactIds?: string[];
  outputArtifactRefs?: string[];
  outputSummary: string;
  errorMessage?: string;
  metrics?: Record<string, number | string | boolean>;
};

type MaintainDurableWorkerQueueInput = {
  now?: Date;
  limit?: number;
  expiredMode?: "requeue" | "fail";
};

export async function ensureDurableWorkerQueueDir() {
  await fs.mkdir(queueDir, { recursive: true });
  await fs.mkdir(queueInputDir, { recursive: true });
}

export async function createDurableWorkerQueueRecord(
  input: CreateDurableWorkerQueueRecordInput
): Promise<DurableWorkerQueueRecord> {
  await ensureDurableWorkerQueueDir();
  const now = new Date().toISOString();
  const id = input.id ?? crypto.randomUUID();
  const payloadWrite = input.inputPayload === undefined
    ? null
    : await writeDurableWorkerInputPayload(id, input.inputPayload);
  const record: DurableWorkerQueueRecord = {
    id,
    version: "durable-worker-queue-v1",
    traceId: input.traceId,
    queueItemId: input.queueItemId,
    createdAt: now,
    updatedAt: now,
    queueLabel: input.queueLabel,
    workerId: input.definition.id,
    workerLabel: input.definition.label,
    definition: input.definition,
    taskNodeDefinition: input.taskNodeDefinition,
    taskNodeExecution: input.taskNodeExecution,
    taskNodeId: input.taskNodeId,
    parentSpanId: input.parentSpanId,
    status: "queued",
    priority: input.priority ?? 5,
    concurrencyGroup: input.concurrencyGroup ?? input.definition.subagent,
    enqueuedAt: now,
    attempt: 0,
    maxAttempts: Math.max(1, input.definition.maxAttempts || 1),
    inputSummary: input.inputSummary,
    inputPayloadRef: payloadWrite?.storageRef,
    inputPayloadPreview: payloadWrite?.preview,
    sourceArtifactIds: input.sourceArtifactIds ?? [],
    artifactIds: [],
    metrics: input.metrics,
    resume: {
      strategy:
        input.resumeStrategy ??
        "从 durable queue record 读取 worker definition、input payload ref、artifact refs 和 idempotencyKey 后重建 worker。",
      requiredArtifactIds: input.sourceArtifactIds ?? [],
      idempotencyKey: input.idempotencyKey
    }
  };
  await saveDurableWorkerQueueRecord(record);
  return record;
}

export async function markDurableWorkerQueueRunning({
  id,
  leaseOwner = inlineLeaseOwner(),
  leaseMs = 10 * 60 * 1000
}: {
  id: string;
  leaseOwner?: string;
  leaseMs?: number;
}) {
  const record = await getDurableWorkerQueueRecord(id);
  if (!record) return null;
  if (isTerminalStatus(record.status)) return record;
  if (record.status === "queued" && record.cancelRequestedAt) {
    return finalizeDurableWorkerQueueCancellation(record, record.cancellationReason || "已请求取消。");
  }
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  const startedAt = record.startedAt ?? now;
  const next: DurableWorkerQueueRecord = {
    ...record,
    status: "running",
    updatedAt: now,
    startedAt,
    attempt: (record.attempt ?? 0) + 1,
    maxAttempts: record.maxAttempts ?? Math.max(1, record.definition.maxAttempts || 1),
    waitMs: Math.max(0, new Date(startedAt).getTime() - new Date(record.enqueuedAt).getTime()),
    lease: {
      owner: leaseOwner,
      acquiredAt: now,
      expiresAt: leaseExpiresAt
    }
  };
  await saveDurableWorkerQueueRecord(next);
  return next;
}

export async function finishDurableWorkerQueueRecord(
  id: string,
  input: FinishDurableWorkerQueueRecordInput
) {
  const record = await getDurableWorkerQueueRecord(id);
  if (!record) return null;
  const now = new Date().toISOString();
  const startedAt = record.startedAt ?? now;
  const completedAt = now;
  const next: DurableWorkerQueueRecord = {
    ...record,
    status: input.status,
    updatedAt: now,
    startedAt,
    completedAt,
    waitMs: record.waitMs ?? Math.max(0, new Date(startedAt).getTime() - new Date(record.enqueuedAt).getTime()),
    latencyMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
    workerRunId: input.workerRunId ?? record.workerRunId,
    artifactIds: [...new Set([...record.artifactIds, ...(input.artifactIds ?? [])])],
    outputArtifactRefs: [
      ...new Set([...(record.outputArtifactRefs ?? []), ...(input.outputArtifactRefs ?? [])])
    ],
    outputSummary: input.outputSummary,
    errorMessage: input.errorMessage ?? record.errorMessage,
    metrics: {
      ...(record.metrics ?? {}),
      ...(input.metrics ?? {})
    },
    lease: undefined
  };
  await saveDurableWorkerQueueRecord(next);
  return next;
}

export async function failDurableWorkerQueueRecord(
  id: string,
  errorMessage: string,
  patch?: Omit<Partial<FinishDurableWorkerQueueRecordInput>, "status" | "outputSummary">
) {
  return finishDurableWorkerQueueRecord(id, {
    status: "failed",
    outputSummary: errorMessage,
    errorMessage,
    workerRunId: patch?.workerRunId,
    artifactIds: patch?.artifactIds,
    outputArtifactRefs: patch?.outputArtifactRefs,
    metrics: patch?.metrics
  });
}

export async function finishDurableWorkerQueueCancellation(
  id: string,
  reason: string,
  patch?: Omit<Partial<FinishDurableWorkerQueueRecordInput>, "status" | "outputSummary">
) {
  return finishDurableWorkerQueueRecord(id, {
    status: "cancelled",
    outputSummary: `已取消：${reason}`,
    errorMessage: reason,
    workerRunId: patch?.workerRunId,
    artifactIds: patch?.artifactIds,
    outputArtifactRefs: patch?.outputArtifactRefs,
    metrics: {
      ...(patch?.metrics ?? {}),
      cancelled: true
    }
  });
}

export async function cancelDurableWorkerQueueRecord(id: string, reason: string) {
  const record = await getDurableWorkerQueueRecord(id);
  if (!record) return null;
  if (isTerminalStatus(record.status)) return record;
  if (record.status === "queued") {
    return finalizeDurableWorkerQueueCancellation(record, reason);
  }
  const now = new Date().toISOString();
  const next: DurableWorkerQueueRecord = {
    ...record,
    updatedAt: now,
    cancelRequestedAt: now,
    cancellationReason: reason,
    outputSummary: record.outputSummary
  };
  await saveDurableWorkerQueueRecord(next);
  return next;
}

export async function requeueDurableWorkerQueueRecord(id: string, reason: string) {
  const record = await getDurableWorkerQueueRecord(id);
  if (!record) return null;
  if (record.status === "completed" || record.status === "cancelled") return record;
  const next = requeueRecord(record, reason);
  await saveDurableWorkerQueueRecord(next);
  return next;
}

export async function maintainDurableWorkerQueue({
  now = new Date(),
  limit = 500,
  expiredMode = "requeue"
}: MaintainDurableWorkerQueueInput = {}): Promise<DurableWorkerQueueMaintenanceResult> {
  const records = await listDurableWorkerQueueRecords({ limit });
  const changed: DurableWorkerQueueRecord[] = [];
  let cancelled = 0;
  let requeued = 0;
  let failedExpired = 0;
  let stillRunning = 0;

  for (const record of records) {
    if (record.status === "queued" && record.cancelRequestedAt) {
      const next = await finalizeDurableWorkerQueueCancellation(
        record,
        record.cancellationReason || "已请求取消。"
      );
      changed.push(next);
      cancelled += 1;
      continue;
    }

    if (record.status !== "running") continue;
    const expired = isLeaseExpired(record, now);
    if (!expired) {
      stillRunning += 1;
      continue;
    }

    if (record.cancelRequestedAt) {
      const next = await finalizeDurableWorkerQueueCancellation(
        record,
        record.cancellationReason || "运行中取消请求已在 lease 过期后生效。"
      );
      changed.push(next);
      cancelled += 1;
      continue;
    }

    const attempts = record.attempt ?? 0;
    const maxAttempts = record.maxAttempts ?? Math.max(1, record.definition.maxAttempts || 1);
    if (expiredMode === "requeue" && attempts < maxAttempts) {
      const next = requeueRecord(record, `lease expired at ${record.lease?.expiresAt || "unknown"}`);
      await saveDurableWorkerQueueRecord(next);
      changed.push(next);
      requeued += 1;
      continue;
    }

    const next = await failDurableWorkerQueueRecord(
      record.id,
      `worker lease expired at ${record.lease?.expiresAt || "unknown"}; attempts ${attempts}/${maxAttempts}.`
    );
    if (next) {
      changed.push(next);
      failedExpired += 1;
    }
  }

  return {
    scanned: records.length,
    cancelled,
    requeued,
    failedExpired,
    stillRunning,
    records: changed
  };
}

export async function getDurableWorkerQueueRecord(
  id: string
): Promise<DurableWorkerQueueRecord | null> {
  try {
    await ensureDurableWorkerQueueDir();
    const raw = await fs.readFile(queueRecordPath(id), "utf8");
    return JSON.parse(raw) as DurableWorkerQueueRecord;
  } catch {
    return null;
  }
}

export async function readDurableWorkerInputPayload<T = unknown>(
  recordOrRef: DurableWorkerQueueRecord | string
): Promise<T | null> {
  const storageRef =
    typeof recordOrRef === "string" ? recordOrRef : recordOrRef.inputPayloadRef;
  if (!storageRef) return null;
  const rootDir = path.resolve(queueInputDir);
  const targetPath = path.resolve(process.cwd(), storageRef);
  if (
    !storageRef.startsWith(path.join(".taste-data", "worker-queue-inputs")) ||
    !(targetPath === rootDir || targetPath.startsWith(`${rootDir}${path.sep}`))
  ) {
    return null;
  }
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    const entry = JSON.parse(raw) as { payload?: T };
    return entry.payload ?? null;
  } catch {
    return null;
  }
}

export async function listDurableWorkerQueueRecords({
  limit = 80,
  traceId,
  status
}: {
  limit?: number;
  traceId?: string;
  status?: AgentWorkerQueueItemStatus;
} = {}): Promise<DurableWorkerQueueRecord[]> {
  try {
    await ensureDurableWorkerQueueDir();
    const fileNames = await fs.readdir(queueDir);
    const records = await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith(".json"))
        .map(async (fileName) => {
          try {
            const raw = await fs.readFile(path.join(queueDir, fileName), "utf8");
            return JSON.parse(raw) as DurableWorkerQueueRecord;
          } catch {
            return null;
          }
        })
    );
    return records
      .filter((record): record is DurableWorkerQueueRecord => Boolean(record))
      .filter((record) => !traceId || record.traceId === traceId)
      .filter((record) => !status || record.status === status)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function saveDurableWorkerQueueRecord(record: DurableWorkerQueueRecord) {
  await ensureDurableWorkerQueueDir();
  await fs.writeFile(queueRecordPath(record.id), JSON.stringify(record, null, 2), "utf8");
}

async function finalizeDurableWorkerQueueCancellation(
  record: DurableWorkerQueueRecord,
  reason: string
) {
  const now = new Date().toISOString();
  const completedAt = now;
  const startedAt = record.startedAt;
  const next: DurableWorkerQueueRecord = {
    ...record,
    status: "cancelled",
    updatedAt: now,
    completedAt,
    cancelRequestedAt: record.cancelRequestedAt ?? now,
    cancellationReason: reason,
    latencyMs:
      startedAt && completedAt
        ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
        : record.latencyMs,
    outputSummary: `已取消：${reason}`,
    lease: undefined
  };
  await saveDurableWorkerQueueRecord(next);
  return next;
}

function requeueRecord(record: DurableWorkerQueueRecord, reason: string): DurableWorkerQueueRecord {
  const now = new Date().toISOString();
  const requeueCount = numericMetric(record.metrics?.requeueCount) + 1;
  return {
    ...record,
    status: "queued",
    updatedAt: now,
    startedAt: undefined,
    completedAt: undefined,
    waitMs: undefined,
    latencyMs: undefined,
    lease: undefined,
    errorMessage: undefined,
    outputSummary: `已重新入队：${reason}`,
    metrics: {
      ...(record.metrics ?? {}),
      requeueCount,
      lastRequeueReason: reason
    }
  };
}

async function writeDurableWorkerInputPayload(id: string, payload: unknown) {
  await ensureDurableWorkerQueueDir();
  const fileName = `${safeFileSegment(id)}.json`;
  const filePath = path.join(queueInputDir, fileName);
  const content = JSON.stringify(
    {
      queueRecordId: id,
      createdAt: new Date().toISOString(),
      payload
    },
    null,
    2
  );
  await fs.writeFile(filePath, content, "utf8");
  return {
    storageRef: path.join(".taste-data", "worker-queue-inputs", fileName),
    preview: compactPreview(content)
  };
}

function queueRecordPath(id: string) {
  return path.join(queueDir, `${safeFileSegment(id)}.json`);
}

function safeFileSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "queue";
}

function compactPreview(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 700 ? normalized : `${normalized.slice(0, 680)} ...`;
}

function inlineLeaseOwner() {
  return `inline:${process.pid}`;
}

function isLeaseExpired(record: DurableWorkerQueueRecord, now: Date) {
  if (!record.lease?.expiresAt) return false;
  return new Date(record.lease.expiresAt).getTime() <= now.getTime();
}

function isTerminalStatus(status: AgentWorkerQueueItemStatus) {
  return status === "completed" || status === "failed" || status === "skipped" || status === "cancelled";
}

function numericMetric(value: string | number | boolean | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
