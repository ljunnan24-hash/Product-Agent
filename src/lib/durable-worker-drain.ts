import {
  listDurableWorkerQueueRecords,
  maintainDurableWorkerQueue
} from "./durable-worker-queue";
import {
  replayDurableWorkerQueueRecord,
  type DurableWorkerReplayResult
} from "./durable-worker-replay";
import type { DurableWorkerQueueMaintenanceResult, DurableWorkerQueueRecord } from "./types";

export type DurableWorkerDrainInput = {
  traceId?: string;
  limit?: number;
  scanLimit?: number;
  concurrency?: number;
  leaseMs?: number;
  expiredMode?: "requeue" | "fail";
};

export type DurableWorkerDrainItem = {
  id: string;
  queueItemId: string;
  workerId: string;
  workerLabel: string;
  status: DurableWorkerReplayResult["status"];
  recordStatus: DurableWorkerQueueRecord["status"];
  summary: string;
  artifactRef?: string;
};

export type DurableWorkerDrainResult = {
  drainedAt: string;
  traceId?: string;
  scannedQueued: number;
  selected: number;
  concurrency: number;
  leaseMs: number;
  maintenance: DurableWorkerQueueMaintenanceResult;
  counts: {
    applied: number;
    blocked: number;
    unsupported: number;
    skipped: number;
    errors: number;
  };
  items: DurableWorkerDrainItem[];
};

export async function drainDurableWorkerQueue({
  traceId,
  limit = 10,
  scanLimit = 200,
  concurrency = 2,
  leaseMs = 10 * 60 * 1000,
  expiredMode = "requeue"
}: DurableWorkerDrainInput = {}): Promise<DurableWorkerDrainResult> {
  const safeLimit = clampInt(limit, 1, 100);
  const safeScanLimit = clampInt(Math.max(scanLimit, safeLimit), safeLimit, 1000);
  const safeConcurrency = clampInt(concurrency, 1, 8);
  const safeLeaseMs = clampInt(leaseMs, 30_000, 60 * 60 * 1000);
  const maintenance = await maintainDurableWorkerQueue({
    expiredMode,
    limit: safeScanLimit
  });
  const queued = await listDurableWorkerQueueRecords({
    traceId,
    status: "queued",
    limit: safeScanLimit
  });
  const selected = queued
    .sort(queueSort)
    .slice(0, safeLimit);
  const items: DurableWorkerDrainItem[] = [];
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(safeConcurrency, selected.length || 1) }, async () => {
      while (cursor < selected.length) {
        const record = selected[cursor];
        cursor += 1;
        if (!record) continue;
        const item = await drainOne(record, safeLeaseMs);
        items.push(item);
      }
    })
  );

  return {
    drainedAt: new Date().toISOString(),
    traceId,
    scannedQueued: queued.length,
    selected: selected.length,
    concurrency: safeConcurrency,
    leaseMs: safeLeaseMs,
    maintenance,
    counts: {
      applied: items.filter((item) => item.status === "applied").length,
      blocked: items.filter((item) => item.status === "blocked").length,
      unsupported: items.filter((item) => item.status === "unsupported").length,
      skipped: items.filter((item) => item.status === "skipped").length,
      errors: items.filter((item) => item.status === "blocked" && item.recordStatus === "running").length
    },
    items: items.sort((a, b) => a.workerLabel.localeCompare(b.workerLabel) || a.id.localeCompare(b.id))
  };
}

async function drainOne(record: DurableWorkerQueueRecord, leaseMs: number): Promise<DurableWorkerDrainItem> {
  try {
    const result = await replayDurableWorkerQueueRecord({
      id: record.id,
      leaseMs
    });
    return {
      id: record.id,
      queueItemId: record.queueItemId,
      workerId: record.workerId,
      workerLabel: record.workerLabel,
      status: result.status,
      recordStatus: result.record.status,
      summary: result.summary,
      artifactRef: result.artifactRef
    };
  } catch (error) {
    return {
      id: record.id,
      queueItemId: record.queueItemId,
      workerId: record.workerId,
      workerLabel: record.workerLabel,
      status: "blocked",
      recordStatus: record.status,
      summary: error instanceof Error ? error.message : "durable worker drain failed"
    };
  }
}

function queueSort(a: DurableWorkerQueueRecord, b: DurableWorkerQueueRecord) {
  return (
    a.priority - b.priority ||
    new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime() ||
    a.id.localeCompare(b.id)
  );
}

function clampInt(value: number, min: number, max: number) {
  const normalized = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(normalized, max));
}
