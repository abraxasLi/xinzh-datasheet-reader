// DeepL 在线翻译 provider（可选，默认关闭）。
// - DeepL API Free：每月 50 万字符，key 以 ":fx" 结尾，走 api-free.deepl.com
// - DeepL API Pro：key 不带 :fx，走 api-prod.deepl.com
// 只发送当前段/选中段文本；key 只从本机 .deepl-key 或 DEEPL_API_KEY 读取，不进前端。
import fs from "node:fs";
import path from "node:path";

const KEY_FILE = path.join(process.cwd(), ".deepl-key");

function readKeyFile(): string {
  try {
    if (!fs.existsSync(KEY_FILE)) return "";
    const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
    const match = raw.match(/^(?:DEEPL_API_KEY\s*=\s*)?(.+)$/m);
    return (match?.[1] || "").trim().replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}

function key() {
  return (process.env.DEEPL_API_KEY || readKeyFile()).trim();
}

export function deeplConfig() {
  const apiKey = key();
  // 未配置时按 Free 的标签展示，避免界面误显示成 Pro
  const free = !apiKey || apiKey.endsWith(":fx");
  return {
    configured: Boolean(apiKey),
    provider: "DeepL",
    host: free ? "api-free.deepl.com" : "api-prod.deepl.com",
    endpoint: free ? "https://api-free.deepl.com/v2/translate" : "https://api-prod.deepl.com/v2/translate",
    mode: free ? "Free（每月 50 万字符）" : "Pro",
  };
}

type DeepLResponse = {
  translations?: { detected_source_language?: string; text?: string }[];
  message?: string;
};

async function request(texts: string[], attempt: number): Promise<string[]> {
  const config = deeplConfig();
  if (!config.configured) throw new Error("未配置 DeepL API key（.deepl-key 或 DEEPL_API_KEY）。");
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `DeepL-Auth-Key ${key()}`,
    },
    body: JSON.stringify({
      text: texts,
      source_lang: "EN",
      target_lang: "ZH",
      preserve_formatting: true,
      split_sentences: "1",
    }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = (await response.json().catch(() => ({}))) as DeepLResponse;
  if (!response.ok) {
    const message = `${response.status} ${payload.message || JSON.stringify(payload).slice(0, 160)}`;
    if ((response.status === 429 || response.status >= 500) && attempt < 1) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      return request(texts, attempt + 1);
    }
    throw new Error(message);
  }
  const translations = payload.translations || [];
  if (translations.length !== texts.length) {
    throw new Error(`DeepL 返回段数 ${translations.length} != ${texts.length}`);
  }
  return translations.map((item) => item.text || "");
}

/** DeepL 原生支持多段数组，一次请求即可。 */
export async function translateWithDeepL(texts: string[]) {
  const startedAt = Date.now();
  const outputs = await request(texts, 0);
  const elapsed = Date.now() - startedAt;
  return {
    items: outputs.map((text) => ({ text, ms: Math.round(elapsed / Math.max(1, texts.length)) })),
    totalMs: elapsed,
    config: deeplConfig(),
  };
}
