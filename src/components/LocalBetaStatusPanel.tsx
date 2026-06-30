"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  XCircle
} from "lucide-react";

type LocalHealthStatus = "pass" | "warn" | "block";

type LocalHealthCheck = {
  id: string;
  label: string;
  status: LocalHealthStatus;
  summary: string;
  details?: string[];
};

type LocalHealthPayload = {
  summary: {
    status: LocalHealthStatus;
    total: number;
    passed: number;
    warnings: number;
    blockers: number;
  };
  checks: LocalHealthCheck[];
};

const actionOrder = [
  "dependencies",
  "env-file",
  "report-model-key",
  "search-key",
  "docker-daemon",
  "docker-image",
  "worker-daemon",
  "durable-queue"
];

export function LocalBetaStatusPanel() {
  const [health, setHealth] = useState<LocalHealthPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadHealth();
  }, []);

  const visibleChecks = useMemo(() => {
    const checks = health?.checks || [];
    const actionable = checks
      .filter((check) => check.status !== "pass")
      .sort((a, b) => orderIndex(a.id) - orderIndex(b.id));
    return actionable.length ? actionable.slice(0, 4) : checks.slice(0, 4);
  }, [health]);

  const title = health
    ? health.summary.status === "pass"
      ? "本地环境就绪"
      : health.summary.status === "warn"
        ? "本地环境可运行，有提醒"
        : "本地环境需要处理"
    : loading
      ? "正在检查本地环境"
      : "本地检查不可用";

  return (
    <section className={`local-beta-panel ${health?.summary.status || "loading"}`}>
      <div className="local-beta-header">
        <div className="local-beta-title">
          <StatusIcon status={health?.summary.status} loading={loading} />
          <div>
            <span>Local Beta</span>
            <strong>{title}</strong>
          </div>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={loadHealth}
          disabled={loading}
          title="重新检查"
          aria-label="重新检查"
        >
          <RefreshCw className={loading ? "spin" : ""} size={17} />
        </button>
      </div>

      {health ? (
        <>
          <div className="local-beta-metrics" aria-label="本地环境摘要">
            <span>
              <CheckCircle2 size={15} />
              {health.summary.passed} 通过
            </span>
            <span>
              <AlertTriangle size={15} />
              {health.summary.warnings} 提醒
            </span>
            <span>
              <XCircle size={15} />
              {health.summary.blockers} 阻塞
            </span>
          </div>
          <div className="local-beta-checks">
            {visibleChecks.map((check) => (
              <div className="local-beta-check" key={check.id}>
                <StatusIcon status={check.status} />
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.summary}</p>
                  {check.details?.[0] ? <small>{check.details[0]}</small> : null}
                </div>
              </div>
            ))}
          </div>
          <div className="local-beta-actions">
            <CommandPill icon={<Terminal size={15} />} label="pnpm local" />
            <CommandPill icon={<ShieldCheck size={15} />} label="pnpm doctor" />
            <CommandPill icon={<Server size={15} />} label="worker ready" />
          </div>
        </>
      ) : (
        <p className="local-beta-empty">
          {error || "正在读取 doctor、worker 和 durable queue 状态。"}
        </p>
      )}
    </section>
  );

  async function loadHealth() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/local-health", { cache: "no-store" });
      const payload = (await response.json()) as LocalHealthPayload;
      setHealth(payload);
    } catch (loadError) {
      setHealth(null);
      setError(loadError instanceof Error ? loadError.message : "本地检查失败");
    } finally {
      setLoading(false);
    }
  }
}

function StatusIcon({
  status,
  loading
}: {
  status?: LocalHealthStatus;
  loading?: boolean;
}) {
  if (loading || !status) return <CircleDashed className="spin-soft" size={18} />;
  if (status === "pass") return <CheckCircle2 size={18} />;
  if (status === "warn") return <AlertTriangle size={18} />;
  return <XCircle size={18} />;
}

function CommandPill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span>
      {icon}
      {label}
    </span>
  );
}

function orderIndex(id: string) {
  const index = actionOrder.indexOf(id);
  return index === -1 ? actionOrder.length : index;
}
