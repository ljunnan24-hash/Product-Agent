import { notFound } from "next/navigation";
import { ReportView } from "@/components/ReportView";
import { evidenceStandardForStage } from "@/lib/evidence-agent";
import { getAnalysis } from "@/lib/storage";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function AnalysisPage({ params }: Props) {
  const { id } = await params;
  const record = await getAnalysis(id);

  if (!record || !record.report) {
    notFound();
  }

  const viewRecord =
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

  return <ReportView record={viewRecord} />;
}
