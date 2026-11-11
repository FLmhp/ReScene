import type { Metadata } from "next";
import "@rescene/design-tokens/web.css";
import "@rescene/viewer/viewer.css";
import "@rescene/workbench/workbench.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReScene · 三维重建工作台",
  description: "基于 Gaussian Splatting 的团队三维重建工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
