// 混合检索：BM25（精确词）+ 向量（语义）→ RRF 合并，取最像的 5 段。
import { createHash } from "node:crypto";
import { expandToEnglish } from "@/lib/datasheet/terms";
import { matchGlossary } from "@/lib/glossary";
import { buildBm25, type Bm25Index } from "./bm25";
import { chunkDocument, type Chunk } from "./chunk";
import { collectionNameFor, dropOtherManuals, getChroma } from "./chroma";
import { embedTexts, embeddingConfig } from "./embed";
import { buildOutline } from "./outline";

export type IndexStatus = { state: "idle" | "indexing" | "ready" | "error"; done: number; total: number; error: string; reused: boolean };
type DocIndex = IndexStatus & { outline: string[]; chunks: Chunk[]; bm25: Bm25Index | null; collection: string; job: Promise<void> | null };

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

/** 这本手册自己的章节/外设名词表，给查询改写做领域对照。 */
export function documentOutline(documentId: string): string[] {
  return indexes.get(documentId)?.outline ?? [];
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
  const item: DocIndex = { outline: buildOutline(pages), state: "indexing", done: 0, total: chunks.length, error: "", reused: false, chunks, bm25: buildBm25(chunks), collection: collectionNameFor(fingerprint(name, pages)), job: null };
  indexes.set(documentId, item);
  item.job = (async () => {
    try {
      const client = await getChroma();
      await dropOtherManuals(client, item.collection);
      const open = () => client.getOrCreateCollection({ name: item.collection, embeddingFunction: null, configuration: { hnsw: { space: "cosine" } } });
      let collection = await open();
      let existing = 0;
      try {
        existing = await collection.count();
        // 取一条向量验证 HNSW 索引能加载（Chroma 被强行结束后索引文件可能损坏）。
        if (existing > 0) await collection.query({ queryEmbeddings: [new Array(1024).fill(0.01)], nResults: 1 });
      } catch {
        await client.deleteCollection({ name: item.collection }).catch(() => undefined);
        collection = await open();
        existing = 0;
      }
      if (existing === chunks.length && chunks.length > 0) {
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

export async function hybridSearch(documentId: string, question: string, queryEmbeddings: number[][], limit = 5, userQuestion = question): Promise<{ hits: Hit[]; keywordHits: number; semanticHits: number }> {
  const item = indexes.get(documentId);
  if (!item || item.state !== "ready" || !item.bm25) throw new Error("索引还没准备好。");
  const keyword = item.bm25.search(queryTerms(question), 20);
  const client = await getChroma();
  const collection = await client.getCollection({ name: item.collection });
  // 每个查询向量各查一路（目前只传一个："原中文问题 + 英文改写"）。
  // 试过再加一路"只有中文问题"的向量并加权兜底：BGE-M3 对很短的中文去搜英文手册跨语言很弱，
  // 只会把无关段落抬高，已撤回。
  const results = await Promise.all(queryEmbeddings.map((embedding) => collection.query({ queryEmbeddings: [embedding], nResults: 20, include: ["distances"] })));
  const semanticLists = results.map((result) => ({
    ids: (result.ids[0] || []) as string[],
    distances: (result.distances?.[0] || []) as (number | null)[],
  }));
  const semanticIds = semanticLists.flatMap((list) => list.ids);
  const byId = new Map(item.chunks.map((chunk) => [chunk.id, chunk]));

  const fused = new Map<string, Hit>();
  const add = (chunk: Chunk, rank: number, via: "keyword" | "semantic", weight = 1) => {
    const hit = fused.get(chunk.id) || { chunk, score: 0, via: [], distance: null };
    hit.score += weight / (RRF_K + rank);
    if (!hit.via.includes(via)) hit.via.push(via);
    fused.set(chunk.id, hit);
  };
  keyword.forEach((entry, rank) => add(entry.chunk, rank, "keyword"));
  semanticLists.forEach((list, listIndex) => {
    list.ids.forEach((id, rank) => {
      const chunk = byId.get(id);
      if (!chunk) return;
      add(chunk, rank, "semantic");
      const hit = fused.get(id)!;
      const distance = list.distances[rank] ?? null;
      if (distance !== null && (hit.distance === null || distance < hit.distance)) hit.distance = distance;
    });
  });
  // 用户写出了完整的寄存器名：寄存器定义段排在泛提及之前。
  // 只认用户自己写的名字；改写出来的"可能的寄存器名"只是猜测，不能拿来加权。
  const named = new Set((userQuestion.match(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g) || []).map((token) => token.toLowerCase()));
  for (const hit of fused.values()) if (hit.chunk.register && named.has(hit.chunk.register.toLowerCase())) hit.score += 0.05;
  // 同一个寄存器/小节被切成多段时只留最相关的一段，别让一个寄存器占满 5 个名额。
  const seen = new Set<string>();
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score).filter((hit) => {
    const key = `${hit.chunk.register || hit.chunk.section}|${hit.chunk.page}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // 顺着引用补定义：前几段正文反复提到某个寄存器（如 "write the key in the Key register (XXX_KR)"），
  // 而它的定义段只有标题、自己很难被搜到时，把定义段补进来。
  const definitions = new Map<string, Chunk>();
  for (const chunk of item.chunks) if (chunk.register && !definitions.has(chunk.register)) definitions.set(chunk.register, chunk);
  const mentions = new Map<string, number>();
  for (const hit of ranked.slice(0, 4)) {
    for (const token of new Set(hit.chunk.text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Za-z0-9]+)+\b/g) || [])) {
      if (definitions.has(token) && hit.chunk.register !== token) mentions.set(token, (mentions.get(token) || 0) + 1);
    }
  }
  const present = new Set(ranked.slice(0, limit).map((hit) => hit.chunk.register).filter(Boolean));
  const anchor = ranked[Math.min(2, ranked.length - 1)]?.score ?? 0;
  const referenced = [...mentions.entries()].filter(([register, count]) => count >= 1 && !present.has(register)).sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([register]): Hit => ({ chunk: definitions.get(register)!, score: anchor + 0.0005, via: ["keyword"], distance: null }));
  const hits = [...ranked.slice(0, limit), ...referenced].sort((a, b) => b.score - a.score).slice(0, limit);
  return { hits, keywordHits: keyword.length, semanticHits: semanticIds.length };
}
