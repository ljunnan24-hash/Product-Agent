import type {
  ExperimentEvidenceArtifact,
  ValidationExperimentResult
} from "./types";

export function codeExecutionResultToExperimentArtifact({
  id,
  stdout,
  summary,
  status,
  capturedAt = new Date().toISOString(),
  experimentStatus
}: {
  id: string;
  stdout: string;
  summary: string;
  status: "completed" | "failed" | "blocked" | "cancelled";
  capturedAt?: string;
  experimentStatus?: ValidationExperimentResult["status"];
}): ExperimentEvidenceArtifact | null {
  const excerpt = stdout.trim();
  if (status !== "completed" || !excerpt) return null;
  return {
    id,
    kind: "metric_snapshot",
    title: "代码执行数据摘要",
    excerpt: shorten(excerpt, 520),
    parsedSignal: `代码执行摘要：${shorten(summary, 180)}。该结果只验证上传实验原件中的计算，不代表外部市场事实。`,
    direction: inferCodeEvidenceDirection(excerpt, experimentStatus),
    objectiveLevel: "observed_fact",
    capturedAt,
    extractionMethod: "code"
  };
}

export function mergeCodeExecutionArtifactIntoExperimentResult(
  result: ValidationExperimentResult,
  artifact: ExperimentEvidenceArtifact
): ValidationExperimentResult {
  const existing = result.rawEvidenceArtifacts ?? [];
  return {
    ...result,
    rawEvidenceArtifacts: [
      ...existing.filter((item) => item.extractionMethod !== "code"),
      artifact
    ]
  };
}

function inferCodeEvidenceDirection(
  text: string,
  experimentStatus?: ValidationExperimentResult["status"]
): ExperimentEvidenceArtifact["direction"] {
  if (
    /(?:点击|访问|转化|留资|预约|回复|评论|用户|signups?|leads?|conversions?|paid|revenue)\s*["']?\s*[:=]\s*(?:0|0\.0|null)\b/i.test(text) ||
    /\b(?:0|0\.0)\s*(?:clicks?|views?|signups?|leads?|users?|conversions?)\b/i.test(text)
  ) {
    return "oppose";
  }
  if (/失败|无需求|不需要|不愿|太贵|低频|没有转化|无人|invalidated|no demand|too expensive/i.test(text)) {
    return "oppose";
  }
  if (/付费|购买|留资|预约|点击|转化|愿意|主动|回复|报名|signup|paid|demo|validated|conversion|leads?|revenue/i.test(text)) {
    return "support";
  }
  if (experimentStatus === "validated") return "support";
  if (experimentStatus === "invalidated") return "oppose";
  return "neutral";
}

function shorten(text: string, maxChars: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}...`;
}
