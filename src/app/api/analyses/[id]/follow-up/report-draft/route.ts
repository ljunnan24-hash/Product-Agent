import { NextResponse } from "next/server";
import {
  applyReportRegenerationDraft,
  generateFollowUpReportDraft
} from "@/lib/report-regeneration";
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
    const action = String(raw.action || "generate");

    if (action === "apply") {
      const draftId = String(raw.draftId || "").trim();
      if (!draftId) throw new Error("缺少 draftId。");
      const appliedAt = new Date().toISOString();
      const result = await applyReportRegenerationDraft({
        record,
        draftId,
        appliedAt
      });
      const updatedRecord = {
        ...result.record,
        agentTrace: [...(result.record.agentTrace ?? []), result.traceStep].slice(-80)
      };
      await saveAnalysis(updatedRecord);

      return NextResponse.json({
        id: updatedRecord.id,
        status: updatedRecord.status,
        report: updatedRecord.report,
        evidenceBrief: updatedRecord.evidenceBrief,
        webResearch: updatedRecord.webResearch,
        reportQualityAudit: updatedRecord.reportQualityAudit,
        reportRegenerationDrafts: updatedRecord.reportRegenerationDrafts,
        draft: result.draft
      });
    }

    const createdAt = new Date().toISOString();
    const turnId = String(raw.turnId || "").trim() || undefined;
    const result = await generateFollowUpReportDraft({
      record,
      draftId: crypto.randomUUID(),
      createdAt,
      turnId
    });
    const updatedRecord = {
      ...record,
      updatedAt: createdAt,
      reportRegenerationDrafts: [
        result.draft,
        ...(record.reportRegenerationDrafts ?? [])
      ].slice(0, 10),
      agentTrace: [...(record.agentTrace ?? []), result.traceStep].slice(-80)
    };

    await saveAnalysis(updatedRecord);

    return NextResponse.json({
      id: updatedRecord.id,
      status: updatedRecord.status,
      reportRegenerationDrafts: updatedRecord.reportRegenerationDrafts,
      draft: result.draft
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "新版报告草案处理失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
