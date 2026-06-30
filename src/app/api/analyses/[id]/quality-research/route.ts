import { NextResponse } from "next/server";
import { runQualityIssueResearch } from "@/lib/quality-driven-research";
import { getAnalysis, saveAnalysis } from "@/lib/storage";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const record = await getAnalysis(id);

  if (!record) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }

  try {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const issueId = String(raw.issueId || "").trim();
    if (!issueId) {
      throw new Error("缺少 issueId。");
    }

    const result = await runQualityIssueResearch({
      record,
      issueId,
      researchedAt: new Date().toISOString()
    });

    await saveAnalysis(result.record);

    return NextResponse.json({
      id: result.record.id,
      status: result.record.status,
      issueId,
      issueTitle: result.issue.title,
      evidenceBrief: result.record.evidenceBrief,
      webResearch: result.record.webResearch,
      reportQualityAudit: result.record.reportQualityAudit,
      agentTrace: result.record.agentTrace,
      confidenceBefore: result.confidenceBefore,
      confidenceAfter: result.confidenceAfter,
      decisionBefore: result.decisionBefore,
      decisionAfter: result.decisionAfter,
      queryCount: result.queryCount,
      resultCount: result.resultCount,
      summary: result.summary
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "质检补证失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
