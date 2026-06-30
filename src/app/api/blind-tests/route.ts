import { NextResponse } from "next/server";
import {
  blindTestCases,
  defaultBlindTestScores,
  productAgentJudgmentFromBacktest
} from "@/lib/blind-test-cases";
import { runDynamicGitHubBacktest } from "@/lib/github-backtest-runner";
import { listBlindTestJudgments, upsertBlindTestJudgment } from "@/lib/storage";
import type {
  BlindTestJudgment,
  BlindTestParticipant,
  BlindTestScores
} from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const judgments = await listBlindTestJudgments();
  return NextResponse.json({ cases: blindTestCases, judgments });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as {
      action?: "save_judgment" | "run_product_agent";
      caseId?: string;
      participant?: BlindTestParticipant;
      output?: string;
      notes?: string;
      scores?: BlindTestScores;
      potentialScore?: number;
      decision?: BlindTestJudgment["decision"];
    };
    const testCase = blindTestCases.find((item) => item.id === payload.caseId);
    if (!testCase) {
      return NextResponse.json({ error: "Blind test case not found" }, { status: 404 });
    }

    if (payload.action === "run_product_agent") {
      const backtest = await runDynamicGitHubBacktest(testCase.repoUrl);
      const judgment = await upsertBlindTestJudgment(
        productAgentJudgmentFromBacktest(testCase, backtest)
      );
      return NextResponse.json({ judgment, backtest });
    }

    const participant = payload.participant;
    if (!participant || participant === "product_agent") {
      return NextResponse.json(
        { error: "手动保存只支持 ChatGPT / Claude。" },
        { status: 400 }
      );
    }
    const output = String(payload.output || "").trim();
    if (!output) {
      return NextResponse.json({ error: "请先粘贴模型输出。" }, { status: 400 });
    }
    const judgment = await upsertBlindTestJudgment({
      caseId: testCase.id,
      participant,
      output,
      notes: String(payload.notes || "").trim() || undefined,
      scores: sanitizeScores(payload.scores),
      potentialScore: normalizePotentialScore(payload.potentialScore),
      decision: payload.decision
    });
    return NextResponse.json({ judgment });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存盲测结果失败" },
      { status: 500 }
    );
  }
}

function sanitizeScores(scores: BlindTestScores | undefined) {
  const fallback = defaultBlindTestScores();
  return {
    evidenceQuality: clamp(scores?.evidenceQuality ?? fallback.evidenceQuality),
    oppositionCoverage: clamp(scores?.oppositionCoverage ?? fallback.oppositionCoverage),
    experimentActionability: clamp(scores?.experimentActionability ?? fallback.experimentActionability),
    calibration: clamp(scores?.calibration ?? fallback.calibration),
    trust: clamp(scores?.trust ?? fallback.trust)
  };
}

function clamp(value: number) {
  return Math.max(1, Math.min(5, Math.round(Number(value) || 1)));
}

function normalizePotentialScore(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}
