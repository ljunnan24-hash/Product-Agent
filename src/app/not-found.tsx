import Link from "next/link";

export default function NotFound() {
  return (
    <main className="not-found">
      <h1>没有找到这个分析</h1>
      <p>它可能还没有生成，或者本地数据被清理了。</p>
      <Link href="/">回到 Product Agent</Link>
    </main>
  );
}
