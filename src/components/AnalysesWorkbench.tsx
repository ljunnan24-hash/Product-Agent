"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  FileText,
  Filter,
  RotateCcw,
  Search,
  ShieldCheck
} from "lucide-react";
import type { AnalysisSummary } from "@/lib/analysis-summary";

type Props = {
  analyses: AnalysisSummary[];
};

type DecisionFilter = "all" | "test_first" | "build" | "reposition" | "stop" | "none";
type QualityFilter = "all" | "pass" | "warn" | "fail" | "none";
type EvidenceFilter = "all" | "needs_evidence" | "budget_ok" | "has_web" | "no_web";
type RevisionFilter = "all" | "revised" | "unrevised";
type ExperimentFilter = "all" | "with_result" | "without_result";
type SortKey = "updated" | "potential" | "confidence" | "quality" | "budget";

export function AnalysesWorkbench({ analyses }: Props) {
  const [query, setQuery] = useState("");
  const [decision, setDecision] = useState<DecisionFilter>("all");
  const [quality, setQuality] = useState<QualityFilter>("all");
  const [evidence, setEvidence] = useState<EvidenceFilter>("all");
  const [revision, setRevision] = useState<RevisionFilter>("all");
  const [experiment, setExperiment] = useState<ExperimentFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("updated");

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return analyses
      .filter((item) => {
        if (!matchesQuery(item, normalizedQuery)) return false;
        if (decision !== "all" && (decision === "none" ? item.decision : item.decision !== decision)) {
          return false;
        }
        if (
          quality !== "all" &&
          (quality === "none" ? item.reportQualityStatus : item.reportQualityStatus !== quality)
        ) {
          return false;
        }
        if (evidence === "needs_evidence" && item.unmetBudgetCount === 0) return false;
        if (evidence === "budget_ok" && item.unmetBudgetCount > 0) return false;
        if (evidence === "has_web" && item.webEvidenceCount === 0) return false;
        if (evidence === "no_web" && item.webEvidenceCount > 0) return false;
        if (revision === "revised" && !item.hasRevisions) return false;
        if (revision === "unrevised" && item.hasRevisions) return false;
        if (experiment === "with_result" && !item.hasExperimentResult) return false;
        if (experiment === "without_result" && item.hasExperimentResult) return false;
        return true;
      })
      .sort((a, b) => sortAnalyses(a, b, sortKey));
  }, [analyses, decision, evidence, experiment, quality, query, revision, sortKey]);

  const stats = useMemo(() => buildStats(analyses), [analyses]);
  const activeFilters = [decision, quality, evidence, revision, experiment].filter(
    (item) => item !== "all"
  ).length + (query.trim() ? 1 : 0);

  function resetFilters() {
    setQuery("");
    setDecision("all");
    setQuality("all");
    setEvidence("all");
    setRevision("all");
    setExperiment("all");
    setSortKey("updated");
  }

  return (
    <>
      <section className="history-head">
        <div>
          <p>报告库</p>
          <h1>多产品验证工作台。</h1>
        </div>
        <span>{filtered.length}/{analyses.length} 份分析</span>
      </section>

      <section className="history-stats" aria-label="历史分析概览">
        <Stat icon={<Archive size={18} />} label="已完成" value={stats.completed} />
        <Stat icon={<Search size={18} />} label="需补证" value={stats.needsEvidence} />
        <Stat icon={<ShieldCheck size={18} />} label="质检未过" value={stats.failedQuality} />
        <Stat icon={<FileText size={18} />} label="已修订" value={stats.revised} />
      </section>

      <section className="history-controls" aria-label="报告筛选">
        <div className="history-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索产品、诊断、缺口或实验"
          />
        </div>
        <div className="history-filter-row">
          <SelectFilter label="决策" value={decision} onChange={setDecision} options={decisionOptions} />
          <SelectFilter label="质检" value={quality} onChange={setQuality} options={qualityOptions} />
          <SelectFilter label="证据" value={evidence} onChange={setEvidence} options={evidenceOptions} />
          <SelectFilter label="修订" value={revision} onChange={setRevision} options={revisionOptions} />
          <SelectFilter label="实验" value={experiment} onChange={setExperiment} options={experimentOptions} />
          <SelectFilter label="排序" value={sortKey} onChange={setSortKey} options={sortOptions} />
        </div>
        <div className="history-filter-foot">
          <span>
            <Filter size={13} />
            {activeFilters ? `${activeFilters} 个筛选生效` : "显示全部报告"}
          </span>
          <button type="button" onClick={resetFilters}>
            <RotateCcw size={13} />
            重置
          </button>
        </div>
      </section>

      {filtered.length ? (
        <section className="history-table" aria-label="历史报告列表">
          <div className="history-table-head">
            <span>产品</span>
            <span>判断</span>
            <span>证据</span>
            <span>下一步</span>
            <span>状态</span>
          </div>
          {filtered.map((item) => (
            <AnalysisRow key={item.id} item={item} />
          ))}
        </section>
      ) : (
        <section className="history-empty">
          <AlertTriangle size={20} />
          <h2>没有匹配的报告</h2>
          <p>换一个筛选条件，或者新建一份产品诊断。</p>
          <button type="button" onClick={resetFilters}>
            重置筛选
          </button>
        </section>
      )}
    </>
  );
}

