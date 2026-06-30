import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { listDurableWorkerQueueRecords } from "./durable-worker-queue";
import { evaluateWorkerAlerts, type WorkerAlertChannelSnapshot } from "./worker-alerts";
import { workerDaemonSupportedTools, type WorkerDaemonSupportedTool } from "./worker-daemon-capabilities";
import type { AgentWorkerQueueItemStatus, DurableWorkerQueueRecord } from "./types";

const daemonRoot = path.join(process.cwd(), ".taste-data", "worker-daemon");
const daemonRunRoot = path.join(daemonRoot, "runs");
const supervisorRoot = path.join(daemonRoot, "supervisor");
const launchdRoot = path.join(daemonRoot, "launchd");
const defaultManagedDaemonId = "taste-agent-managed-worker";
const execFileAsync = promisify(execFile);

export type WorkerDaemonHeartbeatStatus =
  | "starting"
  | "running"
  | "idle"
  | "stopped"
  | "failed"
  | string;

export type WorkerDaemonHeartbeat = {
  daemonId: string;
  version?: string;
  mode?: string;
  status: WorkerDaemonHeartbeatStatus;
  pid?: number;
  updatedAt: string;
  projectRoot?: string;
  runtimeRoot?: string;
  cycle?: number;
  lastResult?: {
    selected?: number;
    scannedQueued?: number;
    counts?: {
      applied?: number;
      blocked?: number;
      unsupported?: number;
      skipped?: number;
      errors?: number;
    };
    maintenance?: {
      scanned?: number;
      requeued?: number;
      cancelled?: number;
      failedExpired?: number;
      stillRunning?: number;
      recoveredRecords?: Array<{
        id: string;
        status: string;
        workerLabel?: string;
        attempt?: number;
        maxAttempts?: number;
        reason?: string;
      }>;
    };
  };
  error?: string;
};

export type WorkerDaemonRunLogEntry = {
  daemonId: string;
  at: string;
  cycle?: number;
  result?: unknown;
};

export type WorkerDaemonSupervisorState = {
  daemonId: string;
  version?: string;
  status: "starting" | "running" | "restarting" | "stopping" | "stopped" | "failed" | string;
  supervisorPid?: number;
  workerPid?: number;
  updatedAt: string;
  restarts?: number;
  maxRestarts?: number;
  restartBackoffMs?: number;
  nextRestartAt?: string;
  stopReason?: string;
  error?: string;
  lastExit?: {
    code?: number | null;
    signal?: string | null;
    at?: string;
  };
};

export type WorkerDaemonStatusItem = {
  heartbeat: WorkerDaemonHeartbeat;
  stale: boolean;
  ageMs: number;
  latestRuns: WorkerDaemonRunLogEntry[];
  supervisor?: WorkerDaemonSupervisorState;
};

export type WorkerDaemonLaunchdStatus = {
  platform: NodeJS.Platform;
  available: boolean;
  label: string;
  daemonId: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  domain?: string;
  pid?: number;
  state?: string;
  lastExitCode?: string;
  stdoutPath: string;
  stderrPath: string;
  summary: string;
};

export type WorkerDaemonHealthStatus = "healthy" | "degraded" | "down" | "unknown";

export type WorkerDaemonHealthSnapshot = {
  status: WorkerDaemonHealthStatus;
  liveDaemonCount: number;
  staleDaemonCount: number;
  supervisedDaemonCount: number;
  lastHeartbeatAgeMs?: number;
  recentRestarts: number;
  recentFailures: number;
  launchdInstalled: boolean;
  launchdLoaded: boolean;
  messages: string[];
};

export type WorkerDaemonQueueSlaAlert = {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  recordIds?: string[];
};

export type WorkerDaemonQueueSlaSnapshot = {
  scanned: number;
  generatedAt: string;
  thresholds: {
    queuedWarnMs: number;
    queuedCriticalMs: number;
    backlogWarnCount: number;
    backlogCriticalCount: number;
  };
  counts: Record<AgentWorkerQueueItemStatus, number>;
  activeCount: number;
  terminalCount: number;
  queuedCount: number;
  runningCount: number;
  failedCount: number;
  expiredRunningCount: number;
  cancelRequestedCount: number;
  oldestQueuedAgeMs?: number;
  oldestRunningAgeMs?: number;
  oldestQueuedRecord?: WorkerDaemonQueueRecordSummary;
  expiredRunningRecords: WorkerDaemonQueueRecordSummary[];
  failedRecords: WorkerDaemonQueueRecordSummary[];
  byTool: Array<{
    toolId: string;
    count: number;
    queued: number;
    running: number;
    failed: number;
  }>;
  alerts: WorkerDaemonQueueSlaAlert[];
};

