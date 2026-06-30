import { NextResponse } from "next/server";
import { runDynamicGitHubBacktest } from "@/lib/github-backtest-runner";
import { listBacktestRecords, updateBacktestSuggestion } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET() {
  const backtests = await listBacktestRecords();
  return NextResponse.json({ backtests });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as {
      repoUrl?: string;
      suggestionId?: string;
    };
    const repoUrl = String(payload.repoUrl || "").trim();
    const suggestionId = String(payload.suggestionId || "").trim();
    if (!repoUrl) {
      return NextResponse.json(
        { error: "请先输入 GitHub repo URL。" },
        { status: 400 }
      );
    }
    if (!/^https:\/\/github\.com\/[^/]+\/[^/\s]+/i.test(repoUrl)) {
      return NextResponse.json(
        { error: "请输入形如 https://github.com/owner/repo 的 URL。" },
        { status: 400 }
      );
    }

    const backtest = await runDynamicGitHubBacktest(repoUrl);
    if (suggestionId) {
      await updateBacktestSuggestion(suggestionId, {
        status: "used",
        repoUrl: backtest.repoUrl,
        usedBacktestId: backtest.id,
        usedAt: new Date().toISOString()
      });
    }
    return NextResponse.json({ backtest });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "README 回测失败" },
      { status: 500 }
    );
  }
}
