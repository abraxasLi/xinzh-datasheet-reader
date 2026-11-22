import { NextResponse } from "next/server";
import { z } from "zod";
import { documents } from "@/lib/documents";
import { embedTexts, embeddingConfig } from "@/lib/search/embed";
import { ensureIndex, hybridSearch, indexStatus } from "@/lib/search/index";
import { rewriteQuery, writeEvidenceCards } from "@/lib/search/evidence";
import { onlineConfig } from "@/lib/translation/online";

export const runtime = "nodejs";
export const maxDuration = 60;

// 向量距离（cosine）超过这个值、且关键词也没命中，就认为"没有一模一样的"。
const APPROXIMATE_DISTANCE = 0.55;

const requestSchema = z.object({
  documentId: z.string().uuid(),
  action: z.enum(["search", "index"]).default("search"),
  question: z.string().trim().min(1).max(1200).optional(),
});

function config() {
  return { embedding: embeddingConfig(), glm: { provider: onlineConfig().provider, host: onlineConfig().host, configured: onlineConfig().configured } };
}

/** 索引进度 / 云端配置状态。 */
export async function GET(request: Request) {
  const documentId = new URL(request.url).searchParams.get("documentId") || "";
  return NextResponse.json({ index: indexStatus(documentId), ...config() });
}

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    const document = documents.get(input.documentId);
    if (!document) return NextResponse.json({ error: "当前阅读会话已失效，请重新打开 PDF。" }, { status: 404 });

    if (input.action === "index") {
      const status = config();
      if (!status.embedding.configured) return NextResponse.json({ error: "未配置 Embedding key（.siliconflow-key），无法建立语义索引。已为你保留精确搜索。" }, { status: 412 });
      return NextResponse.json({ index: ensureIndex(input.documentId, document.name, document.pages), ...status });
    }

    const question = input.question || "";
    if (question.length < 2) return NextResponse.json({ error: "问题需为 2–1200 个字符。" }, { status: 400 });

    const startedAt = Date.now();
    const status = indexStatus(input.documentId);
    if (status.state !== "ready") {
      return NextResponse.json({ error: status.state === "error" ? status.error : "语义索引还没准备好。", index: status }, { status: 409 });
    }
    const english = await rewriteQuery(question);
    const rewrittenAt = Date.now();
    const searchText = english ? `${question}
${english}` : question;
    const [queryEmbedding] = await embedTexts([searchText]);
    const embeddedAt = Date.now();
    const { hits, keywordHits } = await hybridSearch(input.documentId, searchText, queryEmbedding, 5, question);
    const searchedAt = Date.now();
    if (!hits.length) return NextResponse.json({ mode: "semantic", cards: [], approximate: true, ms: searchedAt - startedAt });

    const best = hits[0];
    const approximate = keywordHits === 0 && !best.via.includes("keyword") && (best.distance ?? 1) > APPROXIMATE_DISTANCE;
    const used = approximate ? hits.slice(0, 1) : hits;
    const { cards, ms: glmMs, model } = await writeEvidenceCards(question, used.map((hit) => hit.chunk));
    console.info("[semantic-search]", JSON.stringify({ chunks: used.length, rewriteMs: rewrittenAt - startedAt, embedMs: embeddedAt - rewrittenAt, searchMs: searchedAt - embeddedAt, glmMs, model, approximate }));
    return NextResponse.json({ mode: "semantic", cards, approximate, ms: Date.now() - startedAt,
      ...(process.env.XINZH_SEARCH_DEBUG ? { debug: { english, hits: hits.map((hit) => ({ page: hit.chunk.page, register: hit.chunk.register, via: hit.via, distance: hit.distance, score: hit.score })) } } : {}), timing: { rewriteMs: rewrittenAt - startedAt, embedMs: embeddedAt - rewrittenAt, searchMs: searchedAt - embeddedAt, glmMs } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "请求参数不正确。" }, { status: 400 });
    console.error("semantic search failed:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: error instanceof Error ? error.message : "语义搜索暂时失败，请重试。" }, { status: 502 });
  }
}
