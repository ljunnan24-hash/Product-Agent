import {
  generateFollowUpReportDraft,
  type ReportDraftProgressEvent
} from "@/lib/report-regeneration";
import { getAnalysis, saveAnalysis } from "@/lib/storage";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };
      const sendProgress = (event: ReportDraftProgressEvent) => {
        send({
          type: "progress",
          ...event,
          at: new Date().toISOString()
        });
      };

      try {
        const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const turnId = String(raw.turnId || "").trim() || undefined;
        const record = await getAnalysis(id);

        if (!record) {
          send({
            type: "error",
            message: "Analysis not found",
            status: 404,
            at: new Date().toISOString()
          });
          return;
        }

        sendProgress({
          stage: "prepare",
          status: "running",
          title: "启动草案生成",
          summary: "正在读取当前报告、继续对话和证据账本。"
        });

        const createdAt = new Date().toISOString();
        const result = await generateFollowUpReportDraft({
          record,
          draftId: crypto.randomUUID(),
          createdAt,
          turnId,
          onProgress: sendProgress
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

        sendProgress({
          stage: "save",
          status: "running",
          title: "保存草案",
          summary: "正在保存新版报告草案和可见工具调用。"
        });

        await saveAnalysis(updatedRecord);

        sendProgress({
          stage: "save",
          status: "completed",
          title: "草案已保存",
          summary: `草案已保存，差异 ${result.draft.diff.length} 行。`
        });

        send({
          type: "complete",
          id: updatedRecord.id,
          status: updatedRecord.status,
          draftId: result.draft.id,
          summary: result.draft.summary,
          confidenceBefore: result.draft.confidenceBefore,
          confidenceAfter: result.draft.confidenceAfter,
          decisionBefore: result.draft.decisionBefore,
          decisionAfter: result.draft.decisionAfter,
          diffLines: result.draft.diff.length,
          qualityScore: result.draft.reportQualityAudit?.score ?? null,
          at: new Date().toISOString()
        });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "生成新版报告草案失败",
          status: 400,
          at: new Date().toISOString()
        });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}
