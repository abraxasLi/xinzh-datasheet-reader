// 混合检索：BM25（精确词）+ 向量（语义）→ RRF 合并，取最像的 5 段。
import { createHash } from "node:crypto";
import { expandToEnglish } from "@/lib/datasheet/terms";
import { matchGlossary } from "@/lib/glossary";
import { buildBm25, type Bm25Index } from "./bm25";
import { chunkDocument, type Chunk } from "./chunk";
import { collectionNameFor, dropOtherManuals, getChroma } from "./chroma";
import { embedTexts, embeddingConfig } from "./embed";

export type IndexStatus = { state: "idle" | "indexing" | "ready" | "error"; done: number; total: number; error: string; reused: boolean };
type DocIndex = IndexStatus & { chunks: Chunk[]; bm25: Bm25Index | null; collection: string; job: Promise<void> | null };

const globalIndex = globalThis as typeof globalThis & { __xinzhIndex?: Map<string, DocIndex> };
const indexes = globalIndex.__xinzhIndex ??= new Map<string, DocIndex>();

function fingerprint(name: string, pages: string[]) {
  const hash = createHash("sha1");
  hash.update(name);
  hash.update("chunk-v3"); // 切段规则变了就换索引
  hash.update(embeddingConfig().model); // 换 embedding 模型必须换索引，别复用别的向量
  hash.update(process.env.SILICONFLOW_BASE || "");
  hash.update(String(pages.length));
  for (const page of pages) { hash.update(String(page.length)); hash.update(page.slice(0, 120)); }
  return hash.digest("hex").slice(0, 20);
}

export function indexStatus(documentId: string): IndexStatus {
  const item = indexes.get(documentId);
  return item ? { state: item.state, done: item.done, total: item.total, error: item.error, reused: item.reused } : { state: "idle", done: 0, total: 0, error: "", reused: false };
}

/** 建索引（后台进行）。同一本手册已在 ./chroma_db 里有完整 collection 时直接复用，不再调 embedding。 */
export function ensureIndex(documentId: string, name: string, pages: string[]): IndexStatus {
  const existing = indexes.get(documentId);
  if (existing && (existing.state === "indexing" || existing.state === "ready")) return indexStatus(documentId);
  const chunks = chunkDocument(pages, name);
  const item: DocIndex = { state: "indexing", done: 0, total: chunks.length, error: "", reused: false, chunks, bm25: buildBm25(chunks), collection: collectionNameFor(fingerprint(name, pages)), job: null };
  indexes.set(documentId, item);
  item.job = (async () => {
    try {
      const client = await getChroma();
      await dropOtherManuals(client, item.collection);
      const collection = await client.getOrCreateCollection({ name: item.collection, embeddingFunction: null, configuration: { hnsw: { space: "cosine" } } });
      if ((await collection.count()) === chunks.length && chunks.length > 0) {
        item.done = chunks.length; item.reused = true; item.state = "ready";
        return;
      }
      const embeddings = await embedTexts(chunks.map((chunk) => `${chunk.section}\n${chunk.text}`), (done) => { item.done = done; });
      for (let start = 0; start < chunks.length; start += 200) {
        const slice = chunks.slice(start, start + 200);
        await collection.upsert({
          ids: slice.map((chunk) => chunk.id),
          embeddings: embeddings.slice(start, start + 200),
          documents: slice.map((chunk) => chunk.text),
          metadatas: slice.map((chunk) => ({ page: chunk.page, section: chunk.section, register: chunk.register, doc: chunk.doc })),
        });
      }
      item.state = "ready";
    } catch (error) {
      item.state = "error";
      item.error = error instanceof Error ? error.message : String(error);
    }
  })();
  return indexStatus(documentId);
}

export type Hit = { chunk: Chunk; score: number; via: ("keyword" | "semantic")[]; distance: number | null };

function queryTerms(question: string) {
  const terms = new Set<string>();
  for (const token of question.match(/0x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9_]*/g) || []) terms.add(token);
  for (const term of expandToEnglish(question)) terms.add(term);
  for (const entry of matchGlossary(question)) { terms.add(entry.term); terms.add(entry.english); }
  return [...terms].flatMap((term) => term.split(/\s+/));
}

const RRF_K = 60;

export async function hybridSearch(documentId: string, question: string, queryEmbedding: number[], limit = 5): Promise<{ hits: Hit[]; keywordHits: number; semanticHits: number }> {
  const item = indexes.get(documentId);
  if (!item || item.state !== "ready" || !item.bm25) throw new Error("索引还没准备好。");
  const keyword = item.bm25.search(queryTerms(question), 20);
  const client = await getChroma();
  const collection = await client.getCollection({ name: item.collection });
  const result = await collection.query({ queryEmbeddings: [queryEmbedding], nResults: 20, include: ["distances"] });
  const semanticIds = (result.ids[0] || []) as string[];
  const distances = (result.distances?.[0] || []) as (number | null)[];
  const byId = new Map(item.chunks.map((chunk) => [chunk.id, chunk]));

  const fused = new Map<string, Hit>();
  const add = (chunk: Chunk, rank: number, via: "keyword" | "semantic") => {
    const hit = fused.get(chunk.id) || { chunk, score: 0, via: [], distance: null };
    hit.score += 1 / (RRF_K + rank);
    if (!hit.via.includes(via)) hit.via.push(via);
    fused.set(chunk.id, hit);
  };
  keyword.forEach((entry, rank) => add(entry.chunk, rank, "keyword"));
  semanticIds.forEach((id, rank) => {
    const chunk = byId.get(id);
    if (!chunk) return;
    add(chunk, rank, "semantic");
    fused.get(id)!.distance = distances[rank] ?? null;
  });
  // 用户写出了完整的寄存器名：寄存器定义段排在泛提及之前。
  const named = new Set((question.match(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g) || []).map((token) => token.toLowerCase()));
  for (const hit of fused.values()) if (hit.chunk.register && named.has(hit.chunk.register.toLowerCase())) hit.score += 0.05;
  // 同一个寄存器/小节被切成多段时只留最相关的一段，别让一个寄存器占满 5 个名额。
  const seen = new Set<string>();
  const hits = [...fused.values()].sort((a, b) => b.score - a.score).filter((hit) => {
    const key = `${hit.chunk.register || hit.chunk.section}|${hit.chunk.page}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
  return { hits, keywordHits: keyword.length, semanticHits: semanticIds.length };
}
