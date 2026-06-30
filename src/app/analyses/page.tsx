import Link from "next/link";
import { Plus } from "lucide-react";
import { AnalysesWorkbench } from "@/components/AnalysesWorkbench";
import { summarizeAnalysis } from "@/lib/analysis-summary";
import { listAnalyses } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function AnalysesPage() {
  const records = await listAnalyses();
  const summaries = records.map(summarizeAnalysis);

  return (
    <main className="history-shell">
      <header className="report-header">
        <Link className="brand" href="/">
          Product Agent
        </Link>
        <div className="topbar-actions">
          <Link className="secondary-link" href="/">
            <Plus size={16} />
            新建诊断
          </Link>
        </div>
      </header>

      <AnalysesWorkbench analyses={summaries} />
    </main>
  );
}
