import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { documents, type StoredDocument } from "@/lib/documents";

export const runtime = "nodejs";
export const maxDuration = 60;

async function extractPdf(buffer: Buffer): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  const pdf = await task.promise;
  if (pdf.numPages < 1 || pdf.numPages > 1500) throw new Error("PDF 页数异常（支持 1–1500 页）。");
  const pages: string[] = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const text = content.items.map((item) => "str" in item ? item.str : "").filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    pages.push(text);
  }
  return pages;
}

function detectKind(firstPage: string): string {
  const text = firstPage.toLowerCase();
  if (text.includes("reference manual")) return "Reference Manual";
  if (text.includes("programming manual")) return "Programming Manual";
  if (text.includes("application note")) return "Application Note";
  if (text.includes("datasheet") || text.includes("data sheet")) return "Datasheet";
  return "Technical document";
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "请选择一个 PDF 文件。" }, { status: 400 });
    const maxMb = Number(process.env.MAX_UPLOAD_MB || 30);
    if (file.size > maxMb * 1024 * 1024) return NextResponse.json({ error: `文件超过 ${maxMb} MB 限制。` }, { status: 413 });
    if (!file.name.toLowerCase().endsWith(".pdf")) return NextResponse.json({ error: "仅支持 PDF 文件。" }, { status: 415 });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return NextResponse.json({ error: "文件内容不是有效的 PDF。" }, { status: 415 });
    const pages = await extractPdf(bytes);
    const nonEmptyPages = pages.filter((page) => page.length >= 10).length;
    if (nonEmptyPages === 0) return NextResponse.json({ error: "没有提取到可搜索文字。该文件可能是扫描件，当前版本暂不支持 OCR。" }, { status: 422 });
    const id = randomUUID();
    const kind = detectKind(pages[0] || "");
    const document: StoredDocument = { id, name: file.name, pages, kind };
    documents.set(id, document);
    return NextResponse.json({ documentId: id, name: file.name, pageCount: pages.length, kind });
  } catch (error) {
    console.error("PDF ingestion failed:", error instanceof Error ? error.message : "unknown error");
    const message = error instanceof Error && (error.message.includes("扫描件") || error.message.includes("页数") || error.message.includes("索引")) ? error.message : "无法读取该 PDF。请确认文件未加密且没有损坏。";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
