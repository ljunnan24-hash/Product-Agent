import { NextResponse } from "next/server";
import {
  cancelDurableWorkerQueueRecord,
  getDurableWorkerQueueRecord,
  listDurableWorkerQueueRecords,
  maintainDurableWorkerQueue,
  readDurableWorkerInputPayload,
  requeueDurableWorkerQueueRecord
} from "@/lib/durable-worker-queue";
import { drainDurableWorkerQueue } from "@/lib/durable-worker-drain";
import { replayDurableWorkerQueueRecord } from "@/lib/durable-worker-replay";
import type { AgentWorkerQueueItemStatus } from "@/lib/types";

const queueStatuses: AgentWorkerQueueItemStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled"
];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || undefined;
  const includeInput = url.searchParams.get("includeInput") === "true";
  if (id) {
    const record = await getDurableWorkerQueueRecord(id);
    if (!record) {
      return NextResponse.json({ error: "Worker queue record not found" }, { status: 404 });
    }
    const inputPayload = includeInput ? await readDurableWorkerInputPayload(record) : undefined;
    return NextResponse.json({
      record,
      inputPayload
    });
  }

  const traceId = url.searchParams.get("traceId") || undefined;
  const statusParam = url.searchParams.get("status") || undefined;
  const status = queueStatuses.includes(statusParam as AgentWorkerQueueItemStatus)
    ? (statusParam as AgentWorkerQueueItemStatus)
    : undefined;
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 80), 200));
  const records = await listDurableWorkerQueueRecords({
    traceId,
    status,
    limit
  });
  return NextResponse.json({
    records,
    count: records.length
  });
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as {
    id?: string;
    action?: string;
    reason?: string;
    expiredMode?: "requeue" | "fail";
    limit?: number;
    scanLimit?: number;
    concurrency?: number;
    leaseMs?: number;
    traceId?: string;
  };
  if (payload.action === "maintain") {
    const result = await maintainDurableWorkerQueue({
      expiredMode: payload.expiredMode === "fail" ? "fail" : "requeue",
      limit: Math.max(1, Math.min(Number(payload.limit || 500), 1000))
    });
    return NextResponse.json({ result });
  }
  if (payload.action === "drain") {
    const result = await drainDurableWorkerQueue({
      traceId: payload.traceId?.trim() || undefined,
      expiredMode: payload.expiredMode === "fail" ? "fail" : "requeue",
      limit: Math.max(1, Math.min(Number(payload.limit || 10), 100)),
      scanLimit: Math.max(1, Math.min(Number(payload.scanLimit || 200), 1000)),
      concurrency: Math.max(1, Math.min(Number(payload.concurrency || 2), 8)),
      leaseMs: Number(payload.leaseMs || 10 * 60 * 1000)
    });
    return NextResponse.json({ result });
  }

  const id = payload.id?.trim();
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (payload.action !== "cancel" && payload.action !== "requeue" && payload.action !== "replay") {
    return NextResponse.json({ error: `Unsupported action: ${payload.action}` }, { status: 400 });
  }

  const current = await getDurableWorkerQueueRecord(id);
  if (!current) {
    return NextResponse.json({ error: "Worker queue record not found" }, { status: 404 });
  }

  if (payload.action === "replay") {
    const result = await replayDurableWorkerQueueRecord({
      id,
      leaseMs: Number(payload.leaseMs || 10 * 60 * 1000)
    });
    return NextResponse.json({ result });
  }

  const record =
    payload.action === "cancel"
      ? await cancelDurableWorkerQueueRecord(
          id,
          payload.reason?.trim() || "用户请求取消该 worker。"
        )
      : await requeueDurableWorkerQueueRecord(
          id,
          payload.reason?.trim() || "用户请求重新入队该 worker。"
        );
  return NextResponse.json({ record });
}