export type WorkerDaemonQueueRecordSummary = {
  id: string;
  status: AgentWorkerQueueItemStatus;
  workerLabel: string;
  toolIds: string[];
  priority: number;
  attempt: number;
  maxAttempts: number;
  ageMs: number;
  leaseExpiresAt?: string;
  outputSummary?: string;
  errorMessage?: string;
};

export type WorkerDaemonStatusSnapshot = {
  generatedAt: string;
  staleMs: number;
  supportedTools: WorkerDaemonSupportedTool[];
  launchd: WorkerDaemonLaunchdStatus;
  health: WorkerDaemonHealthSnapshot;
  queueSla: WorkerDaemonQueueSlaSnapshot;
  alertChannel: WorkerAlertChannelSnapshot;
  daemons: WorkerDaemonStatusItem[];
};

export async function readWorkerDaemonStatus({
  limit = 8,
  runLimit = 3,
  staleMs = 45_000,
  queueLimit = 500
}: {
  limit?: number;
  runLimit?: number;
  staleMs?: number;
  queueLimit?: number;
} = {}): Promise<WorkerDaemonStatusSnapshot> {
  const now = Date.now();
  const heartbeats = await readHeartbeats();
  const daemons = await Promise.all(
    heartbeats
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, clamp(limit, 1, 30))
      .map(async (heartbeat) => {
        const updatedAt = new Date(heartbeat.updatedAt).getTime();
        const ageMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : staleMs + 1;
        const supervisor = await readSupervisorState(heartbeat.daemonId);
        return {
          heartbeat,
          stale: isPotentiallyLive(heartbeat.status) && ageMs > staleMs,
          ageMs,
          latestRuns: await readDaemonRunLog(heartbeat.daemonId, runLimit),
          supervisor
        };
      })
  );
  const launchd = await readWorkerDaemonLaunchdStatus();
  const queueSla = await readWorkerDaemonQueueSla({
    now,
    limit: queueLimit
  });
  const health = summarizeWorkerDaemonHealth({
    daemons,
    launchd,
    staleMs,
    queueSla
  });
  const alertChannel = await evaluateWorkerAlerts({
    health,
    queueSla,
    now: new Date(now)
  });
  return {
    generatedAt: new Date(now).toISOString(),
    staleMs,
    supportedTools: workerDaemonSupportedTools,
    launchd,
    health,
    queueSla,
    alertChannel,
    daemons
  };
}

export async function readWorkerDaemonSupervisorState(daemonId: string) {
  return readSupervisorState(daemonId);
}

export async function readWorkerDaemonLaunchdStatus({
  daemonId = defaultManagedDaemonId,
  label = `com.taste-agent.${safeFileSegment(defaultManagedDaemonId)}`
}: {
  daemonId?: string;
  label?: string;
} = {}): Promise<WorkerDaemonLaunchdStatus> {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const stdoutPath = path.join(launchdRoot, `${safeFileSegment(daemonId)}.stdout.log`);
  const stderrPath = path.join(launchdRoot, `${safeFileSegment(daemonId)}.stderr.log`);
  const installed = await fileExists(plistPath);
  if (process.platform !== "darwin") {
    return {
      platform: process.platform,
      available: false,
      label,
      daemonId,
      plistPath,
      installed,
      loaded: false,
      stdoutPath,
      stderrPath,
      summary: "launchd 只在 macOS 可用。"
    };
  }
  const domain = `gui/${process.getuid?.() ?? ""}`;
  const print = await launchctl(["print", `${domain}/${label}`]);
  const details = parseLaunchctlPrint(print.stdout || "");
  return {
    platform: process.platform,
    available: true,
    label,
    daemonId,
    plistPath,
    installed,
    loaded: print.ok,
    domain,
    stdoutPath,
    stderrPath,
    ...details,
    summary: print.ok
      ? `launchd 已加载 ${label}${details.pid ? `，pid ${details.pid}` : ""}。`
      : installed
        ? `launchd plist 已安装但未加载：${label}。`
        : `launchd plist 未安装：${label}。`
  };
}

