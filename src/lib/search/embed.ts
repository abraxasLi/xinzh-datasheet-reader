// 在线 Embedding：BGE-M3（中英双语），走硅基流动 SiliconFlow。
// 只在用户主动开启"语义搜索"后才被调用；key 只读 .siliconflow-key 或环境变量，不进前端、不进日志。
import fs from "node:fs";
import path from "node:path";

// Windows 资源管理器常把 .siliconflow-key 存成 .siliconflow-key.txt，两种名字都认。
const KEY_FILES = [".siliconflow-key", ".siliconflow-key.txt"].map((name) => path.join(process.cwd(), name));
const BASE = process.env.SILICONFLOW_BASE || "https://api.siliconflow.cn/v1";
const MODEL = process.env.XINZH_EMBED_MODEL || "BAAI/bge-m3";
const BATCH = 32;

function readKey(): string {
  const fromEnv = (process.env.SILICONFLOW_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const file = KEY_FILES.find((candidate) => fs.existsSync(candidate));
    if (!file) return "";
    const match = fs.readFileSync(file, "utf8").trim().match(/^(?:SILICONFLOW_API_KEY\s*=\s*)?(.+)$/m);
    return (match?.[1] || "").trim().replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}

export function embeddingConfig() {
  return { configured: Boolean(readKey()), provider: "硅基流动 SiliconFlow", host: "api.siliconflow.cn", model: MODEL };
}

async function embedBatch(texts: string[], attempt = 0): Promise<number[][]> {
  const key = readKey();
  if (!key) throw new Error("未配置 Embedding 的 API key（.siliconflow-key 或 SILICONFLOW_API_KEY）。");
  const response = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, input: texts, encoding_format: "float" }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = (await response.json().catch(() => ({}))) as { data?: { index: number; embedding: number[] }[]; message?: string };
  if (!response.ok) {
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      return embedBatch(texts, attempt + 1);
    }
    throw new Error(`Embedding 请求失败（${response.status}）：${(payload.message || "").slice(0, 120)}`);
  }
  const data = [...(payload.data || [])].sort((a, b) => a.index - b.index);
  if (data.length !== texts.length) throw new Error("Embedding 返回条数与请求不一致。");
  return data.map((item) => item.embedding);
}

export async function embedTexts(texts: string[], onProgress?: (done: number) => void): Promise<number[][]> {
  const out: number[][] = [];
  // BGE-M3 单条输入上限 8192 token，段落已在 1600 字符内；这里再截断兜底。
  const clipped = texts.map((text) => text.slice(0, 2000));
  const batches: string[][] = [];
  for (let i = 0; i < clipped.length; i += BATCH) batches.push(clipped.slice(i, i + BATCH));
  // 并发 4 路，兼顾速度与限流。
  const results: number[][][] = new Array(batches.length);
  let next = 0;
  let done = 0;
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, async () => {
    while (next < batches.length) {
      const at = next++;
      results[at] = await embedBatch(batches[at]);
      done += batches[at].length;
      onProgress?.(done);
    }
  }));
  for (const batch of results) out.push(...batch);
  return out;
}
