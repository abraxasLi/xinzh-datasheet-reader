import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 打包成 EXE 时用 standalone 输出：把 Node 运行时和必需依赖收进 .next/standalone
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  serverExternalPackages: ["pdfjs-dist"],
  distDir: process.env.NEXT_BUILD_DIR || ".next",
};

export default nextConfig;
