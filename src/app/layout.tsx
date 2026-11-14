import type { Metadata } from "next";
import "pdfjs-dist/web/pdf_viewer.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "芯知 · 英文芯片手册阅读器",
  description: "用中文搜索定位英文芯片手册，并在阅读时查看上下文翻译。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
