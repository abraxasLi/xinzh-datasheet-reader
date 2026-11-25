import { NextResponse } from "next/server";
import { z } from "zod";
import { documents } from "@/lib/documents";
import { embedTexts, embeddingConfig } from "@/lib/search/embed";
import { documentOutline, ensureIndex, hybridSearch, indexStatus, registerDefinitionPage } from "@/lib/search/index";
import { rerankChunks, rewriteQuery, verifyCards, writeEvidenceCards } from "@/lib/search/evidence";
import { defaultLlm, llmHost, type LlmChoice } from "@/lib/search/llm";

export const runtime = "nodejs";
export const maxDuration = 60;

// 向量距离（cosine）超过这个值、且关键词也没命中，就认为"没有一模一样的"。
const APPROXIMATE_DISTANCE = 0.55;

// 两种搜索都联网、都由大模型现场判断，区别只是“想多久”：
// fast    默认：2 组改写并行 → 混合检索取前 5 → 出卡。目标 2–4 秒。
// precise 精确：3 组改写并行、多取到前 15 段 → 模型带推理再排一次序取 5 段 → 出卡 → 逐张核对寄存器名和页码。目标 5–10 秒。
const MODES = {
  fast: { rewrites: 2, candidates: 5, rerank: false, verify: false, extraRewriteWaitMs: 1500 },
  precise: { rewrites: 3, candidates: 15, rerank: true, verify: true, extraRewriteWaitMs: 3000 },
} as const;
// 多组改写用不同温度，让它们从不同角度理解问题；第一组固定 0，保证有一组最稳的。
const REWRITE_TEMPERATURES = [0, 0.6, 0.9];
// 第一组之外的改写最多等 extraRewriteWaitMs：偶尔有一组排队 5 秒以上，不值得让整次搜索陪着等。

function within(promise: Promise<string>, ms: number) {
  return Promise.race([promise, new Promise<string>((resolve) => setTimeout(() => resolve(""), ms))]);
}

const requestSchema = z.object({
  documentId: z.string().uuid(),
  action: z.enum(["search", "index"]).default("search"),
  mode: z.enum(["fast", "precise"]).default("fast"),
  question: z.string().trim().min(1).max(1200).optional(),
  // 仅调试：横向比较不同模型时按请求覆盖；没开 XINZH_SEARCH_DEBUG 时忽略。
  llm: z.object({ provider: z.enum(["zhipu", "siliconflow"]), model: z.string().min(2).max(80) }).optional(),
});

function config() {
  return { embedding: embeddingConfig(), llm: { provider: defaultLlm().provider, host: llmHost(), model: defaultLlm().model } };
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
      if (!status.embedding.configured) return NextResponse.json({ error: "未配置 Embedding key（.siliconflow-key），无法建立在线搜索索引。" }, { status: 412 });
      return NextResponse.json({ index: ensureIndex(input.documentId, document.name, document.pages), ...status });
    }

    const question = input.question || "";
    if (question.length < 2) return NextResponse.json({ error: "问题需为 2–1200 个字符。" }, { status: 400 });

    const startedAt = Date.now();
    const status = indexStatus(input.documentId);
    if (status.state !== "ready") {
      return NextResponse.json({ error: status.state === "error" ? status.error : "搜索索引还没准备好。", index: status }, { status: 409 });
    }
    const mode = MODES[input.mode];
    const llm: LlmChoice = (process.env.XINZH_SEARCH_DEBUG && input.llm) || defaultLlm();
    const outline = documentOutline(input.documentId);

    // 1. 改写：几组并行，耗时约等于最慢的一组。
    const rewrites = await Promise.all(REWRITE_TEMPERATURES.slice(0, mode.rewrites).map((temperature, index) => {
      const job = rewriteQuery(question, outline, llm, temperature);
      return index === 0 ? job : within(job, mode.extraRewriteWaitMs);
    }));
    const texts = [...new Set(rewrites.filter(Boolean).map((english) => `${question}\n${english}`))];
    if (!texts.length) texts.push(question);
    const rewrittenAt = Date.now();

    // 2. 每组改写一个向量（一次请求批量算），各查一路后合并。
    const embeddings = await embedTexts(texts);
    const embeddedAt = Date.now();
    const { hits, keywordHits } = await hybridSearch(input.documentId, texts.map((text, index) => ({ text, embedding: embeddings[index] })), mode.candidates, question);
    const searchedAt = Date.now();
    if (!hits.length) return NextResponse.json({ mode: input.mode, cards: [], approximate: true, ms: searchedAt - startedAt });

    const best = hits[0];
    const approximate = keywordHits === 0 && !best.via.includes("keyword") && (best.distance ?? 1) > APPROXIMATE_DISTANCE;

    // 3. 精确搜：模型带推理再排一次序。
    let chunks = hits.map((hit) => hit.chunk);
    let reranked = false;
    if (mode.rerank && !approximate) ({ chunks, reranked } = await rerankChunks(question, chunks, llm, 5));
    chunks = approximate ? chunks.slice(0, 1) : chunks.slice(0, 5);
    const rerankedAt = Date.now();

    // 4. 出卡；精确搜再逐张核对寄存器名和页码。
    const written = await writeEvidenceCards(question, chunks, llm);
    const cards = mode.verify ? verifyCards(written.cards, chunks, (register) => registerDefinitionPage(input.documentId, register)) : written.cards;
    const timing = { rewriteMs: rewrittenAt - startedAt, embedMs: embeddedAt - rewrittenAt, searchMs: searchedAt - embeddedAt, rerankMs: rerankedAt - searchedAt, glmMs: written.ms };
    console.info("[search]", JSON.stringify({ mode: input.mode, rewrites: texts.length, candidates: hits.length, reranked, model: written.model, approximate, ...timing }));
    return NextResponse.json({
      mode: input.mode, cards, approximate, reranked, ms: Date.now() - startedAt, timing,
      ...(process.env.XINZH_SEARCH_DEBUG ? { debug: {
        english: rewrites,
        hits: hits.map((hit) => ({ page: hit.chunk.page, register: hit.chunk.register, via: hit.via, distance: hit.distance, score: hit.score })),
        final: chunks.map((chunk) => ({ page: chunk.page, register: chunk.register })),
      } } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "请求参数不正确。" }, { status: 400 });
    console.error("search failed:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: error instanceof Error ? error.message : "搜索暂时失败，请重试。" }, { status: 502 });
  }
}
