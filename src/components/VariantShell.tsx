import Link from "next/link";
import { ChatAgentEntry } from "./ChatAgentEntry";
import type { ProductVariantConfig } from "@/lib/variants";

type Props = {
  variant: ProductVariantConfig;
};

export function VariantShell({ variant }: Props) {
  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/">
          Product Agent
        </Link>
        <div className="topbar-actions">
          <span className="topbar-status">上传材料，判断潜力</span>
          <Link className="secondary-link" href="/backtests">
            回测
          </Link>
          <Link className="secondary-link" href="/analyses">
            报告库
          </Link>
        </div>
      </header>
      <ChatAgentEntry variant={variant} />
    </main>
  );
}
