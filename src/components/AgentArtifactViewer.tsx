"use client";

import { useMemo, useState } from "react";
import type { AgentRuntimeArtifact } from "@/lib/types";

type Props = {
  artifacts: AgentRuntimeArtifact[];
  artifactIds?: string[];
  limit?: number;
  emptyText?: string;
};

type ArtifactPayloadResponse = {
  payload?: unknown;
  error?: string;
};

export function AgentArtifactViewer({
  artifacts,
  artifactIds,
  limit = 4,
  emptyText = "暂无 artifact。"
}: Props) {
  const orderedArtifacts = useMemo(() => {
    if (!artifactIds?.length) return artifacts.slice(0, limit);
    const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    return artifactIds
      .map((id) => byId.get(id))
      .filter((artifact): artifact is AgentRuntimeArtifact => Boolean(artifact))
      .slice(0, limit);
  }, [artifactIds, artifacts, limit]);
  const [selected, setSelected] = useState<{
    artifact: AgentRuntimeArtifact;
    payload: string;
    truncated: boolean;
  } | null>(null);
  const [loadingId, setLoadingId] = useState("");
  const [error, setError] = useState("");

  async function openArtifact(artifact: AgentRuntimeArtifact) {
    if (!artifact.storageRef) {
      setError("这个 artifact 没有可读取的存储引用。");
      return;
    }
    setError("");
    setLoadingId(artifact.id);
    try {
      const response = await fetch(
        `/api/agent-artifacts?ref=${encodeURIComponent(artifact.storageRef)}`
      );
      const payload = (await response.json()) as ArtifactPayloadResponse;
      if (!response.ok || payload.error) {
        throw new Error(payload.error || "Artifact 读取失败");
      }
      const rendered = JSON.stringify(payload.payload, null, 2);
      setSelected({
        artifact,
        payload: rendered.slice(0, 24000),
        truncated: rendered.length > 24000
      });
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Artifact 读取失败");
    } finally {
      setLoadingId("");
    }
  }

  if (!orderedArtifacts.length) {
    return <p className="artifact-empty">{emptyText}</p>;
  }

  return (
    <div className="artifact-viewer">
      <div className="artifact-chip-row">
        {orderedArtifacts.map((artifact) => (
          <button
            type="button"
            key={artifact.id}
            disabled={!artifact.storageRef || loadingId === artifact.id}
            onClick={() => openArtifact(artifact)}
          >
            {artifactKindLabel(artifact.kind)}
            {artifact.itemCount !== undefined ? ` ${artifact.itemCount}` : ""}
          </button>
        ))}
      </div>
      {error ? <p className="artifact-error">{error}</p> : null}
      {selected ? (
        <details className="artifact-panel" open>
          <summary>
            {artifactKindLabel(selected.artifact.kind)} · {selected.artifact.title}
          </summary>
          <p>{selected.artifact.summary}</p>
          <pre>{selected.payload}</pre>
          {selected.truncated ? <small>已截断显示前 24000 字符。</small> : null}
        </details>
      ) : null}
    </div>
  );
}

export function artifactKindLabel(kind: AgentRuntimeArtifact["kind"]) {
  if (kind === "handoff_packet") return "交接包";
  if (kind === "worker_context") return "边界";
  if (kind === "worker_transcript") return "执行";
  if (kind === "query_plan") return "查询";
  if (kind === "search_results") return "搜索";
  if (kind === "webpage_snapshot") return "网页";
  if (kind === "evidence_cards") return "证据";
  if (kind === "model_report") return "报告";
  if (kind === "source_budget") return "预算";
  if (kind === "failure_report") return "失败";
  return "摘要";
}
