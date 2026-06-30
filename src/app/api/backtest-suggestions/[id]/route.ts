import { NextResponse } from "next/server";
import { buildBacktestCandidatePatch } from "@/lib/backtest-suggestion-candidates";
import { getBacktestSuggestion, updateBacktestSuggestion } from "@/lib/storage";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const payload = (await request.json().catch(() => ({}))) as {
    action?: "dismiss" | "used" | "open" | "refresh_candidates";
    repoUrl?: string;
    backtestId?: string;
  };
  const action = payload.action || "open";
  const now = new Date().toISOString();

  if (action === "dismiss") {
    const suggestion = await updateBacktestSuggestion(id, {
      status: "dismissed",
      dismissedAt: now
    });
    if (!suggestion) {
      return NextResponse.json({ error: "Backtest suggestion not found" }, { status: 404 });
    }
    return NextResponse.json({ suggestion });
  }

  if (action === "used") {
    const suggestion = await updateBacktestSuggestion(id, {
      status: "used",
      repoUrl: payload.repoUrl,
      usedBacktestId: payload.backtestId,
      usedAt: now
    });
    if (!suggestion) {
      return NextResponse.json({ error: "Backtest suggestion not found" }, { status: 404 });
    }
    return NextResponse.json({ suggestion });
  }

  if (action === "refresh_candidates") {
    const current = await getBacktestSuggestion(id);
    if (!current) {
      return NextResponse.json({ error: "Backtest suggestion not found" }, { status: 404 });
    }
    const suggestion = await updateBacktestSuggestion(
      id,
      await buildBacktestCandidatePatch(current)
    );
    if (!suggestion) {
      return NextResponse.json({ error: "Backtest suggestion not found" }, { status: 404 });
    }
    return NextResponse.json({ suggestion });
  }

  const suggestion = await updateBacktestSuggestion(id, {
    status: "open",
    dismissedAt: undefined,
    usedAt: undefined,
    usedBacktestId: undefined
  });
  if (!suggestion) {
    return NextResponse.json({ error: "Backtest suggestion not found" }, { status: 404 });
  }
  return NextResponse.json({ suggestion });
}
