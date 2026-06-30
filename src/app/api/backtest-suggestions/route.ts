import { NextResponse } from "next/server";
import { ensureBacktestSuggestionCandidates } from "@/lib/backtest-suggestion-candidates";
import { evaluateReportQuality } from "@/lib/report-quality";
import {
  getAnalysis,
  listBacktestSuggestions,
  saveBacktestSuggestion,
  updateBacktestSuggestion
} from "@/lib/storage";
import type { BacktestSuggestion, ReportQualityIssue } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const suggestions = await ensureBacktestSuggestionCandidates(
    await listBacktestSuggestions(),
    { updateSuggestion: updateBacktestSuggestion }
  );
  return NextResponse.json({ suggestions });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as {
      analysisId?: string;
      issueId?: string;
    };
    const analysisId = String(payload.analysisId || "").trim();
    const issueId = String(payload.issueId || "").trim();

    if (!analysisId || !issueId) {
      return NextResponse.json(
        { error: "缺少 analysisId 或 issueId。" },
        { status: 400 }
      );
    }

    const record = await getAnalysis(analysisId);
    if (!record?.report) {
      return NextResponse.json(
        { error: "Analysis not found" },
        { status: 404 }
      );
    }

    const audit = evaluateReportQuality({
      report: record.report,
      evidenceBrief: record.evidenceBrief,
      webResearch: record.webResearch,
      materials: record.materials ?? [],
      calibrationContext: record.calibrationContext
    });
    const issue = audit.issues.find((item) => item.id === issueId);
    if (!issue) {
      return NextResponse.json(
        { error: "该质检问题已经不存在或不需要 README 回测。" },
        { status: 400 }
      );
    }

    const backtestSuggestions = issue.repairDraft?.researchPlan?.backtestSuggestions ?? [];
    if (!backtestSuggestions.length) {
      return NextResponse.json(
        { error: "该质检问题没有 README 回测建议。" },
        { status: 400 }
      );
    }

    const existing = await listBacktestSuggestions(200);
    const existingByKey = new Map(
      existing.map((item) => [suggestionKey(item.analysisId, item.issueId, item.suggestion), item])
    );
    const createdAt = new Date().toISOString();
    const suggestions: BacktestSuggestion[] = [];

    for (const suggestionText of uniqueStrings(backtestSuggestions)) {
      const key = suggestionKey(analysisId, issueId, suggestionText);
      const current = existingByKey.get(key);

      if (current) {
        if (current.status === "dismissed") {
          const revived = await updateBacktestSuggestion(current.id, {
            status: "open",
            dismissedAt: undefined
          });
          suggestions.push(revived ?? current);
        } else {
          suggestions.push(current);
        }
        continue;
      }

      const suggestion = buildSuggestion({
        analysisId,
        issue,
        suggestionText,
        createdAt
      });
      const [suggestionWithCandidates] = await ensureBacktestSuggestionCandidates(
        [suggestion],
        { force: true }
      );
      await saveBacktestSuggestion(suggestionWithCandidates);
      suggestions.push(suggestionWithCandidates);
    }

    return NextResponse.json({ suggestions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成 README 回测建议失败" },
      { status: 500 }
    );
  }
}

function buildSuggestion({
  analysisId,
  issue,
  suggestionText,
  createdAt
}: {
  analysisId: string;
  issue: ReportQualityIssue;
  suggestionText: string;
  createdAt: string;
}): BacktestSuggestion {
  return {
    id: crypto.randomUUID(),
    createdAt,
    updatedAt: createdAt,
    status: "open",
    source: "report_quality",
    analysisId,
    issueId: issue.id,
    issueTitle: issue.title,
    title: issue.repairDraft?.researchPlan?.title || "README 回测建议",
    suggestion: suggestionText,
    targetSignal: targetSignalFromIssue(issue)
  };
}

function targetSignalFromIssue(issue: ReportQualityIssue) {
  const title = issue.repairDraft?.researchPlan?.title || issue.title;
  return title.replace(/^校准补查[:：]\s*/, "").trim();
}

function uniqueStrings(items: string[]) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function suggestionKey(analysisId: string, issueId: string, suggestion: string) {
  return `${analysisId}:${issueId}:${normalizeSuggestion(suggestion)}`;
}

function normalizeSuggestion(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
