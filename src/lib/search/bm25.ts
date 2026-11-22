// 关键词路：BM25。认 AFIO_MAPR、0x40010004 这类精确词。
import type { Chunk } from "./chunk";

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/0x[0-9a-f]+|[a-z][a-z0-9_]*|\d+/g) || []) {
    out.push(raw);
    // AFIO_MAPR 同时可被 afio / mapr 命中，但完整标识符权重由 IDF 自然拉高。
    if (raw.includes("_")) for (const part of raw.split("_")) if (part.length > 1) out.push(part);
  }
  return out;
}

export type Bm25Index = {
  search(queryTerms: string[], limit: number): { chunk: Chunk; score: number }[];
};

export function buildBm25(chunks: Chunk[]): Bm25Index {
  const k1 = 1.4;
  const b = 0.75;
  const docs = chunks.map((chunk) => {
    // 寄存器名和章节标题多算一遍，让定义段排在泛提及之前。
    const tokens = tokenize(`${chunk.register} ${chunk.register} ${chunk.section} ${chunk.text}`);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    return { tf, length: tokens.length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const doc of docs) for (const token of doc.tf.keys()) df.set(token, (df.get(token) || 0) + 1);

  return {
    search(queryTerms, limit) {
      const terms = [...new Set(queryTerms.map((term) => term.toLowerCase()))];
      const scored: { chunk: Chunk; score: number }[] = [];
      docs.forEach((doc, index) => {
        let score = 0;
        for (const term of terms) {
          const frequency = doc.tf.get(term);
          if (!frequency) continue;
          const n = df.get(term) || 0;
          const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
          score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * doc.length / average));
        }
        if (score > 0) scored.push({ chunk: chunks[index], score });
      });
      return scored.sort((a, b2) => b2.score - a.score).slice(0, limit);
    },
  };
}
