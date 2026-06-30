import { spawn } from "child_process";
import { createWriteStream, promises as fs } from "fs";
import path from "path";
import {
  readWorkerDaemonStatus,
  readWorkerDaemonSupervisorState,
  type WorkerDaemonStatusItem
} from "./worker-daemon-status";

const daemonRoot = path.join(process.cwd(), ".taste-data", "worker-daemon");
const supervisorRoot = path.join(daemonRoot, "supervisor");
const defaultManagedDaemonId = "taste-agent-managed-worker";

export type WorkerDaemonSupervisorResult = {
  action: "start" | "stop";
  daemonId: string;
  status: "started" | "already_running" | "stop_requested" | "already_stopped" | "not_found" | "failed";
  pid?: number;
  supervisorPid?: number;
  workerPid?: number;
  summary: string;
  daemon?: WorkerDaemonStatusItem;
};

export async function startManagedWorkerDaemon({
  daemonId = defaultManagedDaemonId,
  intervalMs = 5_000,
  limit = 10,
  scanLimit = 200,
  concurrency = 2,
  leaseMs = 10 * 60 * 1000,
  expiredMode = "requeue",
  restartBackoffMs = 1_500,
  maxRestarts = 50
}: {
  daemonId?: string;
  intervalMs?: number;
  limit?: number;
  scanLimit?: number;
  concurrency?: number;
  leaseMs?: number;
  expiredMode?: "requeue" | "fail";
  restartBackoffMs?: number;
  maxRestarts?: number;
} = {}): Promise<WorkerDaemonSupervisorResult> {
  const existing = await findDaemonStatus(daemonId);
  if (existing && isManagedDaemonLive(existing)) {
    return {
      action: "start",
      daemonId,
      status: "already_running",
      pid: existing.supervisor?.supervisorPid ?? existing.heartbeat.pid,
      supervisorPid: existing.supervisor?.supervisorPid,
      workerPid: existing.heartbeat.pid,
      summary: `Worker daemon ${daemonId} is already supervised and ${existing.heartbeat.status}.`,
      daemon: existing
    };
  }

  await fs.mkdir(supervisorRoot, { recursive: true });
  const stdoutPath = path.join(supervisorRoot, `${safeFileSegment(daemonId)}.stdout.log`);
  const stderrPath = path.join(supervisorRoot, `${safeFileSegment(daemonId)}.stderr.log`);
  const stdout = createWriteStream(stdoutPath, { flags: "a" });
  const stderr = createWriteStream(stderrPath, { flags: "a" });
  stdout.write(`\n[${new Date().toISOString()}] supervisor start ${daemonId}\n`);
  stderr.write(`\n[${new Date().toISOString()}] supervisor start ${daemonId}\n`);

  const child = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "scripts", "local-worker-supervisor.mjs"),
      "--daemon-id",
      daemonId,
      "--interval-ms",
      String(clamp(intervalMs, 1_000, 60_000)),
      "--limit",
      String(clamp(limit, 1, 100)),
      "--scan-limit",
      String(clamp(scanLimit, 1, 1_000)),
      "--concurrency",
      String(clamp(concurrency, 1, 8)),
      "--lease-ms",
      String(clamp(leaseMs, 5_000, 60 * 60 * 1000)),
      "--expired-mode",
      expiredMode === "fail" ? "fail" : "requeue",
      "--restart-backoff-ms",
      String(clamp(restartBackoffMs, 200, 30_000)),
      "--max-restarts",
      String(clamp(maxRestarts, 0, 1_000))
    ],
    {
      cwd: process.cwd(),
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  child.unref();

  await writeSupervisorEvent(daemonId, {
    action: "start",
    supervisorPid: child.pid,
    intervalMs,
    limit,
    scanLimit,
    concurrency,
    leaseMs,
    expiredMode,
    restartBackoffMs,
    maxRestarts
  });
  return {
    action: "start",
    daemonId,
    status: "started",
    pid: child.pid,
    supervisorPid: child.pid,
    summary: `Worker daemon supervisor ${daemonId} start requested.`
  };
}

