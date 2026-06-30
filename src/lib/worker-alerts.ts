import { promises as fs } from "fs";
import path from "path";
import type {
  WorkerDaemonHealthSnapshot,
  WorkerDaemonQueueSlaAlert,
  WorkerDaemonQueueSlaSnapshot
} from "./worker-daemon-status";

const alertRoot = path.join(process.cwd(), ".taste-data", "worker-alerts");
const statePath = path.join(alertRoot, "state.json");
const eventLogPath = path.join(alertRoot, "events.jsonl");
const defaultCooldownMs = 15 * 60 * 1000;

export type WorkerAlertSeverity = "info" | "warning" | "critical";
export type WorkerAlertSource = "health" | "queue_sla";
export type WorkerAlertEventType = "emitted" | "suppressed" | "resolved";

export type WorkerAlertCandidate = {
  id: string;
  source: WorkerAlertSource;
  severity: WorkerAlertSeverity;
  title: string;
  summary: string;
  recordIds?: string[];
};

export type WorkerAlertEvent = WorkerAlertCandidate & {
  eventType: WorkerAlertEventType;
  fingerprint: string;
  at: string;
  firstSeenAt: string;
  suppressedCount: number;
  webhook?: WorkerAlertWebhookDelivery;
};

export type WorkerAlertWebhookDelivery = {
  enabled: boolean;
  ok?: boolean;
  status?: number;
  error?: string;
  deliveredAt?: string;
};

export type WorkerAlertChannelSnapshot = {
  enabled: boolean;
  webhookEnabled: boolean;
  webhookUrlConfigured: boolean;
  cooldownMs: number;
  generatedAt: string;
  logPath: string;
  statePath: string;
  activeCount: number;
  emittedCount: number;
  suppressedCount: number;
  resolvedCount: number;
  lastEmittedAt?: string;
  lastWebhookAt?: string;
  lastWebhookError?: string;
  recentEvents: WorkerAlertEvent[];
};

type WorkerAlertState = {
  version: "worker-alerts-v1";
  updatedAt: string;
  entries: Record<string, WorkerAlertStateEntry>;
};

type WorkerAlertStateEntry = WorkerAlertCandidate & {
  fingerprint: string;
  active: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  lastEmittedAt?: string;
  resolvedAt?: string;
  emittedCount: number;
  suppressedCount: number;
  totalSeenCount: number;
  lastWebhookAt?: string;
  lastWebhookError?: string;
};

