import { NextResponse } from "next/server";
import { z } from "zod";
import { documents } from "@/lib/documents";
import { searchPages } from "@/lib/retrieval";

export const runtime = "nodejs";

const requestSchema = z.object({ documentId: z.string().uuid(), question: z.string().trim().min(2).max(1200) });

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    const document = documents.get(input.documentId);
    if (!document) return NextResponse.json({ error: "当前阅读会话已失效，请重新打开 PDF。" }, { status: 404 });
    const result = searchPages(document.pages, input.question, document.kind, document.name);
    return NextResponse.json({
      mode: "local",
      answer: {
        answer_zh: result.answerHint,
        resolved_term: result.glossary[0] ? `${result.glossary[0].term} · ${result.glossary[0].english}` : "",
        confidence: 0,
        insufficient: result.evidence.length === 0,
        evidence: result.evidence,
        glossary: result.glossary,
      },
    });
  } catch (error) {
    const message = error instanceof z.ZodError ? "问题需为 2–1200 个字符。" : "本地检索暂时失败，请重试。";
    return NextResponse.json({ error: message }, { status: error instanceof z.ZodError ? 400 : 500 });
  }
}