async function readHeartbeats() {
  const fileNames = await fs.readdir(daemonRoot).catch(() => []);
  const heartbeats = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".heartbeat.json"))
      .map(async (fileName) => {
        try {
          const raw = await fs.readFile(path.join(daemonRoot, fileName), "utf8");
          return normalizeHeartbeat(JSON.parse(raw));
        } catch {
          return null;
        }
      })
  );
  return heartbeats.filter((item): item is WorkerDaemonHeartbeat => Boolean(item));
}

async function readDaemonRunLog(daemonId: string, limit: number) {
  const filePath = path.join(daemonRunRoot, `${safeFileSegment(daemonId)}.jsonl`);
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split(/\r?\n/)
    .slice(-clamp(limit, 0, 20))
    .map((line) => {
      try {
        return JSON.parse(line) as WorkerDaemonRunLogEntry;
      } catch {
        return null;
      }
    })
    .filter((item): item is WorkerDaemonRunLogEntry => Boolean(item))
    .reverse();
}

async function readSupervisorState(daemonId: string) {
  const filePath = path.join(supervisorRoot, `${safeFileSegment(daemonId)}.state.json`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeSupervisorState(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function normalizeHeartbeat(value: unknown): WorkerDaemonHeartbeat | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<WorkerDaemonHeartbeat>;
  const daemonId = String(record.daemonId || "").trim();
  const updatedAt = String(record.updatedAt || "").trim();
  const status = String(record.status || "").trim();
  if (!daemonId || !updatedAt || !status) return null;
  return {
    ...record,
    daemonId,
    updatedAt,
    status
  };
}

function normalizeSupervisorState(value: unknown): WorkerDaemonSupervisorState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<WorkerDaemonSupervisorState>;
  const daemonId = String(record.daemonId || "").trim();
  const updatedAt = String(record.updatedAt || "").trim();
  const status = String(record.status || "").trim();
  if (!daemonId || !updatedAt || !status) return undefined;
  return {
    ...record,
    daemonId,
    updatedAt,
    status
  };
}

function summarizeWorkerDaemonHealth({
  daemons,
  launchd,
  staleMs,
  queueSla
}: {
  daemons: WorkerDaemonStatusItem[];
  launchd: WorkerDaemonLaunchdStatus;
  staleMs: number;
  queueSla: WorkerDaemonQueueSlaSnapshot;
}): WorkerDaemonHealthSnapshot {
  const liveDaemons = daemons.filter((item) => !item.stale && isPotentiallyLive(item.heartbeat.status));
  const staleDaemons = daemons.filter((item) => item.stale);
  const supervisedDaemons = daemons.filter((item) => item.supervisor && item.supervisor.status !== "stopped");
  const recentRestarts = supervisedDaemons.reduce((sum, item) => sum + (item.supervisor?.restarts ?? 0), 0);
  const recentFailures = daemons.reduce(
    (sum, item) =>
      sum +
      (item.heartbeat.status === "failed" ? 1 : 0) +
      (item.supervisor?.status === "failed" ? 1 : 0) +
      (item.heartbeat.lastResult?.counts?.errors ?? 0) +
      (item.heartbeat.lastResult?.counts?.blocked ?? 0),
    0
  );
  const lastHeartbeatAgeMs = daemons[0]?.ageMs;
  const messages: string[] = [];
  if (!launchd.installed) {
    messages.push("launchd plist 未安装，机器重启后 daemon 不会自动恢复。");
  } else if (!launchd.loaded) {
    messages.push("launchd plist 已安装但未加载。");
  }
  if (!liveDaemons.length) {
    messages.push("当前没有 live worker daemon heartbeat。");
  }
  if (staleDaemons.length) {
    messages.push(`${staleDaemons.length} 个 daemon heartbeat 超过 ${Math.round(staleMs / 1000)}s 未更新。`);
  }
  if (recentRestarts > 0) {
    messages.push(`supervisor 已记录 ${recentRestarts} 次重启。`);
  }
  if (recentFailures > 0) {
    messages.push(`最近 worker drain 有 ${recentFailures} 个失败/阻断信号。`);
  }
  for (const alert of queueSla.alerts.filter((item) => item.severity !== "info").slice(0, 3)) {
    messages.push(`${alert.title}：${alert.summary}`);
  }

  const hasCriticalQueueAlert = queueSla.alerts.some((item) => item.severity === "critical");
  const hasWarningQueueAlert = queueSla.alerts.some((item) => item.severity === "warning");
  const status: WorkerDaemonHealthStatus = liveDaemons.length
    ? launchd.installed && launchd.loaded && recentFailures === 0 && !hasCriticalQueueAlert && !hasWarningQueueAlert
      ? "healthy"
      : "degraded"
    : launchd.loaded || hasCriticalQueueAlert
      ? "degraded"
      : daemons.length
        ? "down"
        : "unknown";

  if (!messages.length) {
    messages.push("daemon heartbeat、supervisor 和 launchd 状态正常。");
  }

  return {
    status,
    liveDaemonCount: liveDaemons.length,
    staleDaemonCount: staleDaemons.length,
    supervisedDaemonCount: supervisedDaemons.length,
    lastHeartbeatAgeMs,
    recentRestarts,
    recentFailures,
    launchdInstalled: launchd.installed,
    launchdLoaded: launchd.loaded,
    messages: messages.slice(0, 6)
  };
}

async function readWorkerDaemonQueueSla({
  now,
  limit
}: {
  now: number;
  limit: number;
}): Promise<WorkerDaemonQueueSlaSnapshot> {
  const records = await listDurableWorkerQueueRecords({
    limit: clamp(limit, 50, 2_000)
  });
  const counts: Record<AgentWorkerQueueItemStatus, number> = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0
  };
  for (const record of records) {
    counts[record.status] += 1;
  }
  const queued = records.filter((record) => record.status === "queued");
  const running = records.filter((record) => record.status === "running");
  const failed = records.filter((record) => record.status === "failed");
  const expiredRunning = running.filter((record) => isLeaseExpired(record, now));
  const cancelRequested = records.filter((record) => Boolean(record.cancelRequestedAt));
  const oldestQueued = minByAge(queued, now, (record) => record.enqueuedAt);
  const oldestRunning = minByAge(running, now, (record) => record.startedAt ?? record.enqueuedAt);
  const thresholds = {
    queuedWarnMs: 5 * 60 * 1000,
    queuedCriticalMs: 30 * 60 * 1000,
    backlogWarnCount: 20,
    backlogCriticalCount: 100
  };
  const byTool = summarizeQueueByTool(records);
  const alerts: WorkerDaemonQueueSlaAlert[] = [];
  const oldestQueuedAgeMs = oldestQueued ? ageMs(oldestQueued.enqueuedAt, now) : undefined;
  if (expiredRunning.length) {
    alerts.push({
      id: "expired-running-lease",
      severity: "critical",
      title: "Running lease 过期",
      summary: `${expiredRunning.length} 个 running worker 的 lease 已过期，需要 daemon maintenance requeue/fail。`,
      recordIds: expiredRunning.slice(0, 5).map((record) => record.id)
    });
  }
  if (oldestQueuedAgeMs !== undefined && oldestQueuedAgeMs >= thresholds.queuedCriticalMs) {
    alerts.push({
      id: "queued-age-critical",
      severity: "critical",
      title: "队列等待超时",
      summary: `最老 queued worker 已等待 ${formatMsForAlert(oldestQueuedAgeMs)}。`,
      recordIds: oldestQueued ? [oldestQueued.id] : undefined
    });
  } else if (oldestQueuedAgeMs !== undefined && oldestQueuedAgeMs >= thresholds.queuedWarnMs) {
    alerts.push({
      id: "queued-age-warning",
      severity: "warning",
      title: "队列等待偏久",
      summary: `最老 queued worker 已等待 ${formatMsForAlert(oldestQueuedAgeMs)}。`,
      recordIds: oldestQueued ? [oldestQueued.id] : undefined
    });
  }
  if (queued.length >= thresholds.backlogCriticalCount) {
    alerts.push({
      id: "queued-backlog-critical",
      severity: "critical",
      title: "队列积压严重",
      summary: `${queued.length} 个 worker 正在等待。`
    });
  } else if (queued.length >= thresholds.backlogWarnCount) {
    alerts.push({
      id: "queued-backlog-warning",
      severity: "warning",
      title: "队列开始积压",
      summary: `${queued.length} 个 worker 正在等待。`
    });
  }
  if (failed.length) {
    alerts.push({
      id: "failed-records",
      severity: "warning",
      title: "存在失败 worker",
      summary: `${failed.length} 个 durable worker 处于 failed。`,
      recordIds: failed.slice(0, 5).map((record) => record.id)
    });
  }
  if (!alerts.length) {
    alerts.push({
      id: "queue-sla-ok",
      severity: "info",
      title: "队列 SLA 正常",
      summary: "没有发现等待超时、过期 lease 或失败堆积。"
    });
  }

  return {
    scanned: records.length,
    generatedAt: new Date(now).toISOString(),
    thresholds,
    counts,
    activeCount: queued.length + running.length,
    terminalCount: counts.completed + counts.failed + counts.skipped + counts.cancelled,
    queuedCount: queued.length,
    runningCount: running.length,
    failedCount: failed.length,
    expiredRunningCount: expiredRunning.length,
    cancelRequestedCount: cancelRequested.length,
    oldestQueuedAgeMs,
    oldestRunningAgeMs: oldestRunning ? ageMs(oldestRunning.startedAt ?? oldestRunning.enqueuedAt, now) : undefined,
    oldestQueuedRecord: oldestQueued ? summarizeQueueRecord(oldestQueued, now) : undefined,
    expiredRunningRecords: expiredRunning.slice(0, 5).map((record) => summarizeQueueRecord(record, now)),
    failedRecords: failed.slice(0, 5).map((record) => summarizeQueueRecord(record, now)),
    byTool,
    alerts
  };
}