export async function stopManagedWorkerDaemon({
  daemonId = defaultManagedDaemonId,
  signal = "SIGTERM"
}: {
  daemonId?: string;
  signal?: NodeJS.Signals;
} = {}): Promise<WorkerDaemonSupervisorResult> {
  const existing = await findDaemonStatus(daemonId);
  if (!existing) {
    return {
      action: "stop",
      daemonId,
      status: "not_found",
      summary: `Worker daemon ${daemonId} has no heartbeat.`
    };
  }
  const supervisorState = existing.supervisor ?? (await readWorkerDaemonSupervisorState(daemonId));
  const supervisorPid = supervisorState?.supervisorPid;
  const workerPid = supervisorState?.workerPid ?? existing.heartbeat.pid;
  if ((!supervisorPid || !isProcessRunning(supervisorPid)) && (!workerPid || !isProcessRunning(workerPid))) {
    return {
      action: "stop",
      daemonId,
      status: "already_stopped",
      pid: supervisorPid ?? workerPid,
      supervisorPid,
      workerPid,
      summary: `Worker daemon ${daemonId} is not running.`,
      daemon: existing
    };
  }
  try {
    await writeSupervisorControl(daemonId, {
      stopRequested: true,
      reason: "api_stop",
      signal,
      at: new Date().toISOString()
    });
    if (supervisorPid && isProcessRunning(supervisorPid)) {
      process.kill(supervisorPid, signal);
    } else if (workerPid && isProcessRunning(workerPid)) {
      process.kill(workerPid, signal);
    }
    await writeSupervisorEvent(daemonId, {
      action: "stop",
      supervisorPid,
      workerPid,
      signal
    });
    return {
      action: "stop",
      daemonId,
      status: "stop_requested",
      pid: supervisorPid ?? workerPid,
      supervisorPid,
      workerPid,
      summary: `Worker daemon supervisor ${daemonId} stop requested with ${signal}.`,
      daemon: existing
    };
  } catch (error) {
    return {
      action: "stop",
      daemonId,
      status: "failed",
      pid: supervisorPid ?? workerPid,
      supervisorPid,
      workerPid,
      summary: error instanceof Error ? error.message : "Failed to stop worker daemon.",
      daemon: existing
    };
  }
}

export function defaultWorkerDaemonId() {
  return defaultManagedDaemonId;
}

async function findDaemonStatus(daemonId: string) {
  const snapshot = await readWorkerDaemonStatus({ limit: 30, runLimit: 2 });
  return snapshot.daemons.find((item) => item.heartbeat.daemonId === daemonId);
}

function isDaemonLive(item: WorkerDaemonStatusItem) {
  const status = item.heartbeat.status;
  if (item.stale) return false;
  if (status !== "starting" && status !== "running" && status !== "idle") return false;
  const pid = item.heartbeat.pid;
  return Boolean(pid && isProcessRunning(pid));
}

function isManagedDaemonLive(item: WorkerDaemonStatusItem) {
  if (isDaemonLive(item)) return true;
  const supervisorPid = item.supervisor?.supervisorPid;
  return Boolean(
    supervisorPid &&
      isProcessRunning(supervisorPid) &&
      item.supervisor?.status !== "stopped" &&
      item.supervisor?.status !== "failed"
  );
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeSupervisorEvent(daemonId: string, value: Record<string, unknown>) {
  await fs.mkdir(supervisorRoot, { recursive: true });
  await fs.appendFile(
    path.join(supervisorRoot, `${safeFileSegment(daemonId)}.jsonl`),
    `${JSON.stringify({ daemonId, at: new Date().toISOString(), ...value })}\n`,
    "utf8"
  );
}

async function writeSupervisorControl(daemonId: string, value: Record<string, unknown>) {
  await fs.mkdir(supervisorRoot, { recursive: true });
  await fs.writeFile(
    path.join(supervisorRoot, `${safeFileSegment(daemonId)}.control.json`),
    JSON.stringify({ daemonId, ...value }, null, 2),
    "utf8"
  );
}

function safeFileSegment(value: string) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "daemon";
}

function clamp(value: number, min: number, max: number) {
  const normalized = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(normalized, max));
}
