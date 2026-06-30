import { NextResponse } from "next/server";
import { runRuntimeResume } from "@/lib/agent-runtime-resume";
import { getAnalysis, saveAnalysis } from "@/lib/storage";
import type { AgentRuntimeResumeAction } from "@/lib/types";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

const allowedActions = new Set<AgentRuntimeResumeAction>([
  "queue_retry",
  "mark_reviewed",
  "skip_until_configured"
]);

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const record = await getAnalysis(id);
  if (!record) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }

  return NextResponse.json({
    requests: record.webResearch?.runtimeTrace?.resumeRequests ?? [],
    resumePlan: record.webResearch?.runtimeTrace?.resumePlan ?? null,
    taskGraph: record.webResearch?.runtimeTrace?.taskGraph ?? null
  });
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const record = await getAnalysis(id);
  if (!record) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }

  let payload: {
    targetId?: string;
    action?: AgentRuntimeResumeAction;
    note?: string;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const targetId = payload.targetId?.trim();
  const action = payload.action ?? "queue_retry";
  if (!targetId) {
    return NextResponse.json({ error: "targetId is required" }, { status: 400 });
  }
  if (!allowedActions.has(action)) {
    return NextResponse.json({ error: `Unsupported resume action: ${action}` }, { status: 400 });
  }

  try {
    const result = await runRuntimeResume(record, {
      targetId,
      action,
      note: payload.note?.trim()
    });
    await saveAnalysis(result.record);
    return NextResponse.json({
      request: result.request,
      requests: result.record.webResearch?.runtimeTrace?.resumeRequests ?? []
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runtime resume failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
