import { NextResponse } from "next/server";
import { evidenceStandardForStage } from "@/lib/evidence-agent";
import { getAnalysis } from "@/lib/storage";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const record = await getAnalysis(id);

  if (!record) {
    return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  }

  const responseRecord =
    record.evidenceBrief && !record.evidenceBrief.lifecycleEvidenceStandard
      ? {
          ...record,
          evidenceBrief: {
            ...record.evidenceBrief,
            lifecycleEvidenceStandard: evidenceStandardForStage(
              record.evidenceBrief.productLifecycleStage ?? "unknown"
            )
          }
        }
      : record;

  return NextResponse.json(responseRecord);
}
