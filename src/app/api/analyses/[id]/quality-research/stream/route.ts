import {
  runQualityIssueResearch,
  type QualityResearchProgressEvent
} from "@/lib/quality-driven-research";
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
      const sendProgress = (event: QualityResearchProgressEvent) => {
        send({
          type: "progress",
          ...event,
          at: new Date().toISOString()
        });
      };

      try {
        const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const issueId = String(raw.issueId || "").trim();
        if (!issueId) {
          send({
            type: "error",
            message: "缺少 issueId。",
            status: 400,
            at: new Date().toISOString()
          });
          return;
        }

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

        const result = await runQualityIssueResearch({
          record,
          issueId,
          researchedAt: new Date().toISOString(),
          onProgress: sendProgress
        });

        sendProgress({
          stage: "save",
          status: "running",
          title: "保存补证结果",
          summary: "正在保存新的网页调研、Evidence Brief、报告质检和可见工具调用。"
        });
        await saveAnalysis(result.record);
        sendProgress({
          stage: "save",
          status: "completed",
          title: "补证结果已保存",
          summary: `新增候选结果 ${result.resultCount} 条，证据置信 ${result.confidenceBefore} -> ${result.confidenceAfter}。`
        });

        send({
          type: "complete",
          id: result.record.id,
          status: result.record.status,
          issueId,
          issueTitle: result.issue.title,
          confidenceBefore: result.confidenceBefore,
          confidenceAfter: result.confidenceAfter,
          decisionBefore: result.decisionBefore,
          decisionAfter: result.decisionAfter,
          queryCount: result.queryCount,
          resultCount: result.resultCount,
          qualityScore: result.record.reportQualityAudit?.score ?? null,
          summary: result.summary,
          at: new Date().toISOString()
        });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "质检补证失败",
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