function summarizeQueueByTool(records: DurableWorkerQueueRecord[]) {
  const byTool = new Map<string, { toolId: string; count: number; queued: number; running: number; failed: number }>();
  for (const record of records) {
    for (const toolId of record.definition.allowedTools.length ? record.definition.allowedTools : ["unknown"]) {
      const current = byTool.get(toolId) ?? { toolId, count: 0, queued: 0, running: 0, failed: 0 };
      current.count += 1;
      if (record.status === "queued") current.queued += 1;
      if (record.status === "running") current.running += 1;
      if (record.status === "failed") current.failed += 1;
      byTool.set(toolId, current);
    }
  }
  return [...byTool.values()].sort((a, b) => b.count - a.count || a.toolId.localeCompare(b.toolId)).slice(0, 12);
}

function summarizeQueueRecord(record: DurableWorkerQueueRecord, now: number): WorkerDaemonQueueRecordSummary {
  return {
    id: record.id,
    status: record.status,
    workerLabel: record.workerLabel,
    toolIds: record.definition.allowedTools,
    priority: record.priority,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    ageMs: ageMs(record.startedAt ?? record.enqueuedAt, now),
    leaseExpiresAt: record.lease?.expiresAt,
    outputSummary: record.outputSummary,
    errorMessage: record.errorMessage
  };
}

