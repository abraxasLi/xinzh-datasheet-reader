// 让 GLM 现场把最像的几段写成中文证据卡。不训练、不写死题集。
// 发送内容：用户的问题 + 命中的手册片段；不发送 PDF 文件本身、文件名。
import fs from "node:fs";
import path from "node:path";
import { onlineConfig } from "@/lib/translation/online";
import type { Chunk } from "./chunk";

export type EvidenceCard = {
  title: string;       // "AFIO_MAPR · 复用重映射寄存器"
  what: string;        // 1 句中文解释
  quote_zh: string;    // 原文那句的中文翻译，命中词用 **加粗**
  keyword: string;     // 英文原样关键词
  sentence_en: string; // 英文原文那句（逐字取自手册片段）
  page: number;
  section: string;
  register: string;
};

function readKey(): string {
  const fromEnv = (process.env.ZHIPU_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const file = path.join(process.cwd(), ".zhipu-key");
    if (!fs.existsSync(file)) return "";
    const match = fs.readFileSync(file, "utf8").trim().match(/^(?:ZHIPU_API_KEY\s*=\s*)?(.+)$/m);
    return (match?.[1] || "").trim().replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}

const SYSTEM = [
  "你是嵌入式芯片手册的中文检索助手，面向不懂英文的初学者。",
  "用户给出一个中文问题和若干编号的手册英文片段。对每个片段输出一张证据卡，严格输出 JSON 数组，不要任何其它文字、不要 Markdown。",
  "每个元素字段：",
  '{"i":片段编号,"title":"寄存器名或主题英文名 · 中文名（如 AFIO_MAPR · 复用重映射寄存器）","what":"一句中文解释这是什么，不超过 40 字","sentence_en":"从该片段中逐字复制最能回答问题的一句英文原文，不得改写","quote_zh":"sentence_en 的中文翻译，把与问题最相关的中文词用 **双星号** 包住","keyword":"该句里最关键的英文词或标识符，原样不翻译"}',
  "规则：寄存器名、位名、地址、数值、单位原样保留；否定和条件关系不能丢；片段里没有的内容不要编造；片段与问题无关时 what 写明“与问题关系不大”。",
].join("\n");

function extractJson(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON。");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("模型返回格式不对。");
  return parsed;
}

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/** 取命中词所在句子，作为模型没给出可核对原句时的兜底。 */
export function fallbackSentence(text: string, term: string) {
  const flat = normalize(text);
  const position = term ? flat.toLowerCase().indexOf(term.toLowerCase()) : -1;
  if (position < 0) return flat.slice(0, 220);
  const before = flat.slice(0, position);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("; "), -1) + 1;
  const endMatch = /[.;](?:\s|$)/.exec(flat.slice(position));
  const end = endMatch ? position + endMatch.index + 1 : Math.min(flat.length, position + 260);
  return flat.slice(start, end).trim().slice(0, 320);
}

export async function writeEvidenceCards(question: string, chunks: Chunk[]): Promise<{ cards: EvidenceCard[]; ms: number; model: string }> {
  const key = readKey();
  if (!key) throw new Error("未配置智谱 API key（.zhipu-key 或 ZHIPU_API_KEY）。");
  const config = onlineConfig();
  const startedAt = Date.now();
  const user = `问题：${question}\n\n` + chunks.map((chunk, index) => `【${index + 1}】${chunk.section ? `(${chunk.section}) ` : ""}${chunk.text.slice(0, 1200)}`).join("\n\n");
  const response = await fetch(`${config.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      stream: false,
      max_tokens: 1800,
      thinking: { type: "disabled" },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = (await response.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!response.ok) throw new Error(`证据卡生成失败（${response.status}）：${(payload.error?.message || "").slice(0, 120)}`);
  const raw = extractJson(payload.choices?.[0]?.message?.content || "") as Record<string, unknown>[];

  const cards = chunks.map((chunk, index): EvidenceCard => {
    const item = raw.find((entry) => Number(entry.i) === index + 1) || raw[index] || {};
    const text = (field: string) => (typeof item[field] === "string" ? (item[field] as string).trim() : "");
    const keyword = text("keyword") || chunk.register;
    // 英文原句必须逐字出自手册片段，否则用本地规则取句，避免模型改写原文。
    const claimed = normalize(text("sentence_en"));
    const sentence = claimed && normalize(chunk.text).includes(claimed) ? claimed : fallbackSentence(chunk.text, keyword || chunk.register);
    return {
      title: text("title") || chunk.register || chunk.section || "相关原文",
      what: text("what"),
      quote_zh: text("quote_zh"),
      keyword,
      sentence_en: sentence,
      page: chunk.page,
      section: chunk.section,
      register: chunk.register,
    };
  });
  return { cards, ms: Date.now() - startedAt, model: config.model };
}
