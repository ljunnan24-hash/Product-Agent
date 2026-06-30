import { NextResponse } from "next/server";
import {
  AnalysisRequestError,
  runAnalysisFromFormData
} from "@/lib/analysis-runner";
import { summarizeAnalysis } from "@/lib/analysis-summary";
import { listAnalyses } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET() {
  const records = await listAnalyses();
  return NextResponse.json({
    analyses: records.map(summarizeAnalysis)
  });
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const record = await runAnalysisFromFormData(formData);

    return NextResponse.json({
      id: record.id,
      status: record.status,
      report: record.report
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "分析失败";
    const status = error instanceof AnalysisRequestError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
