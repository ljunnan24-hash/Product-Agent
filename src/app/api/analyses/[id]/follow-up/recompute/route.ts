import { NextResponse } from "next/server";
import { recomputeEvidenceFromFollowUpsWithRuntime } from "@/lib/followup-recompute";
import { buildReportEvidenceBindings } from "@/lib/report-evidence-binding";
import { attachReportQualityToTrace, evaluateReportQuality } from "@/lib/report-quality";
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

  if (!record.evidenceBrief) {
    return NextResponse.json({ error: "Evidence Brief not found" }, { status: 400 });
  }

  try {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const turnId = String(raw.turnId || "").trim() || undefined;
    const recomputedAt = new Date().toISOString();
    const result = await recomputeEvidenceFromFollowUpsWithRuntime({
      record,
      turnId,
      recomputedAt
    });
    const reportEvidenceBindings = record.report
      ? buildReportEvidenceBindings({
          report: record.report,
          evidenceBrief: result.evidenceBrief
        })
      : record.reportEvidenceBindings;
    const reportQualityAudit = record.report
        ? evaluateReportQuality({
          report: record.report,
          evidenceBrief: result.evidenceBrief,
          webResearch: record.webResearch,
          materials: result.materialsForAudit,
          calibrationContext: record.calibrationContext,
          reportEvidenceBindings
        })
      : record.reportQualityAudit;
    const agentTrace = reportQualityAudit
      ? attachReportQualityToTrace(
          [...(record.agentTrace ?? []), result.traceStep].slice(-80),
          reportQualityAudit
        )
      : [...(record.agentTrace ?? []), result.traceStep].slice(-80);
    const updatedRecord = {
      ...record,
      updatedAt: recomputedAt,
      evidenceBrief: result.evidenceBrief,
      reportQualityAudit,
      reportEvidenceBindings,
      agentTrace,
      followUps: result.followUps,
      webResearch:
        record.webResearch && result.runtimeTrace
          ? {
              ...record.webResearch,
              runtimeTrace: result.runtimeTrace
            }
          : record.webResearch
    };

    await saveAnalysis(updatedRecord);

    return NextResponse.json({
      id: updatedRecord.id,
      status: updatedRecord.status,
      evidenceBrief: updatedRecord.evidenceBrief,
      reportQualityAudit: updatedRecord.reportQualityAudit,
      followUps: updatedRecord.followUps,
      confidenceBefore: result.confidenceBefore,
      confidenceAfter: result.confidenceAfter,
      decisionBefore: result.decisionBefore,
      decisionAfter: result.decisionAfter,
      appliedTurnIds: result.appliedTurnIds
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "重算证据失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
