import Link from "next/link";
import { ArrowLeft, Plus } from "lucide-react";
import { BlindTestsWorkbench } from "@/components/BlindTestsWorkbench";
import { blindTestCases } from "@/lib/blind-test-cases";
import { listBacktestRecords, listBlindTestJudgments } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function BlindTestsPage() {
  const judgments = await listBlindTestJudgments();
  const backtests = await listBacktestRecords(120);

  return (
    <main className="backtest-shell">
      <header className="report-header">
        <Link className="brand" href="/">
          Product Agent
        </Link>
        <div className="topbar-actions">
          <Link className="secondary-link" href="/">
            <Plus size={16} />
            新建诊断
          </Link>
          <Link className="secondary-link" href="/analyses">
            报告库
          </Link>
          <Link className="secondary-link" href="/backtests">
            <ArrowLeft size={16} />
            README 回测
          </Link>
        </div>
      </header>

      <section className="backtest-hero blind-hero">
        <div>
          <p>真实产品盲测</p>
          <h1>同一批材料，同一把尺。</h1>
        </div>
        <span>{blindTestCases.length} 个校准样本</span>
      </section>

      <BlindTestsWorkbench
        cases={blindTestCases}
        initialBacktests={backtests}
        initialJudgments={judgments}
      />
    </main>
  );
}
