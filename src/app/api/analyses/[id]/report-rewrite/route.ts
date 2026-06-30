import { NextResponse } from "next/server";
import { buildReportEvidenceBindings } from "@/lib/report-evidence-binding";
import { attachReportQualityToTrace, evaluateReportQuality } from "@/lib/report-quality";
import {
  applyReportRepairDraft,
  hasAppliedRepairDraft,
  rollbackReportRevision
} from "@/lib/report-rewrite";
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

  if (!record.report) {
    return NextResponse.json({ error: "Report not found" }, { status: 400 });
  }

  try {
    const raw = (await request.json()) as Record<string, unknown>;
    const action = String(raw.action || "apply").trim();

    if (action === "rollback") {
      return rollbackRevision(record, raw);
    }

    const issueId = String(raw.issueId || "").trim();
    if (!issueId) {
      throw new Error("缺少 issueId。");
    }

    const audit = evaluateReportQuality({
      report: record.report,
      evidenceBrief: record.evidenceBrief,
      webResearch: record.webResearch,
      materials: record.materials ?? [],
      calibrationContext: record.calibrationContext,
      reportEvidenceBindings: record.reportEvidenceBindings
    });
    const issue = audit.issues.find((item) => item.id === issueId);
    if (!issue) {
      return NextResponse.json(
        { error: "该质检问题已经不存在或不再需要修复。" },
        { status: 404 }
      );
    }

    if (!issue.repairDraft) {
      return NextResponse.json(
        { error: "该质检问题没有可应用的修复草案。" },
        { status: 400 }
      );
    }

    if (hasAppliedRepairDraft(record.reportRevisions, issue)) {
      return NextResponse.json({
        id: record.id,
        status: record.status,
        alreadyApplied: true,
        report: record.report,
        reportQualityAudit: audit,
        reportRevisions: record.reportRevisions ?? []
      });
    }

    const createdAt = new Date().toISOString();
    const { report, revision } = applyReportRepairDraft({
      report: record.report,
      issue,
      revisionId: crypto.randomUUID(),
      createdAt
    });
    const reportEvidenceBindings = buildReportEvidenceBindings({
      report,
      evidenceBrief: record.evidenceBrief
    });
    const reportQualityAudit = evaluateReportQuality({
      report,
      evidenceBrief: record.evidenceBrief,
      webResearch: record.webResearch,
      materials: record.materials ?? [],
      calibrationContext: record.calibrationContext,
      reportEvidenceBindings
    });
    const agentTrace = attachReportQualityToTrace(record.agentTrace ?? [], reportQualityAudit);
    const updatedRecord = {
      ...record,
      updatedAt: createdAt,
      report,
      reportQualityAudit,
      reportEvidenceBindings,
      agentTrace,
      reportRevisions: [revision, ...(record.reportRevisions ?? [])].slice(0, 20)
    };

    await saveAnalysis(updatedRecord);

    return NextResponse.json({
      id: updatedRecord.id,
      status: updatedRecord.status,
      report: updatedRecord.report,
      reportQualityAudit: updatedRecord.reportQualityAudit,
      reportRevisions: updatedRecord.reportRevisions,
      revision
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "报告修订失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

async function rollbackRevision(
  record: NonNullable<Awaited<ReturnType<typeof getAnalysis>>>,
  raw: Record<string, unknown>
) {
  const revisionId = String(raw.revisionId || "").trim();
  if (!revisionId) {
    throw new Error("缺少 revisionId。");
  }

  const revisions = record.reportRevisions ?? [];
  const revisionIndex = revisions.findIndex((item) => item.id === revisionId);
  if (revisionIndex < 0) {
    return NextResponse.json({ error: "找不到这次报告修订。" }, { status: 404 });
  }

  const revision = revisions[revisionIndex];
  if (revision.rolledBackAt) {
    return NextResponse.json({
      id: record.id,
      status: record.status,
      alreadyRolledBack: true,
      report: record.report,
      reportQualityAudit: record.reportQualityAudit,
      reportRevisions: revisions,
      revision
    });
  }

  const newerSameSection = revisions
    .slice(0, revisionIndex)
    .find(
      (item) =>
        item.targetSection === revision.targetSection &&
        !item.rolledBackAt
    );
  if (newerSameSection) {
    return NextResponse.json(
      {
        error: `请先回滚同一段落里更新的修订：「${newerSameSection.draftTitle}」。`
      },
      { status: 409 }
    );
  }

  if (!record.report) {
    return NextResponse.json({ error: "Report not found" }, { status: 400 });
  }

  const rolledBackAt = new Date().toISOString();
  const rolledBack = rollbackReportRevision({
    report: record.report,
    revision,
    rolledBackAt
  });
  const reportEvidenceBindings = buildReportEvidenceBindings({
    report: rolledBack.report,
    evidenceBrief: record.evidenceBrief
  });
  const reportQualityAudit = evaluateReportQuality({
    report: rolledBack.report,
    evidenceBrief: record.evidenceBrief,
    webResearch: record.webResearch,
    materials: record.materials ?? [],
    calibrationContext: record.calibrationContext,
    reportEvidenceBindings
  });
  const agentTrace = attachReportQualityToTrace(record.agentTrace ?? [], reportQualityAudit);
  const updatedRevisions = revisions.map((item) =>
    item.id === revisionId ? rolledBack.revision : item
  );
  const updatedRecord = {
    ...record,
    updatedAt: rolledBackAt,
    report: rolledBack.report,
    reportQualityAudit,
    reportEvidenceBindings,
    agentTrace,
    reportRevisions: updatedRevisions
  };

  await saveAnalysis(updatedRecord);

  return NextResponse.json({
    id: updatedRecord.id,
    status: updatedRecord.status,
    report: updatedRecord.report,
    reportQualityAudit: updatedRecord.reportQualityAudit,
    reportRevisions: updatedRecord.reportRevisions,
    revision: rolledBack.revision
  });
}
