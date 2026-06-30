import { NextResponse } from "next/server";
import { handleRuntimeInterrupt } from "@/lib/agent-runtime-interrupt";
import { getAnalysis, saveAnalysis } from "@/lib/storage";
import type { AgentRunInterruptAction } from "@/lib/types";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

const allowedActions = new Set<AgentRunInterruptAction>([
  "queue_resume",
  "mark_resolved",
  "dismiss",
  "wait_for_user"
]);

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const record = await getAnalysis(id);
  if (!record) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }

  return NextResponse.json({
    interrupts: record.webResearch?.runtimeTrace?.interrupts ?? []
  });
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const record = await getAnalysis(id);
  if (!record) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }

  let payload: {
    interruptId?: string;
    action?: AgentRunInterruptAction;
    note?: string;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const interruptId = payload.interruptId?.trim();
  const action = payload.action ?? "wait_for_user";
  if (!interruptId) {
    return NextResponse.json({ error: "interruptId is required" }, { status: 400 });
  }
  if (!allowedActions.has(action)) {
    return NextResponse.json({ error: `Unsupported interrupt action: ${action}` }, { status: 400 });
  }

  try {
    const result = await handleRuntimeInterrupt(record, {
      interruptId,
      action,
      note: payload.note?.trim()
    });
    await saveAnalysis(result.record);
    return NextResponse.json({
      interrupt: result.interrupt,
      interrupts: result.record.webResearch?.runtimeTrace?.interrupts ?? [],
      resumeRequests: result.record.webResearch?.runtimeTrace?.resumeRequests ?? []
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runtime interrupt failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
