import { NextResponse } from "next/server";
import { readWorkerAlertEvents } from "@/lib/worker-alerts";
import { readWorkerDaemonStatus } from "@/lib/worker-daemon-status";
import {
  defaultWorkerDaemonId,
  startManagedWorkerDaemon,
  stopManagedWorkerDaemon
} from "@/lib/worker-daemon-supervisor";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("alertsOnly") === "1") {
    const limit = Number(url.searchParams.get("limit") || 20);
    const events = await readWorkerAlertEvents({ limit });
    return NextResponse.json({ events });
  }
  const limit = Number(url.searchParams.get("limit") || 8);
  const runLimit = Number(url.searchParams.get("runLimit") || 3);
  const staleMs = Number(url.searchParams.get("staleMs") || 45_000);
  const queueLimit = Number(url.searchParams.get("queueLimit") || 500);
  const snapshot = await readWorkerDaemonStatus({
    limit,
    runLimit,
    staleMs,
    queueLimit
  });
  return NextResponse.json(snapshot);
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as {
    action?: string;
    daemonId?: string;
    intervalMs?: number;
    limit?: number;
    scanLimit?: number;
    concurrency?: number;
    leaseMs?: number;
    expiredMode?: "requeue" | "fail";
    restartBackoffMs?: number;
    maxRestarts?: number;
  };
  const daemonId = payload.daemonId?.trim() || defaultWorkerDaemonId();
  if (payload.action === "start") {
    const result = await startManagedWorkerDaemon({
      daemonId,
      intervalMs: Number(payload.intervalMs || 5_000),
      limit: Number(payload.limit || 10),
      scanLimit: Number(payload.scanLimit || 200),
      concurrency: Number(payload.concurrency || 2),
      leaseMs: Number(payload.leaseMs || 10 * 60 * 1000),
      expiredMode: payload.expiredMode === "fail" ? "fail" : "requeue",
      restartBackoffMs: Number(payload.restartBackoffMs || 1_500),
      maxRestarts: Number(payload.maxRestarts || 50)
    });
    return NextResponse.json({ result });
  }
  if (payload.action === "stop") {
    const result = await stopManagedWorkerDaemon({ daemonId });
    return NextResponse.json({ result });
  }
  return NextResponse.json({ error: `Unsupported action: ${payload.action}` }, { status: 400 });
}