export async function evaluateWorkerAlerts({
  health,
  queueSla,
  now = new Date()
}: {
  health: WorkerDaemonHealthSnapshot;
  queueSla: WorkerDaemonQueueSlaSnapshot;
  now?: Date;
}): Promise<WorkerAlertChannelSnapshot> {
  const config = workerAlertConfig();
  await fs.mkdir(alertRoot, { recursive: true });
  const nowIso = now.toISOString();
  const state = await readAlertState(nowIso);
  const candidates = config.enabled ? buildAlertCandidates({ health, queueSla }) : [];
  const candidateFingerprints = new Set(candidates.map((candidate) => alertFingerprint(candidate)));
  const events: WorkerAlertEvent[] = [];

  for (const candidate of candidates) {
    const fingerprint = alertFingerprint(candidate);
    const current = state.entries[fingerprint];
    const firstSeenAt = current?.firstSeenAt ?? nowIso;
    const canEmit =
      !current?.lastEmittedAt ||
      now.getTime() - new Date(current.lastEmittedAt).getTime() >= config.cooldownMs;
    const suppressedCount = canEmit ? current?.suppressedCount ?? 0 : (current?.suppressedCount ?? 0) + 1;
    const entry: WorkerAlertStateEntry = {
      ...candidate,
      fingerprint,
      active: true,
      firstSeenAt,
      lastSeenAt: nowIso,
      lastEmittedAt: canEmit ? nowIso : current?.lastEmittedAt,
      resolvedAt: undefined,
      emittedCount: (current?.emittedCount ?? 0) + (canEmit ? 1 : 0),
      suppressedCount,
      totalSeenCount: (current?.totalSeenCount ?? 0) + 1,
      lastWebhookAt: current?.lastWebhookAt,
      lastWebhookError: current?.lastWebhookError
    };
    if (canEmit) {
      const event = await buildAlertEvent({
        candidate,
        eventType: "emitted",
        fingerprint,
        firstSeenAt,
        suppressedCount: current?.suppressedCount ?? 0,
        webhookUrl: config.webhookUrl,
        webhookTimeoutMs: config.webhookTimeoutMs
      });
      entry.lastWebhookAt = event.webhook?.ok ? event.webhook.deliveredAt : current?.lastWebhookAt;
      entry.lastWebhookError = event.webhook?.ok ? undefined : event.webhook?.error ?? current?.lastWebhookError;
      events.push(event);
    }
    state.entries[fingerprint] = entry;
  }

  for (const entry of Object.values(state.entries)) {
    if (!entry.active || candidateFingerprints.has(entry.fingerprint)) continue;
    const resolvedEntry: WorkerAlertStateEntry = {
      ...entry,
      active: false,
      lastSeenAt: nowIso,
      resolvedAt: nowIso
    };
    const event = await buildAlertEvent({
      candidate: resolvedEntry,
      eventType: "resolved",
      fingerprint: entry.fingerprint,
      firstSeenAt: entry.firstSeenAt,
      suppressedCount: entry.suppressedCount,
      webhookUrl: config.webhookUrl,
      webhookTimeoutMs: config.webhookTimeoutMs
    });
    resolvedEntry.lastWebhookAt = event.webhook?.ok ? event.webhook.deliveredAt : entry.lastWebhookAt;
    resolvedEntry.lastWebhookError = event.webhook?.ok ? undefined : event.webhook?.error ?? entry.lastWebhookError;
    state.entries[entry.fingerprint] = resolvedEntry;
    events.push(event);
  }

  if (events.length) {
    await appendAlertEvents(events);
  }
  state.updatedAt = nowIso;
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const recentEvents = await readWorkerAlertEvents({ limit: 8 });
  const entries = Object.values(state.entries);
  return {
    enabled: config.enabled,
    webhookEnabled: Boolean(config.webhookUrl),
    webhookUrlConfigured: Boolean(config.webhookUrl),
    cooldownMs: config.cooldownMs,
    generatedAt: nowIso,
    logPath: path.relative(process.cwd(), eventLogPath),
    statePath: path.relative(process.cwd(), statePath),
    activeCount: entries.filter((entry) => entry.active).length,
    emittedCount: entries.reduce((sum, entry) => sum + entry.emittedCount, 0),
    suppressedCount: entries.reduce((sum, entry) => sum + entry.suppressedCount, 0),
    resolvedCount: entries.filter((entry) => Boolean(entry.resolvedAt)).length,
    lastEmittedAt: maxIso(entries.map((entry) => entry.lastEmittedAt)),
    lastWebhookAt: maxIso(entries.map((entry) => entry.lastWebhookAt)),
    lastWebhookError: entries.find((entry) => entry.lastWebhookError)?.lastWebhookError,
    recentEvents
  };
}

