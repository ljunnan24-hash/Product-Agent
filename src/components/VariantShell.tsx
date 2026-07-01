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
          <span className="topbar-status">产品验证 Agent</span>
          <Link className="secondary-link" href="/analyses">
            历史判断
          </Link>
        </div>
      </header>
      <ChatAgentEntry variant={variant} />
    </main>
  );
}