function AnalysisRow({ item }: { item: AnalysisSummary }) {
  return (
    <Link className={`history-row ${item.reportQualityStatus ?? "warn"}`} href={`/analysis/${item.id}`}>
      <div className="history-product-cell">
        <div>
          <strong>{item.productName}</strong>
          <span>{formatDate(item.updatedAt)} · {workTypeLabel(item.workType)}</span>
        </div>
        <p>{item.oneLineDiagnosis}</p>
      </div>
      <div className="history-decision-cell">
        <strong>{decisionLabel(item.decision)}</strong>
        <span>{lifecycleLabel(item.lifecycleStage)}</span>
      </div>
      <div className="history-score-cell">
        <MiniMetric label="潜力" value={item.potentialScore} />
        <MiniMetric label="证据" value={item.evidenceConfidence} />
        <MiniMetric label="预算" value={item.sourceBudgetScore} />
      </div>
      <div className="history-next-cell">
        <strong>{item.topEvidenceGap || item.topIssueTitle || "暂无阻断缺口"}</strong>
        <span>{item.nextExperimentTitle || "未生成实验"}</span>
      </div>
      <div className="history-status-cell">
        <span className={`status-pill ${item.reportQualityStatus ?? "warn"}`}>
          {qualityLabel(item.reportQualityStatus)}
        </span>
        <span>{item.unmetBudgetCount ? `${item.unmetBudgetCount} 项缺口` : "预算达标"}</span>
        <span>{item.hasExperimentResult ? "已回填实验" : "未回填实验"}</span>
        <span>{item.hasRevisions ? `修订 ${item.revisionCount}` : "未修订"}</span>
      </div>
    </Link>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{typeof value === "number" ? value : "--"}</strong>
    </div>
  );
}

function SelectFilter<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: Array<{ label: string; value: T }>;
  onChange: (value: T) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const decisionOptions: Array<{ label: string; value: DecisionFilter }> = [
  { label: "全部", value: "all" },
  { label: "先验证", value: "test_first" },
  { label: "继续构建", value: "build" },
  { label: "重定位", value: "reposition" },
  { label: "停止", value: "stop" },
  { label: "无决策", value: "none" }
];

const qualityOptions: Array<{ label: string; value: QualityFilter }> = [
  { label: "全部", value: "all" },
  { label: "通过", value: "pass" },
  { label: "提醒", value: "warn" },
  { label: "未过", value: "fail" },
  { label: "无质检", value: "none" }
];

const evidenceOptions: Array<{ label: string; value: EvidenceFilter }> = [
  { label: "全部", value: "all" },
  { label: "需补证", value: "needs_evidence" },
  { label: "预算达标", value: "budget_ok" },
  { label: "有网页证据", value: "has_web" },
  { label: "无网页证据", value: "no_web" }
];

const revisionOptions: Array<{ label: string; value: RevisionFilter }> = [
  { label: "全部", value: "all" },
  { label: "已修订", value: "revised" },
  { label: "未修订", value: "unrevised" }
];

const experimentOptions: Array<{ label: string; value: ExperimentFilter }> = [
  { label: "全部", value: "all" },
  { label: "已回填", value: "with_result" },
  { label: "未回填", value: "without_result" }
];

const sortOptions: Array<{ label: string; value: SortKey }> = [
  { label: "最近更新", value: "updated" },
  { label: "潜力最高", value: "potential" },
  { label: "证据最高", value: "confidence" },
  { label: "质检最高", value: "quality" },
  { label: "预算最高", value: "budget" }
];

function buildStats(items: AnalysisSummary[]) {
  return {
    completed: items.filter((item) => item.status === "completed").length,
    needsEvidence: items.filter((item) => item.unmetBudgetCount > 0).length,
    failedQuality: items.filter((item) => item.reportQualityStatus === "fail").length,
    revised: items.filter((item) => item.hasRevisions).length
  };
}

function matchesQuery(item: AnalysisSummary, query: string) {
  if (!query) return true;
  return [
    item.productName,
    item.oneLineDiagnosis,
    item.topEvidenceGap,
    item.topIssueTitle,
    item.nextExperimentTitle,
    item.model,
    item.searchProvider
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function sortAnalyses(a: AnalysisSummary, b: AnalysisSummary, sortKey: SortKey) {
  if (sortKey === "potential") return nullableScore(b.potentialScore) - nullableScore(a.potentialScore);
  if (sortKey === "confidence") {
    return nullableScore(b.evidenceConfidence) - nullableScore(a.evidenceConfidence);
  }
  if (sortKey === "quality") {
    return nullableScore(b.reportQualityScore) - nullableScore(a.reportQualityScore);
  }
  if (sortKey === "budget") {
    return nullableScore(b.sourceBudgetScore) - nullableScore(a.sourceBudgetScore);
  }
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function nullableScore(value: number | null) {
  return typeof value === "number" ? value : -1;
}

function decisionLabel(decision: AnalysisSummary["decision"]) {
  if (decision === "build") return "继续构建";
  if (decision === "test_first") return "先验证";
  if (decision === "reposition") return "重定位";
  if (decision === "stop") return "停止";
  return "无决策";
}

function qualityLabel(status: AnalysisSummary["reportQualityStatus"]) {
  if (status === "pass") return "质检通过";
  if (status === "fail") return "质检未过";
  if (status === "warn") return "质检提醒";
  return "无质检";
}

function lifecycleLabel(stage: AnalysisSummary["lifecycleStage"]) {
  if (stage === "idea") return "想法期";
  if (stage === "prototype") return "原型期";
  if (stage === "mvp") return "MVP";
  if (stage === "launch") return "发布期";
  if (stage === "early_traction") return "早期牵引";
  if (stage === "growth") return "增长期";
  if (stage === "mature") return "成熟期";
  if (stage === "decline") return "衰退期";
  return "阶段未知";
}

function workTypeLabel(workType: AnalysisSummary["workType"]) {
  return workType.replaceAll("_", " ");
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return value;
  }
}