export async function readWorkerAlertEvents({ limit = 20 }: { limit?: number } = {}) {
  const raw = await fs.readFile(eventLogPath, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split(/\r?\n/)
    .slice(-clamp(limit, 0, 100))
    .map((line) => {
      try {
        return JSON.parse(line) as WorkerAlertEvent;
      } catch {
        return null;
      }
    })
    .filter((item): item is WorkerAlertEvent => Boolean(item))
    .reverse();
}

function buildAlertCandidates({
  health,
  queueSla
}: {
  health: WorkerDaemonHealthSnapshot;
  queueSla: WorkerDaemonQueueSlaSnapshot;
}) {
  const candidates: WorkerAlertCandidate[] = [];
  if (health.status === "down" || health.status === "degraded") {
    candidates.push({
      id: `health-${health.status}`,
      source: "health",
      severity: health.status === "down" ? "critical" : "warning",
      title: health.status === "down" ? "Worker daemon 离线" : "Worker daemon 降级",
      summary: health.messages.slice(0, 3).join("；") || `health status is ${health.status}.`
    });
  }
  for (const alert of queueSla.alerts.filter((item) => item.severity !== "info")) {
    candidates.push({
      id: alert.id,
      source: "queue_sla",
      severity: alert.severity,
      title: alert.title,
      summary: alert.summary,
      recordIds: alert.recordIds
    });
  }
  return candidates;
}

async function buildAlertEvent({
  candidate,
  eventType,
  fingerprint,
  firstSeenAt,
  suppressedCount,
  webhookUrl,
  webhookTimeoutMs
}: {
  candidate: WorkerAlertCandidate;
  eventType: WorkerAlertEventType;
  fingerprint: string;
  firstSeenAt: string;
  suppressedCount: number;
  webhookUrl?: string;
  webhookTimeoutMs: number;
}): Promise<WorkerAlertEvent> {
  const event: WorkerAlertEvent = {
    ...candidate,
    eventType,
    fingerprint,
    at: new Date().toISOString(),
    firstSeenAt,
    suppressedCount
  };
  event.webhook = webhookUrl
    ? await postAlertWebhook(webhookUrl, event, webhookTimeoutMs)
    : { enabled: false };
  return event;
}

async function postAlertWebhook(
  webhookUrl: string,
  event: WorkerAlertEvent,
  timeoutMs: number
): Promise<WorkerAlertWebhookDelivery> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        service: "taste-agent-worker-alerts",
        event
      }),
      signal: controller.signal
    });
    return {
      enabled: true,
      ok: response.ok,
      status: response.status,
      error: response.ok ? undefined : `webhook returned ${response.status}`,
      deliveredAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      error: error instanceof Error ? error.message : "webhook delivery failed",
      deliveredAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function appendAlertEvents(events: WorkerAlertEvent[]) {
  await fs.appendFile(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

async function readAlertState(nowIso: string): Promise<WorkerAlertState> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as WorkerAlertState;
    if (parsed.version === "worker-alerts-v1" && parsed.entries && typeof parsed.entries === "object") {
      return parsed;
    }
  } catch {
    // Fresh local installs will not have alert state yet.
  }
  return {
    version: "worker-alerts-v1",
    updatedAt: nowIso,
    entries: {}
  };
}

function workerAlertConfig() {
  const enabledRaw = (process.env.TASTE_WORKER_ALERTS_ENABLED ?? "1").trim().toLowerCase();
  return {
    enabled: enabledRaw !== "0" && enabledRaw !== "false" && enabledRaw !== "off",
    webhookUrl: process.env.TASTE_WORKER_ALERT_WEBHOOK_URL?.trim() || undefined,
    cooldownMs: clampNumber(
      Number(process.env.TASTE_WORKER_ALERT_COOLDOWN_MS || defaultCooldownMs),
      10_000,
      24 * 60 * 60 * 1000,
      defaultCooldownMs
    ),
    webhookTimeoutMs: clampNumber(
      Number(process.env.TASTE_WORKER_ALERT_WEBHOOK_TIMEOUT_MS || 5_000),
      500,
      30_000,
      5_000
    )
  };
}

function alertFingerprint(candidate: WorkerAlertCandidate) {
  const recordPart = candidate.recordIds?.length ? `:${candidate.recordIds.slice().sort().join(",")}` : "";
  return `${candidate.source}:${candidate.id}:${candidate.severity}${recordPart}`;
}

function maxIso(values: Array<string | undefined>) {
  const sorted = values
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  return sorted[0];
}

function clamp(value: number, min: number, max: number) {
  const normalized = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(normalized, max));
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  const normalized = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(normalized, max));
}
