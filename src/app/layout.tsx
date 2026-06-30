import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Product Agent",
  description: "One conversation and one material upload for product diagnosis."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
