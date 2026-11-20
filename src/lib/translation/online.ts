// 可选的在线翻译 provider（智谱 GLM）。
// 默认关闭；只有用户在界面上明确选择「在线」时才会把当前段落发到 bigmodel.cn。
// 只发送待译文本，不发送 PDF、文件名、页码或其它上下文。
import fs from "node:fs";
import path from "node:path";
import { matchTermsForText } from "@/lib/datasheet/terms";

const KEY_FILE = path.join(process.cwd(), ".zhipu-key");
const DEFAULT_BASE = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_MODEL = "glm-5.3-flashx";

function readKeyFile(): string {
  try {
    if (!fs.existsSync(KEY_FILE)) return "";
    const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
    const match = raw.match(/^(?:ZHIPU_API_KEY\s*=\s*)?(.+)$/m);
    return (match?.[1] || "").trim().replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}

export function onlineConfig() {
  const key = (process.env.ZHIPU_API_KEY || readKeyFile()).trim();
  return {
    configured: Boolean(key),
    provider: "智谱 GLM",
    host: "open.bigmodel.cn",
    base: process.env.ZHIPU_BASE || DEFAULT_BASE,
    model: process.env.XINZH_ONLINE_MODEL || DEFAULT_MODEL,
  };
}

const SYSTEM_PROMPT = [
  "你是嵌入式芯片数据手册的英译中翻译引擎。把用户给的英文段落译成简体中文。",
  "硬性规则：",
  "1. 寄存器名、位域名、缩写、十六进制地址、数值和单位保持原样，不翻译、不改写；",
  "2. 必须保留否定和条件关系（must not / do not / unless / only when / when read）；",
  "3. 只输出译文本身，不要解释、不要加注释、不要用 Markdown；",
  "4. 术语约定：register=寄存器，bit=位，set=置位，cleared=清零，reset=复位，offset=偏移，prescaler=预分频器，alternate function=复用功能，reserved=保留。",
].join("\n");

async function callModel(system: string, user: string, attempt: number): Promise<string> {
  const config = onlineConfig();
  const key = (process.env.ZHIPU_API_KEY || readKeyFile()).trim();
  if (!key) throw new Error("未配置在线翻译的 API key（.zhipu-key 或 ZHIPU_API_KEY）。");
  const response = await fetch(`${config.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string; code?: string };
  };
  if (!response.ok) {
    const message = `${response.status} ${payload.error?.message || JSON.stringify(payload).slice(0, 160)}`;
    const retriable = /429|1302|1305/i.test(message) || response.status >= 500;
    if (retriable && attempt < 1) {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      return callModel(system, user, attempt + 1);
    }
    throw new Error(message);
  }
  return payload.choices?.[0]?.message?.content?.trim() || "";
}

async function callOnce(text: string, attempt: number): Promise<string> {
  // 把命中的通用术语塞进提示词，减少"标针/登记器"这类错译
  const glossary = matchTermsForText(text, 10).map((term) => `${term.en}=${term.zh}`).join("，");
  const system = glossary ? `${SYSTEM_PROMPT}\n5. 本段涉及术语：${glossary}。` : SYSTEM_PROMPT;
  return callModel(system, text, attempt);
}

const BATCH_SYSTEM = `${SYSTEM_PROMPT}
5. 用户会一次给出多段，每段以【1】【2】…开头。逐段翻译，输出也用相同的【1】【2】编号，一段一行，不要合并、不要漏段。`;

/** 批量翻译：一次请求翻多段，避免每段一次往返（免费模型单次延迟 20 秒以上）。 */
export async function translateOnline(texts: string[]) {
  const startedAt = Date.now();
  const items: { text: string; ms: number }[] = [];
  if (!texts.length) return { items, totalMs: 0, config: onlineConfig() };

  if (texts.length === 1) {
    console.info("[translation-mode]", JSON.stringify({ provider: "glm", mode: "single", paragraphs: 1 }));
    const begin = Date.now();
    items.push({ text: await callOnce(texts[0], 0), ms: Date.now() - begin });
    return { items, totalMs: Date.now() - startedAt, config: onlineConfig() };
  }

  const begin = Date.now();
  console.info("[translation-mode]", JSON.stringify({ provider: "glm", mode: "batch-single-request", paragraphs: texts.length }));
  try {
    const joined = texts.map((text, index) => `【${index + 1}】${text}`).join("\n");
    const output = await callModel(BATCH_SYSTEM, joined, 0);
    const parts = output
      .split(/【\s*\d+\s*】|###\s*\d+\s*[.、:]?/g)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === texts.length) {
      const elapsed = Date.now() - begin;
      parts.forEach((part) => items.push({ text: part, ms: Math.round(elapsed / texts.length) }));
      return { items, totalMs: Date.now() - startedAt, config: onlineConfig() };
    }
    console.warn(`[online] 批量返回段数 ${parts.length} != ${texts.length}，回退逐段翻译`);
  } catch (error) {
    console.warn(`[online] 批量失败，回退逐段：${error instanceof Error ? error.message : error}`);
  }

  console.info("[translation-mode]", JSON.stringify({ provider: "glm", mode: "serial-fallback", paragraphs: texts.length }));
  for (const text of texts) {
    const itemStart = Date.now();
    items.push({ text: await callOnce(text, 0), ms: Date.now() - itemStart });
  }
  return { items, totalMs: Date.now() - startedAt, config: onlineConfig() };
}