function isLeaseExpired(record: DurableWorkerQueueRecord, now: number) {
  if (!record.lease?.expiresAt) return false;
  const expiresAt = new Date(record.lease.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function minByAge(
  records: DurableWorkerQueueRecord[],
  now: number,
  getDate: (record: DurableWorkerQueueRecord) => string | undefined
) {
  let result: DurableWorkerQueueRecord | undefined;
  let resultAge = -1;
  for (const record of records) {
    const currentAge = ageMs(getDate(record), now);
    if (currentAge > resultAge) {
      result = record;
      resultAge = currentAge;
    }
  }
  return result;
}

function ageMs(value: string | undefined, now: number) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : 0;
}

function formatMsForAlert(value: number) {
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  if (value < 60 * 60_000) return `${Math.round(value / 60_000)}m`;
  return `${Math.round(value / (60 * 60_000))}h`;
}

async function launchctl(values: string[]) {
  try {
    const result = await execFileAsync("launchctl", values, {
      encoding: "utf8",
      timeout: 5_000
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: execError.stdout || "",
      stderr: execError.stderr || execError.message || String(error)
    };
  }
}

function parseLaunchctlPrint(raw: string) {
  const pidMatch = raw.match(/\bpid = (\d+)/);
  const stateMatch = raw.match(/\bstate = ([^\n]+)/);
  const lastExitMatch = raw.match(/\blast exit code = ([^\n]+)/);
  return {
    pid: pidMatch ? Number(pidMatch[1]) : undefined,
    state: stateMatch?.[1]?.trim(),
    lastExitCode: lastExitMatch?.[1]?.trim()
  };
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isPotentiallyLive(status: string) {
  return status === "starting" || status === "running" || status === "idle";
}

function safeFileSegment(value: string) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "daemon";
}

function clamp(value: number, min: number, max: number) {
  const normalized = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(normalized, max));
}
